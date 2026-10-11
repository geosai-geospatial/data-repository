"use strict";

// Checks geostats.js (analisis-spasial.html). Moran's I, Gi* and the k-nearest
// neighbours are compared with PySAL (esda 2.10, libpysal 4.15) on the same
// data; measurements with the ellipsoid formulas and published values.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const GS = require("../public/assets/js/geostats");
const GC = require("../public/assets/js/geoconvert");

// PySAL reference: a 7×7 grid of 0.01° squares with a trend plus noise (queen
// contiguity, row-standardised for Moran, binary for Gi*), and 60 random
// points (5 nearest neighbours, row-standardised).
const GRID_VALUES = [0.002,1.597,1.452,1.219,3.091,3.017,6.12,3.68,1.016,1.759,4.98,5.714,6.211,5.139,1.941,4.391,1.312,4.085,2.198,4.421,4.317,2.53,1.465,5.543,6.314,6.626,2.966,7.923,3.903,5.227,2.94,6.044,6.043,7.382,12.122,3.385,5.935,8.769,6.833,8.777,10.221,11.128,3.55,7.152,10.718,5.906,11.719,11.239,10.717];
const GRID_MORAN = {"I":0.624249233113773,"EI":-0.020833333333333332,"VI":0.005978483898095934,"z":8.342952542244294,"p":7.24582504192022e-17};
const GRID_GI = [-2.454597992,-3.0666893842,-2.722423745,-1.8755056529,-1.052523392,-0.360435933,-0.1306432521,-2.6398109337,-3.5594651875,-3.0197704687,-2.5567283788,-1.5000336772,-0.8872758029,-0.3695999369,-2.312095212,-2.8083388967,-1.9714126088,-1.0837705332,-0.5066758156,-0.2750968759,-0.1299680736,-1.7056296403,-2.1581810237,-1.2238757917,-0.7857284378,-0.2097916149,0.7071451966,0.985304879,-1.2969424214,-0.9487600113,0.1365346893,1.1576820237,1.5417556951,2.9291451226,2.7101892555,-0.3795845979,0.4270504691,1.3469978069,2.2993661962,3.0421556451,4.800302955,4.2238912137,-0.206787485,1.0370062742,1.8308552093,2.8442299096,3.1140893081,4.3595731819,3.6058279469];
const POINTS = [[110.18063,-0.70091],[110.02963,-0.80618],[110.16152,-0.9249],[110.40817,-0.81028],[110.48937,-0.705],[110.30253,-0.681],[110.33823,-0.92461],[110.22016,-0.88022],[110.20125,-0.95165],[110.48391,-0.8925],[110.33588,-0.84979],[110.43704,-0.66889],[110.06581,-0.57746],[110.47247,-0.54804],[110.28486,-0.92727],[110.09623,-0.53605],[110.27616,-0.90972],[110.44203,-0.67921],[110.28485,-0.81186],[110.20548,-0.88026],[110.01903,-0.56189],[110.23387,-0.72618],[110.16108,-0.62434],[110.0126,-0.81391],[110.01518,-0.93855],[110.48357,-0.67112],[110.21411,-0.73813],[110.4364,-0.82789],[110.29515,-0.65816],[110.17771,-0.74045],[110.38262,-0.54541],[110.07553,-0.53329],[110.00259,-0.62351],[110.40526,-0.93162],[110.20945,-0.59237],[110.00714,-0.68577],[110.39651,-0.7435],[110.36292,-0.88679],[110.09926,-0.81844],[110.0897,-0.82697],[110.47406,-0.71333],[110.17003,-0.86424],[110.47602,-0.77776],[110.4902,-0.74224],[110.26058,-0.55173],[110.37138,-0.70967],[110.21332,-0.56091],[110.20582,-0.53862],[110.03436,-0.785],[110.25976,-0.52453],[110.1255,-0.59698],[110.33824,-0.64146],[110.31481,-0.51422],[110.16634,-0.80086],[110.10146,-0.97465],[110.10645,-0.54227],[110.42008,-0.9438],[110.30189,-0.7604],[110.29734,-0.67036],[110.15333,-0.51932]];
const POINT_VALUES = [1102.174,1100.285,1101.651,1103.706,1105.121,1102.756,1103.311,1101.647,1101.404,1105.507,1103.105,1104.516,1100.641,1104.504,1102.595,1101.277,1102.611,1104.345,1102.86,1102.643,1100.531,1102.53,1101.329,1099.435,1100.627,1105.319,1102.071,1104.635,1103.342,1102.193,1104.287,1100.527,1100.783,1103.429,1102.525,1100.318,1104.402,1104.569,1101.735,1100.324,1103.896,1102.109,1104.253,1104.896,1103.026,1102.892,1101.078,1102.188,1100.366,1102.475,1101.274,1102.952,1102.391,1101.58,1100.529,1100.243,1104.454,1102.988,1103.177,1101.039];
const POINT_MORAN = {"I":0.828553884815815,"VI":0.005506450867079597,"z":11.394080615445098};

function feature(geometry, properties) {
  return { type: "Feature", properties: properties || {}, geometry };
}
function square(x0, y0, size) {
  return { type: "Polygon", coordinates: [[[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]]] };
}
function gridFeatures() {
  const out = [];
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) out.push(feature(square(110 + c * 0.01, -1 + r * 0.01, 0.01), { v: GRID_VALUES[r * 7 + c] }));
  return out;
}
function close(actual, expected, tol, what) {
  assert.ok(Math.abs(actual - expected) <= tol, (what || "") + ": " + actual + " is not within " + tol + " of " + expected);
}

// Area of a longitude/latitude cell on the WGS 84 ellipsoid by numerical
// integration of M·N·cos φ, independent of the projection geostats.js uses.
function cellArea(lat0, lat1, dLon) {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), n = 2000, h = (lat1 - lat0) / n;
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const phi = (lat0 + i * h) * Math.PI / 180, w = 1 - e2 * Math.sin(phi) ** 2;
    const y = a * a * (1 - e2) * Math.cos(phi) / (w * w);
    s += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * y;
  }
  return s * h / 3 * Math.PI / 180 * dLon * Math.PI / 180;
}

test("polygon areas are ellipsoidal", () => {
  close(GS.geometryArea(square(0, 0, 1)), cellArea(0, 1, 1), 1, "1° cell at the equator");
  close(GS.geometryArea(square(100, -60, 2)), cellArea(-60, -58, 2), 1, "2° cell at 60° S");
  close(GS.geometryArea(square(0, 0, 1)) / 1e6, 12308.5, 0.5, "km²");
  // A hole is subtracted; winding does not matter.
  const holed = { type: "Polygon", coordinates: [square(0, 0, 1).coordinates[0].slice().reverse(), square(0.25, 0.25, 0.5).coordinates[0]] };
  close(GS.geometryArea(holed), cellArea(0, 1, 1) - cellArea(0.25, 0.75, 0.5), 1, "holed");
  const multi = { type: "MultiPolygon", coordinates: [square(0, 0, 1).coordinates, square(5, 0, 1).coordinates] };
  close(GS.geometryArea(multi), 2 * cellArea(0, 1, 1), 2, "multi");
});

test("distances use Vincenty's formula", () => {
  // Geoscience Australia's example: Flinders Peak to Buninyong, 54 972.271 m.
  const flinders = [144 + 25 / 60 + 29.5244 / 3600, -(37 + 57 / 60 + 3.7203 / 3600)];
  const buninyong = [143 + 55 / 60 + 35.3839 / 3600, -(37 + 39 / 60 + 10.1561 / 3600)];
  close(GS.distance(flinders, buninyong), 54972.271, 0.001, "Flinders–Buninyong");
  close(GS.distance([0, 0], [1, 0]), 111319.491, 0.001, "1° of the equator");
  assert.equal(GS.distance([10, 10], [10, 10]), 0);
  // Nearly antipodal points fall back to the sphere instead of failing.
  assert.ok(GS.distance([0, 0], [179.9, 0.5]) > 19.9e6);
  close(GS.geometryLength({ type: "LineString", coordinates: [[0, 0], [1, 0], [2, 0]] }), 2 * 111319.491, 0.01, "line");
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  const sides = corners.slice(1).reduce((s, p, i) => s + GS.distance(corners[i], p), 0);
  close(GS.geometryPerimeter(square(0, 0, 1)), sides, 1e-6, "perimeter");
  assert.ok(GS.distance([0, 1], [1, 1]) < 111319.491, "a degree of longitude is shorter away from the equator");
});

test("descriptive statistics", () => {
  const s = GS.describe([4, "3", 1, 2, null, "", "abc"]);
  assert.equal(s.n, 4);
  assert.equal(s.missing, 3);
  assert.equal(s.sum, 10);
  assert.equal(s.mean, 2.5);
  assert.equal(s.median, 2.5);
  assert.equal(s.q1, 1.75);
  assert.equal(s.q3, 3.25);
  close(s.std, Math.sqrt(5 / 3), 1e-12, "sample standard deviation");
  const h = GS.histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 10]);
  assert.equal(h.reduce((n, b) => n + b.count, 0), 10);
  assert.equal(h[0].from, 0);
  assert.equal(h[h.length - 1].to, 10);
  assert.equal(h.length, 5, "Sturges: 5 bins for 10 values");
  assert.equal(h[h.length - 1].count, 2, "the last bin holds 8 and the maximum");
  assert.deepEqual(GS.histogram([5, 5, 5]), [{ from: 5, to: 5, count: 3 }]);
});

test("attribute statistics: numbers by group, text as frequencies with area", () => {
  const fs = [
    feature(square(0, 0, 1), { v: 1, k: "a" }), feature(square(1, 0, 1), { v: 3, k: "a" }),
    feature(square(2, 0, 2), { v: 10, k: "b" }), feature(square(4, 0, 1), { v: null, k: null }),
  ];
  const num = GS.run("describe", { a: fs }, { field: "v", groupBy: "k" }).report;
  assert.equal(num.numeric, true);
  assert.equal(num.stats.n, 3);
  assert.equal(num.stats.missing, 1);
  assert.deepEqual(num.groups.map((g) => [g.key, g.count, g.sum]), [["a", 2, 4], ["b", 1, 10], [null, 1, undefined]]);
  const text = GS.run("describe", { a: fs }, { field: "k" }).report;
  assert.equal(text.numeric, false);
  assert.equal(text.distinct, 3);
  const b = text.categories.find((c) => c.key === "b");
  close(b.size, GS.geometryArea(square(2, 0, 2)), 1e-6, "area of b");
  close(text.categories.reduce((s, c) => s + c.sizeShare, 0), 1, 1e-12, "area shares");
});

test("queen contiguity, k nearest neighbours and distance bands", () => {
  const W = GS.weights(gridFeatures(), { method: "contiguity" });
  assert.equal(W.neighbours[0].length, 3, "corner");
  assert.equal(W.neighbours[3].length, 5, "edge");
  assert.equal(W.neighbours[24].length, 8, "centre");
  assert.deepEqual(W.neighbours[24], [16, 17, 18, 23, 25, 30, 31, 32]);
  assert.equal(W.fallback, 0);
  // An island gets its nearest neighbour.
  const withIsland = gridFeatures().concat([feature(square(111, -1, 0.01), { v: 1 })]);
  const Wi = GS.weights(withIsland, { method: "contiguity" });
  assert.equal(Wi.fallback, 1);
  assert.deepEqual(Wi.neighbours[49], [6]);

  const pts = POINTS.map((p) => feature({ type: "Point", coordinates: p }));
  const K = GS.weights(pts, { method: "knn", k: 5 });
  // Same neighbours as libpysal.weights.KNN on these coordinates, checked by brute force here.
  K.neighbours.forEach((list, i) => {
    const brute = POINTS.map((p, j) => [j, GS.haversine(POINTS[i], p)]).filter((x) => x[0] !== i)
      .sort((a, b) => a[1] - b[1]).slice(0, 5).map((x) => x[0]).sort((a, b) => a - b);
    assert.deepEqual(list, brute, "point " + i);
  });
  const D = GS.weights(pts, { method: "distance", distance: 5000 });
  D.neighbours.forEach((list, i) => {
    if (D.fallback && list.length === 1 && GS.haversine(POINTS[i], POINTS[list[0]]) > 5000) return; // fallback
    list.forEach((j) => assert.ok(GS.haversine(POINTS[i], POINTS[j]) <= 5000));
    POINTS.forEach((p, j) => {
      if (j !== i && GS.haversine(POINTS[i], p) < 4999) assert.ok(list.includes(j), i + " misses " + j);
    });
  });
  assert.throws(() => GS.weights(pts, { method: "distance", distance: 0 }), /greater than 0/);
});

test("Moran's I matches PySAL", () => {
  const W = GS.weights(gridFeatures(), { method: "contiguity" });
  const m = GS.moran(GRID_VALUES, W, { permutations: 0 });
  close(m.I, GRID_MORAN.I, 1e-12, "I");
  close(m.expected, GRID_MORAN.EI, 1e-15, "E[I]");
  close(m.variance, GRID_MORAN.VI, 1e-14, "variance (randomisation)");
  close(m.z, GRID_MORAN.z, 1e-9, "z");
  close(m.p, GRID_MORAN.p, 1e-17, "p");

  // k nearest neighbours are not symmetric, which S1 and S2 must handle.
  const pts = POINTS.map((p) => feature({ type: "Point", coordinates: p }));
  const K = GS.weights(pts, { method: "knn", k: 5 });
  const mk = GS.moran(POINT_VALUES, K, { permutations: 0 });
  close(mk.I, POINT_MORAN.I, 1e-12, "kNN I");
  close(mk.variance, POINT_MORAN.VI, 1e-14, "kNN variance");
  close(mk.z, POINT_MORAN.z, 1e-9, "kNN z");

  // The permutation distribution agrees with the analytical variance, and the
  // seeded test gives the same pseudo p-value every time.
  const perm = GS.moran(POINT_VALUES, K, { permutations: 4999 });
  close(perm.permVariance / perm.variance, 1, 0.1, "permutation variance");
  close(perm.permMean, perm.expected, 0.01, "permutation mean");
  assert.equal(perm.pseudoP, 1 / 5000);
  assert.equal(GS.moran(POINT_VALUES, K, { permutations: 99, seed: 7 }).pseudoP, GS.moran(POINT_VALUES, K, { permutations: 99, seed: 7 }).pseudoP);

  // Alternating columns are negatively autocorrelated (with queen contiguity a
  // checkerboard is not: its diagonal neighbours share the colour).
  const stripes = GRID_VALUES.map((_, i) => (i % 7) % 2);
  const neg = GS.moran(stripes, W, { permutations: 0 });
  assert.ok(neg.I < -0.4 && neg.p < 0.001, "stripes: I = " + neg.I);
  assert.throws(() => GS.moran([1, 1, 1, 1], GS.weights(gridFeatures().slice(0, 4), { method: "knn", k: 2 })), /All values are the same/);
});

test("Getis-Ord Gi* matches PySAL", () => {
  const W = GS.weights(gridFeatures(), { method: "contiguity" });
  const g = GS.getisOrd(GRID_VALUES, W);
  g.forEach((x, i) => close(x.z, GRID_GI[i], 1e-9, "Gi* " + i));
  // The high values (top right) are hot, the low ones (bottom left) cold.
  assert.ok(g[48].bin > 0 && g[0].bin < 0);
  g.forEach((x) => {
    const p = GS.pTwoSided(x.z);
    close(x.p, p, 1e-15);
    assert.equal(Math.abs(x.bin), p < 0.01 ? 3 : p < 0.05 ? 2 : p < 0.1 ? 1 : 0);
  });
  // The hot spot tool returns every feature with its class.
  const res = GS.run("hotspot", { a: gridFeatures() }, { field: "v", method: "contiguity" });
  assert.equal(res.features.length, 49);
  assert.equal(res.features[48].properties.gi_bin, g[48].bin);
  assert.equal(Object.values(res.report.bins).reduce((a, b) => a + b, 0), 49);
});

test("normal p-values", () => {
  close(GS.pTwoSided(1.959964), 0.05, 1e-6);
  close(GS.pTwoSided(2.575829), 0.01, 1e-7);
  close(GS.pTwoSided(0), 1, 1e-7);
  close(GS.pTwoSided(-6) / 1.973175e-9, 1, 1e-4, "tail keeps relative precision");
});

test("point patterns: nearest-neighbour index, mean centre, standard distance", () => {
  const lattice = [], cluster = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) lattice.push([110 + i * 0.01, j * 0.01]);
  for (let i = 0; i < 50; i++) cluster.push([110 + (i % 5) * 0.0005, Math.floor(i / 5) * 0.0005], [110.2 + (i % 5) * 0.0005, 0.2 + Math.floor(i / 5) * 0.0005]);
  const reg = GS.nearestNeighbour(lattice);
  assert.ok(reg.ratio > 1.8, "a lattice is dispersed: R = " + reg.ratio);
  assert.ok(reg.p < 0.001);
  close(reg.observed, GS.distance([110, 0], [110, 0.01]), 1, "lattice spacing");
  const cl = GS.nearestNeighbour(cluster);
  assert.ok(cl.ratio < 0.5 && cl.z < 0 && cl.p < 0.001, "two tight clusters: R = " + cl.ratio);
  assert.throws(() => GS.nearestNeighbour([[0, 0], [1, 1], [2, 2]]), /one line/);

  const c = GS.meanCenter([[179, 0], [-179, 0]]);
  close(Math.abs(c[0]), 180, 1e-9, "across the antimeridian");
  const w = GS.meanCenter([[0, 0], [10, 0]], [3, 1]);
  assert.ok(w[0] > 0 && w[0] < 5, "weighted towards the heavier point");

  const res = GS.run("pattern", { a: lattice.map((p) => feature({ type: "Point", coordinates: p })) }, {});
  const sd = res.report.standardDistance;
  close(res.report.meanCenter[0], 110.045, 1e-6);
  close(res.report.meanCenter[1], 0.045, 1e-6);
  // The standard-distance circle has that radius.
  const ring = res.features[1].geometry.coordinates[0];
  ring.forEach((p) => close(GS.distance(res.report.meanCenter, p), sd, sd * 0.004, "circle radius"));
});

test("buffers have the right size", () => {
  const pt = GS.bufferGeometry({ type: "Point", coordinates: [106.8, -6.2] }, 1000);
  close(GS.geometryArea({ type: "MultiPolygon", coordinates: pt }) / (Math.PI * 1e6), 1, 0.005, "point buffer");
  // Every vertex lies at the buffer distance (within the ±0.3 % of the local sphere).
  pt[0][0].forEach((p) => close(GS.distance([106.8, -6.2], p), 1000, 3.5));

  const sq = square(110, 0, 0.1), A = GS.geometryArea(sq), P = GS.geometryPerimeter(sq), d = 1000;
  const grow = GS.bufferGeometry(sq, d), shrink = GS.bufferGeometry(sq, -d);
  // Minkowski sum of a convex polygon and a disc: A + P·d + π·d².
  close(GS.geometryArea({ type: "MultiPolygon", coordinates: grow }) / (A + P * d + Math.PI * d * d), 1, 0.004, "grown square");
  close(GS.geometryArea({ type: "MultiPolygon", coordinates: shrink }) / (A - P * d + 4 * d * d), 1, 0.004, "shrunk square");
  assert.deepEqual(GS.bufferGeometry(square(110, 0, 0.001), -1000), [], "shrunk away");

  const line = { type: "LineString", coordinates: [[110, 0], [110.1, 0]] };
  const L = GS.geometryLength(line);
  close(GS.geometryArea({ type: "MultiPolygon", coordinates: GS.bufferGeometry(line, 500) }) / (2 * 500 * L + Math.PI * 500 * 500), 1, 0.004, "line buffer");

  const fs = [feature({ type: "Point", coordinates: [110, 0] }, { id: 1 }), feature({ type: "Point", coordinates: [110.005, 0] }, { id: 2 })];
  const one = GS.run("buffer", { a: fs }, { distance: 1000, dissolve: true });
  assert.equal(one.features.length, 1);
  assert.equal(one.features[0].properties.jumlah, 2);
  assert.ok(one.report.area < 2 * Math.PI * 1e6, "overlap counted once");
  const two = GS.run("buffer", { a: fs }, { distance: 1000 });
  assert.equal(two.features.length, 2);
  assert.equal(two.features[0].properties.id, 1);
  assert.equal(two.features[0].properties.jarak_m, 1000);
  assert.ok(two.features[0].properties.luas_ha > 300 && two.features[0].properties.luas_ha < 315);
  assert.throws(() => GS.run("buffer", { a: fs }, { distance: -10 }), /no polygons/);
  assert.throws(() => GS.run("buffer", { a: fs }, { distance: 0 }), /buffer distance/);
});

test("centroids, interior points and envelopes", () => {
  close(GS.centroid(square(110, 0, 0.1))[0], 110.05, 1e-9);
  close(GS.centroid(square(110, 0, 0.1))[1], 0.05, 1e-9);
  // A C shape: its centroid falls in the gap, the interior point does not.
  const c = { type: "Polygon", coordinates: [[[0, 0], [3, 0], [3, 1], [1, 1], [1, 2], [3, 2], [3, 3], [0, 3], [0, 0]]] };
  const cen = GS.centroid(c), inner = GS.interiorPoint(c);
  assert.ok(!GS.inPolygon(cen, c.coordinates), "centroid outside");
  assert.ok(GS.inPolygon(inner, c.coordinates), "interior point inside");
  const res = GS.run("centroid", { a: [feature(c, { n: 1 })] }, { inside: true });
  assert.deepEqual(res.features[0].geometry.coordinates, inner);
  assert.equal(res.features[0].properties.n, 1);

  const pts = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]].map((p) => feature({ type: "Point", coordinates: p }));
  const hull = GS.run("envelope", { a: pts }, { shape: "hull" });
  assert.equal(hull.features.length, 1);
  assert.equal(hull.features[0].geometry.coordinates[0].length, 5, "the inner point is not on the hull");
  close(hull.report.area, cellArea(0, 1, 1), 1);
  assert.equal(hull.features[0].properties.jumlah, 5);
  const boxes = GS.run("envelope", { a: [feature(c)] }, { shape: "bbox", per: "feature" });
  close(boxes.report.area, cellArea(0, 3, 3), 10);
});

test("dissolve unions polygons by value", () => {
  const fs = [
    feature(square(0, 0, 1), { k: "a", v: 1 }), feature(square(1, 0, 1), { k: "a", v: 2 }),
    feature(square(5, 0, 1), { k: "b", v: 5 }),
  ];
  const res = GS.run("dissolve", { a: fs }, { field: "k", sumField: "v" });
  assert.equal(res.features.length, 2);
  const a = res.features.find((f) => f.properties.k === "a");
  assert.equal(a.geometry.type, "Polygon", "adjacent squares become one polygon");
  assert.equal(a.geometry.coordinates[0].length, 5, "the shared edge is gone");
  assert.equal(a.properties.jumlah, 2);
  assert.equal(a.properties.total_v, 3);
  close(a.properties.luas_ha * 1e4, 2 * cellArea(0, 1, 1), 1);
  const all = GS.run("dissolve", { a: fs }, {});
  assert.equal(all.features.length, 1);
  assert.equal(all.features[0].geometry.type, "MultiPolygon");
});

test("clip, erase and intersect", () => {
  const zone = feature(square(0, 0, 1), { zona: "Z", v: 9 });
  const line = feature({ type: "LineString", coordinates: [[-1, 0.5], [2, 0.5]] }, { nama: "jalan" });
  const pts = [feature({ type: "Point", coordinates: [0.5, 0.5] }, { nama: "in" }), feature({ type: "Point", coordinates: [3, 3] }, { nama: "out" })];
  const poly = feature(square(0.5, 0.5, 1), { nama: "petak", v: 1 });
  const layers = { a: [line, poly].concat(pts), b: [zone] };

  const clip = GS.run("clip", layers);
  const cl = clip.features.find((f) => f.properties.nama === "jalan");
  close(GS.geometryLength(cl.geometry), GS.distance([0, 0.5], [1, 0.5]), 0.01, "clipped line");
  assert.deepEqual(clip.features.filter((f) => f.geometry.type === "Point").map((f) => f.properties.nama), ["in"]);
  const cp = clip.features.find((f) => f.properties.nama === "petak");
  close(GS.geometryArea(cp.geometry), cellArea(0.5, 1, 0.5), 1, "clipped polygon");
  assert.equal(clip.report.removed, 1);

  const erase = GS.run("erase", layers);
  const el = erase.features.find((f) => f.properties.nama === "jalan");
  assert.equal(el.geometry.type, "MultiLineString", "two pieces outside");
  close(GS.geometryLength(el.geometry) + GS.geometryLength(cl.geometry), GS.geometryLength(line.geometry), 0.01, "clip + erase = whole");
  const ep = erase.features.find((f) => f.properties.nama === "petak");
  close(GS.geometryArea(ep.geometry) + GS.geometryArea(cp.geometry), GS.geometryArea(poly.geometry), 1, "polygon parts");

  const inter = GS.run("intersect", layers);
  const ip = inter.features.find((f) => f.properties.nama === "petak");
  assert.equal(ip.properties.zona, "Z");
  assert.equal(ip.properties.v, 1, "the input keeps its own value");
  assert.equal(ip.properties.v_2, 9, "a clashing name gets a suffix");
  assert.equal(inter.features.length, 3);
  assert.throws(() => GS.run("clip", { a: [line], b: pts }), /overlay layer has no polygons/);
});

test("counting points in polygons works with the layers either way round", () => {
  const zones = [feature(square(0, 0, 1), { nama: "A" }), feature(square(1, 0, 1), { nama: "B" })];
  const pts = [[0.2, 0.2], [0.5, 0.5], [1.5, 0.5], [5, 5]].map((p, i) => feature({ type: "Point", coordinates: p }, { n: i + 1 }));
  const res = GS.run("count", { a: zones, b: pts }, { field: "n" });
  assert.deepEqual(res.features.map((f) => [f.properties.nama, f.properties.n_titik, f.properties.total_n, f.properties.rerata_n]), [["A", 2, 3, 1.5], ["B", 1, 3, 3]]);
  close(res.features[0].properties.per_km2, 2 / (cellArea(0, 1, 1) / 1e6), 1e-6);
  assert.equal(res.report.inside, 3);
  assert.equal(res.report.points, 4);
  const swapped = GS.run("count", { a: pts, b: zones }, { field: "n" });
  assert.equal(swapped.report.swapped, true);
  assert.deepEqual(swapped.features.map((f) => f.properties.n_titik), [2, 1]);
});

test("measure adds area, perimeter, length and coordinates", () => {
  const res = GS.run("measure", { a: [
    feature(square(0, 0, 1)), feature({ type: "LineString", coordinates: [[0, 0], [1, 0]] }), feature({ type: "Point", coordinates: [106.8, -6.2] }),
  ] });
  close(res.features[0].properties.luas_ha, cellArea(0, 1, 1) / 1e4, 0.0001);
  close(res.features[0].properties.kelilingkm, GS.geometryPerimeter(square(0, 0, 1)) / 1000, 0.0001);
  close(res.features[1].properties.panjang_km, 111.3195, 0.0001);
  assert.equal(res.features[2].properties.bujur, 106.8);
  assert.equal(res.features[2].properties.lintang, -6.2);
  close(res.report.total.area, cellArea(0, 1, 1), 1);
});

test("errors are clear", () => {
  assert.throws(() => GS.run("nope", { a: [feature(square(0, 0, 1))] }), /Unknown analysis/);
  assert.throws(() => GS.run("describe", { a: [] }, { field: "x" }), /Choose a file/);
  assert.throws(() => GS.run("moran", { a: gridFeatures() }, {}), /numeric field/);
  assert.throws(() => GS.run("moran", { a: gridFeatures().slice(0, 3) }, { field: "v" }), /At least 4/);
});

test("results can be written by the converter", async () => {
  const res = GS.run("hotspot", { a: gridFeatures() }, { field: "v", method: "knn", k: 8 });
  const data = GC.fromGeoJSON({ type: "FeatureCollection", features: res.features });
  assert.deepEqual(data.fields.map((f) => f.name), ["v", "gi_z", "gi_p", "gi_bin"]);
  const out = await GC.write(data, "shp", "hotspot");
  assert.equal(out.filename, "hotspot.zip");
  const pattern = GS.run("pattern", { a: gridFeatures() }, {});
  const mixed = await GC.write(GC.fromGeoJSON({ type: "FeatureCollection", features: pattern.features }), "shp", "pola");
  assert.ok(mixed.warnings.some((w) => w.code === "split"), "point and circle go in separate shapefiles");
});

test("the sample layers fit together", () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "data", f), "utf8"));
  const cities = read("contoh-kota.geojson").features, islands = read("contoh-pulau.geojson").features;
  assert.deepEqual(islands.map((f) => f.properties.pulau), ["Sumatra", "Jawa", "Kalimantan", "Sulawesi", "Bali & Nusa Tenggara", "Maluku", "Papua"]);
  // Areas near the official land areas (BPS), at basemap precision.
  const km2 = Object.fromEntries(islands.map((f) => [f.properties.pulau, GS.geometryArea(f.geometry) / 1e6]));
  close(km2.Jawa, 129000, 5000, "Jawa");
  close(km2.Sulawesi, 188000, 6000, "Sulawesi");
  // Every city that falls on land falls in its own region.
  const res = GS.run("count", { a: cities, b: islands }, { field: "penduduk_ribu" });
  res.features.forEach((f) => {
    const own = cities.filter((c) => c.properties.pulau === f.properties.pulau &&
      f.geometry.coordinates.some((poly) => GS.inPolygon(c.geometry.coordinates, poly)));
    assert.equal(f.properties.n_titik, own.length, f.properties.pulau);
  });
  assert.ok(res.report.inside >= 34, "most coastal cities are on the simplified coast");
});
