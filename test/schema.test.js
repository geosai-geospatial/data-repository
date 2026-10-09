"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { validate, validateAll, validateLinks } = require("../public/assets/js/schema");

test("the shipped catalog is valid", () => {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "data", "datasets.json"), "utf8"));
  assert.ok(validateAll(list).length > 0);
});

test("normalises a minimal dataset", () => {
  const d = validate({ id: "a-b", title: " T ", category: "C", extra: "dropped" });
  assert.equal(d.title, "T");
  assert.equal(d.price, "Hubungi kami");
  assert.equal(d.published, true);
  assert.equal(d.bbox, null);
  assert.equal(d.image, "");
  assert.ok(!("extra" in d));
});

test("rejects invalid datasets", () => {
  for (const d of [
    { id: "Bad Id", title: "T", category: "C" },
    { id: "ok", title: "", category: "C" },
    { id: "ok", title: "T" },
    { id: "ok", title: "T", category: "C", bbox: [10, 0, 5, 1] },
    { id: "ok", title: "T", category: "C", bbox: [100, "", 110, 2] },
    { id: "ok", title: "T", category: "C", features: -1 },
    { id: "ok", title: "T", category: "C", features: 1.5 },
    { id: "ok", title: "T", category: "C", geometry: "Blob" },
    { id: "ok", title: "T", category: "C", attributes: [{ type: "Text" }] },
    { id: "ok", title: "T", category: "C", image: "javascript:alert(1)" },
    { id: "ok", title: "T", category: "C", image: "https://example.com/a.png" },
    { id: "ok", title: "T", category: "C", image: "data/images/../../admin.png" },
    { id: "ok", title: "T", category: "C", image: "data/images/a.svg" },
  ]) {
    assert.throws(() => validate(d), Error, JSON.stringify(d));
  }
});

test("accepts a coverage image path", () => {
  assert.equal(validate({ id: "a", title: "T", category: "C", image: "data/images/a-b.png" }).image, "data/images/a-b.png");
  assert.equal(validate({ id: "a", title: "T", category: "C", image: "data/images/a.jpg" }).image, "data/images/a.jpg");
});

test("validates admin Drive links", () => {
  const url = "https://drive.google.com/drive/folders/abc123";
  assert.deepEqual(validateLinks({ "a-b": url, c: "" }), { "a-b": url });
  assert.throws(() => validateLinks({ a: "javascript:alert(1)" }));
  assert.throws(() => validateLinks({ a: "https://drive.google.com.evil.com/x" }));
  assert.throws(() => validateLinks({ "Bad Id": url }));
  assert.throws(() => validateLinks([]));
});

test("rejects duplicate ids and non-arrays", () => {
  const d = { id: "x", title: "T", category: "C" };
  assert.throws(() => validateAll([d, d]), /Duplicate id/);
  assert.throws(() => validateAll({}), /array/);
});
