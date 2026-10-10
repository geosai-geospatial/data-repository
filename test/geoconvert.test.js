"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const SM = require("../public/assets/js/staticmap");
const GC = require("../public/assets/js/geoconvert");

const MB = 1024 * 1024;

function file(name, content) {
  return new File([content], name);
}
async function bytes(out) {
  return new Uint8Array(await new Blob(out.parts).arrayBuffer());
}
// Blob.text() drops a byte-order mark; keep it so the tests can see it.
async function text(out) {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await bytes(out));
}
// Reads a zip written by GC.zip back with staticmap's reader, checking CRCs.
async function unzip(u8) {
  const entries = await SM.readZip(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), () => true);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = dv.getUint32(u8.length - 6, true);
  const crcs = {};
  for (let i = 0; i < entries.length; i++) {
    const n = dv.getUint16(p + 28, true);
    crcs[Buffer.from(u8.subarray(p + 46, p + 46 + n)).toString()] = dv.getUint32(p + 16, true);
    p += 46 + n + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  const out = {};
  entries.forEach((e) => {
    assert.equal(zlib.crc32(e.data), crcs[e.name], "CRC of " + e.name);
    out[e.name] = e.data;
  });
  return out;
}

const SQUARE_WITH_HOLE = {
  type: "Polygon",
  coordinates: [
    [[106, -6], [107, -6], [107, -7], [106, -7], [106, -6]],
    [[106.4, -6.4], [106.4, -6.6], [106.6, -6.6], [106.6, -6.4], [106.4, -6.4]],
  ],
};
const SAMPLE = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { nama: "Desa Sukamaju", luas_ha: 1250.5, kode: "3201", aktif: true }, geometry: SQUARE_WITH_HOLE },
    {
      type: "Feature", properties: { nama: "Pulau", luas_ha: 12, kode: "3202", aktif: false },
      geometry: { type: "MultiPolygon", coordinates: [[[[108, -6], [108, -5], [109, -5], [108, -6]]], [[[110, -6], [110, -5], [111, -5], [110, -6]]]] },
    },
  ],
};

test("size limit follows the device", () => {
  assert.equal(GC.sizeLimit({}), 250 * MB);
  assert.equal(GC.sizeLimit({ deviceMemory: 8 }), 250 * MB);
  assert.equal(GC.sizeLimit({ deviceMemory: 4 }), 150 * MB);
  assert.equal(GC.sizeLimit({ deviceMemory: 2 }), 75 * MB);
  assert.equal(GC.sizeLimit({ mobile: true }), 50 * MB);
  assert.equal(GC.sizeLimit({ mobile: true, deviceMemory: 8 }), 100 * MB);
});

test("read refuses files over the limit before reading them", async () => {
  await assert.rejects(GC.read([file("a.geojson", "x".repeat(2000))], { maxBytes: 1000 }), /too large/);
});

test("GeoJSON: polygons are rewound to RFC 7946 and UTM is converted", () => {
  const d = GC.fromGeoJSON(JSON.stringify(SAMPLE));
  const outer = d.features[0].geometry.coordinates[0];
  // Input outer ring was clockwise; output is counter-clockwise.
  assert.deepEqual(outer[1], [106, -7]);
  assert.deepEqual(d.fields.map((f) => f.type), ["Text", "Double", "Text", "Boolean"]);

  const utm = GC.fromGeoJSON({
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32748" } },
    features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [700000, 9300000] } }],
  });
  const [lon, lat] = utm.features[0].geometry.coordinates;
  assert.ok(Math.abs(lon - 106.8) < 0.01 && Math.abs(lat - -6.33) < 0.01, lon + " " + lat);
  assert.equal(utm.crs, "WGS 84 / UTM zone 48S");
});

test("shapefile: write then read back gives the same polygons and attributes", async () => {
  const d = GC.fromGeoJSON(SAMPLE);
  const out = await GC.write(d, "shp", "batas desa");
  assert.equal(out.filename, "batas desa.zip");
  const files = await unzip(await bytes(out));
  assert.deepEqual(Object.keys(files).sort(), ["batas desa.cpg", "batas desa.dbf", "batas desa.prj", "batas desa.shp", "batas desa.shx"]);
  const back = GC.fromLayer(SM.parseShapefile({
    shp: files["batas desa.shp"], dbf: files["batas desa.dbf"],
    prj: Buffer.from(files["batas desa.prj"]).toString(), cpg: "UTF-8",
  }));
  assert.equal(back.features.length, 2);
  assert.deepEqual(back.features[0].geometry, d.features[0].geometry);
  assert.equal(back.features[1].geometry.type, "MultiPolygon");
  assert.deepEqual(back.features[1].geometry, d.features[1].geometry);
  assert.deepEqual(back.features[0].properties, { nama: "Desa Sukamaju", luas_ha: 1250.5, kode: "3201", aktif: true });
  assert.deepEqual(back.fields.map((f) => f.type), ["Text", "Double", "Text", "Boolean"]);
  // .shx points at each record.
  const shx = new DataView(files["batas desa.shx"].buffer, files["batas desa.shx"].byteOffset);
  assert.equal(shx.getInt32(100, false), 50);
});

test("shapefile: mixed geometry is split, long names shortened, missing geometry reported", async () => {
  const d = GC.fromGeoJSON({
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { nama_kabupaten_kota: "Bogor", "jumlah penduduk": 5000000 }, geometry: { type: "Point", coordinates: [106.8, -6.6] } },
      { type: "Feature", properties: { nama_kabupaten_kota: "Jalan" }, geometry: { type: "LineString", coordinates: [[106, -6], [107, -6.5]] } },
      { type: "Feature", properties: { nama_kabupaten_kota: "Kosong" }, geometry: null },
    ],
  });
  const out = await GC.write(d, "shp", "campuran");
  const codes = out.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ["no-geometry", "renamed-fields", "split"]);
  const files = await unzip(await bytes(out));
  assert.ok(files["campuran_titik.shp"] && files["campuran_garis.shp"]);
  const pts = SM.parseShapefile({ shp: files["campuran_titik.shp"], dbf: files["campuran_titik.dbf"] });
  assert.deepEqual(pts.fields.map((f) => f.name), ["nama_kabup", "jumlah_pen"]);
  assert.equal(pts.features[0].props.jumlah_pen, 5000000);
  assert.deepEqual(GC.dbfNames(["nama_kabupaten", "nama_kabupaten2", "Évaluasi"]).names, ["nama_kabup", "nama_kab_1", "Evaluasi"]);
});

test("KML: read placemarks with holes and ExtendedData, and write them back", async () => {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Folder>
  <Placemark><name>Blok A &amp; B</name>
    <ExtendedData><Data name="luas"><value>12.5</value></Data><Data name="kode"><value>007</value></Data></ExtendedData>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>
      106,-6,0 106,-7,0 107,-7,0 107,-6,0 106,-6,0
    </coordinates></LinearRing></outerBoundaryIs>
    <innerBoundaryIs><LinearRing><coordinates>106.4,-6.4 106.6,-6.4 106.6,-6.6 106.4,-6.6 106.4,-6.4</coordinates></LinearRing></innerBoundaryIs>
    </Polygon></Placemark>
  <Placemark><name><![CDATA[Titik <1>]]></name><Point><coordinates>106.8,-6.2</coordinates></Point></Placemark>
</Folder></Document></kml>`;
  const d = GC.fromKML(kml);
  assert.equal(d.features.length, 2);
  assert.deepEqual(d.features[0].properties, { name: "Blok A & B", luas: 12.5, kode: "007" });
  assert.equal(d.features[0].geometry.coordinates.length, 2);
  assert.equal(d.features[1].properties.name, "Titik <1>");

  const out = await GC.write(d, "kml", "blok");
  const again = GC.fromKML(await text(out));
  assert.deepEqual(again.features.map((f) => f.geometry), d.features.map((f) => f.geometry));
  assert.equal(again.features[0].properties.name, "Blok A & B");
});

test("GPX: waypoints, routes and tracks", () => {
  const d = GC.fromGPX(`<gpx version="1.1"><wpt lat="-6.2" lon="106.8"><ele>12</ele><name>Start</name></wpt>
    <trk><name>Jalur</name><trkseg><trkpt lat="-6.2" lon="106.8"/><trkpt lat="-6.3" lon="106.9"/></trkseg></trk></gpx>`);
  assert.deepEqual(d.features.map((f) => f.geometry.type), ["Point", "LineString"]);
  assert.deepEqual(d.features[0].geometry.coordinates, [106.8, -6.2, 12]);
  assert.equal(d.features[1].properties.name, "Jalur");
});

test("CSV: quotes, semicolons, comma decimals and leading-zero codes", () => {
  const d = GC.fromCSV('\uFEFFnama;kode;Lintang;Bujur;catatan\r\n"Kota ""A""";007;-6,2;106,8;"baris\nbaru"\r\nB;010;-6.3;106.9;\r\nTanpa;011;;;\r\n');
  assert.equal(d.features.length, 3);
  assert.deepEqual(d.features[0].geometry.coordinates, [106.8, -6.2]);
  assert.equal(d.features[0].properties.nama, 'Kota "A"');
  assert.equal(d.features[0].properties.kode, "007");
  assert.equal(d.features[0].properties.catatan, "baris\nbaru");
  assert.equal(d.features[2].geometry, null);
  assert.throws(() => GC.fromCSV("a,b\n1,2\n"), /no coordinate columns/);
});

test("CSV: WKT column and round trip", async () => {
  const d = GC.fromGeoJSON(SAMPLE);
  const out = await GC.write(d, "csv", "x");
  const csv = await text(out);
  assert.ok(csv.startsWith("\uFEFFnama,luas_ha,kode,aktif,WKT\r\n"));
  const back = GC.fromCSV(csv);
  assert.deepEqual(back.features.map((f) => f.geometry), d.features.map((f) => f.geometry));
  assert.equal(back.features[0].properties.luas_ha, 1250.5);

  const pts = GC.fromCSV("id,longitude,latitude\n1,106.8,-6.2\n");
  const csv2 = await text(await GC.write(pts, "csv", "p"));
  assert.equal(csv2, "\uFEFFid,longitude,latitude\r\n1,106.8,-6.2\r\n");
});

test("WKT parser", () => {
  assert.deepEqual(GC.parseWkt("POINT (106.8 -6.2)"), { type: "Point", coordinates: [106.8, -6.2] });
  assert.deepEqual(GC.parseWkt("SRID=4326;POINT Z (1 2 3)"), { type: "Point", coordinates: [1, 2] });
  assert.deepEqual(GC.parseWkt("MULTIPOINT (1 2, 3 4)").coordinates, [[1, 2], [3, 4]]);
  assert.deepEqual(GC.parseWkt("MULTIPOINT ((1 2), (3 4))").coordinates, [[1, 2], [3, 4]]);
  assert.equal(GC.parseWkt("GEOMETRYCOLLECTION (POINT (1 2), LINESTRING (0 0, 1 1))").geometries.length, 2);
  assert.equal(GC.parseWkt("POINT EMPTY"), null);
  assert.equal(GC.parseWkt("nonsense"), null);
});

test("read: zipped shapefile, KMZ and loose files", async () => {
  const d = GC.fromGeoJSON(SAMPLE);
  const shpZip = new Blob((await GC.write(d, "shp", "desa")).parts);
  const a = await GC.read([new File([shpZip], "desa.zip")], { maxBytes: MB });
  assert.equal(a.format, "Shapefile");
  assert.equal(a.features.length, 2);
  await assert.rejects(GC.read([new File([shpZip], "desa.zip")], { maxBytes: 100 }), /too large/);

  const kml = await text(await GC.write(d, "kml", "desa"));
  const kmz = new Blob(await GC.zip([{ name: "doc.kml", data: new TextEncoder().encode(kml) }]));
  const b = await GC.read([new File([kmz], "desa.kmz")]);
  assert.equal(b.format, "KMZ");
  assert.equal(b.features.length, 2);

  const files = await unzip(await bytes(await GC.write(d, "shp", "desa")));
  const c = await GC.read(["shp", "dbf", "prj"].map((x) => new File([files["desa." + x]], "desa." + x)));
  assert.equal(c.features.length, 2);
});

test("GeoJSON output is valid JSON with every feature", async () => {
  const d = GC.fromGeoJSON(SAMPLE);
  const gj = JSON.parse(await text(await GC.write(d, "geojson", "out")));
  assert.equal(gj.type, "FeatureCollection");
  assert.deepEqual(gj.features.map((f) => f.properties), SAMPLE.features.map((f) => f.properties));
});
