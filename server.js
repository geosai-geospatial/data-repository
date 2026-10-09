"use strict";

const path = require("path");
const express = require("express");
const { Store } = require("./lib/store");
const { createAuth } = require("./lib/auth");

function createApp(config) {
  const store = new Store(path.join(config.dataDir, "datasets.json"), path.join(__dirname, "data", "seed.json"));
  const auth = createAuth(config);
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind the host's HTTPS proxy (Render, Railway, Fly…)

  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self' https://cdnjs.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
        "font-src https://fonts.gstatic.com",
        "img-src 'self' data: https://*.basemaps.cartocdn.com https://avatars.githubusercontent.com",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),
    });
    next();
  });

  app.use(auth.middleware);
  app.use(express.json({ limit: "200kb" }));

  // Writes must come from our own pages: together with SameSite=Lax cookies and
  // the JSON-only body parser this blocks cross-site request forgery.
  app.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    if (origin && origin !== new URL(config.baseUrl).origin) return res.status(403).json({ error: "Bad origin" });
    next();
  });

  // ---- Auth ----
  app.get("/auth/github", auth.login);
  app.get("/auth/github/callback", auth.callback);
  app.post("/auth/logout", auth.logout);
  app.get("/api/me", (req, res) => (req.user ? res.json({ login: req.user.login, name: req.user.name, avatar: req.user.avatar }) : res.status(401).json({ error: "Not logged in" })));

  // ---- Datasets (read: public, write: admin) ----
  app.get("/api/datasets", (req, res) => {
    res.json(store.list({ includeDrafts: Boolean(req.user) && req.query.all === "1" }));
  });

  app.get("/api/datasets/:id", (req, res) => {
    const d = store.get(req.params.id);
    if (!d || (d.published === false && !req.user)) return res.status(404).json({ error: "Not found" });
    res.json(d);
  });

  app.post("/api/datasets", auth.requireAdmin, (req, res) => {
    res.status(201).json(store.create(req.body));
  });

  app.put("/api/datasets/:id", auth.requireAdmin, (req, res) => {
    const d = store.update(req.params.id, req.body);
    if (!d) return res.status(404).json({ error: "Not found" });
    res.json(d);
  });

  app.delete("/api/datasets/:id", auth.requireAdmin, (req, res) => {
    if (!store.remove(req.params.id)) return res.status(404).json({ error: "Not found" });
    res.status(204).end();
  });

  app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
  app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "Server error" : err.message });
  });

  return app;
}

function configFromEnv(env = process.env) {
  const port = Number(env.PORT) || 3000;
  const config = {
    port,
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ""),
    clientId: env.GITHUB_CLIENT_ID || "",
    clientSecret: env.GITHUB_CLIENT_SECRET || "",
    sessionSecret: env.SESSION_SECRET || "",
    admins: (env.ADMIN_GITHUB_USERS || "").split(",").map((s) => s.trim()).filter(Boolean),
    dataDir: env.DATA_DIR || path.join(__dirname, "data"),
  };
  if (config.sessionSecret.length < 32) throw new Error("SESSION_SECRET must be set to at least 32 random characters");
  if (!config.admins.length) console.warn("ADMIN_GITHUB_USERS is empty: nobody can log in to the admin.");
  return config;
}

if (require.main === module) {
  try {
    process.loadEnvFile?.(); // reads .env if present (Node ≥ 20.12)
  } catch {
    /* no .env file */
  }
  const config = configFromEnv();
  createApp(config).listen(config.port, () => console.log(`GeoSAI Data running at ${config.baseUrl}`));
}

module.exports = { createApp, configFromEnv };
