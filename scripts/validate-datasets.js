// CI check: fails the deploy if public/data/datasets.json is not valid.
"use strict";

const fs = require("fs");
const path = require("path");
const { validateAll, validateLinks } = require("../public/assets/js/schema");

const file = path.join(__dirname, "..", "public", "data", "datasets.json");
try {
  const list = validateAll(JSON.parse(fs.readFileSync(file, "utf8")));
  for (const d of list) {
    if (d.image && !fs.existsSync(path.join(__dirname, "..", "public", d.image))) {
      throw new Error(`Dataset "${d.id}": image ${d.image} does not exist in public/`);
    }
  }
  console.log(`datasets.json OK: ${list.length} datasets`);
  const links = path.join(__dirname, "..", "cms", "drive-links.json");
  if (fs.existsSync(links)) {
    const n = Object.keys(validateLinks(JSON.parse(fs.readFileSync(links, "utf8")))).length;
    console.log(`drive-links.json OK: ${n} links`);
  }
} catch (err) {
  console.error(`datasets.json is invalid: ${err.message}`);
  process.exit(1);
}
