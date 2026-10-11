// Runs the spatial analysis (geostats.js) off the page's main thread, so the
// page stays responsive. Files are read by geoconvert.js; the layers and the
// last result stay here, and only summaries, map features and the finished
// download (a Blob) go back to the page. Nothing is sent anywhere else.
importScripts(
  "staticmap.js" + self.location.search,
  "geoconvert.js" + self.location.search,
  "../vendor/polygon-clipping/polygon-clipping.umd.min.js",
  "geostats.js" + self.location.search
);

var layers = { a: null, b: null, result: null };

// The map gets every feature while that stays light enough to draw.
var MAX_DRAW_FEATURES = 50000, MAX_DRAW_POSITIONS = 2000000;
var DEPTH = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };
function positions(g) {
  if (!g) return 0;
  if (g.type === "GeometryCollection") return g.geometries.reduce(function (s, x) { return s + positions(x); }, 0);
  return (function count(a, d) {
    if (d <= 1) return d ? a.length : 1;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += count(a[i], d - 1);
    return s;
  })(g.coordinates, DEPTH[g.type] || 0);
}
function drawable(data) {
  if (data.features.length > MAX_DRAW_FEATURES) return null;
  var n = 0;
  for (var i = 0; i < data.features.length; i++) {
    n += positions(data.features[i].geometry);
    if (n > MAX_DRAW_POSITIONS) return null;
  }
  return data.features.filter(function (f) { return f.geometry; });
}

function describeLayer(data) {
  var s = GeoConvert.summary(data);
  s.kinds = GeoStats.kinds(data.features);
  return { summary: s, draw: drawable(data) };
}

var HOTSPOT_LABELS = {
  3: "Hot spot (99%)", 2: "Hot spot (95%)", 1: "Hot spot (90%)", 0: "Tidak signifikan",
  "-1": "Cold spot (90%)", "-2": "Cold spot (95%)", "-3": "Cold spot (99%)",
};

function run(op, params) {
  if (!layers.a) throw new Error("Choose a file first.");
  layers.result = null;
  var res = GeoStats.run(op, { a: layers.a.features, b: layers.b && layers.b.features }, params);
  var out = { report: res.report };
  if (res.features) {
    if (op === "hotspot") res.features.forEach(function (f) { f.properties.gi_kelas = HOTSPOT_LABELS[f.properties.gi_bin]; });
    if (res.features.some(function (f) { return f.geometry; })) {
      layers.result = GeoConvert.fromGeoJSON({ type: "FeatureCollection", features: res.features });
      layers.result.format = "Hasil analisis";
      var d = describeLayer(layers.result);
      out.summary = d.summary;
      out.draw = d.draw;
    } else {
      out.summary = null;
    }
  }
  return out;
}

self.onmessage = function (e) {
  var msg = e.data, job;
  try {
    if (msg.cmd === "read") {
      layers[msg.slot] = null; // let the previous file be freed before reading the next one
      layers.result = null;
      job = GeoConvert.read(msg.files, msg.options).then(function (d) {
        layers[msg.slot] = d;
        return describeLayer(d);
      });
    } else if (msg.cmd === "run") {
      job = Promise.resolve(run(msg.op, msg.params));
    } else if (msg.cmd === "write") {
      job = layers.result ? GeoConvert.write(layers.result, msg.format, msg.name).then(function (out) {
        return { blob: new Blob(out.parts, { type: out.mime }), filename: out.filename, warnings: out.warnings };
      }) : Promise.reject(new Error("Run an analysis first."));
    } else if (msg.cmd === "drop") {
      layers[msg.slot] = null;
      layers.result = null;
      job = Promise.resolve(true);
    } else if (msg.cmd === "limit") {
      job = Promise.resolve(GeoConvert.sizeLimit(msg.env));
    } else if (msg.cmd === "clear") {
      layers = { a: null, b: null, result: null };
      job = Promise.resolve(true);
    }
  } catch (err) {
    job = Promise.reject(err);
  }
  if (!job) job = Promise.reject(new Error("Unknown command: " + msg.cmd));
  job.then(function (result) {
    self.postMessage({ id: msg.id, result: result });
  }, function (err) {
    self.postMessage({ id: msg.id, error: { message: String((err && err.message) || err), name: err && err.name } });
  });
};
