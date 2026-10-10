// Public data converter (konversi-data.html): a visitor picks a file, sees
// what is in it, picks an output format and downloads the result. The work is
// done in this browser by geoconvert.js, inside a worker
// (geoconvertworker.js); nothing is uploaded or stored.
(function () {
  "use strict";

  // The worker's scripts get the same ?v= tag as this one (see pages.yml).
  var script = document.currentScript;
  var VERSION = script && script.src.indexOf("?") > 0 ? script.src.slice(script.src.indexOf("?")) : "";
  var MB = 1024 * 1024;
  var state = { summary: null, name: "", limit: 0 };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmt(n) { return Number(n).toLocaleString("id-ID"); }
  function mb(bytes) {
    return bytes < MB ? fmt(Math.max(1, Math.round(bytes / 1024))) + " KB" : fmt(Math.round(bytes / MB * 10) / 10) + " MB";
  }

  function status(text, isError) {
    $("cv-status").textContent = text;
    $("cv-status").className = "mm-status" + (isError ? " error" : "");
    $("cv-status").hidden = !text;
  }

  // ---------- Worker ----------
  var worker = null, seq = 0, waiting = {};
  function startWorker() {
    try {
      worker = new Worker("assets/js/geoconvertworker.js" + VERSION);
    } catch (e) {
      worker = null;
      return;
    }
    worker.onmessage = function (e) {
      var w = waiting[e.data.id];
      if (!w) return;
      delete waiting[e.data.id];
      if (e.data.error) w.reject(e.data.error);
      else w.resolve(e.data.result);
    };
    // A worker that dies (usually out of memory) fails every pending job;
    // the next job starts a fresh one.
    worker.onerror = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      Object.keys(waiting).forEach(function (id) { waiting[id].reject({ message: "worker stopped" }); });
      waiting = {};
      worker.terminate();
      worker = null;
    };
  }
  function ask(cmd, payload) {
    if (!worker) startWorker();
    if (!worker) return Promise.reject({ message: "no worker" });
    return new Promise(function (resolve, reject) {
      var id = ++seq, msg = payload || {};
      waiting[id] = { resolve: resolve, reject: reject };
      msg.id = id;
      msg.cmd = cmd;
      worker.postMessage(msg);
    });
  }

  // geoconvert.js speaks English (it is shared with the tests).
  function explain(err) {
    var m = (err && err.message) || "";
    if (/worker stopped/.test(m)) return "Konverter berhenti, biasanya karena memori browser tidak cukup untuk file ini. Tutup tab lain lalu muat ulang halaman, atau potong data per wilayah agar file lebih kecil.";
    if ((err && err.name === "RangeError") || /out of memory|allocation failed|Invalid string length/i.test(m)) {
      return "Memori browser tidak cukup untuk file ini. Tutup tab lain lalu coba lagi, atau potong data per wilayah agar file lebih kecil.";
    }
    if (/no worker/.test(m)) return "Browser ini tidak bisa menjalankan konverter. Coba browser lain (Chrome, Edge, Firefox, atau Safari versi baru).";
    if (/too large for this browser/.test(m)) return "File ini terlalu besar untuk diolah di browser perangkat ini (batas " + mb(state.limit) + "; shapefile setelah diekstrak maks. " + mb(state.limit * 2) + ").";
    if (/not longitude\/latitude/.test(m)) return "Koordinat file ini bukan bujur/lintang dan proyeksinya tidak dikenali. Ekspor data sebagai WGS 84 (EPSG:4326), lalu coba lagi.";
    if (/which is not supported here/.test(m)) return "Proyeksi file ini belum didukung (yang didukung: WGS 84, UTM, Web Mercator). Ekspor data sebagai WGS 84 (EPSG:4326), lalu coba lagi.";
    if (/no features with geometry/.test(m)) return "File ini tidak berisi fitur dengan geometri.";
    if (/no coordinate columns/.test(m)) return "CSV ini tidak punya kolom koordinat. Beri nama kolomnya longitude dan latitude (atau bujur/lintang, lon/lat, x/y), atau sediakan kolom WKT.";
    if (/no data rows/.test(m)) return "CSV ini tidak berisi baris data.";
    if (/not a KML/.test(m)) return "File ini bukan KML yang valid.";
    if (/not a GPX/.test(m)) return "File ini bukan GPX yang valid.";
    if (/Choose a \.geojson/.test(m)) return "Pilih file .geojson, .json, .kml, .kmz, .gpx, .csv, shapefile dalam .zip, atau file .shp, .dbf, dan .prj sekaligus.";
    if (/\.zip file has no/.test(m)) return "File .zip ini tidak berisi shapefile (.shp) atau file lain yang bisa dibaca.";
    if (/ZIP64|zip file is damaged|could not be read|unsupported compression/i.test(m)) return "File .zip ini tidak bisa dibaca. Buat ulang zip-nya (hanya berisi file shapefile), lalu coba lagi.";
    if (/unsupported shape type/.test(m)) return "Jenis geometri shapefile ini belum didukung (mis. MultiPatch).";
    if (/\.shp file/.test(m)) return "File .shp tidak ada atau rusak. Pilih .shp, .dbf, dan .prj bersama-sama, atau kirim dalam satu .zip.";
    if (/not a GeoJSON/.test(m) || (err && err.name === "SyntaxError")) return "File ini bukan GeoJSON yang valid.";
    return "File tidak bisa dibaca" + (m ? ": " + m : ".");
  }

  var GEOMETRY = {
    Point: "titik", MultiPoint: "multi-titik", LineString: "garis", MultiLineString: "multi-garis",
    Polygon: "poligon", MultiPolygon: "multi-poligon", GeometryCollection: "koleksi geometri",
  };
  var FORMAT_IN = { GeoJSON: "geojson", Shapefile: "shp", KML: "kml", KMZ: "kmz", GPX: "gpx", CSV: "csv" };

  function showSummary(s) {
    var geoms = Object.keys(s.geometries).map(function (k) { return fmt(s.geometries[k]) + " " + (GEOMETRY[k] || k); });
    if (s.empty) geoms.push(fmt(s.empty) + " tanpa geometri");
    var b = s.bbox.map(function (v) { return (Math.round(v * 1000) / 1000).toLocaleString("id-ID") + "°"; });
    var rows = [
      ["Format", s.format],
      ["Fitur", fmt(s.features)],
      ["Geometri", geoms.join(", ")],
      ["Sistem koordinat", s.crs + (/UTM|Mercator/i.test(s.crs) ? " → diubah ke WGS 84" : "")],
      ["Cakupan", "bujur " + b[0] + " s.d. " + b[2] + ", lintang " + b[1] + " s.d. " + b[3]],
    ];
    $("cv-facts").innerHTML = rows.map(function (r) { return "<div><dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd></div>"; }).join("");
    var fields = s.fields.slice(0, 40).map(function (f) { return '<span class="badge">' + esc(f.name) + "</span>"; }).join(" ");
    $("cv-fields").innerHTML = s.fields.length ?
      "<strong>" + fmt(s.fields.length) + " kolom atribut</strong> " + fields + (s.fields.length > 40 ? " …" : "") :
      "<strong>Tidak ada kolom atribut.</strong>";
    $("cv-summary").hidden = false;
    $("cv-placeholder").hidden = true;
  }

  function openFiles(files) {
    files = Array.prototype.slice.call(files || []);
    if (!files.length) return;
    var size = files.reduce(function (sum, f) { return sum + f.size; }, 0);
    if (state.limit && size > state.limit) {
      status("File ini " + mb(size) + ", melebihi batas " + mb(state.limit) + " untuk browser di perangkat ini. Potong data per wilayah atau sederhanakan geometrinya dulu.", true);
      return;
    }
    var main = files.filter(function (f) { return !/\.(dbf|prj|cpg|shx)$/i.test(f.name); })[0] || files[0];
    state.summary = null;
    $("cv-options").hidden = true;
    $("cv-result").hidden = true;
    status("Membaca " + main.name + " (" + mb(size) + ")…");
    ask("read", { files: files, options: { maxBytes: state.limit } }).then(function (s) {
      state.summary = s;
      state.name = main.name.replace(/\.[^.]+$/, "");
      status("");
      showSummary(s);
      $("cv-name").value = state.name;
      var from = FORMAT_IN[s.format];
      // Suggest a different format from the input (GeoJSON in, shapefile out).
      var suggest = from === "geojson" ? "shp" : "geojson";
      var current = document.querySelector('input[name="cv-format"]:checked');
      if (!current || current.value === from) document.querySelector('input[name="cv-format"][value="' + suggest + '"]').checked = true;
      formatHint();
      $("cv-options").hidden = false;
      if (window.matchMedia("(max-width: 860px)").matches) $("cv-summary").scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function (err) {
      status(explain(err), true);
    });
  }

  var HINTS = {
    geojson: "Untuk QGIS, ArcGIS Pro, web map (Leaflet, Mapbox), dan Python/R.",
    shp: "Zip berisi .shp, .shx, .dbf, .prj, dan .cpg (UTF-8). Nama kolom maks. 10 karakter dan teks maks. 254 byte (batas format shapefile). Data campuran dipisah per jenis geometri.",
    kml: "Untuk Google Earth dan Google My Maps. Atribut disimpan sebagai ExtendedData.",
    csv: "Data titik: kolom longitude dan latitude. Garis/poligon: kolom WKT. Di Excel, buka lewat Data → From Text/CSV agar kolom terpisah dengan benar.",
  };
  function formatHint() {
    var f = document.querySelector('input[name="cv-format"]:checked');
    $("cv-format-hint").textContent = f ? HINTS[f.value] : "";
  }

  function warningText(w) {
    switch (w.code) {
      case "no-geometry": return fmt(w.count) + " fitur tanpa geometri tidak dimasukkan (setiap baris shapefile harus punya geometri).";
      case "split": return "Data berisi beberapa jenis geometri, jadi zip berisi satu shapefile per jenis (" + w.kinds.join(", ") + ").";
      case "renamed-fields":
        return "Nama kolom shapefile maksimal 10 karakter, jadi " + fmt(w.fields.length) + " kolom diganti namanya: " +
          w.fields.slice(0, 8).map(function (r) { return r.from + " → " + r.to; }).join(", ") + (w.fields.length > 8 ? ", …" : "") + ".";
      case "too-many-fields": return "Shapefile maksimal 255 kolom; " + fmt(w.count) + " kolom terakhir tidak dimasukkan.";
      case "text-cut": return fmt(w.count) + " isian teks lebih panjang dari 254 byte dipotong (batas format shapefile).";
      case "excel-cell": return fmt(w.count) + " geometri lebih panjang dari 32.767 karakter. Excel akan memotongnya; QGIS dan Python membacanya utuh.";
    }
    return "";
  }

  function count(path, title) {
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: path, title: title, event: true });
  }

  function convert() {
    var format = document.querySelector('input[name="cv-format"]:checked').value;
    var btn = $("cv-convert");
    btn.disabled = true;
    $("cv-result").hidden = true;
    status("Mengonversi…");
    ask("write", { format: format, name: $("cv-name").value.trim() || state.name }).then(function (out) {
      status("");
      var a = document.createElement("a");
      a.href = URL.createObjectURL(out.blob);
      a.download = out.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      var notes = out.warnings.map(warningText).filter(Boolean);
      $("cv-result").innerHTML = "<p><strong>Selesai.</strong> " + esc(out.filename) + " (" + mb(out.blob.size) + ") sudah diunduh ke perangkat Anda.</p>" +
        (notes.length ? "<ul>" + notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul>" : "");
      $("cv-result").hidden = false;
      // Only the formats are counted, never the file name or its contents.
      count("konversi-data/" + FORMAT_IN[state.summary.format] + "-ke-" + format, "Konversi: " + state.summary.format + " ke " + format);
    }).catch(function (err) {
      status(explain(err), true);
    }).then(function () {
      btn.disabled = false;
    });
  }

  function clearAll() {
    ask("clear").catch(function () {});
    state.summary = null;
    $("cv-file").value = "";
    $("cv-options").hidden = true;
    $("cv-summary").hidden = true;
    $("cv-result").hidden = true;
    $("cv-placeholder").hidden = false;
    status("Data sudah dihapus dari memori browser.");
  }

  function deviceEnv() {
    var ua = navigator.userAgent || "";
    var mobile = (navigator.userAgentData && navigator.userAgentData.mobile) || /Android|iPhone|iPad|iPod|Mobi/i.test(ua) ||
      (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua)); // iPadOS reports a Mac
    return { mobile: !!mobile, deviceMemory: navigator.deviceMemory || 0 };
  }

  document.addEventListener("DOMContentLoaded", function () {
    // Start the worker now, so its scripts are loaded before any file is
    // picked (the converter then also works with the internet off).
    ask("limit", { env: deviceEnv() }).then(function (limit) {
      state.limit = limit;
      document.querySelectorAll("[data-cv-limit]").forEach(function (el) { el.textContent = mb(limit); });
    }).catch(function (err) {
      status(explain(err), true);
    });

    $("cv-file").addEventListener("change", function () { openFiles(this.files); });

    var zone = $("cv-drop");
    ["dragenter", "dragover"].forEach(function (t) {
      zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.add("over"); });
    });
    ["dragleave", "drop"].forEach(function (t) {
      zone.addEventListener(t, function () { zone.classList.remove("over"); });
    });
    zone.addEventListener("drop", function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
    });

    $("cv-sample").addEventListener("click", function () {
      status("Memuat data contoh…");
      fetch("data/contoh-kota.geojson").then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.blob();
      }).then(function (blob) {
        openFiles([new File([blob], "contoh-kota.geojson", { type: "application/geo+json" })]);
        count("konversi-data/contoh", "Konversi: coba data contoh");
      }).catch(function () {
        status("Data contoh gagal dimuat. Muat ulang halaman lalu coba lagi.", true);
      });
    });

    document.querySelectorAll('input[name="cv-format"]').forEach(function (r) { r.addEventListener("change", formatHint); });
    $("cv-convert").addEventListener("click", convert);
    $("cv-clear").addEventListener("click", clearAll);
  });
})();
