// Builds public/data/basemap.json, the land/country layer behind the static maps
// made in the admin (assets/js/staticmap.js), from Natural Earth (public domain).
//
//   curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson
//   node scripts/build-basemap.js ne_10m_admin_0_countries.geojson
//
// Only countries around Indonesia are kept, simplified (finely for the
// archipelago, coarsely for the rest) and stored as integer thousandths of a
// degree, so the file stays small enough to load in the admin.
"use strict";

const fs = require("fs");
const path = require("path");

const REGION = [80, -30, 160, 25]; // countries touching this box are kept
const DETAIL = [92, -13, 143, 9]; // countries touching this box keep fine detail
const FINE = 0.003, COARSE = 0.02; // simplification tolerance (degrees)
// Natural Earth's Indonesian name is wrong for these.
const NAME_FIX = { PGA: "Kepulauan Spratly" };

function boxOf(coords) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  (function walk(c) {
    if (typeof c[0] === "number") {
      b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]);
      b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
    } else c.forEach(walk);
  })(coords);
  return b;
}
const touches = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// Douglas–Peucker on one ring (iterative, so long coastlines don't overflow the stack).
function simplify(pts, tol) {
  if (pts.length < 5) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = len ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / len : Math.hypot(px - ax, py - ay);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function main(file) {
  const src = JSON.parse(fs.readFileSync(file, "utf8"));
  const countries = [];
  for (const f of src.features) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    if (!touches(boxOf(polys), REGION)) continue;
    const tol = touches(boxOf(polys), DETAIL) ? FINE : COARSE;
    const rings = [];
    for (const poly of polys) {
      if (!touches(boxOf(poly[0]), REGION)) continue; // far-off islands of a kept country
      for (const ring of poly) {
        const s = simplify(ring, tol);
        if (s.length < 4) continue; // collapsed to nothing at this tolerance
        const flat = [];
        let px = null, py = null;
        for (const [x, y] of s) {
          const qx = Math.round(x * 1000), qy = Math.round(y * 1000);
          if (qx === px && qy === py) continue;
          flat.push(qx, qy);
          px = qx; py = qy;
        }
        if (flat.length >= 8) rings.push(flat);
      }
    }
    if (!rings.length) continue;
    const p = f.properties;
    // Extent of the largest landmass: decides whether the country is big enough on screen to label.
    let b = null;
    rings.forEach((r) => {
      const rb = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < r.length; i += 2) {
        rb[0] = Math.min(rb[0], r[i]); rb[2] = Math.max(rb[2], r[i]);
        rb[1] = Math.min(rb[1], r[i + 1]); rb[3] = Math.max(rb[3], r[i + 1]);
      }
      if (!b || (rb[2] - rb[0]) * (rb[3] - rb[1]) > (b[2] - b[0]) * (b[3] - b[1])) b = rb;
    });
    countries.push({
      name: NAME_FIX[p.ADM0_A3] || p.NAME_ID || p.NAME,
      iso: p.ADM0_A3,
      rank: p.LABELRANK, // 1 = most important, as Natural Earth ranks label priority
      label: [Math.round(p.LABEL_X * 1000) / 1000, Math.round(p.LABEL_Y * 1000) / 1000],
      main: b.map((v) => v / 1000),
      rings,
    });
  }
  countries.sort((a, b) => a.iso.localeCompare(b.iso));
  const out = {
    source: "Natural Earth 1:10m Admin 0 – Countries (public domain), simplified",
    scale: 1000,
    countries,
  };
  const dest = path.join(__dirname, "..", "public", "data", "basemap.json");
  fs.writeFileSync(dest, JSON.stringify(out) + "\n");
  console.log(`${dest}: ${countries.length} countries, ${(fs.statSync(dest).size / 1024).toFixed(0)} KB`);
}

if (!process.argv[2]) {
  console.error("Usage: node scripts/build-basemap.js ne_10m_admin_0_countries.geojson");
  process.exit(1);
}
main(process.argv[2]);
