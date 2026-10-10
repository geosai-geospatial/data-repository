// PDF map extractor (ekstrak-pdf.html): turns a map saved as PDF back into
// geospatial data, in the visitor's browser. Runs in the page, in its worker
// (pdfgeoworker.js) and in Node (tests). pdf.js (vendored) reads the PDF; this
// file does the geography:
//
// - Georeferencing. A PDF page has its own coordinates (points, y up). A
//   GeoPDF (ISO 32000 /VP + /Measure, or the older OGC /LGIDict) says how they
//   map to the earth; otherwise the visitor clicks control points and types
//   their coordinates. Printed maps are drawn in one projection, so page →
//   projected coordinates is an affine transform: 1 point (with the grid
//   spacing), 2 points (similarity) or 3+ points (least squares). Grid crosses
//   drawn as vectors are found automatically, so the visitor can type one
//   coordinate and let the rest of the grid fill in.
// - Vectors. Paths from pdf.js's operator list (with the transforms applied),
//   grouped by style, so "dashed black 0.5 pt" (a boundary) or "blue 0.3 pt"
//   (rivers) can be exported as layers. Text becomes labelled points.
// - Colours. Areas painted into the map image (risk zones, land cover) are
//   classified by colour (CIE Lab distance to sampled colours), cleaned (thin
//   lines and specks removed) and traced into polygons.
// - Raster. The map area rendered at a chosen resolution, written as a
//   GeoTIFF in the map's own projection (no resampling: the affine transform
//   is the GeoTIFF's transform).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./geotiff"));
  else root.PdfGeo = factory(root.GeoTiff);
})(this, function (GT) {
  "use strict";

  function fail(msg) { throw new Error(msg); }

  // ---------- Coordinate systems ----------
  var GEOGRAPHIC = { name: "WGS 84 (bujur/lintang)", geographic: true, toLonLat: function (x, y) { return [x, y]; }, fromLonLat: function (lon, lat) { return [lon, lat]; } };
  // EPSG code → { name, toLonLat, fromLonLat, geographic }, or null.
  function crs(code) {
    code = Number(code);
    if (code === 4326 || code === 4755 || code === 4258 || code === 4269) return GEOGRAPHIC;
    return (GT && GT.epsg(code)) || null;
  }
  function utmEpsg(zone, south) { return (south ? 32700 : 32600) + zone; }

  // "UTM Zona 50 S", "UTM zone 50S", "Zone 49 M" → EPSG code. Latitude band
  // letters C–M are south, N–X north.
  function detectCrs(text) {
    var t = String(text || "").replace(/\s+/g, " ");
    var m = t.match(/\bUTM\b[^0-9]{0,24}?(?:zona|zone)?\s*(\d{1,2})\s*([A-Za-z])?\b/i) ||
      t.match(/\b(?:zona|zone)\s*(?:UTM\s*)?(\d{1,2})\s*([A-Za-z])?\b/i);
    if (m) {
      var zone = Number(m[1]), band = (m[2] || "").toUpperCase();
      if (zone >= 1 && zone <= 60) {
        var south = band === "S" || band === "LS" || (band >= "C" && band <= "M");
        if (!band) south = true; // most of Indonesia's map sheets
        return { epsg: utmEpsg(zone, south), label: "UTM zona " + zone + (south ? " S" : " N") };
      }
    }
    var e = t.match(/EPSG\s*:?\s*(\d{4,5})/i);
    if (e && crs(e[1])) return { epsg: Number(e[1]), label: "EPSG:" + e[1] };
    return null;
  }
  // Latitude/longitude typed by a person: "-8.25", "8.25 LS", "8°15'30\" S",
  // "115 15 BT", "115°BT". Returns degrees or NaN. South/west (S, LS, W, BB)
  // make it negative.
  function parseDegrees(s) {
    s = String(s == null ? "" : s).trim().toUpperCase().replace(/,/g, ".");
    if (!s) return NaN;
    var neg = /^-/.test(s) || /(^|[\s\d°'"″′])(S|LS|W|BB)\s*$/.test(s);
    var nums = s.replace(/^-/, "").match(/\d+(?:\.\d+)?/g);
    if (!nums || nums.length > 3) return NaN;
    var rest = s.replace(/^-/, "").replace(/\d+(?:\.\d+)?/g, "").replace(/[\s°'"″′:]/g, "").replace(/^(N|S|E|W|LU|LS|BT|BB)$/, "");
    if (rest) return NaN;
    var v = Number(nums[0]) + (nums[1] ? Number(nums[1]) / 60 : 0) + (nums[2] ? Number(nums[2]) / 3600 : 0);
    return neg ? -v : v;
  }
  // "9.060.000", "9 060 000", "9060000.5", "230,000" → number.
  function parseNumber(s) {
    s = String(s == null ? "" : s).trim().replace(/\s+/g, "");
    if (!s) return NaN;
    if (/^-?\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ""));
    if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."));
    if (/^-?\d{1,3}(,\d{3})+\.\d+$/.test(s)) return Number(s.replace(/,/g, ""));
    return /^-?\d+([.,]\d+)?$/.test(s) ? Number(s.replace(",", ".")) : NaN;
  }

  // ---------- 2D affine matrices (PDF order: [a b c d e f]) ----------
  // x' = a x + c y + e, y' = b x + d y + f
  var IDENTITY = [1, 0, 0, 1, 0, 0];
  // m applied first, then n.
  function concat(m, n) {
    return [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  }
  function invert(m) {
    var det = m[0] * m[3] - m[1] * m[2];
    if (!det) fail("matrix is not invertible");
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  }
  function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  // ---------- Paths from a pdf.js operator list ----------
  function rgbOf(args) {
    var c = args && (args.length === 1 && typeof args[0] === "string" ? args[0] : args);
    if (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c)) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    if (c && c.length >= 3 && typeof c[0] === "number") return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
    return null; // pattern or shading
  }

  // Walks the operator list (fnArray/argsArray from page.getOperatorList())
  // and returns every painted path in page coordinates, plus the placed
  // images (for finding the map frame and its resolution).
  // paths: [{ fill: [r,g,b]|null, stroke: [r,g,b]|null, width (pt), dash,
  //   evenOdd, parts: [{ pts: [x0,y0,x1,y1,…], closed }], bbox }]
  // images: [{ bbox, width, height }] (pixels)
  // isVisible(properties) answers for optional content (layers): hidden
  // layers, such as CorelDRAW guidelines, are left out as when displayed.
  function extractPaths(opList, OPS, isVisible) {
    var fn = opList.fnArray, args = opList.argsArray, marked = [], hidden = 0;
    var st = { ctm: IDENTITY, fill: [0, 0, 0], stroke: [0, 0, 0], width: 1, dash: false }, stack = [];
    var paths = [], images = [], parts = [], cur = null, cx = 0, cy = 0, sx = 0, sy = 0;
    function scale() { var m = st.ctm; return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])); }
    function point(x, y) {
      var p = apply(st.ctm, x, y);
      cur.pts.push(p[0], p[1]);
    }
    function moveTo(x, y) {
      cur = { pts: [], closed: false };
      parts.push(cur);
      point(x, y);
      cx = sx = x; cy = sy = y;
    }
    function lineTo(x, y) {
      if (!cur) moveTo(cx, cy);
      point(x, y);
      cx = x; cy = y;
    }
    function curve(x1, y1, x2, y2, x3, y3) {
      if (!cur) moveTo(cx, cy);
      var a = apply(st.ctm, cx, cy), b = apply(st.ctm, x1, y1), c = apply(st.ctm, x2, y2), d = apply(st.ctm, x3, y3);
      var len = Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1]) + Math.hypot(d[0] - c[0], d[1] - c[1]);
      var n = Math.max(1, Math.min(16, Math.ceil(len / 3)));
      for (var i = 1; i <= n; i++) {
        var t = i / n, u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
        cur.pts.push(w0 * a[0] + w1 * b[0] + w2 * c[0] + w3 * d[0], w0 * a[1] + w1 * b[1] + w2 * c[1] + w3 * d[1]);
      }
      cx = x3; cy = y3;
    }
    function construct(a) {
      var ops = a[0], co = a[1], j = 0;
      for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        if (op === OPS.moveTo) { moveTo(co[j], co[j + 1]); j += 2; }
        else if (op === OPS.lineTo) { lineTo(co[j], co[j + 1]); j += 2; }
        else if (op === OPS.curveTo) { curve(co[j], co[j + 1], co[j + 2], co[j + 3], co[j + 4], co[j + 5]); j += 6; }
        else if (op === OPS.curveTo2) { curve(cx, cy, co[j], co[j + 1], co[j + 2], co[j + 3]); j += 4; }
        else if (op === OPS.curveTo3) { curve(co[j], co[j + 1], co[j + 2], co[j + 3], co[j + 2], co[j + 3]); j += 4; }
        else if (op === OPS.closePath) {
          if (cur) { cur.closed = true; cur = null; }
          cx = sx; cy = sy;
        } else if (op === OPS.rectangle) {
          var x = co[j], y = co[j + 1], w = co[j + 2], h = co[j + 3];
          j += 4;
          moveTo(x, y); lineTo(x + w, y); lineTo(x + w, y + h); lineTo(x, y + h);
          cur.closed = true; cur = null;
          cx = sx = x; cy = sy = y;
        }
      }
    }
    function paint(fill, stroke, close, evenOdd) {
      var kept = hidden ? [] : parts.filter(function (p) { return p.pts.length >= 4; });
      if (close) kept.forEach(function (p) { p.closed = true; });
      if (kept.length && (fill || stroke)) {
        var b = [Infinity, Infinity, -Infinity, -Infinity];
        kept.forEach(function (p) {
          for (var i = 0; i < p.pts.length; i += 2) {
            if (p.pts[i] < b[0]) b[0] = p.pts[i];
            if (p.pts[i] > b[2]) b[2] = p.pts[i];
            if (p.pts[i + 1] < b[1]) b[1] = p.pts[i + 1];
            if (p.pts[i + 1] > b[3]) b[3] = p.pts[i + 1];
          }
        });
        paths.push({
          fill: fill ? st.fill : null, stroke: stroke ? st.stroke : null,
          width: stroke ? Math.round(st.width * scale() * 100) / 100 : 0, dash: stroke ? st.dash : false,
          evenOdd: !!evenOdd, parts: kept, bbox: b,
        });
      }
      parts = []; cur = null;
    }
    function image(w, h) {
      if (hidden) return;
      var m = st.ctm, c = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
      var xs = c.map(function (p) { return p[0]; }), ys = c.map(function (p) { return p[1]; });
      images.push({ bbox: [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)], width: w || 0, height: h || 0 });
    }
    for (var i = 0; i < fn.length; i++) {
      var f = fn[i], a = args[i];
      if (f === OPS.constructPath) construct(a);
      else if (f === OPS.save) stack.push({ ctm: st.ctm, fill: st.fill, stroke: st.stroke, width: st.width, dash: st.dash });
      else if (f === OPS.restore) { if (stack.length) st = stack.pop(); }
      else if (f === OPS.transform) st.ctm = concat(a, st.ctm);
      else if (f === OPS.paintFormXObjectBegin) {
        stack.push({ ctm: st.ctm, fill: st.fill, stroke: st.stroke, width: st.width, dash: st.dash });
        if (a && a[0] && a[0].length === 6) st.ctm = concat(a[0], st.ctm);
      } else if (f === OPS.paintFormXObjectEnd) { if (stack.length) st = stack.pop(); }
      else if (f === OPS.setFillRGBColor) st.fill = rgbOf(a);
      else if (f === OPS.setStrokeRGBColor) st.stroke = rgbOf(a);
      else if (f === OPS.setFillColorN || f === OPS.setFillColor) st.fill = rgbOf(a);
      else if (f === OPS.setStrokeColorN || f === OPS.setStrokeColor) st.stroke = rgbOf(a);
      else if (f === OPS.setLineWidth) st.width = a[0];
      else if (f === OPS.setDash) st.dash = !!(a[0] && a[0].length && a[0].some(function (v) { return v > 0; }));
      else if (f === OPS.setGState) {
        (a[0] || []).forEach(function (kv) {
          if (kv[0] === "LW") st.width = kv[1];
          if (kv[0] === "D" && kv[1]) st.dash = !!(kv[1][0] && kv[1][0].length);
        });
      }
      else if (f === OPS.stroke) paint(false, true, false);
      else if (f === OPS.closeStroke) paint(false, true, true);
      else if (f === OPS.fill) paint(true, false, true);
      else if (f === OPS.eoFill) paint(true, false, true, true);
      else if (f === OPS.fillStroke) paint(true, true, false);
      else if (f === OPS.eoFillStroke) paint(true, true, false, true);
      else if (f === OPS.closeFillStroke) paint(true, true, true);
      else if (f === OPS.closeEOFillStroke) paint(true, true, true, true);
      else if (f === OPS.endPath) { parts = []; cur = null; }
      else if (f === OPS.beginMarkedContentProps || f === OPS.beginMarkedContent) {
        var vis = true;
        if (f === OPS.beginMarkedContentProps && a[0] === "OC" && isVisible) { try { vis = isVisible(a[1]) !== false; } catch (e) { vis = true; } }
        marked.push(vis);
        if (!vis) hidden++;
      } else if (f === OPS.endMarkedContent) { if (marked.length && !marked.pop()) hidden--; }
      else if (f === OPS.paintImageXObject) image(a[1], a[2]);
      else if (f === OPS.paintImageXObjectRepeat) image(0, 0);
      else if (f === OPS.paintInlineImageXObject) image(a[0] && a[0].width, a[0] && a[0].height);
      else if (f === OPS.paintImageMaskXObject) image(a[0] && a[0].width, a[0] && a[0].height);
    }
    return { paths: paths, images: images };
  }

  function hex(rgb) {
    return rgb ? "#" + rgb.map(function (v) { return (256 | Math.max(0, Math.min(255, v))).toString(16).slice(1); }).join("") : null;
  }

  // Paths drawn the same way are one layer on the map (all rivers, all
  // district boundaries). Groups sorted by number of paths, largest first.
  function groupPaths(paths, frame) {
    var byKey = {}, groups = [];
    paths.forEach(function (p, i) {
      if (frame && !overlaps(p.bbox, frame)) return;
      var kind = p.fill && p.stroke ? "both" : p.fill ? "fill" : "stroke";
      var key = kind + "|" + hex(p.fill) + "|" + hex(p.stroke) + "|" + (p.stroke ? p.width.toFixed(2) : "") + "|" + (p.dash ? "d" : "");
      var g = byKey[key];
      if (!g) {
        g = byKey[key] = { key: key, kind: kind, fill: hex(p.fill), stroke: hex(p.stroke), width: p.stroke ? p.width : 0, dash: p.dash, items: [], points: 0 };
        groups.push(g);
      }
      g.items.push(i);
      p.parts.forEach(function (part) { g.points += part.pts.length / 2; });
    });
    groups.sort(function (a, b) { return b.items.length - a.items.length || b.points - a.points; });
    return groups;
  }
  function overlaps(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
  function inside(b, x, y) { return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]; }

  // ---------- Grid crosses and grid lines ----------
  // Grid intersections drawn as vectors: "+" crosses (two short strokes that
  // cross at their middles; only the most common size, so symbols are left
  // out) and crossings of long horizontal and vertical grid lines.
  function findGridNodes(paths, page) {
    var pw = page[2] - page[0], ph = page[3] - page[1], short = 0.04 * Math.min(pw, ph), long = 0.25 * Math.min(pw, ph);
    var hAll = [], vAll = [];
    paths.forEach(function (p) {
      if (!p.stroke || p.fill) return;
      p.parts.forEach(function (part) {
        var q = part.pts;
        for (var i = 0; i + 3 < q.length; i += 2) {
          var x0 = q[i], y0 = q[i + 1], x1 = q[i + 2], y1 = q[i + 3], dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
          if (dx + dy < 1e-6) continue;
          if (dy <= 0.02 * dx) hAll.push({ c: (y0 + y1) / 2, a: Math.min(x0, x1), b: Math.max(x0, x1) });
          else if (dx <= 0.02 * dy) vAll.push({ c: (x0 + x1) / 2, a: Math.min(y0, y1), b: Math.max(y0, y1) });
        }
      });
    });
    // Strokes on one line that touch are one stroke (a cross is often drawn
    // as a full bar and two half bars).
    function merge(list) {
      list.sort(function (p, q) { return p.c - q.c || p.a - q.a; });
      var out = [];
      list.forEach(function (sg) {
        var last = out[out.length - 1];
        if (last && Math.abs(sg.c - last.c) <= 0.05 && sg.a <= last.b + 0.05) { last.b = Math.max(last.b, sg.b); return; }
        out.push({ c: sg.c, a: sg.a, b: sg.b });
      });
      return out;
    }
    var hs = [], vs = [], lh = [], lv = [];
    merge(hAll).forEach(function (sg) {
      var seg = { x0: sg.a, x1: sg.b, y: sg.c, len: sg.b - sg.a };
      if (seg.len <= short) hs.push(seg); else if (seg.len >= long) lh.push(seg);
    });
    merge(vAll).forEach(function (sg) {
      var seg = { y0: sg.a, y1: sg.b, x: sg.c, len: sg.b - sg.a };
      if (seg.len <= short) vs.push(seg); else if (seg.len >= long) lv.push(seg);
    });
    var nodes = [];
    // Crosses: hash the vertical strokes by their middle.
    var cell = Math.max(1, short), grid = {};
    vs.forEach(function (v) {
      var k = Math.floor(v.x / cell) + ":" + Math.floor((v.y0 + v.y1) / 2 / cell);
      (grid[k] = grid[k] || []).push(v);
    });
    var crosses = [];
    hs.forEach(function (h) {
      var mx = (h.x0 + h.x1) / 2, kx = Math.floor(mx / cell), ky = Math.floor(h.y / cell);
      for (var i = -1; i <= 1; i++) {
        for (var j = -1; j <= 1; j++) {
          (grid[(kx + i) + ":" + (ky + j)] || []).forEach(function (v) {
            var my = (v.y0 + v.y1) / 2, tol = Math.max(0.3, 0.15 * Math.max(h.len, v.len));
            if (Math.abs(v.x - mx) <= tol && Math.abs(h.y - my) <= tol && Math.abs(h.len - v.len) <= 0.5 * Math.max(h.len, v.len)) {
              crosses.push({ x: v.x, y: h.y, size: (h.len + v.len) / 2 });
            }
          });
        }
      }
    });
    if (crosses.length) {
      // Keep the most common cross size (grid crosses are all alike).
      var sizes = crosses.map(function (c) { return c.size; }).sort(function (a, b) { return a - b; });
      var best = sizes[0], bestN = 0;
      sizes.forEach(function (s) {
        var n = 0;
        for (var i = 0; i < sizes.length; i++) if (Math.abs(sizes[i] - s) <= 0.2 * s) n++;
        if (n > bestN) { bestN = n; best = s; }
      });
      crosses.forEach(function (c) { if (Math.abs(c.size - best) <= 0.2 * best) nodes.push([c.x, c.y]); });
    }
    if (lh.length * lv.length <= 250000) {
      lh.forEach(function (h) {
        lv.forEach(function (v) {
          if (v.x >= h.x0 - 0.5 && v.x <= h.x1 + 0.5 && h.y >= v.y0 - 0.5 && h.y <= v.y1 + 0.5) {
            // Ends of lines meeting at a corner are a frame, not a grid crossing.
            var endH = Math.min(Math.abs(v.x - h.x0), Math.abs(v.x - h.x1)) < 1, endV = Math.min(Math.abs(h.y - v.y0), Math.abs(h.y - v.y1)) < 1;
            if (!(endH && endV)) nodes.push([v.x, h.y]);
          }
        });
      });
    }
    return dedupe(nodes, 0.5);
  }
  function dedupe(pts, tol) {
    var out = [], seen = {};
    pts.forEach(function (p) {
      var k = Math.round(p[0] / tol) + ":" + Math.round(p[1] / tol);
      if (seen[k]) return;
      seen[k] = 1;
      out.push(p);
    });
    return out;
  }

  // Typical distance between neighbouring grid nodes along x and along y
  // (page units), or null.
  function latticeSpacing(nodes) {
    function median(a) { a.sort(function (p, q) { return p - q; }); return a.length ? a[a.length >> 1] : null; }
    var dx = [], dy = [];
    nodes.forEach(function (p) {
      var bx = Infinity, by = Infinity;
      nodes.forEach(function (q) {
        var ex = q[0] - p[0], ey = q[1] - p[1];
        if (ex > 0.5 && Math.abs(ey) < 0.05 * ex && ex < bx) bx = ex;
        if (ey > 0.5 && Math.abs(ex) < 0.05 * ey && ey < by) by = ey;
      });
      if (bx < Infinity) dx.push(bx);
      if (by < Infinity) dy.push(by);
    });
    var sx = median(dx), sy = median(dy);
    if (!sx && !sy) return null;
    return { x: sx || sy, y: sy || sx };
  }

  // A round grid interval near v (map units): 1, 2, 2.5, 5 × 10^n, or for
  // degrees also whole minutes (15' = 0.25°).
  function niceInterval(v, geographic) {
    if (!(v > 0)) return null;
    var cands = [];
    for (var e = -4; e <= 7; e++) [1, 2, 2.5, 5].forEach(function (m) { cands.push(m * Math.pow(10, e)); });
    if (geographic) [1, 2, 3, 5, 6, 10, 15, 20, 30].forEach(function (m) { cands.push(m / 60); });
    var best = cands[0];
    cands.forEach(function (c) { if (Math.abs(Math.log(c / v)) < Math.abs(Math.log(best / v))) best = c; });
    return Math.abs(Math.log(best / v)) < Math.log(1.2) ? best : null;
  }

  // ---------- Fitting page → map coordinates ----------
  // points: [{ px, py, x, y }] (page and map coordinates). With one point,
  // opts.lattice ({ x, y } page spacing of the grid) and opts.interval (map
  // units) give the scale, assuming north is up.
  // Returns { m: [a b c d e f] (PDF order, page → map), kind, residuals, rmse } or null.
  function fit(points, opts) {
    opts = opts || {};
    var n = points.length, m = null, kind;
    if (n === 1 && opts.lattice && opts.interval) {
      var p = points[0], kx = opts.interval / opts.lattice.x, ky = opts.interval / opts.lattice.y;
      m = [kx, 0, 0, ky, p.x - kx * p.px, p.y - ky * p.py];
      kind = "grid";
    } else if (n === 2) {
      var a = points[0], b = points[1], dpx = b.px - a.px, dpy = b.py - a.py, dx = b.x - a.x, dy = b.y - a.y, d2 = dpx * dpx + dpy * dpy;
      if (!d2) return null;
      // x = s·px − t·py + e, y = t·px + s·py + f
      var s = (dx * dpx + dy * dpy) / d2, t = (dy * dpx - dx * dpy) / d2;
      if (!s && !t) return null;
      m = [s, t, -t, s, a.x - s * a.px + t * a.py, a.y - t * a.px - s * a.py];
      kind = "similarity";
    } else if (n >= 3) {
      // Least squares, centred for precision (map coordinates can be ~10⁷).
      var mx = 0, my = 0, mX = 0, mY = 0;
      points.forEach(function (q) { mx += q.px; my += q.py; mX += q.x; mY += q.y; });
      mx /= n; my /= n; mX /= n; mY /= n;
      var sxx = 0, sxy = 0, syy = 0, sxX = 0, syX = 0, sxY = 0, syY = 0;
      points.forEach(function (q) {
        var u = q.px - mx, v = q.py - my, X = q.x - mX, Y = q.y - mY;
        sxx += u * u; sxy += u * v; syy += v * v; sxX += u * X; syX += v * X; sxY += u * Y; syY += v * Y;
      });
      var det = sxx * syy - sxy * sxy;
      if (Math.abs(det) <= 1e-9 * Math.max(1, sxx * syy)) return null; // all on one line
      var A = (sxX * syy - syX * sxy) / det, B = (syX * sxx - sxX * sxy) / det;
      var D = (sxY * syy - syY * sxy) / det, E = (syY * sxx - sxY * sxy) / det;
      m = [A, D, B, E, mX - A * mx - B * my, mY - D * mx - E * my];
      kind = "affine";
    }
    if (!m || !m.every(isFinite) || !(m[0] * m[3] - m[1] * m[2])) return null;
    var sum = 0, residuals = points.map(function (q) {
      var r = apply(m, q.px, q.py), e = Math.hypot(r[0] - q.x, r[1] - q.y);
      sum += e * e;
      return e;
    });
    return { m: m, kind: kind, residuals: residuals, rmse: n ? Math.sqrt(sum / n) : 0 };
  }
  // Map units per page point (geometric mean of the axes).
  function fitScale(f) { return Math.sqrt(Math.abs(f.m[0] * f.m[3] - f.m[1] * f.m[2])); }

  // Adds every grid node whose map position (from the current fit) is close
  // to a multiple of the interval in both axes, then refits; repeated, so a
  // rough fit from one or two points becomes a least-squares fit over the
  // whole grid. Returns { points, fit, added }.
  function completeGrid(points, nodes, interval, opts) {
    var base = points.filter(function (p) { return !p.auto; }), pts = base, f = fit(base, opts), added = 0;
    if (!f || !(interval > 0)) return { points: points, fit: f, added: 0 };
    for (var round = 0; round < 3; round++) {
      var taken = {}, cand = [];
      nodes.forEach(function (nd) {
        if (base.some(function (p) { return Math.hypot(p.px - nd[0], p.py - nd[1]) < 1; })) return;
        var q = apply(f.m, nd[0], nd[1]), rx = Math.round(q[0] / interval) * interval, ry = Math.round(q[1] / interval) * interval;
        var ex = Math.abs(q[0] - rx), ey = Math.abs(q[1] - ry);
        if (ex > 0.2 * interval || ey > 0.2 * interval) return;
        var k = rx + ":" + ry, e = ex + ey;
        if (taken[k] && taken[k].e <= e) return;
        taken[k] = { px: nd[0], py: nd[1], x: rx, y: ry, auto: true, e: e };
      });
      Object.keys(taken).forEach(function (k) { var t = taken[k]; delete t.e; cand.push(t); });
      var next = fit(base.concat(cand));
      if (!next) break;
      // Drop crosses that do not fit (wrongly rounded, or a stray symbol).
      var lim = Math.max(3 * next.rmse, 0.02 * interval);
      cand = cand.filter(function (c) { var r = apply(next.m, c.px, c.py); return Math.hypot(r[0] - c.x, r[1] - c.y) <= lim; });
      pts = base.concat(cand);
      f = fit(pts) || f;
      added = cand.length;
    }
    return { points: pts, fit: f, added: added };
  }

  // ---------- Map frame ----------
  // The rectangle the map is drawn in (page coordinates): the smallest large
  // rectangle that holds all grid nodes, else the largest picture on the page
  // (strips merged), else the largest rectangle, else the page.
  function findFrame(paths, images, page, nodes) {
    var area = (page[2] - page[0]) * (page[3] - page[1]), rects = [];
    paths.forEach(function (p) {
      p.parts.forEach(function (part) {
        var b = rectOf(part.pts);
        if (b) rects.push(b);
      });
    });
    var pics = mergeBoxes(images.map(function (im) { return im.bbox.slice(); }));
    function size(b) { return (b[2] - b[0]) * (b[3] - b[1]); }
    var big = rects.concat(pics).filter(function (b) { return size(b) >= 0.15 * area && size(b) <= 0.98 * area; });
    if (nodes && nodes.length >= 2) {
      var nb = [Infinity, Infinity, -Infinity, -Infinity];
      nodes.forEach(function (n) { nb[0] = Math.min(nb[0], n[0]); nb[1] = Math.min(nb[1], n[1]); nb[2] = Math.max(nb[2], n[0]); nb[3] = Math.max(nb[3], n[1]); });
      var holding = big.filter(function (b) { return b[0] <= nb[0] + 0.5 && b[1] <= nb[1] + 0.5 && b[2] >= nb[2] - 0.5 && b[3] >= nb[3] - 0.5; });
      if (holding.length) return holding.sort(function (a, b) { return size(a) - size(b); })[0];
    }
    pics = pics.filter(function (b) { return size(b) >= 0.15 * area; }).sort(function (a, b) { return size(b) - size(a); });
    if (pics.length) return clip(pics[0], page);
    if (big.length) return big.sort(function (a, b) { return size(b) - size(a); })[0];
    return page.slice();
  }
  function clip(b, page) { return [Math.max(b[0], page[0]), Math.max(b[1], page[1]), Math.min(b[2], page[2]), Math.min(b[3], page[3])]; }
  // Axis-aligned rectangle drawn as a path → its box, else null.
  function rectOf(q) {
    var n = q.length / 2;
    if (n < 4 || n > 5) return null;
    if (n === 5 && (Math.abs(q[0] - q[8]) > 0.01 || Math.abs(q[1] - q[9]) > 0.01)) return null;
    for (var i = 0; i < 4; i++) {
      var j = (i + 1) % 4, dx = Math.abs(q[2 * j] - q[2 * i]), dy = Math.abs(q[2 * j + 1] - q[2 * i + 1]);
      if (Math.min(dx, dy) > 0.01) return null;
    }
    var xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    return [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)];
  }
  // Pictures cut into strips (common in CorelDRAW and ArcMap exports) are
  // merged back into one box when they touch.
  function mergeBoxes(boxes) {
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < boxes.length && !changed; i++) {
        for (var j = i + 1; j < boxes.length; j++) {
          var a = boxes[i], b = boxes[j];
          if (a[0] <= b[2] + 1 && b[0] <= a[2] + 1 && a[1] <= b[3] + 1 && b[1] <= a[3] + 1) {
            boxes[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
            boxes.splice(j, 1);
            changed = true;
            break;
          }
        }
      }
    }
    return boxes;
  }
  // Resolution (dots per inch) of the largest picture inside the frame, so
  // the raster is exported at the detail the PDF actually has.
  function imageDpi(images, frame) {
    var best = null, bestArea = 0;
    images.forEach(function (im) {
      var b = im.bbox, w = b[2] - b[0], h = b[3] - b[1];
      if (!overlaps(b, frame) || !im.width || w <= 0 || h <= 0) return;
      var a = w * h;
      if (a > bestArea) { bestArea = a; best = Math.max(im.width / w, im.height / h) * 72; }
    });
    return best && isFinite(best) ? Math.round(best) : null;
  }

  // ---------- Vectors → GeoJSON ----------
  function ringArea(q) {
    var s = 0;
    for (var i = 0, n = q.length; i < n; i++) {
      var a = q[i], b = q[(i + 1) % n];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2;
  }
  function pointInRing(x, y, q) {
    var c = false;
    for (var i = 0, j = q.length - 1; i < q.length; j = i++) {
      var a = q[i], b = q[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  function bboxOf(q) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    q.forEach(function (p) {
      if (p[0] < b[0]) b[0] = p[0];
      if (p[1] < b[1]) b[1] = p[1];
      if (p[0] > b[2]) b[2] = p[0];
      if (p[1] > b[3]) b[3] = p[1];
    });
    return b;
  }
  // Rings (any winding) → polygons [[outer, hole, …], …]: a ring inside an
  // odd number of others is a hole of the smallest ring around it.
  // probe(ring) gives a point strictly inside the ring's area (defaults to
  // its first vertex).
  function nestRings(rings, probe) {
    var info = rings.map(function (r) { return { ring: r, area: Math.abs(ringArea(r)), bbox: bboxOf(r), probe: probe ? probe(r) : r[0] }; });
    var order = info.slice().sort(function (a, b) { return a.area - b.area; });
    info.forEach(function (it) {
      it.parents = [];
      order.forEach(function (o) {
        if (o === it || o.area <= it.area) return;
        var p = it.probe;
        if (inside(o.bbox, p[0], p[1]) && pointInRing(p[0], p[1], o.ring)) it.parents.push(o);
      });
    });
    var polys = [];
    info.forEach(function (it) { if (it.parents.length % 2 === 0) { it.poly = [it.ring]; polys.push(it.poly); } });
    info.forEach(function (it) {
      if (it.parents.length % 2 === 1) {
        var owner = it.parents.filter(function (o) { return o.poly; }).sort(function (a, b) { return a.area - b.area; })[0];
        if (owner) owner.poly.push(it.ring);
      }
    });
    return polys;
  }
  // RFC 7946: outer rings counter-clockwise, holes clockwise; closed.
  function windPolygon(poly) {
    return poly.map(function (ring, i) {
      var r = ring.slice(), a = ringArea(r);
      if ((i === 0 && a < 0) || (i > 0 && a > 0)) r.reverse();
      if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) r.push(r[0].slice());
      return r;
    });
  }
  function round(v, dp) { var f = Math.pow(10, dp); return Math.round(v * f) / f; }

  // Page → longitude/latitude.
  function projector(m, mapCrs) {
    var dp = 7;
    return function (x, y) {
      var p = apply(m, x, y), ll = mapCrs.toLonLat(p[0], p[1]);
      return [round(ll[0], dp), round(ll[1], dp)];
    };
  }

  // Selected path groups → GeoJSON features (WGS 84). Filled paths become
  // polygons, stroked ones lines. Parts outside the frame are left out.
  function pathFeatures(paths, groups, frame, toLonLat) {
    var features = [];
    groups.forEach(function (g) {
      g.items.forEach(function (idx) {
        var p = paths[idx];
        var parts = p.parts.filter(function (part) {
          for (var i = 0; i < part.pts.length; i += 2) if (inside(frame, part.pts[i], part.pts[i + 1])) return true;
          return false;
        });
        if (!parts.length) return;
        var props = { lapisan: g.name, warna_isi: hex(p.fill) || "", warna_grs: hex(p.stroke) || "", tebal_pt: p.stroke ? p.width : 0 };
        var geom;
        if (p.fill && !g.asLines) {
          var rings = parts.map(function (part) {
            var r = [];
            for (var i = 0; i < part.pts.length; i += 2) r.push([part.pts[i], part.pts[i + 1]]);
            return r;
          }).filter(function (r) { return r.length >= 3 && Math.abs(ringArea(r)) > 1e-6; });
          if (!rings.length) return;
          var polys = nestRings(rings).map(function (poly) {
            return windPolygon(poly.map(function (r) { return r.map(function (pt) { return toLonLat(pt[0], pt[1]); }); }));
          });
          geom = polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
        } else {
          var lines = parts.map(function (part) {
            var l = [];
            for (var i = 0; i < part.pts.length; i += 2) l.push(toLonLat(part.pts[i], part.pts[i + 1]));
            if (part.closed && l.length > 2) l.push(l[0].slice());
            return l;
          }).filter(function (l) { return l.length >= 2; });
          if (!lines.length) return;
          geom = lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines };
        }
        features.push({ type: "Feature", properties: props, geometry: geom });
      });
    });
    return features;
  }

  // ---------- Text → labelled points ----------
  // items: pdf.js text items ({ str, transform, width, height }). Pieces of
  // one label on one line (pdf.js splits "L A U T" and "B A L I") are joined.
  function textLabels(items, frame) {
    var lines = [];
    items.forEach(function (it) {
      var s = String(it.str || "");
      if (!s.trim()) { if (lines.length) lines[lines.length - 1].gap = true; return; }
      var t = it.transform, size = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 1;
      var ux = t[0], uy = t[1], ul = Math.hypot(ux, uy) || 1;
      ux /= ul; uy /= ul;
      var last = lines[lines.length - 1];
      if (last) {
        // Same direction and size, on the same baseline, and close behind.
        var ex = last.x + last.ux * last.w, ey = last.y + last.uy * last.w;
        var along = (t[4] - ex) * ux + (t[5] - ey) * uy, across = -(t[4] - last.x) * uy + (t[5] - last.y) * ux;
        if (Math.abs(ux - last.ux) < 0.02 && Math.abs(uy - last.uy) < 0.02 && Math.abs(size - last.size) < 0.1 * size &&
          Math.abs(across) < 0.3 * size && along > -0.5 * size && along < 1.5 * size) {
          last.str += (last.gap || along > 0.15 * size ? " " : "") + s;
          last.w = (t[4] - last.x) * ux + (t[5] - last.y) * uy + (it.width || 0);
          last.gap = false;
          return;
        }
      }
      lines.push({ str: s, x: t[4], y: t[5], ux: ux, uy: uy, size: size, w: it.width || 0, gap: false });
    });
    return lines.map(function (l) {
      // Middle of the text (baseline + about a third of the height).
      var cx = l.x + l.ux * l.w / 2 - l.uy * l.size * 0.35, cy = l.y + l.uy * l.w / 2 + l.ux * l.size * 0.35;
      return { text: l.str.replace(/\s+/g, " ").trim(), x: cx, y: cy, size: Math.round(l.size * 10) / 10, angle: Math.round(Math.atan2(l.uy, l.ux) * 180 / Math.PI) };
    }).filter(function (l) { return l.text && (!frame || inside(frame, l.x, l.y)); });
  }

  // ---------- GeoPDF ----------
  // A small reader for PDF objects, enough to find the georeferencing
  // dictionaries (pdf.js does not expose them).
  function parseValue(s, i) {
    function ws() {
      for (;;) {
        var c = s.charCodeAt(i);
        if (c === 37) { while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++; } // % comment
        else if (c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0) i++;
        else return;
      }
    }
    var DELIM = /[\s()<>\[\]{}\/%]/;
    function value() {
      ws();
      var c = s[i];
      if (c === "<" && s[i + 1] === "<") {
        i += 2;
        var d = {};
        for (;;) {
          ws();
          if (s[i] === ">" && s[i + 1] === ">") { i += 2; return d; }
          if (s[i] !== "/" || i >= s.length) fail("bad dictionary");
          var k = value();
          d[k.name] = value();
        }
      }
      if (c === "[") {
        i++;
        var a = [];
        for (;;) {
          ws();
          if (s[i] === "]") { i++; return a; }
          if (i >= s.length) fail("bad array");
          a.push(value());
        }
      }
      if (c === "/") {
        var j = ++i;
        while (i < s.length && !DELIM.test(s[i])) i++;
        return { name: s.slice(j, i).replace(/#([0-9a-f]{2})/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); }) };
      }
      if (c === "(") {
        var depth = 1, out = "";
        i++;
        while (i < s.length && depth) {
          var ch = s[i++];
          if (ch === "\\") {
            var e = s[i++];
            if (/[0-7]/.test(e)) {
              var oct = e;
              while (oct.length < 3 && /[0-7]/.test(s[i])) oct += s[i++];
              out += String.fromCharCode(parseInt(oct, 8));
            } else out += { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[e] || (e === "\r" || e === "\n" ? "" : e);
          } else if (ch === "(") { depth++; out += ch; }
          else if (ch === ")") { if (--depth) out += ch; }
          else out += ch;
        }
        return out;
      }
      if (c === "<") {
        var k2 = s.indexOf(">", i), h2 = s.slice(i + 1, k2).replace(/\s+/g, ""), str = "";
        i = k2 + 1;
        if (h2.length % 2) h2 += "0";
        for (var q = 0; q < h2.length; q += 2) str += String.fromCharCode(parseInt(h2.substr(q, 2), 16));
        return str;
      }
      var m = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(s.slice(i, i + 40));
      if (m) {
        i += m[0].length;
        var ref = /^\s+(\d+)\s+R(?![A-Za-z])/.exec(s.slice(i, i + 24));
        if (ref && /^\d+$/.test(m[0])) { i += ref[0].length; return { ref: Number(m[0]) }; }
        return Number(m[0]);
      }
      var w = /^(true|false|null)/.exec(s.slice(i, i + 5));
      if (w) { i += w[0].length; return w[0] === "true" ? true : w[0] === "false" ? false : null; }
      fail("bad PDF object");
    }
    var v = value();
    return { value: v, end: i };
  }

  function latin1(u8) {
    var out = "", CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return out;
  }
  function inflate(u8) {
    if (typeof DecompressionStream !== "function") return Promise.reject(new Error("no DecompressionStream"));
    var stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  // Every object in the file, as text (later definitions win, as with
  // incremental updates), including those packed in object streams.
  function readObjects(bytes) {
    var s = latin1(bytes), objs = {}, streams = [], re = /(\d+)\s+(\d+)\s+obj\b/g, m;
    while ((m = re.exec(s))) {
      var start = m.index + m[0].length, end = s.indexOf("endobj", start);
      if (end < 0) end = s.length;
      var body = s.slice(start, end), st = body.search(/\bstream\r?\n/);
      var dict = st >= 0 ? body.slice(0, st) : body;
      objs[m[1]] = dict;
      if (st >= 0 && /\/Type\s*\/ObjStm/.test(dict)) {
        var ds = start + st + body.slice(st).match(/^stream\r?\n/)[0].length, de = s.lastIndexOf("endstream", end);
        if (de > ds) streams.push({ dict: dict, data: bytes.subarray(ds, de) });
      }
      re.lastIndex = end;
    }
    return Promise.all(streams.map(function (st) {
      var filter = /\/Filter\s*(\[\s*)?\/(\w+)/.exec(st.dict);
      var data = st.data, n = data.length;
      while (n && (data[n - 1] === 10 || data[n - 1] === 13)) n--;
      data = data.subarray(0, n);
      var got = !filter ? Promise.resolve(data) : filter[2] === "FlateDecode" ? inflate(data) : Promise.resolve(null);
      return got.then(function (u8) {
        if (!u8) return;
        var text = latin1(u8), N = Number((/\/N\s+(\d+)/.exec(st.dict) || [])[1]), first = Number((/\/First\s+(\d+)/.exec(st.dict) || [])[1]);
        var nums = text.slice(0, first).trim().split(/\s+/).map(Number);
        for (var k = 0; k < N && 2 * k + 1 < nums.length; k++) {
          var a = first + nums[2 * k + 1], b = k + 1 < N ? first + nums[2 * k + 3] : text.length;
          objs[nums[2 * k]] = text.slice(a, b);
        }
      }, function () {});
    })).then(function () { return objs; });
  }

  // EPSG code from a GeoPDF /GCS dictionary (EPSG number or WKT).
  function gcsEpsg(gcs) {
    if (!gcs) return null;
    if (typeof gcs.EPSG === "number") return gcs.EPSG;
    var wkt = typeof gcs.WKT === "string" ? gcs.WKT : "";
    var auth = wkt.match(/AUTHORITY\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]\s*\]\s*$/i) || wkt.match(/ID\[\s*"EPSG"\s*,\s*(\d+)\s*\]\s*\]\s*$/i);
    if (auth) return Number(auth[1]);
    var utm = wkt.match(/UTM[ _]zone[ _](\d{1,2})[ _]?([NS])/i);
    if (utm) return utmEpsg(Number(utm[1]), utm[2].toUpperCase() === "S");
    if (/^\s*GEOGCS/i.test(wkt) || (gcs.Type && gcs.Type.name === "GEOGCS")) return 4326;
    return null;
  }

  // Georeferencing stored in the PDF for one page (pageRef: pdf.js page.ref).
  // Resolves to null or { source, viewports: [{ bbox, epsg, name, points:
  // [{ px, py, lon, lat }] }] }, largest viewport first.
  function readGeoPdf(bytes, pageRef) {
    var s = latin1(bytes.subarray(0, Math.min(bytes.length, 64)));
    if (!/^%PDF/.test(s.trim())) return Promise.resolve(null);
    return readObjects(bytes).then(function (objs) {
      var cache = {};
      function obj(num) {
        if (!(num in cache)) {
          cache[num] = null;
          if (objs[num] != null) { try { cache[num] = parseValue(objs[num], 0).value; } catch (e) { cache[num] = null; } }
        }
        return cache[num];
      }
      function get(v) { return v && typeof v === "object" && "ref" in v ? obj(v.ref) : v; }
      function nums(v) { v = get(v); return Array.isArray(v) ? v.map(function (x) { x = get(x); return typeof x === "string" ? Number(x) : x; }) : null; }
      var page = pageRef ? get({ ref: pageRef.num }) : null;
      if (!page) {
        // No page reference: the first page object with georeferencing.
        Object.keys(objs).some(function (k) {
          if (!/\/(VP|LGIDict)\b/.test(objs[k]) || !/\/Type\s*\/Page\b/.test(objs[k])) return false;
          page = obj(k);
          return !!page;
        });
      }
      if (!page) return null;
      var out = [];
      var vps = get(page.VP);
      (Array.isArray(vps) ? vps : []).forEach(function (vp) {
        vp = get(vp);
        var meas = vp && get(vp.Measure), bbox = vp && nums(vp.BBox);
        if (!meas || !bbox || bbox.length < 4) return;
        var g = nums(meas.GPTS), l = nums(meas.LPTS), gcs = get(meas.GCS);
        if (!g || g.length < 6) return;
        var x0 = Math.min(bbox[0], bbox[2]), y0 = Math.min(bbox[1], bbox[3]), w = Math.abs(bbox[2] - bbox[0]), h = Math.abs(bbox[3] - bbox[1]);
        if (!l || l.length !== g.length) {
          // Without LPTS the points are the Bounds (or unit square) corners.
          l = nums(meas.Bounds) || [0, 0, 0, 1, 1, 1, 1, 0];
        }
        var unit = l.every(function (v) { return v >= -0.5 && v <= 1.5; });
        var points = [];
        for (var k = 0; k + 1 < g.length && k + 1 < l.length; k += 2) {
          points.push({ px: unit ? x0 + l[k] * w : l[k], py: unit ? y0 + l[k + 1] * h : l[k + 1], lat: g[k], lon: g[k + 1] });
        }
        if (gcs) gcs = { EPSG: get(gcs.EPSG), WKT: get(gcs.WKT), Type: get(gcs.Type) };
        out.push({ bbox: [x0, y0, x0 + w, y0 + h], epsg: gcsEpsg(gcs), name: typeof get(vp.Name) === "string" ? get(vp.Name) : "", points: points });
      });
      if (out.length) {
        out.sort(function (a, b) { return (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) - (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]); });
        return { source: "ISO 32000", viewports: out };
      }
      // OGC best practice (TerraGo / older GDAL): /LGIDict with /Registration
      // or /CTM in a projection's own coordinates.
      var lgi = get(page.LGIDict);
      (Array.isArray(lgi) ? lgi : lgi ? [lgi] : []).forEach(function (d) {
        d = get(d);
        var proj = d && get(d.Projection);
        if (!proj) return;
        var type = String(get(proj.ProjectionType) || ""), epsg = null;
        if (/^GEO/i.test(type)) epsg = 4326;
        else if (/^UT$/i.test(type)) epsg = utmEpsg(Number(get(proj.Zone)), /^S/i.test(String(get(proj.Hemisphere) || "N")));
        var points = [], reg = get(d.Registration), ctm = nums(d.CTM);
        if (Array.isArray(reg)) {
          reg.forEach(function (r) { r = nums(r); if (r && r.length >= 4) points.push({ px: r[0], py: r[1], x: r[2], y: r[3] }); });
        } else if (ctm && ctm.length === 6) {
          [[0, 0], [1000, 0], [0, 1000]].forEach(function (p) {
            var q = apply(ctm, p[0], p[1]);
            points.push({ px: p[0], py: p[1], x: q[0], y: q[1] });
          });
        }
        var nl = nums(d.Neatline), bb = null;
        if (nl && nl.length >= 4) {
          var xs = [], ys = [];
          for (var k = 0; k + 1 < nl.length; k += 2) { xs.push(nl[k]); ys.push(nl[k + 1]); }
          bb = [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)];
        }
        if (points.length >= 2) {
          // Projected coordinates; geographic ones are x = lon, y = lat.
          out.push({ bbox: bb, epsg: epsg, name: "", projected: true, points: points.map(function (p) { return epsg === 4326 ? { px: p.px, py: p.py, lon: p.x, lat: p.y } : p; }) });
        }
      });
      return out.length ? { source: "OGC", viewports: out } : null;
    });
  }

  // ---------- Colour classes ----------
  function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function labF(t) { return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116; }
  function rgbToLab(r, g, b) {
    var R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
    var x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, y = 0.2126 * R + 0.7152 * G + 0.0722 * B, z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    var fx = labF(x), fy = labF(y), fz = labF(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  // classes: [{ colors: [[r,g,b], …] }]; tolerance: CIE76 ΔE. A table over
  // RGB at 6 bits a channel, so classifying a pixel is one lookup.
  function colorTable(classes, tolerance) {
    var samples = [];
    classes.forEach(function (c, ci) {
      (c.colors || []).forEach(function (rgb) { samples.push({ lab: rgbToLab(rgb[0], rgb[1], rgb[2]), cls: ci + 1 }); });
    });
    var lut = new Uint8Array(1 << 18), tol2 = tolerance * tolerance;
    if (!samples.length) return lut;
    for (var r = 0; r < 64; r++) {
      for (var g = 0; g < 64; g++) {
        for (var b = 0; b < 64; b++) {
          var lab = rgbToLab(r * 4 + 2, g * 4 + 2, b * 4 + 2), best = tol2, cls = 0;
          for (var k = 0; k < samples.length; k++) {
            var s = samples[k].lab, d0 = lab[0] - s[0], d1 = lab[1] - s[1], d2 = lab[2] - s[2], d = d0 * d0 + d1 * d1 + d2 * d2;
            if (d < best) { best = d; cls = samples[k].cls; }
          }
          lut[(r << 12) | (g << 6) | b] = cls;
        }
      }
    }
    return lut;
  }
  // RGBA pixels → class per pixel (0 = none) written into out at offset.
  function classify(rgba, lut, out, offset) {
    var n = rgba.length >> 2;
    out = out || new Uint8Array(n);
    offset = offset || 0;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      out[offset + i] = rgba[j + 3] < 128 ? 0 : lut[((rgba[j] >> 2) << 12) | ((rgba[j + 1] >> 2) << 6) | (rgba[j + 2] >> 2)];
    }
    return out;
  }

  // Removes, per class, everything narrower than 2r+1 pixels (roads and
  // boundary lines drawn in a similar colour): a morphological opening with
  // a square, keeping the original outline of what survives.
  function removeThin(cls, w, h, r, nClasses) {
    if (!(r > 0)) return cls;
    var mask = new Uint8Array(w * h), tmp = new Uint8Array(w * h), row = new Int32Array(Math.max(w, h) + 1);
    function pass(src, dst, horizontal, erode) {
      var lines = horizontal ? h : w, len = horizontal ? w : h, step = horizontal ? 1 : w;
      for (var l = 0; l < lines; l++) {
        var base = horizontal ? l * w : l;
        row[0] = 0;
        for (var k = 0; k < len; k++) row[k + 1] = row[k] + src[base + k * step];
        for (var k2 = 0; k2 < len; k2++) {
          var a = Math.max(0, k2 - r), b = Math.min(len - 1, k2 + r), sum = row[b + 1] - row[a];
          // Erosion: the window is full (the image edge counts as inside).
          dst[base + k2 * step] = erode ? (sum === b - a + 1 ? 1 : 0) : (sum > 0 ? 1 : 0);
        }
      }
    }
    for (var c = 1; c <= nClasses; c++) {
      var any = false;
      for (var i = 0; i < cls.length; i++) { mask[i] = cls[i] === c ? 1 : 0; if (mask[i]) any = true; }
      if (!any) continue;
      pass(mask, tmp, true, true); pass(tmp, mask, false, true);
      pass(mask, tmp, true, false); pass(tmp, mask, false, false);
      for (var i2 = 0; i2 < cls.length; i2++) if (cls[i2] === c && !mask[i2]) cls[i2] = 0;
    }
    return cls;
  }

  // Removes connected patches (4-neighbour) smaller than minPixels.
  function sieve(cls, w, h, minPixels) {
    if (!(minPixels > 1)) return cls;
    var seen = new Uint8Array(w * h), stack = new Int32Array(1024), list = [];
    function grow() { var s2 = new Int32Array(stack.length * 2); s2.set(stack); stack = s2; }
    for (var start = 0; start < cls.length; start++) {
      if (seen[start] || !cls[start]) continue;
      var c = cls[start], sp = 0, count = 0;
      list.length = 0;
      stack[sp++] = start;
      seen[start] = 1;
      while (sp) {
        var p = stack[--sp], x = p % w;
        count++;
        if (count < minPixels) list.push(p);
        if (sp + 4 >= stack.length) grow();
        if (x > 0 && !seen[p - 1] && cls[p - 1] === c) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && !seen[p + 1] && cls[p + 1] === c) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (p >= w && !seen[p - w] && cls[p - w] === c) { seen[p - w] = 1; stack[sp++] = p - w; }
        if (p + w < cls.length && !seen[p + w] && cls[p + w] === c) { seen[p + w] = 1; stack[sp++] = p + w; }
      }
      if (count < minPixels) for (var k = 0; k < list.length; k++) cls[list[k]] = 0;
    }
    return cls;
  }

  // Outlines of one class along pixel edges. Rings are in pixel-corner
  // coordinates (x right, y down): outer rings clockwise on screen (positive
  // area), holes the other way. Diagonal neighbours are not joined.
  function traceClass(cls, w, h, c) {
    var W = w + 1, out = new Uint8Array(W * (h + 1)), rings = [];
    var DX = [1, 0, -1, 0], DY = [0, 1, 0, -1], STEP = [1, W, -1, -W];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        if (cls[i] !== c) continue;
        var v = y * W + x;
        if (y === 0 || cls[i - w] !== c) out[v] |= 1;                    // top, going east
        if (x === w - 1 || cls[i + 1] !== c) out[v + 1] |= 2;            // right, going south
        if (y === h - 1 || cls[i + w] !== c) out[v + W + 1] |= 4;        // bottom, going west
        if (x === 0 || cls[i - 1] !== c) out[v + W] |= 8;                // left, going north
      }
    }
    for (var s = 0; s < out.length; s++) {
      while (out[s]) {
        var d = out[s] & 1 ? 0 : out[s] & 2 ? 1 : out[s] & 4 ? 2 : 3, d0 = d, pos = s;
        var sx = s % W, sy = (s - sx) / W, pts = [[sx, sy]];
        // A point just inside the class, beside the first edge.
        var probe = [sx + 0.5 * DX[d] + 0.5 * DX[(d + 1) % 4], sy + 0.5 * DY[d] + 0.5 * DY[(d + 1) % 4]];
        out[pos] &= ~(1 << d);
        for (;;) {
          pos += STEP[d];
          if (pos === s) break;
          var r = (d + 1) & 3, l = (d + 3) & 3, nd;
          if (out[pos] & (1 << r)) nd = r;          // turn right first: keeps diagonal pixels apart
          else if (out[pos] & (1 << d)) nd = d;
          else if (out[pos] & (1 << l)) nd = l;
          else break;                                // broken ring (should not happen)
          out[pos] &= ~(1 << nd);
          if (nd !== d) { var px = pos % W; pts.push([px, (pos - px) / W]); }
          d = nd;
        }
        if (d === d0 && pts.length > 1) pts.shift(); // the start was mid-edge
        if (pts.length >= 3) rings.push({ pts: pts, probe: probe });
      }
    }
    return rings;
  }

  // Douglas–Peucker on a closed ring.
  function simplifyRing(pts, tol) {
    var n = pts.length;
    if (n <= 4 || !(tol > 0)) return pts;
    var far = 0, fd = -1;
    for (var i = 1; i < n; i++) {
      var d = (pts[i][0] - pts[0][0]) * (pts[i][0] - pts[0][0]) + (pts[i][1] - pts[0][1]) * (pts[i][1] - pts[0][1]);
      if (d > fd) { fd = d; far = i; }
    }
    var keep = new Uint8Array(n), t2 = tol * tol;
    keep[0] = keep[far] = 1;
    function dp(a, b) {
      var stack = [[a, b]];
      while (stack.length) {
        var seg = stack.pop(), i0 = seg[0], i1 = seg[1], A = pts[i0], B = pts[i1 % n];
        var dx = B[0] - A[0], dy = B[1] - A[1], l2 = dx * dx + dy * dy, best = -1, bi = -1;
        for (var k = i0 + 1; k < i1; k++) {
          var P = pts[k], t = l2 ? ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          var ex = A[0] + t * dx - P[0], ey = A[1] + t * dy - P[1], e = ex * ex + ey * ey;
          if (e > best) { best = e; bi = k; }
        }
        if (bi >= 0 && best > t2) { keep[bi] = 1; stack.push([i0, bi], [bi, i1]); }
      }
    }
    dp(0, far);
    dp(far, n);
    var out = [];
    for (var j = 0; j < n; j++) if (keep[j]) out.push(pts[j]);
    return out.length >= 3 ? out : pts;
  }

  // Class raster → GeoJSON features, one (Multi)Polygon per class.
  // toLonLat(col, row) maps pixel corners to longitude/latitude.
  function polygonize(cls, w, h, classes, toLonLat, opts) {
    opts = opts || {};
    var tol = opts.simplify == null ? 0.75 : opts.simplify, features = [];
    classes.forEach(function (c, ci) {
      var traced = traceClass(cls, w, h, ci + 1);
      if (!traced.length) return;
      var probes = new Map();
      traced.forEach(function (t) { probes.set(t.pts, t.probe); });
      var polys = nestRings(traced.map(function (t) { return t.pts; }), function (r) { return probes.get(r); });
      var pixels = 0;
      var coords = polys.map(function (poly) {
        pixels += Math.abs(ringArea(poly[0])) - poly.slice(1).reduce(function (s, r) { return s + Math.abs(ringArea(r)); }, 0);
        return windPolygon(poly.map(function (r) {
          return simplifyRing(r, tol).map(function (p) { return toLonLat(p[0], p[1]); });
        }));
      });
      features.push({
        type: "Feature",
        properties: { kelas: c.name, nilai: c.value != null && c.value !== "" ? c.value : ci + 1, warna: hex(c.colors && c.colors[0]) || "", piksel: Math.round(pixels) },
        geometry: coords.length === 1 ? { type: "Polygon", coordinates: coords[0] } : { type: "MultiPolygon", coordinates: coords },
      });
    });
    return features;
  }

  // ---------- GeoTIFF writer ----------
  function zlib(u8) {
    var stream = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  // Streaming writer: rows go in as they are rendered, compressed in strips.
  // o: { width, height, samples (1 or 3), transform (GDAL order, pixel corner
  // → map), epsg, palette ([[r,g,b], …] for a 1-band class raster), nodata }.
  // add(rows: Uint8Array, interleaved) → Promise; finish() → Promise of the
  // file as a list of Uint8Arrays (for a Blob).
  function tiffWriter(o) {
    var spp = o.samples, rowBytes = o.width * spp, rps = Math.max(1, Math.min(o.height, Math.floor(262144 / rowBytes) || 1));
    var predictor = spp === 3 ? 2 : 1, compressed = typeof CompressionStream === "function";
    var strips = [], pending = new Uint8Array(rps * rowBytes), fill = 0, rowsIn = 0;
    function flush(rows) {
      var raw = pending.slice(0, rows * rowBytes);
      if (predictor === 2) {
        for (var r = 0; r < rows; r++) {
          for (var k = rowBytes - 1; k >= spp; k--) raw[r * rowBytes + k] = (raw[r * rowBytes + k] - raw[r * rowBytes + k - spp]) & 255;
        }
      }
      strips.push(compressed ? zlib(raw) : Promise.resolve(raw));
    }
    function add(rows) {
      var off = 0;
      while (off < rows.length) {
        var take = Math.min(rows.length - off, pending.length - fill);
        pending.set(rows.subarray(off, off + take), fill);
        fill += take; off += take;
        if (fill === pending.length) { flush(rps); fill = 0; }
      }
      rowsIn += rows.length / rowBytes;
      return Promise.all(strips.slice(-2)).then(function () {});
    }
    function finish() {
      if (fill) flush(fill / rowBytes);
      if (Math.round(rowsIn) !== o.height) return Promise.reject(new Error("expected " + o.height + " rows, got " + rowsIn));
      return Promise.all(strips).then(function (data) {
        return build(o, data, rps, compressed ? 8 : 1, predictor);
      });
    }
    return { add: add, finish: finish, rowsPerStrip: rps };
  }
  function build(o, strips, rps, compression, predictor) {
    var spp = o.samples, t = o.transform.slice(), tags = [];
    // Rounding noise is not a rotation.
    if (Math.abs(t[2]) < 1e-9 * Math.abs(t[1])) t[2] = 0;
    if (Math.abs(t[4]) < 1e-9 * Math.abs(t[5])) t[4] = 0;
    function tag(id, type, values) { tags.push({ id: id, type: type, values: values }); }
    var SHORT = 3, LONG = 4, DOUBLE = 12, ASCII = 2;
    tag(256, LONG, [o.width]);
    tag(257, LONG, [o.height]);
    tag(258, SHORT, new Array(spp).fill(8));
    tag(259, SHORT, [compression]);
    tag(262, SHORT, [o.palette ? 3 : spp === 3 ? 2 : 1]);
    tag(273, LONG, strips.map(function () { return 0; })); // offsets, set below
    tag(277, SHORT, [spp]);
    tag(278, LONG, [rps]);
    tag(279, LONG, strips.map(function (s) { return s.length; }));
    tag(284, SHORT, [1]);
    tag(305, ASCII, "GeoSAI ekstrak-pdf");
    if (predictor === 2) tag(317, SHORT, [2]);
    if (o.palette) {
      var cmap = new Array(768).fill(0);
      o.palette.forEach(function (c, i) { if (i < 256) { cmap[i] = c[0] * 257; cmap[256 + i] = c[1] * 257; cmap[512 + i] = c[2] * 257; } });
      tag(320, SHORT, cmap);
    }
    tag(339, SHORT, new Array(spp).fill(1));
    if (!t[2] && !t[4]) {
      tag(33550, DOUBLE, [t[1], -t[5], 0]);
      tag(33922, DOUBLE, [0, 0, 0, t[0], t[3], 0]);
    } else {
      tag(34264, DOUBLE, [t[1], t[2], 0, t[0], t[4], t[5], 0, t[3], 0, 0, 0, 0, 0, 0, 0, 1]);
    }
    var geographic = o.epsg === 4326;
    var keys = [[1024, geographic ? 2 : 1], [1025, 1], geographic ? [2048, 4326] : [3072, o.epsg]];
    var dir = [1, 1, 0, keys.length];
    keys.forEach(function (k) { dir.push(k[0], 0, 1, k[1]); });
    tag(34735, SHORT, dir);
    if (o.nodata != null) tag(42113, ASCII, String(o.nodata));
    tags.sort(function (a, b) { return a.id - b.id; });

    var SIZE = { 2: 1, 3: 2, 4: 4, 12: 8 };
    var dataLen = strips.reduce(function (s, d) { return s + d.length; }, 0);
    var ifdOff = 8 + dataLen + ((8 + dataLen) & 1);
    var extraOff = ifdOff + 2 + tags.length * 12 + 4, extra = [];
    tags.forEach(function (tg) {
      var bytes = tg.type === ASCII ? tg.values.length + 1 : tg.values.length * SIZE[tg.type];
      tg.count = tg.type === ASCII ? tg.values.length + 1 : tg.values.length;
      if (bytes > 4) {
        tg.offset = extraOff;
        extraOff += bytes + (bytes & 1);
        extra.push(tg);
      }
    });
    var stripOffsets = [], off = 8;
    strips.forEach(function (s) { stripOffsets.push(off); off += s.length; });
    tags.forEach(function (tg) { if (tg.id === 273) tg.values = stripOffsets; });

    var head = new DataView(new ArrayBuffer(8));
    head.setUint16(0, 0x4949); head.setUint16(2, 42, true); head.setUint32(4, ifdOff, true);
    var tail = new DataView(new ArrayBuffer(extraOff - ifdOff + ((8 + dataLen) & 1)));
    var base = (8 + dataLen) & 1, p = base;
    function put(dv, at, type, v) {
      if (type === SHORT) dv.setUint16(at, v, true);
      else if (type === LONG) dv.setUint32(at, v, true);
      else if (type === DOUBLE) dv.setFloat64(at, v, true);
    }
    tail.setUint16(p, tags.length, true); p += 2;
    tags.forEach(function (tg) {
      tail.setUint16(p, tg.id, true); tail.setUint16(p + 2, tg.type, true); tail.setUint32(p + 4, tg.count, true);
      if (tg.offset != null) tail.setUint32(p + 8, tg.offset, true);
      else if (tg.type === ASCII) for (var k = 0; k < tg.values.length; k++) tail.setUint8(p + 8 + k, tg.values.charCodeAt(k));
      else tg.values.forEach(function (v, k) { put(tail, p + 8 + k * SIZE[tg.type], tg.type, v); });
      p += 12;
    });
    tail.setUint32(p, 0, true);
    extra.forEach(function (tg) {
      var q = tg.offset - ifdOff + base;
      if (tg.type === ASCII) { for (var k = 0; k < tg.values.length; k++) tail.setUint8(q + k, tg.values.charCodeAt(k) & 255); }
      else tg.values.forEach(function (v, k) { put(tail, q + k * SIZE[tg.type], tg.type, v); });
    });
    return [new Uint8Array(head.buffer)].concat(strips, [new Uint8Array(tail.buffer)]);
  }

  return {
    crs: crs,
    GEOGRAPHIC: GEOGRAPHIC,
    utmEpsg: utmEpsg,
    detectCrs: detectCrs,
    parseDegrees: parseDegrees,
    parseNumber: parseNumber,
    concat: concat,
    invert: invert,
    apply: apply,
    extractPaths: extractPaths,
    groupPaths: groupPaths,
    hex: hex,
    findGridNodes: findGridNodes,
    latticeSpacing: latticeSpacing,
    niceInterval: niceInterval,
    fit: fit,
    fitScale: fitScale,
    completeGrid: completeGrid,
    findFrame: findFrame,
    imageDpi: imageDpi,
    projector: projector,
    pathFeatures: pathFeatures,
    textLabels: textLabels,
    parseValue: parseValue,
    readGeoPdf: readGeoPdf,
    rgbToLab: rgbToLab,
    colorTable: colorTable,
    classify: classify,
    removeThin: removeThin,
    sieve: sieve,
    traceClass: traceClass,
    simplifyRing: simplifyRing,
    nestRings: nestRings,
    polygonize: polygonize,
    tiffWriter: tiffWriter,
  };
});
