// Runs the heavy part of the PDF map extractor (pdfgeo.js) off the page's
// main thread: the page renders the map area in bands and posts the pixels
// here; this worker writes them into a GeoTIFF and classifies them by colour,
// then traces the colour classes into polygons. Nothing is sent anywhere else.
importScripts("staticmap.js" + self.location.search, "geotiff.js" + self.location.search, "pdfgeo.js" + self.location.search);

var job = null;

function start(o) {
  var crs = PdfGeo.crs(o.epsg);
  if (!crs) throw new Error("unsupported EPSG:" + o.epsg);
  job = {
    o: o, crs: crs, row: 0,
    raster: o.raster ? PdfGeo.tiffWriter({ width: o.width, height: o.height, samples: 3, transform: o.transform, epsg: o.epsg }) : null,
    cls: o.classes.length ? new Uint8Array(o.width * o.height) : null,
    lut: o.classes.length ? PdfGeo.colorTable(o.classes, o.tolerance) : null,
  };
  return Promise.resolve(true);
}

// rgba: rows × width × 4 bytes, the next rows of the map area.
function rows(rgba) {
  var o = job.o, n = rgba.length >> 2, done = Promise.resolve();
  if (job.cls) PdfGeo.classify(rgba, job.lut, job.cls, job.row * o.width);
  if (job.raster) {
    var rgb = new Uint8Array(n * 3);
    for (var i = 0, j = 0, k = 0; i < n; i++, j += 4) {
      // Transparent pixels (outside the page's drawing) become white, as on paper.
      var a = rgba[j + 3];
      if (a === 255) { rgb[k++] = rgba[j]; rgb[k++] = rgba[j + 1]; rgb[k++] = rgba[j + 2]; }
      else { rgb[k++] = 255 + ((rgba[j] - 255) * a) / 255; rgb[k++] = 255 + ((rgba[j + 1] - 255) * a) / 255; rgb[k++] = 255 + ((rgba[j + 2] - 255) * a) / 255; }
    }
    done = job.raster.add(rgb);
  }
  job.row += n / o.width;
  return done.then(function () { return job.row; });
}

function finish() {
  var o = job.o, out = {}, w = o.width, h = o.height, t = o.transform, crs = job.crs;
  return (job.raster ? job.raster.finish() : Promise.resolve(null)).then(function (parts) {
    if (parts) out.raster = new Blob(parts, { type: "image/tiff" });
    if (!job.cls) return out;
    PdfGeo.removeThin(job.cls, w, h, o.thin, o.classes.length);
    PdfGeo.sieve(job.cls, w, h, o.minPixels);
    var counts = new Array(o.classes.length + 1).fill(0);
    for (var i = 0; i < job.cls.length; i++) counts[job.cls[i]]++;
    out.counts = counts;
    var f = Math.pow(10, 7);
    out.features = PdfGeo.polygonize(job.cls, w, h, o.classes, function (c, r) {
      var ll = crs.toLonLat(t[0] + c * t[1] + r * t[2], t[3] + c * t[4] + r * t[5]);
      return [Math.round(ll[0] * f) / f, Math.round(ll[1] * f) / f];
    }, { simplify: o.simplify });
    var palette = [[0, 0, 0]].concat(o.classes.map(function (c) { return c.colors[0] || [128, 128, 128]; }));
    var writer = PdfGeo.tiffWriter({ width: w, height: h, samples: 1, transform: t, epsg: o.epsg, palette: palette, nodata: 0 });
    return writer.add(job.cls).then(function () { return writer.finish(); }).then(function (p) {
      out.classRaster = new Blob(p, { type: "image/tiff" });
      return out;
    });
  }).then(function (result) {
    job = null;
    return result;
  });
}

self.onmessage = function (e) {
  var msg = e.data, run;
  try {
    if (msg.cmd === "start") run = start(msg.options);
    else if (msg.cmd === "rows") run = job ? rows(new Uint8ClampedArray(msg.buffer)) : Promise.reject(new Error("no job"));
    else if (msg.cmd === "finish") run = job ? finish() : Promise.reject(new Error("no job"));
    else if (msg.cmd === "lut") run = Promise.resolve(PdfGeo.colorTable(msg.classes, msg.tolerance));
    else if (msg.cmd === "cancel") { job = null; run = Promise.resolve(true); }
    else run = Promise.reject(new Error("Unknown command: " + msg.cmd));
  } catch (err) {
    run = Promise.reject(err);
  }
  run.then(function (result) {
    var transfer = result && result.buffer instanceof ArrayBuffer && result.length > 1000 ? [result.buffer] : [];
    self.postMessage({ id: msg.id, result: result }, transfer);
  }, function (err) {
    job = null;
    self.postMessage({ id: msg.id, error: { message: String((err && err.message) || err), name: err && err.name } });
  });
};
