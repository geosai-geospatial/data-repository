"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { sign, SESSION_COOKIE } = require("../lib/auth");

const SECRET = "x".repeat(40);
let server, base, dataDir;

function cookieFor(login, secret = SECRET) {
  return SESSION_COOKIE + "=" + sign({ login, name: login, exp: Date.now() + 60000 }, secret);
}
const ADMIN = { Cookie: cookieFor("owner") };

function req(method, url, { body, headers = {} } = {}) {
  return fetch(base + url, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geosai-"));
  const app = createApp({
    baseUrl: "http://localhost",
    clientId: "cid",
    clientSecret: "csecret",
    sessionSecret: SECRET,
    admins: ["Owner"],
    dataDir,
  });
  await new Promise((r) => (server = app.listen(0, r)));
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("public catalog is seeded and readable without login", async () => {
  const res = await req("GET", "/api/datasets");
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(list.length > 0);
  assert.equal((await req("GET", "/api/datasets/" + list[0].id)).status, 200);
  assert.equal((await req("GET", "/api/datasets/nope")).status, 404);
});

test("writes require an admin session", async () => {
  assert.equal((await req("POST", "/api/datasets", { body: { id: "a", title: "A", category: "C" } })).status, 401);
  assert.equal((await req("DELETE", "/api/datasets/iup-minerba-indonesia")).status, 401);
  // Valid signature but wrong secret, or a user not on the allowlist.
  assert.equal((await req("GET", "/api/me", { headers: { Cookie: cookieFor("owner", "y".repeat(40)) } })).status, 401);
  assert.equal((await req("GET", "/api/me", { headers: { Cookie: cookieFor("stranger") } })).status, 401);
  assert.equal((await req("GET", "/api/me", { headers: ADMIN })).status, 200);
});

test("full CRUD cycle, persisted to disk", async () => {
  const input = { id: "test-set", title: "Test set", category: "Uji", format: ["SHP"], bbox: [100, -5, 110, 2], features: 12 };

  let res = await req("POST", "/api/datasets", { body: input, headers: ADMIN });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.price, "Hubungi kami");
  assert.match(created.updated, /^\d{4}-\d{2}-\d{2}$/);

  assert.equal((await req("POST", "/api/datasets", { body: input, headers: ADMIN })).status, 409);

  res = await req("PUT", "/api/datasets/test-set", { body: { ...input, id: "renamed", title: "Changed" }, headers: ADMIN });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.title, "Changed");
  assert.equal(updated.id, "test-set", "id cannot be changed by an update");

  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "datasets.json"), "utf8"));
  assert.equal(onDisk.find((d) => d.id === "test-set").title, "Changed");

  assert.equal((await req("DELETE", "/api/datasets/test-set", { headers: ADMIN })).status, 204);
  assert.equal((await req("GET", "/api/datasets/test-set")).status, 404);
  assert.equal((await req("PUT", "/api/datasets/test-set", { body: input, headers: ADMIN })).status, 404);
});

test("drafts are hidden from the public", async () => {
  await req("POST", "/api/datasets", { body: { id: "draft", title: "Draft", category: "C", published: false }, headers: ADMIN });
  assert.equal((await req("GET", "/api/datasets/draft")).status, 404);
  const pub = await (await req("GET", "/api/datasets?all=1")).json();
  assert.ok(!pub.some((d) => d.id === "draft"));
  const all = await (await req("GET", "/api/datasets?all=1", { headers: ADMIN })).json();
  assert.ok(all.some((d) => d.id === "draft"));
});

test("invalid input is rejected with a message", async () => {
  for (const body of [
    { id: "Bad Id", title: "T", category: "C" },
    { id: "ok", title: "", category: "C" },
    { id: "ok", title: "T", category: "C", bbox: [10, 0, 5, 1] },
    { id: "ok", title: "T", category: "C", features: -1 },
    { id: "ok", title: "T", category: "C", geometry: "Blob" },
  ]) {
    const res = await req("POST", "/api/datasets", { body, headers: ADMIN });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok((await res.json()).error);
  }
});

test("cross-origin writes are refused", async () => {
  const res = await req("POST", "/api/datasets", {
    body: { id: "x", title: "X", category: "C" },
    headers: { ...ADMIN, Origin: "https://evil.example" },
  });
  assert.equal(res.status, 403);
});

test("login redirects to GitHub with a state cookie; bad state is refused", async () => {
  const res = await req("GET", "/auth/github");
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("location"));
  assert.equal(loc.host, "github.com");
  assert.equal(loc.searchParams.get("client_id"), "cid");
  assert.equal(loc.searchParams.get("redirect_uri"), "http://localhost/auth/github/callback");
  assert.match(res.headers.get("set-cookie"), /oauth_state=.+HttpOnly/);

  assert.equal((await req("GET", "/auth/github/callback?code=c&state=forged", { headers: { Cookie: "oauth_state=real" } })).status, 400);
});

test("static pages are served", async () => {
  for (const p of ["/", "/dataset.html", "/contact.html", "/admin.html"]) {
    assert.equal((await req("GET", p)).status, 200, p);
  }
});
