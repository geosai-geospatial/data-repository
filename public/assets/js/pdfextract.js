// PDF map extractor (ekstrak-pdf.html): a visitor opens a map saved as PDF,
// gives it coordinates (read from a GeoPDF, or control points typed from the
// map grid), and extracts vector layers, colour classes as polygons and the
// map image as a GeoTIFF. pdf.js (vendored, assets/vendor/pdfjs) reads and
// renders the PDF; pdfgeo.js does the geography, its heavy part in a worker
// (pdfgeoworker.js); geoconvert.js writes the vector files. Nothing is
// uploaded.
(function () {
  "use strict";

  // The worker's scripts get the same ?v= tag as this one (see pages.yml).
  var script = document.currentScript;
  var VERSION = script && script.src.indexOf("?") > 0 ? script.src.slice(script.src.indexOf("?")) : "";
  var PG = window.PdfGeo, GT = window.GeoTiff, GC = window.GeoConvert;
  var MB = 1024 * 1024, MAX_BYTES = 150 * MB, MM_PER_PT = 25.4 / 72;
  var PDFJS = new URL("assets/vendor/pdfjs/pdf.min.mjs", document.baseURI).href;
  var PDFJS_WORKER = new URL("assets/vendor/pdfjs/pdf.worker.min.mjs", document.baseURI).href;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(n, dp) { return Number(n).toLocaleString("id-ID", { maximumFractionDigits: dp == null ? 0 : dp }); }
  function mb(bytes) { return bytes < MB ? fmt(Math.max(1, Math.round(bytes / 1024))) + " KB" : fmt(bytes / MB, 1) + " MB"; }
  function status(text, isError) {
    $("px-status").textContent = text;
    $("px-status").className = "mm-status" + (isError ? " error" : "");
    $("px-status").hidden = !text;
  }
  function track(path, title) {
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: path, title: title, event: true });
  }
  function explain(err) {
    var m = (err && err.message) || "", n = err && err.name;
    if (n === "PasswordException" || /password/i.test(m)) return "PDF ini dikunci dengan kata sandi. Buka di pembaca PDF, simpan tanpa kata sandi, lalu coba lagi.";
    if (n === "InvalidPDFException" || /Invalid PDF/i.test(m)) return "File ini bukan PDF yang valid, atau rusak.";
    if (/Failed to fetch dynamically imported module|Importing a module script failed|import/i.test(m) && !state.doc) return "Pembaca PDF tidak bisa dimuat. Periksa koneksi lalu muat ulang halaman, atau coba browser versi baru.";
    if ((err && err.name === "RangeError") || /out of memory|allocation failed/i.test(m)) return "Memori browser tidak cukup. Pilih resolusi lebih kecil atau perkecil area peta, tutup tab lain, lalu coba lagi.";
    if (/unsupported EPSG/.test(m)) return "Sistem koordinat ini belum didukung.";
    return "Terjadi kesalahan" + (m ? ": " + m : ".");
  }

  // ---------- pdf.js ----------
  var pdfjsLib = null;
  function loadPdfjs() {
    if (pdfjsLib) return Promise.resolve(pdfjsLib);
    return import(PDFJS).then(function (lib) {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      pdfjsLib = lib;
      return lib;
    });
  }

  // ---------- Our worker ----------
  var worker = null, seq = 0, waiting = {};
  function ask(cmd, payload, transfer) {
    if (!worker) {
      worker = new Worker("assets/js/pdfgeoworker.js" + VERSION);
      worker.onmessage = function (e) {
        var w = waiting[e.data.id];
        if (!w) return;
        delete waiting[e.data.id];
        if (e.data.error) w.reject(e.data.error); else w.resolve(e.data.result);
      };
      worker.onerror = function (e) {
        Object.keys(waiting).forEach(function (id) { waiting[id].reject({ message: e.message || "worker failed" }); });
        waiting = {};
      };
    }
    return new Promise(function (resolve, reject) {
      var id = ++seq, msg = payload || {};
      waiting[id] = { resolve: resolve, reject: reject };
      msg.id = id;
      msg.cmd = cmd;
      worker.postMessage(msg, transfer || []);
    });
  }

  // ---------- State ----------
  // Page coordinates are PDF user space (points, y up). "Display" coordinates
  // are the page as shown (pdf.js viewport at scale 1: y down, /Rotate
  // applied); Leaflet's CRS.Simple shows display (x, y) as latLng(−y, x).
  var state = {};
  function resetState() {
    state = {
      doc: null, bytes: null, name: "", page: null, pageNum: 1, size: [0, 0], toDisp: null, fromDisp: null,
      paths: [], images: [], nodes: [], lattice: null, frame: null, groups: [], labels: [], dpi: null,
      geo: null, epsg: 4326, entry: "map", points: [], fit: null, intervalTouched: false,
      classes: [], lut: null, mode: null, base: null, detail: null, urls: [],
    };
  }
  resetState();

  function toDisplay(x, y) { return PG.apply(state.toDisp, x, y); }
  function toLatLng(x, y) { var d = toDisplay(x, y); return L.latLng(-d[1], d[0]); }
  function fromLatLng(ll) { return PG.apply(state.fromDisp, ll.lng, -ll.lat); }
  // Page rectangle → display rectangle [x0, y0, x1, y1].
  function dispRect(b) {
    var a = toDisplay(b[0], b[1]), c = toDisplay(b[2], b[3]);
    return [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])];
  }
  function mapCrs() { return PG.crs(state.epsg); }

  // ---------- PDF view ----------
  var CanvasOverlay = L.ImageOverlay.extend({
    _initImage: function () {
      var c = this._image = this._url;
      L.DomUtil.addClass(c, "leaflet-image-layer");
      if (this._zoomAnimated) L.DomUtil.addClass(c, "leaflet-zoom-animated");
      c.onselectstart = L.Util.falseFn;
      c.onmousemove = L.Util.falseFn;
    },
  });

  var view = L.map("px-view", { crs: L.CRS.Simple, minZoom: -6, maxZoom: 5, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: false, center: [0, 0], zoom: 0 });
  // Page images go in their own pane, under the frame, grid and highlights.
  view.createPane("pdf").style.zIndex = 350;
  var layers = {
    frame: L.layerGroup().addTo(view), nodes: L.layerGroup().addTo(view), auto: L.layerGroup().addTo(view),
    pins: L.layerGroup().addTo(view), hi: L.layerGroup().addTo(view), draw: L.layerGroup().addTo(view),
  };

  // Renders part of the page (display rectangle r, scale s) into a canvas.
  var renders = [];
  function renderRegion(r, s, canvas) {
    var w = Math.max(1, Math.round((r[2] - r[0]) * s)), h = Math.max(1, Math.round((r[3] - r[1]) * s));
    canvas = canvas || document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    var task = state.page.render({
      canvasContext: ctx, viewport: state.page.getViewport({ scale: s }),
      transform: [1, 0, 0, 1, -r[0] * s, -r[1] * s], background: "#ffffff",
    });
    renders.push(task);
    return task.promise.then(function () {
      renders.splice(renders.indexOf(task), 1);
      return { canvas: canvas, ctx: ctx, rect: [r[0], r[1], r[0] + w / s, r[1] + h / s], scale: s };
    }, function (err) {
      renders.splice(renders.indexOf(task), 1);
      throw err;
    });
  }
  function bounds(r) { return L.latLngBounds([-r[3], r[0]], [-r[1], r[2]]); }
  function showRender(slot, res) {
    if (state[slot]) { view.removeLayer(state[slot].overlay); if (state[slot].mask) view.removeLayer(state[slot].mask); }
    L.DomUtil.addClass(res.canvas, "px-" + slot);
    res.overlay = new CanvasOverlay(res.canvas, bounds(res.rect), { interactive: false, pane: "pdf" }).addTo(view);
    state[slot] = res;
    updateMask(slot);
  }
  // Whole page, its highlight, then the sharper render of the view and its highlight.
  function stack() {
    [state.base, state.detail].forEach(function (r) {
      if (!r) return;
      r.overlay.bringToFront();
      if (r.mask) r.mask.bringToFront();
    });
  }

  var detailTimer = null, detailSeq = 0;
  function scheduleDetail() { clearTimeout(detailTimer); detailTimer = setTimeout(renderDetail, 200); }
  function renderDetail() {
    if (!state.page || !state.base) return;
    var s = Math.pow(2, view.getZoom()) * (window.devicePixelRatio || 1), b = view.getBounds();
    var r = [Math.max(0, b.getWest()), Math.max(0, -b.getNorth()), Math.min(state.size[0], b.getEast()), Math.min(state.size[1], -b.getSouth())];
    var my = ++detailSeq;
    if (s <= state.base.scale * 1.15 || r[2] <= r[0] || r[3] <= r[1]) {
      if (state.detail) { view.removeLayer(state.detail.overlay); if (state.detail.mask) view.removeLayer(state.detail.mask); state.detail = null; }
      return;
    }
    s = Math.min(s, 16, Math.sqrt(8e6 / ((r[2] - r[0]) * (r[3] - r[1]))));
    $("px-loading").hidden = false;
    renderRegion(r, s).then(function (res) {
      if (my !== detailSeq || !state.page) return;
      showRender("detail", res);
    }).catch(function () {}).then(function () { if (my === detailSeq) $("px-loading").hidden = true; });
  }
  view.on("moveend", scheduleDetail);

  // The colour under a point (from the sharpest render that has it).
  function pixelAt(ll) {
    var x = ll.lng, y = -ll.lat;
    var src = [state.detail, state.base].filter(function (r) { return r && x >= r.rect[0] && x < r.rect[2] && y >= r.rect[1] && y < r.rect[3]; })[0];
    if (!src) return null;
    var px = Math.floor((x - src.rect[0]) * src.scale), py = Math.floor((y - src.rect[1]) * src.scale);
    var d = src.ctx.getImageData(px, py, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  // ---------- Opening ----------
  var busy = false;
  function openFile(blob, name, isSample) {
    if (busy) return;
    if (blob.size > MAX_BYTES) { status("File lebih dari " + MAX_BYTES / MB + " MB. Simpan ulang PDF dengan gambar terkompresi, atau hanya halaman petanya.", true); return; }
    busy = true;
    clearData();
    status("Membaca " + name + "…");
    var bytes;
    blob.arrayBuffer().then(function (buf) {
      bytes = new Uint8Array(buf);
      return loadPdfjs();
    }).then(function (lib) {
      // pdf.js takes ownership of the bytes it gets; keep ours for GeoPDF.
      return lib.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false }).promise;
    }).then(function (doc) {
      state.doc = doc;
      state.bytes = bytes;
      state.name = name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().slice(0, 60) || "peta";
      var sel = $("px-page");
      sel.innerHTML = "";
      for (var i = 1; i <= doc.numPages; i++) sel.insertAdjacentHTML("beforeend", '<option value="' + i + '">' + i + " dari " + doc.numPages + "</option>");
      $("px-page-wrap").hidden = doc.numPages < 2;
      track(isSample ? "ekstrak-pdf/contoh" : "ekstrak-pdf/buka", isSample ? "Ekstrak PDF: contoh" : "Ekstrak PDF: buka file");
      return openPage(1);
    }).catch(function (err) {
      if (window.console) console.error(err);
      clearData();
      status(explain(err), true);
    }).then(function () { busy = false; });
  }

  function openPage(n) {
    var doc = state.doc;
    status("Membaca isi halaman " + n + "…");
    clearPage();
    return doc.getPage(n).then(function (page) {
      state.page = page;
      state.pageNum = n;
      var vp = page.getViewport({ scale: 1 });
      state.size = [vp.width, vp.height];
      state.toDisp = vp.transform.slice();
      state.fromDisp = PG.invert(state.toDisp);
      return Promise.all([
        page.getOperatorList(), doc.getOptionalContentConfig(), page.getTextContent(),
        PG.readGeoPdf(state.bytes, page.ref).catch(function () { return null; }),
      ]);
    }).then(function (r) {
      var oc = r[1], page = state.page, view4 = page.view;
      var got = PG.extractPaths(r[0], pdfjsLib.OPS, function (p) { return oc.isVisible(p); });
      state.paths = got.paths;
      state.images = got.images;
      state.nodes = PG.findGridNodes(got.paths, view4);
      state.lattice = PG.latticeSpacing(state.nodes);
      state.geo = r[3];
      var vp = r[3] && r[3].viewports[0];
      state.frame = vp && vp.bbox ? vp.bbox : PG.findFrame(got.paths, got.images, view4, state.nodes);
      state.dpi = PG.imageDpi(got.images, state.frame);
      var text = r[2].items.map(function (i) { return i.str; }).join(" ");
      state.textItems = r[2].items;
      state.detected = PG.detectCrs(text);
      setupGeoref(vp);
      return renderBase();
    }).then(function () {
      $("px-steps").hidden = false;
      $("px-clear-wrap").hidden = false;
      $("px-placeholder").hidden = true;
      refreshAll();
      status(summaryText());
    });
  }
  $("px-page").addEventListener("change", function () {
    if (busy || !state.doc) return;
    busy = true;
    openPage(Number(this.value)).catch(function (err) { status(explain(err), true); }).then(function () { busy = false; });
  });

  function summaryText() {
    var parts = [fmt(state.paths.length) + " objek vektor", fmt(state.images.length) + " gambar"];
    if (state.dpi) parts[1] += " (" + state.dpi + " dpi)";
    if (state.nodes.length) parts.push(fmt(state.nodes.length) + " persilangan grid");
    return "Halaman " + state.pageNum + ": " + parts.join(" · ") + ".";
  }

  function renderBase() {
    var s = Math.min(3, 2400 / Math.max(state.size[0], state.size[1]));
    return renderRegion([0, 0, state.size[0], state.size[1]], s).then(function (res) {
      showRender("base", res);
      view.invalidateSize();
      view.fitBounds(bounds([0, 0, state.size[0], state.size[1]]), { padding: [8, 8] });
    });
  }

  function clearPage() {
    renders.slice().forEach(function (t) { try { t.cancel(); } catch (e) { /* already done */ } });
    detailSeq++;
    ["base", "detail"].forEach(function (k) {
      if (state[k]) { view.removeLayer(state[k].overlay); if (state[k].mask) view.removeLayer(state[k].mask); state[k] = null; }
    });
    Object.keys(layers).forEach(function (k) { layers[k].clearLayers(); });
    state.points = []; state.fit = null; state.geo = null; state.intervalTouched = false;
    state.paths = []; state.images = []; state.nodes = []; state.groups = []; state.labels = [];
    setMode(null);
    clearResults();
  }

  function clearData() {
    clearPage();
    if (state.doc) { try { state.doc.destroy(); } catch (e) { /* ignore */ } }
    resetState();
    $("px-steps").hidden = true;
    $("px-clear-wrap").hidden = true;
    $("px-placeholder").hidden = false;
    $("px-page-wrap").hidden = true;
    $("px-tab-map").disabled = true;
    showTab("pdf");
    if (worker) { worker.terminate(); worker = null; waiting = {}; }
  }
  $("px-clear").addEventListener("click", function () {
    if (busy) return;
    clearData();
    status("Data sudah dihapus dari memori browser.");
  });

  $("px-file").addEventListener("change", function () {
    var f = this.files && this.files[0];
    if (f) openFile(f, f.name, false);
    this.value = "";
  });
  var drop = $("px-drop");
  ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) {
    e.preventDefault();
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f, f.name, false);
  });
  $("px-sample").addEventListener("click", function () {
    if (busy) return;
    status("Memuat contoh…");
    fetch("data/contoh-peta.pdf").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.blob();
    }).then(function (b) {
      openFile(b, "contoh-peta.pdf", true);
    }).catch(function () { status("Contoh tidak bisa dimuat. Periksa koneksi lalu coba lagi.", true); });
  });

  // ---------- Coordinate system ----------
  var crsSel = $("px-crs");
  (function fillCrs() {
    var html = '<optgroup label="Bujur/lintang"><option value="4326">WGS 84 bujur/lintang (derajat)</option></optgroup><optgroup label="UTM WGS 84 (meter)">';
    for (var z = 46; z <= 54; z++) html += '<option value="' + PG.utmEpsg(z, true) + '">UTM zona ' + z + " S (EPSG:" + PG.utmEpsg(z, true) + ")</option>";
    for (var z2 = 46; z2 <= 54; z2++) html += '<option value="' + PG.utmEpsg(z2, false) + '">UTM zona ' + z2 + " N (EPSG:" + PG.utmEpsg(z2, false) + ")</option>";
    html += '</optgroup><optgroup label="Lainnya"><option value="3857">Web Mercator (EPSG:3857)</option><option value="other">Kode EPSG lain…</option></optgroup>';
    crsSel.innerHTML = html;
  })();

  function setupGeoref(vp) {
    var epsg = 4326, note;
    if (vp) {
      epsg = vp.epsg && PG.crs(vp.epsg) ? vp.epsg : 4326;
      var crs = PG.crs(epsg);
      state.points = vp.points.map(function (p) {
        var xy = p.lon != null ? crs.fromLonLat(p.lon, p.lat) : [p.x, p.y];
        return { px: p.px, py: p.py, x: xy[0], y: xy[1], a: "", b: "", fixed: true };
      });
      note = "<strong>PDF ini sudah berkoordinat</strong> (GeoPDF " + esc(state.geo.source) + (vp.epsg ? ", EPSG:" + vp.epsg : "") + "). Titik kontrol dibaca dari file; Anda bisa langsung ke langkah 3.";
      if (vp.epsg && !PG.crs(vp.epsg)) note += " Proyeksinya belum didukung, jadi koordinat dihitung dalam bujur/lintang (sedikit kurang teliti).";
    } else {
      var d = state.detected;
      if (d) epsg = d.epsg;
      note = "PDF ini belum berkoordinat. Beri titik kontrol di bawah." + (d ? " Keterangan di peta menyebut <strong>" + esc(d.label) + "</strong>, jadi sistem koordinat itu sudah dipilih." : "");
    }
    state.epsg = epsg;
    if (crsSel.querySelector('option[value="' + epsg + '"]')) { crsSel.value = String(epsg); $("px-epsg-wrap").hidden = true; }
    else { crsSel.value = "other"; $("px-epsg").value = String(epsg); $("px-epsg-wrap").hidden = false; }
    state.entry = PG.crs(epsg).geographic ? "lonlat" : "map";
    $("px-entry").value = state.entry;
    $("px-entry-wrap").hidden = PG.crs(epsg).geographic;
    $("px-geo-note").innerHTML = note;
  }

  function onCrsChange() {
    var v = crsSel.value, code = v === "other" ? Number($("px-epsg").value) : Number(v);
    $("px-epsg-wrap").hidden = v !== "other";
    if (v === "other" && !PG.crs(code)) {
      $("px-epsg").setCustomValidity("Kode EPSG ini belum didukung.");
      if ($("px-epsg").value) $("px-epsg").reportValidity();
      return;
    }
    $("px-epsg").setCustomValidity("");
    var wasGeo = PG.crs(state.epsg).geographic;
    state.epsg = code;
    if (PG.crs(code).geographic) state.entry = "lonlat";
    else if (wasGeo) state.entry = "map";
    $("px-entry").value = state.entry;
    $("px-entry-wrap").hidden = PG.crs(code).geographic;
    // Points typed by hand are re-read in the new system; grid points are
    // redone from them.
    state.points = state.points.filter(function (p) { return !p.auto; });
    state.intervalTouched = false;
    reparse();
  }
  crsSel.addEventListener("change", onCrsChange);
  $("px-epsg").addEventListener("change", onCrsChange);
  $("px-entry").addEventListener("change", function () { state.entry = this.value; reparse(); });

  // ---------- Control points ----------
  function parsePoint(p) {
    if (p.fixed) return;
    var crs = mapCrs();
    p.x = p.y = NaN;
    if (state.entry === "lonlat" || crs.geographic) {
      var lon = PG.parseDegrees(p.a), lat = PG.parseDegrees(p.b);
      if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) { var xy = crs.fromLonLat(lon, lat); p.x = xy[0]; p.y = xy[1]; }
    } else {
      p.x = PG.parseNumber(p.a);
      p.y = PG.parseNumber(p.b);
    }
  }
  function reparse() {
    state.points.forEach(parsePoint);
    refit();
  }
  function usable() { return state.points.filter(function (p) { return isFinite(p.x) && isFinite(p.y); }); }
  // rebuild: false keeps the point list as it is (the visitor is typing in it).
  function refit(rebuild) {
    state.fit = PG.fit(usable());
    if (rebuild === false) updatePointRows(); else renderPoints();
    renderFit();
    refreshDpi();
    refreshMinHint();
    $("px-tab-map").disabled = !state.fit;
    mapDirty = true;
    if (currentTab === "map") updateWorldMap();
  }

  function snap(pt) {
    if (!$("px-snap").checked || !state.nodes.length) return pt;
    var c = view.latLngToContainerPoint(toLatLng(pt[0], pt[1])), best = null, bd = 14;
    state.nodes.forEach(function (n) {
      var q = view.latLngToContainerPoint(toLatLng(n[0], n[1])), d = Math.hypot(q.x - c.x, q.y - c.y);
      if (d < bd) { bd = d; best = n; }
    });
    return best ? best.slice() : pt;
  }

  function addPoint(ll) {
    var pt = snap(fromLatLng(ll));
    state.points.push({ px: pt[0], py: pt[1], a: "", b: "", x: NaN, y: NaN });
    refit();
    var inputs = $("px-points").querySelectorAll('li[data-i="' + (manualPoints().length - 1) + '"] input');
    if (inputs[0]) inputs[0].focus();
  }
  function manualPoints() { return state.points.filter(function (p) { return !p.auto; }); }

  function pinIcon(n, bad) {
    return L.divIcon({ className: "px-pin" + (bad ? " px-pin-empty" : ""), html: "<span>" + n + "</span>", iconSize: [22, 22], iconAnchor: [11, 11] });
  }
  function residualText(p) {
    var used = usable(), k = used.indexOf(p);
    return state.fit && k >= 0 && used.length > 2 ? "±" + groundText(state.fit.residuals[k]) : "";
  }
  function drawPins() {
    layers.pins.clearLayers();
    layers.auto.clearLayers();
    var used = usable();
    manualPoints().forEach(function (p, i) {
      var m = L.marker(toLatLng(p.px, p.py), { icon: pinIcon(i + 1, used.indexOf(p) < 0), draggable: !p.fixed, keyboard: false }).addTo(layers.pins);
      m.on("dragend", function () {
        var q = snap(fromLatLng(m.getLatLng()));
        p.px = q[0]; p.py = q[1];
        state.points = manualPoints();
        refit();
      });
    });
    state.points.forEach(function (p) {
      if (p.auto) L.circleMarker(toLatLng(p.px, p.py), { radius: 4, color: "#fff", weight: 1, fillColor: "#e5484d", fillOpacity: 1, interactive: false }).addTo(layers.auto);
    });
  }
  function updatePointRows() {
    drawPins();
    var manual = manualPoints();
    $("px-points").querySelectorAll("li[data-i]").forEach(function (li) {
      var p = manual[Number(li.getAttribute("data-i"))], inputs = li.querySelectorAll("input");
      inputs[0].classList.toggle("bad", !!p.a && !isFinite(p.x));
      inputs[1].classList.toggle("bad", !!p.b && !isFinite(p.y));
      li.querySelector(".px-res").textContent = residualText(p);
    });
    renderGridControls();
  }
  function renderPoints() {
    drawPins();
    var crs = mapCrs(), geo = crs.geographic || state.entry === "lonlat", list = $("px-points"), html = "";
    var manual = manualPoints(), autos = state.points.filter(function (p) { return p.auto; });
    manual.forEach(function (p, i) {
      if (p.fixed) return;
      html += '<li data-i="' + i + '"><span class="px-num">' + (i + 1) + "</span>" +
        '<input aria-label="' + (geo ? "Bujur titik " : "X titik ") + (i + 1) + '" data-k="a" value="' + esc(p.a) + '" placeholder="' + (geo ? "Bujur, mis. 115°15′ BT" : "X / Timur (m)") + '" autocomplete="off" inputmode="' + (geo ? "text" : "decimal") + '"' + (isFinite(p.x) || !p.a ? "" : ' class="bad"') + ">" +
        '<input aria-label="' + (geo ? "Lintang titik " : "Y titik ") + (i + 1) + '" data-k="b" value="' + esc(p.b) + '" placeholder="' + (geo ? "Lintang, mis. 8°30′ LS" : "Y / Utara (m)") + '" autocomplete="off" inputmode="' + (geo ? "text" : "decimal") + '"' + (isFinite(p.y) || !p.b ? "" : ' class="bad"') + ">" +
        '<span class="px-res" title="Galat titik ini">' + residualText(p) + "</span>" +
        '<button type="button" class="px-del" aria-label="Hapus titik ' + (i + 1) + '">×</button></li>';
    });
    if (state.points.some(function (p) { return p.fixed; })) html = '<li class="px-auto">' + fmt(manual.length) + " titik kontrol dari GeoPDF</li>" + html;
    if (autos.length) html += '<li class="px-auto">+ ' + fmt(autos.length) + ' persilangan grid ditambahkan otomatis <button type="button" class="link-btn" id="px-drop-auto">hapus</button></li>';
    if (!manual.length) html = '<li class="px-empty">Belum ada titik. Klik peta untuk menambah.</li>';
    list.innerHTML = html;
    renderGridControls();
  }
  $("px-points").addEventListener("input", function (e) {
    var li = e.target.closest("li[data-i]");
    if (!li) return;
    var p = manualPoints()[Number(li.getAttribute("data-i"))];
    p[e.target.getAttribute("data-k")] = e.target.value;
  });
  $("px-points").addEventListener("change", function (e) {
    var li = e.target.closest("li[data-i]");
    if (!li) return;
    // Grid points were fitted to the old values: redo them from the typed ones.
    var hadAuto = state.points.some(function (p) { return p.auto; });
    if (hadAuto) state.points = manualPoints();
    parsePoint(manualPoints()[Number(li.getAttribute("data-i"))]);
    refit(hadAuto ? true : false);
  });
  $("px-points").addEventListener("click", function (e) {
    if (e.target.id === "px-drop-auto") {
      state.points = manualPoints();
      refit();
      return;
    }
    if (!e.target.classList.contains("px-del")) return;
    var i = Number(e.target.closest("li").getAttribute("data-i"));
    var p = manualPoints()[i];
    state.points = manualPoints().filter(function (q) { return q !== p; });
    refit();
  });

  // Distances in map units → words ("12 m", "1,2 km"); degrees as metres.
  function metres(v) {
    var crs = mapCrs();
    if (!crs.geographic) return v;
    var c = state.fit ? centerLonLat() : [0, 0];
    return v * 111320 * Math.sqrt(Math.cos(c[1] * Math.PI / 180));
  }
  function groundText(v) {
    var m = metres(v);
    return m >= 1000 ? fmt(m / 1000, 1) + " km" : fmt(m, m < 10 ? 1 : 0) + " m";
  }
  function centerLonLat() {
    var f = state.frame, p = PG.apply(state.fit.m, (f[0] + f[2]) / 2, (f[1] + f[3]) / 2);
    return mapCrs().toLonLat(p[0], p[1]);
  }
  // Map units per page point → metres per point on the ground.
  function groundPerPt() { return state.fit ? metres(PG.fitScale(state.fit)) : null; }

  function renderFit() {
    var f = state.fit, el = $("px-fit"), used = usable().length;
    el.className = "px-fit";
    if (!f) {
      el.innerHTML = state.points.length && used < 2 ? "Isi koordinat minimal 2 titik yang berjauhan." :
        used >= 2 ? "Titik-titik ini segaris atau bertumpuk. Pilih titik lain yang berjauhan." : "";
      if (used >= 2) el.className = "px-fit warn";
      return;
    }
    var g = groundPerPt(), scale = g / (MM_PER_PT / 1000);
    var txt = "<strong>Georeferensi siap</strong>: " + fmt(used) + " titik, ";
    if (f.kind === "similarity") txt += "skala dan rotasi dari 2 titik (galat belum bisa diperiksa; tambah titik atau lengkapi dari grid).";
    else {
      var sheet = f.rmse / PG.fitScale(f) * MM_PER_PT;
      txt += "galat rata-rata (RMSE) " + groundText(f.rmse) + " ≈ " + fmt(sheet, sheet < 0.1 ? 2 : 1) + " mm di kertas.";
      if (sheet > 1) {
        el.className = "px-fit warn";
        var worst = f.residuals.indexOf(Math.max.apply(null, f.residuals)), wp = usable()[worst], mi = manualPoints().indexOf(wp);
        txt += " Galatnya besar: periksa " + (mi >= 0 ? "titik " + (mi + 1) : "titik grid otomatis") + " (koordinat salah ketik, atau sistem koordinat tidak cocok).";
      }
    }
    txt += " Skala peta ±1 : " + fmt(Math.round(scale / 100) * 100) + ".";
    if (!el.classList.contains("warn")) el.className = "px-fit ok";
    el.innerHTML = txt;
  }

  // "Complete from grid": the grid spacing in map units, guessed from the
  // crosses found in the PDF and the current fit.
  function renderGridControls() {
    var box = $("px-grid"), can = !!state.fit && state.nodes.length >= 3 && state.lattice;
    box.hidden = !can;
    $("px-snap-wrap").hidden = !state.nodes.length || !!state.geo;
    $("px-node-count").textContent = fmt(state.nodes.length);
    if (!can) return;
    var geo = mapCrs().geographic;
    if (!state.intervalTouched) {
      var guess = PG.niceInterval(Math.min(state.lattice.x, state.lattice.y) * PG.fitScale(state.fit), geo);
      $("px-interval").value = guess ? String(Number(guess.toPrecision(6))) : "";
    }
    box.querySelector("label").firstChild.textContent = "Jarak grid (" + (geo ? "derajat" : "meter") + ") ";
  }
  $("px-interval").addEventListener("input", function () { state.intervalTouched = true; });
  $("px-complete").addEventListener("click", function () {
    var s = $("px-interval").value, iv = mapCrs().geographic ? Number(s.replace(",", ".")) : PG.parseNumber(s);
    if (!(iv > 0)) { status("Isi jarak grid dulu (selisih koordinat dua garis grid yang bersebelahan).", true); return; }
    var res = PG.completeGrid(usable(), state.nodes, iv);
    if (!res.added) { status("Tidak ada persilangan grid yang cocok dengan jarak " + s + ". Periksa jarak grid dan koordinat titik.", true); return; }
    var bad = state.points.filter(function (p) { return !p.auto && !(isFinite(p.x) && isFinite(p.y)); });
    state.points = res.points.concat(bad);
    status(fmt(res.added) + " persilangan grid ditambahkan sebagai titik kontrol.");
    refit();
  });
  $("px-snap").addEventListener("change", drawNodes);
  function drawNodes() {
    layers.nodes.clearLayers();
    if (!$("px-snap").checked || state.nodes.length > 3000 || state.geo) return;
    state.nodes.forEach(function (n) {
      L.circleMarker(toLatLng(n[0], n[1]), { radius: 6, color: "#0f5e4b", weight: 1.5, fill: false, interactive: false }).addTo(layers.nodes);
    });
  }
  function drawFrame() {
    layers.frame.clearLayers();
    if (!state.frame) return;
    L.rectangle(bounds(dispRect(state.frame)), { color: "#0f5e4b", weight: 2, dashArray: "6 6", fill: false, interactive: false }).addTo(layers.frame);
  }

  // ---------- Modes (what a click on the PDF does) ----------
  function setMode(mode, data) {
    state.mode = mode ? { type: mode, data: data, first: null } : null;
    layers.draw.clearLayers();
    var bar = $("px-mode"), text = "";
    if (mode === "pick") text = "Klik warna untuk kelas «" + data.name + "». Bisa berkali-kali; geser dan perbesar peta seperti biasa.";
    else if (mode === "ramp") text = "Klik ujung awal batang gradasi legenda untuk kelas «" + data.name + "».";
    else if (mode === "frame") text = "Seret kotak di sekeliling area peta (tanpa legenda).";
    bar.hidden = !mode;
    $("px-mode-text").textContent = text;
    $("px-view").classList.toggle("px-picking", mode === "pick" || mode === "ramp" || mode === "frame");
    if (mode === "frame") view.dragging.disable(); else view.dragging.enable();
    renderClasses();
  }
  $("px-mode-done").addEventListener("click", function () { setMode(null); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && state.mode) setMode(null); });

  view.on("click", function (e) {
    if (!state.page || busy) return;
    var m = state.mode;
    if (!m) { if (!state.geo) addPoint(e.latlng); return; }
    if (m.type === "pick") {
      var c = pixelAt(e.latlng);
      if (c) addColors(m.data, [c]);
    } else if (m.type === "ramp") {
      if (!m.first) {
        m.first = e.latlng;
        L.circleMarker(e.latlng, { radius: 4, color: "#e5484d", interactive: false }).addTo(layers.draw);
        $("px-mode-text").textContent = "Sekarang klik ujung akhir batang gradasi.";
        return;
      }
      var cols = [], a = m.first, b = e.latlng;
      for (var i = 0; i <= 32; i++) {
        var t = i / 32, px = pixelAt(L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t));
        if (px) cols.push(px);
      }
      addColors(m.data, cols);
      setMode(null);
    }
  });

  // Frame drawing.
  var frameStart = null;
  view.on("mousedown", function (e) {
    if (!state.mode || state.mode.type !== "frame") return;
    frameStart = e.latlng;
  });
  view.on("mousemove", function (e) {
    if (!frameStart) return;
    layers.draw.clearLayers();
    L.rectangle(L.latLngBounds(frameStart, e.latlng), { color: "#e5484d", weight: 2, fill: false, interactive: false }).addTo(layers.draw);
  });
  view.on("mouseup", function (e) {
    if (!frameStart) return;
    var a = fromLatLng(frameStart), b = fromLatLng(e.latlng);
    frameStart = null;
    var f = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    if (f[2] - f[0] < 5 || f[3] - f[1] < 5) return;
    var v = state.page.view;
    state.frame = [Math.max(f[0], v[0]), Math.max(f[1], v[1]), Math.min(f[2], v[2]), Math.min(f[3], v[3])];
    setMode(null);
    refreshAll();
  });
  $("px-frame-btn").addEventListener("click", function () { if (state.page) setMode("frame"); });

  // ---------- Vector layers ----------
  function describe(g) {
    var w = fmt(g.width, 2) + " pt";
    if (g.kind === "fill") return "Area " + g.fill;
    if (g.kind === "both") return "Area " + g.fill + " bergaris " + g.stroke;
    return "Garis " + g.stroke + " " + w + (g.dash ? " putus-putus" : "");
  }
  function swatch(g) {
    var dash = g.dash ? ' stroke-dasharray="4 3"' : "", sw = Math.max(1, Math.min(4, g.width * 2));
    if (g.kind === "stroke") return '<svg width="30" height="14" aria-hidden="true"><path d="M1 10 C8 2 14 14 29 4" fill="none" stroke="' + g.stroke + '" stroke-width="' + sw + '"' + dash + "/></svg>";
    return '<svg width="30" height="14" aria-hidden="true"><rect x="1" y="1" width="28" height="12" rx="2" fill="' + g.fill + '" stroke="' + (g.stroke || "#d0d5dd") + '" stroke-width="' + (g.stroke ? Math.min(3, sw) : 1) + '"' + dash + "/></svg>";
  }
  function refreshGroups() {
    var old = {};
    state.groups.forEach(function (g) { old[g.key] = g; });
    state.groups = PG.groupPaths(state.paths, state.frame).map(function (g) {
      var o = old[g.key];
      g.name = o ? o.name : describe(g);
      g.on = o ? o.on : false;
      return g;
    });
    var html = state.groups.map(function (g, i) {
      return '<li data-i="' + i + '"><label class="px-g-check"><input type="checkbox"' + (g.on ? " checked" : "") + ' aria-label="Ekstrak lapisan ' + esc(g.name) + '">' + swatch(g) + "</label>" +
        '<input class="px-g-name" value="' + esc(g.name) + '" aria-label="Nama lapisan" autocomplete="off">' +
        '<span class="px-g-n" title="Jumlah objek">' + fmt(g.items.length) + "</span></li>";
    }).join("");
    $("px-groups").innerHTML = html || '<li class="px-empty">Tidak ada objek vektor di area peta; data peta ini tersimpan sebagai gambar. Pakai <em>Warna legenda → poligon</em>.</li>';
    $("px-vec-count").textContent = state.groups.length ? fmt(state.groups.length) + " lapisan" : "";
  }
  $("px-groups").addEventListener("change", function (e) {
    var li = e.target.closest("li[data-i]");
    if (!li) return;
    var g = state.groups[Number(li.getAttribute("data-i"))];
    if (e.target.type === "checkbox") g.on = e.target.checked;
    else g.name = e.target.value.trim() || describe(g);
  });
  function highlight(g) {
    layers.hi.clearLayers();
    if (!g) return;
    var lines = [], budget = 40000;
    g.items.some(function (idx) {
      state.paths[idx].parts.forEach(function (part) {
        var l = [];
        for (var i = 0; i < part.pts.length; i += 2) l.push(toLatLng(part.pts[i], part.pts[i + 1]));
        if (part.closed && l.length > 2) l.push(l[0]);
        budget -= l.length;
        lines.push(l);
      });
      return budget < 0;
    });
    L.polyline(lines, { color: "#ff00d4", weight: 3, opacity: 0.9, interactive: false }).addTo(layers.hi);
  }
  ["mouseover", "focusin"].forEach(function (t) {
    $("px-groups").addEventListener(t, function (e) {
      var li = e.target.closest("li[data-i]");
      highlight(li ? state.groups[Number(li.getAttribute("data-i"))] : null);
    });
  });
  $("px-groups").addEventListener("mouseleave", function () { highlight(null); });
  $("px-all").addEventListener("click", function () { state.groups.forEach(function (g) { g.on = true; }); refreshGroups(); });
  $("px-none").addEventListener("click", function () { state.groups.forEach(function (g) { g.on = false; }); refreshGroups(); });

  function refreshLabels() {
    state.labels = PG.textLabels(state.textItems || [], state.frame);
    $("px-label-count").textContent = fmt(state.labels.length);
    $("px-labels").disabled = !state.labels.length;
    if (!state.labels.length) $("px-labels").checked = false;
  }

  // ---------- Colour classes ----------
  var CLASS_NAMES = ["Rendah", "Sedang", "Tinggi"];
  function renderClasses() {
    var html = state.classes.map(function (c, i) {
      var picking = state.mode && state.mode.data === c;
      return '<li data-i="' + i + '"' + (picking ? ' class="active"' : "") + ">" +
        '<input class="px-c-name" value="' + esc(c.name) + '" aria-label="Nama kelas" autocomplete="off">' +
        '<div class="px-chips">' + (c.colors.length ? c.colors.map(function (rgb, k) {
          var h = PG.hex(rgb);
          return '<button type="button" class="px-chip" data-k="' + k + '" style="background:' + h + '" title="' + h + ' (klik untuk hapus)" aria-label="Hapus warna ' + h + '"></button>';
        }).join("") : '<span class="hint">Belum ada warna</span>') + "</div>" +
        '<div class="px-c-actions"><button type="button" class="link-btn" data-act="pick">' + (picking && state.mode.type === "pick" ? "Selesai" : "Ambil warna") + "</button>" +
        '<button type="button" class="link-btn" data-act="ramp">Ambil gradasi</button>' +
        '<button type="button" class="link-btn px-danger" data-act="del">Hapus kelas</button></div></li>';
    }).join("");
    $("px-classes").innerHTML = html;
  }
  $("px-add-class").addEventListener("click", function () {
    var c = { name: CLASS_NAMES[state.classes.length] || "Kelas " + (state.classes.length + 1), colors: [] };
    state.classes.push(c);
    $("px-sec-cls").open = true;
    setMode("pick", c);
  });
  $("px-classes").addEventListener("click", function (e) {
    var li = e.target.closest("li[data-i]");
    if (!li) return;
    var c = state.classes[Number(li.getAttribute("data-i"))];
    if (e.target.classList.contains("px-chip")) {
      c.colors.splice(Number(e.target.getAttribute("data-k")), 1);
      renderClasses();
      colorsChanged();
      return;
    }
    var act = e.target.getAttribute("data-act");
    if (act === "pick") setMode(state.mode && state.mode.data === c && state.mode.type === "pick" ? null : "pick", c);
    else if (act === "ramp") setMode("ramp", c);
    else if (act === "del") {
      state.classes.splice(state.classes.indexOf(c), 1);
      if (state.mode && state.mode.data === c) setMode(null); else renderClasses();
      colorsChanged();
    }
  });
  $("px-classes").addEventListener("change", function (e) {
    var li = e.target.closest("li[data-i]");
    if (li && e.target.classList.contains("px-c-name")) state.classes[Number(li.getAttribute("data-i"))].name = e.target.value.trim() || "Kelas " + (Number(li.getAttribute("data-i")) + 1);
  });
  function addColors(c, cols) {
    var labs = c.colors.map(function (rgb) { return PG.rgbToLab(rgb[0], rgb[1], rgb[2]); });
    cols.forEach(function (rgb) {
      var lab = PG.rgbToLab(rgb[0], rgb[1], rgb[2]);
      if (labs.some(function (l) { return Math.hypot(l[0] - lab[0], l[1] - lab[1], l[2] - lab[2]) < 2; })) return;
      if (c.colors.length >= 48) return;
      labs.push(lab);
      c.colors.push(rgb);
    });
    renderClasses();
    colorsChanged();
  }

  // Highlight: dims everything that would not become a polygon, with the
  // same clean-up as the extraction (at the resolution on screen).
  var lutTimer = null;
  function tolerance() { return Number($("px-tol").value); }
  function colorsChanged() {
    $("px-tol-val").textContent = "ΔE " + tolerance();
    clearTimeout(lutTimer);
    lutTimer = setTimeout(function () {
      var cls = state.classes.filter(function (c) { return c.colors.length; });
      state.lut = cls.length ? PG.colorTable(cls, tolerance()) : null;
      updateMask("base");
      updateMask("detail");
    }, 150);
  }
  function cleanParams(scale) {
    var thinPx = Number($("px-thin").value) / MM_PER_PT * scale;
    var minPx = Number($("px-min").value) / (MM_PER_PT * MM_PER_PT) * scale * scale;
    return { thin: thinPx >= 1.5 ? Math.max(1, Math.round(thinPx / 2)) : 0, minPixels: Math.round(minPx) };
  }
  function updateMask(slot) {
    var r = state[slot];
    if (!r) return;
    if (r.mask) { view.removeLayer(r.mask); r.mask = null; }
    if (!state.lut || !$("px-highlight").checked) { stack(); return; }
    var w = r.canvas.width, h = r.canvas.height, img = r.ctx.getImageData(0, 0, w, h);
    var cls = PG.classify(img.data, state.lut), n = state.classes.filter(function (c) { return c.colors.length; }).length, p = cleanParams(r.scale);
    PG.removeThin(cls, w, h, p.thin, n);
    PG.sieve(cls, w, h, p.minPixels);
    var mask = document.createElement("canvas");
    mask.width = w; mask.height = h;
    var mctx = mask.getContext("2d"), out = mctx.createImageData(w, h), d = out.data;
    for (var i = 0, j = 0; i < cls.length; i++, j += 4) {
      if (cls[i]) continue;
      d[j] = d[j + 1] = d[j + 2] = 255; d[j + 3] = 190;
    }
    mctx.putImageData(out, 0, 0);
    r.mask = new CanvasOverlay(mask, bounds(r.rect), { interactive: false, pane: "pdf" }).addTo(view);
    stack();
  }
  $("px-tol").addEventListener("input", colorsChanged);
  ["px-thin", "px-min", "px-highlight"].forEach(function (id) {
    $(id).addEventListener("change", function () { updateMask("base"); updateMask("detail"); refreshMinHint(); });
  });
  function refreshMinHint() {
    var g = groundPerPt(), mm2 = Number($("px-min").value);
    if (!g || !mm2) { $("px-min-hint").textContent = ""; return; }
    var m2 = mm2 / (MM_PER_PT * MM_PER_PT) * g * g;
    $("px-min-hint").textContent = "≈ " + (m2 >= 10000 ? fmt(m2 / 10000, 1) + " ha" : fmt(m2) + " m²") + " di lapangan.";
  }

  // ---------- Resolution ----------
  function pixelLimit() {
    var mem = navigator.deviceMemory, mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || "");
    var lim = mem && mem <= 2 ? 15e6 : mem && mem <= 4 ? 30e6 : 60e6;
    return mobile ? Math.min(lim, 25e6) : lim;
  }
  function sizeAt(dpi) {
    var r = dispRect(state.frame), s = dpi / 72;
    return [Math.max(1, Math.round((r[2] - r[0]) * s)), Math.max(1, Math.round((r[3] - r[1]) * s))];
  }
  function refreshDpi() {
    if (!state.frame) return;
    var sel = $("px-dpi"), prev = Number(sel.value), list = [72, 100, 150, 200, 300, 400], lim = pixelLimit();
    if (state.dpi && list.indexOf(state.dpi) < 0) list.push(state.dpi);
    list.sort(function (a, b) { return a - b; });
    var want = state.dpi || 150, best = null;
    sel.innerHTML = list.map(function (d) {
      var sz = sizeAt(d), ok = sz[0] * sz[1] <= lim && sz[0] <= 16384 && sz[1] <= 16384;
      // The PDF's own resolution, else the largest that fits below it.
      if (ok && (best == null || d <= want)) best = d;
      return '<option value="' + d + '"' + (ok ? "" : " disabled") + ">" + d + " dpi" + (d === state.dpi ? " (sama dengan gambar di PDF)" : "") + (ok ? "" : " (terlalu besar)") + "</option>";
    }).join("");
    var keep = list.indexOf(prev) >= 0 && !sel.querySelector('option[value="' + prev + '"]').disabled;
    sel.value = String(keep ? prev : best || 72);
    dpiHint();
  }
  function dpiHint() {
    var d = Number($("px-dpi").value), sz = sizeAt(d), g = groundPerPt();
    $("px-dpi-hint").textContent = fmt(sz[0]) + " × " + fmt(sz[1]) + " piksel" + (g ? " · 1 piksel ≈ " + groundText(PG.fitScale(state.fit) * 72 / d) : "") + ". Dipakai untuk GeoTIFF dan poligon warna.";
  }
  $("px-dpi").addEventListener("change", dpiHint);

  function refreshAll() {
    drawFrame();
    drawNodes();
    refreshGroups();
    refreshLabels();
    renderPoints();
    renderFit();
    renderClasses();
    colorsChanged();
    refreshDpi();
    refreshMinHint();
    $("px-tab-map").disabled = !state.fit;
    mapDirty = true;
  }

  // ---------- World map (checking the georeferencing and the results) ----------
  var currentTab = "pdf", world = null, worldBase = null, worldPdf = null, worldResults = null, mapDirty = true;
  var BASEMAPS = {
    osm: function () {
      return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 22, maxNativeZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
    },
    imagery: function () {
      return L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 22, maxNativeZoom: 19, attribution: "Citra &copy; Esri, Maxar, Earthstar Geographics" });
    },
  };
  function setBasemap(name) {
    if (worldBase) world.removeLayer(worldBase);
    worldBase = BASEMAPS[name] ? BASEMAPS[name]().addTo(world) : null;
  }
  function showTab(name) {
    currentTab = name;
    $("px-tab-pdf").setAttribute("aria-selected", String(name === "pdf"));
    $("px-tab-map").setAttribute("aria-selected", String(name === "map"));
    $("px-view").hidden = name !== "pdf";
    $("px-map").hidden = name !== "map";
    $("px-map-opts").hidden = name !== "map";
    if (name === "pdf") { view.invalidateSize(); return; }
    if (!world) {
      world = L.map("px-map", { center: [-2.5, 118], zoom: 4, maxZoom: 22, zoomSnap: 0.5 });
      setBasemap($("px-basemap").value);
    }
    world.invalidateSize();
    updateWorldMap();
  }
  $("px-tab-pdf").addEventListener("click", function () { showTab("pdf"); });
  $("px-tab-map").addEventListener("click", function () { if (state.fit) showTab("map"); });
  $("px-basemap").addEventListener("change", function () { if (world) setBasemap(this.value); });
  $("px-opacity").addEventListener("input", function () { if (worldPdf) worldPdf.setOpacity(this.value / 100); });

  // The base render of the map area, warped onto Web Mercator.
  function updateWorldMap() {
    if (!world || !mapDirty || !state.fit || !state.base) return;
    mapDirty = false;
    if (worldPdf) { world.removeLayer(worldPdf); worldPdf = null; }
    var b = state.base, r = dispRect(state.frame);
    var c0 = Math.max(0, Math.floor((r[0] - b.rect[0]) * b.scale)), r0 = Math.max(0, Math.floor((r[1] - b.rect[1]) * b.scale));
    var c1 = Math.min(b.canvas.width, Math.ceil((r[2] - b.rect[0]) * b.scale)), r1 = Math.min(b.canvas.height, Math.ceil((r[3] - b.rect[1]) * b.scale));
    if (c1 <= c0 || r1 <= r0) return;
    var t = pixelTransform(b.rect[0] + c0 / b.scale, b.rect[1] + r0 / b.scale, b.scale);
    var grid = { width: c1 - c0, height: r1 - r0, transform: t };
    try {
      var lookup = GT.mercatorLookup(grid, mapCrs(), 2048);
      var src = b.ctx.getImageData(c0, r0, c1 - c0, r1 - r0).data;
      var canvas = document.createElement("canvas");
      canvas.width = lookup.width; canvas.height = lookup.height;
      var ctx = canvas.getContext("2d"), out = ctx.createImageData(lookup.width, lookup.height);
      GT.project(lookup, src, out.data);
      ctx.putImageData(out, 0, 0);
      worldPdf = new CanvasOverlay(canvas, lookup.bounds, { opacity: $("px-opacity").value / 100, interactive: false }).addTo(world);
      if (worldResults) worldResults.bringToFront();
      world.fitBounds(lookup.bounds);
    } catch (e) {
      status("Koordinat hasil georeferensi berada di luar bumi. Periksa sistem koordinat dan koordinat titik.", true);
    }
  }
  // GDAL geotransform for pixels of a render whose top-left corner is at
  // display (x0, y0) with s pixels per point: pixel → display → page → map.
  function pixelTransform(x0, y0, s) {
    var m = PG.concat(PG.concat([1 / s, 0, 0, 1 / s, x0, y0], state.fromDisp), state.fit.m);
    return [m[4], m[0], m[2], m[5], m[1], m[3]];
  }

  // ---------- Extraction ----------
  function clearResults() {
    state.urls.forEach(function (u) { URL.revokeObjectURL(u); });
    state.urls = [];
    $("px-downloads").innerHTML = "";
    $("px-results").hidden = true;
    if (worldResults && world) { world.removeLayer(worldResults); worldResults = null; }
  }
  function addResult(blob, filename, what) {
    var url = URL.createObjectURL(blob);
    state.urls.push(url);
    $("px-downloads").insertAdjacentHTML("beforeend", '<li><a class="btn btn-email" href="' + url + '" download="' + esc(filename) + '">' + esc(filename) + "</a><span>" + esc(what) + " · " + mb(blob.size) + "</span></li>");
    $("px-results").hidden = false;
  }
  function writeVector(features, name, format) {
    var data = GC.fromGeoJSON({ type: "FeatureCollection", features: features });
    return GC.write(data, format, name).then(function (out) {
      return { blob: new Blob(out.parts, { type: out.mime }), filename: out.filename };
    });
  }

  $("px-run").addEventListener("click", function () {
    if (busy || !state.page) return;
    if (!state.fit) { status("Beri koordinat dulu (langkah 2): minimal 2 titik kontrol.", true); return; }
    var groups = state.groups.filter(function (g) { return g.on; }), labels = $("px-labels").checked ? state.labels : [];
    var classes = state.classes.filter(function (c) { return c.colors.length; }), raster = $("px-raster").checked;
    if (!groups.length && !labels.length && !classes.length && !raster) {
      status("Pilih dulu yang akan diekstrak: lapisan vektor, teks, kelas warna, atau GeoTIFF.", true);
      return;
    }
    busy = true;
    setMode(null);
    clearResults();
    $("px-run").disabled = true;
    var crs = mapCrs(), toLL = PG.projector(state.fit.m, crs), format = $("px-format").value, name = state.name, shown = [];
    var job = Promise.resolve();
    if (groups.length || labels.length) {
      job = job.then(function () {
        status("Mengambil vektor…");
        var feats = PG.pathFeatures(state.paths, groups, state.frame, toLL);
        labels.forEach(function (l) {
          feats.push({ type: "Feature", properties: { teks: l.text, ukuran_pt: l.size, sudut: l.angle }, geometry: { type: "Point", coordinates: toLL(l.x, l.y) } });
        });
        if (!feats.length) return;
        shown = shown.concat(feats);
        return writeVector(feats, name + "_vektor", format).then(function (r) { addResult(r.blob, r.filename, fmt(feats.length) + " fitur vektor"); });
      });
    }
    if (classes.length || raster) job = job.then(function () { return rasterJob(classes, raster, format, name, shown); });
    job.then(function () {
      status("Selesai. Unduh hasilnya di bawah peta, dan periksa di tab Periksa di peta dunia.");
      track("ekstrak-pdf/ekstrak", "Ekstrak PDF: ekstrak data");
      showResults(shown);
    }).catch(function (err) {
      if (window.console) console.error(err);
      status(explain(err), true);
    }).then(function () {
      busy = false;
      $("px-run").disabled = false;
    });
  });

  // Renders the map area in bands at the chosen resolution and hands them
  // to the worker, which writes the GeoTIFF and the colour classes.
  function rasterJob(classes, raster, format, name, shown) {
    var dpi = Number($("px-dpi").value), s = dpi / 72, r = dispRect(state.frame), size = sizeAt(dpi), W = size[0], H = size[1];
    var t = pixelTransform(r[0], r[1], s), p = cleanParams(s);
    var bandRows = Math.max(1, Math.min(H, 2048, Math.floor(8e6 / W)));
    var canvas = document.createElement("canvas");
    return ask("start", { options: {
      width: W, height: H, transform: t, epsg: state.epsg, raster: raster, tolerance: tolerance(),
      classes: classes.map(function (c, i) { return { name: c.name, value: i + 1, colors: c.colors }; }),
      thin: p.thin, minPixels: p.minPixels, simplify: 0.75,
    } }).then(function () {
      var row = 0;
      function next() {
        if (row >= H) return Promise.resolve();
        var rows = Math.min(bandRows, H - row);
        status("Merender peta… " + Math.round(row / H * 100) + "%");
        return renderRegion([r[0], r[1] + row / s, r[0] + W / s, r[1] + (row + rows) / s], s, canvas).then(function (res) {
          // Rounding can make the band a pixel off: take exactly W × rows.
          var img = res.ctx.getImageData(0, 0, W, rows);
          row += rows;
          return ask("rows", { buffer: img.data.buffer }, [img.data.buffer]);
        }).then(next);
      }
      return next();
    }).then(function () {
      status(classes.length ? "Menelusuri batas kelas warna…" : "Menyimpan GeoTIFF…");
      return ask("finish");
    }).then(function (out) {
      var jobs = [];
      if (out.raster) addResult(out.raster, name + "_peta.tif", "GeoTIFF " + fmt(W) + " × " + fmt(H) + ", EPSG:" + state.epsg);
      if (out.classRaster) addResult(out.classRaster, name + "_kelas.tif", "GeoTIFF kelas (1 = " + classes[0].name + (classes.length > 1 ? ", …" : "") + ")");
      if (out.features && out.features.length) {
        out.features.forEach(function (f) { shown.push(f); });
        jobs.push(writeVector(out.features, name + "_kelas", format).then(function (res) {
          addResult(res.blob, res.filename, fmt(out.features.length) + " kelas sebagai poligon");
        }));
      } else if (classes.length) {
        jobs.push(Promise.resolve().then(function () { status("Tidak ada piksel yang cocok dengan warna kelas. Naikkan toleransi atau ambil warna lagi.", true); }));
      }
      return Promise.all(jobs);
    });
  }

  function showResults(features) {
    if (!features.length) return;
    if (!world) { mapDirty = true; }
    var layer = L.geoJSON({ type: "FeatureCollection", features: features }, {
      style: function (f) {
        var p = f.properties, line = /Line/.test(f.geometry.type);
        return { color: p.warna_grs || p.warna || p.warna_isi || "#e5484d", weight: line ? 2 : 1, fillColor: p.warna || p.warna_isi || "#e5484d", fillOpacity: line ? 0 : 0.55 };
      },
      pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 4, color: "#101828", weight: 1, fillColor: "#fff", fillOpacity: 1 }); },
      onEachFeature: function (f, l) {
        var p = f.properties, t = p.teks || p.kelas || p.lapisan;
        if (t) l.bindTooltip(esc(t), { sticky: true });
      },
    });
    var add = function () {
      if (worldResults) world.removeLayer(worldResults);
      worldResults = layer.addTo(world);
    };
    if (world) add();
    else {
      // Created on first visit to the tab.
      var once = function () { add(); $("px-tab-map").removeEventListener("click", once); };
      $("px-tab-map").addEventListener("click", once);
    }
  }
})();
