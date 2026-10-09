// Dataset storage: one JSON file on disk, read into memory at startup and
// rewritten atomically (write temp file, then rename) on every change.
// This is enough for a single-admin catalog of tens to hundreds of entries.
"use strict";

const fs = require("fs");
const path = require("path");

const GEOMETRIES = ["Polygon", "Line", "Point", "Raster", "Mixed"];
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function str(v, field, { required = false, max = 500 } = {}) {
  if (v == null || v === "") {
    if (required) throw new ValidationError(`${field} is required`);
    return "";
  }
  if (typeof v !== "string") throw new ValidationError(`${field} must be text`);
  const s = v.trim();
  if (required && !s) throw new ValidationError(`${field} is required`);
  if (s.length > max) throw new ValidationError(`${field} is longer than ${max} characters`);
  return s;
}

function strList(v, field, { max = 500, maxItems = 50 } = {}) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new ValidationError(`${field} must be a list`);
  if (v.length > maxItems) throw new ValidationError(`${field} has more than ${maxItems} items`);
  return v.map((x, i) => str(x, `${field}[${i}]`, { max })).filter(Boolean);
}

// Normalises and validates client input into a dataset record. Unknown fields
// are dropped, so the stored shape is always the one the public pages expect.
function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("Body must be a JSON object");
  }
  const id = str(input.id, "id", { required: true, max: 80 });
  if (!ID_RE.test(id)) {
    throw new ValidationError("id must be lowercase letters, digits and single dashes (e.g. iup-minerba-2025)");
  }

  let bbox = null;
  if (input.bbox != null && !(Array.isArray(input.bbox) && input.bbox.every((x) => x === null || x === ""))) {
    if (!Array.isArray(input.bbox) || input.bbox.length !== 4) throw new ValidationError("bbox must be [west, south, east, north]");
    bbox = input.bbox.map(Number);
    const [w, s, e, n] = bbox;
    if (bbox.some((x) => !Number.isFinite(x)) || w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) {
      throw new ValidationError("bbox must be valid WGS84 coordinates with west < east and south < north");
    }
  }

  let features = 0;
  if (input.features != null && input.features !== "") {
    features = Number(input.features);
    if (!Number.isInteger(features) || features < 0) throw new ValidationError("features must be a whole number ≥ 0");
  }

  const geometry = str(input.geometry, "geometry", { max: 20 }) || "Polygon";
  if (!GEOMETRIES.includes(geometry)) throw new ValidationError(`geometry must be one of ${GEOMETRIES.join(", ")}`);

  if (input.attributes != null && !Array.isArray(input.attributes)) throw new ValidationError("attributes must be a list");
  const attributes = (input.attributes || []).slice(0, 200).map((a, i) => {
    if (!a || typeof a !== "object") throw new ValidationError(`attributes[${i}] must be an object`);
    return {
      name: str(a.name, `attributes[${i}].name`, { required: true, max: 100 }),
      type: str(a.type, `attributes[${i}].type`, { max: 40 }),
      description: str(a.description, `attributes[${i}].description`, { max: 300 }),
    };
  });

  return {
    id,
    title: str(input.title, "title", { required: true, max: 200 }),
    category: str(input.category, "category", { required: true, max: 60 }),
    summary: str(input.summary, "summary", { max: 600 }),
    description: strList(input.description, "description", { max: 4000, maxItems: 30 }),
    coverage: str(input.coverage, "coverage", { max: 200 }),
    bbox,
    source: str(input.source, "source", { max: 300 }),
    year: str(input.year, "year", { max: 20 }),
    format: strList(input.format, "format", { max: 30, maxItems: 20 }),
    crs: str(input.crs, "crs", { max: 100 }),
    geometry,
    features,
    size: str(input.size, "size", { max: 50 }),
    attributes,
    price: str(input.price, "price", { max: 100 }) || "Hubungi kami",
    published: input.published !== false,
  };
}

class Store {
  constructor(file, seedFile) {
    this.file = file;
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const seed = seedFile && fs.existsSync(seedFile) ? fs.readFileSync(seedFile, "utf8") : "[]";
      fs.writeFileSync(file, seed);
    }
    this.items = JSON.parse(fs.readFileSync(file, "utf8"));
  }

  _save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2) + "\n");
    fs.renameSync(tmp, this.file);
  }

  list({ includeDrafts = false } = {}) {
    return includeDrafts ? this.items : this.items.filter((d) => d.published !== false);
  }

  get(id) {
    return this.items.find((d) => d.id === id) || null;
  }

  create(input) {
    const d = validate(input);
    if (this.get(d.id)) {
      const err = new ValidationError(`A dataset with id "${d.id}" already exists`);
      err.status = 409;
      throw err;
    }
    d.updated = today();
    this.items.push(d);
    this._save();
    return d;
  }

  // The id is the URL slug and is fixed after creation, so links already
  // shared with buyers keep working.
  update(id, input) {
    const i = this.items.findIndex((d) => d.id === id);
    if (i < 0) return null;
    const d = validate({ ...input, id });
    d.updated = today();
    this.items[i] = d;
    this._save();
    return d;
  }

  remove(id) {
    const i = this.items.findIndex((d) => d.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this._save();
    return true;
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { Store, validate, ValidationError, GEOMETRIES };
