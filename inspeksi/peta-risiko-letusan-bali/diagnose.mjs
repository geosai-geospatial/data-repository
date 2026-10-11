// Runs the extractor's own functions (public/assets/js/pdfgeo.js, vendored
// pdf.js) on the BNPB volcano risk map of Bali and prints what they find:
// grid crosses, map frame, coordinate system, and the fit from two typed
// control points, once with the right coordinates and once with the
// northing typed in 30 km steps. Writes the vector output of both fits.
//
//   node inspeksi/peta-risiko-letusan-bali/diagnose.mjs <file.pdf> [out-dir]
import fs from "fs";
import path from "path";
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
const doc = await lib.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)), isEvalSupported: false, verbosity: 0 }).promise;
const page = await doc.getPage(1);
const oc = await doc.getOptionalContentConfig();
const got = PG.extractPaths(await page.getOperatorList(), lib.OPS, (p) => oc.isVisible(p));
const nodes = PG.findGridNodes(got.paths, page.view);
const lattice = PG.latticeSpacing(nodes);
const frame = PG.findFrame(got.paths, got.images, page.view, nodes);
const text = (await page.getTextContent()).items;
const inFrame = (b) => b[0] < frame[2] && b[2] > frame[0] && b[1] < frame[3] && b[3] > frame[1];

log("page (pt)", page.view.map((v) => +v.toFixed(1)));
log("vector paths", got.paths.length, "· in frame", got.paths.filter((p) => inFrame(p.bbox)).length);
log("pictures", got.images.length, "· in frame", got.images.filter((i) => inFrame(i.bbox)).length, "· dpi", PG.imageDpi(got.images, frame));
log("frame (pt)", frame.map((v) => +v.toFixed(1)));
log("coordinate system from the notes", PG.detectCrs(text.map((i) => i.str).join(" ")));
log("grid crosses", nodes.length, "· spacing (pt)", { x: +lattice.x.toFixed(2), y: +lattice.y.toFixed(2) });
const uniq = (a) => [...new Set(a.map((v) => v.toFixed(1)))].sort((p, q) => p - q);
log("  columns (pt)", uniq(nodes.map((n) => n[0])).join(" "));
log("  rows    (pt)", uniq(nodes.map((n) => n[1])).join(" "));

// Grid labels read off the map (they are drawn as outlines, not text):
// easting 230000…350000 every 30 km, northing 9020000…9110000 every 10 km.
const cross = (x, y) => nodes.find((n) => Math.abs(n[0] - x) < 1 && Math.abs(n[1] - y) < 1);
const sw = cross(400.2, 346.5), ne = cross(2065.2, 1595.4);
const scenarios = {
  benar: [{ px: sw[0], py: sw[1], x: 230000, y: 9020000 }, { px: ne[0], py: ne[1], x: 350000, y: 9110000 }],
  salah_y30km: [{ px: sw[0], py: sw[1], x: 230000, y: 9020000 }, { px: ne[0], py: ne[1], x: 350000, y: 9290000 }],
};
const utm = PG.crs(32750), groups = PG.groupPaths(got.paths, frame), labels = PG.textLabels(text, frame);
groups.forEach((g, i) => (g.name = "lapisan " + (i + 1)));
fs.mkdirSync(outDir, { recursive: true });
for (const [name, typed] of Object.entries(scenarios)) {
  const two = PG.fit(typed);
  const rot = (Math.atan2(two.m[1], two.m[0]) * 180) / Math.PI;
  const iv = PG.niceInterval(Math.min(lattice.x, lattice.y) * PG.fitScale(two), false);
  const done = PG.completeGrid(typed, nodes, iv);
  const toLL = PG.projector(done.fit.m, utm);
  log(`\n[${name}] two points: ${PG.fitScale(two).toFixed(1)} m/pt, rotation ${rot.toFixed(1)}°`);
  log(`  grid interval guess ${iv} m · crosses added ${done.added} · RMSE ${done.fit.rmse.toFixed(1)} m`);
  log("  frame corners SW", toLL(frame[0], frame[1]), "NE", toLL(frame[2], frame[3]));
  const feats = PG.pathFeatures(got.paths, groups, frame, toLL);
  labels.forEach((l) => feats.push({ type: "Feature", properties: { teks: l.text }, geometry: { type: "Point", coordinates: toLL(l.x, l.y) } }));
  fs.writeFileSync(path.join(outDir, `vektor_${name}.geojson`), JSON.stringify({ type: "FeatureCollection", features: feats }));
}
await doc.destroy();
