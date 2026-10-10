(function () {
  "use strict";

  var SITE = window.SITE;
  var DATASETS = [];

  var ICONS = {
    logo: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>',
    telegram: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M9.78 15.27 9.6 19.3c.39 0 .56-.17.76-.37l1.83-1.75 3.79 2.78c.7.38 1.19.18 1.38-.64l2.5-11.75c.23-1.04-.37-1.45-1.05-1.2L3.1 11.1c-1 .39-.98.95-.17 1.2l3.76 1.17 8.73-5.5c.41-.27.79-.12.48.15"/></svg>',
    discord: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.32 4.37A19.8 19.8 0 0 0 15.4 2.85a13.9 13.9 0 0 0-.63 1.29 18.4 18.4 0 0 0-5.53 0 12.6 12.6 0 0 0-.64-1.29 19.7 19.7 0 0 0-4.93 1.53C.53 9.05-.32 13.6.1 18.1a19.9 19.9 0 0 0 6.04 3.05c.49-.67.92-1.37 1.3-2.11a12.9 12.9 0 0 1-2.04-.98l.5-.39a14.2 14.2 0 0 0 12.2 0l.5.39c-.65.39-1.33.71-2.05.98.38.74.81 1.45 1.3 2.11a19.8 19.8 0 0 0 6.05-3.05c.5-5.22-.84-9.73-3.55-13.73ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.95-2.42 2.16-2.42s2.18 1.1 2.16 2.42c0 1.34-.96 2.42-2.16 2.42Zm7.97 0c-1.19 0-2.16-1.08-2.16-2.42 0-1.33.95-2.42 2.16-2.42 1.2 0 2.18 1.1 2.16 2.42 0 1.34-.95 2.42-2.16 2.42Z"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    arrow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    calendar: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    pin: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    globe: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
    file: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    source: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z"/><path d="M6.5 17A2.5 2.5 0 0 0 4 19.5 2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>',
    clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    shield: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
    download: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg>',
    email: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
  };

  // Category illustrations for cards without a coverage image. Unknown categories fall back to the map.
  var CATEGORY_ICONS = {
    pertambangan: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 3 4 8 5-5 5 15H2L8 3z"/></svg>',
    kehutanan: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 6 10h3l-4 6h14l-4-6h3L12 2z"/><path d="M12 16v6"/></svg>',
    perkebunan: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.4 5.2-6.1 2.4-.5 4.8-2 5.8-3.9"/></svg>',
    administrasi: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/></svg>',
  };

  function catKey(c) {
    return String(c || "").toLowerCase().replace(/[^a-z]/g, "");
  }

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
        '<nav class="nav" aria-label="Navigasi utama">' +
        '<a href="services.html"' + (page === "services" ? ' class="active"' : "") + ">Layanan</a>" +
        '<a href="index.html#katalog"' + (page === "home" || page === "dataset" ? ' class="active"' : "") + ">Data</a>" +
        '<a href="buat-peta.html"' + (page === "mapmaker" ? ' class="active"' : "") + ">Buat Peta</a>" +
        '<a href="contact.html"' + (page === "contact" ? ' class="active"' : "") + ">Kontak</a>" +
        (page === "admin" ? "" : '<a class="nav-cta" href="contact.html" data-service="">Konsultasi</a>') +
        "</nav></div>";
    }
    var footer = document.getElementById("site-footer");
    if (footer) {
      footer.innerHTML =
        '<div class="container"><div class="footer-grid">' +
        '<div><a class="logo" href="index.html"><span class="logo-mark">' + ICONS.logo + "</span>" + esc(SITE.name) + "</a>" +
        "<p>" + esc(SITE.tagline) + "</p></div>" +
        '<div><h4>Layanan</h4><ul><li><a href="services.html#uji-tuntas">Uji tuntas spasial</a></li><li><a href="services.html#penginderaan-jauh">Penginderaan jauh</a></li><li><a href="services.html#karbon">Proyek karbon</a></li><li><a href="services.html">Semua layanan</a></li></ul></div>' +
        '<div><h4>Data</h4><ul><li><a href="index.html#katalog">Katalog dataset</a></li><li><a href="buat-peta.html">Buat peta gratis</a></li><li><a href="contact.html">Minta sampel</a></li></ul></div>' +
        '<div><h4>Bantuan</h4><ul><li><a href="contact.html">Kontak &amp; pemesanan</a></li><li><a href="contact.html#faq">Pertanyaan umum</a></li></ul></div>' +
        "</div>" +
        '<div class="footer-bottom"><span>&copy; ' + new Date().getFullYear() + " " + esc(SITE.name) + ".</span>" +
        "<span>Data dan hasil analisis bersifat referensi, bukan pengganti dokumen legal resmi.</span></div>" +
        "</div>";
    }
  }

  // ---------- Email ----------
  // Email is the main channel. Every button opens a pre-filled message so
  // visitors don't have to work out what to write or what we need from them.
  function dsLines(d) {
    if (!d) return [];
    var url = location.origin + location.pathname.replace(/[^/]*$/, "") + "dataset.html?id=" + encodeURIComponent(d.id);
    return ["- Dataset: " + d.title, "- Kode: " + d.id, "- Tautan: " + url, ""];
  }

  function greet(t) {
    t.body = ["Halo GeoSAI,", ""].concat(t.body).concat(["", "Terima kasih."]).join("\n");
    return t;
  }

  var WHO = ["- Nama:", "- Instansi/perusahaan:"];

  // Enquiry about a service; an empty name is a general consultation.
  function serviceTemplate(service) {
    return greet({
      subject: "Konsultasi layanan geospasial" + (service ? ": " + service : ""),
      body: ["Saya ingin berkonsultasi tentang pekerjaan geospasial berikut:", ""]
        .concat(service ? ["- Layanan: " + service] : [])
        .concat(["- Pertanyaan yang ingin dijawab:", "- Lokasi / luas area (lampirkan SHP, KML, atau koordinat jika ada):", "- Tenggat waktu:", "- Hasil yang dibutuhkan (laporan / peta / data):"])
        .concat(WHO),
    });
  }

  function mailTemplate(kind, d) {
    if (kind === "service") return serviceTemplate("");
    var name = d ? d.title : "";
    var who = WHO;
    var t = {
      ask: {
        subject: "Pertanyaan data spasial" + (d ? ": " + name : ""),
        body: [d ? "Saya ingin bertanya tentang dataset berikut:" : "Saya mencari data spasial dengan kebutuhan berikut:", ""]
          .concat(dsLines(d))
          .concat(d ? ["Pertanyaan saya:", "", ""] : ["- Data yang dicari:", "- Wilayah:", "- Tahun data:", "- Format (SHP / GPKG / lainnya):", ""])
          .concat(who),
      },
      sample: {
        subject: "Permintaan sampel" + (d ? ": " + name : " dataset"),
        body: ["Saya ingin melihat sampel data sebelum membeli.", ""]
          .concat(d ? dsLines(d) : ["- Dataset:", ""])
          .concat(["- Wilayah sampel yang diinginkan:"]).concat(who),
      },
      order: {
        subject: "Pemesanan dataset" + (d ? ": " + name : ""),
        body: ["Saya ingin memesan dataset berikut:", ""]
          .concat(d ? dsLines(d) : ["- Dataset:", ""])
          .concat(["Detail kebutuhan:", "- Wilayah (seluruh cakupan / provinsi / kabupaten):", "- Format (SHP / GPKG / lainnya):", "- Keperluan penggunaan:"])
          .concat(who)
          .concat(["", "Mohon informasi harga dan cara pembayarannya."]),
      },
      invoice: {
        subject: "Permintaan penawaran resmi" + (d ? ": " + name : ""),
        body: ["Kami membutuhkan penawaran resmi untuk pengadaan data atau layanan geospasial.", ""]
          .concat(d ? dsLines(d) : ["- Dataset / layanan:", ""])
          .concat(["- Nama instansi/perusahaan:", "- Nama & jabatan penanggung jawab:", "- Alamat penagihan:", "- Dokumen yang dibutuhkan (penawaran / invoice / kuitansi):"]),
      },
    }[kind];
    return greet(t);
  }

  function mailto(t) {
    return "mailto:" + SITE.contacts.email + "?subject=" + encodeURIComponent(t.subject) + "&body=" + encodeURIComponent(t.body);
  }

  // For visitors without a desktop mail app, where mailto: links do nothing.
  function gmailUrl(t) {
    return "https://mail.google.com/mail/?view=cm&fs=1&to=" + encodeURIComponent(SITE.contacts.email) +
      "&su=" + encodeURIComponent(t.subject) + "&body=" + encodeURIComponent(t.body);
  }

  function copyButton() {
    return '<button type="button" class="copy-btn" data-copy="' + esc(SITE.contacts.email) + '">Salin</button>';
  }

  function emailFallback(t) {
    return '<p class="email-alt">Aplikasi email tidak terbuka? <a href="' + esc(gmailUrl(t)) + '" target="_blank" rel="noopener">Kirim lewat Gmail</a> ' +
      "atau kirim ke <strong>" + esc(SITE.contacts.email) + "</strong> " + copyButton() + "</p>";
  }

  function comingSoonNote() {
    var soon = SITE.contacts.comingSoon || [];
    return soon.length ? '<p class="soon-note"><span class="soon-badge">Segera hadir</span>' + esc(soon.join(" & ")) + "</p>" : "";
  }

  function contactButtons(d) {
    var c = SITE.contacts, html = "";
    if (c.email) {
      var order = mailTemplate("order", d);
      html += '<a class="btn btn-primary" href="' + esc(mailto(order)) + '">' + ICONS.email + "Pesan via Email</a>";
      html += '<a class="btn btn-email" href="' + esc(mailto(mailTemplate("sample", d))) + '">Minta sampel gratis</a>';
      html += emailFallback(order);
    }
    if (c.telegram) html += '<a class="btn btn-telegram" href="' + esc(c.telegram) + '" target="_blank" rel="noopener">' + ICONS.telegram + "Chat via Telegram</a>";
    if (c.discord) html += '<a class="btn btn-discord" href="' + esc(c.discord) + '" target="_blank" rel="noopener">' + ICONS.discord + "Gabung Discord</a>";
    return html + comingSoonNote();
  }

  function initCopy() {
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-copy]");
      if (!b) return;
      var text = b.getAttribute("data-copy");
      var done = function () {
        var label = b.textContent;
        b.textContent = "Tersalin ✓";
        setTimeout(function () { b.textContent = label; }, 2000);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, function () { window.prompt("Salin alamat email:", text); });
      } else {
        window.prompt("Salin alamat email:", text);
      }
    });
  }

  // Service buttons link to contact.html without JS; with JS they open a
  // pre-filled email naming the service (an empty value is a general enquiry).
  function wireServiceButtons() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-service]"), function (a) {
      if (SITE.contacts.email) a.href = mailto(serviceTemplate(a.getAttribute("data-service")));
    });
  }

  // ---------- Home ----------
  function thumb(d, withBadge) {
    var key = catKey(d.category);
    var badge = withBadge ? '<span class="badge solid badge-float">' + esc(d.category) + "</span>" : "";
    if (withBadge && d.free) badge += '<span class="badge free badge-free">Gratis</span>';
    if (d.image) {
      return '<div class="thumb has-img t-' + key + '">' + badge +
        '<img src="' + esc(imageUrl(d)) + '" alt="" loading="lazy">' +
        '<span class="cat-icon">' + (CATEGORY_ICONS[key] || ICONS.logo) + "</span></div>";
    }
    return '<div class="thumb t-' + key + '">' + badge + '<span class="cat-icon">' + (CATEGORY_ICONS[key] || ICONS.logo) + "</span></div>";
  }

  // If a thumbnail image is missing (e.g. still deploying), show the category illustration instead.
  function thumbFallback(el) {
    el.addEventListener("error", function (e) {
      var img = e.target;
      if (img.tagName === "IMG" && img.parentNode.classList.contains("thumb")) {
        img.parentNode.classList.remove("has-img");
        img.parentNode.removeChild(img);
      }
    }, true);
  }

  function card(d) {
    return (
      '<a class="card" href="dataset.html?id=' + encodeURIComponent(d.id) + '">' +
      thumb(d, true) +
      '<div class="card-body">' +
      '<div class="card-meta">' + (d.format || []).map(function (f) { return '<span class="badge">' + esc(f) + "</span>"; }).join("") + "</div>" +
      "<h3>" + esc(d.title) + "</h3>" +
      "<p>" + esc(d.summary) + "</p>" +
      '<div class="card-facts">' +
      (d.coverage ? "<span>" + ICONS.pin + esc(d.coverage) + "</span>" : "") +
      (d.year ? "<span>" + ICONS.calendar + "Data " + esc(d.year) + "</span>" : "") +
      "</div></div>" +
      (d.free
        ? '<div class="card-foot"><span class="price free"><small>Harga</small>Gratis</span>' +
          '<span class="more">Unduh gratis ' + ICONS.arrow + "</span></div>"
        : '<div class="card-foot"><span class="price"><small>Harga</small>' + esc(d.price || "Hubungi kami") + "</span>" +
          '<span class="more">Lihat detail ' + ICONS.arrow + "</span></div>") +
      "</a>"
    );
  }

  // A real spec sheet in the hero, so visitors see the level of documentation before scrolling.
  function renderPreview(d) {
    var el = document.getElementById("hero-preview");
    if (!el || !d) return;
    el.innerHTML =
      '<div class="preview">' +
      '<div class="preview-bar"><i></i><i></i><i></i><span>' + esc(d.id) + ".gpkg</span></div>" +
      '<div class="preview-body"><span class="badge cat">' + esc(d.category) + "</span>" +
      "<h3>" + esc(d.title) + "</h3>" +
      '<div class="preview-specs">' +
      "<div>Sistem koordinat<strong>" + esc(d.crs || "—") + "</strong></div>" +
      "<div>Geometri<strong>" + esc(d.geometry || "—") + "</strong></div>" +
      "<div>Tahun data<strong>" + esc(d.year || "—") + "</strong></div>" +
      "<div>Format<strong>" + esc((d.format || []).join(", ") || "—") + "</strong></div>" +
      "</div>" +
      "<table><thead><tr><th>Kolom</th><th>Keterangan</th></tr></thead><tbody>" +
      (d.attributes || []).slice(0, 4).map(function (a) {
        return "<tr><td><code>" + esc(a.name) + "</code></td><td>" + esc(a.description) + "</td></tr>";
      }).join("") +
      "</tbody></table></div>" +
      '<div class="preview-foot"><span class="small">' + (d.attributes || []).length + " kolom terdokumentasi</span>" +
      '<a href="dataset.html?id=' + encodeURIComponent(d.id) + '" tabindex="-1">Lihat spesifikasi →</a></div>' +
      "</div>";
  }

  function latestUpdate(list) {
    return list.reduce(function (max, d) { return d.updated && d.updated > max ? d.updated : max; }, "");
  }

  function renderHome() {
    var cats = [], counts = {};
    DATASETS.forEach(function (d) {
      if (cats.indexOf(d.category) < 0) cats.push(d.category);
      counts[d.category] = (counts[d.category] || 0) + 1;
    });

    var stat = document.getElementById("stat-datasets");
    if (stat) stat.textContent = DATASETS.length;
    var statCat = document.getElementById("stat-categories");
    if (statCat) statCat.textContent = cats.length;
    var statUpd = document.getElementById("stat-updated");
    var last = latestUpdate(DATASETS);
    if (statUpd && last) statUpd.textContent = fmtDate(last);

    // Prefer the best-documented dataset for the hero preview.
    renderPreview(DATASETS.slice().sort(function (a, b) {
      return (b.attributes || []).length - (a.attributes || []).length;
    })[0]);

    var chipsEl = document.getElementById("chips");
    var gridEl = document.getElementById("grid");
    var searchEl = document.getElementById("search");
    var countEl = document.getElementById("result-count");
    var state = { cat: "Semua", q: "" };
    thumbFallback(gridEl);

    // "Gratis" is a filter across categories, shown only when a free dataset exists.
    var FREE = "Gratis";
    var nFree = DATASETS.filter(function (d) { return d.free; }).length;
    chipsEl.innerHTML = ["Semua"].concat(nFree ? [FREE] : []).concat(cats).map(function (c) {
      var n = c === "Semua" ? DATASETS.length : c === FREE ? nFree : counts[c];
      return '<button class="chip" type="button" data-cat="' + esc(c) + '">' + esc(c) + '<span class="n">' + n + "</span></button>";
    }).join("");

    function draw() {
      var q = state.q.toLowerCase();
      var list = DATASETS.filter(function (d) {
        var inCat = state.cat === "Semua" || (state.cat === FREE ? d.free : d.category === state.cat);
        var hay = (d.title + " " + d.summary + " " + d.category + " " + d.coverage + (d.free ? " gratis free" : "")).toLowerCase();
        return inCat && (!q || hay.indexOf(q) >= 0);
      });
      Array.prototype.forEach.call(chipsEl.children, function (b) {
        var on = b.getAttribute("data-cat") === state.cat;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      if (countEl) countEl.textContent = list.length + " dari " + DATASETS.length + " dataset";
      if (!list.length) {
        gridEl.innerHTML = '<div class="empty">Tidak ada dataset yang cocok. Butuh data lain? <a href="contact.html">Hubungi kami</a>.</div>';
        return;
      }
      gridEl.innerHTML = list.map(card).join("");
    }

    chipsEl.addEventListener("click", function (e) {
      var b = e.target.closest(".chip");
      if (b) { state.cat = b.getAttribute("data-cat"); draw(); }
    });
    searchEl.addEventListener("input", function () { state.q = searchEl.value; draw(); });
    draw();
  }

  // ---------- Detail ----------
  function renderDataset(d, all) {
    var root = document.getElementById("detail");

    if (!d) {
      root.innerHTML = '<div class="panel empty"><h2>Dataset tidak ditemukan</h2><p><a href="index.html">← Kembali ke katalog</a></p></div>';
      return;
    }
    document.title = d.title + " — " + SITE.name;

    // Rows without a value are left out: an empty "—" reads as missing data.
    var specs = [
      ["Kategori", d.category],
      ["Cakupan", d.coverage],
      ["Tahun data", d.year],
      ["Sumber", d.source],
      ["Format", (d.format || []).join(", ")],
      ["Sistem koordinat", d.crs],
      ["Tipe geometri", d.geometry],
      ["Jumlah fitur", d.features ? fmtNumber(d.features) : ""],
      ["Ukuran file", d.size],
      ["Listing diperbarui", d.updated ? fmtDate(d.updated) : ""],
    ].filter(function (s) { return s[1]; });

    var attrs = d.attributes || [];
    var related = all.filter(function (x) { return x.id !== d.id && x.category === d.category; })
      .concat(all.filter(function (x) { return x.category !== d.category; }))
      .slice(0, 3);

    root.innerHTML =
      '<nav class="breadcrumb" aria-label="Breadcrumb"><a href="index.html">Katalog</a><span>/</span>' + esc(d.category) + "</nav>" +
      '<div class="detail-head"><span class="badge cat">' + esc(d.category) + "</span>" +
      (d.free ? ' <span class="badge free">Gratis · unduh langsung</span>' : "") +
      "<h1>" + esc(d.title) + '</h1><p class="lead">' + esc(d.summary) + "</p>" +
      '<div class="detail-facts">' +
      (d.coverage ? "<span>" + ICONS.pin + esc(d.coverage) + "</span>" : "") +
      (d.year ? "<span>" + ICONS.calendar + "Data tahun " + esc(d.year) + "</span>" : "") +
      (d.crs ? "<span>" + ICONS.globe + esc(d.crs) + "</span>" : "") +
      ((d.format || []).length ? "<span>" + ICONS.file + esc(d.format.join(" · ")) + "</span>" : "") +
      "</div></div>" +
      '<div class="detail"><div>' +
      '<section class="panel"><h2>Deskripsi</h2>' + (d.description || []).map(function (p) { return "<p>" + esc(p) + "</p>"; }).join("") +
      (d.source ? '<div class="source-note">' + ICONS.source + "<div><strong>Sumber:</strong> " + esc(d.source) + "</div></div>" : "") +
      "</section>" +
      (d.image
        ? '<section class="panel"><h2>Cakupan wilayah</h2><a class="coverage-img" href="' + esc(imageUrl(d)) + '" target="_blank" rel="noopener">' +
          '<img src="' + esc(imageUrl(d)) + '" alt="Peta cakupan ' + esc(d.coverage || d.title) + '"></a></section>'
        : "") +
      (attrs.length
        ? '<section class="panel"><h2>Struktur atribut <span class="count">' + attrs.length + ' kolom</span></h2><div class="table-wrap"><table class="attr"><thead><tr><th>Kolom</th><th>Tipe</th><th>Keterangan</th></tr></thead><tbody>' +
          attrs.map(function (a) {
            return "<tr><td><code>" + esc(a.name) + "</code></td><td>" + esc(a.type) + "</td><td>" + esc(a.description) + "</td></tr>";
          }).join("") +
          "</tbody></table></div></section>"
        : "") +
      "</div>" +
      '<aside>' + (d.free ? freePanel(d, attrs) : buyPanel(d, attrs)) +
      '<div class="panel"><h2>Spesifikasi</h2><table class="specs"><tbody>' +
      specs.map(function (s) { return "<tr><th>" + esc(s[0]) + "</th><td>" + esc(s[1]) + "</td></tr>"; }).join("") +
      "</tbody></table></div></aside></div>" +
      (related.length ? '<section class="related"><h2>Dataset lainnya</h2><div class="grid">' + related.map(card).join("") + "</div></section>" : "");

    thumbFallback(root);
    // If the image is missing (e.g. still deploying), hide the panel instead of showing a broken image.
    var img = root.querySelector(".coverage-img img");
    if (img) img.addEventListener("error", function () { img.closest(".panel").hidden = true; });
  }

  function buyPanel(d, attrs) {
    return '<div class="panel buy">' +
      '<p class="price-label">Harga</p><p class="price-big">' + esc(d.price || "Hubungi kami") + "</p>" +
      '<p class="small">' + ICONS.clock + esc(SITE.responseTime) + "</p>" +
      contactButtons(d) +
      '<div class="guarantee">' + ICONS.shield + "<div><strong>Lihat sampel dulu, bayar kemudian.</strong> Minta potongan data atau tangkapan tabel atribut sebelum memutuskan.</div></div>" +
      '<hr class="divider"><h3>Yang Anda terima</h3><ul class="checklist">' +
      "<li>" + ICONS.check + "File " + esc((d.format || []).join(" / ") || "data") + "</li>" +
      (attrs.length ? "<li>" + ICONS.check + "Kamus atribut (" + attrs.length + " kolom)</li>" : "") +
      "<li>" + ICONS.check + "Catatan sumber dan tahun data</li>" +
      "<li>" + ICONS.check + "Potongan per wilayah atas permintaan</li>" +
      "</ul>" +
      '<hr class="divider"><h3>Cara memesan</h3>' +
      '<ol class="steps"><li>Klik <strong>Pesan via Email</strong>; nama dataset sudah terisi, tinggal lengkapi wilayah dan keperluan.</li><li>Kami kirim penawaran, sampel atribut, dan pratinjau geometri.</li><li>Setelah pembayaran dikonfirmasi, file dikirim via tautan unduhan.</li></ol>' +
      "</div>";
  }

  // Free datasets: one download button, no email, no admin in the loop.
  function freePanel(d, attrs) {
    return '<div class="panel buy free-panel">' +
      '<p class="price-label">Harga</p><p class="price-big">Gratis</p>' +
      '<p class="small">' + ICONS.check + "Tanpa daftar, tanpa menghubungi admin.</p>" +
      '<a class="btn btn-primary btn-download" href="' + esc(d.download) + '" target="_blank" rel="noopener noreferrer">' + ICONS.download + "Unduh gratis</a>" +
      '<p class="email-alt">Tautan membuka folder Google Drive di tab baru. Tidak perlu akun Google.</p>' +
      '<hr class="divider"><h3>Cara mengunduh</h3>' +
      '<ol class="steps"><li>Klik <strong>Unduh gratis</strong>.</li><li>Di Google Drive, klik <strong>Download</strong> (ikon ⤓ di kanan atas) untuk mengunduh semua file sebagai ZIP.</li><li>Ekstrak ZIP, lalu buka file ' + esc((d.format || []).join(" / ") || "data") + " di QGIS atau ArcGIS.</li></ol>" +
      '<hr class="divider"><h3>Yang Anda dapatkan</h3><ul class="checklist">' +
      "<li>" + ICONS.check + "File " + esc((d.format || []).join(" / ") || "data") + "</li>" +
      (attrs.length ? "<li>" + ICONS.check + "Kamus atribut (" + attrs.length + " kolom) di halaman ini</li>" : "") +
      "<li>" + ICONS.check + "Catatan sumber; cantumkan sumbernya saat data dipakai</li>" +
      "</ul>" +
      '<p class="email-alt">Tautan tidak bisa dibuka atau ada pertanyaan? <a href="' + esc(mailto(mailTemplate("ask", d))) + '">Email kami</a>.</p>' +
      "</div>";
  }

  // `updated` changes on every admin save, so a replaced image is not served stale from cache.
  function imageUrl(d) {
    return d.image + (d.updated ? "?v=" + encodeURIComponent(d.updated) : "");
  }

  // ---------- Contact ----------
  function renderContact() {
    var c = SITE.contacts, html = "";
    if (c.email) {
      var templates = [
        { kind: "service", title: "Konsultasi layanan", text: "Uji tuntas, penginderaan jauh, proyek karbon, analisis, atau pemetaan." },
        { kind: "ask", title: "Tanya ketersediaan data", text: "Cari data yang belum ada di katalog, atau tanya detail dataset." },
        { kind: "sample", title: "Minta sampel gratis", text: "Lihat potongan data atau tabel atribut sebelum membeli." },
        { kind: "order", title: "Pesan dataset", text: "Dapatkan harga dan cara pembayaran untuk dataset pilihan Anda." },
        { kind: "invoice", title: "Penawaran resmi / invoice", text: "Untuk pengadaan data atau layanan oleh instansi dan perusahaan." },
      ];
      html +=
        '<section class="panel email-hero">' +
        '<div class="email-head"><div class="icon">' + ICONS.email + "</div><div>" +
        '<p class="kicker">Email</p><h2><a href="mailto:' + esc(c.email) + '">' + esc(c.email) + "</a> " + copyButton() + "</h2>" +
        "<p>Satu alamat untuk konsultasi layanan, bertanya, minta sampel, dan memesan data. Pilih keperluan Anda; email terbuka dengan isi yang sudah disiapkan, tinggal lengkapi.</p>" +
        "</div></div>" +
        '<div class="template-grid">' +
        templates.map(function (k) {
          var t = mailTemplate(k.kind);
          return '<div class="template">' +
            "<h3>" + esc(k.title) + "</h3><p>" + esc(k.text) + "</p>" +
            '<a class="btn btn-primary" href="' + esc(mailto(t)) + '">' + ICONS.email + "Tulis email</a>" +
            '<a class="gmail-link" href="' + esc(gmailUrl(t)) + '" target="_blank" rel="noopener">atau buka di Gmail</a></div>';
        }).join("") +
        "</div></section>";
    }

    var cards = [];
    if (c.telegram) cards.push({ cls: "btn-telegram", bg: "#229ed9", icon: ICONS.telegram, title: "Telegram", label: c.telegramLabel, text: "Bertanya, minta sampel, dan memesan data lewat chat.", href: c.telegram, cta: "Chat via Telegram" });
    if (c.discord) cards.push({ cls: "btn-discord", bg: "#5865f2", icon: ICONS.discord, title: "Discord", label: c.discordLabel, text: "Gabung komunitas untuk info rilis dataset baru dan diskusi teknis.", href: c.discord, cta: "Gabung Discord" });
    var soon = { Telegram: ICONS.telegram, Discord: ICONS.discord };
    html += '<div class="contact-grid">' +
      cards.map(function (k) {
        return (
          '<div class="panel contact-card">' +
          '<div class="icon" style="background:' + k.bg + '">' + k.icon + "</div>" +
          "<h3>" + esc(k.title) + "</h3><p><strong>" + esc(k.label) + "</strong></p><p>" + esc(k.text) + "</p>" +
          '<a class="btn ' + k.cls + '" href="' + esc(k.href) + '" target="_blank" rel="noopener">' + esc(k.cta) + "</a></div>"
        );
      }).join("") +
      (c.comingSoon || []).map(function (name) {
        return '<div class="panel contact-card soon">' +
          '<div class="icon">' + (soon[name] || ICONS.email) + "</div>" +
          "<h3>" + esc(name) + ' <span class="soon-badge">Segera hadir</span></h3>' +
          "<p>Kanal " + esc(name) + " sedang kami siapkan. Sementara itu, hubungi kami lewat email.</p></div>";
      }).join("") +
      "</div>";

    document.getElementById("contact-cards").innerHTML = html;
    var rt = document.getElementById("response-time");
    if (rt) rt.textContent = SITE.responseTime;
  }

  // Published datasets only; drafts stay in the file but are not listed.
  function loadDatasets() {
    return fetch("data/datasets.json", { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (list) {
      return list.filter(function (d) { return d.published !== false; });
    });
  }

  function loadError(el) {
    el.innerHTML = '<div class="panel empty"><h2>Gagal memuat data</h2><p>Silakan muat ulang halaman ini.</p></div>';
  }

  document.addEventListener("DOMContentLoaded", function () {
    var page = document.body.getAttribute("data-page");
    renderLayout(page);
    initCopy();
    wireServiceButtons();
    if (page === "home") {
      loadDatasets()
        .then(function (list) { DATASETS = list; renderHome(); })
        .catch(function () { loadError(document.getElementById("grid")); });
    }
    if (page === "dataset") {
      var id = new URLSearchParams(location.search).get("id") || "";
      loadDatasets()
        .then(function (list) { renderDataset(list.filter(function (d) { return d.id === id; })[0], list); })
        .catch(function () { loadError(document.getElementById("detail")); });
    }
    if (page === "contact") renderContact();
  });
})();
