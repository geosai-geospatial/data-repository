// Spatial statistics and operations (analisis-spasial.html): measurements on
// the WGS 84 ellipsoid, attribute statistics, point-pattern statistics,
// spatial autocorrelation (Moran's I), hot spots (Getis-Ord Gi*), and
// geometry operations (centroid, envelope, buffer, dissolve, clip, erase,
// intersect, count points in polygons). Everything runs in the visitor's
// browser (in a worker, analysisworker.js); nothing is uploaded.
//
// Input and output are GeoJSON features in WGS 84 longitude/latitude, as read
// by geoconvert.js. Polygon boolean operations use polygon-clipping (vendored,
// MIT). Shared by the worker (browser) and the tests (Node), like geoconvert.js.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("../vendor/polygon-clipping/polygon-clipping.umd.min.js"));
  else root.GeoStats = factory(root.polygonClipping);
})(this, function (PC) {
  "use strict";

  function fail(msg) { throw new Error(msg); }

  // ---------- The ellipsoid ----------
  // WGS 84. Areas are exact on the ellipsoid for polygons whose edges are
  // straight in Lambert's cylindrical equal-area projection (x = aλ,
  // y = a·q(φ)/2), which for digitised boundaries (short edges) is the
  // ellipsoidal area to well under 0.01 %. Distances are Vincenty's inverse
  // formula (sub-millimetre). Statistics that only rank neighbours use the
  // sphere.
  var A = 6378137, F = 1 / 298.257223563, B = A * (1 - F), E2 = F * (2 - F), E = Math.sqrt(E2);
  var R = 6371008.8; // mean radius, for buffers and neighbour searches
  var RAD = Math.PI / 180;

  function q(sinPhi) {
    var es = E * sinPhi;
    return (1 - E2) * (sinPhi / (1 - es * es) - Math.log((1 - es) / (1 + es)) / (2 * E));
  }

  // Unsigned area of one ring, m².
  function ringArea(ring) {
    var n = ring.length;
    if (n < 3) return 0;
    var lon0 = ring[0][0], s = 0, px = 0, py = 0;
    for (var i = 0; i <= n; i++) {
      var p = ring[i % n], d = p[0] - lon0;
      if (d > 180) d -= 360; else if (d < -180) d += 360;
      var x = A * d * RAD, y = A * q(Math.sin(p[1] * RAD)) / 2;
      if (i) s += px * y - x * py;
      px = x; py = y;
    }
    return Math.abs(s / 2);
  }
  function polygonArea(rings) {
    var a = 0;
    rings.forEach(function (r, i) { a += i ? -ringArea(r) : ringArea(r); });
    return Math.max(0, a);
  }

  // Vincenty's inverse formula on WGS 84, metres. Nearly antipodal points
  // (where it does not converge) fall back to the sphere.
  function distance(p1, p2) {
    if (p1[0] === p2[0] && p1[1] === p2[1]) return 0;
    var L = (p2[0] - p1[0]) * RAD;
    var U1 = Math.atan((1 - F) * Math.tan(p1[1] * RAD)), U2 = Math.atan((1 - F) * Math.tan(p2[1] * RAD));
    var sinU1 = Math.sin(U1), cosU1 = Math.cos(U1), sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
    var lambda = L, prev, sinSigma, cosSigma, sigma, cos2Alpha, cos2SigmaM, iter = 0;
    do {
      var sinL = Math.sin(lambda), cosL = Math.cos(lambda);
      sinSigma = Math.sqrt(Math.pow(cosU2 * sinL, 2) + Math.pow(cosU1 * sinU2 - sinU1 * cosU2 * cosL, 2));
      if (sinSigma === 0) return 0;
      cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
      sigma = Math.atan2(sinSigma, cosSigma);
      var sinAlpha = cosU1 * cosU2 * sinL / sinSigma;
      cos2Alpha = 1 - sinAlpha * sinAlpha;
      cos2SigmaM = cos2Alpha ? cosSigma - 2 * sinU1 * sinU2 / cos2Alpha : 0;
      var C = F / 16 * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
      prev = lambda;
      lambda = L + (1 - C) * F * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    } while (Math.abs(lambda - prev) > 1e-12 && ++iter < 200);
    if (iter >= 200) return haversine(p1, p2);
    var u2 = cos2Alpha * (A * A - B * B) / (B * B);
    var Ak = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
    var Bk = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
    var dSigma = Bk * sinSigma * (cos2SigmaM + Bk / 4 * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
      Bk / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    return B * Ak * (sigma - dSigma);
  }
  function haversine(p1, p2) {
    var dLat = (p2[1] - p1[1]) * RAD, dLon = (p2[0] - p1[0]) * RAD;
    var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(p1[1] * RAD) * Math.cos(p2[1] * RAD) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function pathLength(line, closed) {
    var s = 0;
    for (var i = 1; i < line.length; i++) s += distance(line[i - 1], line[i]);
    if (closed && line.length > 2) {
      var a = line[0], b = line[line.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) s += distance(b, a);
    }
    return s;
  }

  // ---------- Geometry parts ----------
  // Any geometry as plain lists: points [[x, y]], lines [[[x, y], …]] and
  // polygons [[ring, hole, …]] (GeometryCollections flattened).
  function parts(g, out) {
    out = out || { points: [], lines: [], polygons: [] };
    if (!g) return out;
    var c = g.coordinates;
    switch (g.type) {
      case "Point": out.points.push(c); break;
      case "MultiPoint": c.forEach(function (p) { out.points.push(p); }); break;
      case "LineString": out.lines.push(c); break;
      case "MultiLineString": c.forEach(function (l) { out.lines.push(l); }); break;
      case "Polygon": out.polygons.push(c); break;
      case "MultiPolygon": c.forEach(function (p) { out.polygons.push(p); }); break;
      case "GeometryCollection": (g.geometries || []).forEach(function (x) { parts(x, out); }); break;
    }
    return out;
  }
  function kindOf(g) {
    var p = parts(g);
    return p.polygons.length ? "polygon" : p.lines.length ? "line" : p.points.length ? "point" : null;
  }
  // The kinds of geometry in a layer, with counts.
  function kinds(features) {
    var k = { point: 0, line: 0, polygon: 0, none: 0 };
    features.forEach(function (f) { k[kindOf(f.geometry) || "none"]++; });
    return k;
  }

  function geometryArea(g) {
    return parts(g).polygons.reduce(function (s, p) { return s + polygonArea(p); }, 0);
  }
  function geometryLength(g) {
    var p = parts(g), s = 0;
    p.lines.forEach(function (l) { s += pathLength(l, false); });
    return s;
  }
  function geometryPerimeter(g) {
    var s = 0;
    parts(g).polygons.forEach(function (p) { p.forEach(function (r) { s += pathLength(r, true); }); });
    return s;
  }

  function bboxOf(g) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    var p = parts(g);
    function add(pt) {
      if (pt[0] < b[0]) b[0] = pt[0];
      if (pt[1] < b[1]) b[1] = pt[1];
      if (pt[0] > b[2]) b[2] = pt[0];
      if (pt[1] > b[3]) b[3] = pt[1];
    }
    p.points.forEach(add);
    p.lines.forEach(function (l) { l.forEach(add); });
    p.polygons.forEach(function (poly) { poly[0].forEach(add); });
    return b;
  }
  function bboxHit(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }

  function toGeometry(type, list) {
    if (!list.length) return null;
    return list.length === 1 ? { type: type, coordinates: list[0] } : { type: "Multi" + type, coordinates: list };
  }

  // ---------- Point in polygon ----------
  function inRing(pt, ring) {
    var x = pt[0], y = pt[1], inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  function inPolygon(pt, rings) {
    if (!inRing(pt, rings[0])) return false;
    for (var i = 1; i < rings.length; i++) if (inRing(pt, rings[i])) return false;
    return true;
  }
  function inAny(pt, polygons) {
    for (var i = 0; i < polygons.length; i++) if (inPolygon(pt, polygons[i])) return true;
    return false;
  }

  // ---------- Centroids ----------
  // Centroids are computed in a local equirectangular frame around the
  // feature (x scaled by cos φ), which is accurate for features up to a few
  // hundred kilometres across.
  function centroid(g) {
    var p = parts(g), sx = 0, sy = 0, sw = 0;
    var bb = bboxOf(g);
    if (!isFinite(bb[0])) return null;
    var lon0 = (bb[0] + bb[2]) / 2, lat0 = (bb[1] + bb[3]) / 2, k = Math.cos(lat0 * RAD) || 1e-9;
    function X(pt) { return (pt[0] - lon0) * k; }
    function Y(pt) { return pt[1] - lat0; }
    if (p.polygons.length) {
      p.polygons.forEach(function (poly) {
        poly.forEach(function (ring, ri) {
          var a = 0, cx = 0, cy = 0;
          for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            var x0 = X(ring[j]), y0 = Y(ring[j]), x1 = X(ring[i]), y1 = Y(ring[i]);
            var cr = x0 * y1 - x1 * y0;
            a += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr;
          }
          if (!a) return;
          // Each ring's own centroid, weighted by its area: holes subtract.
          var w = (ri ? -1 : 1) * Math.abs(a / 2);
          sx += cx / (3 * a) * w; sy += cy / (3 * a) * w; sw += w;
        });
      });
    }
    if (!sw && (p.lines.length || p.polygons.length)) {
      var lines = p.lines.concat.apply(p.lines, p.polygons);
      lines.forEach(function (l) {
        for (var i = 1; i < l.length; i++) {
          var x0 = X(l[i - 1]), y0 = Y(l[i - 1]), x1 = X(l[i]), y1 = Y(l[i]);
          var w = Math.hypot(x1 - x0, y1 - y0);
          sx += (x0 + x1) / 2 * w; sy += (y0 + y1) / 2 * w; sw += w;
        }
      });
    }
    if (!sw) {
      var pts = p.points.length ? p.points : [[lon0, lat0]];
      pts.forEach(function (pt) { sx += X(pt); sy += Y(pt); sw++; });
    }
    return [lon0 + sx / sw / k, lat0 + sy / sw];
  }

  // A point guaranteed inside the polygon: the centroid if it is inside,
  // otherwise the middle of the widest stretch of the largest polygon along
  // the parallel through its centroid (or its middle).
  function interiorPoint(g) {
    var c = centroid(g), polys = parts(g).polygons;
    if (!polys.length || !c || inAny(c, polys)) return c;
    var big = polys.map(function (p) { return { p: p, a: polygonArea(p) }; }).sort(function (a, b) { return b.a - a.a; })[0].p;
    var bb = bboxOf({ type: "Polygon", coordinates: big });
    var tries = [centroid({ type: "Polygon", coordinates: big })[1], (bb[1] + bb[3]) / 2];
    for (var t = 0; t < tries.length; t++) {
      var y = tries[t], xs = [];
      big.forEach(function (ring) {
        for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          var a = ring[i], b = ring[j];
          if ((a[1] > y) !== (b[1] > y)) xs.push((b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]);
        }
      });
      xs.sort(function (a, b) { return a - b; });
      var best = null;
      for (var i = 0; i + 1 < xs.length; i += 2) {
        if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
      }
      if (best && best[1] > best[0]) return [(best[0] + best[1]) / 2, y];
    }
    return big[0][0].slice(0, 2);
  }

  // ---------- Convex hull (Andrew's monotone chain, in longitude/latitude) ----------
  function convexHull(points) {
    var pts = points.map(function (p) { return [p[0], p[1]]; }).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var uniq = pts.filter(function (p, i) { return !i || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]; });
    if (uniq.length < 3) return null;
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lower = [], upper = [];
    uniq.forEach(function (p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    });
    for (var i = uniq.length - 1; i >= 0; i--) {
      var p = uniq[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    var hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    if (hull.length < 3) return null;
    hull.push(hull[0].slice());
    return [hull]; // counter-clockwise
  }
  function allPositions(g) {
    var p = parts(g), out = p.points.slice();
    p.lines.forEach(function (l) { out.push.apply(out, l); });
    p.polygons.forEach(function (poly) { out.push.apply(out, poly[0]); });
    return out;
  }

  // ---------- Descriptive statistics ----------
  function numberOf(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string" && /^\s*-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) return Number(v);
    return null;
  }
  // Quantile with linear interpolation between order statistics (the default
  // in R, Excel's PERCENTILE.INC and NumPy).
  function quantile(sorted, p) {
    if (!sorted.length) return null;
    var h = (sorted.length - 1) * p, lo = Math.floor(h);
    return lo + 1 < sorted.length ? sorted[lo] + (h - lo) * (sorted[lo + 1] - sorted[lo]) : sorted[lo];
  }
  function describe(values) {
    var xs = [], missing = 0;
    values.forEach(function (v) {
      var x = numberOf(v);
      if (x == null) missing++; else xs.push(x);
    });
    var n = xs.length;
    if (!n) return { n: 0, missing: missing };
    xs.sort(function (a, b) { return a - b; });
    var sum = 0;
    xs.forEach(function (x) { sum += x; });
    var mean = sum / n, ss = 0;
    xs.forEach(function (x) { ss += (x - mean) * (x - mean); });
    var std = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
    return {
      n: n, missing: missing, sum: sum, mean: mean, std: std,
      min: xs[0], q1: quantile(xs, 0.25), median: quantile(xs, 0.5), q3: quantile(xs, 0.75), max: xs[n - 1],
      cv: mean ? std / Math.abs(mean) : null,
      sorted: xs,
    };
  }
  // Equal-width bins; the number of bins from Sturges' rule (5–20).
  function histogram(sorted, bins) {
    var n = sorted.length;
    if (!n) return [];
    var lo = sorted[0], hi = sorted[n - 1];
    if (lo === hi) return [{ from: lo, to: hi, count: n }];
    var k = bins || Math.max(5, Math.min(20, Math.ceil(Math.log2(n) + 1)));
    var w = (hi - lo) / k, out = [];
    for (var i = 0; i < k; i++) out.push({ from: lo + i * w, to: i === k - 1 ? hi : lo + (i + 1) * w, count: 0 });
    sorted.forEach(function (x) { out[Math.min(k - 1, Math.floor((x - lo) / w))].count++; });
    return out;
  }

  // ---------- Normal distribution ----------
  // Complementary error function (Numerical Recipes' erfcc, relative error
  // < 1.2e-7 everywhere, so tail p-values keep their precision).
  function erfc(x) {
    var z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    var r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
      t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }
  function pTwoSided(z) { return isFinite(z) ? erfc(Math.abs(z) / Math.SQRT2) : 0; }

  // A small seeded random generator (mulberry32), so permutation tests give
  // the same answer every time for the same data.
  function random(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- Neighbour searches ----------
  // Points on the unit sphere in a 3-D grid: the straight-line (chord)
  // distance ranks neighbours exactly as the great-circle distance does.
  function xyz(p) {
    var lon = p[0] * RAD, lat = p[1] * RAD, c = Math.cos(lat);
    return [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
  }
  function chordToMetres(c) { return 2 * R * Math.asin(Math.min(1, c / 2)); }
  function metresToChord(d) { return 2 * Math.sin(Math.min(Math.PI, d / R) / 2); }

  function Index(points, cell) {
    var n = points.length, pos = new Float64Array(n * 3), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    points.forEach(function (p, i) {
      var v = xyz(p);
      for (var d = 0; d < 3; d++) {
        pos[i * 3 + d] = v[d];
        if (v[d] < lo[d]) lo[d] = v[d];
        if (v[d] > hi[d]) hi[d] = v[d];
      }
    });
    if (!cell) {
      var ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].sort(function (a, b) { return b - a; });
      cell = Math.sqrt(Math.max(ext[0] * ext[1], ext[0] * ext[0] * 1e-6) / Math.max(1, n)) * 1.5 || 1e-9;
    }
    var cells = new Map();
    for (var i = 0; i < n; i++) {
      var key = Math.floor(pos[i * 3] / cell) + "," + Math.floor(pos[i * 3 + 1] / cell) + "," + Math.floor(pos[i * 3 + 2] / cell);
      var list = cells.get(key);
      if (list) list.push(i); else cells.set(key, [i]);
    }
    this.n = n; this.pos = pos; this.cell = cell; this.cells = cells;
  }
  Index.prototype.chord = function (i, j) {
    var p = this.pos, dx = p[i * 3] - p[j * 3], dy = p[i * 3 + 1] - p[j * 3 + 1], dz = p[i * 3 + 2] - p[j * 3 + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  Index.prototype.home = function (i) {
    var c = this.cell, p = this.pos;
    return [Math.floor(p[i * 3] / c), Math.floor(p[i * 3 + 1] / c), Math.floor(p[i * 3 + 2] / c)];
  };
  // The k nearest other points to point i: [{ j, d (chord) }], nearest first.
  Index.prototype.knn = function (i, k) {
    var self = this, found = [], h = this.home(i);
    function take(j) {
      if (j === i) return;
      var d = self.chord(i, j);
      if (found.length < k) { found.push({ j: j, d: d }); found.sort(function (a, b) { return a.d - b.d; }); }
      else if (d < found[k - 1].d) { found[k - 1] = { j: j, d: d }; found.sort(function (a, b) { return a.d - b.d; }); }
    }
    for (var r = 0; ; r++) {
      // Far from the rest (an outlier): looking through every point is cheaper
      // than walking ever larger shells of empty cells.
      if (Math.pow(2 * r + 1, 3) > 4 * this.cells.size) {
        found = [];
        for (var j = 0; j < this.n; j++) take(j);
        break;
      }
      for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) for (var dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        var list = this.cells.get((h[0] + dx) + "," + (h[1] + dy) + "," + (h[2] + dz));
        if (list) list.forEach(take);
      }
      // Every point not yet seen is at least r cells away.
      if (found.length === Math.min(k, this.n - 1) && (!found.length || found[found.length - 1].d <= r * this.cell)) break;
    }
    return found;
  };
  // All other points within chord distance c of point i (the index's cell
  // must be at least c).
  Index.prototype.within = function (i, c) {
    var out = [], h = this.home(i);
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
      var list = this.cells.get((h[0] + dx) + "," + (h[1] + dy) + "," + (h[2] + dz));
      if (!list) continue;
      for (var t = 0; t < list.length; t++) {
        var j = list[t];
        if (j !== i && this.chord(i, j) <= c) out.push(j);
      }
    }
    return out;
  };

  // ---------- Spatial weights ----------
  // Neighbour lists for n features: "contiguity" (polygons or lines that
  // share a vertex: queen contiguity), "knn" (the k nearest centroids) or
  // "distance" (every centroid within a distance in metres). Features left
  // without neighbours get their nearest one, and are counted as `fallback`.
  var MAX_NEIGHBOURS = 2000000; // pairs, to keep memory in check
  function weights(features, opts) {
    opts = opts || {};
    var n = features.length, method = opts.method || "knn";
    if (n < 3) fail("At least 3 features with a value are needed.");
    var points = features.map(function (f) { return centroid(f.geometry); });
    var lists = [], fallback = 0, total = 0, index;
    if (method === "contiguity") {
      var sets = [], seen = new Map();
      for (var i = 0; i < n; i++) sets.push(new Set());
      features.forEach(function (f, i) {
        var p = parts(f.geometry), rings = p.lines.concat.apply(p.lines, p.polygons);
        rings.forEach(function (ring) {
          ring.forEach(function (pt) {
            var key = Math.round(pt[0] * 1e7) + "," + Math.round(pt[1] * 1e7);
            var list = seen.get(key);
            if (!list) seen.set(key, [i]);
            else if (list[list.length - 1] !== i) list.push(i);
          });
        });
      });
      seen.forEach(function (list) {
        if (list.length < 2) return;
        for (var a = 0; a < list.length; a++) for (var b = 0; b < list.length; b++) if (a !== b) sets[list[a]].add(list[b]);
      });
      seen = null;
      lists = sets.map(function (s) { return Array.from(s).sort(function (a, b) { return a - b; }); });
    } else if (method === "distance") {
      var d = Number(opts.distance);
      if (!(d > 0)) fail("Give a distance greater than 0.");
      var c = metresToChord(d);
      index = new Index(points, c);
      for (var i2 = 0; i2 < n; i2++) {
        var w = index.within(i2, c).sort(function (a, b) { return a - b; });
        total += w.length;
        if (total > MAX_NEIGHBOURS) fail("The distance is too large: there are too many neighbours. Use a smaller distance or k nearest neighbours.");
        lists.push(w);
      }
    } else if (method === "knn") {
      var k = Math.max(1, Math.min(Math.round(Number(opts.k) || 8), n - 1));
      index = new Index(points);
      for (var i3 = 0; i3 < n; i3++) lists.push(index.knn(i3, k).map(function (x) { return x.j; }).sort(function (a, b) { return a - b; }));
    } else {
      fail("Unknown weights method: " + method);
    }
    lists.forEach(function (l, i) {
      if (l.length) return;
      index = index || new Index(points);
      var nn = index.knn(i, 1);
      if (nn.length) { lists[i] = [nn[0].j]; fallback++; }
    });
    var counts = lists.map(function (l) { return l.length; }), sum = 0;
    counts.forEach(function (c) { sum += c; });
    return {
      neighbours: lists, points: points, fallback: fallback, method: method,
      min: Math.min.apply(null, counts), max: Math.max.apply(null, counts), mean: sum / n,
    };
  }

  // ---------- Global Moran's I ----------
  // Row-standardised weights. The z-score uses the variance under the
  // randomisation assumption (Cliff & Ord); a permutation test gives a
  // pseudo p-value that does not depend on the values being normal.
  function moran(values, W, opts) {
    opts = opts || {};
    var n = values.length, nb = W.neighbours;
    if (n < 4) fail("At least 4 features with a value are needed.");
    var mean = 0;
    values.forEach(function (x) { mean += x; });
    mean /= n;
    var z = values.map(function (x) { return x - mean; }), m2 = 0, m4 = 0;
    z.forEach(function (v) { m2 += v * v; m4 += v * v * v * v; });
    if (!m2) fail("All values are the same, so there is no pattern to test.");
    function stat(zz) {
      var s = 0;
      for (var i = 0; i < n; i++) {
        var l = nb[i];
        if (!l.length) continue;
        var t = 0;
        for (var a = 0; a < l.length; a++) t += zz[l[a]];
        s += zz[i] * t / l.length;
      }
      return s;
    }
    // Weight sums. With row standardisation w_ij = 1 / k_i.
    var S0 = 0, colSum = new Float64Array(n), pair = new Map();
    for (var i = 0; i < n; i++) {
      var l = nb[i];
      if (!l.length) continue;
      S0 += 1;
      for (var a = 0; a < l.length; a++) {
        colSum[l[a]] += 1 / l.length;
        pair.set(i * n + l[a], 1 / l.length);
      }
    }
    var S1 = 0;
    pair.forEach(function (w, key) {
      var i = Math.floor(key / n), j = key - i * n, back = pair.get(j * n + i) || 0;
      // (w_ij + w_ji)² appears twice in the double sum, for (i, j) and
      // (j, i); a pair linked both ways is visited twice, so count it once.
      if (back && j < i) return;
      S1 += 2 * Math.pow(w + back, 2);
    });
    S1 /= 2;
    var S2 = 0;
    for (var i2 = 0; i2 < n; i2++) S2 += Math.pow((nb[i2].length ? 1 : 0) + colSum[i2], 2);
    var I = n / S0 * stat(z) / m2, EI = -1 / (n - 1);
    var b2 = n * m4 / (m2 * m2);
    var EI2 = (n * ((n * n - 3 * n + 3) * S1 - n * S2 + 3 * S0 * S0) - b2 * ((n * n - n) * S1 - 2 * n * S2 + 6 * S0 * S0)) /
      ((n - 1) * (n - 2) * (n - 3) * S0 * S0);
    var variance = EI2 - EI * EI, zScore = (I - EI) / Math.sqrt(variance);
    var out = { I: I, expected: EI, variance: variance, z: zScore, p: pTwoSided(zScore), n: n, S0: S0, S1: S1, S2: S2 };
    var perms = opts.permutations == null ? 999 : opts.permutations;
    if (perms > 0) {
      var rnd = random(opts.seed || 12345), zz = z.slice(), extreme = 0, sum = 0, sumSq = 0;
      for (var p = 0; p < perms; p++) {
        for (var s = n - 1; s > 0; s--) {
          var r = Math.floor(rnd() * (s + 1)), tmp = zz[s];
          zz[s] = zz[r]; zz[r] = tmp;
        }
        var Ip = n / S0 * stat(zz) / m2;
        sum += Ip; sumSq += Ip * Ip;
        if (I >= EI ? Ip >= I : Ip <= I) extreme++;
      }
      out.permutations = perms;
      out.pseudoP = (extreme + 1) / (perms + 1);
      out.permMean = sum / perms;
      out.permVariance = (sumSq - sum * sum / perms) / (perms - 1);
    }
    return out;
  }

  // ---------- Hot spots: Getis-Ord Gi* ----------
  // Binary weights with each feature counted as its own neighbour. Returns a
  // z-score and two-sided p-value per feature, and a bin: ±3 (99 %
  // confidence), ±2 (95 %), ±1 (90 %), 0 (not significant); + is a hot spot.
  function getisOrd(values, W) {
    var n = values.length, nb = W.neighbours, sum = 0, sumSq = 0;
    if (n < 3) fail("At least 3 features with a value are needed.");
    values.forEach(function (x) { sum += x; sumSq += x * x; });
    var mean = sum / n, S = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    if (!(S > 0)) fail("All values are the same, so there is no pattern to test.");
    return values.map(function (x, i) {
      var l = nb[i], wsum = l.length + 1, lx = x;
      for (var a = 0; a < l.length; a++) lx += values[l[a]];
      var den = S * Math.sqrt((n * wsum - wsum * wsum) / (n - 1));
      var z = den > 0 ? (lx - mean * wsum) / den : 0;
      var p = pTwoSided(z), abs = Math.abs(z);
      var bin = abs >= 2.5758 ? 3 : abs >= 1.96 ? 2 : abs >= 1.6449 ? 1 : 0;
      return { z: z, p: p, bin: z < 0 ? -bin : bin };
    });
  }

  // ---------- Point patterns ----------
  // Mean centre (the mean of the points as 3-D unit vectors, so it works
  // across the antimeridian), optionally weighted.
  function meanCenter(points, w) {
    var s = [0, 0, 0], sw = 0;
    points.forEach(function (p, i) {
      var v = xyz(p), wi = w ? w[i] : 1;
      s[0] += v[0] * wi; s[1] += v[1] * wi; s[2] += v[2] * wi; sw += wi;
    });
    if (!sw) return null;
    return [Math.atan2(s[1], s[0]) / RAD, Math.atan2(s[2], Math.hypot(s[0], s[1])) / RAD];
  }
  // Clark & Evans' nearest-neighbour index over the convex hull's area.
  // R < 1: clustered, R ≈ 1: random, R > 1: dispersed.
  function nearestNeighbour(points) {
    var n = points.length;
    if (n < 3) fail("At least 3 points are needed.");
    var hull = convexHull(points), area = hull ? polygonArea(hull) : 0;
    if (!(area > 0)) fail("The points lie on one line, so they cover no area.");
    // The sphere ranks neighbours; the ellipsoid (up to 0.7 % different by
    // direction) decides among the closest few.
    var index = new Index(points), sum = 0;
    for (var i = 0; i < n; i++) {
      var best = Infinity;
      index.knn(i, Math.min(4, n - 1)).forEach(function (c) { best = Math.min(best, distance(points[i], points[c.j])); });
      sum += best;
    }
    var observed = sum / n, density = n / area;
    var expected = 0.5 / Math.sqrt(density), se = 0.26136 / Math.sqrt(n * density);
    var z = (observed - expected) / se;
    return { n: n, area: area, hull: hull, observed: observed, expected: expected, ratio: observed / expected, z: z, p: pTwoSided(z) };
  }

  // ---------- Local projection, for buffers ----------
  // Azimuthal equidistant on a sphere with the ellipsoid's Gaussian radius
  // at the feature (√(MN)), centred on it: distances from the centre are true
  // to about ±0.3 % (the ellipsoid is flatter north–south), and nearly so
  // across a feature a few hundred kilometres wide.
  function aeqd(lon0, lat0) {
    var l0 = lon0 * RAD, p0 = lat0 * RAD, sp0 = Math.sin(p0), cp0 = Math.cos(p0);
    var w = 1 - E2 * sp0 * sp0, R = A * Math.sqrt(1 - E2) / w;
    return {
      forward: function (p) {
        var l = p[0] * RAD - l0, ph = p[1] * RAD, sp = Math.sin(ph), cp = Math.cos(ph), cl = Math.cos(l);
        var cc = Math.max(-1, Math.min(1, sp0 * sp + cp0 * cp * cl)), c = Math.acos(cc);
        var k = c < 1e-12 ? 1 : c / Math.sin(c);
        return [R * k * cp * Math.sin(l), R * k * (cp0 * sp - sp0 * cp * cl)];
      },
      inverse: function (xy) {
        var x = xy[0], y = xy[1], rho = Math.hypot(x, y);
        if (rho < 1e-9) return [lon0, lat0];
        var c = rho / R, sc = Math.sin(c), cc = Math.cos(c);
        var ph = Math.asin(Math.max(-1, Math.min(1, cc * sp0 + y * sc * cp0 / rho)));
        var l = l0 + Math.atan2(x * sc, rho * cp0 * cc - y * sp0 * sc);
        var lon = l / RAD;
        while (lon > 180) lon -= 360;
        while (lon < -180) lon += 360;
        return [lon, ph / RAD];
      },
    };
  }

  // Douglas–Peucker simplification of a projected line.
  function simplify(pts, tol) {
    if (pts.length < 3 || !(tol > 0)) return pts;
    var keep = new Uint8Array(pts.length), stack = [[0, pts.length - 1]], t2 = tol * tol;
    keep[0] = keep[pts.length - 1] = 1;
    while (stack.length) {
      var s = stack.pop(), a = pts[s[0]], b = pts[s[1]], best = -1, bd = 0;
      var dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
      for (var i = s[0] + 1; i < s[1]; i++) {
        var p = pts[i], t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        var ex = a[0] + t * dx - p[0], ey = a[1] + t * dy - p[1], d = ex * ex + ey * ey;
        if (d > bd) { bd = d; best = i; }
      }
      if (best > 0 && bd > t2) {
        keep[best] = 1;
        stack.push([s[0], best], [best, s[1]]);
      }
    }
    return pts.filter(function (p, i) { return keep[i]; });
  }

  function circle(c, r, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var t = 2 * Math.PI * i / n;
      out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
    }
    out.push(out[0].slice());
    return out;
  }
  // A segment widened by r on both sides, with round ends.
  function stadium(a, b, r, n) {
    var ang = Math.atan2(b[1] - a[1], b[0] - a[0]), out = [], half = Math.max(2, Math.round(n / 2));
    for (var i = 0; i <= half; i++) {
      var t = ang - Math.PI / 2 - Math.PI * i / half; // around a, on its far side
      out.push([a[0] + r * Math.cos(t), a[1] + r * Math.sin(t)]);
    }
    for (var j = 0; j <= half; j++) {
      var u = ang + Math.PI / 2 - Math.PI * j / half; // around b
      out.push([b[0] + r * Math.cos(u), b[1] + r * Math.sin(u)]);
    }
    out.push(out[0].slice());
    return [out];
  }

  // Union of many polygons, merged pairwise (much faster than one by one).
  function unionAll(list) {
    list = list.filter(function (g) { return g && g.length; });
    if (!list.length) return [];
    while (list.length > 1) {
      var next = [];
      for (var i = 0; i < list.length; i += 8) next.push(PC.union.apply(null, list.slice(i, i + 8)));
      list = next;
    }
    return list[0].length && typeof list[0][0][0][0] === "number" ? [list[0]] : list[0];
  }

  // Coordinates snapped to a grid. polygon-clipping can fail on vertices that
  // differ only in the last bits (neighbouring buffer pieces compute "the
  // same" arc point twice); on a grid they are the same number.
  function snap(geoms, step) {
    return geoms.map(function (poly) {
      return poly.map(function (ring) {
        return ring.map(function (p) { return [Math.round(p[0] / step) * step, Math.round(p[1] / step) * step]; });
      });
    });
  }

  // Buffer one geometry by d metres (negative shrinks polygons). Returns a
  // MultiPolygon coordinate list in longitude/latitude, or [] if nothing is
  // left. Built on a 1 mm grid, then coarser grids (up to 1 % of the
  // distance) if the polygon library still trips.
  function bufferGeometry(g, d, segments) {
    var steps = [0.001, 0.01, 0.1, Math.abs(d) / 100], err;
    for (var i = 0; i < steps.length; i++) {
      if (i && steps[i] <= steps[i - 1]) continue;
      try { return bufferOn(g, d, segments, steps[i]); } catch (e) { err = e; }
    }
    throw err;
  }
  function bufferOn(g, d, segments, step) {
    var bb = bboxOf(g);
    if (!isFinite(bb[0]) || !d) return [];
    var proj = aeqd((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2), r = Math.abs(d);
    var n = segments || 32, tol = r / 100, p = parts(g), pieces = [];
    var fw = function (list) { return simplify(list.map(proj.forward), tol); };
    if (d > 0) {
      p.points.forEach(function (pt) { pieces.push([circle(proj.forward(pt), r, 2 * n)]); });
      p.lines.forEach(function (l) {
        var xy = fw(l);
        if (xy.length === 1) pieces.push([circle(xy[0], r, n)]);
        for (var i = 1; i < xy.length; i++) pieces.push(stadium(xy[i - 1], xy[i], r, n));
      });
    }
    var polys = p.polygons.map(function (poly) {
      return poly.map(fw).filter(function (ring) { return ring.length >= 4; });
    }).filter(function (poly) { return poly.length; });
    var edges = [];
    polys.forEach(function (poly) {
      poly.forEach(function (ring) {
        for (var i = 1; i < ring.length; i++) edges.push(stadium(ring[i - 1], ring[i], r, n));
      });
    });
    var out;
    pieces = snap(pieces, step); polys = snap(polys, step); edges = snap(edges, step);
    if (d > 0) out = unionAll(pieces.concat(polys, edges));
    else {
      if (!polys.length) return [];
      var band = unionAll(edges);
      out = band.length ? PC.difference(unionAll(polys), band) : unionAll(polys);
    }
    return out.map(function (poly) { return poly.map(function (ring) { return ring.map(proj.inverse); }); });
  }

  // ---------- Cutting lines by polygons ----------
  // Pieces of a line inside (keepInside) or outside a set of polygons.
  function cutLine(line, polygons, keepInside) {
    var edges = [];
    polygons.forEach(function (poly) {
      poly.forEach(function (ring) {
        for (var i = 1; i < ring.length; i++) edges.push([ring[i - 1], ring[i]]);
      });
    });
    var out = [], run = null;
    function emit(a, b) {
      if (run && run[run.length - 1][0] === a[0] && run[run.length - 1][1] === a[1]) run.push(b);
      else { run = [a, b]; out.push(run); }
    }
    for (var i = 1; i < line.length; i++) {
      var p = line[i - 1], s = line[i], ts = [0, 1];
      var rx = s[0] - p[0], ry = s[1] - p[1];
      var minx = Math.min(p[0], s[0]), maxx = Math.max(p[0], s[0]), miny = Math.min(p[1], s[1]), maxy = Math.max(p[1], s[1]);
      edges.forEach(function (e) {
        var a = e[0], b = e[1];
        if (Math.max(a[0], b[0]) < minx || Math.min(a[0], b[0]) > maxx || Math.max(a[1], b[1]) < miny || Math.min(a[1], b[1]) > maxy) return;
        var sx = b[0] - a[0], sy = b[1] - a[1], den = rx * sy - ry * sx;
        if (!den) return;
        var t = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / den, u = ((a[0] - p[0]) * ry - (a[1] - p[1]) * rx) / den;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
      });
      ts.sort(function (x, y) { return x - y; });
      for (var k = 1; k < ts.length; k++) {
        if (ts[k] - ts[k - 1] < 1e-12) continue;
        var tm = (ts[k - 1] + ts[k]) / 2;
        if (inAny([p[0] + rx * tm, p[1] + ry * tm], polygons) !== keepInside) { run = null; continue; }
        emit(k === 1 ? p : [p[0] + rx * ts[k - 1], p[1] + ry * ts[k - 1]], k === ts.length - 1 ? s : [p[0] + rx * ts[k], p[1] + ry * ts[k]]);
      }
    }
    return out;
  }

  // Any geometry with its coordinates rounded to a grid (degrees).
  function snapGeometry(g, step) {
    if (!g) return g;
    if (g.type === "GeometryCollection") return { type: g.type, geometries: g.geometries.map(function (x) { return snapGeometry(x, step); }) };
    var depth = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 }[g.type];
    return { type: g.type, coordinates: (function walk(a, d) {
      return d ? a.map(function (x) { return walk(x, d - 1); }) : [Math.round(a[0] / step) * step, Math.round(a[1] / step) * step];
    })(g.coordinates, depth) };
  }
  var SNAP_DEG = 1e-8; // about 1 mm

  // A geometry cut by polygons: the part inside (keepInside) or outside.
  // Retried on a 1 mm grid if the polygon library trips on near-coincident
  // vertices.
  function cutGeometry(g, polygons, keepInside) {
    try {
      return cutOnce(g, polygons, keepInside);
    } catch (e) {
      return cutOnce(snapGeometry(g, SNAP_DEG), snap(polygons, SNAP_DEG), keepInside);
    }
  }
  function cutOnce(g, polygons, keepInside) {
    var p = parts(g), out = [];
    var pts = p.points.filter(function (pt) { return inAny(pt, polygons) === keepInside; });
    if (pts.length) out.push(toGeometry("Point", pts));
    var lines = [];
    p.lines.forEach(function (l) { lines.push.apply(lines, cutLine(l, polygons, keepInside)); });
    if (lines.length) out.push(toGeometry("LineString", lines));
    if (p.polygons.length) {
      var res = keepInside ? PC.intersection(p.polygons, unionAll(polygons.map(function (x) { return [x]; }))) :
        PC.difference.apply(null, [p.polygons].concat(polygons.map(function (x) { return [x]; })));
      if (res.length) out.push(toGeometry("Polygon", res));
    }
    return out.length ? out.length === 1 ? out[0] : { type: "GeometryCollection", geometries: out } : null;
  }

  // ---------- Operations on layers ----------
  function copyProps(f) {
    var o = {}, p = f.properties || {};
    for (var k in p) o[k] = p[k];
    return o;
  }
  function round(v, d) { var m = Math.pow(10, d); return Math.round(v * m) / m; }
  // Adds area (ha) or length (km) to a result feature's attributes.
  function measured(props, g) {
    var k = kindOf(g);
    if (k === "polygon") props.luas_ha = round(geometryArea(g) / 1e4, 4);
    else if (k === "line") props.panjang_km = round(geometryLength(g) / 1000, 4);
    return props;
  }
  function polygonsOf(features) {
    return features.map(function (f) { return parts(f.geometry).polygons; });
  }
  function needPolygons(features, which) {
    if (!features.some(function (f) { return parts(f.geometry).polygons.length; })) fail("The " + which + " layer has no polygons.");
  }

  // Values of a numeric field, with the features that have one.
  function valued(features, field) {
    var fs = [], xs = [];
    features.forEach(function (f) {
      var x = f.geometry ? numberOf((f.properties || {})[field]) : null;
      if (x != null) { fs.push(f); xs.push(x); }
    });
    return { features: fs, values: xs };
  }

  var OPS = {
    // Attribute statistics: numbers (summary, histogram, optionally per
    // group) or text (frequency table), with area/length per group.
    describe: function (layers, o) {
      var fs = layers.a, field = o.field;
      if (!field) fail("Choose a field.");
      var k = kinds(fs), measure = k.polygon ? "area" : k.line ? "length" : null;
      function size(f) { return measure === "area" ? geometryArea(f.geometry) : measure === "length" ? geometryLength(f.geometry) : 0; }
      var vals = fs.map(function (f) { return (f.properties || {})[field]; });
      var numeric = o.numeric != null ? o.numeric : vals.some(function (v) { return numberOf(v) != null; }) &&
        vals.every(function (v) { return v == null || v === "" || numberOf(v) != null; });
      var report = { op: "describe", field: field, numeric: numeric, count: fs.length, measure: measure };
      function groups(keyOf) {
        var map = new Map();
        fs.forEach(function (f, i) {
          var key = keyOf(f, i), gr = map.get(key);
          if (!gr) map.set(key, gr = { key: key, count: 0, values: [], size: 0 });
          gr.count++;
          gr.values.push(vals[i]);
          if (measure) gr.size += size(f);
        });
        return Array.from(map.values()).sort(function (a, b) { return b.count - a.count || String(a.key).localeCompare(String(b.key)); });
      }
      if (numeric) {
        var st = describe(vals);
        report.stats = st;
        report.histogram = histogram(st.sorted || []);
        delete st.sorted;
        if (o.groupBy) {
          report.groupBy = o.groupBy;
          report.groups = groups(function (f) { var v = (f.properties || {})[o.groupBy]; return v == null || v === "" ? null : v; }).map(function (gr) {
            var s = describe(gr.values);
            return { key: gr.key, count: gr.count, n: s.n, sum: s.sum, mean: s.mean, min: s.min, max: s.max, size: gr.size };
          });
        }
      } else {
        var gs = groups(function (f, i) { var v = vals[i]; return v == null || v === "" ? null : v; });
        var totalSize = 0;
        gs.forEach(function (gr) { totalSize += gr.size; });
        report.distinct = gs.length;
        report.categories = gs.map(function (gr) {
          return { key: gr.key, count: gr.count, share: gr.count / fs.length, size: gr.size, sizeShare: totalSize ? gr.size / totalSize : null };
        });
      }
      return { report: report };
    },

    // Area and perimeter (polygons), length (lines), coordinates (points).
    measure: function (layers) {
      var areas = [], lengths = [], out = [], total = { area: 0, length: 0, perimeter: 0 };
      layers.a.forEach(function (f) {
        var g = f.geometry, k = kindOf(g), p = copyProps(f);
        if (k === "polygon") {
          var a = geometryArea(g), per = geometryPerimeter(g);
          p.luas_ha = round(a / 1e4, 4);
          p.kelilingkm = round(per / 1000, 4);
          areas.push(a / 1e4); total.area += a; total.perimeter += per;
        } else if (k === "line") {
          var l = geometryLength(g);
          p.panjang_km = round(l / 1000, 4);
          lengths.push(l / 1000); total.length += l;
        } else if (k === "point") {
          var c = centroid(g);
          p.bujur = round(c[0], 7);
          p.lintang = round(c[1], 7);
        }
        out.push({ type: "Feature", properties: p, geometry: g });
      });
      var area = describe(areas), length = describe(lengths);
      delete area.sorted; delete length.sorted;
      return {
        features: out,
        report: { op: "measure", count: out.length, kinds: kinds(layers.a), total: total, area: area, length: length },
      };
    },

    centroid: function (layers, o) {
      var out = [];
      layers.a.forEach(function (f) {
        if (!f.geometry) return;
        var c = o.inside ? interiorPoint(f.geometry) : centroid(f.geometry);
        if (c) out.push({ type: "Feature", properties: copyProps(f), geometry: { type: "Point", coordinates: c } });
      });
      return { features: out, report: { op: "centroid", count: out.length, inside: !!o.inside } };
    },

    // Convex hull or bounding box, of everything or per feature.
    envelope: function (layers, o) {
      var shape = o.shape === "bbox" ? "bbox" : "hull", out = [];
      function make(geoms, props) {
        var g = null;
        if (shape === "bbox") {
          var b = [Infinity, Infinity, -Infinity, -Infinity];
          geoms.forEach(function (x) {
            var bb = bboxOf(x);
            b = [Math.min(b[0], bb[0]), Math.min(b[1], bb[1]), Math.max(b[2], bb[2]), Math.max(b[3], bb[3])];
          });
          if (isFinite(b[0]) && b[2] > b[0] && b[3] > b[1]) {
            g = { type: "Polygon", coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] };
          }
        } else {
          var pts = [];
          geoms.forEach(function (x) { pts.push.apply(pts, allPositions(x)); });
          var h = convexHull(pts);
          if (h) g = { type: "Polygon", coordinates: h };
        }
        if (g) out.push({ type: "Feature", properties: measured(props, g), geometry: g });
      }
      if (o.per === "feature") layers.a.forEach(function (f) { if (f.geometry) make([f.geometry], copyProps(f)); });
      else make(layers.a.map(function (f) { return f.geometry; }).filter(Boolean), { jumlah: layers.a.filter(function (f) { return f.geometry; }).length });
      var area = 0;
      out.forEach(function (f) { area += geometryArea(f.geometry); });
      return { features: out, report: { op: "envelope", shape: shape, per: o.per === "feature" ? "feature" : "all", count: out.length, area: area } };
    },

    buffer: function (layers, o) {
      var d = Number(o.distance);
      if (!d || !isFinite(d)) fail("Give a buffer distance.");
      if (Math.abs(d) > 1000000) fail("The buffer distance is too large (max. 1,000 km).");
      if (d < 0) needPolygons(layers.a, "input");
      var out = [], failed = 0, empty = 0;
      layers.a.forEach(function (f) {
        if (!f.geometry) return;
        var mp;
        try {
          mp = bufferGeometry(f.geometry, d, o.segments);
        } catch (e) {
          failed++;
          return;
        }
        if (!mp.length) { empty++; return; }
        out.push({ type: "Feature", properties: copyProps(f), geometry: toGeometry("Polygon", mp) });
      });
      if (o.dissolve && out.length) {
        var all = unionAll(out.map(function (f) { return f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates; }));
        out = all.length ? [{ type: "Feature", properties: { jarak_m: d, jumlah: out.length }, geometry: toGeometry("Polygon", all) }] : [];
      } else {
        out.forEach(function (f) { f.properties.jarak_m = d; });
      }
      var area = 0;
      out.forEach(function (f) { measured(f.properties, f.geometry); area += geometryArea(f.geometry); });
      return { features: out, report: { op: "buffer", distance: d, count: out.length, area: area, failed: failed, empty: empty, dissolved: !!o.dissolve } };
    },

    // Merge features that share a value (or all of them). Polygons are
    // unioned, lines and points collected into one multi-geometry.
    dissolve: function (layers, o) {
      var groups = new Map(), field = o.field || "", sumField = o.sumField || "";
      layers.a.forEach(function (f) {
        if (!f.geometry) return;
        var v = field ? (f.properties || {})[field] : "";
        var key = v == null || v === "" ? "\u0000" : typeof v + ":" + v, gr = groups.get(key);
        if (!gr) groups.set(key, gr = { value: v == null || v === "" ? null : v, features: [] });
        gr.features.push(f);
      });
      var out = [], failed = 0;
      groups.forEach(function (gr) {
        var p = { points: [], lines: [], polygons: [] };
        gr.features.forEach(function (f) { parts(f.geometry, p); });
        var geoms = [];
        if (p.polygons.length) {
          var u = null;
          try {
            u = unionAll(p.polygons.map(function (x) { return [x]; }));
          } catch (e) {
            try { u = unionAll(snap(p.polygons, SNAP_DEG).map(function (x) { return [x]; })); } catch (e2) { u = null; }
          }
          if (!u) {
            failed++;
            geoms.push(toGeometry("Polygon", p.polygons));
          } else if (u.length) geoms.push(toGeometry("Polygon", u));
        }
        if (p.lines.length) geoms.push(toGeometry("LineString", p.lines));
        if (p.points.length) geoms.push(toGeometry("Point", p.points));
        if (!geoms.length) return;
        var props = {};
        if (field) props[field] = gr.value;
        props.jumlah = gr.features.length;
        if (sumField) {
          var s = describe(gr.features.map(function (f) { return (f.properties || {})[sumField]; }));
          props["total_" + sumField] = s.n ? s.sum : null;
        }
        var g = geoms.length === 1 ? geoms[0] : { type: "GeometryCollection", geometries: geoms };
        out.push({ type: "Feature", properties: measured(props, g), geometry: g });
      });
      var area = 0;
      out.forEach(function (f) { area += geometryArea(f.geometry); });
      return { features: out, report: { op: "dissolve", field: field, groups: out.length, count: layers.a.length, area: area, failed: failed } };
    },

    clip: function (layers) { return cut(layers, true, "clip"); },
    erase: function (layers) { return cut(layers, false, "erase"); },

    // Pieces of each input feature inside each overlay polygon, with the
    // attributes of both.
    intersect: function (layers) {
      var b = layers.b || [];
      needPolygons(b, "overlay");
      var bPolys = polygonsOf(b), bBoxes = b.map(function (f) { return bboxOf(f.geometry); });
      var names = {}, rename = {};
      layers.a.forEach(function (f) { for (var k in f.properties || {}) names[k] = true; });
      var out = [], failed = 0;
      layers.a.forEach(function (f) {
        if (!f.geometry) return;
        var bb = bboxOf(f.geometry);
        b.forEach(function (o, j) {
          if (!bPolys[j].length || !bboxHit(bb, bBoxes[j])) return;
          var g;
          try { g = cutGeometry(f.geometry, bPolys[j], true); } catch (e) { failed++; return; }
          if (!g) return;
          var p = copyProps(f), op = o.properties || {};
          for (var k in op) {
            if (!rename[k]) {
              var name = k, i = 2;
              while (names[name]) name = k + "_" + i++;
              rename[k] = name;
              names[name] = true;
            }
            p[rename[k]] = op[k];
          }
          out.push({ type: "Feature", properties: measured(p, g), geometry: g });
        });
      });
      return { features: out, report: { op: "intersect", count: out.length, input: layers.a.length, overlay: b.length, failed: failed } };
    },

    // For each polygon, the points of the other layer inside it: count,
    // count per km², and the sum and mean of a numeric field. Either layer
    // may hold the polygons.
    count: function (layers, o) {
      var a = layers.a, b = layers.b || [], swapped = false;
      var ka = kinds(a), kb = kinds(b);
      if (!ka.polygon && kb.polygon && ka.point) { a = layers.b; b = layers.a; swapped = true; }
      needPolygons(a, "first");
      var pts = [], vals = [], field = o.field || "";
      b.forEach(function (f) {
        parts(f.geometry).points.forEach(function (p) {
          pts.push(p);
          vals.push(field ? numberOf((f.properties || {})[field]) : null);
        });
      });
      if (!pts.length) fail("The second layer has no points.");
      // Points in a grid, so each polygon only tests the points near it.
      var gb = [Infinity, Infinity, -Infinity, -Infinity];
      pts.forEach(function (p) { gb = [Math.min(gb[0], p[0]), Math.min(gb[1], p[1]), Math.max(gb[2], p[0]), Math.max(gb[3], p[1])]; });
      var cells = Math.max(1, Math.round(Math.sqrt(pts.length / 4)));
      var cw = (gb[2] - gb[0]) / cells || 1, ch = (gb[3] - gb[1]) / cells || 1, grid = new Map();
      pts.forEach(function (p, i) {
        var key = Math.min(cells - 1, Math.floor((p[0] - gb[0]) / cw)) + "," + Math.min(cells - 1, Math.floor((p[1] - gb[1]) / ch));
        var l = grid.get(key);
        if (l) l.push(i); else grid.set(key, [i]);
      });
      var out = [], inside = 0;
      a.forEach(function (f) {
        var polys = parts(f.geometry).polygons;
        if (!polys.length) return;
        var bb = bboxOf(f.geometry), n = 0, sum = 0, nv = 0;
        var x0 = Math.max(0, Math.floor((bb[0] - gb[0]) / cw)), x1 = Math.min(cells - 1, Math.floor((bb[2] - gb[0]) / cw));
        var y0 = Math.max(0, Math.floor((bb[1] - gb[1]) / ch)), y1 = Math.min(cells - 1, Math.floor((bb[3] - gb[1]) / ch));
        for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
          (grid.get(x + "," + y) || []).forEach(function (i) {
            var p = pts[i];
            if (p[0] < bb[0] || p[0] > bb[2] || p[1] < bb[1] || p[1] > bb[3] || !inAny(p, polys)) return;
            n++;
            if (vals[i] != null) { sum += vals[i]; nv++; }
          });
        }
        inside += n;
        var props = copyProps(f), km2 = geometryArea(f.geometry) / 1e6;
        props.n_titik = n;
        props.per_km2 = km2 ? round(n / km2, 6) : null;
        if (field) {
          props["total_" + field] = nv ? sum : null;
          props["rerata_" + field] = nv ? sum / nv : null;
        }
        out.push({ type: "Feature", properties: props, geometry: f.geometry });
      });
      var counts = describe(out.map(function (f) { return f.properties.n_titik; }));
      delete counts.sorted;
      return {
        features: out,
        report: { op: "count", polygons: out.length, points: pts.length, inside: inside, field: field, counts: counts, swapped: swapped,
          empty: out.filter(function (f) { return !f.properties.n_titik; }).length },
      };
    },

    // Mean centre, standard distance and nearest-neighbour index of points
    // (of feature centroids, for lines and polygons).
    pattern: function (layers, o) {
      var fs = layers.a.filter(function (f) { return f.geometry; });
      var pts = fs.map(function (f) { return centroid(f.geometry); });
      var w = null;
      if (o.weightField) {
        w = fs.map(function (f) { var x = numberOf((f.properties || {})[o.weightField]); return x != null && x > 0 ? x : 0; });
        if (!w.some(function (x) { return x > 0; })) fail("The weight field has no positive values.");
      }
      var nn = nearestNeighbour(pts), mc = meanCenter(pts, w), ss = 0, sw = 0;
      pts.forEach(function (p, i) {
        var wi = w ? w[i] : 1, d = distance(mc, p);
        ss += wi * d * d; sw += wi;
      });
      var sd = Math.sqrt(ss / sw);
      var proj = aeqd(mc[0], mc[1]);
      var ring = circle([0, 0], sd, 128).map(proj.inverse);
      var features = [
        { type: "Feature", properties: { jenis: "pusat_rerata", jarak_m: null }, geometry: { type: "Point", coordinates: mc } },
        { type: "Feature", properties: { jenis: "jarak_standar", jarak_m: round(sd, 1) }, geometry: { type: "Polygon", coordinates: [ring] } },
      ];
      delete nn.hull;
      return { features: features, report: { op: "pattern", n: pts.length, weightField: o.weightField || "", meanCenter: mc, standardDistance: sd, nn: nn } };
    },

    moran: function (layers, o) {
      if (!o.field) fail("Choose a numeric field.");
      var v = valued(layers.a, o.field), W = weights(v.features, o);
      var res = moran(v.values, W, { permutations: o.permutations, seed: o.seed });
      return { report: { op: "moran", field: o.field, missing: layers.a.length - v.values.length, weights: summaryOf(W), result: res } };
    },

    hotspot: function (layers, o) {
      if (!o.field) fail("Choose a numeric field.");
      var v = valued(layers.a, o.field), W = weights(v.features, o);
      var res = getisOrd(v.values, W), bins = {};
      var out = v.features.map(function (f, i) {
        var p = copyProps(f), r = res[i];
        p.gi_z = round(r.z, 4);
        p.gi_p = round(r.p, 6);
        p.gi_bin = r.bin;
        bins[r.bin] = (bins[r.bin] || 0) + 1;
        return { type: "Feature", properties: p, geometry: f.geometry };
      });
      return { features: out, report: { op: "hotspot", field: o.field, n: v.values.length, missing: layers.a.length - v.values.length, weights: summaryOf(W), bins: bins } };
    },
  };

  function summaryOf(W) {
    return { method: W.method, min: W.min, max: W.max, mean: W.mean, fallback: W.fallback };
  }

  function cut(layers, keepInside, op) {
    var b = layers.b || [];
    needPolygons(b, "overlay");
    var bPolys = [], bBoxes = [];
    b.forEach(function (f) {
      parts(f.geometry).polygons.forEach(function (p) {
        bPolys.push(p);
        bBoxes.push(bboxOf({ type: "Polygon", coordinates: p }));
      });
    });
    var out = [], failed = 0, removed = 0;
    layers.a.forEach(function (f) {
      if (!f.geometry) return;
      var bb = bboxOf(f.geometry), near = bPolys.filter(function (p, j) { return bboxHit(bb, bBoxes[j]); });
      var g;
      if (!near.length) g = keepInside ? null : f.geometry;
      else {
        try { g = cutGeometry(f.geometry, near, keepInside); } catch (e) { failed++; return; }
      }
      if (!g) { removed++; return; }
      out.push({ type: "Feature", properties: measured(copyProps(f), g), geometry: g });
    });
    return { features: out, report: { op: op, count: out.length, input: layers.a.length, removed: removed, failed: failed } };
  }

  // Runs one analysis. layers: { a: [features], b: [features] } in WGS 84.
  // Returns { report, features? }: features is the result layer, if any.
  function run(op, layers, opts) {
    if (!OPS[op]) fail("Unknown analysis: " + op);
    if (!layers || !layers.a || !layers.a.length) fail("Choose a file first.");
    return OPS[op](layers, opts || {});
  }

  return {
    run: run,
    OPS: Object.keys(OPS),
    ringArea: ringArea,
    geometryArea: geometryArea,
    geometryLength: geometryLength,
    geometryPerimeter: geometryPerimeter,
    distance: distance,
    haversine: haversine,
    centroid: centroid,
    interiorPoint: interiorPoint,
    convexHull: convexHull,
    describe: describe,
    quantile: quantile,
    histogram: histogram,
    weights: weights,
    moran: moran,
    getisOrd: getisOrd,
    meanCenter: meanCenter,
    nearestNeighbour: nearestNeighbour,
    bufferGeometry: bufferGeometry,
    cutLine: cutLine,
    inPolygon: inPolygon,
    kinds: kinds,
    kindOf: kindOf,
    pTwoSided: pTwoSided,
    chordToMetres: chordToMetres,
  };
});
