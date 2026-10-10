"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const SM = require("../public/assets/js/staticmap");

// ---------- helpers: build small shapefiles and zips in memory ----------
function shp(type, records) {
  // records: arrays of rings ([[x, y], …]) for polylines/polygons, or [x, y] for points.
  const bodies = records.map((r) => {
    if (type === 1) {
      const b = Buffer.alloc(20);
      b.writeInt32LE(1, 0); b.writeDoubleLE(r[0], 4); b.writeDoubleLE(r[1], 12);
      return b;
    }
    const pts = r.flat();
    const b = Buffer.alloc(44 + r.length * 4 + pts.length * 16);
    b.writeInt32LE(type, 0);
    b.writeInt32LE(r.length, 36);
    b.writeInt32LE(pts.length, 40);
    let start = 0;
    r.forEach((ring, i) => { b.writeInt32LE(start, 44 + i * 4); start += ring.length; });
    pts.forEach((p, i) => { b.writeDoubleLE(p[0], 44 + r.length * 4 + i * 16); b.writeDoubleLE(p[1], 52 + r.length * 4 + i * 16); });
    return b;
  });
  const header = Buffer.alloc(100);
  header.writeInt32BE(9994, 0);
  header.writeInt32LE(1000, 28);
  header.writeInt32LE(type, 32);
  const recs = bodies.map((b, i) => {
    const h = Buffer.alloc(8);
    h.writeInt32BE(i + 1, 0);
    h.writeInt32BE(b.length / 2, 4);
    return Buffer.concat([h, b]);
  });
  const all = Buffer.concat([header, ...recs]);
  all.writeInt32BE(all.length / 2, 24);
  return new Uint8Array(all);
}

function dbf(fields, rows, encoding = "latin1") {
  // fields: [name, type, size, decimals]
  const recLen = 1 + fields.reduce((s, f) => s + f[2], 0);
  const headerLen = 32 + fields.length * 32 + 1;
  const b = Buffer.alloc(headerLen + rows.length * recLen + 1, 0x20);
  b.fill(0, 0, headerLen);
  b[0] = 3;
  b.writeUInt32LE(rows.length, 4);
  b.writeUInt16LE(headerLen, 8);
  b.writeUInt16LE(recLen, 10);
  fields.forEach((f, i) => {
    const p = 32 + i * 32;
    b.write(f[0], p, "latin1");
    b.write(f[1], p + 11, "latin1");
    b[p + 16] = f[2];
    b[p + 17] = f[3] || 0;
  });
  b[headerLen - 1] = 0x0d;
  rows.forEach((row, r) => {
    let p = headerLen + r * recLen + 1;
    fields.forEach((f, i) => {
      const v = String(row[i] == null ? "" : row[i]);
      const bytes = Buffer.from(f[1] === "N" ? v.padStart(f[2]) : v, encoding);
      bytes.copy(b, p, 0, f[2]);
      p += f[2];
    });
  });
  b[b.length - 1] = 0x1a;
  return new Uint8Array(b);
}

function zip(entries) {
  // entries: { name: Buffer|Uint8Array } — deflated, like most zip tools do.
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const comp = zlib.deflateRawSync(Buffer.from(data));
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, comp);
    centrals.push(central, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...locals, cd, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

// Forward UTM (Snyder), only to check the inverse round-trips.
function utmForward(lon, lat, zone) {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), ep2 = e2 / (1 - e2), k0 = 0.9996, d = Math.PI / 180;
  const phi = lat * d, lam0 = (zone * 6 - 183) * d;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2;
  const A = (lon * d - lam0) * Math.cos(phi);
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi) +
    (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
  const y = k0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return [x + 500000, lat < 0 ? y + 10000000 : y];
}

const UTM49S = 'PROJCS["WGS_1984_UTM_Zone_49S",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",111.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
const WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

// ---------- GeoJSON ----------
test("reads a GeoJSON FeatureCollection with mixed geometry", () => {
  const layer = SM.parseGeoJSON(JSON.stringify({
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { NAME: "A", LUAS: 1.5, N: 3 }, geometry: { type: "Polygon", coordinates: [[[110, -2], [111, -2], [111, -1], [110, -2]]] } },
      { type: "Feature", properties: { NAME: "B", LUAS: 2, N: 4 }, geometry: { type: "MultiPoint", coordinates: [[112, 1], [113, 2]] } },
      { type: "Feature", properties: { NAME: "C" }, geometry: null },
    ],
  }));
  assert.equal(layer.features.length, 2);
  assert.equal(layer.geometry, "Mixed");
  assert.deepEqual(layer.bbox, [110, -2, 113, 2]);
  assert.deepEqual(layer.fields, [{ name: "NAME", type: "Text" }, { name: "LUAS", type: "Double" }, { name: "N", type: "Integer" }]);
});

test("reprojects GeoJSON in a legacy UTM crs", () => {
  const [x, y] = utmForward(111.5, -2.25, 49);
  const layer = SM.parseGeoJSON({
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32749" } },
    features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [x, y] } }],
  });
  assert.ok(Math.abs(layer.bbox[0] - 111.5) < 1e-7);
  assert.ok(Math.abs(layer.bbox[1] + 2.25) < 1e-7);
});

test("rejects projected coordinates with no crs", () => {
  assert.throws(() => SM.parseGeoJSON({ type: "Point", coordinates: [500000, 9800000] }), /not longitude\/latitude/);
});

// ---------- Projections ----------
test("UTM inverse round-trips across Indonesia", () => {
  for (const [lon, lat, zone] of [[106.8272, -6.1754, 48], [117.15, 3.31, 50], [140.7, -2.53, 54], [95.32, 5.55, 46]]) {
    const [x, y] = utmForward(lon, lat, zone);
    const toLonLat = SM.parsePrj(UTM49S.replace("111.0", String(zone * 6 - 183)).replace("10000000.0", lat < 0 ? "10000000.0" : "0.0")).toLonLat;
    const [lo, la] = toLonLat(x, y);
    assert.ok(Math.abs(lo - lon) < 1e-7 && Math.abs(la - lat) < 1e-7, `${lon},${lat} → ${lo},${la}`);
  }
});

test("reads .prj files", () => {
  assert.equal(SM.parsePrj(WGS84).toLonLat, null);
  assert.equal(SM.parsePrj("").toLonLat, null);
  assert.equal(SM.parsePrj(UTM49S).name, "WGS 1984 UTM Zone 49S");
  const merc = SM.parsePrj('PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]');
  const R = 6378137, rad = Math.PI / 180;
  const [lon, lat] = merc.toLonLat(R * 110 * rad, R * Math.log(Math.tan(Math.PI / 4 - 6 * rad / 2)));
  assert.ok(Math.abs(lon - 110) < 1e-9 && Math.abs(lat + 6) < 1e-9);
  assert.throws(() => SM.parsePrj('PROJCS["Lambert",GEOGCS["x"],PROJECTION["Lambert_Conformal_Conic"],UNIT["Meter",1.0]]'), /not supported/);
});

// ---------- Shapefile ----------
test("reads a polygon shapefile with attributes, holes and Windows-1252 text", () => {
  const outer = [[110, -2], [110, -1], [111, -1], [111, -2], [110, -2]];
  const hole = [[110.2, -1.8], [110.8, -1.8], [110.8, -1.2], [110.2, -1.8]];
  const layer = SM.parseShapefile({
    shp: shp(5, [[outer, hole], [[[112, 0], [112, 1], [113, 1], [112, 0]]]]),
    dbf: dbf([["NAMA", "C", 20], ["LUAS", "N", 12, 3], ["KODE", "N", 4, 0], ["TGL", "D", 8]],
      [["Désa A", 12.5, 13, "20260420"], ["Desa B", "", 52, ""]]),
    prj: WGS84,
  });
  assert.equal(layer.geometry, "Polygon");
  assert.equal(layer.features.length, 2);
  assert.equal(layer.features[0].parts.length, 2);
  assert.deepEqual(layer.features[0].props, { NAMA: "Désa A", LUAS: 12.5, KODE: 13, TGL: "2026-04-20" });
  assert.equal(layer.features[1].props.LUAS, null);
  assert.deepEqual(layer.fields.map((f) => f.type), ["Text", "Double", "Integer", "Date"]);
  assert.deepEqual(layer.bbox, [110, -2, 113, 1]);
  assert.equal(layer.format, "SHP");
});

test("reads UTF-8 attributes when the .cpg says so", () => {
  const layer = SM.parseShapefile({ shp: shp(1, [[110, -2]]), dbf: dbf([["NAMA", "C", 20]], [["Café ✓"]], "utf8"), cpg: "UTF-8" });
  assert.equal(layer.features[0].props.NAMA, "Café ✓");
  assert.equal(layer.geometry, "Point");
});

test("reprojects a UTM shapefile using its .prj", () => {
  const ring = [[111.1, -2.1], [111.1, -2], [111.2, -2], [111.1, -2.1]].map(([lo, la]) => utmForward(lo, la, 49));
  const layer = SM.parseShapefile({ shp: shp(3, [[ring]]), prj: UTM49S });
  assert.equal(layer.geometry, "Line");
  assert.ok(Math.abs(layer.bbox[0] - 111.1) < 1e-7 && Math.abs(layer.bbox[3] + 2) < 1e-7);
  assert.equal(layer.crs, "WGS 1984 UTM Zone 49S");
});

test("reads a zipped shapefile", async () => {
  const buf = zip({
    "__MACOSX/._data.shp": Buffer.from("junk"),
    "data/areal.shp": shp(5, [[[[110, -2], [110, -1], [111, -1], [110, -2]]]]),
    "data/areal.dbf": dbf([["STATUS", "C", 10]], [["Realisasi"]]),
    "data/areal.prj": Buffer.from(WGS84),
    "data/readme.txt": Buffer.from("ignored"),
  });
  const entries = await SM.readZip(buf, (n) => /\.(shp|dbf|prj)$/i.test(n));
  assert.deepEqual(entries.map((e) => e.name).sort(), ["data/areal.dbf", "data/areal.prj", "data/areal.shp"]);
  const file = { name: "areal.zip", arrayBuffer: async () => buf };
  const layer = await SM.load([file]);
  assert.equal(layer.features[0].props.STATUS, "Realisasi");
});

test("load explains which files it needs", async () => {
  await assert.rejects(SM.load([{ name: "x.kml" }]), /Choose a \.geojson/);
  await assert.rejects(SM.load([]), /Choose a file/);
});

// ---------- Styling & layout ----------
test("categories: largest first, colour-blind-safe palette, rest grouped", () => {
  const features = [];
  "aaaaabbbbcccdde".split("").forEach((v) => features.push({ props: { K: v } }));
  "fghij".split("").forEach((v) => features.push({ props: { K: v } }));
  features.push({ props: { K: "" } });
  const layer = { features, fields: [{ name: "K" }, { name: "ID" }] };
  const c = SM.categories(layer, "K");
  assert.equal(c.length, 7);
  assert.deepEqual(c.slice(0, 3).map((x) => [x.label, x.count]), [["a", 5], ["b", 4], ["c", 3]]);
  assert.equal(c[6].label, "Lainnya");
  assert.equal(c.reduce((s, x) => s + x.count, 0), features.length);
  assert.equal(SM.categories(layer, "").length, 1);
  features.forEach((f, i) => { f.props.ID = i; });
  assert.deepEqual(SM.categoryFields(layer), ["K"]);
});

test("numeric fields: quantile ranges, light to dark, blanks grey", () => {
  const features = [];
  for (let i = 1; i <= 20; i++) features.push({ props: { N: i * 10, K: i % 3 ? "x" : "y", ID: "f" + i, T: "t" + i } });
  features.push({ props: { N: null, K: "x", ID: "f21", T: "t21" } });
  const layer = { features, fields: ["N", "K", "ID", "T"].map((name) => ({ name })) };
  assert.equal(SM.fieldKind(layer, "N"), "number");
  assert.equal(SM.fieldKind(layer, "K"), "category");
  // Identifiers (one text value per feature) are not offered.
  assert.deepEqual(SM.fieldOptions(layer), [{ name: "N", kind: "number" }, { name: "K", kind: "category" }]);

  const r = SM.ranges(layer, "N");
  assert.deepEqual(r.map((c) => [c.label, c.count]), [
    ["10 – 40", 4], ["50 – 80", 4], ["90 – 120", 4], ["130 – 160", 4], ["170 – 200", 4], ["Tanpa nilai", 1],
  ]);
  assert.deepEqual(SM.classify(layer, "N"), r);
  assert.deepEqual(SM.classify(layer, "K"), SM.categories(layer, "K"));

  // Few distinct numbers are categories. A run of equal values pushes the break to the next value.
  const codes = { features: [1, 2, 3, 1].map((v) => ({ props: { C: v } })), fields: [{ name: "C" }] };
  assert.equal(SM.fieldKind(codes, "C"), "category");
  const skewed = { features: Array.from({ length: 20 }, (_, i) => ({ props: { S: i < 17 ? 0 : i } })), fields: [{ name: "S" }] };
  const rs = SM.ranges(skewed, "S");
  assert.deepEqual(rs.map((c) => [c.label, c.count]), [["0", 17], ["17", 1], ["18", 1], ["19", 1]]);
  assert.equal(new Set(rs.map((c) => c.color)).size, 4);
});

test("nice numbers, grid steps and degree labels", () => {
  assert.equal(SM.niceFloor(347), 200);
  assert.equal(SM.niceFloor(0.73), 0.5);
  assert.equal(SM.niceFloor(1000), 1000);
  assert.equal(SM.gridStep(46), 10);
  assert.equal(SM.gridStep(2), 0.5);
  assert.equal(SM.formatDeg(106.5, "x"), "106°30′ BT");
  assert.equal(SM.formatDeg(-6.25, "y"), "6°15′ LS");
  assert.equal(SM.formatDeg(0, "y"), "0°");
});

test("the view fits the data, keeps areas true and the scale true at the centre", () => {
  const frame = { x: 0, y: 0, w: 1000, h: 500 };
  const v = SM.makeView([95, -11, 141, 6], frame, { pad: 0 });
  assert.ok(v.x(95) >= -1e-9 && v.x(141) <= 1000 + 1e-9);
  assert.ok(v.y(6) >= -1e-9 && v.y(-11) <= 500 + 1e-9);
  assert.ok(Math.abs(v.lon(v.x(120)) - 120) < 1e-9 && Math.abs(v.lat(v.y(-3)) + 3) < 1e-9);
  // 1° of longitude at the standard parallel is 111.2 km × cos(lat0).
  const km = (v.x(119) - v.x(118)) * v.kmPerPx;
  assert.ok(Math.abs(km - 111.195 * Math.cos(v.lat0 * Math.PI / 180)) < 0.01, String(km));
  // A single point still gets a sensible extent.
  const p = SM.makeView([110, -2, 110, -2], frame);
  assert.ok(p.bbox[2] - p.bbox[0] > 0.05);
});

test("summary rounds the extent outwards", () => {
  const s = SM.summary({ bbox: [110.12345, -2.00001, 111.99991, 1.5], features: [1, 2], geometry: "Polygon", fields: [{ name: "A", type: "Text" }], crs: "WGS 84", format: "SHP" });
  assert.deepEqual(s.bbox, [110.1234, -2.0001, 112, 1.5]);
  assert.equal(s.features, 2);
});

test("the basemap is valid and covers Indonesia", () => {
  const b = require("../public/data/basemap.json");
  assert.equal(b.scale, 1000);
  const idn = b.countries.find((c) => c.iso === "IDN");
  assert.ok(idn && idn.rings.length > 100);
  for (const c of b.countries) for (const r of c.rings) assert.ok(r.length >= 8 && r.length % 2 === 0 && r.every(Number.isInteger));
});
