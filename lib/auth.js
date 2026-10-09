// GitHub OAuth login and a stateless, HMAC-signed session cookie.
//
// Flow: /auth/github -> github.com/login/oauth/authorize -> /auth/github/callback
// The callback exchanges the code for a token, reads the GitHub username, and
// only issues a session if that username is in the ADMIN_GITHUB_USERS allowlist.
// The GitHub token itself is discarded; the session only holds the profile.
"use strict";

const crypto = require("crypto");

const SESSION_COOKIE = "sid";
const STATE_COOKIE = "oauth_state";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return body + "." + mac;
}

function verify(token, secret) {
  if (typeof token !== "string") return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function createAuth(config) {
  const { clientId, clientSecret, baseUrl, sessionSecret, admins } = config;
  const secure = baseUrl.startsWith("https://");
  const cookieOpts = { httpOnly: true, sameSite: "lax", secure, path: "/" };
  const allow = new Set(admins.map((a) => a.toLowerCase()));

  function currentUser(req) {
    const s = verify(parseCookies(req.headers.cookie)[SESSION_COOKIE], sessionSecret);
    // Re-check the allowlist so removing someone from it takes effect at once.
    return s && allow.has(s.login.toLowerCase()) ? s : null;
  }

  // Attaches req.user on every request.
  function middleware(req, res, next) {
    req.user = currentUser(req);
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: "Login required" });
    next();
  }

  function login(req, res) {
    if (!clientId) return res.status(500).send("GitHub OAuth is not configured (GITHUB_CLIENT_ID).");
    const state = crypto.randomBytes(16).toString("hex");
    res.cookie(STATE_COOKIE, state, { ...cookieOpts, maxAge: 10 * 60 * 1000 });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", baseUrl + "/auth/github/callback");
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "false");
    // No scope: we only need the public profile to learn the username.
    res.redirect(url.toString());
  }

  async function callback(req, res) {
    const { code, state } = req.query;
    const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, cookieOpts);
    if (!code || !state || !expected || state !== expected) {
      return res.status(400).send(page("Login failed", "Invalid or expired login attempt. Please try again."));
    }
    try {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: baseUrl + "/auth/github/callback",
        }),
      });
      const token = await tokenRes.json();
      if (!token.access_token) throw new Error(token.error_description || "No access token");

      const userRes = await fetch("https://api.github.com/user", {
        headers: { Authorization: "Bearer " + token.access_token, Accept: "application/vnd.github+json", "User-Agent": "geosai-data-cms" },
      });
      if (!userRes.ok) throw new Error("GitHub /user returned " + userRes.status);
      const gh = await userRes.json();

      if (!allow.has(String(gh.login).toLowerCase())) {
        return res.status(403).send(page("Access denied", `GitHub user <b>${escapeHtml(gh.login)}</b> is not an administrator of this site.`));
      }
      const session = { login: gh.login, name: gh.name || gh.login, avatar: gh.avatar_url, exp: Date.now() + SESSION_TTL_MS };
      res.cookie(SESSION_COOKIE, sign(session, sessionSecret), { ...cookieOpts, maxAge: SESSION_TTL_MS });
      res.redirect("/admin.html");
    } catch (err) {
      console.error("OAuth callback failed:", err.message);
      res.status(502).send(page("Login failed", "Could not complete login with GitHub. Please try again."));
    }
  }

  function logout(req, res) {
    res.clearCookie(SESSION_COOKIE, cookieOpts);
    res.json({ ok: true });
  }

  return { middleware, requireAdmin, login, callback, logout };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function page(title, message) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/assets/css/style.css"><main><div class="container"><div class="panel empty"><h2>${title}</h2><p>${message}</p><p><a href="/admin.html">Back to admin</a> · <a href="/">Catalog</a></p></div></div></main>`;
}

module.exports = { createAuth, sign, verify, SESSION_COOKIE };
