// Static map maker: reads a GeoJSON file or a shapefile in the browser and draws
// a print-style coverage map (title, legend, scale bar, north arrow, graticule,
// locator inset, credits) on a canvas. Used by the admin form to make the
// coverage image, and by the public map maker (buat-peta.html); nothing is
// uploaded anywhere: the admin saves only the finished PNG.
//
// Shared by the admin page (browser) and the tests (Node), like schema.js.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.StaticMap = factory();
})(this, function () {
  "use strict";

  function fail(msg) { throw new Error(msg); }

  // ---------- Coordinate reference systems ----------
  // Everything is converted to WGS84 longitude/latitude. Datum shifts (e.g.
  // DGN95 vs WGS84, under 2 m) are ignored: they are invisible at map scale.
  var A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F), EP2 = E2 / (1 - E2);
  var DEG = Math.PI / 180;

  // Inverse Transverse Mercator (Snyder, USGS PP 1395, eq. 8-12 to 8-18).
  function tmInverse(p) {
    var e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
    var m0 = meridianArc(p.lat0 * DEG);
    return function (x, y) {
      x -= p.fe; y -= p.fn;
      var mu = (m0 + y / p.k0) / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256));
      var phi1 = mu + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu) +
        (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu) +
        (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu) + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
      var s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
      var c1 = EP2 * c * c, t1 = t * t, n1 = A / Math.sqrt(1 - E2 * s * s);
      var r1 = A * (1 - E2) / Math.pow(1 - E2 * s * s, 1.5), d = x / (n1 * p.k0);
      var lat = phi1 - (n1 * t / r1) * (d * d / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * Math.pow(d, 4) / 24 +
        (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * Math.pow(d, 6) / 720);
      var lon = p.lon0 * DEG + (d - (1 + 2 * t1 + c1) * Math.pow(d, 3) / 6 +
        (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * Math.pow(d, 5) / 120) / c;
      return [lon / DEG, lat / DEG];
    };
  }
  function meridianArc(phi) {
    return A * ((1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256) * phi -
      (3 * E2 / 8 + 3 * E2 * E2 / 32 + 45 * E2 * E2 * E2 / 1024) * Math.sin(2 * phi) +
      (15 * E2 * E2 / 256 + 45 * E2 * E2 * E2 / 1024) * Math.sin(4 * phi) -
      (35 * E2 * E2 * E2 / 3072) * Math.sin(6 * phi));
  }
  function webMercatorInverse(x, y) {
    return [x / A / DEG, (2 * Math.atan(Math.exp(y / A)) - Math.PI / 2) / DEG];
  }
  function utm(zone, south) {
    return tmInverse({ lon0: zone * 6 - 183, lat0: 0, k0: 0.9996, fe: 500000, fn: south ? 10000000 : 0 });
  }

  // Reads an ESRI .prj (WKT1). Returns { name, toLonLat } where toLonLat is
  // null for geographic coordinates (no conversion needed).
  function parsePrj(wkt) {
    wkt = String(wkt || "").trim();
    if (!wkt) return { name: "", toLonLat: null };
    var name = (wkt.match(/^\w+\["([^"]*)"/) || [])[1] || "";
    if (/^GEOGCS\[/i.test(wkt)) return { name: name.replace(/_/g, " "), toLonLat: null };
    if (!/^PROJCS\[/i.test(wkt)) fail("The .prj file could not be read. Export the data as WGS 84 (EPSG:4326) and try again.");
    var proj = ((wkt.match(/PROJECTION\["([^"]+)"/i) || [])[1] || "").toLowerCase();
    var unit = wkt.match(/UNIT\["[^"]*",\s*([\d.eE+-]+)\]\s*(?:,\s*AUTHORITY\[[^\]]*\]\s*)?(?:,\s*AXIS\[[^\]]*\]\s*)*\]\s*$/);
    if (unit && Math.abs(Number(unit[1]) - 1) > 1e-9) fail("The projection in the .prj file does not use metres. Export the data as WGS 84 (EPSG:4326) and try again.");
    function param(key, dflt) {
      var m = wkt.match(new RegExp('PARAMETER\\["' + key + '",\\s*([\\d.eE+-]+)\\]', "i"));
      return m ? Number(m[1]) : dflt;
    }
    if (proj === "transverse_mercator") {
      return {
        name: name.replace(/_/g, " "),
        toLonLat: tmInverse({
          lon0: param("central_meridian", 0), lat0: param("latitude_of_origin", 0),
          k0: param("scale_factor", 1), fe: param("false_easting", 0), fn: param("false_northing", 0),
        }),
      };
    }
    if (/mercator_auxiliary_sphere|popular_visualisation|pseudo_mercator/.test(proj) || /web_mercator|pseudo.mercator/i.test(name)) {
      return { name: "WGS 84 / Pseudo-Mercator", toLonLat: webMercatorInverse };
    }
    fail('The projection "' + (name || proj) + '" is not supported here. Export the data as WGS 84 (EPSG:4326), Web Mercator or UTM and try again.');
  }

  // Legacy GeoJSON "crs" member, e.g. "urn:ogc:def:crs:EPSG::32749".
  function geojsonCrs(crs) {
    var name = crs && crs.properties && crs.properties.name;
    if (!name) return { name: "", toLonLat: null };
    if (/CRS84$/i.test(name)) return { name: "WGS 84", toLonLat: null };
    var code = Number((String(name).match(/EPSG:{1,2}(\d+)$/i) || [])[1]);
    if (code === 4326 || code === 4755) return { name: "WGS 84", toLonLat: null };
    if (code === 3857 || code === 900913) return { name: "WGS 84 / Pseudo-Mercator", toLonLat: webMercatorInverse };
    if (code > 32600 && code <= 32660) return { name: "WGS 84 / UTM zone " + (code - 32600) + "N", toLonLat: utm(code - 32600, false) };
    if (code > 32700 && code <= 32760) return { name: "WGS 84 / UTM zone " + (code - 32700) + "S", toLonLat: utm(code - 32700, true) };
    fail("The GeoJSON uses " + name + ", which is not supported here. Export it as WGS 84 (EPSG:4326) and try again.");
  }

  // ---------- Layer model ----------
  // A layer is { features, fields, bbox, geometry, crs, format }. Each feature is
  // { kind: "polygon" | "line" | "point", parts: [[x, y, x, y, …], …], props }
  // in WGS84 degrees. Polygon rings of one feature are filled with the even-odd
  // rule, so holes need no special handling.
  function finish(features, fields, crs, format) {
    if (!features.length) fail("The file has no features with geometry.");
    var b = [Infinity, Infinity, -Infinity, -Infinity], kinds = {};
    features.forEach(function (f) {
      kinds[f.kind] = true;
      f.parts.forEach(function (p) {
        for (var i = 0; i < p.length; i += 2) {
          if (p[i] < b[0]) b[0] = p[i];
          if (p[i] > b[2]) b[2] = p[i];
          if (p[i + 1] < b[1]) b[1] = p[i + 1];
          if (p[i + 1] > b[3]) b[3] = p[i + 1];
        }
      });
    });
    if (!b.every(isFinite) || b[0] < -180.5 || b[2] > 180.5 || b[1] < -90.5 || b[3] > 90.5) {
      fail("The coordinates are not longitude/latitude" + (crs.name ? "" : " and the file does not say which projection it uses") +
        ". Export the data as WGS 84 (EPSG:4326) and try again.");
    }
    var k = Object.keys(kinds);
    var geometry = k.length > 1 ? "Mixed" : { polygon: "Polygon", line: "Line", point: "Point" }[k[0]];
    return { features: features, fields: fields, bbox: b, geometry: geometry, crs: crs.name || "WGS 84", format: format };
  }

  function reproject(parts, toLonLat) {
    if (!toLonLat) return parts;
    return parts.map(function (p) {
      var out = new Array(p.length);
      for (var i = 0; i < p.length; i += 2) {
        var ll = toLonLat(p[i], p[i + 1]);
        out[i] = ll[0]; out[i + 1] = ll[1];
      }
      return out;
    });
  }

  // ---------- GeoJSON ----------
  function parseGeoJSON(input) {
    var gj = typeof input === "string" ? JSON.parse(input) : input;
    if (!gj || typeof gj !== "object") fail("This is not a GeoJSON file.");
    var crs = geojsonCrs(gj.crs);
    var list = gj.type === "FeatureCollection" ? gj.features || [] :
      gj.type === "Feature" ? [gj] : gj.type ? [{ type: "Feature", geometry: gj, properties: {} }] : fail("This is not a GeoJSON file.");
    var features = [];
    list.forEach(function (feat) {
      var props = (feat && feat.properties) || {};
      (function add(g) {
        if (!g || !g.coordinates && g.type !== "GeometryCollection") return;
        var c = g.coordinates, flat = function (ring) {
          var out = [];
          ring.forEach(function (pt) { out.push(Number(pt[0]), Number(pt[1])); });
          return out;
        };
        switch (g.type) {
          case "Point": features.push({ kind: "point", parts: [flat([c])], props: props }); break;
          case "MultiPoint": features.push({ kind: "point", parts: c.map(function (pt) { return flat([pt]); }), props: props }); break;
          case "LineString": features.push({ kind: "line", parts: [flat(c)], props: props }); break;
          case "MultiLineString": features.push({ kind: "line", parts: c.map(flat), props: props }); break;
          case "Polygon": features.push({ kind: "polygon", parts: c.map(flat), props: props }); break;
          case "MultiPolygon": features.push({ kind: "polygon", parts: [].concat.apply([], c.map(function (poly) { return poly.map(flat); })), props: props }); break;
          case "GeometryCollection": (g.geometries || []).forEach(add); break;
        }
      })(feat && feat.geometry);
    });
    features.forEach(function (f) { f.parts = reproject(f.parts, crs.toLonLat); });
    return finish(features, inferFields(features), crs, "GeoJSON");
  }

  // Field types from the values of the first 1,000 features.
  function inferFields(features) {
    var names = [], seen = {}, kinds = {};
    features.slice(0, 1000).forEach(function (f) {
      Object.keys(f.props).forEach(function (k) {
        if (!seen[k]) { seen[k] = true; names.push(k); kinds[k] = {}; }
        var v = f.props[k];
        if (v == null || v === "") return;
        kinds[k][typeof v === "number" ? (Number.isInteger(v) ? "Integer" : "Double") :
          typeof v === "boolean" ? "Boolean" : typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? "Date" : "Text"] = true;
      });
    });
    return names.map(function (n) {
      var k = Object.keys(kinds[n]);
      var type = k.length === 1 ? k[0] : k.length === 2 && kinds[n].Integer && kinds[n].Double ? "Double" : "Text";
      return { name: n, type: type };
    });
  }

  // ---------- ZIP (shapefiles are usually shared zipped) ----------
  // Reads the central directory and inflates the wanted entries with the
  // browser's DecompressionStream. ZIP64 (archives over 4 GB) is not supported.
  // maxBytes (optional) caps the unzipped size of the wanted entries, so a
  // small archive cannot inflate past what the browser can hold in memory.
  function readZip(buffer, wanted, maxBytes) {
    var dv = new DataView(buffer), u8 = new Uint8Array(buffer);
    var eocd = -1;
    for (var i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) fail("This .zip file could not be read.");
    var count = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true);
    if (p === 0xffffffff) fail("This .zip file is too large (ZIP64). Zip the shapefile without other data and try again.");
    var entries = [];
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) fail("This .zip file is damaged.");
      var nameLen = dv.getUint16(p + 28, true);
      var entry = {
        method: dv.getUint16(p + 10, true),
        size: dv.getUint32(p + 20, true),
        unzipped: dv.getUint32(p + 24, true),
        name: new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen)),
        offset: dv.getUint32(p + 42, true),
      };
      p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
      if (/(^|\/)(__MACOSX\/|\.)/.test(entry.name) || /\/$/.test(entry.name) || !wanted(entry.name)) continue;
      entries.push(entry);
    }
    var total = entries.reduce(function (sum, e) { return sum + e.unzipped; }, 0);
    if (maxBytes && total > maxBytes) fail("The unzipped files are too large for this browser (" + Math.round(total / 1048576) + " MB).");
    return Promise.all(entries.map(function (e) {
      var start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
      var data = u8.subarray(start, start + e.size);
      if (e.method === 0) return { name: e.name, data: data.slice() };
      if (e.method !== 8) fail("This .zip file uses an unsupported compression method.");
      var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Response(stream).arrayBuffer().then(function (buf) { return { name: e.name, data: new Uint8Array(buf) }; });
    }));
  }

  // ---------- Shapefile ----------
  // files: { shp: Uint8Array, dbf?: Uint8Array, prj?: string, cpg?: string }
  function parseShapefile(files) {
    if (!files.shp) fail("The .shp file is missing.");
    var crs = files.prj ? parsePrj(files.prj) : { name: "", toLonLat: null };
    var shp = files.shp, dv = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
    if (shp.byteLength < 100 || dv.getInt32(0, false) !== 9994) fail("The .shp file could not be read.");
    var table = files.dbf ? parseDbf(files.dbf, files.cpg) : { fields: [], records: [] };
    var features = [], pos = 100, index = 0;
    while (pos + 8 <= shp.byteLength) {
      var len = dv.getInt32(pos + 4, false) * 2, at = pos + 8, type = len >= 4 ? dv.getInt32(at, true) : 0;
      var props = table.records[index] || {};
      // Z (1x) and M (2x) variants share the 2D layout; MultiPatch (31) is not supported.
      var base = type > 0 && type < 30 ? type % 10 : type ? -1 : 0;
      if (base === 1) {
        features.push({ kind: "point", parts: [[dv.getFloat64(at + 4, true), dv.getFloat64(at + 12, true)]], props: props });
      } else if (base === 8) {
        var np = dv.getInt32(at + 36, true), pts = [];
        for (var j = 0; j < np; j++) pts.push([dv.getFloat64(at + 40 + j * 16, true), dv.getFloat64(at + 48 + j * 16, true)]);
        features.push({ kind: "point", parts: pts, props: props });
      } else if (base === 3 || base === 5) {
        var nParts = dv.getInt32(at + 36, true), nPts = dv.getInt32(at + 40, true);
        var ptsAt = at + 44 + nParts * 4, parts = [];
        for (var k = 0; k < nParts; k++) {
          var from = dv.getInt32(at + 44 + k * 4, true);
          var to = k + 1 < nParts ? dv.getInt32(at + 48 + k * 4, true) : nPts;
          var ring = new Array((to - from) * 2);
          for (var q = from; q < to; q++) {
            ring[(q - from) * 2] = dv.getFloat64(ptsAt + q * 16, true);
            ring[(q - from) * 2 + 1] = dv.getFloat64(ptsAt + q * 16 + 8, true);
          }
          parts.push(ring);
        }
        features.push({ kind: base === 5 ? "polygon" : "line", parts: parts, props: props });
      } else if (base !== 0) {
        fail("The .shp file has an unsupported shape type (" + type + ").");
      }
      pos = at + len;
      index++;
    }
    features.forEach(function (f) { f.parts = reproject(f.parts, crs.toLonLat); });
    return finish(features, table.fields, crs, "SHP");
  }

  var DBF_TYPES = { C: "Text", D: "Date", L: "Boolean", F: "Double", M: "Text" };

  function parseDbf(bytes, cpg) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var n = dv.getUint32(4, true), headerLen = dv.getUint16(8, true), recLen = dv.getUint16(10, true);
    var fields = [], p = 32, offset = 1;
    while (p + 32 <= headerLen && bytes[p] !== 0x0d) {
      var name = String.fromCharCode.apply(null, bytes.subarray(p, p + 11)).replace(/\0[\s\S]*$/, "");
      var t = String.fromCharCode(bytes[p + 11]), size = bytes[p + 16], dec = bytes[p + 17];
      fields.push({ name: name, code: t, size: size, offset: offset, type: t === "N" ? (dec ? "Double" : "Integer") : DBF_TYPES[t] || "Text" });
      offset += size;
      p += 32;
    }
    // UTF-8 if the .cpg says so, or if the text decodes cleanly as UTF-8; else Windows-1252.
    var decoder = new TextDecoder(/utf-?8/i.test(cpg || "") ? "utf-8" : "windows-1252");
    if (!cpg) {
      try { new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(headerLen)); decoder = new TextDecoder("utf-8"); } catch (e) { /* not UTF-8 */ }
    }
    var records = new Array(n);
    for (var i = 0; i < n; i++) {
      var r = headerLen + i * recLen, rec = {};
      if (r + recLen > bytes.byteLength) break;
      fields.forEach(function (f) {
        var raw = decoder.decode(bytes.subarray(r + f.offset, r + f.offset + f.size)).trim();
        var v = raw;
        if (f.code === "N" || f.code === "F") v = raw === "" || isNaN(raw) ? null : Number(raw);
        else if (f.code === "D") v = /^\d{8}$/.test(raw) ? raw.slice(0, 4) + "-" + raw.slice(4, 6) + "-" + raw.slice(6) : raw || null;
        else if (f.code === "L") v = /^[YyTt]$/.test(raw) ? true : /^[NnFf]$/.test(raw) ? false : null;
        rec[f.name] = v;
      });
      records[i] = rec;
    }
    return { fields: fields.map(function (f) { return { name: f.name, type: f.type }; }), records: records };
  }

  // ---------- Loading files picked in the browser ----------
  function ext(name) { return ((name.match(/\.([^./]+)$/) || [])[1] || "").toLowerCase(); }
  function bytesOf(file) { return file.arrayBuffer().then(function (b) { return new Uint8Array(b); }); }
  function textOf(bytes) { return new TextDecoder().decode(bytes); }

  // Accepts one .geojson/.json, one .zip with a shapefile inside, or the
  // .shp/.dbf/.prj/.cpg files picked together.
  function load(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return Promise.reject(new Error("Choose a file first."));
    var byExt = {};
    files.forEach(function (f) { byExt[ext(f.name)] = f; });
    if (byExt.geojson || byExt.json) {
      return (byExt.geojson || byExt.json).text().then(parseGeoJSON);
    }
    if (byExt.zip) {
      return byExt.zip.arrayBuffer().then(function (buf) {
        return readZip(buf, function (name) { return /\.(shp|dbf|prj|cpg|geojson|json)$/i.test(name); });
      }).then(function (entries) {
        var gj = entries.filter(function (e) { return /\.(geo)?json$/i.test(e.name); })[0];
        var shps = entries.filter(function (e) { return /\.shp$/i.test(e.name); });
        if (!shps.length && gj) return parseGeoJSON(textOf(gj.data));
        if (!shps.length) fail("The .zip file has no shapefile (.shp) or GeoJSON inside.");
        // With several shapefiles, use the largest one.
        var shp = shps.sort(function (a, b) { return b.data.length - a.data.length; })[0];
        var stem = shp.name.replace(/\.shp$/i, "").toLowerCase();
        var part = function (x) { return entries.filter(function (e) { return e.name.toLowerCase() === stem + "." + x; })[0]; };
        return parseShapefile({
          shp: shp.data,
          dbf: part("dbf") && part("dbf").data,
          prj: part("prj") && textOf(part("prj").data),
          cpg: part("cpg") && textOf(part("cpg").data),
        });
      });
    }
    if (byExt.shp) {
      return Promise.all([byExt.shp, byExt.dbf, byExt.prj, byExt.cpg].map(function (f) { return f ? bytesOf(f) : null; })).then(function (b) {
        return parseShapefile({ shp: b[0], dbf: b[1], prj: b[2] && textOf(b[2]), cpg: b[3] && textOf(b[3]) });
      });
    }
    return Promise.reject(new Error("Choose a .geojson, a zipped shapefile (.zip), or the .shp, .dbf and .prj files together."));
  }

  // ---------- Styling helpers ----------
  // Okabe–Ito colours: distinguishable with common colour-vision deficiencies.
  var PALETTE = ["#D55E00", "#0072B2", "#009E73", "#E69F00", "#CC79A7", "#56B4E9", "#F0E442"];
  var OTHER = "#9a9a9a";
  var SINGLE = "#D55E00";

  // Fields worth colouring by: 2–30 distinct values, and not an identifier
  // (a value per feature, more than there are colours).
  function categoryFields(layer) {
    return layer.fields.filter(function (f) {
      var seen = {}, n = 0, filled = 0;
      for (var i = 0; i < layer.features.length; i++) {
        var v = layer.features[i].props[f.name];
        if (v == null || v === "") continue;
        filled++;
        if (!seen[v]) { seen[v] = true; if (++n > 30) return false; }
      }
      return n >= 2 && !(n === filled && n > PALETTE.length);
    }).map(function (f) { return f.name; });
  }

  // Classes for one field, largest first. Past the palette, the rest are "Lainnya".
  function categories(layer, field) {
    if (!field) return [{ value: null, label: null, color: SINGLE, count: layer.features.length }];
    var counts = {};
    layer.features.forEach(function (f) {
      var v = f.props[field];
      var key = v == null || v === "" ? "" : String(v);
      counts[key] = (counts[key] || 0) + 1;
    });
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
    var blank = keys.indexOf("");
    if (blank >= 0) keys.splice(blank, 1);
    var shown = keys.length > PALETTE.length ? keys.slice(0, PALETTE.length - 1) : keys;
    var out = shown.map(function (k, i) { return { value: k, label: k, color: PALETTE[i], count: counts[k] }; });
    var rest = keys.slice(shown.length).reduce(function (s, k) { return s + counts[k]; }, 0) + (blank >= 0 ? counts[""] : 0);
    if (rest) out.push({ value: "*", label: blank >= 0 && rest === counts[""] ? "Tanpa keterangan" : "Lainnya", color: OTHER, count: rest });
    return out;
  }

  // Numeric fields with more values than there are category colours are shown
  // as ranges (graduated colours) instead of categories.
  function fieldKind(layer, field) {
    var seen = {}, n = 0, numeric = true;
    for (var i = 0; i < layer.features.length; i++) {
      var v = layer.features[i].props[field];
      if (v == null || v === "") continue;
      if (typeof v !== "number" || !isFinite(v)) numeric = false;
      if (!seen[v]) { seen[v] = true; n++; }
    }
    return numeric && n > PALETTE.length ? "number" : "category";
  }

  // Fields a map can be coloured by: category fields plus numeric fields.
  function fieldOptions(layer) {
    var cats = categoryFields(layer);
    return layer.fields.map(function (f) {
      var kind = fieldKind(layer, f.name);
      return kind === "number" || cats.indexOf(f.name) >= 0 ? { name: f.name, kind: kind } : null;
    }).filter(Boolean);
  }

  // Sequential light-to-dark blues (ColorBrewer YlGnBu, colour-blind safe),
  // without its lightest step, which would vanish on the basemap.
  var SEQUENTIAL = ["#c7e9b4", "#7fcdbb", "#41b6c4", "#2c7fb8", "#253494"];

  function formatNumber(v) {
    var a = Math.abs(v);
    var digits = a >= 100 || Number.isInteger(v) ? 0 : a >= 1 ? 2 : 3;
    return v.toLocaleString("id-ID", { maximumFractionDigits: digits });
  }

  // Up to five quantile classes (about the same number of features in each),
  // labelled with the smallest and largest value actually in the class. Each
  // class holds its lower bound in `lo`; features without a number are grey.
  function ranges(layer, field) {
    var vals = [], blank = 0;
    layer.features.forEach(function (f) {
      var v = f.props[field];
      if (typeof v === "number" && isFinite(v)) vals.push(v); else blank++;
    });
    vals.sort(function (a, b) { return a - b; });
    var out = [];
    if (vals.length) {
      // Where a quantile falls inside a run of equal values (skewed data, many
      // zeros), the break moves to the next larger value.
      var k = SEQUENTIAL.length, los = [vals[0]];
      for (var i = 1, j = 0; i < k; i++) {
        j = Math.max(j, Math.floor(i * vals.length / k));
        while (j < vals.length && vals[j] <= los[los.length - 1]) j++;
        if (j < vals.length) los.push(vals[j]);
      }
      out = los.map(function (lo, j) {
        var color = SEQUENTIAL[los.length === 1 ? SEQUENTIAL.length - 1 : Math.round(j * (SEQUENTIAL.length - 1) / (los.length - 1))];
        return { lo: lo, color: color, count: 0, min: Infinity, max: -Infinity };
      });
      var c = 0;
      vals.forEach(function (v) {
        while (c + 1 < out.length && v >= out[c + 1].lo) c++;
        out[c].count++;
        if (v < out[c].min) out[c].min = v;
        if (v > out[c].max) out[c].max = v;
      });
      out.forEach(function (cl) {
        cl.value = cl.label = formatNumber(cl.min) + (cl.max > cl.min ? " – " + formatNumber(cl.max) : "");
      });
    }
    if (blank) out.push({ value: "*", label: "Tanpa nilai", color: OTHER, count: blank });
    return out;
  }

  // Classes for `field`: ranges for numbers, categories otherwise.
  function classify(layer, field) {
    return field && fieldKind(layer, field) === "number" ? ranges(layer, field) : categories(layer, field);
  }

  // Colour of one feature under classes from categories() or ranges().
  function colorer(classes, field) {
    if (!field) return function () { return SINGLE; };
    var steps = classes.filter(function (c) { return c.lo != null; });
    if (steps.length) {
      return function (f) {
        var v = f.props[field];
        if (typeof v !== "number" || !isFinite(v)) return OTHER;
        for (var i = steps.length - 1; i > 0; i--) if (v >= steps[i].lo) return steps[i].color;
        return steps[0].color;
      };
    }
    var colorOf = {};
    classes.forEach(function (c) { colorOf[c.value] = c.color; });
    return function (f) {
      var v = f.props[field];
      return colorOf[v == null || v === "" ? "" : String(v)] || OTHER;
    };
  }

  // A "nice" number (1, 2 or 5 × 10ⁿ) not larger than x.
  function niceFloor(x) {
    var p = Math.pow(10, Math.floor(Math.log10(x))), m = x / p;
    return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
  }

  var GRID_STEPS = [1 / 60, 2 / 60, 5 / 60, 10 / 60, 15 / 60, 0.5, 1, 2, 5, 10, 15, 20, 30];
  function gridStep(spanDeg) {
    for (var i = 0; i < GRID_STEPS.length; i++) if (spanDeg / GRID_STEPS[i] <= 7) return GRID_STEPS[i];
    return 30;
  }

  // 106.5, "E" → "106°30′ BT" (Indonesian: BT/BB, LU/LS).
  function formatDeg(v, axis) {
    var hemi = axis === "x" ? (v < 0 ? "BB" : v > 0 ? "BT" : "") : (v < 0 ? "LS" : v > 0 ? "LU" : "");
    var a = Math.abs(v), d = Math.floor(a + 1e-9), m = Math.round((a - d) * 60);
    if (m === 60) { d++; m = 0; }
    return d + "°" + (m ? m + "′" : "") + (hemi ? " " + hemi : "");
  }

  // ---------- Map view ----------
  // Lambert cylindrical equal-area with the standard parallel at the centre of
  // the map: areas are true everywhere and scale is true at the centre, which
  // is what the scale bar uses. Units are Earth radii.
  var R_KM = 6371.0088;

  function makeView(bbox, frame, opts) {
    opts = opts || {};
    var pad = opts.pad == null ? 0.08 : opts.pad;
    var minSpan = opts.minSpan || 0.05;
    var w = bbox[0], s = bbox[1], e = bbox[2], n = bbox[3];
    if (e - w < minSpan) { var cx = (w + e) / 2; w = cx - minSpan / 2; e = cx + minSpan / 2; }
    if (n - s < minSpan) { var cy = (s + n) / 2; s = cy - minSpan / 2; n = cy + minSpan / 2; }
    var lat0 = Math.max(-60, Math.min(60, (s + n) / 2)), k = Math.cos(lat0 * DEG);
    var fx = function (lon) { return lon * DEG * k; };
    var fy = function (lat) { return Math.sin(lat * DEG) / k; };
    var x0 = fx(w), x1 = fx(e), y0 = fy(s), y1 = fy(n);
    var px = (x1 - x0) * pad, py = (y1 - y0) * pad;
    x0 -= px; x1 += px; y0 -= py; y1 += py;
    var scale = Math.min(frame.w / (x1 - x0), frame.h / (y1 - y0));
    var mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    var view = {
      lat0: lat0, scale: scale, frame: frame,
      x: function (lon) { return frame.x + frame.w / 2 + (fx(lon) - mx) * scale; },
      y: function (lat) { return frame.y + frame.h / 2 - (fy(lat) - my) * scale; },
      lon: function (px) { return ((px - frame.x - frame.w / 2) / scale + mx) / k / DEG; },
      lat: function (py) { return Math.asin(Math.max(-1, Math.min(1, (my - (py - frame.y - frame.h / 2) / scale) * k))) / DEG; },
      kmPerPx: R_KM / scale,
    };
    view.bbox = [view.lon(frame.x), view.lat(frame.y + frame.h), view.lon(frame.x + frame.w), view.lat(frame.y)];
    return view;
  }

  // ---------- Drawing ----------
  var FONT = "Inter, 'Segoe UI', Roboto, Arial, sans-serif";
  var C = {
    paper: "#ffffff", ink: "#1f2933", muted: "#5b6672", faint: "#8a949e",
    sea: "#e4eef3", land: "#f7f5ef", focus: "#fdfcf9", border: "#b3ab9d", grid: "rgba(90,120,140,0.28)",
    frame: "#3d4852", box: "rgba(255,255,255,0.93)", boxLine: "#cfd6dc",
  };

  function font(ctx, size, weight) { ctx.font = (weight || 400) + " " + size + "px " + FONT; }

  function haloText(ctx, text, x, y, halo) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineWidth = halo || 3;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.strokeText(text, x, y);
    ctx.restore();
    ctx.fillText(text, x, y);
  }

  // Shrinks the font until the text fits, then ellipsises as a last resort.
  function fitText(ctx, text, maxW, size, weight, minSize) {
    for (var s = size; s >= (minSize || 12); s--) {
      font(ctx, s, weight);
      if (ctx.measureText(text).width <= maxW) return text;
    }
    while (text.length > 1 && ctx.measureText(text + "…").width > maxW) text = text.slice(0, -1);
    return text + "…";
  }

  function wrap(ctx, text, maxW, maxLines) {
    var words = String(text).split(/\s+/), lines = [], line = "";
    words.forEach(function (w) {
      var t = line ? line + " " + w : w;
      if (ctx.measureText(t).width <= maxW || !line) line = t;
      else { lines.push(line); line = w; }
    });
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      var last = lines[maxLines - 1];
      while (last.length > 1 && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
      lines[maxLines - 1] = last + "…";
    }
    return lines;
  }

  // Adds rings to the current path in screen space, skipping vertices closer
  // than half a pixel to the previous one (keeps big datasets fast).
  function tracePath(ctx, view, parts, close) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    parts.forEach(function (p) {
      var lx = null, ly = null;
      for (var i = 0; i < p.length; i += 2) {
        var x = view.x(p[i]), y = view.y(p[i + 1]);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (lx === null) ctx.moveTo(x, y);
        else if (Math.abs(x - lx) + Math.abs(y - ly) >= 0.5 || i === p.length - 2) ctx.lineTo(x, y);
        else continue;
        lx = x; ly = y;
      }
      if (close) ctx.closePath();
    });
    return [minX, minY, maxX, maxY];
  }

  function shade(hex, f) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  function ringsBox(rings, sc) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    rings.forEach(function (r) {
      for (var i = 0; i < r.length; i += 2) {
        var x = r[i] / sc, y = r[i + 1] / sc;
        if (x < b[0]) b[0] = x; if (x > b[2]) b[2] = x;
        if (y < b[1]) b[1] = y; if (y > b[3]) b[3] = y;
      }
    });
    return b;
  }

  // The country most of the data lies in (by testing up to 300 sample
  // vertices), or null. It is drawn lighter and left unlabelled.
  function focusCountry(layer, basemap) {
    var sc = basemap.scale, hits = {}, step = Math.max(1, Math.floor(layer.features.length / 300));
    function inside(c, x, y) {
      var b = c._box || (c._box = ringsBox(c.rings, sc)), n = false;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false;
      c.rings.forEach(function (r) {
        for (var i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
          var yi = r[i + 1] / sc, yj = r[j + 1] / sc;
          if ((yi > y) !== (yj > y) && x < (r[j] / sc - r[i] / sc) * (y - yi) / (yj - yi) + r[i] / sc) n = !n;
        }
      });
      return n;
    }
    for (var i = 0; i < layer.features.length; i += step) {
      var p = layer.features[i].parts[0];
      if (!p || !p.length) continue;
      for (var k = 0; k < basemap.countries.length; k++) {
        var c = basemap.countries[k];
        if (inside(c, p[0], p[1])) { hits[c.iso] = (hits[c.iso] || 0) + 1; break; }
      }
    }
    var best = null;
    Object.keys(hits).forEach(function (iso) { if (!best || hits[iso] > hits[best]) best = iso; });
    return best;
  }

  function drawBasemap(ctx, view, basemap, focusIso) {
    var fr = view.frame, sc = basemap.scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(fr.x, fr.y, fr.w, fr.h);
    ctx.clip();
    ctx.fillStyle = C.sea;
    ctx.fillRect(fr.x, fr.y, fr.w, fr.h);
    basemap.countries.forEach(function (c) {
      // The country under the data is drawn lighter, so the data stands out against its neighbours.
      var focus = c.iso === focusIso;
      ctx.beginPath();
      c.rings.forEach(function (r) {
        var lx = null, ly = null, any = false;
        for (var i = 0; i < r.length; i += 2) {
          var lon = r[i] / sc, lat = r[i + 1] / sc;
          var x = view.x(lon), y = view.y(lat);
          if (lx === null) ctx.moveTo(x, y);
          else if (Math.abs(x - lx) + Math.abs(y - ly) >= 0.6) ctx.lineTo(x, y);
          else continue;
          lx = x; ly = y; any = true;
        }
        if (any) ctx.closePath();
      });
      ctx.fillStyle = focus ? C.focus : C.land;
      ctx.fill("evenodd");
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    });
    ctx.restore();
  }

  // Neighbouring countries are labelled when their main landmass is big enough
  // on screen to matter at this scale (minor territories need to be bigger
  // still), and the label does not collide with the legend or other boxes.
  function drawCountryLabels(ctx, view, basemap, focusIso, avoid) {
    var fr = view.frame;
    ctx.save();
    font(ctx, 12, 600);
    ctx.fillStyle = C.faint;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if ("letterSpacing" in ctx) ctx.letterSpacing = "2px";
    basemap.countries.forEach(function (c) {
      if (c.iso === focusIso) return;
      var b = c.main, size = Math.max(view.x(b[2]) - view.x(b[0]), view.y(b[1]) - view.y(b[3]));
      if (size < (c.rank <= 4 ? 60 : 150)) return;
      var x = view.x(c.label[0]), y = view.y(c.label[1]), t = c.name.toUpperCase(), w = ctx.measureText(t).width;
      if (x - w / 2 < fr.x + 8 || x + w / 2 > fr.x + fr.w - 8 || y < fr.y + 12 || y > fr.y + fr.h - 12) return;
      var hit = avoid.some(function (r) { return r && x + w / 2 > r.x - 6 && x - w / 2 < r.x + r.w + 6 && y + 8 > r.y - 4 && y - 8 < r.y + r.h + 4; });
      if (hit) return;
      haloText(ctx, t, x, y, 3);
    });
    ctx.restore();
  }

  function drawGraticule(ctx, view) {
    var fr = view.frame, vb = view.bbox;
    var step = gridStep(Math.max(vb[2] - vb[0], (vb[3] - vb[1]) * 1.4));
    var lines = { x: [], y: [] };
    ctx.save();
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (var lon = Math.ceil(vb[0] / step - 1e-9) * step; lon <= vb[2] + 1e-9; lon += step) {
      var x = Math.round(view.x(lon)) + 0.5;
      if (x < fr.x + 4 || x > fr.x + fr.w - 4) continue;
      ctx.moveTo(x, fr.y); ctx.lineTo(x, fr.y + fr.h);
      lines.x.push([x, lon]);
    }
    for (var lat = Math.ceil(vb[1] / step - 1e-9) * step; lat <= vb[3] + 1e-9; lat += step) {
      var y = Math.round(view.y(lat)) + 0.5;
      if (y < fr.y + 4 || y > fr.y + fr.h - 4) continue;
      ctx.moveTo(fr.x, y); ctx.lineTo(fr.x + fr.w, y);
      lines.y.push([y, lat]);
    }
    ctx.stroke();
    ctx.restore();
    return lines;
  }

  // Graticule labels in the margin outside the neatline, with tick marks.
  function drawGridLabels(ctx, view, lines) {
    var fr = view.frame;
    ctx.save();
    font(ctx, 12, 400);
    ctx.fillStyle = C.muted;
    ctx.strokeStyle = C.frame;
    ctx.lineWidth = 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.beginPath();
    lines.x.forEach(function (l) {
      ctx.moveTo(l[0], fr.y + fr.h); ctx.lineTo(l[0], fr.y + fr.h + 5);
      ctx.moveTo(l[0], fr.y); ctx.lineTo(l[0], fr.y - 5);
      ctx.fillText(formatDeg(l[1], "x"), l[0], fr.y + fr.h + 8);
    });
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    lines.y.forEach(function (l) {
      ctx.moveTo(fr.x, l[0]); ctx.lineTo(fr.x - 5, l[0]);
      ctx.moveTo(fr.x + fr.w, l[0]); ctx.lineTo(fr.x + fr.w + 5, l[0]);
      ctx.fillText(formatDeg(l[1], "y"), fr.x - 8, l[0]);
    });
    ctx.stroke();
    ctx.restore();
  }

  function drawData(ctx, view, layer, classes, field) {
    var color = colorer(classes, field);
    // Polygons first, then lines, then points on top. Within polygons, draw the
    // largest classes first so small classes are not hidden beneath them.
    var rank = {};
    classes.forEach(function (c, i) { rank[c.color] = i; });
    var order = { polygon: 0, line: 1, point: 2 };
    var list = layer.features.map(function (f) { return { f: f, c: color(f) }; });
    list.sort(function (a, b) { return order[a.f.kind] - order[b.f.kind] || (rank[a.c] || 0) - (rank[b.c] || 0); });

    var fr = view.frame;
    ctx.save();
    ctx.beginPath();
    ctx.rect(fr.x, fr.y, fr.w, fr.h);
    ctx.clip();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    list.forEach(function (item) {
      var f = item.f, c = item.c;
      if (f.kind === "point") {
        f.parts.forEach(function (p) {
          ctx.beginPath();
          ctx.arc(view.x(p[0]), view.y(p[1]), 3.5, 0, 2 * Math.PI);
          ctx.fillStyle = c;
          ctx.fill();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1;
          ctx.stroke();
        });
        return;
      }
      ctx.beginPath();
      var box = tracePath(ctx, view, f.parts, f.kind === "polygon");
      if (box[2] < fr.x || box[0] > fr.x + fr.w || box[3] < fr.y || box[1] > fr.y + fr.h) return;
      if (f.kind === "line") {
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        return;
      }
      // A polygon smaller than a pixel would vanish: show it as a small dot instead.
      if (box[2] - box[0] < 1.5 && box[3] - box[1] < 1.5) {
        ctx.fillStyle = c;
        ctx.fillRect((box[0] + box[2]) / 2 - 1, (box[1] + box[3]) / 2 - 1, 2, 2);
        return;
      }
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = c;
      ctx.fill("evenodd");
      ctx.globalAlpha = 1;
      ctx.strokeStyle = shade(c, 0.7);
      ctx.lineWidth = 0.6;
      ctx.stroke();
    });
    ctx.restore();
  }

  function swatch(ctx, kind, color, x, y) {
    ctx.save();
    if (kind === "Point") {
      ctx.beginPath();
      ctx.arc(x + 9, y, 5, 0, 2 * Math.PI);
      ctx.fillStyle = color; ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();
    } else if (kind === "Line") {
      ctx.beginPath();
      ctx.moveTo(x, y + 3); ctx.lineTo(x + 6, y - 3); ctx.lineTo(x + 12, y + 3); ctx.lineTo(x + 18, y - 3);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
    } else {
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 7, 18, 14);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = shade(color, 0.7);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y - 6.5, 17, 13);
    }
    ctx.restore();
  }

  function box(ctx, x, y, w, h) {
    ctx.save();
    ctx.fillStyle = C.box;
    ctx.strokeStyle = C.boxLine;
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
  }

  function drawLegend(ctx, view, layer, classes, opts) {
    var fr = view.frame, pad = 14, maxText = 300, lineH = 17;
    var kind = layer.geometry === "Mixed" ? "Polygon" : layer.geometry;
    var fmt = function (n) { return n.toLocaleString("id-ID"); };
    font(ctx, 13, 400);
    var rows = classes.map(function (c) {
      var label = c.label == null ? opts.layerName : c.label;
      return { c: c, lines: wrap(ctx, label, maxText, 2), count: "(" + fmt(c.count) + ")" };
    });
    var title = opts.legendTitle || "Keterangan";
    font(ctx, 14, 600);
    var titleW = ctx.measureText(title).width;
    font(ctx, 13, 400);
    var width = Math.max(titleW, Math.max.apply(null, rows.map(function (r) {
      return Math.max.apply(null, r.lines.map(function (l) { return ctx.measureText(l).width; })) + 8 + ctx.measureText(r.count).width;
    })) + 28);
    width = Math.min(width, maxText + 90) + pad * 2;
    var height = pad * 2 + 22 + rows.reduce(function (s, r) { return s + r.lines.length * lineH + 7; }, 0) - 7;
    var x = fr.x + 14, y = fr.y + fr.h - height - 14;
    box(ctx, x, y, width, height);
    ctx.fillStyle = C.ink;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    font(ctx, 14, 600);
    ctx.fillText(title, x + pad, y + pad + 12);
    var cy = y + pad + 22;
    rows.forEach(function (r) {
      swatch(ctx, kind, r.c.color, x + pad, cy + 9);
      font(ctx, 13, 400);
      ctx.fillStyle = C.ink;
      r.lines.forEach(function (l, i) {
        ctx.fillText(l, x + pad + 28, cy + 13 + i * lineH);
        if (i === r.lines.length - 1) {
          ctx.fillStyle = C.faint;
          ctx.fillText(r.count, x + pad + 28 + ctx.measureText(l).width + 6, cy + 13 + i * lineH);
        }
      });
      cy += r.lines.length * lineH + 7;
    });
    return { x: x, y: y, w: width, h: height };
  }

  // Scale bar (true at the map centre) and north arrow, bottom right.
  function drawScaleAndNorth(ctx, view) {
    var fr = view.frame;
    var targetPx = Math.min(240, fr.w * 0.2);
    var km = niceFloor(targetPx * view.kmPerPx), px = km / view.kmPerPx;
    var unit = km < 1 ? "m" : "km", show = function (v) { return (km < 1 ? Math.round(v * 1000) : +v.toFixed(2)).toLocaleString("id-ID"); };
    var w = px + 70, h = 92, x = fr.x + fr.w - w - 14, y = fr.y + fr.h - h - 14;
    box(ctx, x, y, w, h);

    // North arrow (cylindrical projection: meridians are vertical, so north is straight up).
    var ax = x + 26, ay = y + 20;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(ax + 9, ay + 30); ctx.lineTo(ax, ay + 24); ctx.closePath();
    ctx.fillStyle = C.ink; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(ax - 9, ay + 30); ctx.lineTo(ax, ay + 24); ctx.closePath();
    ctx.fillStyle = "#fff"; ctx.fill();
    ctx.strokeStyle = C.ink; ctx.lineWidth = 1; ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(ax + 9, ay + 30); ctx.lineTo(ax, ay + 24); ctx.lineTo(ax - 9, ay + 30); ctx.closePath();
    ctx.stroke();
    font(ctx, 13, 700);
    ctx.fillStyle = C.ink;
    ctx.textAlign = "center";
    ctx.fillText("U", ax, ay + 46);

    // Alternating 4-segment bar.
    var bx = x + 52, by = y + 40, seg = px / 4;
    for (var i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? "#fff" : C.ink;
      ctx.fillRect(bx + i * seg, by, seg, 6);
    }
    ctx.strokeStyle = C.ink;
    ctx.strokeRect(bx + 0.5, by + 0.5, px - 1, 5);
    font(ctx, 12, 400);
    ctx.fillStyle = C.ink;
    ctx.textBaseline = "top";
    ctx.fillText("0", bx, by + 10);
    ctx.fillText(show(km / 2), bx + px / 2, by + 10);
    ctx.fillText(show(km) + " " + unit, bx + px, by + 10);
    ctx.fillStyle = C.faint;
    font(ctx, 11, 400);
    ctx.fillText("Skala benar pada " + formatDeg(Math.round(view.lat0 * 60) / 60, "y"), bx + px / 2, by + 30);
    ctx.restore();
    return { x: x, y: y, w: w, h: h };
  }

  // Locator inset: where the map sits in the wider region. Only drawn when the
  // map covers a small part of the region, where it adds information.
  function drawLocator(ctx, view, basemap, region) {
    var fr = view.frame, vb = view.bbox;
    var share = Math.max((vb[2] - vb[0]) / (region[2] - region[0]), (vb[3] - vb[1]) / (region[3] - region[1]));
    if (share > 0.4) return null;
    // Data outside the region: the inset would show nothing useful.
    if (vb[2] < region[0] || vb[0] > region[2] || vb[3] < region[1] || vb[1] > region[3]) return null;
    var w = 300, h = 140, x = fr.x + fr.w - w - 14, y = fr.y + 14;
    var inner = { x: x + 1, y: y + 1, w: w - 2, h: h - 2 };
    var lv = makeView(region, inner, { pad: 0.02 });
    ctx.save();
    ctx.beginPath();
    ctx.rect(inner.x, inner.y, inner.w, inner.h);
    ctx.clip();
    ctx.fillStyle = C.sea;
    ctx.fillRect(inner.x, inner.y, inner.w, inner.h);
    var sc = basemap.scale;
    ctx.beginPath();
    basemap.countries.forEach(function (c) {
      c.rings.forEach(function (r) {
        var lx = null, ly = null;
        for (var i = 0; i < r.length; i += 2) {
          var px = lv.x(r[i] / sc), py = lv.y(r[i + 1] / sc);
          if (lx === null) ctx.moveTo(px, py);
          else if (Math.abs(px - lx) + Math.abs(py - ly) >= 0.8) ctx.lineTo(px, py);
          else continue;
          lx = px; ly = py;
        }
        ctx.closePath();
      });
    });
    ctx.fillStyle = "#d9d4c9";
    ctx.fill("evenodd");
    // The current map extent, at least 8 px so it stays visible.
    var rx0 = lv.x(vb[0]), rx1 = lv.x(vb[2]), ry0 = lv.y(vb[3]), ry1 = lv.y(vb[1]);
    var cx = (rx0 + rx1) / 2, cy = (ry0 + ry1) / 2, rw = Math.max(8, rx1 - rx0), rh = Math.max(8, ry1 - ry0);
    ctx.strokeStyle = "#c0392b";
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - rw / 2, cy - rh / 2, rw, rh);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = C.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
    return { x: x, y: y, w: w, h: h };
  }

  // Renders the map on `canvas` (it is resized to the output size).
  // opts: { title, subtitle, field, legendTitle, layerName, source, credit, date, region }
  var W = 1600, H = 1000;
  function render(canvas, layer, basemap, opts) {
    opts = opts || {};
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext("2d");
    var frame = { x: 82, y: 108, w: W - 82 - 40, h: 790 };

    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, W, H);

    // Title block.
    ctx.fillStyle = C.ink;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    var title = fitText(ctx, opts.title || "Peta Cakupan Data", frame.w + 42, 30, 700, 20);
    ctx.fillText(title, 40, 54);
    if (opts.subtitle) {
      ctx.fillStyle = C.muted;
      ctx.fillText(fitText(ctx, opts.subtitle, frame.w + 42, 16, 400, 12), 40, 82);
    }

    var view = makeView(layer.bbox, frame);
    var classes = classify(layer, opts.field);
    var focus = focusCountry(layer, basemap);
    drawBasemap(ctx, view, basemap, focus);
    var lines = drawGraticule(ctx, view);
    drawData(ctx, view, layer, classes, opts.field);

    // Neatline.
    ctx.strokeStyle = C.frame;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(frame.x + 0.5, frame.y + 0.5, frame.w - 1, frame.h - 1);
    drawGridLabels(ctx, view, lines);

    var boxes = [
      drawLegend(ctx, view, layer, classes, {
        legendTitle: opts.field ? opts.legendTitle || opts.field : "Keterangan",
        layerName: opts.layerName || opts.title || "Data",
      }),
      drawScaleAndNorth(ctx, view),
      drawLocator(ctx, view, basemap, opts.region || [94, -11.5, 141.5, 6.5]),
    ];
    drawCountryLabels(ctx, view, basemap, focus, boxes);

    // Credits.
    var y = H - 46;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.muted;
    var sources = (opts.source ? "Sumber data: " + opts.source + "  ·  " : "") + "Peta dasar: Natural Earth";
    var projection = "Proyeksi: Lambert Silinder Sama-Luas, lintang standar " + formatDeg(Math.round(view.lat0 * 60) / 60, "y") + "  ·  Datum WGS 84";
    font(ctx, 12, 600);
    var right = (opts.credit || "GeoSAI") + (opts.date ? " · " + opts.date : "");
    var rightW = ctx.measureText(right).width;
    ctx.fillText(fitText(ctx, sources, W - 80 - rightW - 40, 12, 400, 10), 40, y + 14);
    font(ctx, 12, 400);
    ctx.fillText(projection, 40, y + 32);
    ctx.textAlign = "right";
    font(ctx, 12, 600);
    ctx.fillStyle = C.ink;
    ctx.fillText(right, W - 40, y + 32);
    return { view: view, classes: classes };
  }

  // ---------- Form summary ----------
  // bbox rounded outwards to 4 decimals (~11 m), so it still contains the data.
  function summary(layer) {
    var b = layer.bbox;
    var r = function (v, up) { return (up ? Math.ceil(v * 1e4) : Math.floor(v * 1e4)) / 1e4; };
    return {
      bbox: [r(b[0]), r(b[1]), r(b[2], true), r(b[3], true)],
      features: layer.features.length,
      geometry: layer.geometry,
      attributes: layer.fields.map(function (f) { return { name: f.name, type: f.type }; }),
      crs: layer.crs,
      format: layer.format,
    };
  }

  return {
    load: load,
    parseGeoJSON: parseGeoJSON,
    parseShapefile: parseShapefile,
    parseDbf: parseDbf,
    parsePrj: parsePrj,
    geojsonCrs: geojsonCrs,
    readZip: readZip,
    tmInverse: tmInverse,
    categoryFields: categoryFields,
    categories: categories,
    fieldKind: fieldKind,
    fieldOptions: fieldOptions,
    ranges: ranges,
    classify: classify,
    niceFloor: niceFloor,
    gridStep: gridStep,
    formatDeg: formatDeg,
    makeView: makeView,
    render: render,
    summary: summary,
    SIZE: { width: W, height: H },
  };
});
