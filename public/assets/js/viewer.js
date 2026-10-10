// Public GeoTIFF viewer (lihat-geotiff.html): a visitor opens a GeoTIFF, sees
// it on a Leaflet map and colours it from its bands (RGB composite, one band
// with a colour ramp, or a normalised-difference index such as NDVI). The
// file is read and drawn in this browser by geotiff.js; nothing is uploaded.
(function () {
  "use strict";

  var GT = window.GeoTiff;
  var state = null; // { info, grid, lookup, name, stats: [], index: {key, values, stats} }

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmt(n) { return Number(n).toLocaleString("id-ID"); }
  // Values as typed in the range boxes and shown in the legend.
  function num(v) {
    if (v == null || v !== v) return "";
    if (Number.isInteger(v)) return String(v);
    var a = Math.abs(v);
    return String(Number(v.toPrecision(a >= 1000 ? 7 : 4)));
  }

  function status(text, isError) {
    $("gv-status").textContent = text;
    $("gv-status").className = "mm-status" + (isError ? " error" : "");
    $("gv-status").hidden = !text;
  }

  function track(path, title) {
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: path, title: title, event: true });
  }

  // geotiff.js speaks English (it is shared with the tests).
  function explain(err) {
    var m = (err && err.message) || "";
    if (/not a TIFF/.test(m)) return "File ini bukan GeoTIFF. Pilih file .tif atau .tiff.";
    if (/not georeferenced/.test(m)) return "File TIFF ini tidak punya koordinat (georeferensi), jadi tidak bisa ditempatkan di peta. Di QGIS, beri georeferensi atau ekspor ulang sebagai GeoTIFF.";
    if (/compression (.+) is not supported/.test(m)) return "Kompresi " + m.match(/compression (.+) is not supported/)[1] + " belum didukung. Simpan ulang dengan kompresi DEFLATE atau LZW (QGIS: Export → Save As, atau gdal_translate -co COMPRESS=DEFLATE).";
    if (/projection|CRS model|units are not metres/.test(m)) return "Proyeksi file ini belum didukung. Proyeksikan ulang ke WGS 84 (EPSG:4326) atau UTM, misalnya dengan gdalwarp -t_srs EPSG:4326, lalu coba lagi.";
    if (/outside the world/.test(m)) return "Koordinat file ini di luar jangkauan bumi. Periksa sistem koordinatnya.";
    if (/samples are not supported|unsupported JPEG/.test(m)) return "Tipe nilai piksel di file ini belum didukung. Simpan ulang sebagai 8, 16, atau 32 bit.";
    if (/image decoder not available/.test(m)) return "Browser ini tidak bisa membaca GeoTIFF berkompresi JPEG/WebP. Coba Chrome, Edge, Firefox, atau Safari versi baru.";
    if (/broken TIFF|Offset is outside|out of bounds/i.test(m)) return "File ini rusak atau tidak lengkap. Coba unduh atau ekspor ulang.";
    if ((err && err.name === "RangeError") || /out of memory|allocation failed/i.test(m)) return "Memori browser tidak cukup untuk file ini. Tutup tab lain lalu coba lagi.";
    return "File tidak bisa dibaca" + (m ? ": " + m : ".");
  }

  // ---------- Map ----------
  // An image overlay whose image is a canvas, so restyling is a putImageData
  // instead of encoding a new image.
  var CanvasOverlay = L.ImageOverlay.extend({
    _initImage: function () {
      var c = this._image = this._url;
      L.DomUtil.addClass(c, "leaflet-image-layer");
      L.DomUtil.addClass(c, "gv-raster");
      if (this._zoomAnimated) L.DomUtil.addClass(c, "leaflet-zoom-animated");
      c.onselectstart = L.Util.falseFn;
      c.onmousemove = L.Util.falseFn;
    },
  });

  var map = L.map("gv-map", { center: [-2.5, 118], zoom: 4, maxZoom: 22, zoomSnap: 0.5 });
  var BASEMAPS = {
    osm: function () {
      return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 22, maxNativeZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      });
    },
    imagery: function () {
      return L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 22, maxNativeZoom: 19,
        attribution: "Citra &copy; Esri, Maxar, Earthstar Geographics",
      });
    },
  };
  var basemap = null;
  function setBasemap(name) {
    if (basemap) map.removeLayer(basemap);
    basemap = BASEMAPS[name] ? BASEMAPS[name]().addTo(map) : null;
  }
  setBasemap($("gv-basemap").value);
  $("gv-basemap").addEventListener("change", function () { setBasemap(this.value); });

  var overlay = null, canvas = null, ctx = null, image = null, gridRgba = null;

  // ---------- Opening ----------
  var busy = false;
  function openFile(file, name, isSample) {
    if (busy) return;
    busy = true;
    clearData();
    status("Membaca " + name + "…");
    var info;
    GT.open(file).then(function (i) {
      info = i;
      return GT.readGrid(info, {
        onProgress: function (f) { status("Membaca " + name + "… " + Math.round(f * 100) + "%"); },
      });
    }).then(function (grid) {
      var lookup = GT.mercatorLookup(grid, info.crs);
      state = { info: info, grid: grid, lookup: lookup, name: name, stats: [], index: null };
      showRaster();
      track(isSample ? "lihat-geotiff/contoh" : "lihat-geotiff/buka", isSample ? "Lihat GeoTIFF: contoh" : "Lihat GeoTIFF: buka file");
    }).catch(function (err) {
      if (window.console) console.error(err);
      clearData();
      status(explain(err), true);
    }).then(function () { busy = false; });
  }

  $("gv-file").addEventListener("change", function () {
    var f = this.files && this.files[0];
    if (f) openFile(f, f.name, false);
    this.value = "";
  });
  var drop = $("gv-drop");
  ["dragenter", "dragover"].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (t) {
    drop.addEventListener(t, function () { drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) {
    e.preventDefault();
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f, f.name, false);
  });
  $("gv-sample").addEventListener("click", function () {
    if (busy) return;
    status("Memuat contoh…");
    fetch("data/contoh-sentinel2-jakarta.tif").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.blob();
    }).then(function (b) {
      openFile(b, "Sentinel-2 pesisir Jakarta Utara, 27 Juli 2024 (data Copernicus Sentinel)", true);
    }).catch(function () { status("Contoh tidak bisa dimuat. Periksa koneksi lalu coba lagi.", true); });
  });

  function clearData() {
    state = null;
    if (overlay) { map.removeLayer(overlay); overlay = null; }
    canvas = ctx = image = gridRgba = null;
    map.closePopup();
    $("gv-options").hidden = true;
    $("gv-summary").hidden = true;
    $("gv-placeholder").hidden = false;
  }
  $("gv-clear").addEventListener("click", function () {
    clearData();
    status("Data sudah dihapus dari memori browser.");
  });

  // ---------- After opening ----------
  function bandLabel(b, i) { return "Band " + (b.index + 1) + (b.name ? " · " + b.name : ""); }

  function showRaster() {
    var s = state, info = s.info, grid = s.grid;
    canvas = document.createElement("canvas");
    canvas.width = s.lookup.width;
    canvas.height = s.lookup.height;
    ctx = canvas.getContext("2d");
    image = ctx.createImageData(canvas.width, canvas.height);
    gridRgba = new Uint8ClampedArray(grid.width * grid.height * 4);
    overlay = new CanvasOverlay(canvas, s.lookup.bounds, { opacity: $("gv-opacity").value / 100 }).addTo(map);
    map.fitBounds(s.lookup.bounds, { maxZoom: 18 });

    // Band lists.
    var opts = info.bands.map(function (b, i) { return '<option value="' + i + '">' + esc(bandLabel(b, i)) + "</option>"; }).join("");
    ["gv-r", "gv-g", "gv-b", "gv-band", "gv-ia", "gv-ib"].forEach(function (id) { $(id).innerHTML = opts; });
    var n = info.bands.length, roles = GT.guessBands(info.bands.map(function (b) { return b.name; }));
    s.roles = roles;
    $("gv-r").value = roles.red != null ? roles.red : 0;
    $("gv-g").value = roles.green != null ? roles.green : Math.min(1, n - 1);
    $("gv-b").value = roles.blue != null ? roles.blue : Math.min(2, n - 1);
    $("gv-band").value = 0;
    $("gv-ia").value = roles.nir != null ? roles.nir : n - 1;
    $("gv-ib").value = roles.red != null ? roles.red : 0;
    $("gv-ramp").value = info.dtype === "uint8" ? "gray" : "viridis";
    $("gv-reverse").checked = false;
    $("gv-mode-palette").hidden = !info.palette;
    presets(roles);

    var mode = info.palette ? "palette" : n >= 3 ? "rgb" : "single";
    setMode(mode);
    facts();
    $("gv-options").hidden = false;
    $("gv-summary").hidden = false;
    $("gv-placeholder").hidden = true;
    status(s.name + ": " + fmt(info.width) + " × " + fmt(info.height) + " piksel, " + fmt(n) + " band.");
  }

  function facts() {
    var s = state, info = s.info, grid = s.grid, t = info.transform;
    var px = Math.sqrt(Math.abs(t[1] * t[5] - t[2] * t[4]));
    var geographic = /bujur/.test(info.crs.name);
    var size = geographic ? num(px) + "°" + (px < 0.01 ? " (± " + fmt(Math.round(px * 111320 * 10) / 10) + " m)" : "") : fmt(Math.round(px * 100) / 100) + " m";
    var rows = [
      ["Ukuran", fmt(info.width) + " × " + fmt(info.height) + " piksel"],
      ["Band", fmt(info.bands.length) + " (" + info.dtype + ")"],
      ["Ukuran piksel", size],
      ["Sistem koordinat", info.crs.name],
      ["NoData", info.nodata == null ? (info.alphaBand >= 0 ? "band alfa" : "—") : num(info.nodata)],
      ["Kompresi", info.compression === "none" ? "tanpa" : info.compression],
    ];
    $("gv-facts").innerHTML = rows.map(function (r) { return "<div><dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd></div>"; }).join("");
    var note = $("gv-note");
    if (grid.width < info.width) {
      note.textContent = "Ditampilkan pada " + fmt(grid.width) + " × " + fmt(grid.height) + " piksel (diperkecil " + fmt(Math.round(info.width / grid.width * 10) / 10) + "×) agar muat di memori browser. Nilai piksel saat diklik berasal dari resolusi ini.";
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  // Shortcuts when the band names say which band is which.
  var PRESETS = [
    { label: "Warna asli", need: ["red", "green", "blue"], apply: function (r) { setRgb(r.red, r.green, r.blue); } },
    { label: "Inframerah semu", need: ["nir", "red", "green"], apply: function (r) { setRgb(r.nir, r.red, r.green); } },
    { label: "NDVI", need: ["nir", "red"], apply: function (r) { setIndex(r.nir, r.red, "rdylgn"); } },
    { label: "NDWI", need: ["green", "nir"], apply: function (r) { setIndex(r.green, r.nir, "blues"); } },
  ];
  function presets(roles) {
    var box = $("gv-presets"), list = PRESETS.filter(function (p) { return p.need.every(function (k) { return roles[k] != null; }); });
    box.innerHTML = list.map(function (p, i) { return '<button type="button" class="chip" data-preset="' + i + '">' + esc(p.label) + "</button>"; }).join("");
    box.hidden = !list.length;
    box.onclick = function (e) {
      var b = e.target.closest("[data-preset]");
      if (b) list[Number(b.getAttribute("data-preset"))].apply(state.roles);
    };
  }
  function setRgb(r, g, b) {
    $("gv-r").value = r; $("gv-g").value = g; $("gv-b").value = b;
    setMode("rgb");
  }
  function setIndex(a, b, ramp) {
    $("gv-ia").value = a; $("gv-ib").value = b; $("gv-ramp").value = ramp; $("gv-reverse").checked = false;
    setMode("index");
  }

  // ---------- Style ----------
  function mode() {
    var el = document.querySelector('input[name="gv-mode"]:checked');
    return el ? el.value : "rgb";
  }
  function setMode(m) {
    document.querySelector('input[name="gv-mode"][value="' + m + '"]').checked = true;
    document.querySelectorAll(".gv-group").forEach(function (g) {
      g.hidden = g.getAttribute("data-for").split(" ").indexOf(m) < 0;
    });
    $("gv-stretch").querySelector('[value="fixed"]').hidden = m !== "index";
    $("gv-stretch").querySelector('[value="byte"]').hidden = m === "index" || state.info.dtype !== "uint8";
    $("gv-stretch").value = defaultStretch(m);
    fillRanges();
    repaint();
  }

  // 8-bit images (photos, drone orthomosaics) already hold display colours.
  function defaultStretch(m) {
    return m === "index" ? "fixed" : state.info.dtype === "uint8" ? "byte" : "p2";
  }

  function bandStats(i) {
    if (!state.stats[i]) state.stats[i] = GT.stats(state.grid.bands[i]) || { min: 0, max: 0, p2: 0, p98: 0 };
    return state.stats[i];
  }
  function indexValues() {
    var a = Number($("gv-ia").value), b = Number($("gv-ib").value), key = a + "/" + b;
    if (!state.index || state.index.key !== key) {
      var values = GT.normalizedDifference(state.grid.bands[a], state.grid.bands[b]);
      state.index = { key: key, values: values, stats: GT.stats(values) || { min: -1, max: 1, p2: -1, p98: 1 } };
    }
    return state.index;
  }

  // The channels whose range can be set: [label, stats] per channel.
  function channels() {
    var m = mode();
    if (m === "rgb") {
      return [["Merah", bandStats(Number($("gv-r").value))], ["Hijau", bandStats(Number($("gv-g").value))], ["Biru", bandStats(Number($("gv-b").value))]];
    }
    if (m === "single") return [["", bandStats(Number($("gv-band").value))]];
    if (m === "index") return [["", indexValues().stats]];
    return [];
  }

  // Fills the min/max boxes from the chosen stretch.
  function fillRanges() {
    var how = $("gv-stretch").value, list = channels();
    if (how === "manual") {
      // Keep what is typed, but add boxes if the number of channels changed.
      if ($("gv-ranges").children.length === list.length) return;
      how = defaultStretch(mode());
    }
    $("gv-ranges").innerHTML = list.map(function (c, i) {
      var st = c[1], lo = st.p2, hi = st.p98;
      if (how === "minmax") { lo = st.min; hi = st.max; }
      if (how === "fixed") { lo = -1; hi = 1; }
      if (how === "byte") { lo = 0; hi = 255; }
      return '<div class="gv-range' + (c[0] ? "" : " gv-range-one") + '">' + (c[0] ? "<span>" + esc(c[0]) + "</span>" : "") +
        '<input type="number" step="any" aria-label="' + esc((c[0] ? c[0] + ", " : "") + "minimum") + '" data-i="' + i + '" data-k="0" value="' + num(lo) + '">' +
        '<span aria-hidden="true">–</span>' +
        '<input type="number" step="any" aria-label="' + esc((c[0] ? c[0] + ", " : "") + "maksimum") + '" data-i="' + i + '" data-k="1" value="' + num(hi) + '"></div>';
    }).join("");
  }
  function ranges() {
    var out = [];
    $("gv-ranges").querySelectorAll("input").forEach(function (el) {
      var i = Number(el.getAttribute("data-i")), k = Number(el.getAttribute("data-k"));
      out[i] = out[i] || [0, 0];
      out[i][k] = el.value === "" ? NaN : Number(el.value);
    });
    return out;
  }

  function style() {
    var m = mode(), r = ranges();
    if (m === "palette") return { mode: "palette", band: 0, colormap: state.info.palette };
    if (m === "rgb") return { mode: "rgb", bands: [Number($("gv-r").value), Number($("gv-g").value), Number($("gv-b").value)], ranges: r };
    var s = { mode: m, ramp: $("gv-ramp").value, reverse: $("gv-reverse").checked, min: r[0][0], max: r[0][1] };
    if (m === "single") s.band = Number($("gv-band").value);
    else s.values = indexValues().values;
    return s;
  }

  function legend(s) {
    if (s.mode !== "single" && s.mode !== "index") return;
    var stops = GT.RAMPS[s.ramp].stops.slice();
    if (s.reverse) stops.reverse();
    $("gv-ramp-bar").style.background = "linear-gradient(to right, " + stops.join(", ") + ")";
    $("gv-legend-min").textContent = num(s.min);
    $("gv-legend-max").textContent = num(s.max);
  }

  var pending = false;
  function repaint() {
    if (!state || pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      if (!state) return;
      var s = style();
      if (s.ranges && s.ranges.some(function (r) { return !(r[0] === r[0] && r[1] === r[1]); })) return;
      if (s.min !== undefined && !(s.min === s.min && s.max === s.max)) return;
      GT.render(state.grid, s, gridRgba);
      GT.project(state.lookup, gridRgba, image.data);
      ctx.putImageData(image, 0, 0);
      legend(s);
    });
  }

  document.querySelectorAll('input[name="gv-mode"]').forEach(function (el) {
    el.addEventListener("change", function () { setMode(this.value); });
  });
  ["gv-r", "gv-g", "gv-b", "gv-band", "gv-ia", "gv-ib"].forEach(function (id) {
    $(id).addEventListener("change", function () {
      if ($("gv-stretch").value === "manual") $("gv-stretch").value = defaultStretch(mode());
      fillRanges();
      repaint();
    });
  });
  ["gv-ramp", "gv-reverse"].forEach(function (id) { $(id).addEventListener("change", repaint); });
  $("gv-stretch").addEventListener("change", function () { fillRanges(); repaint(); });
  $("gv-ranges").addEventListener("input", function () { $("gv-stretch").value = "manual"; repaint(); });
  $("gv-opacity").addEventListener("input", function () { if (overlay) overlay.setOpacity(this.value / 100); });

  // ---------- Pixel values ----------
  map.on("click", function (e) {
    if (!state) return;
    var i = GT.gridIndexAt(state.grid, state.info.crs, e.latlng.lng, e.latlng.lat);
    if (i < 0) return;
    var rows = state.info.bands.map(function (b, k) {
      var v = state.grid.bands[k][i];
      return "<tr><th>" + esc(bandLabel(b, k)) + "</th><td>" + (v === v ? esc(num(v)) : "NoData") + "</td></tr>";
    });
    if (mode() === "index") {
      var v = indexValues().values[i];
      rows.push("<tr><th>Indeks (A − B) / (A + B)</th><td>" + (v === v ? esc(num(Math.round(v * 1000) / 1000)) : "—") + "</td></tr>");
    }
    L.popup({ maxWidth: 320 }).setLatLng(e.latlng).setContent(
      '<table class="gv-pixel">' + rows.join("") + "</table>" +
      '<p class="gv-pixel-at">' + e.latlng.lat.toFixed(5) + ", " + e.latlng.lng.toFixed(5) + "</p>"
    ).openOn(map);
  });

  // Ramp list.
  $("gv-ramp").innerHTML = Object.keys(GT.RAMPS).map(function (k) { return '<option value="' + k + '">' + esc(GT.RAMPS[k].label) + "</option>"; }).join("");
})();
