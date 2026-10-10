// Data converter (konversi-data.html): reads GeoJSON, shapefiles (.zip or the
// loose .shp/.dbf/.prj files), KML/KMZ, GPX or CSV, and writes GeoJSON, a
// zipped shapefile, KML or CSV. Everything happens in the visitor's browser
// (in a worker, geoconvertworker.js); nothing is uploaded or stored.
//
// The data model is a GeoJSON FeatureCollection in WGS 84 with RFC 7946
// winding (polygon outer rings counter-clockwise, holes clockwise):
// { features, fields: [{ name, type }], crs, format, bbox }.
//
// Shared by the worker (browser) and the tests (Node), like staticmap.js.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./staticmap"));
  else root.GeoConvert = factory(root.StaticMap);
})(this, function (SM) {
  "use strict";

  function fail(msg) { throw new Error(msg); }

  // ---------- How big a file this browser can take ----------
  // The whole file is held in memory, then parsed into objects, then written
  // out again: peak memory is roughly 5–8× the file size for text formats
  // (GeoJSON, KML, CSV). Browsers kill a tab long before the device runs out:
  // desktop Chrome/Edge/Firefox allow about 4 GB per tab, phones (iOS Safari
  // especially) about 1–1.5 GB. A JavaScript string also cannot be longer than
  // ~512 million characters (Chrome), which caps a GeoJSON/KML/CSV file.
  // navigator.deviceMemory (Chrome/Edge only, in GB, capped at 8) lowers the
  // limit on small devices.
  var MB = 1024 * 1024;
  function sizeLimit(env) {
    env = env || {};
    var mem = env.deviceMemory;
    if (env.mobile) return (mem >= 6 ? 100 : 50) * MB;
    if (mem && mem <= 2) return 75 * MB;
    if (mem && mem <= 4) return 150 * MB;
    return 250 * MB;
  }

  // ---------- Geometry helpers ----------
  var DEPTH = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };

  function eachPosition(g, fn) {
    if (!g) return;
    if (g.type === "GeometryCollection") { g.geometries.forEach(function (x) { eachPosition(x, fn); }); return; }
    (function walk(a, d) {
      if (d === 0) fn(a);
      else for (var i = 0; i < a.length; i++) walk(a[i], d - 1);
    })(g.coordinates, DEPTH[g.type]);
  }

  // Signed area (shoelace): positive for counter-clockwise rings.
  function ringArea(r) {
    var s = 0;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] * r[i][1]) - (r[i][0] * r[j][1]);
    return s / 2;
  }
  function wind(ring, ccw) { return (ringArea(ring) > 0) === ccw ? ring : ring.slice().reverse(); }
  function closeRing(r) {
    if (!r.length) return r;
    var a = r[0], b = r[r.length - 1];
    return a[0] === b[0] && a[1] === b[1] ? r : r.concat([a.slice()]);
  }
  function inRing(pt, ring) {
    var x = pt[0], y = pt[1], inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function rewind(g) {
    if (g.type === "Polygon") g.coordinates = g.coordinates.map(function (r, i) { return wind(r, i === 0); });
    if (g.type === "MultiPolygon") g.coordinates = g.coordinates.map(function (p) { return p.map(function (r, i) { return wind(r, i === 0); }); });
    if (g.type === "GeometryCollection") g.geometries.forEach(rewind);
    return g;
  }

  // Several geometries of one feature (KML MultiGeometry, shapefile parts) as one.
  function merge(list) {
    list = list.filter(Boolean);
    if (list.length < 2) return list[0] || null;
    var types = {};
    list.forEach(function (g) { types[g.type.replace(/^Multi/, "")] = true; });
    var k = Object.keys(types);
    if (k.length === 1 && k[0] !== "GeometryCollection") {
      var coords = [];
      list.forEach(function (g) {
        if (/^Multi/.test(g.type)) coords.push.apply(coords, g.coordinates);
        else coords.push(g.coordinates);
      });
      return { type: "Multi" + k[0], coordinates: coords };
    }
    return { type: "GeometryCollection", geometries: list };
  }

  // Shapefile polygons are a flat list of rings: outer rings clockwise, holes
  // counter-clockwise. Each hole goes into the smallest outer ring around it.
  function polygonFromRings(rings) {
    rings = rings.filter(function (r) { return r.length >= 3; });
    if (!rings.length) return null;
    var outers = [], holes = [];
    rings.forEach(function (r) { (ringArea(r) < 0 ? outers : holes).push(r); });
    if (!outers.length) { outers = holes; holes = []; }
    var polys = outers.map(function (r) { return { outer: r, area: Math.abs(ringArea(r)), holes: [] }; });
    holes.forEach(function (h) {
      var best = null;
      polys.forEach(function (p) { if (inRing(h[0], p.outer) && (!best || p.area < best.area)) best = p; });
      if (best) best.holes.push(h);
      else polys.push({ outer: h, area: Math.abs(ringArea(h)), holes: [] });
    });
    var coords = polys.map(function (p) {
      return [wind(p.outer, true)].concat(p.holes.map(function (h) { return wind(h, false); }));
    });
    return coords.length === 1 ? { type: "Polygon", coordinates: coords[0] } : { type: "MultiPolygon", coordinates: coords };
  }

  // ---------- The common model ----------
  function inferFields(features) {
    var names = [], kinds = {};
    features.forEach(function (f) {
      var p = f.properties;
      for (var k in p) {
        if (!kinds[k]) { kinds[k] = {}; names.push(k); }
        var v = p[k];
        if (v == null || v === "") continue;
        kinds[k][typeof v === "number" ? (Number.isInteger(v) ? "Integer" : "Double") : typeof v === "boolean" ? "Boolean" : "Text"] = true;
      }
    });
    return names.map(function (n) {
      var k = Object.keys(kinds[n]);
      return { name: n, type: k.length === 1 ? k[0] : k.length === 2 && kinds[n].Integer && kinds[n].Double ? "Double" : "Text" };
    });
  }

  // Text formats (CSV, KML, GPX) carry every value as text. A column whose
  // values are all plain numbers becomes a number column; codes with a
  // leading zero ("0101") stay text so they are not changed.
  var NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
  function typeColumns(features) {
    var numeric = {};
    features.forEach(function (f) {
      for (var k in f.properties) {
        var v = f.properties[k];
        if (numeric[k] === false || v == null || v === "") continue;
        numeric[k] = typeof v === "string" && NUMBER.test(v.trim()) && v.trim().length < 16;
      }
    });
    features.forEach(function (f) {
      for (var k in f.properties) {
        var v = f.properties[k];
        if (numeric[k]) f.properties[k] = v == null || v === "" ? null : Number(v);
      }
    });
  }

  function collection(features, crs, format, fields) {
    var b = [Infinity, Infinity, -Infinity, -Infinity], any = false;
    features.forEach(function (f) {
      eachPosition(f.geometry, function (p) {
        any = true;
        if (p[0] < b[0]) b[0] = p[0];
        if (p[0] > b[2]) b[2] = p[0];
        if (p[1] < b[1]) b[1] = p[1];
        if (p[1] > b[3]) b[3] = p[1];
      });
    });
    if (!any) fail("The file has no features with geometry.");
    if (!b.every(isFinite) || b[0] < -180.5 || b[2] > 180.5 || b[1] < -90.5 || b[3] > 90.5) {
      fail("The coordinates are not longitude/latitude and the file does not say which projection it uses. Export the data as WGS 84 (EPSG:4326) and try again.");
    }
    return { features: features, fields: fields || inferFields(features), crs: crs || "WGS 84", format: format, bbox: b };
  }

  function summary(data) {
    var geometries = {}, empty = 0;
    data.features.forEach(function (f) {
      if (!f.geometry) empty++;
      else geometries[f.geometry.type] = (geometries[f.geometry.type] || 0) + 1;
    });
    return {
      features: data.features.length, geometries: geometries, empty: empty,
      fields: data.fields, crs: data.crs, format: data.format, bbox: data.bbox,
    };
  }

  // ---------- GeoJSON ----------
  function cleanGeometry(g, toLonLat) {
    if (!g || typeof g !== "object") return null;
    if (g.type === "GeometryCollection") {
      var parts = (g.geometries || []).map(function (x) { return cleanGeometry(x, toLonLat); }).filter(Boolean);
      return parts.length ? { type: g.type, geometries: parts } : null;
    }
    var depth = DEPTH[g.type];
    if (depth == null || !Array.isArray(g.coordinates)) return null;
    var pos = function (p) {
      var x = Number(p[0]), y = Number(p[1]);
      var out = toLonLat ? toLonLat(x, y) : [x, y];
      if (p.length > 2 && isFinite(p[2]) && p[2] !== null) out.push(Number(p[2]));
      return out;
    };
    var c = (function walk(a, d) { return d === 0 ? pos(a) : a.map(function (x) { return walk(x, d - 1); }); })(g.coordinates, depth);
    if (depth > 0 && !c.length) return null;
    return rewind({ type: g.type, coordinates: c });
  }

  function fromGeoJSON(input) {
    var gj = typeof input === "string" ? JSON.parse(input) : input;
    if (!gj || typeof gj !== "object") fail("This is not a GeoJSON file.");
    var crs = SM.geojsonCrs(gj.crs);
    var list = gj.type === "FeatureCollection" ? gj.features || [] :
      gj.type === "Feature" ? [gj] : DEPTH[gj.type] != null || gj.type === "GeometryCollection" ? [{ geometry: gj }] : fail("This is not a GeoJSON file.");
    var features = list.filter(Boolean).map(function (f) {
      var out = { type: "Feature", properties: f.properties || {}, geometry: cleanGeometry(f.geometry, crs.toLonLat) };
      if (f.id != null) out.id = f.id;
      return out;
    });
    return collection(features, crs.name, "GeoJSON");
  }

  // ---------- Shapefile (parsed by staticmap.js) ----------
  function pairs(flat) {
    var out = [];
    for (var i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
    return out;
  }
  function fromLayer(layer) {
    var features = layer.features.map(function (f) {
      var g;
      if (f.kind === "point") {
        g = f.parts.length === 1 ? { type: "Point", coordinates: pairs(f.parts[0])[0] } :
          { type: "MultiPoint", coordinates: f.parts.map(function (p) { return pairs(p)[0]; }) };
      } else if (f.kind === "line") {
        g = f.parts.length === 1 ? { type: "LineString", coordinates: pairs(f.parts[0]) } :
          { type: "MultiLineString", coordinates: f.parts.map(pairs) };
      } else {
        g = polygonFromRings(f.parts.map(pairs));
      }
      return { type: "Feature", properties: f.props, geometry: g };
    });
    return collection(features, layer.crs, "Shapefile", layer.fields);
  }

  // ---------- A small XML reader (KML, GPX) ----------
  // Works the same in a worker and in Node, where there is no DOMParser.
  var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  function unescapeXml(s) {
    return s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, function (m, e) {
      if (e[0] === "#") {
        var code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e] != null ? ENTITIES[e] : m;
    });
  }
  function local(name) { return name.replace(/^[^:]*:/, ""); }
  function parseXml(text) {
    var root = { name: "#root", attrs: {}, children: [], text: "" }, stack = [root], m;
    var re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s>/]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
    while ((m = re.exec(text))) {
      var top = stack[stack.length - 1];
      if (m[1] != null) top.text += m[1];
      else if (m[2]) {
        var name = local(m[2]);
        for (var i = stack.length - 1; i > 0; i--) if (stack[i].name === name) { stack.length = i; break; }
      } else if (m[3]) {
        var attrs = {}, a, are = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        while ((a = are.exec(m[4]))) attrs[local(a[1])] = unescapeXml(a[2] != null ? a[2] : a[3]);
        var el = { name: local(m[3]), attrs: attrs, children: [], text: "" };
        top.children.push(el);
        if (!m[5]) stack.push(el);
      } else if (m[6] != null) top.text += unescapeXml(m[6]);
    }
    return root;
  }
  function kids(el, name) { return el ? el.children.filter(function (c) { return c.name === name; }) : []; }
  function kid(el, name) { return kids(el, name)[0] || null; }
  function txt(el) { return el ? el.text.trim() : ""; }
  function descendants(el, name, out) {
    out = out || [];
    el.children.forEach(function (c) {
      if (c.name === name) out.push(c);
      else descendants(c, name, out);
    });
    return out;
  }

  // ---------- KML ----------
  function kmlCoords(el) {
    var out = [];
    txt(el).split(/\s+/).forEach(function (t) {
      var p = t.split(",").map(Number);
      if (p.length < 2 || !isFinite(p[0]) || !isFinite(p[1]) || t === "") return;
      out.push(p.length > 2 && isFinite(p[2]) && p[2] !== 0 ? [p[0], p[1], p[2]] : [p[0], p[1]]);
    });
    return out;
  }
  function kmlRing(boundary) {
    var ring = kmlCoords(kid(kid(boundary, "LinearRing"), "coordinates"));
    return ring.length >= 3 ? closeRing(ring) : null;
  }
  var KML_GEOMETRY = { Point: 1, LineString: 1, LinearRing: 1, Polygon: 1, MultiGeometry: 1, Track: 1, MultiTrack: 1 };
  function kmlGeometry(el) {
    var c;
    switch (el.name) {
      case "Point":
        c = kmlCoords(kid(el, "coordinates"));
        return c.length ? { type: "Point", coordinates: c[0] } : null;
      case "LineString":
      case "LinearRing":
        c = kmlCoords(kid(el, "coordinates"));
        return c.length >= 2 ? { type: "LineString", coordinates: c } : null;
      case "Polygon":
        var outer = kmlRing(kid(el, "outerBoundaryIs"));
        if (!outer) return null;
        var holes = [];
        kids(el, "innerBoundaryIs").forEach(function (b) {
          kids(b, "LinearRing").forEach(function (r) {
            var ring = kmlCoords(kid(r, "coordinates"));
            if (ring.length >= 3) holes.push(closeRing(ring));
          });
        });
        return rewind({ type: "Polygon", coordinates: [outer].concat(holes) });
      case "Track": // gx:Track: <gx:coord>lon lat alt</gx:coord>
        c = kids(el, "coord").map(function (k) { return txt(k).split(/\s+/).map(Number); })
          .filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); })
          .map(function (p) { return [p[0], p[1]]; });
        return c.length >= 2 ? { type: "LineString", coordinates: c } : null;
      case "MultiTrack":
      case "MultiGeometry":
        return merge(el.children.filter(function (k) { return KML_GEOMETRY[k.name]; }).map(kmlGeometry));
    }
    return null;
  }
  function fromKML(text) {
    var doc = parseXml(text);
    if (!descendants(doc, "kml").length && !descendants(doc, "Placemark").length) fail("This is not a KML file.");
    var features = descendants(doc, "Placemark").map(function (pm) {
      var props = {};
      if (kid(pm, "name")) props.name = txt(kid(pm, "name"));
      if (txt(kid(pm, "description"))) props.description = txt(kid(pm, "description"));
      var ext = kid(pm, "ExtendedData");
      if (ext) {
        kids(ext, "Data").forEach(function (d) { if (d.attrs.name) props[d.attrs.name] = txt(kid(d, "value")); });
        descendants(ext, "SimpleData").forEach(function (d) { if (d.attrs.name) props[d.attrs.name] = txt(d); });
      }
      var g = pm.children.filter(function (k) { return KML_GEOMETRY[k.name]; })[0];
      return { type: "Feature", properties: props, geometry: g ? kmlGeometry(g) : null };
    });
    typeColumns(features);
    return collection(features, "WGS 84", "KML");
  }

  // ---------- GPX ----------
  function fromGPX(text) {
    var doc = parseXml(text);
    if (!descendants(doc, "gpx").length) fail("This is not a GPX file.");
    var features = [];
    var point = function (el) {
      var lon = parseFloat(el.attrs.lon), lat = parseFloat(el.attrs.lat), ele = parseFloat(txt(kid(el, "ele")));
      if (!isFinite(lon) || !isFinite(lat)) return null;
      return isFinite(ele) ? [lon, lat, ele] : [lon, lat];
    };
    var props = function (el, kind) {
      var p = { gpx_type: kind };
      ["name", "desc", "cmt", "type", "time"].forEach(function (k) { if (txt(kid(el, k))) p[k] = txt(kid(el, k)); });
      return p;
    };
    descendants(doc, "wpt").forEach(function (w) {
      var p = point(w), pr = props(w, "waypoint");
      if (p && p.length > 2) pr.ele = p[2];
      features.push({ type: "Feature", properties: pr, geometry: p ? { type: "Point", coordinates: p } : null });
    });
    descendants(doc, "rte").forEach(function (r) {
      var line = kids(r, "rtept").map(point).filter(Boolean);
      features.push({ type: "Feature", properties: props(r, "route"), geometry: line.length >= 2 ? { type: "LineString", coordinates: line } : null });
    });
    descendants(doc, "trk").forEach(function (t) {
      var segs = kids(t, "trkseg").map(function (s) { return kids(s, "trkpt").map(point).filter(Boolean); })
        .filter(function (s) { return s.length >= 2; });
      features.push({ type: "Feature", properties: props(t, "track"),
        geometry: segs.length === 1 ? { type: "LineString", coordinates: segs[0] } : segs.length ? { type: "MultiLineString", coordinates: segs } : null });
    });
    typeColumns(features);
    return collection(features, "WGS 84", "GPX");
  }

  // ---------- CSV ----------
  function detectDelimiter(text) {
    var line = text.slice(0, Math.max(0, text.indexOf("\n")) || 10000).replace(/"[^"]*"/g, "");
    var best = ",", n = 0;
    [",", ";", "\t", "|"].forEach(function (d) {
      var c = line.split(d).length - 1;
      if (c > n) { best = d; n = c; }
    });
    return best;
  }
  function parseCsv(text, d) {
    var rows = [], row = [], i = 0, n = text.length, m;
    var stop = new RegExp("[" + (d === "\t" ? "\\t" : d === "|" ? "\\|" : d) + "\\r\\n]", "g");
    for (;;) {
      var v;
      if (text[i] === '"') {
        var j = i + 1, k;
        for (;;) {
          k = text.indexOf('"', j);
          if (k < 0) { k = n; break; }
          if (text[k + 1] === '"') { j = k + 2; continue; }
          break;
        }
        v = text.slice(i + 1, k).replace(/""/g, '"');
        stop.lastIndex = Math.min(k + 1, n);
        m = stop.exec(text);
        i = m ? m.index : n;
      } else {
        stop.lastIndex = i;
        m = stop.exec(text);
        var e = m ? m.index : n;
        v = text.slice(i, e);
        i = e;
      }
      row.push(v);
      if (text[i] === d) { i++; continue; }
      if (text[i] === "\r") i++;
      if (text[i] === "\n") i++;
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (i >= n) break;
    }
    return rows;
  }

  // WKT, as written by QGIS, PostGIS and spreadsheets: POINT (x y),
  // LINESTRING, POLYGON, their MULTI forms and GEOMETRYCOLLECTION. Z and M
  // values are dropped.
  var WKT_TYPES = { POINT: "Point", MULTIPOINT: "MultiPoint", LINESTRING: "LineString", MULTILINESTRING: "MultiLineString", POLYGON: "Polygon", MULTIPOLYGON: "MultiPolygon" };
  function parseWkt(s) {
    s = String(s || "").trim().replace(/^SRID=\d+;\s*/i, "");
    var m = /^([A-Za-z]+)\s*(?:ZM|Z|M)?\s*(\([\s\S]*\)|EMPTY)$/i.exec(s);
    if (!m || /EMPTY/i.test(m[2])) return null;
    var type = m[1].toUpperCase();
    if (type === "GEOMETRYCOLLECTION") {
      var body = m[2].slice(1, -1), parts = [], depth = 0, start = 0;
      for (var i = 0; i < body.length; i++) {
        if (body[i] === "(") depth++;
        else if (body[i] === ")") depth--;
        else if (body[i] === "," && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
      }
      parts.push(body.slice(start));
      var geoms = parts.map(parseWkt).filter(Boolean);
      return geoms.length ? { type: "GeometryCollection", geometries: geoms } : null;
    }
    if (!WKT_TYPES[type]) return null;
    var c;
    try {
      c = JSON.parse(m[2].replace(/[-+.\deE]+(\s+[-+.\deE]+)+/g, function (p) {
        var xy = p.trim().split(/\s+/).slice(0, 2);
        return "[" + Number(xy[0]) + "," + Number(xy[1]) + "]";
      }).replace(/\(/g, "[").replace(/\)/g, "]"));
    } catch (e) { return null; }
    if (type === "POINT") c = c[0];
    if (type === "MULTIPOINT") c = c.map(function (p) { return Array.isArray(p[0]) ? p[0] : p; });
    var g = { type: WKT_TYPES[type], coordinates: c }, ok = true;
    try { eachPosition(g, function (p) { if (!isFinite(p[0]) || !isFinite(p[1])) ok = false; }); } catch (e) { ok = false; }
    return ok ? rewind(g) : null;
  }

  var LON = ["longitude", "lon", "lng", "long", "bujur", "x"];
  var LAT = ["latitude", "lat", "lintang", "y"];
  var WKT_COLS = ["wkt", "wkt_geom", "geometry", "geom", "the_geom", "shape"];
  function findColumn(head, names) {
    var lower = head.map(function (h) { return h.trim().toLowerCase(); });
    for (var i = 0; i < names.length; i++) {
      var at = lower.indexOf(names[i]);
      if (at >= 0) return at;
    }
    return -1;
  }
  function coord(v) {
    v = String(v == null ? "" : v).trim().replace(",", ".");
    return v === "" ? NaN : Number(v);
  }
  function fromCSV(text) {
    text = text.replace(/^\uFEFF/, "");
    var rows = parseCsv(text, detectDelimiter(text));
    if (rows.length < 2) fail("The CSV file has no data rows.");
    var seen = {};
    var head = rows[0].map(function (h, i) {
      var name = h.trim() || "kolom_" + (i + 1), base = name, k = 2;
      while (seen[name]) name = base + "_" + k++;
      seen[name] = true;
      return name;
    });
    var wkt = findColumn(head, WKT_COLS), lon = findColumn(head, LON), lat = findColumn(head, LAT);
    var sample = wkt >= 0 ? rows.slice(1).map(function (r) { return r[wkt]; }).filter(Boolean)[0] : null;
    if (wkt >= 0 && !/^\s*(SRID=\d+;\s*)?(POINT|LINESTRING|POLYGON|MULTI|GEOMETRYCOLLECTION)/i.test(sample || "")) wkt = -1;
    if (wkt < 0 && (lon < 0 || lat < 0)) fail("The CSV file has no coordinate columns.");
    var features = rows.slice(1).map(function (r) {
      var props = {}, g = null;
      head.forEach(function (h, i) { if (i !== wkt) props[h] = r[i] == null ? null : r[i]; });
      if (wkt >= 0) g = parseWkt(r[wkt]);
      else {
        var x = coord(r[lon]), y = coord(r[lat]);
        if (isFinite(x) && isFinite(y)) g = { type: "Point", coordinates: [x, y] };
      }
      return { type: "Feature", properties: props, geometry: g };
    });
    typeColumns(features);
    return collection(features, "WGS 84", "CSV");
  }

  // ---------- Reading the files a visitor picked ----------
  function ext(name) { return ((name.match(/\.([^./]+)$/) || [])[1] || "").toLowerCase(); }
  function textOf(bytes) { return new TextDecoder().decode(bytes); }
  function bytesOf(file) { return file.arrayBuffer().then(function (b) { return new Uint8Array(b); }); }

  function fromShapefileEntries(entries) {
    var shps = entries.filter(function (e) { return /\.shp$/i.test(e.name); });
    // Several shapefiles in one zip: convert the largest (the others are usually helpers).
    var shp = shps.sort(function (a, b) { return b.data.length - a.data.length; })[0];
    var stem = shp.name.replace(/\.shp$/i, "").toLowerCase();
    var part = function (x) { return entries.filter(function (e) { return e.name.toLowerCase() === stem + "." + x; })[0]; };
    return fromLayer(SM.parseShapefile({
      shp: shp.data,
      dbf: part("dbf") && part("dbf").data,
      prj: part("prj") && textOf(part("prj").data),
      cpg: part("cpg") && textOf(part("cpg").data),
    }));
  }

  function fromText(name, text) {
    var e = ext(name);
    if (e === "kml") return fromKML(text);
    if (e === "gpx") return fromGPX(text);
    if (e === "csv" || e === "txt" || e === "tsv") return fromCSV(text);
    return fromGeoJSON(text);
  }

  // Accepts one .geojson/.json/.kml/.kmz/.gpx/.csv, one .zip (a shapefile, or
  // one of the other formats, inside), or the .shp/.dbf/.prj/.cpg files
  // picked together. opts.maxBytes caps the input size (see sizeLimit).
  function read(fileList, opts) {
    var files = Array.prototype.slice.call(fileList || []), max = (opts && opts.maxBytes) || 0;
    if (!files.length) return Promise.reject(new Error("Choose a file first."));
    var total = files.reduce(function (s, f) { return s + f.size; }, 0);
    if (max && total > max) return Promise.reject(new Error("The file is too large for this browser."));
    var byExt = {};
    files.forEach(function (f) { byExt[ext(f.name)] = f; });
    var one = ["geojson", "json", "kml", "gpx", "csv", "tsv", "txt"].filter(function (k) { return byExt[k]; })[0];
    if (one) return byExt[one].text().then(function (t) { return fromText(byExt[one].name, t); });
    var zipped = byExt.zip || byExt.kmz;
    if (zipped) {
      return zipped.arrayBuffer().then(function (buf) {
        return SM.readZip(buf, function (n) { return /\.(shp|dbf|prj|cpg|geojson|json|kml|gpx|csv)$/i.test(n); }, max * 2);
      }).then(function (entries) {
        if (entries.some(function (e) { return /\.shp$/i.test(e.name); })) return fromShapefileEntries(entries);
        // KMZ is a zip with doc.kml inside; otherwise take the first readable file.
        var order = ["kml", "geojson", "json", "gpx", "csv"];
        var file = entries.slice().sort(function (a, b) { return order.indexOf(ext(a.name)) - order.indexOf(ext(b.name)); })[0];
        if (!file) fail("The .zip file has no shapefile (.shp) or other readable file inside.");
        var data = fromText(file.name, textOf(file.data));
        if (byExt.kmz) data.format = "KMZ";
        return data;
      });
    }
    if (byExt.shp) {
      return Promise.all([byExt.shp, byExt.dbf, byExt.prj, byExt.cpg].map(function (f) { return f ? bytesOf(f) : null; })).then(function (b) {
        return fromLayer(SM.parseShapefile({ shp: b[0], dbf: b[1], prj: b[2] && textOf(b[2]), cpg: b[3] && textOf(b[3]) }));
      });
    }
    return Promise.reject(new Error("Choose a .geojson, .kml, .kmz, .gpx, .csv, a zipped shapefile (.zip), or the .shp, .dbf and .prj files together."));
  }

  // ---------- Writing ----------
  // Output is built as a list of ~1 MB strings and handed to a Blob, never as
  // one big string: a single string is capped at ~512 million characters.
  function chunker() {
    var parts = [], buf = [], size = 0;
    function flush() { if (buf.length) parts.push(buf.join("")); buf = []; size = 0; }
    return {
      add: function (s) { buf.push(s); size += s.length; if (size > MB) flush(); },
      done: function () { flush(); return parts; },
    };
  }

  function toGeoJSON(data, name) {
    var out = chunker();
    out.add('{"type":"FeatureCollection","name":' + JSON.stringify(name) + ',"features":[\n');
    data.features.forEach(function (f, i) { out.add((i ? ",\n" : "") + JSON.stringify(f)); });
    out.add("\n]}\n");
    return { parts: out.done(), mime: "application/geo+json", ext: "geojson", warnings: [] };
  }

  function xml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]; });
  }
  function valueText(v) { return v != null && typeof v === "object" ? JSON.stringify(v) : String(v); }
  function kmlPositions(list) { return "<coordinates>" + list.map(function (p) { return p.join(","); }).join(" ") + "</coordinates>"; }
  function kmlPolygon(rings) {
    return "<Polygon><outerBoundaryIs><LinearRing>" + kmlPositions(rings[0]) + "</LinearRing></outerBoundaryIs>" +
      rings.slice(1).map(function (r) { return "<innerBoundaryIs><LinearRing>" + kmlPositions(r) + "</LinearRing></innerBoundaryIs>"; }).join("") + "</Polygon>";
  }
  function kmlOf(g) {
    if (!g) return "";
    var c = g.coordinates, multi = function (list) { return "<MultiGeometry>" + list.join("") + "</MultiGeometry>"; };
    switch (g.type) {
      case "Point": return "<Point>" + kmlPositions([c]) + "</Point>";
      case "MultiPoint": return multi(c.map(function (p) { return "<Point>" + kmlPositions([p]) + "</Point>"; }));
      case "LineString": return "<LineString>" + kmlPositions(c) + "</LineString>";
      case "MultiLineString": return multi(c.map(function (l) { return "<LineString>" + kmlPositions(l) + "</LineString>"; }));
      case "Polygon": return kmlPolygon(c);
      case "MultiPolygon": return multi(c.map(kmlPolygon));
      case "GeometryCollection": return multi(g.geometries.map(kmlOf));
    }
    return "";
  }
  // The field Google Earth shows as each feature's label.
  function nameField(fields) {
    var f = fields.filter(function (x) { return /^(name|nama|namobj|nm_?\w*|label|judul|title)$/i.test(x.name); })[0];
    return f ? f.name : null;
  }
  function toKML(data, name) {
    var out = chunker(), label = nameField(data.fields);
    out.add('<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n<name>' + xml(name) + "</name>\n");
    data.features.forEach(function (f) {
      var p = f.properties, extended = "";
      for (var k in p) {
        if (p[k] == null || p[k] === "") continue;
        extended += '<Data name="' + xml(k) + '"><value>' + xml(valueText(p[k])) + "</value></Data>";
      }
      out.add("<Placemark>" + (label && p[label] != null ? "<name>" + xml(valueText(p[label])) + "</name>" : "") +
        (extended ? "<ExtendedData>" + extended + "</ExtendedData>" : "") + kmlOf(f.geometry) + "</Placemark>\n");
    });
    out.add("</Document>\n</kml>\n");
    return { parts: out.done(), mime: "application/vnd.google-earth.kml+xml", ext: "kml", warnings: [] };
  }

  function wktPositions(list) { return "(" + list.map(function (p) { return p[0] + " " + p[1]; }).join(", ") + ")"; }
  function wktOf(g) {
    if (!g) return "";
    var c = g.coordinates, rings = function (r) { return "(" + r.map(wktPositions).join(", ") + ")"; };
    switch (g.type) {
      case "Point": return "POINT (" + c[0] + " " + c[1] + ")";
      case "MultiPoint": return "MULTIPOINT (" + c.map(function (p) { return "(" + p[0] + " " + p[1] + ")"; }).join(", ") + ")";
      case "LineString": return "LINESTRING " + wktPositions(c);
      case "MultiLineString": return "MULTILINESTRING " + rings(c);
      case "Polygon": return "POLYGON " + rings(c);
      case "MultiPolygon": return "MULTIPOLYGON (" + c.map(rings).join(", ") + ")";
      case "GeometryCollection": return "GEOMETRYCOLLECTION (" + g.geometries.map(wktOf).join(", ") + ")";
    }
    return "";
  }
  function csvCell(v) {
    if (v == null) return "";
    var s = valueText(v);
    return /[",;\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  var EXCEL_CELL = 32767; // characters; longer cells are cut off by Excel
  function toCSV(data) {
    var names = data.fields.map(function (f) { return f.name; }), taken = {};
    names.forEach(function (n) { taken[n.toLowerCase()] = true; });
    var unique = function (n) { var base = n, k = 2; while (taken[n.toLowerCase()]) n = base + "_" + k++; taken[n.toLowerCase()] = true; return n; };
    var points = data.features.every(function (f) { return !f.geometry || f.geometry.type === "Point"; });
    // Points get longitude/latitude columns; if the data already has them
    // (a CSV converted again), they are filled from the geometry instead.
    var lon = names.indexOf("longitude"), lat = names.indexOf("latitude"), reuse = points && lon >= 0 && lat >= 0;
    var geomCols = reuse ? [] : points ? [unique("longitude"), unique("latitude")] : [unique("WKT")];
    var out = chunker(), long = 0;
    // The byte-order mark makes Excel read the file as UTF-8.
    out.add("\uFEFF" + names.concat(geomCols).map(csvCell).join(",") + "\r\n");
    data.features.forEach(function (f) {
      var cells = names.map(function (n) { return csvCell(f.properties[n]); }), g = f.geometry;
      if (reuse) { if (g) { cells[lon] = g.coordinates[0]; cells[lat] = g.coordinates[1]; } }
      else if (points) cells.push(g ? g.coordinates[0] : "", g ? g.coordinates[1] : "");
      else {
        var w = wktOf(g);
        if (w.length > EXCEL_CELL) long++;
        cells.push(csvCell(w));
      }
      out.add(cells.join(",") + "\r\n");
    });
    return { parts: out.done(), mime: "text/csv", ext: "csv", warnings: long ? [{ code: "excel-cell", count: long }] : [] };
  }

  // ---------- Shapefile writer ----------
  // A shapefile holds one geometry type, so mixed data becomes one shapefile
  // per type in the same zip. Coordinates are WGS 84 (with a .prj saying so),
  // text is UTF-8 (with a .cpg saying so).
  var PRJ_WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  var GROUP_NAMES = { point: "titik", line: "garis", polygon: "poligon" };

  function explode(g, rec, push) {
    if (!g) return;
    var c = g.coordinates;
    switch (g.type) {
      case "Point": push("point", [[c]], rec); break;
      case "MultiPoint": if (c.length) push("point", [c], rec); break;
      case "LineString": push("line", [c], rec); break;
      case "MultiLineString": push("line", c, rec); break;
      case "Polygon": push("polygon", shpRings(c), rec); break;
      case "MultiPolygon": push("polygon", [].concat.apply([], c.map(shpRings)), rec); break;
      case "GeometryCollection": g.geometries.forEach(function (x) { explode(x, rec, push); }); break;
    }
  }
  function shpRings(poly) { return poly.map(function (r, i) { return wind(closeRing(r), i !== 0); }); }

  function writeShp(type, shapes) {
    // shapes: a list of parts per record; each part is a list of [x, y].
    var lengths = shapes.map(function (parts) {
      var n = 0;
      parts.forEach(function (p) { n += p.length; });
      return type === 1 ? 20 : type === 8 ? 40 + 16 * n : 44 + 4 * parts.length + 16 * n;
    });
    var size = 100 + lengths.reduce(function (s, l) { return s + 8 + l; }, 0);
    var shp = new DataView(new ArrayBuffer(size)), shx = new DataView(new ArrayBuffer(100 + 8 * shapes.length));
    var all = [Infinity, Infinity, -Infinity, -Infinity];
    var boxOf = function (parts) {
      var b = [Infinity, Infinity, -Infinity, -Infinity];
      parts.forEach(function (p) {
        p.forEach(function (pt) {
          if (pt[0] < b[0]) b[0] = pt[0];
          if (pt[1] < b[1]) b[1] = pt[1];
          if (pt[0] > b[2]) b[2] = pt[0];
          if (pt[1] > b[3]) b[3] = pt[1];
        });
      });
      return b;
    };
    var at = 100;
    shapes.forEach(function (parts, i) {
      var b = boxOf(parts), len = lengths[i];
      all = [Math.min(all[0], b[0]), Math.min(all[1], b[1]), Math.max(all[2], b[2]), Math.max(all[3], b[3])];
      shx.setInt32(100 + i * 8, at / 2, false);
      shx.setInt32(104 + i * 8, len / 2, false);
      shp.setInt32(at, i + 1, false);
      shp.setInt32(at + 4, len / 2, false);
      var c = at + 8;
      shp.setInt32(c, type, true);
      if (type === 1) {
        shp.setFloat64(c + 4, parts[0][0][0], true);
        shp.setFloat64(c + 12, parts[0][0][1], true);
      } else {
        b.forEach(function (v, k) { shp.setFloat64(c + 4 + k * 8, v, true); });
        var pts = [].concat.apply([], parts), q = c + 36;
        if (type !== 8) {
          shp.setInt32(q, parts.length, true);
          q += 4;
        }
        shp.setInt32(q, pts.length, true);
        q += 4;
        if (type !== 8) {
          var start = 0;
          parts.forEach(function (p) { shp.setInt32(q, start, true); q += 4; start += p.length; });
        }
        pts.forEach(function (pt) { shp.setFloat64(q, pt[0], true); shp.setFloat64(q + 8, pt[1], true); q += 16; });
      }
      at += 8 + len;
    });
    [shp, shx].forEach(function (dv) {
      dv.setInt32(0, 9994, false);
      dv.setInt32(24, dv.byteLength / 2, false);
      dv.setInt32(28, 1000, true);
      dv.setInt32(32, type, true);
      all.forEach(function (v, k) { dv.setFloat64(36 + k * 8, shapes.length ? v : 0, true); });
    });
    return { shp: new Uint8Array(shp.buffer), shx: new Uint8Array(shx.buffer) };
  }

  // dBASE field names: 10 ASCII characters, unique.
  function dbfNames(names) {
    var taken = {}, renamed = [];
    var out = names.map(function (n) {
      var base = n.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 10) || "FIELD";
      var name = base, k = 1;
      while (taken[name.toUpperCase()]) { var s = "_" + k++; name = base.slice(0, 10 - s.length) + s; }
      taken[name.toUpperCase()] = true;
      if (name !== n) renamed.push({ from: n, to: name });
      return name;
    });
    return { names: out, renamed: renamed };
  }

  var encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
  function utf8(s, max) {
    var b = encoder.encode(s);
    if (b.length <= max) return b;
    var end = max;
    while (end > 0 && (b[end] & 0xc0) === 0x80) end--; // don't split a character
    return b.subarray(0, end);
  }
  function decimals(v) {
    var s = String(v);
    if (/e/i.test(s)) return -1;
    var dot = s.indexOf(".");
    return dot < 0 ? 0 : s.length - dot - 1;
  }

  // Column types from the values: N (number), L (true/false), D (date, only
  // if the source said so), or C (text, up to 254 bytes).
  function dbfColumns(fields, records) {
    return fields.map(function (f) {
      var kinds = {}, text = 0, dec = 0, intLen = 1, date = f.type === "Date";
      records.forEach(function (p) {
        var v = p[f.name];
        if (v == null || v === "") return;
        var t = typeof v;
        kinds[t] = true;
        if (t === "number") {
          var d = decimals(v);
          if (d < 0 || !isFinite(v)) kinds.wide = true;
          else {
            dec = Math.max(dec, d);
            intLen = Math.max(intLen, String(Math.trunc(Math.abs(v))).length + (v < 0 ? 1 : 0));
          }
        }
        if (date && !(t === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v))) date = false;
        text = Math.max(text, encoder.encode(valueText(v)).length);
      });
      var k = Object.keys(kinds).filter(function (x) { return x !== "wide"; });
      if (k.length === 1 && k[0] === "number" && !kinds.wide && intLen <= 18) {
        dec = Math.min(dec, 15, 19 - intLen);
        return { type: "N", size: intLen + (dec ? dec + 1 : 0), dec: dec };
      }
      if (k.length === 1 && k[0] === "boolean") return { type: "L", size: 1, dec: 0 };
      if (k.length === 1 && date) return { type: "D", size: 8, dec: 0 };
      return { type: "C", size: Math.max(1, Math.min(254, text)), dec: 0, cut: text > 254 };
    });
  }

  function writeDbf(fields, names, cols, records) {
    var recLen = 1 + cols.reduce(function (s, c) { return s + c.size; }, 0);
    var headLen = 32 + 32 * cols.length + 1;
    var bytes = new Uint8Array(headLen + records.length * recLen + 1);
    var dv = new DataView(bytes.buffer), now = new Date(), cut = 0;
    bytes[0] = 0x03;
    bytes[1] = now.getFullYear() - 1900; bytes[2] = now.getMonth() + 1; bytes[3] = now.getDate();
    dv.setUint32(4, records.length, true);
    dv.setUint16(8, headLen, true);
    dv.setUint16(10, recLen, true);
    cols.forEach(function (c, i) {
      var p = 32 + i * 32;
      for (var j = 0; j < names[i].length; j++) bytes[p + j] = names[i].charCodeAt(j);
      bytes[p + 11] = c.type.charCodeAt(0);
      bytes[p + 16] = c.size;
      bytes[p + 17] = c.dec;
    });
    bytes[headLen - 1] = 0x0d;
    bytes.fill(0x20, headLen, headLen + records.length * recLen);
    records.forEach(function (p, r) {
      var at = headLen + r * recLen + 1;
      cols.forEach(function (c, i) {
        var v = p[fields[i].name], s;
        if (v != null && v !== "") {
          if (c.type === "N") s = c.dec ? v.toFixed(c.dec) : String(Math.round(v));
          else if (c.type === "L") s = v ? "T" : "F";
          else if (c.type === "D") s = v.replace(/-/g, "");
          if (s != null) {
            s = s.slice(0, c.size);
            // Numbers are right-aligned; the rest are left-aligned.
            var start = c.type === "N" ? at + c.size - s.length : at;
            for (var j = 0; j < s.length; j++) bytes[start + j] = s.charCodeAt(j);
          } else {
            var full = valueText(v), b = utf8(full, c.size);
            if (b.length < encoder.encode(full).length) cut++;
            bytes.set(b, at);
          }
        } else if (c.type === "L") bytes[at] = 0x3f; // "?" = no value
        at += c.size;
      });
    });
    bytes[bytes.length - 1] = 0x1a;
    return { bytes: bytes, cut: cut };
  }

  function toShapefile(data, name) {
    var groups = { point: [], line: [], polygon: [] }, empty = 0;
    data.features.forEach(function (f) {
      if (!f.geometry) { empty++; return; }
      explode(f.geometry, f.properties, function (kind, parts, rec) {
        groups[kind].push({ parts: parts.map(function (p) { return p.map(function (pt) { return [pt[0], pt[1]]; }); }), props: rec });
      });
    });
    var kinds = Object.keys(groups).filter(function (k) { return groups[k].length; });
    var warnings = [], fields = data.fields;
    if (fields.length > 255) {
      warnings.push({ code: "too-many-fields", count: fields.length - 255 });
      fields = fields.slice(0, 255);
    }
    var dbf = dbfNames(fields.map(function (f) { return f.name; }));
    if (dbf.renamed.length) warnings.push({ code: "renamed-fields", fields: dbf.renamed });
    if (empty) warnings.push({ code: "no-geometry", count: empty });
    if (kinds.length > 1) warnings.push({ code: "split", kinds: kinds.map(function (k) { return GROUP_NAMES[k]; }) });
    var entries = [], cut = 0;
    kinds.forEach(function (kind) {
      var list = groups[kind], stem = name + (kinds.length > 1 ? "_" + GROUP_NAMES[kind] : "");
      var type = kind === "polygon" ? 5 : kind === "line" ? 3 : list.some(function (r) { return r.parts[0].length > 1; }) ? 8 : 1;
      var shapes = list.map(function (r) { return type === 8 ? [r.parts[0]] : r.parts; });
      var records = list.map(function (r) { return r.props; });
      var files = writeShp(type, shapes);
      var table = writeDbf(fields, dbf.names, dbfColumns(fields, records), records);
      cut += table.cut;
      entries.push(
        { name: stem + ".shp", data: files.shp },
        { name: stem + ".shx", data: files.shx },
        { name: stem + ".dbf", data: table.bytes },
        { name: stem + ".prj", data: encoder.encode(PRJ_WGS84) },
        { name: stem + ".cpg", data: encoder.encode("UTF-8") }
      );
    });
    if (cut) warnings.push({ code: "text-cut", count: cut });
    return zip(entries).then(function (parts) {
      return { parts: parts, mime: "application/zip", ext: "zip", warnings: warnings };
    });
  }

  // ---------- ZIP writer ----------
  var CRC_TABLE = null;
  function crc32(u8) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < u8.length; i++) crc = CRC_TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function deflate(u8) {
    if (typeof CompressionStream !== "function") return Promise.resolve(null);
    var stream = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); }, function () { return null; });
  }
  // Returns the archive as a list of byte arrays (for a Blob), not one copy.
  function zip(entries) {
    return Promise.all(entries.map(function (e) { return deflate(e.data); })).then(function (packed) {
      var parts = [], central = [], offset = 0, now = new Date();
      var time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
      var date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
      entries.forEach(function (e, i) {
        var name = encoder.encode(e.name), crc = crc32(e.data);
        var stored = !packed[i] || packed[i].length >= e.data.length, body = stored ? e.data : packed[i];
        if (offset + body.length > 0xfffffffe) fail("The result is too large for a .zip file (over 4 GB).");
        var head = function (sig, size) {
          var b = new DataView(new ArrayBuffer(size));
          b.setUint32(0, sig, true);
          return b;
        };
        var local = head(0x04034b50, 30 + name.length);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true); // names are UTF-8
        local.setUint16(8, stored ? 0 : 8, true);
        local.setUint16(10, time, true);
        local.setUint16(12, date, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, body.length, true);
        local.setUint32(22, e.data.length, true);
        local.setUint16(26, name.length, true);
        new Uint8Array(local.buffer).set(name, 30);
        var cd = head(0x02014b50, 46 + name.length);
        cd.setUint16(4, 20, true);
        cd.setUint16(6, 20, true);
        cd.setUint16(8, 0x0800, true);
        cd.setUint16(10, stored ? 0 : 8, true);
        cd.setUint16(12, time, true);
        cd.setUint16(14, date, true);
        cd.setUint32(16, crc, true);
        cd.setUint32(20, body.length, true);
        cd.setUint32(24, e.data.length, true);
        cd.setUint16(28, name.length, true);
        cd.setUint32(42, offset, true);
        new Uint8Array(cd.buffer).set(name, 46);
        parts.push(new Uint8Array(local.buffer), body);
        central.push(new Uint8Array(cd.buffer));
        offset += local.byteLength + body.length;
      });
      var cdSize = central.reduce(function (s, c) { return s + c.length; }, 0);
      var end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, entries.length, true);
      end.setUint16(10, entries.length, true);
      end.setUint32(12, cdSize, true);
      end.setUint32(16, offset, true);
      return parts.concat(central, [new Uint8Array(end.buffer)]);
    });
  }

  var FORMATS = {
    geojson: function (d, n) { return Promise.resolve(toGeoJSON(d, n)); },
    shp: toShapefile,
    kml: function (d, n) { return Promise.resolve(toKML(d, n)); },
    csv: function (d) { return Promise.resolve(toCSV(d)); },
  };

  // Resolves to { parts, mime, filename, warnings }; new Blob(parts) is the file.
  function write(data, format, name) {
    if (!FORMATS[format]) return Promise.reject(new Error("Unknown output format: " + format));
    name = String(name || "data").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().slice(0, 80) || "data";
    return FORMATS[format](data, name).then(function (out) {
      out.filename = name + "." + out.ext;
      return out;
    });
  }

  return {
    sizeLimit: sizeLimit,
    read: read,
    write: write,
    summary: summary,
    fromGeoJSON: fromGeoJSON,
    fromKML: fromKML,
    fromGPX: fromGPX,
    fromCSV: fromCSV,
    fromLayer: fromLayer,
    parseCsv: parseCsv,
    parseWkt: parseWkt,
    parseXml: parseXml,
    polygonFromRings: polygonFromRings,
    dbfNames: dbfNames,
    crc32: crc32,
    zip: zip,
    FORMATS: Object.keys(FORMATS),
  };
});
