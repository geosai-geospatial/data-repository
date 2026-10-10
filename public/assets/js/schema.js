// Dataset schema: validates and normalises one dataset record.
// Shared by the admin page (browser) and the CI check (Node), so a bad edit is
// caught in the form, and again before deploy if the file was edited by hand.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Schema = factory();
})(this, function () {
  "use strict";

  var GEOMETRIES = ["Polygon", "Line", "Point", "Raster", "Mixed"];
  var ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  // Coverage images live next to datasets.json, uploaded by the admin. Only
  // this exact shape is accepted, so the value is always a same-site image path.
  var IMAGE_RE = /^data\/images\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:png|jpe?g|webp)$/;
  // Public download link of a free dataset. Must be https so the button can
  // never become a javascript: or plain-http link.
  var DOWNLOAD_RE = /^https:\/\/[^\s"'<>]+$/;

  function fail(msg) { throw new Error(msg); }

  function str(v, field, opts) {
    opts = opts || {};
    var max = opts.max || 500;
    if (v == null || v === "") {
      if (opts.required) fail(field + " is required");
      return "";
    }
    if (typeof v !== "string") fail(field + " must be text");
    var s = v.trim();
    if (opts.required && !s) fail(field + " is required");
    if (s.length > max) fail(field + " is longer than " + max + " characters");
    return s;
  }

  function strList(v, field, opts) {
    if (v == null) return [];
    if (!Array.isArray(v)) fail(field + " must be a list");
    if (v.length > opts.maxItems) fail(field + " has more than " + opts.maxItems + " items");
    return v.map(function (x, i) { return str(x, field + "[" + i + "]", opts); }).filter(Boolean);
  }

  function validate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("Dataset must be an object");

    var id = str(input.id, "id", { required: true, max: 80 });
    if (!ID_RE.test(id)) fail("id must be lowercase letters, digits and single dashes (e.g. iup-minerba-2025)");

    var bbox = null;
    if (input.bbox != null) {
      if (!Array.isArray(input.bbox) || input.bbox.length !== 4) fail("bbox must be [west, south, east, north]");
      if (input.bbox.some(function (x) { return x === null || x === ""; })) fail("bbox needs all four values (west, south, east, north)");
      bbox = input.bbox.map(Number);
      var w = bbox[0], s = bbox[1], e = bbox[2], n = bbox[3];
      if (bbox.some(function (x) { return !isFinite(x); }) || w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) {
        fail("bbox must be valid WGS84 coordinates with west < east and south < north");
      }
    }

    var image = str(input.image, "image", { max: 200 });
    if (image && !IMAGE_RE.test(image)) fail("image must be a path like data/images/<id>.png");

    var features = 0;
    if (input.features != null && input.features !== "") {
      features = Number(input.features);
      if (!Number.isInteger(features) || features < 0) fail("features must be a whole number ≥ 0");
    }

    var geometry = str(input.geometry, "geometry", { max: 20 }) || "Polygon";
    if (GEOMETRIES.indexOf(geometry) < 0) fail("geometry must be one of " + GEOMETRIES.join(", "));

    if (input.attributes != null && !Array.isArray(input.attributes)) fail("attributes must be a list");
    var attributes = (input.attributes || []).slice(0, 200).map(function (a, i) {
      if (!a || typeof a !== "object") fail("attributes[" + i + "] must be an object");
      return {
        name: str(a.name, "attributes[" + i + "].name", { required: true, max: 100 }),
        type: str(a.type, "attributes[" + i + "].type", { max: 40 }),
        description: str(a.description, "attributes[" + i + "].description", { max: 300 }),
      };
    });

    var out = {
      id: id,
      title: str(input.title, "title", { required: true, max: 200 }),
      category: str(input.category, "category", { required: true, max: 60 }),
      summary: str(input.summary, "summary", { max: 600 }),
      description: strList(input.description, "description", { max: 4000, maxItems: 30 }),
      coverage: str(input.coverage, "coverage", { max: 200 }),
      bbox: bbox,
      image: image,
      source: str(input.source, "source", { max: 300 }),
      year: str(input.year, "year", { max: 20 }),
      format: strList(input.format, "format", { max: 30, maxItems: 20 }),
      crs: str(input.crs, "crs", { max: 100 }),
      geometry: geometry,
      features: features,
      size: str(input.size, "size", { max: 50 }),
      attributes: attributes,
      price: str(input.price, "price", { max: 100 }) || "Hubungi kami",
      published: input.published !== false,
    };
    // Free datasets are downloaded straight from the public link, without
    // contacting us. The two keys are only written for free datasets.
    if (input.free === true) {
      var download = str(input.download, "download", { required: true, max: 500 });
      if (!DOWNLOAD_RE.test(download)) fail("download must be an https:// link");
      out.free = true;
      out.download = download;
      out.price = "Gratis";
    }
    if (input.updated) out.updated = str(input.updated, "updated", { max: 10 });
    return out;
  }

  // Validates the admin-only Drive links file: { "<dataset id>": "https://drive.google.com/…" }.
  // Empty links are dropped. Only Google Drive/Docs URLs are accepted.
  var DRIVE_RE = /^https:\/\/(?:drive|docs)\.google\.com\/\S*$/;
  function validateLinks(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) fail("drive-links.json must contain a JSON object");
    var out = {};
    Object.keys(obj).sort().forEach(function (id) {
      if (!ID_RE.test(id)) fail('Drive link key "' + id + '" is not a valid dataset id');
      var url = str(obj[id], "Drive link for " + id, { max: 500 });
      if (!url) return;
      if (!DRIVE_RE.test(url)) fail("Drive link for " + id + " must start with https://drive.google.com/");
      out[id] = url;
    });
    return out;
  }

  // Validates the whole catalog file: an array of valid datasets with unique ids.
  function validateAll(list) {
    if (!Array.isArray(list)) fail("datasets.json must contain a JSON array");
    var seen = {};
    return list.map(function (d, i) {
      var v;
      try { v = validate(d); } catch (e) { fail("Dataset #" + (i + 1) + " (" + (d && d.id) + "): " + e.message); }
      if (seen[v.id]) fail('Duplicate id "' + v.id + '"');
      seen[v.id] = true;
      return v;
    });
  }

  return { validate: validate, validateAll: validateAll, GEOMETRIES: GEOMETRIES, IMAGE_RE: IMAGE_RE, validateLinks: validateLinks };
});
