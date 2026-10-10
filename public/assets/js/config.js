// Site-wide settings. Edit these values before publishing.
window.SITE = {
  name: "GeoSAI Data",
  tagline: "Data spasial Indonesia yang terkurasi, terdokumentasi, dan siap pakai.",
  contacts: {
    // Email is the main channel: every "ask" and "order" button opens a
    // pre-filled email to this address.
    email: "geosai.geospatial@gmail.com",
    // Leave a value empty ("") to hide it. Fill these in once the channels exist.
    telegram: "",
    telegramLabel: "",
    discord: "",
    discordLabel: "",
    // Channels shown as "segera hadir" (coming soon). Remove a name once its link is set above.
    comingSoon: ["Telegram", "Discord"],
  },
  responseTime: "Biasanya membalas dalam 1×24 jam (hari kerja, WIB).",
  // Admin (admin.html) saves edits as commits to this repository through the
  // GitHub API. Leave branch empty to use the repository's default branch.
  cms: {
    owner: "geosai-geospatial",
    repo: "data-repository",
    branch: "",
    path: "public/data/datasets.json",
    // Admin-only Google Drive folder links. Kept outside public/ so it is not
    // part of the website, but the repository is public, so it is still
    // readable on GitHub: keep the Drive folders' sharing set to Restricted.
    linksPath: "cms/drive-links.json",
  },
};
