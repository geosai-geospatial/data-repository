// Builds public/data/contoh-pulau.geojson, the sample polygon layer of the
// spatial analysis page (analisis-spasial.html): Indonesia's land from
// public/data/basemap.json (Natural Earth, public domain), grouped into the
// seven island regions used by the sample cities (contoh-kota.geojson), so
// the two-layer tools (count points in polygons, clip, intersect) have
// something to work on.
//
//   node scripts/build-sample-islands.js
//
// The grouping goes by each island's position (rules below), at basemap
// precision (0.001°, simplified): a demo, not a boundary dataset.
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "public", "data");
const basemap = JSON.parse(fs.readFileSync(path.join(root, "basemap.json"), "utf8"));
const idn = basemap.countries.find((c) => c.iso === "IDN");
if (!idn) throw new Error("Indonesia is not in basemap.json");

function ringOf(flat) {
  const r = [];
  for (let i = 0; i < flat.length; i += 2) r.push([flat[i] / 1000, flat[i + 1] / 1000]);
  if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) r.push(r[0].slice());
  return r;
}
function signedArea(r) {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return s / 2;
}
function centre(r) {
  let a = 0, x = 0, y = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const c = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += c; x += (r[j][0] + r[i][0]) * c; y += (r[j][1] + r[i][1]) * c;
  }
  return a ? [x / (3 * a), y / (3 * a)] : r[0];
}

// Island region from an island's centre (longitude, latitude).
function region([x, y]) {
  if (x >= 137 || (x >= 129.8 && y > -2.4) || (x >= 131.3 && y > -4.6)) return "Papua";
  if (x >= 125.8 && !(y > 3 && x < 127.5)) return "Maluku";
  if (x >= 124.3 && y > -2.3 && y < -1.4) return "Maluku"; // Sula and Taliabu
  if (y < -7.5 && x >= 114.7) return "Bali & Nusa Tenggara";
  if (y < -5.5 && x >= 105.2 && x < 116) return "Jawa";
  if (x >= 118.8 && x < 119.2 && y < -4.5) return "Sulawesi";
  if (x >= 108.6 && x < 119.2 && y > -4.6) return "Kalimantan";
  if (x >= 118.8) return "Sulawesi";
  return "Sumatra";
}

const groups = new Map();
idn.rings.map(ringOf).forEach((ring) => {
  const name = region(centre(ring));
  if (signedArea(ring) < 0) ring.reverse(); // counter-clockwise, as RFC 7946 asks
  if (!groups.has(name)) groups.set(name, []);
  groups.get(name).push([ring]);
});

const ORDER = ["Sumatra", "Jawa", "Kalimantan", "Sulawesi", "Bali & Nusa Tenggara", "Maluku", "Papua"];
const out = {
  type: "FeatureCollection",
  name: "contoh-pulau",
  features: ORDER.filter((n) => groups.has(n)).map((n) => ({
    type: "Feature",
    // The region's name and how many separate islands (polygons) it has.
    properties: { pulau: n, jumlah_pulau: groups.get(n).length },
    geometry: { type: "MultiPolygon", coordinates: groups.get(n) },
  })),
};

const file = path.join(root, "contoh-pulau.geojson");
fs.writeFileSync(file, JSON.stringify(out) + "\n");
console.log("Wrote " + file + ": " + out.features.map((f) => f.properties.pulau + " (" + f.properties.jumlah_pulau + ")").join(", "));
