// Public spatial analysis page (analisis-spasial.html): a visitor opens a file
// (and, for some tools, a second one), picks an analysis, sees the result on a
// Leaflet map with a report, and downloads the result layer or the tables.
// The work is done in this browser by geostats.js inside a worker
// (analysisworker.js); nothing is uploaded or stored.
(function () {
  "use strict";

  // The worker's scripts get the same ?v= tag as this one (see pages.yml).
  var script = document.currentScript;
  var VERSION = script && script.src.indexOf("?") > 0 ? script.src.slice(script.src.indexOf("?")) : "";
  var MB = 1024 * 1024;
  var state = { a: null, b: null, last: null, limit: 0 };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------- Numbers ----------
  function fmt(n, digits) {
    if (n == null || n !== n) return "–";
    return Number(n).toLocaleString("id-ID", { maximumFractionDigits: digits == null ? 0 : digits });
  }
  // About 4 significant digits, more for big numbers.
  function num(v) {
    if (v == null || v !== v) return "–";
    if (!isFinite(v)) return v > 0 ? "∞" : "−∞";
    var a = Math.abs(v);
    if (a >= 1000 || Number.isInteger(v)) return fmt(v, a >= 100000 ? 0 : 2);
    return Number(v.toPrecision(4)).toLocaleString("id-ID", { maximumFractionDigits: 10 });
  }
  function pval(p) { return p == null ? "–" : p < 0.001 ? "< 0,001" : fmt(p, 3); }
  function hectares(m2) { return fmt(m2 / 1e4, m2 < 1e6 ? 2 : 0) + " ha (" + fmt(m2 / 1e6, m2 < 1e8 ? 2 : 0) + " km²)"; }
  function metres(m) { return m < 1000 ? fmt(m, 1) + " m" : fmt(m / 1000, m < 100000 ? 2 : 0) + " km"; }
  function mb(bytes) {
    return bytes < MB ? fmt(Math.max(1, Math.round(bytes / 1024))) + " KB" : fmt(Math.round(bytes / MB * 10) / 10) + " MB";
  }

  function status(text, isError) {
    $("an-status").textContent = text;
    $("an-status").className = "mm-status" + (isError ? " error" : "");
    $("an-status").hidden = !text;
  }

  function track(path, title) {
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: path, title: title, event: true });
  }

  // ---------- Worker ----------
  var worker = null, seq = 0, waiting = {};
  function startWorker() {
    try {
      worker = new Worker("assets/js/analysisworker.js" + VERSION);
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
    // A worker that dies (usually out of memory) fails every pending job and
    // loses the layers; the page is reset so it does not pretend otherwise.
    worker.onerror = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      Object.keys(waiting).forEach(function (id) { waiting[id].reject({ message: "worker stopped" }); });
      waiting = {};
      worker.terminate();
      worker = null;
      resetLayers();
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

  // geoconvert.js and geostats.js speak English (they are shared with the tests).
  function explain(err) {
    var m = (err && err.message) || "";
    if (/worker stopped/.test(m)) return "Analisis berhenti, biasanya karena memori browser tidak cukup. Tutup tab lain lalu pilih file lagi, atau potong data per wilayah agar lebih kecil.";
    if ((err && err.name === "RangeError") || /out of memory|allocation failed|Invalid string length/i.test(m)) {
      return "Memori browser tidak cukup untuk data ini. Tutup tab lain lalu coba lagi, atau potong data per wilayah agar lebih kecil.";
    }
    if (/no worker/.test(m)) return "Browser ini tidak bisa menjalankan analisis. Coba browser lain (Chrome, Edge, Firefox, atau Safari versi baru).";
    if (/too large for this browser/.test(m)) return "File ini terlalu besar untuk diolah di browser perangkat ini (batas " + mb(state.limit) + ").";
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
    var n = m.match(/At least (\d+) (features with a value|points) are needed/);
    if (n) return "Perlu minimal " + n[1] + (n[2] === "points" ? " titik." : " fitur yang punya nilai di kolom ini.");
    if (/All values are the same/.test(m)) return "Semua nilai di kolom ini sama, jadi tidak ada pola yang bisa diuji.";
    if (/lie on one line/.test(m)) return "Titik-titik berada pada satu garis, jadi tidak membentuk wilayah untuk diuji.";
    if (/distance is too large: there are too many/.test(m)) return "Jarak terlalu besar: hampir semua fitur saling bertetangga. Perkecil jarak atau pakai k tetangga terdekat.";
    if (/distance greater than 0/.test(m)) return "Isi jarak lebih dari 0.";
    if (/Give a buffer distance/.test(m)) return "Isi jarak buffer (tidak boleh 0).";
    if (/buffer distance is too large/.test(m)) return "Jarak buffer terlalu besar (maks. 1.000 km).";
    if (/The input layer has no polygons/.test(m)) return "Buffer negatif (mengecilkan) hanya untuk poligon.";
    if (/The overlay layer has no polygons/.test(m)) return "Lapisan kedua harus berisi poligon.";
    if (/The first layer has no polygons|The second layer has no points/.test(m)) return "Untuk menghitung titik, satu lapisan harus berisi poligon dan yang lain titik.";
    if (/weight field has no positive/.test(m)) return "Kolom bobot tidak punya nilai positif.";
    if (/Choose a (numeric )?field/.test(m)) return "Pilih kolom dulu.";
    if (/Choose a file first|Run an analysis first/.test(m)) return "Pilih file dan jalankan analisis dulu.";
    return "Analisis gagal" + (m ? ": " + m : ".");
  }

  // ---------- Map ----------
  // Colours: data (blue), second layer (orange, dashed), result (green);
  // checked for colour-blind separation. Hot spots use a red–grey–blue
  // diverging scale.
  var COLORS = { a: "#2563eb", b: "#ea580c", result: "#059669" };
  var HOT = { 3: "#b2182b", 2: "#ef8a62", 1: "#fddbc7", 0: "#d4d4d4", "-1": "#d1e5f0", "-2": "#67a9cf", "-3": "#2166ac" };
  var HOT_LABELS = {
    3: "Hot spot, 99%", 2: "Hot spot, 95%", 1: "Hot spot, 90%", 0: "Tidak signifikan",
    "-1": "Cold spot, 90%", "-2": "Cold spot, 95%", "-3": "Cold spot, 99%",
  };
  var map = L.map("an-map", { center: [-2.5, 118], zoom: 4, maxZoom: 22, zoomSnap: 0.5, preferCanvas: true });
  var renderer = L.canvas({ padding: 0.5 });
  var bases = {
    "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 22, maxNativeZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }),
    "Citra satelit (Esri)": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 22, maxNativeZoom: 19,
      attribution: "Citra &copy; Esri, Maxar, Earthstar Geographics",
    }),
    "Tanpa peta dasar": L.layerGroup(),
  };
  bases.OpenStreetMap.addTo(map);
  var overlays = { a: null, b: null, result: null };
  var control = L.control.layers(bases, {}, { collapsed: true }).addTo(map);
  var OVERLAY_NAMES = { a: "Data utama", b: "Lapisan kedua", result: "Hasil analisis" };

  function popup(props) {
    var keys = Object.keys(props || {});
    if (!keys.length) return "<em>Tanpa atribut</em>";
    var rows = keys.slice(0, 25).map(function (k) {
      var v = props[k];
      if (v != null && typeof v === "object") v = JSON.stringify(v);
      if (typeof v === "number") v = num(v);
      return "<tr><th>" + esc(k) + "</th><td>" + esc(v == null ? "" : v) + "</td></tr>";
    }).join("");
    return '<table class="an-popup">' + rows + "</table>" + (keys.length > 25 ? "<p>… " + fmt(keys.length - 25) + " kolom lain</p>" : "");
  }

  function styleFor(slot, op) {
    var c = COLORS[slot];
    return function (f) {
      var p = f.properties || {}, s = { renderer: renderer, color: c, weight: 2, opacity: 0.9, fillColor: c, fillOpacity: slot === "result" ? 0.3 : 0.12 };
      if (slot === "b") s.dashArray = "6 4";
      if (slot === "result" && op === "hotspot") {
        s.fillColor = HOT[p.gi_bin] || HOT[0];
        s.color = "#ffffff";
        s.weight = 1;
        s.fillOpacity = 0.85;
      }
      if (slot === "result" && op === "pattern" && p.jenis === "jarak_standar") { s.fillOpacity = 0.08; s.dashArray = "4 4"; }
      return s;
    };
  }

  function draw(slot, features, op) {
    if (overlays[slot]) {
      map.removeLayer(overlays[slot]);
      control.removeLayer(overlays[slot]);
      overlays[slot] = null;
    }
    if (!features || !features.length) return null;
    var style = styleFor(slot, op);
    var layer = L.geoJSON(features, {
      style: style,
      pointToLayer: function (f, latlng) {
        var s = style(f);
        var big = slot === "result" && op === "pattern";
        return L.circleMarker(latlng, {
          renderer: renderer, radius: big ? 8 : slot === "result" && op === "hotspot" ? 6 : 5,
          color: "#ffffff", weight: 2, fillColor: s.fillColor, fillOpacity: 1,
        });
      },
      onEachFeature: function (f, l) { l.bindPopup(function () { return popup(f.properties); }, { maxWidth: 320 }); },
    }).addTo(map);
    overlays[slot] = layer;
    control.addOverlay(layer, OVERLAY_NAMES[slot]);
    // Keep the result on top, the second layer under the data.
    if (overlays.b && slot !== "b") overlays.b.bringToBack();
    if (overlays.result) overlays.result.bringToFront();
    return layer;
  }
  function fit(layer) {
    if (!layer) return;
    var b = layer.getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [20, 20], maxZoom: 16 });
  }
  function fitBbox(bbox) {
    if (bbox && bbox.every(isFinite)) map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { padding: [20, 20], maxZoom: 16 });
  }

  function legend() {
    var items = [];
    function item(swatch, label) { items.push('<span class="an-legend-item">' + swatch + "<span>" + label + "</span></span>"); }
    function sw(color, dashed) { return '<span class="an-swatch' + (dashed ? " dashed" : "") + '" style="--c:' + color + '"></span>'; }
    if (state.a) item(sw(COLORS.a), "Data utama: " + esc(state.a.name));
    if (state.b && needsB(currentOp())) item(sw(COLORS.b, true), "Lapisan kedua: " + esc(state.b.name));
    var last = state.last;
    if (last && last.summary) {
      if (last.op === "hotspot") {
        [3, 2, 1, 0, -1, -2, -3].forEach(function (k) {
          var n = last.report.bins[k] || 0;
          if (n) item(sw(HOT[k]), HOT_LABELS[k] + " (" + fmt(n) + ")");
        });
      } else {
        item(sw(COLORS.result), "Hasil: " + esc(OP_NAMES[last.op]));
      }
    }
    $("an-legend").innerHTML = items.join("");
    $("an-legend").hidden = !items.length;
  }

  function mapNote() {
    var notes = [];
    ["a", "b"].forEach(function (s) {
      if (state[s] && !state[s].drawn) notes.push((s === "a" ? "Data utama" : "Lapisan kedua") + " terlalu besar untuk ditampilkan di peta, tetapi tetap bisa dianalisis.");
    });
    if (state.last && state.last.summary && !state.last.drawn) notes.push("Hasil terlalu besar untuk ditampilkan di peta; unduh untuk melihatnya di QGIS.");
    $("an-map-note").textContent = notes.join(" ");
    $("an-map-note").hidden = !notes.length;
  }

  // ---------- Analyses ----------
  var OP_NAMES = {
    describe: "Statistik atribut", measure: "Luas, keliling & panjang", pattern: "Pola sebaran",
    moran: "Moran's I", hotspot: "Hot spot (Gi*)", buffer: "Buffer", centroid: "Centroid",
    envelope: "Convex hull / kotak batas", dissolve: "Dissolve", count: "Hitung titik dalam poligon",
    clip: "Clip", erase: "Erase", intersect: "Intersect",
  };
  var OP_HINTS = {
    describe: "Ringkasan nilai satu kolom: angka (rata-rata, median, sebaran, histogram) atau teks (frekuensi setiap nilai, beserta luas/panjangnya).",
    measure: "Menambah kolom luas (ha) dan keliling (km) untuk poligon, panjang (km) untuk garis, atau koordinat untuk titik.",
    pattern: "Apakah titik-titik mengelompok, acak, atau menyebar? Juga pusat rata-rata dan jarak standarnya. Garis dan poligon diwakili titik pusatnya.",
    moran: "Apakah nilai yang mirip cenderung berdekatan? Satu angka untuk seluruh wilayah, dengan uji signifikansi.",
    hotspot: "Di mana nilai tinggi (hot spot) dan nilai rendah (cold spot) mengelompok secara signifikan? Setiap fitur diberi kelas.",
    buffer: "Zona sejauh jarak tertentu di sekitar setiap fitur, misalnya sempadan sungai 100 m. Jarak negatif mengecilkan poligon.",
    centroid: "Satu titik di tengah setiap fitur, misalnya untuk label atau analisis titik.",
    envelope: "Batas luar dari sekumpulan fitur: batas cembung (convex hull) atau kotak batas.",
    dissolve: "Gabungkan fitur dengan nilai kolom yang sama menjadi satu, misalnya desa menjadi kecamatan.",
    count: "Berapa titik di dalam setiap poligon, misalnya jumlah titik api per desa. Satu lapisan poligon, satu lapisan titik (urutannya bebas).",
    clip: "Ambil bagian data utama yang berada di dalam poligon lapisan kedua.",
    erase: "Buang bagian data utama yang berada di dalam poligon lapisan kedua.",
    intersect: "Potong data utama per poligon lapisan kedua dan gabungkan atribut keduanya, misalnya konsesi × kawasan hutan.",
  };
  function needsB(op) { return op === "count" || op === "clip" || op === "erase" || op === "intersect"; }
  function currentOp() { return $("an-op").value; }

  function kindsOf(layer) { return layer ? layer.summary.kinds : { point: 0, line: 0, polygon: 0 }; }
  function numericFields(layer) {
    return layer ? layer.summary.fields.filter(function (f) { return f.type === "Integer" || f.type === "Double"; }) : [];
  }

  // Why an analysis cannot run on the current data, or "".
  function blocker(op) {
    var a = state.a;
    if (!a) return "Pilih file dulu.";
    var ka = kindsOf(a), kb = kindsOf(state.b);
    if (op === "describe" && !a.summary.fields.length) return "Data ini tidak punya kolom atribut.";
    if ((op === "moran" || op === "hotspot") && !numericFields(a).length) return "Analisis ini butuh kolom angka, dan data ini tidak punya.";
    if ((op === "moran" || op === "hotspot" || op === "pattern") && a.summary.features < 4) return "Analisis ini butuh minimal 4 fitur.";
    if (needsB(op) && !state.b) return "Pilih file lapisan kedua di bawah.";
    if (op === "count" && !((ka.polygon && kb.point) || (ka.point && kb.polygon))) return "Satu lapisan harus berisi poligon (mis. batas desa) dan yang lain titik.";
    if ((op === "clip" || op === "erase" || op === "intersect") && !kb.polygon) return "Lapisan kedua harus berisi poligon.";
    return "";
  }

  function options(sel, fields, empty, keep) {
    var prev = sel.value;
    sel.innerHTML = (empty != null ? '<option value="">' + esc(empty) + "</option>" : "") +
      fields.map(function (f) { return '<option value="' + esc(f.name) + '">' + esc(f.name) + "</option>"; }).join("");
    if (keep && prev && fields.some(function (f) { return f.name === prev; })) sel.value = prev;
  }

  function fillFields() {
    var a = state.a, fields = a ? a.summary.fields : [], nums = numericFields(a);
    var texts = fields.filter(function (f) { return f.type !== "Integer" && f.type !== "Double"; });
    options($("an-field"), fields, null, true);
    if (a && !$("an-field").dataset.touched) {
      // Start on a number column when there is one: it shows the most.
      if (nums.length) $("an-field").value = nums[0].name;
    }
    options($("an-group"), texts, "— tidak dikelompokkan —", true);
    options($("an-num"), nums, null, true);
    options($("an-wfield"), nums, "— tanpa bobot —", true);
    options($("an-dfield"), fields, "— semua fitur jadi satu —", true);
    options($("an-sum"), nums, "— tidak ada —", true);
    options($("an-cfield"), numericFields(pointsLayer()), "— tidak ada —", true);
  }

  // For counting, the layer with the points (either one: geostats.js swaps).
  function pointsLayer() {
    var ka = kindsOf(state.a), kb = kindsOf(state.b);
    return ka.polygon && kb.point ? state.b : ka.point && kb.polygon ? state.a : state.b;
  }

  function isNumericField(name) {
    return numericFields(state.a).some(function (f) { return f.name === name; });
  }

  function syncForm() {
    var op = currentOp(), ka = kindsOf(state.a);
    document.querySelectorAll(".an-group").forEach(function (g) {
      g.hidden = g.dataset.for.split(" ").indexOf(op) < 0;
    });
    // Contiguity needs shared boundaries: lines or polygons.
    var contig = $("an-weights").querySelector('option[value="contiguity"]');
    contig.disabled = !(ka.polygon || ka.line);
    if (contig.disabled && $("an-weights").value === "contiguity") $("an-weights").value = "knn";
    document.querySelectorAll("[data-weights]").forEach(function (el) { el.hidden = el.dataset.weights !== $("an-weights").value; });
    $("an-group-wrap").hidden = !isNumericField($("an-field").value);
    $("an-inside").closest("label").hidden = !ka.polygon;
    document.querySelectorAll("[data-for-op]").forEach(function (el) { el.hidden = el.dataset.forOp !== op; });
    var countB = op === "count" && !kindsOf(state.a).polygon ? "poligon" : op === "count" ? "titik" : "poligon";
    $("an-b-title").textContent = "Lapisan kedua (" + countB + ")";
    $("an-sample-b").textContent = countB === "titik" ? "Pakai contoh kota (titik)" : "Pakai contoh wilayah pulau (poligon)";
    options($("an-cfield"), numericFields(pointsLayer()), "— tidak ada —", true);
    var why = blocker(op);
    $("an-op-hint").innerHTML = esc(OP_HINTS[op]) + (why ? '<br><strong class="an-warn">' + esc(why) + "</strong>" : "");
    $("an-run").disabled = !!why;
    // The second layer is only on the map while an analysis uses it.
    if (overlays.b) {
      if (needsB(op) && !map.hasLayer(overlays.b)) overlays.b.addTo(map).bringToBack();
      if (!needsB(op) && map.hasLayer(overlays.b)) map.removeLayer(overlays.b);
    }
    legend();
  }

  function params(op) {
    switch (op) {
      case "describe":
        return { field: $("an-field").value, numeric: isNumericField($("an-field").value), groupBy: isNumericField($("an-field").value) ? $("an-group").value : "" };
      case "moran":
      case "hotspot":
        return { field: $("an-num").value, method: $("an-weights").value, k: Number($("an-k").value), distance: Number($("an-dist").value) * 1000 };
      case "pattern": return { weightField: $("an-wfield").value };
      case "buffer": return { distance: Number($("an-buf").value) * Number($("an-buf-unit").value), dissolve: $("an-buf-dissolve").checked };
      case "centroid": return { inside: $("an-inside").checked };
      case "envelope": return { shape: $("an-shape").value, per: $("an-per").value };
      case "dissolve": return { field: $("an-dfield").value, sumField: $("an-sum").value };
      case "count": return { field: $("an-cfield").value };
    }
    return {};
  }

  // ---------- Reports ----------
  // Each report is facts (label, value), optional tables and a verdict. The
  // tables keep raw values for the CSV download and a formatter for the page.
  function factsHtml(rows) {
    return '<dl class="cv-facts an-facts">' + rows.map(function (r) {
      return "<div><dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd></div>";
    }).join("") + "</dl>";
  }
  function tableHtml(t) {
    var shown = t.rows.slice(0, t.limit || 200);
    return '<div class="table-wrap an-table"><table class="format-table">' +
      (t.title ? "<caption>" + esc(t.title) + "</caption>" : "") +
      "<thead><tr>" + t.head.map(function (h, i) { return "<th" + (t.num && t.num[i] ? ' class="num"' : "") + ">" + esc(h) + "</th>"; }).join("") + "</tr></thead><tbody>" +
      shown.map(function (r) {
        return "<tr>" + r.map(function (v, i) {
          var f = t.fmt && t.fmt[i];
          return "<td" + (t.num && t.num[i] ? ' class="num"' : "") + ">" + (t.html && t.html[i] ? t.html[i](v, r) : esc(f ? f(v) : v == null ? "(kosong)" : v)) + "</td>";
        }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>" +
      (t.rows.length > shown.length ? '<p class="hint">Ditampilkan ' + fmt(shown.length) + " dari " + fmt(t.rows.length) + " baris; semua ada di CSV.</p>" : "");
  }
  function verdictHtml(v) {
    return v ? '<div class="an-verdict an-verdict-' + v.tone + '"><strong>' + esc(v.title) + "</strong><span>" + esc(v.text) + "</span></div>" : "";
  }
  // A single-series histogram: thin bars with a gap, hover tooltips, and the
  // counts in a table below for screen readers and exact values.
  function histogramHtml(bins) {
    if (!bins || bins.length < 2) return "";
    var W = 600, H = 170, top = 14, bottom = 26, gap = 2, max = 0;
    bins.forEach(function (b) { max = Math.max(max, b.count); });
    var bw = W / bins.length, plot = H - top - bottom;
    var bars = bins.map(function (b, i) {
      var h = max ? Math.max(b.count ? 2 : 0, b.count / max * plot) : 0, x = i * bw + gap / 2, w = Math.min(bw - gap, 48);
      x += (bw - gap - w) / 2;
      var y = top + plot - h, r = Math.min(4, w / 2, h);
      var d = "M" + x + "," + (top + plot) + "V" + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y + "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + "V" + (top + plot) + "Z";
      var tip = num(b.from) + " – " + num(b.to) + ": " + fmt(b.count) + " fitur";
      return '<g class="an-bar"><rect x="' + (i * bw) + '" y="' + top + '" width="' + bw + '" height="' + plot + '" fill="transparent"><title>' + esc(tip) + "</title></rect>" +
        (h ? '<path d="' + d + '"><title>' + esc(tip) + "</title></path>" : "") + "</g>";
    }).join("");
    return '<figure class="an-hist"><figcaption>Sebaran nilai (histogram)</figcaption>' +
      '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Histogram ' + bins.length + ' kelas">' +
      '<line x1="0" x2="' + W + '" y1="' + (top + plot) + '" y2="' + (top + plot) + '" class="an-axis"/>' + bars +
      '<text x="0" y="' + (H - 6) + '" class="an-tick">' + esc(num(bins[0].from)) + "</text>" +
      '<text x="' + W + '" y="' + (H - 6) + '" class="an-tick" text-anchor="end">' + esc(num(bins[bins.length - 1].to)) + "</text>" +
      '<text x="0" y="10" class="an-tick">maks. ' + esc(fmt(max)) + " fitur per kelas</text></svg></figure>";
  }

  function significant(p) { return p != null && p < 0.05; }

  var REPORTS = {
    describe: function (r) {
      var out = { facts: [], tables: [] };
      var sizeHead = r.measure === "area" ? "Luas (ha)" : r.measure === "length" ? "Panjang (km)" : null;
      function size(v) { return r.measure === "area" ? v / 1e4 : v / 1000; }
      if (r.numeric) {
        var s = r.stats;
        if (!s.n) {
          out.facts.push(["Kolom", r.field], ["Terisi", "0 dari " + fmt(r.count) + " fitur"]);
          return out;
        }
        out.facts.push(
          ["Kolom", r.field], ["Terisi", fmt(s.n) + " dari " + fmt(r.count) + " fitur"], ["Total", num(s.sum)],
          ["Rata-rata", num(s.mean)], ["Median", num(s.median)], ["Simpangan baku", num(s.std)],
          ["Minimum", num(s.min)], ["Kuartil 1 – 3", num(s.q1) + " – " + num(s.q3)], ["Maksimum", num(s.max)]
        );
        if (s.cv != null) out.facts.push(["Koefisien variasi", fmt(s.cv * 100, 1) + "%"]);
        out.histogram = r.histogram;
        out.tables.push({
          title: "Histogram", head: ["Dari", "Sampai", "Jumlah fitur"], rows: r.histogram.map(function (b) { return [b.from, b.to, b.count]; }),
          fmt: [num, num, fmt], num: [1, 1, 1], hidden: true,
        });
        if (r.groups) {
          var head = ["Kelompok (" + r.groupBy + ")", "Fitur", "Terisi", "Total", "Rata-rata", "Min", "Maks"];
          if (sizeHead) head.push(sizeHead);
          out.tables.push({
            title: "Per kelompok", head: head,
            rows: r.groups.map(function (g) {
              var row = [g.key, g.count, g.n, g.sum, g.mean, g.min, g.max];
              if (sizeHead) row.push(size(g.size));
              return row;
            }),
            fmt: [null, fmt, fmt, num, num, num, num, num], num: [0, 1, 1, 1, 1, 1, 1, 1],
          });
        }
      } else {
        out.facts.push(["Kolom", r.field], ["Fitur", fmt(r.count)], ["Nilai berbeda", fmt(r.distinct)]);
        var h = ["Nilai", "Fitur", "% fitur"];
        if (sizeHead) h.push(sizeHead, "% " + (r.measure === "area" ? "luas" : "panjang"));
        out.tables.push({
          title: "Frekuensi", head: h,
          rows: r.categories.map(function (c) {
            var row = [c.key, c.count, c.share * 100];
            if (sizeHead) row.push(size(c.size), c.sizeShare == null ? null : c.sizeShare * 100);
            return row;
          }),
          fmt: [null, fmt, function (v) { return fmt(v, 1) + "%"; }, function (v) { return fmt(v, 2); }, function (v) { return v == null ? "–" : fmt(v, 1) + "%"; }],
          num: [0, 1, 1, 1, 1],
        });
      }
      return out;
    },
    measure: function (r) {
      var out = { facts: [["Fitur", fmt(r.count)]], tables: [] }, k = r.kinds;
      if (k.polygon) {
        out.facts.push(["Total luas", hectares(r.total.area)], ["Total keliling", metres(r.total.perimeter)]);
        if (r.area.n) out.facts.push(["Luas rata-rata", fmt(r.area.mean, 2) + " ha"], ["Luas median", fmt(r.area.median, 2) + " ha"], ["Terkecil – terbesar", fmt(r.area.min, 2) + " – " + fmt(r.area.max, 2) + " ha"]);
      }
      if (k.line) {
        out.facts.push(["Total panjang", metres(r.total.length)]);
        if (r.length.n) out.facts.push(["Panjang rata-rata", fmt(r.length.mean, 3) + " km"], ["Terpendek – terpanjang", fmt(r.length.min, 3) + " – " + fmt(r.length.max, 3) + " km"]);
      }
      if (k.point) out.facts.push(["Titik", fmt(k.point) + " (kolom bujur, lintang)"]);
      out.note = "Kolom baru ada di lapisan hasil: " + [k.polygon ? "luas_ha, kelilingkm" : "", k.line ? "panjang_km" : "", k.point ? "bujur, lintang" : ""].filter(Boolean).join(", ") + ". Unduh untuk memakainya di Excel atau GIS.";
      return out;
    },
    pattern: function (r) {
      var nn = r.nn, out = { facts: [], tables: [] };
      out.facts.push(
        ["Titik", fmt(r.n)],
        ["Pusat rata-rata (lintang, bujur)" + (r.weightField ? ", bobot " + r.weightField : ""), fmt(r.meanCenter[1], 5) + "; " + fmt(r.meanCenter[0], 5)],
        ["Jarak standar", metres(r.standardDistance)],
        ["Jarak tetangga terdekat rata-rata", metres(nn.observed)],
        ["Jika acak (diharapkan)", metres(nn.expected)],
        ["Indeks tetangga terdekat (R)", fmt(nn.ratio, 3)],
        ["z-score", fmt(nn.z, 2)], ["p-value", pval(nn.p)],
        ["Luas wilayah studi (convex hull)", hectares(nn.area)]
      );
      var sig = significant(nn.p);
      out.verdict = !sig ? { tone: "neutral", title: "Acak", text: "Sebaran titik tidak berbeda nyata dari sebaran acak (p ≥ 0,05)." } :
        nn.ratio < 1 ? { tone: "info", title: "Mengelompok", text: "Titik-titik lebih berdekatan daripada jika tersebar acak (R = " + fmt(nn.ratio, 2) + ", p " + (nn.p < 0.001 ? "< 0,001" : "= " + fmt(nn.p, 3)) + ")." } :
          { tone: "info", title: "Menyebar (teratur)", text: "Titik-titik lebih berjauhan dan teratur daripada jika tersebar acak (R = " + fmt(nn.ratio, 2) + ")." };
      out.note = "Di peta: titik pusat rata-rata dan lingkaran jarak standar (sekitar 68% titik berada di dalamnya bila sebarannya normal). Indeks R peka terhadap luas wilayah studi: di sini convex hull titik.";
      return out;
    },
    moran: function (r) {
      var m = r.result, w = r.weights, out = { facts: [], tables: [] };
      out.facts.push(
        ["Kolom", r.field], ["Fitur", fmt(m.n) + (r.missing ? " (" + fmt(r.missing) + " tanpa nilai dilewati)" : "")],
        ["Moran's I", fmt(m.I, 4)], ["Diharapkan jika acak", fmt(m.expected, 4)],
        ["z-score", fmt(m.z, 2)], ["p-value", pval(m.p)]
      );
      if (m.permutations) out.facts.push(["p-value semu (" + fmt(m.permutations) + " permutasi)", pval(m.pseudoP)]);
      out.facts.push(["Tetangga per fitur", weightsText(w)]);
      var sig = significant(m.p);
      out.verdict = !sig ? { tone: "neutral", title: "Tidak ada pola spasial yang nyata", text: "Sebaran nilai tidak berbeda nyata dari acak (p ≥ 0,05)." } :
        m.I > m.expected ? { tone: "info", title: "Mengelompok (autokorelasi positif)", text: "Fitur bernilai tinggi cenderung berdekatan dengan yang tinggi, dan yang rendah dengan yang rendah. Jalankan Hot spot (Gi*) untuk melihat di mana." } :
          { tone: "info", title: "Berselang-seling (autokorelasi negatif)", text: "Fitur bernilai tinggi cenderung bertetangga dengan yang rendah, seperti papan catur." };
      if (w.fallback) out.note = fmt(w.fallback) + " fitur tidak punya tetangga bersinggungan (mis. pulau), jadi memakai satu tetangga terdekatnya.";
      return out;
    },
    hotspot: function (r) {
      var w = r.weights, out = { facts: [], tables: [] };
      out.facts.push(["Kolom", r.field], ["Fitur", fmt(r.n) + (r.missing ? " (" + fmt(r.missing) + " tanpa nilai dilewati)" : "")], ["Tetangga per fitur", weightsText(w)]);
      out.tables.push({
        title: "Kelas", head: ["Kelas", "Fitur"],
        rows: [3, 2, 1, 0, -1, -2, -3].map(function (k) { return [k, r.bins[k] || 0]; }),
        fmt: [function (k) { return HOT_LABELS[k]; }, fmt], num: [0, 1],
        html: [function (k) { return '<span class="an-swatch" style="--c:' + HOT[k] + '"></span>' + esc(HOT_LABELS[k]); }, null],
        csv: [function (k) { return HOT_LABELS[k]; }, null],
      });
      var hot = (r.bins[3] || 0) + (r.bins[2] || 0) + (r.bins[1] || 0), cold = (r.bins[-3] || 0) + (r.bins[-2] || 0) + (r.bins[-1] || 0);
      out.verdict = hot || cold ?
        { tone: "info", title: fmt(hot) + " fitur hot spot, " + fmt(cold) + " fitur cold spot", text: "Hot spot: nilai tinggi yang dikelilingi nilai tinggi; cold spot: nilai rendah di antara nilai rendah. Klik fitur di peta untuk melihat z-score dan p-value-nya." } :
        { tone: "neutral", title: "Tidak ada hot spot atau cold spot", text: "Tidak ada kelompok nilai tinggi atau rendah yang signifikan pada tingkat kepercayaan 90%." };
      out.note = "Tingkat kepercayaan per fitur tanpa koreksi uji berganda (FDR): dengan banyak fitur, sebagian kecil bisa signifikan karena kebetulan." + (w.fallback ? " " + fmt(w.fallback) + " fitur tanpa tetangga bersinggungan memakai satu tetangga terdekatnya." : "");
      return out;
    },
    buffer: function (r) {
      var out = { facts: [["Jarak", r.distance < 0 ? "−" + metres(-r.distance) : metres(r.distance)], ["Poligon hasil", fmt(r.count)], ["Total luas", hectares(r.area)]] };
      var notes = [];
      if (r.empty) notes.push(fmt(r.empty) + " poligon habis karena lebih sempit dari jarak buffer negatif.");
      if (r.failed) notes.push(fmt(r.failed) + " fitur gagal diproses (geometrinya kemungkinan tidak valid).");
      if (r.dissolved) notes.push("Buffer yang bertumpuk sudah digabung, jadi total luas tidak dihitung dobel.");
      else notes.push("Buffer yang bertumpuk tidak digabung, jadi total luas bisa menghitung area yang sama lebih dari sekali.");
      out.note = notes.join(" ");
      return out;
    },
    centroid: function (r) {
      return { facts: [["Titik hasil", fmt(r.count)]], note: r.inside ? "Titik poligon dijamin berada di dalam poligonnya (untuk bentuk seperti huruf C, centroid bisa jatuh di luar)." : "" };
    },
    envelope: function (r) {
      return { facts: [["Bentuk", r.shape === "bbox" ? "Kotak batas" : "Convex hull"], ["Untuk", r.per === "feature" ? "Setiap fitur" : "Semua fitur"], ["Poligon hasil", fmt(r.count)], ["Total luas", hectares(r.area)]] };
    },
    dissolve: function (r) {
      return {
        facts: [["Gabung menurut", r.field || "semua fitur"], ["Fitur awal", fmt(r.count)], ["Fitur hasil", fmt(r.groups)]].concat(r.area ? [["Total luas", hectares(r.area)]] : []),
        note: r.failed ? fmt(r.failed) + " kelompok tidak bisa disatukan (geometri tidak valid) dan disimpan sebagai multi-poligon apa adanya." : "",
      };
    },
    count: function (r, res) {
      var out = {
        facts: [["Poligon", fmt(r.polygons)], ["Titik di lapisan kedua", fmt(r.points)], ["Titik di dalam poligon", fmt(r.inside)],
          ["Poligon tanpa titik", fmt(r.empty)], ["Titik per poligon (rata-rata)", num(r.counts.mean)], ["Terbanyak", fmt(r.counts.max)]],
        tables: [],
      };
      if (r.inside < r.points) out.note = fmt(r.points - r.inside) + " titik tidak berada di dalam poligon mana pun.";
      if (r.inside > r.points) out.note = "Ada poligon yang bertumpuk, jadi sebagian titik dihitung di lebih dari satu poligon.";
      var label = labelField(r.swapped ? state.b : state.a), field = r.field;
      if (res && res.draw) {
        var head = [label || "Fitur", "Titik", "Per km²"], rows = res.draw.map(function (f, i) {
          var p = f.properties, row = [label ? p[label] : i + 1, p.n_titik, p.per_km2];
          if (field) row.push(p["total_" + field], p["rerata_" + field]);
          return row;
        }).sort(function (a, b) { return b[1] - a[1]; });
        if (field) head.push("Total " + field, "Rata-rata " + field);
        out.tables.push({ title: "Per poligon", head: head, rows: rows, fmt: [null, fmt, function (v) { return num(v); }, num, num], num: [0, 1, 1, 1, 1], limit: 100 });
      }
      return out;
    },
    clip: cutReport, erase: cutReport,
    intersect: function (r) {
      return { facts: [["Fitur data utama", fmt(r.input)], ["Poligon lapisan kedua", fmt(r.overlay)], ["Potongan hasil", fmt(r.count)]],
        note: "Setiap potongan membawa atribut dari kedua lapisan (kolom yang namanya sama diberi akhiran _2), ditambah luas_ha atau panjang_km potongan itu." + failedNote(r) };
    },
  };
  function cutReport(r) {
    return { facts: [["Fitur data utama", fmt(r.input)], ["Fitur hasil", fmt(r.count)], [r.op === "clip" ? "Di luar, dibuang" : "Habis terhapus", fmt(r.removed)]],
      note: "Luas (luas_ha) atau panjang (panjang_km) dihitung ulang untuk bagian yang tersisa." + failedNote(r) };
  }
  function failedNote(r) { return r.failed ? " " + fmt(r.failed) + " fitur gagal diproses (geometrinya kemungkinan tidak valid)." : ""; }
  function weightsText(w) {
    var name = { contiguity: "bersinggungan", knn: "k terdekat", distance: "dalam jarak" }[w.method];
    return name + ": " + fmt(w.min) + "–" + fmt(w.max) + " (rata-rata " + fmt(w.mean, 1) + ")";
  }
  // A text field that names the features (nama, name, desa…), for tables.
  function labelField(layer) {
    if (!layer) return "";
    var texts = layer.summary.fields.filter(function (f) { return f.type === "Text"; }).map(function (f) { return f.name; });
    return texts.filter(function (n) { return /^(nama|name|nm|desa|kelurahan|kecamatan|kabupaten|kab_kota|provinsi|pulau|wilayah)/i.test(n); })[0] || texts[0] || "";
  }

  function showReport(op, res) {
    var built = REPORTS[op](res.report, res);
    state.last.tables = [{ title: "Ringkasan", head: ["Ukuran", "Nilai"], rows: built.facts }].concat(built.tables || []);
    $("an-result-title").textContent = "Hasil: " + OP_NAMES[op];
    $("an-report").innerHTML = factsHtml(built.facts) + verdictHtml(built.verdict) +
      (built.histogram ? histogramHtml(built.histogram) : "") +
      (built.tables || []).map(function (t) {
        return t.hidden ? '<details class="an-details"><summary>Tabel ' + esc(t.title.toLowerCase()) + "</summary>" + tableHtml(t) + "</details>" : tableHtml(t);
      }).join("") +
      (built.note ? '<p class="hint an-note">' + esc(built.note) + "</p>" : "");
    $("an-download").hidden = !res.summary;
    $("an-table-wrap").hidden = false;
    $("an-saved").hidden = true;
    $("an-result").hidden = false;
    if (!res.summary && op !== "describe" && op !== "moran") {
      $("an-report").insertAdjacentHTML("beforeend", '<p class="hint an-note">Lapisan hasil kosong: tidak ada fitur yang tersisa.</p>');
    }
  }

  function csvTables() {
    var lines = [];
    function cell(v) {
      if (v == null) return "";
      var s = typeof v === "number" ? String(v) : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    (state.last.tables || []).forEach(function (t) {
      if (lines.length) lines.push("");
      lines.push(cell(t.title));
      lines.push(t.head.map(cell).join(","));
      t.rows.forEach(function (r) {
        lines.push(r.map(function (v, i) { return cell(t.csv && t.csv[i] ? t.csv[i](v) : v); }).join(","));
      });
    });
    return "﻿" + lines.join("\r\n") + "\r\n";
  }

  function download(blob, filename) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
  }

  // ---------- Running ----------
  var busy = false;
  function run() {
    var op = currentOp(), why = blocker(op);
    if (why || busy) { if (why) status(why, true); return; }
    busy = true;
    $("an-run").disabled = true;
    status("Menghitung " + OP_NAMES[op].toLowerCase() + "…");
    var t0 = Date.now();
    ask("run", { op: op, params: params(op) }).then(function (res) {
      state.last = { op: op, report: res.report, summary: res.summary, drawn: !!res.draw };
      var layer = draw("result", res.draw, op);
      if (layer) fit(layer);
      else if (res.summary) fitBbox(res.summary.bbox);
      showReport(op, res);
      legend();
      mapNote();
      var secs = (Date.now() - t0) / 1000;
      status(secs >= 2 ? "Selesai dalam " + fmt(secs, 1) + " detik." : "");
      $("an-name").value = (state.a.name.replace(/\.[^.]+$/, "") + "_" + op).slice(0, 80);
      if (window.matchMedia("(max-width: 860px)").matches) $("an-result").scrollIntoView({ behavior: "smooth", block: "start" });
      // Only the kind of analysis is counted, never the file or its contents.
      track("analisis-spasial/" + op, "Analisis spasial: " + OP_NAMES[op]);
    }).catch(function (err) {
      if (window.console) console.error(err);
      status(explain(err), true);
    }).then(function () {
      busy = false;
      syncForm();
    });
  }

  function clearResult() {
    state.last = null;
    draw("result", null);
    $("an-result").hidden = true;
    $("an-report").innerHTML = "";
    legend();
    mapNote();
  }

  // ---------- Opening files ----------
  function openFiles(slot, files, isSample) {
    files = Array.prototype.slice.call(files || []);
    if (!files.length || busy) return;
    var size = files.reduce(function (sum, f) { return sum + f.size; }, 0);
    if (state.limit && size > state.limit) {
      status("File ini " + mb(size) + ", melebihi batas " + mb(state.limit) + " untuk browser di perangkat ini. Potong data per wilayah atau sederhanakan geometrinya dulu.", true);
      return;
    }
    var main = files.filter(function (f) { return !/\.(dbf|prj|cpg|shx)$/i.test(f.name); })[0] || files[0];
    busy = true;
    status("Membaca " + main.name + " (" + mb(size) + ")…");
    clearResult();
    return ask("read", { slot: slot, files: files, options: { maxBytes: state.limit } }).then(function (d) {
      state[slot] = { name: main.name, summary: d.summary, drawn: !!d.draw };
      var layer = draw(slot, d.draw);
      if (slot === "a") {
        fit(layer);
        if (!layer) fitBbox(d.summary.bbox);
        $("an-placeholder").hidden = true;
        $("an-options").hidden = false;
        $("an-clear-wrap").hidden = false;
      }
      layerInfo(slot);
      fillFields();
      status("");
      if (!isSample) track("analisis-spasial/buka", "Analisis spasial: buka file");
    }).catch(function (err) {
      state[slot] = null;
      draw(slot, null);
      layerInfo(slot);
      status(explain(err), true);
    }).then(function () {
      busy = false;
      mapNote();
      syncForm();
    });
  }

  var KIND_NAMES = { point: "titik", line: "garis", polygon: "poligon" };
  function layerInfo(slot) {
    var el = $(slot === "a" ? "an-layer-a" : "an-layer-b"), l = state[slot];
    if (!l) { el.hidden = true; el.innerHTML = ""; return; }
    var k = l.summary.kinds, kinds = Object.keys(KIND_NAMES).filter(function (x) { return k[x]; }).map(function (x) { return fmt(k[x]) + " " + KIND_NAMES[x]; });
    el.innerHTML = '<span class="an-swatch' + (slot === "b" ? " dashed" : "") + '" style="--c:' + COLORS[slot] + '"></span>' +
      "<span><strong>" + esc(l.name) + "</strong> " + esc(kinds.join(", ")) + " · " + fmt(l.summary.fields.length) + " kolom" +
      (/UTM|Mercator/i.test(l.summary.crs) ? " · " + esc(l.summary.crs) + " → WGS 84" : "") + "</span>";
    el.hidden = false;
  }

  function resetLayers() {
    state.a = state.b = null;
    ["a", "b"].forEach(function (s) { draw(s, null); layerInfo(s); });
    clearResult();
    $("an-options").hidden = true;
    $("an-placeholder").hidden = false;
    $("an-clear-wrap").hidden = true;
    $("an-file").value = "";
    $("an-file-b").value = "";
    $("an-field").dataset.touched = "";
  }

  function clearAll() {
    ask("clear").catch(function () {});
    resetLayers();
    status("Data sudah dihapus dari memori browser.");
  }

  // ---------- Samples ----------
  var SAMPLES = {
    kota: { file: "data/contoh-kota.geojson", name: "contoh-kota.geojson" },
    pulau: { file: "data/contoh-pulau.geojson", name: "contoh-pulau.geojson" },
  };
  function loadSample(slot, which) {
    if (busy) return Promise.resolve();
    status("Memuat data contoh…");
    var s = SAMPLES[which];
    return fetch(s.file).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.blob();
    }).then(function (blob) {
      return openFiles(slot, [new File([blob], s.name, { type: "application/geo+json" })], true);
    }).catch(function () {
      status("Data contoh gagal dimuat. Muat ulang halaman lalu coba lagi.", true);
    });
  }

  function deviceEnv() {
    var ua = navigator.userAgent || "";
    var mobile = (navigator.userAgentData && navigator.userAgentData.mobile) || /Android|iPhone|iPad|iPod|Mobi/i.test(ua) ||
      (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua)); // iPadOS reports a Mac
    return { mobile: !!mobile, deviceMemory: navigator.deviceMemory || 0 };
  }

  function dropzone(zone, input, slot) {
    input.addEventListener("change", function () { openFiles(slot, this.files); this.value = ""; });
    ["dragenter", "dragover"].forEach(function (t) {
      zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.add("over"); });
    });
    ["dragleave", "drop"].forEach(function (t) {
      zone.addEventListener(t, function () { zone.classList.remove("over"); });
    });
    zone.addEventListener("drop", function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) openFiles(slot, e.dataTransfer.files);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    // Start the worker now, so its scripts are loaded before any file is
    // picked (the analysis then also works with the internet off).
    ask("limit", { env: deviceEnv() }).then(function (limit) {
      state.limit = limit;
      document.querySelectorAll("[data-an-limit]").forEach(function (el) { el.textContent = mb(limit); });
    }).catch(function (err) {
      status(explain(err), true);
    });

    dropzone($("an-drop"), $("an-file"), "a");
    dropzone($("an-drop-b"), $("an-file-b"), "b");

    $("an-sample").addEventListener("click", function () {
      // Cities as the data and the island regions as the second layer, so
      // every analysis can be tried straight away.
      $("an-op").value = "describe";
      loadSample("a", "kota").then(function () {
        if (state.a) {
          $("an-field").value = "penduduk_ribu";
          $("an-group").value = "pulau";
          syncForm();
          track("analisis-spasial/contoh", "Analisis spasial: coba data contoh");
          return loadSample("b", "pulau");
        }
      });
    });
    $("an-sample-b").addEventListener("click", function () {
      loadSample("b", currentOp() === "count" && kindsOf(state.a).polygon ? "kota" : "pulau");
    });

    $("an-op").addEventListener("change", syncForm);
    $("an-field").addEventListener("change", function () { this.dataset.touched = "1"; syncForm(); });
    $("an-weights").addEventListener("change", syncForm);
    $("an-run").addEventListener("click", run);
    $("an-clear").addEventListener("click", clearAll);
    $("an-save").addEventListener("click", function () {
      var btn = this, format = document.querySelector('input[name="an-format"]:checked').value;
      btn.disabled = true;
      ask("write", { format: format, name: $("an-name").value.trim() || "hasil_analisis" }).then(function (out) {
        download(out.blob, out.filename);
        $("an-saved").innerHTML = "<p><strong>Selesai.</strong> " + esc(out.filename) + " (" + mb(out.blob.size) + ") sudah diunduh ke perangkat Anda.</p>" +
          (out.warnings.some(function (w) { return w.code === "renamed-fields"; }) ? "<ul><li>Nama kolom shapefile maksimal 10 karakter, jadi sebagian kolom diganti namanya.</li></ul>" : "");
        $("an-saved").hidden = false;
        track("analisis-spasial/unduh", "Analisis spasial: unduh hasil");
      }).catch(function (err) {
        status(explain(err), true);
      }).then(function () { btn.disabled = false; });
    });
    $("an-table").addEventListener("click", function () {
      if (!state.last) return;
      download(new Blob([csvTables()], { type: "text/csv" }), (state.a.name.replace(/\.[^.]+$/, "") + "_" + state.last.op + "_tabel.csv").slice(0, 90));
    });
    syncForm();
  });
})();
