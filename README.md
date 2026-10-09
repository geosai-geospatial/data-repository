# GeoSAI Data — katalog data spasial

Catalog site for selling Indonesian geospatial datasets (IUP mining, IUPHHK-HTI/HA, kawasan hutan, plantation concessions, admin boundaries), with a small admin CMS. The owner signs in with GitHub and creates, edits, publishes/unpublishes and deletes datasets; the public pages update immediately.

## How it works

```
Browser ──► Node/Express (server.js)
             ├── /                 public pages (public/*.html), read datasets from the API
             ├── /admin.html       CMS (list + form), needs a session
             ├── /api/datasets     GET = public · POST/PUT/DELETE = admin only
             ├── /auth/github      → GitHub OAuth → /auth/github/callback
             └── data/datasets.json  the database (one JSON file)
```

- **Login.** GitHub OAuth with no scopes (only the public profile is read). After GitHub confirms who you are, the server checks the username against `ADMIN_GITHUB_USERS`; anyone else gets "Access denied". The session is an HMAC-signed, HttpOnly cookie valid for 7 days; the GitHub token is discarded.
- **Storage.** `data/datasets.json`, created from `data/seed.json` (the example datasets) on first start. Writes are atomic (temp file + rename). Fine for one admin and hundreds of datasets; swap `lib/store.js` for a database if that ever changes.
- **Drafts.** Untick *Published* to hide a dataset from the public catalog while you prepare it.
- **IDs.** The dataset ID is the URL slug (`dataset.html?id=…`) and is fixed after creation so links shared with buyers keep working.

## Run locally

Requires Node.js ≥ 20.12.

1. Create a GitHub OAuth app: **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
   - Homepage URL: `http://localhost:3000`
   - Authorization callback URL: `http://localhost:3000/auth/github/callback`
2. Configure and start:
   ```sh
   cp .env.example .env      # fill in client ID/secret, your GitHub username, SESSION_SECRET
   npm install
   npm start                 # or: npm run dev (auto-restart)
   ```
3. Open http://localhost:3000/admin.html and sign in.

Run the tests with `npm test`.

## Deploy

GitHub Pages only serves static files, so it can't run the login or save edits. Deploy to any Node host instead (Render, Railway, Fly.io, a VPS):

- Start command `npm start`, build command `npm install`.
- Set the variables from `.env.example`. `BASE_URL` must be the public `https://…` URL, and the OAuth app's callback must be `BASE_URL/auth/github/callback` (create a separate OAuth app for production).
- **Attach a persistent disk and point `DATA_DIR` at it.** Most hosts wipe the container filesystem on each deploy; without a persistent disk your edits are lost.
- Back up `datasets.json` occasionally (download it from the disk, or copy it into `data/seed.json` and commit).

## Editing other content

- **Contacts and site name** — `public/assets/js/config.js`.
- **Styling** — `public/assets/css/style.css` (brand colour is `--brand`).

## Before going live

- [ ] Replace placeholder Telegram/Discord handles in `config.js`
- [ ] Replace the example datasets with real ones through the admin (especially feature counts)
- [ ] Check redistribution rights for each source
