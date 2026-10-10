"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const GT = require("../public/assets/js/geotiff");

// ---------- helper: write small GeoTIFFs in memory ----------
// opts: width, height, bands (arrays of numbers, row-major), bits, format
// (1 uint, 2 int, 3 float), tile ([w, h]) or rowsPerStrip, compression
// (1 none, 8 deflate, 32773 packbits), predictor, planar, bigEndian, big
// (BigTIFF), epsg, geographic, tie [x, y], scale [sx, sy], nodata, names.
function tiff(o) {
  const le = !o.bigEndian, big = !!o.big, bits = o.bits || 16, fmt = o.format || 1, size = bits / 8;
  const W = o.width, H = o.height, n = o.bands.length, planar = o.planar || 1;
  const tw = o.tile ? o.tile[0] : W, th = o.tile ? o.tile[1] : (o.rowsPerStrip || H);
  const across = Math.ceil(W / tw), down = Math.ceil(H / th);
  const write = (buf, off, v) => {
    if (fmt === 3) return bits === 32 ? buf[le ? "writeFloatLE" : "writeFloatBE"](v, off) : buf[le ? "writeDoubleLE" : "writeDoubleBE"](v, off);
    if (bits === 8) return fmt === 2 ? buf.writeInt8(v, off) : buf.writeUInt8(v, off);
    const name = (fmt === 2 ? "writeInt" : "writeUInt") + bits + (le ? "LE" : "BE");
    return buf[name](v, off);
  };
  const chunks = [];
  for (let p = 0; p < (planar === 2 ? n : 1); p++) {
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) {
        const rows = o.tile ? th : Math.min(th, H - ty * th), spp = planar === 2 ? 1 : n;
        const vals = [];
        for (let r = 0; r < rows; r++) {
          const row = [];
          for (let c = 0; c < tw; c++) {
            const x = tx * tw + c, y = ty * th + r;
            for (let s = 0; s < spp; s++) {
              const b = planar === 2 ? p : s;
              row.push(x < W && y < H ? o.bands[b][y * W + x] : 0);
            }
          }
          if (o.predictor === 2) for (let i = row.length - 1; i >= spp; i--) row[i] = (row[i] - row[i - spp] + 2 ** bits) % 2 ** bits;
          vals.push(...row);
        }
        let raw = Buffer.alloc(vals.length * size);
        vals.forEach((v, i) => write(raw, i * size, v));
        if (o.compression === 8) raw = zlib.deflateSync(raw);
        if (o.compression === 32773) raw = packbits(raw);
        chunks.push(raw);
      }
    }
  }
  // Tags: [tag, type, values]
  const tags = [
    [256, 4, [W]], [257, 4, [H]], [258, 3, Array(n).fill(bits)], [259, 3, [o.compression || 1]],
    [262, 3, [1]], [277, 3, [n]], [284, 3, [planar]], [339, 3, Array(n).fill(fmt)],
  ];
  if (o.predictor) tags.push([317, 3, [o.predictor]]);
  if (o.tile) tags.push([322, 3, [tw]], [323, 3, [th]]);
  else tags.push([278, 4, [th]]);
  tags.push([o.tile ? 324 : 273, big ? 16 : 4, chunks.map(() => 0)], [o.tile ? 325 : 279, 4, chunks.map((c) => c.length)]);
  tags.push([33550, 12, [o.scale[0], o.scale[1], 0]], [33922, 12, [0, 0, 0, o.tie[0], o.tie[1], 0]]);
  tags.push([34735, 3, o.geographic ? [1, 1, 0, 1, 1024, 0, 1, 2] : [1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, o.epsg]]);
  if (o.nodata != null) tags.push([42113, 2, String(o.nodata) + "\0"]);
  if (o.names) {
    tags.push([42112, 2, "<GDALMetadata>" + o.names.map((s, i) => '<Item name="DESCRIPTION" sample="' + i + '" role="description">' + s + "</Item>").join("") + "</GDALMetadata>\0"]);
  }
  tags.sort((a, b) => a[0] - b[0]);
  const TS = { 2: 1, 3: 2, 4: 4, 12: 8, 16: 8 };
  const head = big ? 16 : 8, entry = big ? 20 : 12, inline = big ? 8 : 4;
  const ifdSize = (big ? 8 : 2) + tags.length * entry + (big ? 8 : 4);
  let far = head + ifdSize;
  const layout = tags.map(([tag, type, v]) => {
    const len = (type === 2 ? v.length : v.length) * TS[type];
    const at = len > inline ? far : -1;
    if (at >= 0) far += len + (len % 2);
    return { tag, type, v, len, at };
  });
  let dataAt = far;
  const offsets = chunks.map((c) => { const o2 = dataAt; dataAt += c.length; return o2; });
  layout.forEach((e) => { if (e.tag === 273 || e.tag === 324) e.v = offsets; });
  const buf = Buffer.alloc(dataAt);
  buf.write(le ? "II" : "MM", 0, "latin1");
  const u16 = (v, off) => buf[le ? "writeUInt16LE" : "writeUInt16BE"](v, off);
  const u32 = (v, off) => buf[le ? "writeUInt32LE" : "writeUInt32BE"](v, off);
  const u64 = (v, off) => buf[le ? "writeBigUInt64LE" : "writeBigUInt64BE"](BigInt(v), off);
  if (big) { u16(43, 2); u16(8, 4); u16(0, 6); u64(head, 8); } else { u16(42, 2); u32(head, 4); }
  let p = head;
  if (big) { u64(tags.length, p); p += 8; } else { u16(tags.length, p); p += 2; }
  const writeVals = (e, off) => {
    if (e.type === 2) { buf.write(e.v, off, "latin1"); return; }
    e.v.forEach((x, i) => {
      const q = off + i * TS[e.type];
      if (e.type === 3) u16(x, q);
      else if (e.type === 4) u32(x, q);
      else if (e.type === 16) u64(x, q);
      else buf[le ? "writeDoubleLE" : "writeDoubleBE"](x, q);
    });
  };
  layout.forEach((e) => {
    u16(e.tag, p); u16(e.type, p + 2);
    const count = e.type === 2 ? e.v.length : e.v.length;
    if (big) u64(count, p + 4); else u32(count, p + 4);
    const vAt = p + (big ? 12 : 8);
    if (e.at >= 0) { if (big) u64(e.at, vAt); else u32(e.at, vAt); writeVals(e, e.at); } else writeVals(e, vAt);
    p += entry;
  });
  chunks.forEach((c, i) => c.copy(buf, offsets[i]));
  return new Uint8Array(buf);
}

function packbits(b) {
  const out = [];
  for (let i = 0; i < b.length; i += 128) {
    const part = b.subarray(i, i + 128);
    out.push(part.length - 1, ...part);
  }
  return Buffer.from(out);
}

const W = 37, H = 23;
const ramp = (k) => Array.from({ length: W * H }, (_, i) => (i * 7 + k * 101) % 4000);

async function decode(o) {
  const info = await GT.open(tiff(o));
  return { info, grid: await GT.readGrid(info) };
}

// ---------- tests ----------
const base = { width: W, height: H, bands: [ramp(0), ramp(1), ramp(2)], epsg: 32748, tie: [692760, 9327430], scale: [10, 10] };
const variants = {
  "uncompressed strips": {},
  "deflate + predictor, tiled": { compression: 8, predictor: 2, tile: [16, 16] },
  "packbits, 3-row strips": { compression: 32773, rowsPerStrip: 3 },
  "planar, tiled": { planar: 2, tile: [16, 16], compression: 8 },
  "big-endian": { bigEndian: true, compression: 8, predictor: 2 },
  "BigTIFF": { big: true, tile: [16, 16] },
  "float32": { bits: 32, format: 3 },
  "int16": { format: 2, bands: [ramp(0).map((v) => v - 2000), ramp(1), ramp(2)] },
};
for (const [name, extra] of Object.entries(variants)) {
  test("decodes " + name, async () => {
    const o = { ...base, ...extra };
    const { info, grid } = await decode(o);
    assert.equal(grid.width, W);
    assert.equal(grid.height, H);
    assert.equal(info.bands.length, 3);
    for (let b = 0; b < 3; b++) assert.deepEqual(Array.from(grid.bands[b]), o.bands[b]);
    assert.deepEqual(grid.transform, [692760, 10, 0, 9327430, 0, -10]);
    assert.equal(info.crs.name, "WGS 84 / UTM 48S");
  });
}

test("nodata becomes NaN and band names are read", async () => {
  const band = ramp(0);
  band[5] = -9999;
  const { info, grid } = await decode({ ...base, bands: [band], format: 2, nodata: -9999, names: ["Elevasi"], geographic: true, tie: [110, -7], scale: [0.001, 0.001] });
  assert.ok(Number.isNaN(grid.bands[0][5]));
  assert.equal(grid.bands[0][6], band[6]);
  assert.equal(info.bands[0].name, "Elevasi");
  assert.equal(info.crs.name, "WGS 84 (bujur/lintang)");
});

test("large images are sampled down to the display limit", async () => {
  const w = 3000, h = 20, band = Array.from({ length: w * h }, (_, i) => i % w);
  const info = await GT.open(tiff({ width: w, height: h, bands: [band], epsg: 32748, tie: [0, 0], scale: [1, 1], tile: [512, 16], compression: 8 }));
  const grid = await GT.readGrid(info);
  assert.equal(grid.width, 2048);
  assert.equal(grid.height, 14);
  // Nearest neighbour: grid column i samples source column floor((i + 0.5) * w / gw).
  for (const i of [0, 1, 1000, 2047]) assert.equal(grid.bands[0][i], Math.floor((i + 0.5) * w / 2048));
  assert.ok(Math.abs(grid.transform[1] - w / 2048) < 1e-12);
});

test("rejects files without georeferencing or with unsupported projections", async () => {
  await assert.rejects(GT.open(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /not a TIFF/);
  await assert.rejects(GT.open(tiff({ ...base, epsg: 3395 })), /EPSG:3395 is not supported/);
});

test("LZW decoder handles the KwKwK case and code width changes", () => {
  // TIFF LZW encoder (MSB-first, early change), to round-trip through the decoder.
  function encode(data) {
    const out = []; let acc = 0, nbits = 0, width = 9;
    const put = (code) => { acc = (acc << width) | code; nbits += width; while (nbits >= 8) { out.push((acc >> (nbits - 8)) & 255); nbits -= 8; } acc &= (1 << nbits) - 1; };
    let dict = new Map(), next = 258;
    put(256);
    let w = String.fromCharCode(data[0]);
    for (let i = 1; i < data.length; i++) {
      const c = String.fromCharCode(data[i]), wc = w + c;
      if (dict.has(wc) || wc.length === 1) { w = wc; continue; }
      put(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
      dict.set(wc, next++);
      if (next >= (1 << width) && width < 12) width++;
      if (next >= 4094) { put(256); dict = new Map(); next = 258; width = 9; }
      w = c;
    }
    put(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
    put(257);
    if (nbits) out.push((acc << (8 - nbits)) & 255);
    return new Uint8Array(out);
  }
  const data = new Uint8Array(20000);
  for (let i = 0; i < data.length; i++) data[i] = i < 500 ? 65 : (i * 31 + (i >> 7)) % 251;
  assert.deepEqual(GT.lzw(encode(data), data.length), data);
});

test("transverse Mercator forward matches PROJ", () => {
  // Reference values from PROJ (pyproj) for EPSG:32748 and EPSG:23834 (DGN95 / Indonesia TM-3 48.2).
  const utm = GT.epsg(32748).fromLonLat(106.82, -6.2);
  assert.ok(Math.abs(utm[0] - 701377.0452) < 0.01 && Math.abs(utm[1] - 9314341.4066) < 0.01, utm.join());
  const tm3 = GT.epsg(23834);
  const p = tm3.fromLonLat(106.82, -6.2), back = tm3.toLonLat(p[0], p[1]);
  assert.ok(Math.abs(back[0] - 106.82) < 1e-8 && Math.abs(back[1] + 6.2) < 1e-8);
  assert.match(tm3.name, /TM-3 48\.2/);
});

test("rendering: RGB stretch, ramps, index, nodata transparency", () => {
  const grid = { width: 2, height: 1, bands: [new Float32Array([0, 100]), new Float32Array([50, NaN]), new Float32Array([100, 0])] };
  const rgba = new Uint8ClampedArray(8);
  GT.render(grid, { mode: "rgb", bands: [0, 1, 2], ranges: [[0, 100], [0, 100], [0, 100]] }, rgba);
  assert.deepEqual(Array.from(rgba.slice(0, 4)), [0, 127, 255, 255]);
  assert.equal(rgba[7], 0, "NaN in any channel is transparent");
  const nd = GT.normalizedDifference(grid.bands[2], grid.bands[0]);
  assert.deepEqual(Array.from(nd), [1, -1]);
  GT.render(grid, { mode: "index", values: nd, min: -1, max: 1, ramp: "gray" }, rgba);
  assert.deepEqual(Array.from(rgba), [255, 255, 255, 255, 0, 0, 0, 255]);
  GT.render(grid, { mode: "index", values: nd, min: -1, max: 1, ramp: "gray", reverse: true }, rgba);
  assert.equal(rgba[0], 0);
});

test("Web Mercator lookup covers the raster and matches gridIndexAt", async () => {
  const { info, grid } = await decode(base);
  const lk = GT.mercatorLookup(grid, info.crs);
  const inside = lk.lookup.filter((i) => i >= 0).length;
  assert.ok(inside > 0.8 * W * H, "most output pixels land on the raster");
  const [[s, w], [n, e]] = lk.bounds;
  const lon = (w + e) / 2, lat = (s + n) / 2;
  assert.ok(GT.gridIndexAt(grid, info.crs, lon, lat) >= 0);
  assert.equal(GT.gridIndexAt(grid, info.crs, lon + 1, lat), -1);
});

test("the sample Sentinel-2 file decodes with its band names", async () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, "../public/data/contoh-sentinel2-jakarta.tif")));
  const info = await GT.open(bytes);
  const grid = await GT.readGrid(info);
  assert.equal(grid.width, 512);
  assert.deepEqual(info.bands.map((b) => b.name), ["B2 Biru", "B3 Hijau", "B4 Merah", "B8 NIR"]);
  assert.deepEqual(GT.guessBands(info.bands.map((b) => b.name)), { blue: 0, green: 1, red: 2, nir: 3 });
  // Pixel at 106.75269 E, 6.11004 S, checked against GDAL.
  const i = GT.gridIndexAt(grid, info.crs, 106.75269, -6.11004);
  assert.deepEqual(grid.bands.map((b) => b[i]), [980, 1082, 1580, 2562]);
});

test("a window of the image is read at full resolution with its own transform", async () => {
  const w = 3000, h = 40, band = Array.from({ length: w * h }, (_, i) => (i % w) + 10000 * Math.floor(i / w));
  const info = await GT.open(tiff({ width: w, height: h, bands: [band], bits: 32, epsg: 32748, tie: [500000, 9300000], scale: [10, 10], tile: [256, 16], compression: 8 }));
  const box = [info.crs.toLonLat(500000 + 1000 * 10, 9300000 - 30 * 10), info.crs.toLonLat(500000 + 1500 * 10, 9300000 - 5 * 10)];
  const win = GT.pixelWindow(info, [box[0][0], box[0][1], box[1][0], box[1][1]]);
  assert.ok(Math.abs(win[0] - 1000) <= 1 && Math.abs(win[2] - 1500) <= 1 && Math.abs(win[1] - 5) <= 1 && Math.abs(win[3] - 30) <= 1, win.join());
  const grid = await GT.readGrid(info, { window: [1000, 5, 1500, 30] });
  assert.equal(grid.width, 500);
  assert.equal(grid.height, 25);
  assert.equal(grid.bands[0][0], 1000 + 10000 * 5);
  assert.equal(grid.bands[0][24 * 500 + 499], 1499 + 10000 * 29);
  assert.deepEqual(grid.transform, [510000, 10, 0, 9299950, 0, -10]);
  assert.equal(GT.pixelWindow(info, [0, 0, 1, 1]), null);
});
