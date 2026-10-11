"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pathToFileURL } = require("url");
const PG = require("../public/assets/js/pdfgeo");
const GT = require("../public/assets/js/geotiff");

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || "") + ` ${a} ≉ ${b} (±${tol})`);

// ---------- Typed coordinates ----------
test("parses degrees as people type them", () => {
  near(PG.parseDegrees("-8.25"), -8.25, 1e-12);
  near(PG.parseDegrees("8,25"), 8.25, 1e-12);
  near(PG.parseDegrees("8°15'30\" LS"), -(8 + 15 / 60 + 30 / 3600), 1e-12);
  near(PG.parseDegrees("115 15 BT"), 115.25, 1e-12);
  near(PG.parseDegrees("115°BT"), 115, 1e-12);
  near(PG.parseDegrees("6° 30′ S"), -6.5, 1e-12);
  near(PG.parseDegrees("3 LU"), 3, 1e-12);
  assert.ok(Number.isNaN(PG.parseDegrees("abc")));
  assert.ok(Number.isNaN(PG.parseDegrees("")));
});

test("parses map coordinates with thousands separators", () => {
  assert.equal(PG.parseNumber("9.110.000"), 9110000);
  assert.equal(PG.parseNumber("230,000"), 230000);
  assert.equal(PG.parseNumber("9 110 000"), 9110000);
  assert.equal(PG.parseNumber("230000.5"), 230000.5);
  assert.equal(PG.parseNumber("1.234.567,8"), 1234567.8);
  assert.ok(Number.isNaN(PG.parseNumber("x")));
});

test("reads the coordinate system from the map's notes", () => {
  assert.equal(PG.detectCrs("UTM : Zona 50 S Interval Antar Grid 30.000 Meter").epsg, 32750);
  assert.equal(PG.detectCrs("Proyeksi UTM zone 49N, WGS 84").epsg, 32649);
  assert.equal(PG.detectCrs("Sistem Grid UTM Zona 48 M").epsg, 32748); // band M is south
  assert.equal(PG.detectCrs("EPSG:32651").epsg, 32651);
  assert.equal(PG.detectCrs("Skala 1 : 50.000"), null);
});

// ---------- Fitting ----------
// A map in UTM at 1 : 200 000 (72 m per point), rotated a little.
const TRUE = [70, 5, -5, 70, 200000, 9000000];
function gcp(px, py) { const p = PG.apply(TRUE, px, py); return { px, py, x: p[0], y: p[1] }; }

test("fits 2 points exactly (scale, rotation, shift)", () => {
  const f = PG.fit([gcp(100, 100), gcp(900, 500)]);
  assert.equal(f.kind, "similarity");
  TRUE.forEach((v, i) => near(f.m[i], v, 1e-6, "m[" + i + "]"));
});

test("fits 3+ points by least squares and reports the error", () => {
  const pts = [gcp(100, 100), gcp(900, 120), gcp(500, 700), gcp(120, 650)];
  pts[3].x += 30; // one point typed 30 m off
  const f = PG.fit(pts);
  assert.equal(f.kind, "affine");
  assert.ok(f.rmse > 5 && f.rmse < 30);
  assert.equal(f.residuals.indexOf(Math.max(...f.residuals)), 3);
  assert.equal(PG.fit([gcp(0, 0), gcp(10, 10), gcp(20, 20)]), null, "points on one line");
});

test("fits one point from the grid spacing, north up", () => {
  const f = PG.fit([{ px: 100, py: 100, x: 230000, y: 9110000 }], { lattice: { x: 400, y: 400 }, interval: 30000 });
  const p = PG.apply(f.m, 500, 500);
  near(p[0], 260000, 1e-6); near(p[1], 9140000, 1e-6);
});

test("completes the grid from two typed points", () => {
  const m = [72, 0, 0, 72, 201000, 8995000], nodes = [];
  let seed = 1;
  const jitter = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 0.02; }; // drawn to 0.01 pt
  for (let x = 210000; x <= 350000; x += 10000) {
    for (let y = 9000000; y <= 9100000; y += 10000) {
      const q = PG.apply(PG.invert(m), x, y);
      nodes.push([q[0] + jitter(), q[1] + jitter()]);
    }
  }
  nodes.push([5, 5]); // a stray cross outside the grid
  const a = nodes[0], b = nodes[nodes.length - 2];
  const typed = [{ px: a[0], py: a[1], x: 210000, y: 9000000 }, { px: b[0], py: b[1], x: 350000, y: 9100000 }];
  const lattice = PG.latticeSpacing(nodes);
  const iv = PG.niceInterval(Math.min(lattice.x, lattice.y) * PG.fitScale(PG.fit(typed)), false);
  assert.equal(iv, 10000);
  const done = PG.completeGrid(typed, nodes, iv);
  assert.equal(done.points.length, 15 * 11);
  assert.ok(done.fit.rmse < 2, "rmse " + done.fit.rmse);
  assert.equal(PG.niceInterval(0.26, true), 0.25);
  near(PG.niceInterval(0.083, true), 5 / 60, 1e-12);
});

// ---------- Paths and grid crosses ----------
function stroke(width, ...segs) {
  return { fill: null, stroke: [0, 0, 0], width, dash: false, parts: segs.map((pts) => ({ pts, closed: false })), bbox: [0, 0, 1000, 1000] };
}
test("finds grid crosses (also drawn as a bar and two half arms) and grid line crossings", () => {
  const paths = [];
  for (let x = 100; x <= 500; x += 100) {
    for (let y = 100; y <= 300; y += 100) {
      // vertical bar + two half arms, as CorelDRAW writes them
      paths.push(stroke(0.2, [x, y - 4, x, y + 4], [x - 4, y, x, y], [x + 4, y, x, y]));
    }
  }
  paths.push(stroke(0.2, [700, 690, 700, 710], [690, 700, 710, 700])); // a bigger "+" symbol
  const nodes = PG.findGridNodes(paths, [0, 0, 1000, 800]);
  assert.equal(nodes.length, 15);
  assert.deepEqual(PG.latticeSpacing(nodes), { x: 100, y: 100 });
  const lines = [stroke(0.5, [0, 200, 1000, 200]), stroke(0.5, [0, 400, 1000, 400]), stroke(0.5, [300, 0, 300, 800]), stroke(0.5, [600, 0, 600, 800])];
  assert.equal(PG.findGridNodes(lines, [0, 0, 1000, 800]).length, 4);
});

test("walks a pdf.js operator list: transforms, curves, layers, colours", () => {
  const OPS = { save: 1, restore: 2, transform: 3, constructPath: 4, moveTo: 5, lineTo: 6, curveTo: 7, curveTo2: 8, curveTo3: 9, closePath: 10, rectangle: 11,
    stroke: 12, fill: 13, eoFill: 14, fillStroke: 15, endPath: 16, setFillRGBColor: 17, setStrokeRGBColor: 18, setLineWidth: 19, setDash: 20,
    beginMarkedContentProps: 21, endMarkedContent: 22, paintImageXObject: 23, closeStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27, setGState: 28 };
  const fn = [], args = [];
  const op = (f, a) => { fn.push(OPS[f]); args.push(a || []); };
  op("save"); op("transform", [2, 0, 0, 2, 10, 20]);
  op("setStrokeRGBColor", [0, 0, 255]); op("setLineWidth", [0.5]); op("setDash", [[3, 2], 0]);
  op("constructPath", [[OPS.moveTo, OPS.lineTo, OPS.curveTo], [0, 0, 10, 0, 10, 5, 5, 10, 0, 10]]);
  op("stroke");
  op("restore");
  op("setFillRGBColor", [255, 0, 0]);
  op("constructPath", [[OPS.rectangle], [100, 100, 50, 20]]);
  op("fill");
  op("beginMarkedContentProps", ["OC", { id: "guides" }]);
  op("constructPath", [[OPS.moveTo, OPS.lineTo], [0, 0, 999, 999]]);
  op("stroke");
  op("endMarkedContent");
  op("save"); op("transform", [300, 0, 0, 200, 50, 60]); op("paintImageXObject", ["img1", 600, 400]); op("restore");
  const out = PG.extractPaths({ fnArray: fn, argsArray: args }, OPS, (p) => p.id !== "guides");
  assert.equal(out.paths.length, 2, "hidden layer left out");
  const line = out.paths[0];
  assert.deepEqual(line.stroke, [0, 0, 255]);
  assert.equal(line.width, 1); // 0.5 × scale 2
  assert.equal(line.dash, true);
  assert.deepEqual(Array.from(line.parts[0].pts.slice(0, 4)), [10, 20, 30, 20]);
  const end = line.parts[0].pts.slice(-2);
  assert.deepEqual(Array.from(end), [10, 40]); // curve end (0,10) transformed
  assert.ok(line.parts[0].pts.length > 8, "curve flattened");
  const rect = out.paths[1];
  assert.deepEqual(rect.fill, [255, 0, 0]);
  assert.equal(rect.parts[0].closed, true);
  assert.deepEqual(rect.bbox, [100, 100, 150, 120]);
  assert.deepEqual(out.images, [{ bbox: [50, 60, 350, 260], width: 600, height: 400 }]);
  assert.equal(PG.imageDpi(out.images, [0, 0, 400, 400]), 144);
  const groups = PG.groupPaths(out.paths, null);
  assert.equal(groups.length, 2);
  assert.equal(PG.findFrame(out.paths, out.images, [0, 0, 400, 300], []).join(), "50,60,350,260");
});

test("clips lines and rings to the map frame", () => {
  assert.deepEqual(PG.clipLine([-5, 5, 5, 5, 15, 5, 15, -5], [0, 0, 10, 10]), [[0, 5, 5, 5, 10, 5]]);
  assert.deepEqual(PG.clipLine([2, 2, 8, 8], [0, 0, 10, 10]), [[2, 2, 8, 8]]);
  assert.deepEqual(PG.clipLine([5, -5, 5, 15, 7, 15, 7, -5], [0, 0, 10, 10]), [[5, 0, 5, 10], [7, 10, 7, 0]]);
  assert.deepEqual(PG.clipRing([[-5, -5], [5, -5], [5, 5], [-5, 5]], [0, 0, 10, 10]), [[0, 0], [5, 0], [5, 5], [0, 5]]);
  assert.deepEqual(PG.clipRing([[20, 20], [30, 20], [30, 30]], [0, 0, 10, 10]), []);
});

test("turns paths into GeoJSON: polygons with holes, lines, clipped", () => {
  const m = [0.001, 0, 0, 0.001, 110, -8]; // page → lon/lat directly
  const toLL = PG.projector(m, PG.crs(4326));
  const sq = (x0, y0, s) => [x0, y0, x0 + s, y0, x0 + s, y0 + s, x0, y0 + s];
  const paths = [
    { fill: [0, 128, 0], stroke: null, width: 0, parts: [{ pts: sq(0, 0, 100), closed: true }, { pts: sq(25, 25, 50), closed: true }], bbox: [0, 0, 100, 100] },
    { fill: null, stroke: [0, 0, 255], width: 0.5, parts: [{ pts: [-50, 50, 50, 50], closed: false }], bbox: [-50, 50, 50, 50] },
  ];
  const groups = [{ name: "Hutan", items: [0] }, { name: "Sungai", items: [1] }];
  const feats = PG.pathFeatures(paths, groups, [0, 0, 200, 200], toLL);
  assert.equal(feats.length, 2);
  const poly = feats[0];
  assert.equal(poly.geometry.type, "Polygon");
  assert.equal(poly.geometry.coordinates.length, 2, "outer + hole");
  assert.equal(poly.properties.lapisan, "Hutan");
  assert.equal(poly.properties.warna_isi, "#008000");
  const area = (r) => r.slice(0, -1).reduce((s, p, i) => s + p[0] * r[i + 1][1] - r[i + 1][0] * p[1], 0) / 2;
  assert.ok(area(poly.geometry.coordinates[0]) > 0, "outer counter-clockwise");
  assert.ok(area(poly.geometry.coordinates[1]) < 0, "hole clockwise");
  assert.deepEqual(feats[1].geometry, { type: "LineString", coordinates: [[110, -7.95], [110.05, -7.95]] });
});

test("joins text pieces into labels", () => {
  const item = (str, x, y, w, size) => ({ str, transform: [size, 0, 0, size, x, y], width: w, height: size });
  const labels = PG.textLabels([
    item("L A U T", 100, 500, 60, 20), item(" ", 160, 500, 5, 20), item("B A L I", 170, 500, 60, 20),
    item("Denpasar", 300, 200, 40, 8),
    item("Legenda", 900, 50, 40, 10),
  ], [0, 0, 800, 600]);
  assert.deepEqual(labels.map((l) => l.text), ["L A U T B A L I", "Denpasar"]);
  near(labels[1].x, 320, 1e-9);
  assert.equal(labels[1].angle, 0);
});

// ---------- GeoPDF ----------
function pdf(objects, trailerRoot) {
  let out = "%PDF-1.7\n", offs = [];
  objects.forEach((o, i) => { offs.push(out.length); out += (i + 1) + " 0 obj\n" + o + "\nendobj\n"; });
  out += "trailer\n<< /Root " + trailerRoot + " 0 R >>\n%%EOF\n";
  return new Uint8Array(Buffer.from(out, "latin1"));
}
test("reads ISO 32000 GeoPDF georeferencing (/VP, /Measure, /GCS)", async () => {
  const bytes = pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /VP [ << /Type /Viewport /BBox [ 36 120 636 475 ] /Name (Peta) /Measure 4 0 R >> ] >>",
    "<< /Type /Measure /Subtype /GEO /Bounds [0 0 0 1 1 1 1 0] /GPTS [ -9.04 114.27 -7.87 114.27 -7.87 116.3 -9.04 116.3 ] /LPTS [0 0 0 1 1 1 1 0] /GCS 5 0 R >>",
    "<< /Type /PROJCS /EPSG 32750 /WKT (PROJCS[\"WGS 84 / UTM zone 50S\"]) >>",
  ], 1);
  const g = await PG.readGeoPdf(bytes, { num: 3, gen: 0 });
  assert.equal(g.source, "ISO 32000");
  const vp = g.viewports[0];
  assert.deepEqual(vp.bbox, [36, 120, 636, 475]);
  assert.equal(vp.epsg, 32750);
  assert.equal(vp.name, "Peta");
  assert.deepEqual(vp.points[1], { px: 36, py: 475, lat: -7.87, lon: 114.27 });
});

test("reads GeoPDF dictionaries packed in a compressed object stream", async () => {
  const objs = [
    "<< /Type /Page /Parent 2 0 R /VP [ 5 0 R ] >>",
    "<< /Type /Viewport /BBox [0 0 100 100] /Measure << /Subtype /GEO /GPTS [-6 106 -5 106 -5 107 -6 107] /LPTS [0 0 0 1 1 1 1 0] /GCS << /Type /GEOGCS /WKT (GEOGCS[\"WGS 84\"]) >> >> >>",
  ];
  let body = "", header = "";
  [3, 5].forEach((num, i) => { header += num + " " + body.length + " "; body += objs[i] + "\n"; });
  const stream = zlib.deflateSync(Buffer.from(header + body, "latin1"));
  const head = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
    "4 0 obj\n<< /Type /ObjStm /N 2 /First " + header.length + " /Filter /FlateDecode /Length " + stream.length + " >>\nstream\n", "latin1");
  const bytes = new Uint8Array(Buffer.concat([head, stream, Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")]));
  const g = await PG.readGeoPdf(bytes, { num: 3, gen: 0 });
  assert.equal(g.viewports[0].epsg, 4326);
  assert.deepEqual(g.viewports[0].points[2], { px: 100, py: 100, lat: -5, lon: 107 });
});

test("reads OGC /LGIDict georeferencing and ignores plain PDFs", async () => {
  const bytes = pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /LGIDict << /Type /LGIDict /Version (2.1) /Neatline [10 10 10 90 90 90 90 10] " +
      "/Registration [ [(10) (10) (200000) (9000000)] [(90) (90) (280000) (9080000)] ] /Projection << /Type /Projection /ProjectionType (UT) /Zone 50 /Hemisphere (S) /Datum (WE) >> >> >>",
  ], 1);
  const g = await PG.readGeoPdf(bytes, { num: 3, gen: 0 });
  assert.equal(g.source, "OGC");
  assert.equal(g.viewports[0].epsg, 32750);
  assert.deepEqual(g.viewports[0].bbox, [10, 10, 90, 90]);
  assert.deepEqual(g.viewports[0].points[1], { px: 90, py: 90, x: 280000, y: 9080000 });
  const plain = pdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R >>"], 1);
  assert.equal(await PG.readGeoPdf(plain, { num: 3, gen: 0 }), null);
});

test("parses PDF objects: strings, names, refs, nesting", () => {
  const v = PG.parseValue("<< /A (a\\(b\\)c\\101) /B <48 69> /C [1 0 R 2.5 -3 /N#20x true null] /D << /E 7 >> >>", 0).value;
  assert.equal(v.A, "a(b)cA");
  assert.equal(v.B, "Hi");
  assert.deepEqual(v.C, [{ ref: 1 }, 2.5, -3, { name: "N x" }, true, null]);
  assert.equal(v.D.E, 7);
});

// ---------- Colour classes → polygons ----------
function raster(w, h, fn) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn(x, y), i = (y * w + x) * 4;
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
  }
  return rgba;
}
test("classifies colours, removes thin lines and specks, traces polygons with holes", () => {
  const W = 60, H = 40, RED = [220, 30, 30], GREEN = [40, 180, 60], GREY = [200, 200, 200];
  const rgba = raster(W, H, (x, y) => {
    if (x >= 5 && x < 25 && y >= 5 && y < 25 && !(x >= 10 && x < 15 && y >= 10 && y < 15)) return [RED[0] + (x % 3), RED[1], RED[2]]; // red square with a hole
    if (y === 30 && x > 2 && x < 58) return RED;          // a thin red road
    if (x >= 40 && x < 50 && y >= 5 && y < 15) return GREEN;  // green block
    if (x === 55 && y === 5) return GREEN;                 // a speck
    return GREY;
  });
  const classes = [{ name: "Tinggi", colors: [RED] }, { name: "Rendah", colors: [GREEN] }];
  const cls = PG.classify(rgba, PG.colorTable(classes, 10));
  assert.equal(cls[30 * W + 20], 1, "road classified before clean-up");
  PG.removeThin(cls, W, H, 1, 2);
  assert.equal(cls[30 * W + 20], 0, "road removed");
  assert.equal(cls[5 * W + 5], 1, "corner of the square kept");
  PG.sieve(cls, W, H, 4);
  assert.equal(cls[5 * W + 55], 0, "speck removed");
  const feats = PG.polygonize(cls, W, H, classes, (c, r) => [c, -r], { simplify: 0 });
  assert.equal(feats.length, 2);
  const red = feats[0];
  assert.equal(red.properties.kelas, "Tinggi");
  assert.equal(red.geometry.type, "Polygon");
  assert.equal(red.geometry.coordinates.length, 2, "outer ring and hole");
  assert.equal(red.properties.piksel, 20 * 20 - 5 * 5);
  assert.equal(red.geometry.coordinates[0].length, 5, "a square has 4 corners (+ closing point)");
  assert.equal(feats[1].properties.piksel, 100);
});

test("keeps diagonal neighbours apart and nests islands in holes", () => {
  // 1 0 . / 0 1 . : two pixels touching at a corner → two polygons.
  const diag = PG.traceClass(Uint8Array.from([1, 0, 0, 1]), 2, 2, 1);
  assert.equal(diag.length, 2);
  // Ring of class 1 with an island of class 1 in its hole.
  const W = 7, cls = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) cls[y * W + x] = (x === 0 || y === 0 || x === W - 1 || y === W - 1 || (x === 3 && y === 3)) ? 1 : 0;
  const f = PG.polygonize(cls, W, W, [{ name: "a", colors: [[0, 0, 0]] }], (c, r) => [c, -r], { simplify: 0 })[0];
  assert.equal(f.geometry.type, "MultiPolygon");
  assert.equal(f.geometry.coordinates.length, 2);
  assert.equal(f.geometry.coordinates[0].length + f.geometry.coordinates[1].length, 3, "ring with hole + island");
});

// ---------- GeoTIFF writer ----------
test("writes GeoTIFFs that read back (RGB with predictor, palette classes, rotation)", async () => {
  const W = 37, H = 23;
  const rgb = new Uint8Array(W * H * 3).map((_, i) => (i * 7) % 256);
  const w = PG.tiffWriter({ width: W, height: H, samples: 3, transform: [230000, 50, 0, 9110000, 0, -50], epsg: 32750 });
  await w.add(rgb.subarray(0, W * 3 * 10));
  await w.add(rgb.subarray(W * 3 * 10));
  const file = new Blob(await w.finish());
  const info = await GT.open(file);
  assert.equal(info.width, W);
  assert.equal(info.crs.name, "WGS 84 / UTM 50S");
  assert.deepEqual(info.transform, [230000, 50, 0, 9110000, 0, -50]);
  const grid = await GT.readGrid(info, { maxSide: 64 });
  for (let i = 0; i < W * H; i++) {
    assert.equal(grid.bands[0][i], rgb[i * 3]);
    assert.equal(grid.bands[2][i], rgb[i * 3 + 2]);
  }

  const cls = new Uint8Array(W * H).map((_, i) => i % 3);
  const cw = PG.tiffWriter({ width: W, height: H, samples: 1, transform: [110, 0.001, 0.0002, -6, 0.0001, -0.001], epsg: 4326, palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0]], nodata: 0 });
  await cw.add(cls);
  const ci = await GT.open(new Blob(await cw.finish()));
  assert.equal(ci.crs.name, "WGS 84 (bujur/lintang)");
  assert.deepEqual(ci.transform, [110, 0.001, 0.0002, -6, 0.0001, -0.001]);
  assert.equal(ci.nodata, 0);
  assert.ok(ci.palette);
  const cg = await GT.readGrid(ci, { maxSide: 64 });
  assert.equal(cg.bands[0][4], 1);
  assert.ok(Number.isNaN(cg.bands[0][3]), "class 0 is nodata");
});

// ---------- The sample PDF, through the vendored pdf.js ----------
async function loadPdfjs() {
  const dir = path.join(__dirname, "..", "public", "assets", "vendor", "pdfjs");
  const log = console.log;
  console.log = (...a) => { if (!/^Warning: /.test(String(a[0]))) log(...a); }; // no canvas in Node: fine for reading
  try {
    const lib = await import(pathToFileURL(path.join(dir, "pdf.min.mjs")).href);
    lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(dir, "pdf.worker.min.mjs")).href;
    return lib;
  } finally { console.log = log; }
}

test("extracts the sample map: grid, frame, georeferencing, coastline, labels", async () => {
  const lib = await loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "public", "data", "contoh-peta.pdf")));
  assert.equal(await PG.readGeoPdf(data, null), null, "not a GeoPDF");
  const doc = await lib.getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const page = await doc.getPage(1);
    const got = PG.extractPaths(await page.getOperatorList(), lib.OPS);
    const nodes = PG.findGridNodes(got.paths, page.view);
    const frame = PG.findFrame(got.paths, got.images, page.view, nodes);
    assert.deepEqual(frame.map((v) => Math.round(v)), [36, 120, 636, 475]);
    assert.equal(PG.imageDpi(got.images, frame), 108);
    const text = (await page.getTextContent()).items;
    assert.equal(PG.detectCrs(text.map((i) => i.str).join(" ")).epsg, 32750);
    const labels = PG.textLabels(text, frame).map((l) => l.text);
    assert.ok(labels.includes("Denpasar") && labels.includes("SELAT LOMBOK"), labels.join("|"));

    // Two crosses typed from the labels, then the grid.
    const K = 600 / 220000, at = (x, y) => nodes.find((n) => Math.hypot(n[0] - (36 + (x - 200000) * K), n[1] - (120 + (y - 9000000) * K)) < 0.5);
    const typed = [{ px: at(220000, 9120000)[0], py: at(220000, 9120000)[1], x: 220000, y: 9120000 }, { px: at(400000, 9020000)[0], py: at(400000, 9020000)[1], x: 400000, y: 9020000 }];
    const lattice = PG.latticeSpacing(nodes);
    const iv = PG.niceInterval(Math.min(lattice.x, lattice.y) * PG.fitScale(PG.fit(typed)), false);
    assert.equal(iv, 20000);
    const done = PG.completeGrid(typed, nodes, iv);
    assert.equal(done.points.length, 60);
    assert.ok(done.fit.rmse < 5, "rmse " + done.fit.rmse);

    // The coastline layer, cut to the frame, lands where Bali is.
    const coast = PG.groupPaths(got.paths, frame).find((g) => g.stroke === "#006bbf");
    coast.name = "Garis pantai";
    const feats = PG.pathFeatures(got.paths, [coast], frame, PG.projector(done.fit.m, PG.crs(32750)));
    const all = feats.flatMap((f) => f.geometry.type === "LineString" ? f.geometry.coordinates : f.geometry.coordinates.flat());
    const lons = all.map((c) => c[0]), lats = all.map((c) => c[1]);
    assert.ok(Math.min(...lons) >= 114.26 && Math.max(...lons) <= 116.3, "within the frame (lon)");
    assert.ok(Math.min(...lats) >= -9.05 && Math.max(...lats) <= -7.86, "within the frame (lat)");
    // Denpasar's label is near the real Denpasar (115.22 E, 8.65 S).
    const dps = PG.textLabels(text, frame).find((l) => l.text === "Denpasar");
    const ll = PG.projector(done.fit.m, PG.crs(32750))(dps.x, dps.y);
    assert.ok(Math.abs(ll[0] - 115.22) < 0.15 && Math.abs(ll[1] + 8.65) < 0.1, ll.join());
  } finally {
    await doc.destroy();
  }
});
