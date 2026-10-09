# GeoSAI Data — katalog data spasial

Static landing page for selling Indonesian geospatial datasets (IUP mining, IUPHHK-HTI/HA, kawasan hutan, plantation concessions, admin boundaries). No build step: plain HTML, CSS and JavaScript, served by GitHub Pages.

Live site (after Pages is enabled): https://geosai-geospatial.github.io/data-repository/

## Pages

| File | Purpose |
|---|---|
| `index.html` | Catalog: hero, search and category filter, dataset cards |
| `dataset.html?id=<id>` | Dataset detail: description, coverage map, attribute table, specs, contact buttons |
| `contact.html` | Telegram / Discord / email links and FAQ |

## Editing content

- **Datasets** — `assets/js/datasets.js`. One object per dataset; add, remove or edit entries and the catalog and detail pages update automatically. The entries shipped here are **examples**: replace feature counts (`features: 0` shows as "—"), years, sources, sizes, prices and attributes with the real values of the data you hold.
- **Contacts and site name** — `assets/js/config.js`. Set your Telegram link, Discord invite and (optionally) email. Empty values are hidden.
- **Styling** — `assets/css/style.css` (brand colour is `--brand`).

## Publishing on GitHub Pages

Deployment runs from `.github/workflows/pages.yml` on every push to `main` (or the current working branch).

1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push a commit, or run the workflow manually from the **Actions** tab ("Deploy site to GitHub Pages" → Run workflow).
3. When the run is green, the site is live at the URL above.

GitHub Pages on a private repository requires a paid GitHub plan; on the free plan the repository must be public.

## Local preview

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Before going live

- [ ] Replace placeholder Telegram/Discord handles in `config.js`
- [ ] Replace example values in `datasets.js` with the real ones (especially `features`)
- [ ] Remove datasets you don't actually have
- [ ] Check redistribution rights for each source
