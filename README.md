# GeoSAI Data — katalog data spasial

Catalog site for selling Indonesian geospatial datasets, hosted free on GitHub Pages, with a small admin CMS at `/admin.html`.

Live site: https://geosai-geospatial.github.io/data-repository/

## How it works

There is no server. The catalog is one file in this repository, `public/data/datasets.json`:

```
Admin page ──(your GitHub token)──► GitHub API: commit datasets.json
                                          │ push
                                          ▼
                     GitHub Actions: validate datasets.json → deploy public/ to Pages
                                          │ ~1 minute
                                          ▼
Public pages ──────────────────────► read data/datasets.json
```

- **Sign in.** Paste a GitHub fine-grained access token. The admin accepts it only if GitHub says it can write to this repository, so whoever can edit the repo can edit the catalog. The token is kept in the browser tab (or on the device, if you tick *Remember*) and is only ever sent to `api.github.com`.
- **Every save is a commit** (`CMS: add …`, `CMS: update …`, `CMS: delete …`), so you have a full history and can undo anything with git.
- **Safety net.** The form validates input, and the deploy workflow checks `datasets.json` again (`scripts/validate-datasets.js`). If the file is broken, for example by a hand edit, the deploy stops and the live site keeps the last good version.
- **Drafts.** Untick *Published* to hide a dataset from the catalog. Drafts are still in `datasets.json`, which is public in a public repository, so don't put secrets in them.
- **Coverage image.** Upload a PNG (or JPEG/WebP, max 5 MB) in the form; it is committed to `public/data/images/<id>.png` and shown under *Cakupan wilayah* on the detail page. Replacing or removing it, or deleting the dataset, also removes the old file.
- **IDs.** The dataset ID is the URL slug (`dataset.html?id=…`) and is fixed after creation so links shared with buyers keep working.

## One-time setup

1. **Pages:** Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Token:** [GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token](https://github.com/settings/personal-access-tokens/new)
   - Resource owner: `geosai-geospatial` (an organisation owner may need to approve the token)
   - Repository access: *Only select repositories* → `data-repository`
   - Permissions → Repository → **Contents: Read and write**
3. Open `/admin.html` on the live site and paste the token.

When the token expires, generate a new one and sign in again.

## Configuration

`public/assets/js/config.js`:

- `contacts`: Telegram, Discord, email (empty values are hidden).
- `cms`: the repository, branch and file path the admin commits to. An empty `branch` means the repo's default branch. The deploy workflow (`.github/workflows/pages.yml`) runs on pushes to `main` and `claude/vibrant-clarke-y6qm5s`; if you change the default branch, make sure it is in that list.

Styling: `public/assets/css/style.css` (brand colour is `--brand`).

## Local preview and tests

```sh
npm start        # serves public/ at http://localhost:8000
npm test         # schema tests
npm run validate # check public/data/datasets.json
```

Saving from a local preview commits to the real repository, the same as on the live site.

## Before going live

- [ ] Replace placeholder Telegram/Discord handles in `config.js`
- [ ] Replace the example datasets with real ones through the admin (especially feature counts)
- [ ] Check redistribution rights for each source
