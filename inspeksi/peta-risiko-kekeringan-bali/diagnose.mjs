// Runs the PDF extractor's colour-class pipeline (public/assets/js/pdfgeo.js:
// colorTable → classify → removeThin → sieve → polygonize, the same steps the
// page's worker runs) on the BNPB drought risk map of Bali, for the ways a
// visitor would pick colours, and for a hue-based alternative. Prints how much
// of the land each class covers and writes the GeoJSON of each run.
//
// pdf.js cannot draw in Node, so the map area is rendered by poppler
// (pdftoppm) at the PDF's own picture resolution, 200 dpi.
//
//   node inspeksi/peta-risiko-kekeringan-bali/diagnose.mjs <file.pdf> [out-dir]
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const PG = createRequire(import.meta.url)(path.join(repo, "public/assets/js/pdfgeo.js"));
const dir = path.join(repo, "public/assets/vendor/pdfjs");
const log = console.log;
console.log = (...a) => { if (!/^Warning: /.test(String(a[0]))) log(...a); }; // no canvas in Node
const lib = await import(pathToFileURL(path.join(dir, "pdf.min.mjs")).href);
lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(dir, "pdf.worker.min.mjs")).href;

const [pdf, outDir = path.join(here, "hasil")] = process.argv.slice(2);
if (!pdf) { console.error("usage: node diagnose.mjs <file.pdf> [out-dir]"); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

// ---- Georeferencing (same template as the volcano map: see ../peta-risiko-letusan-bali)
const doc = await lib.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)), isEvalSupported: false, verbosity: 0 }).promise;
const page = await doc.getPage(1);
const oc = await doc.getOptionalContentConfig();
const got = PG.extractPaths(await page.getOperatorList(), lib.OPS, (p) => oc.isVisible(p));
const nodes = PG.findGridNodes(got.paths, page.view);
const lattice = PG.latticeSpacing(nodes);
const frame = PG.findFrame(got.paths, got.images, page.view, nodes);
const dpi = PG.imageDpi(got.images, frame);
const cross = (x, y) => nodes.find((n) => Math.abs(n[0] - x) < 1 && Math.abs(n[1] - y) < 1);
const sw = cross(400.2, 346.5), ne = cross(2065.2, 1595.4);
const typed = [{ px: sw[0], py: sw[1], x: 230000, y: 9020000 }, { px: ne[0], py: ne[1], x: 350000, y: 9110000 }];
const iv = PG.niceInterval(Math.min(lattice.x, lattice.y) * PG.fitScale(PG.fit(typed)), false);
const done = PG.completeGrid(typed, nodes, iv);
const toLL = PG.projector(done.fit.m, PG.crs(32750));
const pageH = page.view[3];
log("frame (pt)", frame.map((v) => +v.toFixed(1)), "· picture", dpi, "dpi");
log("fit", done.fit.points ?? "", "crosses", done.points.length, "· RMSE", done.fit.rmse.toFixed(1), "m");
await doc.destroy();

// ---- Pixels: the map area at the picture's resolution (what the page's default 200 dpi gives)
const s = dpi / 72, MM_PER_PT = 25.4 / 72;
const W = Math.round((frame[2] - frame[0]) * s), H = Math.round((frame[3] - frame[1]) * s);
function render(x0pt, ytop, w, h) { // page pt (x, y down from the top) → RGBA
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kekeringan-"));
  execFileSync("pdftoppm", ["-r", String(dpi), "-x", String(Math.round(x0pt * s)), "-y", String(Math.round(ytop * s)),
    "-W", String(w), "-H", String(h), "-singlefile", pdf, path.join(tmp, "a")]);
  const ppm = fs.readFileSync(path.join(tmp, "a.ppm"));
  fs.rmSync(tmp, { recursive: true });
  const head = ppm.subarray(0, 40).toString("latin1").match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
  if (!head) throw new Error("pdftoppm: unexpected output");
  const o = head[0].length, pw = Number(head[1]), ph = Number(head[2]), rgba = new Uint8ClampedArray(pw * ph * 4);
  for (let i = 0, j = o, k = 0; i < pw * ph; i++) { rgba[k++] = ppm[j++]; rgba[k++] = ppm[j++]; rgba[k++] = ppm[j++]; rgba[k++] = 255; }
  return { rgba, w: pw, h: ph };
}
const map = render(frame[0], pageH - frame[3], W, H);
log("map area", W, "×", H, "px");

// ---- The legend bar (Indeks Risiko 0 – 0,3 – 0,6 – 1,0), itself a compressed
// picture: 72 → 506 pt across, 1595 → 1617 pt down, with white gaps at the
// two class breaks. Colours are averaged down each column, which removes most
// of the compression noise (single pixels wander ±2° in hue).
function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = -1;
  if (d > 0) h = 60 * (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return [h, mx ? d / mx : 0, mx / 255];
}
const BAR = { x0: 72.0, x1: 506.2, top: 1596.5, bottom: 1615.5 };
const barImg = render(BAR.x0, BAR.top, Math.round((BAR.x1 - BAR.x0) * s), Math.round((BAR.bottom - BAR.top) * s));
const bar = Array.from({ length: barImg.w }, (_, x) => {
  const c = [0, 0, 0];
  for (let y = 0; y < barImg.h; y++) for (let k = 0; k < 3; k++) c[k] += barImg.rgba[(y * barImg.w + x) * 4 + k];
  return c.map((v) => Math.round(v / barImg.h));
});
const barHue = bar.map((c) => hsv(...c)[0]);
const barAt = (x) => bar[Math.min(bar.length - 1, Math.max(0, Math.round((x - BAR.x0) * s)))];
const gapPx = bar.map((c, x) => (hsv(...c)[1] < 0.3 ? x : -1)).filter((x) => x >= 0);
const gap1 = gapPx.filter((x) => x < bar.length / 2), gap2 = gapPx.filter((x) => x >= bar.length / 2);
const toPt = (x) => BAR.x0 + x / s;
// Each third, 2 pt clear of the gaps and ends (their dark separator lines).
const BREAKS = [[BAR.x0 + 2, toPt(Math.min(...gap1)) - 2], [toPt(Math.max(...gap1)) + 2, toPt(Math.min(...gap2)) - 2], [toPt(Math.max(...gap2)) + 2, BAR.x1 - 2]];
log("legend thirds (pt)", BREAKS.map((b) => b.map((v) => +v.toFixed(1))));
// The hue at a break: a straight line through 0.2 – 2 mm of bar on each side
// (the pixels next to the white gap ring), extended to the gap's centre.
function breakHue(g) {
  const c = (Math.min(...g) + Math.max(...g)) / 2, side = (xs) => {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const x of xs) { n++; sx += x; sy += barHue[x]; sxx += x * x; sxy += x * barHue[x]; }
    const k = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return sy / n + k * (c - sx / n);
  };
  const r0 = Math.round(0.2 / MM_PER_PT * s), r1 = Math.round(2 / MM_PER_PT * s);
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  return [side(range(Math.min(...g) - r1, Math.min(...g) - r0)), side(range(Math.max(...g) + r0, Math.max(...g) + r1))];
}
// "Ambil gradasi": 33 colours along a line on the legend (as the page does).
const ramp = (a, b) => Array.from({ length: 33 }, (_, i) => barAt(a + (b - a) * i / 32));
const NAMES = ["Rendah", "Sedang", "Tinggi"];

// ---- Land mask, for reporting only: pixels whose hue is on the ramp (green → red)
// and that carry colour. Sea (blue), Java (grey), labels (black/white) are out.
const n = W * H, land = new Uint8Array(n);
let nLand = 0;
for (let i = 0, j = 0; i < n; i++, j += 4) {
  const [h, sat] = hsv(map.rgba[j], map.rgba[j + 1], map.rgba[j + 2]);
  if (sat > 0.35 && h >= 0 && h <= 130) { land[i] = 1; nLand++; }
}
log("land pixels", nLand, `(${(nLand / n * 100).toFixed(1)}% of the map area)`);

// ---- Clean-up the page uses by default: ignore lines thinner than 0.8 mm, drop areas under 1 mm².
const thinPx = 0.8 / MM_PER_PT * s, clean = { thin: thinPx >= 1.5 ? Math.max(1, Math.round(thinPx / 2)) : 0, minPixels: Math.round(1 / (MM_PER_PT * MM_PER_PT) * s * s) };
const pixelLL = (c, r) => toLL(frame[0] + c / s, frame[3] - r / s);

const share = (cls) => { let k = 0; for (let i = 0; i < n; i++) if (land[i] && cls[i]) k++; return (k / nLand * 100).toFixed(1) + "%"; };
function report(name, cls, classes, cleaned, quiet) {
  const before = share(cls);
  if (!cleaned) {
    PG.removeThin(cls, W, H, clean.thin, classes.length);
    PG.sieve(cls, W, H, clean.minPixels);
  }
  const counts = new Array(classes.length + 1).fill(0);
  for (let i = 0; i < n; i++) if (land[i]) counts[cls[i]]++;
  const covered = nLand - counts[0];
  log(`\n[${name}]  land matched ${before}${cleaned ? "" : " before clean-up"} · covered ${(covered / nLand * 100).toFixed(1)}%`);
  classes.forEach((c, i) => log(`  ${c.name.padEnd(7)} ${(counts[i + 1] / nLand * 100).toFixed(1).padStart(5)}% of land`));
  if (quiet) return counts;
  const feats = PG.polygonize(cls, W, H, classes, pixelLL, { simplify: 0.75 });
  const file = path.join(outDir, `${name}.geojson`);
  fs.writeFileSync(file, JSON.stringify({ type: "FeatureCollection", features: feats }));
  const parts = feats.reduce((a, f) => a + (f.geometry.type === "Polygon" ? 1 : f.geometry.coordinates.length), 0);
  log(`  ${feats.length} feature(s), ${parts} polygon part(s) → ${path.relative(process.cwd(), file)} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
  // A 1:8 preview of the class raster for the figures (PGM, 0 = none).
  const k = 8, pw = Math.floor(W / k), ph = Math.floor(H / k), pv = Buffer.alloc(pw * ph);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) pv[y * pw + x] = cls[(y * k + 4) * W + x * k + 4];
  fs.writeFileSync(path.join(outDir, `${name}.pgm`), Buffer.concat([Buffer.from(`P5 ${pw} ${ph} 255\n`), pv]));
  return counts;
}
function byColour(name, classes, tol) {
  const lut = PG.colorTable(classes, tol);
  return report(name, PG.classify(map.rgba, lut), classes);
}

// A. One class, one colour picked from the "Tinggi" part of the legend bar.
const mid = (b) => (b[0] + b[1]) / 2;
byColour("A_satu_warna_legenda", [{ name: "Tinggi", colors: [barAt(mid(BREAKS[2]))] }], 12);
// B. Three classes, "Ambil gradasi" over each third of the legend bar, default tolerance ΔE 12.
const grad = BREAKS.map((b, i) => ({ name: NAMES[i], colors: ramp(b[0], b[1]) }));
byColour("B_gradasi_legenda_dE12", grad, 12);
// C. The same at the highest tolerance the slider allows (ΔE 40).
byColour("C_gradasi_legenda_dE40", grad, 40);

// D. Hue. The map is the legend colour at ~71% opacity over a grey hillshade:
// pixel = 0.71·legend + 0.29·grey. Blending with grey changes lightness and
// saturation but not hue, so the hue of a pixel names its legend colour.
// Each class takes the hue range of its third of the legend bar.
const brk = [breakHue(gap1), breakHue(gap2)];
log("\nclass breaks on the legend (hue °, fitted from the left / right of each gap):",
  brk.map((b, i) => `${["Rendah|Sedang", "Sedang|Tinggi"][i]} ${b[0].toFixed(1)} / ${b[1].toFixed(1)}`).join(", "));
const mean = (b) => (b[0] + b[1]) / 2;
const top = barHue[2] + 10; // greener than the legend's first colour: not on the ramp

// The cartography painted over the risk picture (rivers, roads, boundaries,
// labels, grid crosses) is filled from the neighbouring class: every
// unclassified pixel within a closing (dilate, then erode) of the classified
// land, up to 1.4 mm on paper, takes the class of the nearest classified
// pixel. Sea and coast stay as they are.
function boxPass(src, dst, r, erode) {
  const tmp = new Uint8Array(n), row = new Int32Array(Math.max(W, H) + 1);
  for (const [a, b, horizontal] of [[src, tmp, true], [tmp, dst, false]]) {
    const lines = horizontal ? H : W, len = horizontal ? W : H, step = horizontal ? 1 : W;
    for (let l = 0; l < lines; l++) {
      const base = horizontal ? l * W : l;
      for (let k = 0; k < len; k++) row[k + 1] = row[k] + a[base + k * step];
      for (let k = 0; k < len; k++) {
        const lo = Math.max(0, k - r), hi = Math.min(len - 1, k + r), sum = row[hi + 1] - row[lo];
        b[base + k * step] = erode ? (sum === hi - lo + 1 ? 1 : 0) : sum > 0 ? 1 : 0;
      }
    }
  }
}
function fillGaps(cls, raw, r) {
  const any = new Uint8Array(n), closed = new Uint8Array(n);
  for (let i = 0; i < n; i++) any[i] = raw[i] ? 1 : 0;
  boxPass(any, closed, r, false); boxPass(closed, any, r, true);   // any = closing of the raw classes
  let front = [];
  for (let i = 0; i < n; i++) if (cls[i]) front.push(i);
  while (front.length) {                                         // breadth-first: nearest class wins
    const next = [];
    for (const p of front) {
      const x = p % W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
        if (q < 0 || q >= n || cls[q] || !any[q]) continue;
        cls[q] = cls[p]; next.push(q);
      }
    }
    front = next;
  }
  return cls;
}
function byHue(b12, b23) {
  const cls = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const [h, sat] = hsv(map.rgba[j], map.rgba[j + 1], map.rgba[j + 2]);
    if (sat < 0.35 || h < 0 || h > top) continue;
    cls[i] = h > b12 ? 1 : h > b23 ? 2 : 3;
  }
  const raw = cls.slice();
  PG.removeThin(cls, W, H, clean.thin, 3);
  PG.sieve(cls, W, H, clean.minPixels);
  return fillGaps(cls, raw, Math.round(0.7 / MM_PER_PT * s));
}
const hueClasses = NAMES.map((name, i) => ({ name, colors: [barAt((BREAKS[i][0] + BREAKS[i][1]) / 2)] }));
report("D_rona_hue", byHue(mean(brk[0]), mean(brk[1])), hueClasses, true);
// How much the Sedang/Tinggi split depends on where exactly the 0,6 break is.
log("\nsensitivity: Sedang|Tinggi break at");
for (const b23 of [brk[1][0], brk[1][1], mean(brk[1]) - 1, mean(brk[1]) + 1].sort((p, q) => p - q)) {
  const c = report(`hue ${b23.toFixed(1)}°`, byHue(mean(brk[0]), b23), hueClasses, true, true);
  void c;
}
