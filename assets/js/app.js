(function () {
  "use strict";

  var SITE = window.SITE;
  var DATASETS = window.DATASETS || [];

  var ICONS = {
    logo: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>',
    telegram: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M9.78 15.27 9.6 19.3c.39 0 .56-.17.76-.37l1.83-1.75 3.79 2.78c.7.38 1.19.18 1.38-.64l2.5-11.75c.23-1.04-.37-1.45-1.05-1.2L3.1 11.1c-1 .39-.98.95-.17 1.2l3.76 1.17 8.73-5.5c.41-.27.79-.12.48.15"/></svg>',
    discord: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.32 4.37A19.8 19.8 0 0 0 15.4 2.85a13.9 13.9 0 0 0-.63 1.29 18.4 18.4 0 0 0-5.53 0 12.6 12.6 0 0 0-.64-1.29 19.7 19.7 0 0 0-4.93 1.53C.53 9.05-.32 13.6.1 18.1a19.9 19.9 0 0 0 6.04 3.05c.49-.67.92-1.37 1.3-2.11a12.9 12.9 0 0 1-2.04-.98l.5-.39a14.2 14.2 0 0 0 12.2 0l.5.39c-.65.39-1.33.71-2.05.98.38.74.81 1.45 1.3 2.11a19.8 19.8 0 0 0 6.05-3.05c.5-5.22-.84-9.73-3.55-13.73ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.95-2.42 2.16-2.42s2.18 1.1 2.16 2.42c0 1.34-.96 2.42-2.16 2.42Zm7.97 0c-1.19 0-2.16-1.08-2.16-2.42 0-1.33.95-2.42 2.16-2.42 1.2 0 2.18 1.1 2.16 2.42 0 1.34-.95 2.42-2.16 2.42Z"/></svg>',
    email: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtNumber(n) {
    return n ? Number(n).toLocaleString("id-ID") : "—";
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso + "T00:00:00");
    return isNaN(d) ? iso : d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
  }

  // ---------- Shared layout ----------
  function renderLayout(page) {
    var header = document.getElementById("site-header");
    if (header) {
      header.innerHTML =
        '<div class="container">' +
        '<a class="logo" href="index.html"><span class="logo-mark">' + ICONS.logo + '</span><span class="name">' + esc(SITE.name) + "</span></a>" +
        '<nav class="nav">' +
        '<a href="index.html"' + (page === "home" || page === "dataset" ? ' class="active"' : "") + ">Katalog Data</a>" +
        '<a href="contact.html"' + (page === "contact" ? ' class="active"' : "") + ">Kontak</a>" +
        "</nav></div>";
    }
    var footer = document.getElementById("site-footer");
    if (footer) {
      footer.innerHTML =
        '<div class="container">' +
        "<div>&copy; " + new Date().getFullYear() + " " + esc(SITE.name) + ". Data spasial untuk riset, perencanaan, dan uji tuntas.</div>" +
        '<nav><a href="index.html">Katalog</a><a href="contact.html">Kontak</a></nav>' +
        "</div>";
    }
  }

  function contactButtons() {
    var c = SITE.contacts, html = "";
    if (c.telegram) html += '<a class="btn btn-telegram" href="' + esc(c.telegram) + '" target="_blank" rel="noopener">' + ICONS.telegram + "Chat via Telegram</a>";
    if (c.discord) html += '<a class="btn btn-discord" href="' + esc(c.discord) + '" target="_blank" rel="noopener">' + ICONS.discord + "Gabung Discord</a>";
    if (c.email) html += '<a class="btn btn-email" href="mailto:' + esc(c.email) + '">' + ICONS.email + "Kirim Email</a>";
    return html;
  }

  // ---------- Home ----------
  function renderHome() {
    var cats = [];
    DATASETS.forEach(function (d) { if (cats.indexOf(d.category) < 0) cats.push(d.category); });

    var stat = document.getElementById("stat-datasets");
    if (stat) stat.textContent = DATASETS.length;
    var statCat = document.getElementById("stat-categories");
    if (statCat) statCat.textContent = cats.length;

    var chipsEl = document.getElementById("chips");
    var gridEl = document.getElementById("grid");
    var searchEl = document.getElementById("search");
    var state = { cat: "Semua", q: "" };

    chipsEl.innerHTML = ["Semua"].concat(cats).map(function (c) {
      return '<button class="chip" data-cat="' + esc(c) + '">' + esc(c) + "</button>";
    }).join("");

    function draw() {
      var q = state.q.toLowerCase();
      var list = DATASETS.filter(function (d) {
        var inCat = state.cat === "Semua" || d.category === state.cat;
        var hay = (d.title + " " + d.summary + " " + d.category + " " + d.coverage).toLowerCase();
        return inCat && (!q || hay.indexOf(q) >= 0);
      });
      Array.prototype.forEach.call(chipsEl.children, function (b) {
        b.classList.toggle("active", b.getAttribute("data-cat") === state.cat);
      });
      if (!list.length) {
        gridEl.innerHTML = '<div class="empty">Tidak ada dataset yang cocok. Butuh data lain? <a href="contact.html">Hubungi kami</a>.</div>';
        return;
      }
      gridEl.innerHTML = list.map(function (d) {
        return (
          '<a class="card" href="dataset.html?id=' + encodeURIComponent(d.id) + '">' +
          '<div class="card-meta"><span class="badge cat">' + esc(d.category) + "</span>" +
          d.format.map(function (f) { return '<span class="badge">' + esc(f) + "</span>"; }).join("") + "</div>" +
          "<h3>" + esc(d.title) + "</h3>" +
          "<p>" + esc(d.summary) + "</p>" +
          '<div class="card-meta"><span class="badge">' + esc(d.coverage) + '</span><span class="badge">Tahun ' + esc(d.year) + "</span></div>" +
          '<div class="card-foot"><span class="price">' + esc(d.price) + '</span><span class="more">Lihat detail →</span></div>' +
          "</a>"
        );
      }).join("");
    }

    chipsEl.addEventListener("click", function (e) {
      var b = e.target.closest(".chip");
      if (b) { state.cat = b.getAttribute("data-cat"); draw(); }
    });
    searchEl.addEventListener("input", function () { state.q = searchEl.value; draw(); });
    draw();
  }

  // ---------- Detail ----------
  function renderDataset() {
    var id = new URLSearchParams(location.search).get("id");
    var d = DATASETS.filter(function (x) { return x.id === id; })[0];
    var root = document.getElementById("detail");

    if (!d) {
      root.innerHTML = '<div class="panel empty"><h2>Dataset tidak ditemukan</h2><p><a href="index.html">← Kembali ke katalog</a></p></div>';
      return;
    }
    document.title = d.title + " — " + SITE.name;

    var specs = [
      ["Kategori", d.category],
      ["Cakupan", d.coverage],
      ["Tahun data", d.year],
      ["Sumber", d.source],
      ["Format", d.format.join(", ")],
      ["Sistem koordinat", d.crs],
      ["Tipe geometri", d.geometry],
      ["Jumlah fitur", fmtNumber(d.features)],
      ["Ukuran file", d.size],
      ["Listing diperbarui", fmtDate(d.updated)],
    ];

    root.innerHTML =
      '<div class="breadcrumb"><a href="index.html">Katalog</a> / ' + esc(d.category) + "</div>" +
      '<div class="detail-head"><span class="badge cat">' + esc(d.category) + "</span>" +
      "<h1>" + esc(d.title) + '</h1><p class="lead">' + esc(d.summary) + "</p></div>" +
      '<div class="detail"><div>' +
      '<section class="panel"><h2>Deskripsi</h2>' + d.description.map(function (p) { return "<p>" + esc(p) + "</p>"; }).join("") + "</section>" +
      '<section class="panel"><h2>Cakupan wilayah</h2><div id="map" role="img" aria-label="Peta cakupan ' + esc(d.coverage) + '"></div></section>' +
      '<section class="panel"><h2>Struktur atribut</h2><div class="table-wrap"><table class="attr"><thead><tr><th>Kolom</th><th>Tipe</th><th>Keterangan</th></tr></thead><tbody>' +
      d.attributes.map(function (a) {
        return "<tr><td><code>" + esc(a.name) + "</code></td><td>" + esc(a.type) + "</td><td>" + esc(a.description) + "</td></tr>";
      }).join("") +
      "</tbody></table></div></section>" +
      "</div>" +
      '<aside><div class="panel buy">' +
      '<p class="small">Harga</p><p class="price-big">' + esc(d.price) + "</p>" +
      '<p class="small">' + esc(SITE.responseTime) + "</p>" +
      contactButtons() +
      '<ol class="steps"><li>Kirim nama dataset ini lewat Telegram atau Discord.</li><li>Kami kirim penawaran, sampel atribut, dan pratinjau geometri.</li><li>Setelah pembayaran dikonfirmasi, file dikirim via tautan unduhan.</li></ol>' +
      "</div>" +
      '<div class="panel"><h2>Spesifikasi</h2><table class="specs"><tbody>' +
      specs.map(function (s) { return "<tr><th>" + esc(s[0]) + "</th><td>" + esc(s[1]) + "</td></tr>"; }).join("") +
      "</tbody></table></div></aside></div>";

    drawMap(d.bbox);
  }

  function drawMap(bbox) {
    var el = document.getElementById("map");
    if (!el || !window.L || !bbox) { if (el) el.closest(".panel").style.display = "none"; return; }
    var bounds = [[bbox[1], bbox[0]], [bbox[3], bbox[2]]];
    var map = L.map(el, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    }).addTo(map);
    L.rectangle(bounds, { color: "#0f5e4b", weight: 2, fillOpacity: 0.12 }).addTo(map);
    map.fitBounds(bounds, { padding: [16, 16] });
  }

  // ---------- Contact ----------
  function renderContact() {
    var c = SITE.contacts, cards = [];
    if (c.telegram) cards.push({ cls: "btn-telegram", bg: "#229ed9", icon: ICONS.telegram, title: "Telegram", label: c.telegramLabel, text: "Cara tercepat untuk bertanya, minta sampel, dan memesan data.", href: c.telegram, cta: "Chat via Telegram" });
    if (c.discord) cards.push({ cls: "btn-discord", bg: "#5865f2", icon: ICONS.discord, title: "Discord", label: c.discordLabel, text: "Gabung komunitas untuk info rilis dataset baru dan diskusi teknis.", href: c.discord, cta: "Gabung Discord" });
    if (c.email) cards.push({ cls: "btn-email", bg: "#374151", icon: ICONS.email, title: "Email", label: c.email, text: "Untuk penawaran resmi, invoice, dan kebutuhan institusi.", href: "mailto:" + c.email, cta: "Kirim Email" });

    document.getElementById("contact-cards").innerHTML = cards.map(function (k) {
      var ext = k.href.indexOf("mailto:") === 0 ? "" : ' target="_blank" rel="noopener"';
      return (
        '<div class="panel contact-card">' +
        '<div class="icon" style="background:' + k.bg + '">' + k.icon + "</div>" +
        "<h3>" + esc(k.title) + "</h3><p><strong>" + esc(k.label) + "</strong></p><p>" + esc(k.text) + "</p>" +
        '<a class="btn ' + k.cls + '" href="' + esc(k.href) + '"' + ext + ">" + esc(k.cta) + "</a></div>"
      );
    }).join("");
    var rt = document.getElementById("response-time");
    if (rt) rt.textContent = SITE.responseTime;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var page = document.body.getAttribute("data-page");
    renderLayout(page);
    if (page === "home") renderHome();
    if (page === "dataset") renderDataset();
    if (page === "contact") renderContact();
  });
})();
