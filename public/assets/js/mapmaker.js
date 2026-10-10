// Public map maker (buat-peta.html): a visitor picks a GeoJSON (or a zipped
// shapefile), chooses a field, and downloads the finished map as a PNG. The
// file is read and drawn in this browser by staticmap.js; nothing is uploaded.
(function () {
  "use strict";

  var SM = window.StaticMap;
  var MAX_BYTES = 50 * 1024 * 1024;
  var state = { layer: null, name: "" };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmt(n) { return Number(n).toLocaleString("id-ID"); }

  function status(text, isError) {
    $("mm-status").textContent = text;
    $("mm-status").className = "mm-status" + (isError ? " error" : "");
    $("mm-status").hidden = !text;
  }

  // staticmap.js speaks English (it is shared with the admin page).
  function explain(err) {
    var m = (err && err.message) || "";
    if (/not longitude\/latitude/.test(m)) return "Koordinat file ini bukan bujur/lintang dan proyeksinya tidak dikenali. Ekspor data sebagai WGS 84 (EPSG:4326), lalu coba lagi.";
    if (/no features with geometry/.test(m)) return "File ini tidak berisi fitur dengan geometri.";
    if (/Choose a \.geojson/.test(m)) return "Pilih file .geojson, .json, atau shapefile dalam .zip.";
    if (/\.zip file has no/.test(m)) return "File .zip ini tidak berisi shapefile (.shp) atau GeoJSON.";
    if (/not a GeoJSON/.test(m) || err instanceof SyntaxError) return "File ini bukan GeoJSON yang valid.";
    return "File tidak bisa dibaca" + (m ? ": " + m : ".");
  }

  var GEOMETRY = { Polygon: "poligon", Line: "garis", Point: "titik", Mixed: "campuran" };
  var basemap = null;
  function loadBasemap() {
    basemap = basemap || fetch("data/basemap.json").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).catch(function (err) { basemap = null; throw err; });
    return basemap;
  }
  var fonts = document.fonts ? Promise.all(["400", "600", "700"].map(function (w) {
    return document.fonts.load(w + " 16px Inter");
  })).catch(function () {}) : Promise.resolve();

  function openFiles(files, name) {
    if (files && files[0] && files[0].size > MAX_BYTES) {
      status("File lebih dari 50 MB. Sederhanakan geometrinya atau potong wilayahnya dulu.", true);
      return;
    }
    status("Membaca " + name + "…");
    SM.load(files).then(function (layer) {
      state.layer = layer;
      state.name = name.replace(/\.[^.]+$/, "");
      status(fmt(layer.features.length) + " fitur " + (GEOMETRY[layer.geometry] || "") + " · " + fmt(layer.fields.length) + " kolom · " + layer.crs);
      var options = SM.fieldOptions(layer);
      // Start with the first category field: a coloured map shows off the tool better than one colour.
      var first = options.filter(function (o) { return o.kind === "category"; })[0] || options[0];
      $("mm-field").innerHTML = '<option value="">Satu warna</option>' + options.map(function (o) {
        return '<option value="' + esc(o.name) + '">' + esc(o.name) + (o.kind === "number" ? " (angka)" : "") + "</option>";
      }).join("");
      $("mm-field").value = first ? first.name : "";
      $("mm-title").value = state.name;
      $("mm-legend").value = first ? first.name : state.name;
      delete $("mm-legend").dataset.touched;
      fieldHint();
      $("mm-options").hidden = false;
      draw().then(function () {
        // One column (phones): the preview is below the form, so bring it into view.
        if (window.matchMedia("(max-width: 860px)").matches) $("mm-canvas-wrap").scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }).catch(function (err) {
      status(explain(err), true);
    });
  }

  function fieldHint() {
    var field = $("mm-field").value, hint = "";
    if (!state.layer.fields.length) hint = "File ini tidak punya kolom atribut.";
    else if (!field) hint = "Semua fitur satu warna.";
    else if (SM.fieldKind(state.layer, field) === "number") hint = "Angka dibagi menjadi hingga 5 kelas dengan jumlah fitur yang kira-kira sama.";
    else hint = "Setiap nilai satu warna; nilai yang jarang digabung menjadi “Lainnya”.";
    $("mm-field-hint").textContent = hint;
  }

  function siteAddress() {
    return (location.host + location.pathname.replace(/\/[^/]*$/, "")) || window.SITE.name;
  }

  var pending = 0;
  function draw() {
    var layer = state.layer, ticket = ++pending;
    if (!layer) return Promise.resolve();
    return Promise.all([loadBasemap(), fonts]).then(function (res) {
      if (ticket !== pending) return;
      var field = $("mm-field").value;
      SM.render($("mm-canvas"), layer, res[0], {
        title: $("mm-title").value.trim() || state.name,
        subtitle: $("mm-subtitle").value.trim() || fmt(layer.features.length) + " fitur",
        field: field,
        legendTitle: $("mm-legend").value.trim() || field,
        layerName: $("mm-legend").value.trim() || state.name,
        source: $("mm-source").value.trim(),
        credit: "Dibuat dengan " + window.SITE.name + " · " + siteAddress(),
        date: new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" }),
      });
      $("mm-canvas").classList.remove("empty");
      $("mm-placeholder").hidden = true;
      $("mm-actions").hidden = false;
    }).catch(function () {
      status("Peta dasar gagal dimuat. Periksa koneksi internet lalu muat ulang halaman.", true);
    });
  }

  // Redraw while typing, but not on every keystroke.
  var timer = null;
  function drawSoon() {
    clearTimeout(timer);
    timer = setTimeout(draw, 250);
  }

  function count(path, title) {
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: path, title: title, event: true });
  }

  function slug(s) {
    return String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "peta";
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("mm-canvas").classList.add("empty");

    $("mm-file").addEventListener("change", function () {
      if (this.files.length) openFiles(this.files, this.files[0].name);
    });

    var zone = $("dropzone");
    ["dragenter", "dragover"].forEach(function (t) {
      zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.add("over"); });
    });
    ["dragleave", "drop"].forEach(function (t) {
      zone.addEventListener(t, function () { zone.classList.remove("over"); });
    });
    zone.addEventListener("drop", function (e) {
      e.preventDefault();
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) openFiles(files, files[0].name);
    });

    $("mm-sample").addEventListener("click", function () {
      status("Memuat data contoh…");
      fetch("data/contoh-kota.geojson").then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.blob();
      }).then(function (blob) {
        openFiles([new File([blob], "contoh-kota.geojson", { type: "application/geo+json" })], "contoh-kota.geojson");
        count("buat-peta/contoh", "Peta: coba data contoh");
      }).catch(function () {
        status("Data contoh gagal dimuat. Muat ulang halaman lalu coba lagi.", true);
      });
    });

    $("mm-field").addEventListener("change", function () {
      if (!$("mm-legend").dataset.touched) $("mm-legend").value = this.value || state.name;
      fieldHint();
      draw();
    });
    $("mm-legend").addEventListener("input", function () { this.dataset.touched = "1"; });
    ["mm-title", "mm-subtitle", "mm-legend", "mm-source"].forEach(function (id) {
      $(id).addEventListener("input", drawSoon);
    });

    $("mm-download").addEventListener("click", function () {
      $("mm-canvas").toBlob(function (blob) {
        if (!blob) return;
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = slug($("mm-title").value || state.name) + ".png";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
        count("buat-peta/unduh", "Peta: unduh PNG");
      }, "image/png");
    });

    $("mm-share").addEventListener("click", function () {
      var btn = this, url = location.href.split(/[?#]/)[0];
      var text = "Buat peta dari GeoJSON gratis, langsung di browser:";
      if (navigator.share) {
        navigator.share({ title: document.title, text: text, url: url }).catch(function () {});
        return;
      }
      var done = function () {
        btn.textContent = "Tautan disalin";
        setTimeout(function () { btn.textContent = "Bagikan alat ini"; }, 2000);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () { window.prompt("Salin tautan:", url); });
      else window.prompt("Salin tautan:", url);
    });
  });
})();
