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
- **Hiding datasets.** Click *Hide* next to a dataset in the admin list (or untick *Visible on the website* in the form) to take it off the public site: it disappears from the catalog, search, related datasets, and its detail page shows "not found". Click *Show* to bring it back. Each toggle is one commit (`CMS: hide …` / `CMS: show …`) and leaves the *Updated* date alone. Hidden datasets are still in `datasets.json`, which is public in a public repository, so don't put secrets in them.
- **Coverage image.** Upload a PNG (or JPEG/WebP, max 5 MB) in the form; it is committed to `public/data/images/<id>.png` and shown under *Cakupan wilayah* on the detail page. Replacing or removing it, or deleting the dataset, also removes the old file.
- **Coverage map from data.** Instead of uploading an image, pick a GeoJSON, a zipped shapefile, or the `.shp`/`.dbf`/`.prj` files under *Make the coverage map from data* and click *Make map*. The file is read and drawn in the browser (`assets/js/staticmap.js`); only the finished 1600×1000 PNG is saved, as the coverage image. The map follows standard cartographic practice: title and subtitle, an equal-area projection centred on the data, a muted Natural Earth basemap with the focus country lighter and neighbours labelled, graticule labelled in the margin (BT/LS), a legend with feature counts (one colour, or a colour-blind-safe palette by a chosen field, with small classes grouped as *Lainnya*), a scale bar and north arrow, a locator inset for small areas, and source/projection credits. Coordinates in UTM or Web Mercator (from the `.prj` or a GeoJSON `crs`) are converted to WGS 84; other projections must be exported as EPSG:4326 first. *Fill form from file* copies the bounding box, geometry, feature count and attribute names/types into the form.
- **Google Drive link (admin only).** Each dataset can have a link to its Drive folder, shown as a *Drive ↗* shortcut in the admin list. It is stored in `cms/drive-links.json`, outside `public/`, so it is not on the website. The repository is public, though, so the file is readable on GitHub: keep every Drive folder's sharing set to **Restricted** and share it with each buyer by email.
- **Free datasets.** Tick *Free* and paste a public download link (usually the Drive folder, shared as *Anyone with the link – Viewer*). The catalog then shows a *Gratis* badge and filter, the price reads *Gratis*, and the detail page replaces the email/order panel with an *Unduh gratis* button that opens the link, so visitors download without contacting you. The link is stored in `datasets.json`, so it is public.
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

- `contacts`: `email` is the main channel; every ask/sample/order button opens a pre-filled email to it (with a Gmail fallback and a copy button). Telegram and Discord are hidden while empty; names in `comingSoon` are shown as "Segera hadir".
- `cms`: the repository, branch and file path the admin commits to. An empty `branch` means the repo's default branch. The deploy workflow (`.github/workflows/pages.yml`) runs on pushes to `main` and `claude/vibrant-clarke-y6qm5s`; if you change the default branch, make sure it is in that list.

Styling: `public/assets/css/style.css` (brand colour is `--brand`).

Basemap: `public/data/basemap.json` (countries around Indonesia, simplified from Natural Earth, public domain). To rebuild it:

```sh
curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson
node scripts/build-basemap.js ne_10m_admin_0_countries.geojson
```

## Local preview and tests

```sh
npm start        # serves public/ at http://localhost:8000
npm test         # schema and static map tests
npm run validate # check public/data/datasets.json
```

Saving from a local preview commits to the real repository, the same as on the live site.

## Before going live

- [ ] When Telegram/Discord are ready: set their links in `config.js` and remove them from `comingSoon`
- [ ] Replace the example datasets with real ones through the admin (especially feature counts)
- [ ] Check redistribution rights for each source
