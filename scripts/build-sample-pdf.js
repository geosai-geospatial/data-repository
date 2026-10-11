// Builds public/data/contoh-peta.pdf, the sample for the PDF map extractor
// (ekstrak-pdf.html): a small A4 map of Bali and Lombok in UTM zone 50 S, in
// the style of Indonesian thematic maps. It has what real map PDFs have:
//
// - a picture of the map (land, sea, and three coloured "hazard" zones by
//   distance to the coast: fictional data, said so on the map),
// - vector coastlines (Natural Earth, public domain, from data/basemap.json),
// - grid crosses every 20 km with labelled coordinates on the frame,
// - town symbols, text labels, and a legend with the zone colours.
//
// It is not a GeoPDF: the visitor georeferences it from the grid.
//
//   node scripts/build-sample-pdf.js
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const SM = require("../public/assets/js/staticmap");
const GT = require("../public/assets/js/geotiff");

const OUT = path.join(__dirname, "..", "public", "data", "contoh-peta.pdf");
const basemap = require("../public/data/basemap.json");

// UTM 50 S
const UTM = { lon0: 117, lat0: 0, k0: 0.9996, fe: 500000, fn: 10000000 };
const toLonLat = SM.tmInverse(UTM), fromLonLat = GT.tmForward(UTM);

// Map extent (metres) and where it sits on the page (points, A4 landscape).
const EXT = [200000, 9000000, 420000, 9130000];
const PAGE = [842, 595];
const FRAME = [36, 120, 636, 120 + 600 * (EXT[3] - EXT[1]) / (EXT[2] - EXT[0])];
const K = (FRAME[2] - FRAME[0]) / (EXT[2] - EXT[0]); // points per metre
function toPage(x, y) { return [FRAME[0] + (x - EXT[0]) * K, FRAME[1] + (y - EXT[1]) * K]; }
const GRID = 20000;

// ---------- Land polygons near the map, in UTM ----------
const SCALE = basemap.scale;
const box = (() => { // lon/lat box of the extent, with a margin
  const c = [[EXT[0], EXT[1]], [EXT[2], EXT[1]], [EXT[0], EXT[3]], [EXT[2], EXT[3]]].map((p) => toLonLat(p[0], p[1]));
  return [Math.min(...c.map((p) => p[0])) - 0.2, Math.min(...c.map((p) => p[1])) - 0.2, Math.max(...c.map((p) => p[0])) + 0.2, Math.max(...c.map((p) => p[1])) + 0.2];
})();
const rings = [];
basemap.countries.forEach((c) => {
  c.rings.forEach((flat) => {
    const r = [];
    for (let i = 0; i < flat.length; i += 2) r.push([flat[i] / SCALE, flat[i + 1] / SCALE]);
    const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
    if (Math.max(...xs) < box[0] || Math.min(...xs) > box[2] || Math.max(...ys) < box[1] || Math.min(...ys) > box[3]) return;
    rings.push(r.map((p) => fromLonLat(p[0], p[1])));
  });
});
function inLand(x, y) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
  }
  return inside;
}

// ---------- The map picture ----------
// Land grey, sea blue (lighter near the coast), and on land three zones by
// distance to the sea: < 2 km, 2–5 km, 5–8 km (fictional "hazard").
const IW = 900, IH = Math.round(IW * (FRAME[3] - FRAME[1]) / (FRAME[2] - FRAME[0]));
const PX = (EXT[2] - EXT[0]) / IW; // metres per pixel
const land = new Uint8Array(IW * IH);
for (let r = 0; r < IH; r++) {
  for (let c = 0; c < IW; c++) land[r * IW + c] = inLand(EXT[0] + (c + 0.5) * PX, EXT[3] - (r + 0.5) * PX) ? 1 : 0;
}
// Distance (pixels) to the other kind of pixel: two-pass chamfer transform.
function distance(target) {
  const d = new Float32Array(IW * IH).fill(1e9);
  for (let i = 0; i < d.length; i++) if (land[i] !== target) d[i] = 0;
  const S = Math.SQRT2;
  for (let r = 0; r < IH; r++) {
    for (let c = 0; c < IW; c++) {
      const i = r * IW + c;
      if (c > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
      if (r > 0) {
        d[i] = Math.min(d[i], d[i - IW] + 1);
        if (c > 0) d[i] = Math.min(d[i], d[i - IW - 1] + S);
        if (c < IW - 1) d[i] = Math.min(d[i], d[i - IW + 1] + S);
      }
    }
  }
  for (let r = IH - 1; r >= 0; r--) {
    for (let c = IW - 1; c >= 0; c--) {
      const i = r * IW + c;
      if (c < IW - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
      if (r < IH - 1) {
        d[i] = Math.min(d[i], d[i + IW] + 1);
        if (c < IW - 1) d[i] = Math.min(d[i], d[i + IW + 1] + S);
        if (c > 0) d[i] = Math.min(d[i], d[i + IW - 1] + S);
      }
    }
  }
  return d;
}
const toSea = distance(1), toLandFromSea = distance(0);
const ZONES = [
  { name: "Tinggi", note: "< 2 km dari pantai", max: 2000, rgb: [230, 57, 70] },
  { name: "Sedang", note: "2 - 5 km", max: 5000, rgb: [247, 167, 59] },
  { name: "Rendah", note: "5 - 8 km", max: 8000, rgb: [168, 214, 120] },
];
let seed = 7;
function rand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const rgb = Buffer.alloc(IW * IH * 3);
for (let i = 0; i < IW * IH; i++) {
  let c;
  const jitter = Math.round((rand() - 0.5) * 8);
  if (land[i]) {
    const m = toSea[i] * PX, z = ZONES.find((zz) => m < zz.max);
    c = z ? z.rgb : [214, 214, 210];
  } else {
    const m = toLandFromSea[i] * PX;
    c = m < 4000 ? [206, 236, 245] : m < 15000 ? [172, 216, 236] : [140, 190, 225];
  }
  rgb[i * 3] = Math.max(0, Math.min(255, c[0] + jitter));
  rgb[i * 3 + 1] = Math.max(0, Math.min(255, c[1] + jitter));
  rgb[i * 3 + 2] = Math.max(0, Math.min(255, c[2] + jitter));
}

// ---------- Content stream ----------
const ops = [];
const n = (v) => (Math.round(v * 100) / 100).toString();
function text(font, size, x, y, s, rot) {
  const t = rot ? "0 1 -1 0 " + n(x) + " " + n(y) : "1 0 0 1 " + n(x) + " " + n(y);
  ops.push("BT /" + font + " " + size + " Tf " + t + " Tm (" + s.replace(/[()\\]/g, "\\$&") + ") Tj ET");
}
function width(s, size) { return s.length * size * 0.5; } // rough, for centring

// Picture, clipped to the frame.
ops.push("q " + n(FRAME[0]) + " " + n(FRAME[1]) + " " + n(FRAME[2] - FRAME[0]) + " " + n(FRAME[3] - FRAME[1]) + " re W n");
ops.push("q " + n(FRAME[2] - FRAME[0]) + " 0 0 " + n(FRAME[3] - FRAME[1]) + " " + n(FRAME[0]) + " " + n(FRAME[1]) + " cm /Im1 Do Q");
// Coastline (vector).
ops.push("0 0.42 0.75 RG 0.6 w 1 j");
rings.forEach((r) => {
  const pts = r.map((p) => toPage(p[0], p[1]));
  ops.push(n(pts[0][0]) + " " + n(pts[0][1]) + " m " + pts.slice(1).map((p) => n(p[0]) + " " + n(p[1]) + " l").join(" ") + " h S");
});
// Grid crosses.
ops.push("0 0 0 RG 0.3 w");
for (let x = Math.ceil(EXT[0] / GRID) * GRID; x < EXT[2]; x += GRID) {
  for (let y = Math.ceil(EXT[1] / GRID) * GRID; y < EXT[3]; y += GRID) {
    if (x === EXT[0] || y === EXT[1]) continue;
    const p = toPage(x, y);
    ops.push(n(p[0] - 4) + " " + n(p[1]) + " m " + n(p[0] + 4) + " " + n(p[1]) + " l " + n(p[0]) + " " + n(p[1] - 4) + " m " + n(p[0]) + " " + n(p[1] + 4) + " l S");
  }
}
// Towns.
const TOWNS = [["Denpasar", 115.2167, -8.65], ["Singaraja", 115.0883, -8.112], ["Mataram", 116.1167, -8.5833], ["Amlapura", 115.6167, -8.45]];
TOWNS.forEach((t) => {
  const p = toPage(...fromLonLat(t[1], t[2]));
  ops.push("1 1 1 RG 0.8 w 0.85 0.1 0.15 rg " + n(p[0] - 2.5) + " " + n(p[1] - 2.5) + " 5 5 re B");
  ops.push("0.1 0.1 0.1 rg");
  text("F1", 8, p[0] + 5, p[1] + 3, t[0]);
});
// Water names.
ops.push("0.05 0.45 0.7 rg");
text("F3", 10, toPage(255000, 9105000)[0], toPage(255000, 9105000)[1], "L A U T   B A L I");
text("F3", 10, toPage(235000, 9012000)[0], toPage(235000, 9012000)[1], "S A M U D E R A   H I N D I A");
text("F3", 8, toPage(375000, 9040000)[0], toPage(375000, 9040000)[1], "SELAT LOMBOK", true);
ops.push("Q");

// Frame and grid labels.
ops.push("0 0 0 RG 0.9 w " + n(FRAME[0]) + " " + n(FRAME[1]) + " " + n(FRAME[2] - FRAME[0]) + " " + n(FRAME[3] - FRAME[1]) + " re S");
ops.push("0 0 0 rg 0.6 w");
for (let x = Math.ceil(EXT[0] / GRID) * GRID; x <= EXT[2]; x += GRID) {
  const p = toPage(x, EXT[1]);
  if (x === EXT[0] || x === EXT[2]) continue;
  ops.push(n(p[0]) + " " + n(FRAME[1]) + " m " + n(p[0]) + " " + n(FRAME[1] - 4) + " l S");
  ops.push(n(p[0]) + " " + n(FRAME[3]) + " m " + n(p[0]) + " " + n(FRAME[3] + 4) + " l S");
  text("F1", 6.5, p[0] - width(String(x), 6.5) / 2, FRAME[1] - 12, String(x));
  text("F1", 6.5, p[0] - width(String(x), 6.5) / 2, FRAME[3] + 7, String(x));
}
for (let y = Math.ceil(EXT[1] / GRID) * GRID; y <= EXT[3]; y += GRID) {
  const p = toPage(EXT[0], y);
  if (y === EXT[1] || y === EXT[3]) continue;
  ops.push(n(FRAME[0]) + " " + n(p[1]) + " m " + n(FRAME[0] - 4) + " " + n(p[1]) + " l S");
  ops.push(n(FRAME[2]) + " " + n(p[1]) + " m " + n(FRAME[2] + 4) + " " + n(p[1]) + " l S");
  text("F1", 6.5, FRAME[0] - 7, p[1] - width(String(y), 6.5) / 2, String(y), true);
  text("F1", 6.5, FRAME[2] + 12, p[1] - width(String(y), 6.5) / 2, String(y), true);
}

// Side panel: title, legend, notes.
const X = 660;
ops.push("0 0 0 rg");
text("F2", 13, X, 540, "PETA CONTOH");
text("F2", 13, X, 524, "ZONA RAWAN PESISIR");
text("F1", 9, X, 508, "Bali dan Lombok");
ops.push("0.5 w 0.6 0.6 0.6 RG " + X + " 496 m 810 496 l S");
text("F2", 9, X, 480, "Legenda");
text("F1", 8, X, 466, "Zona rawan (data fiktif)");
ZONES.forEach((z, i) => {
  const y = 446 - i * 20;
  ops.push(z.rgb.map((v) => n(v / 255)).join(" ") + " rg 0.3 0.3 0.3 RG 0.4 w " + X + " " + y + " 26 13 re B");
  ops.push("0 0 0 rg");
  text("F2", 8, X + 34, y + 6.5, z.name);
  text("F1", 7, X + 34, y - 1, z.note);
});
ops.push("0 0.42 0.75 RG 0.6 w " + X + " 381 m " + (X + 26) + " 381 l S 0 0 0 rg");
text("F1", 8, X + 34, 378, "Garis pantai");
ops.push("0.85 0.1 0.15 rg 1 1 1 RG 0.8 w " + (X + 10) + " 358 5 5 re B 0 0 0 rg");
text("F1", 8, X + 34, 358, "Kota");
ops.push("0 0 0 RG 0.3 w " + (X + 9) + " 340 m " + (X + 17) + " 340 l " + (X + 13) + " 336 m " + (X + 13) + " 344 l S");
text("F1", 8, X + 34, 337, "Grid UTM");
ops.push("0.5 w 0.6 0.6 0.6 RG " + X + " 322 m 810 322 l S 0 0 0 rg");
[
  ["F2", "Sistem koordinat"], ["F1", "UTM Zona 50 S, datum WGS 84"], ["F1", "Interval grid 20.000 meter"], ["F1", "Skala ±1 : 1.040.000 (A4)"], ["F1", ""],
  ["F2", "Sumber"], ["F1", "Garis pantai: Natural Earth"], ["F1", "(domain publik)"], ["F1", "Zona rawan: data fiktif untuk"], ["F1", "mencoba alat Ekstrak PDF GeoSAI."],
  ["F1", "Bukan peta resmi."],
].forEach((l, i) => text(l[0], 7.5, X, 308 - i * 11, l[1]));
text("F1", 7, 36, 92, "Contoh untuk ekstrak-pdf.html - GeoSAI. Silakan dipakai dan dibagikan.");

const content = zlib.deflateSync(Buffer.from(ops.join("\n"), "latin1"), { level: 9 });
const image = zlib.deflateSync(rgb, { level: 9 });

// ---------- PDF file ----------
const objs = [];
objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + PAGE[0] + " " + PAGE[1] + "] /Contents 4 0 R " +
  "/Resources << /Font << /F1 6 0 R /F2 7 0 R /F3 8 0 R >> /XObject << /Im1 5 0 R >> >> >>";
objs[4] = { dict: "<< /Length " + content.length + " /Filter /FlateDecode >>", data: content };
objs[5] = { dict: "<< /Type /XObject /Subtype /Image /Width " + IW + " /Height " + IH + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length " + image.length + " /Filter /FlateDecode >>", data: image };
objs[6] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
objs[7] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
objs[8] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique /Encoding /WinAnsiEncoding >>";
objs[9] = "<< /Title (Peta contoh zona rawan pesisir - Bali dan Lombok) /Author (GeoSAI) /Producer (scripts/build-sample-pdf.js) >>";

const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")], offsets = [];
let size = parts[0].length;
for (let i = 1; i < objs.length; i++) {
  offsets[i] = size;
  const o = objs[i];
  const buf = typeof o === "string" ? Buffer.from(i + " 0 obj\n" + o + "\nendobj\n", "latin1") :
    Buffer.concat([Buffer.from(i + " 0 obj\n" + o.dict + "\nstream\n", "latin1"), o.data, Buffer.from("\nendstream\nendobj\n", "latin1")]);
  parts.push(buf);
  size += buf.length;
}
let xref = "xref\n0 " + objs.length + "\n0000000000 65535 f \n";
for (let i = 1; i < objs.length; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
xref += "trailer\n<< /Size " + objs.length + " /Root 1 0 R /Info 9 0 R >>\nstartxref\n" + size + "\n%%EOF\n";
parts.push(Buffer.from(xref, "latin1"));
fs.writeFileSync(OUT, Buffer.concat(parts));
console.log("Wrote " + path.relative(process.cwd(), OUT) + " (" + Math.round(fs.statSync(OUT).size / 1024) + " KB, " + rings.length + " coastline rings, picture " + IW + "×" + IH + ")");
