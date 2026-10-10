// Admin: the "Visitors" panel. Visits are counted by GoatCounter's count.js
// (in the <head> of each public page); this reads them back through its API with a read-only
// API key that the admin pastes once. The key is kept on this device only and
// is only ever sent to <code>.goatcounter.com.
(function () {
  "use strict";

  var KEY = "geosai-goatcounter-key";
  var NO_COUNT = "skipgc"; // count.js skips counting while this is "t"
  var DAYS = 30;
  var $ = function (id) { return document.getElementById(id); };
  var code = ((window.SITE || {}).analytics || {}).goatcounter || "";
  var shown = null; // the days in the chart, to redraw it on resize

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function store(name, value) {
    try {
      if (value == null) localStorage.removeItem(name);
      else localStorage.setItem(name, value);
    } catch (e) { /* private mode: nothing persists */ }
  }
  function read(name) {
    try { return localStorage.getItem(name); } catch (e) { return null; }
  }

  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function daysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    return ymd(d);
  }
  function num(n) { return Number(n || 0).toLocaleString("en-US"); }

  function api(path) {
    return fetch("https://" + code + ".goatcounter.com/api/v0" + path, {
      headers: { Authorization: "Bearer " + read(KEY), "Content-Type": "application/json" },
      cache: "no-store",
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.ok) return data;
        var err = new Error(data.error || "Request failed (HTTP " + r.status + ")");
        err.status = r.status;
        throw err;
      });
    });
  }

  function show(part) {
    ["setup", "key", "stats"].forEach(function (p) { $("visitors-" + p).hidden = p !== part; });
  }
  function status(text) {
    $("visitors-status").textContent = text;
    $("visitors-status").hidden = !text;
  }

  // ---------- Drawing ----------
  // A day-by-day map of visitors, oldest first, with zero for days without any.
  function byDay(stats, from, days) {
    var counts = {};
    (stats || []).forEach(function (s) { counts[s.day] = (counts[s.day] || 0) + (s.daily || 0); });
    var out = [];
    for (var i = from + days - 1; i >= from; i--) {
      var day = daysAgo(i);
      out.push({ day: day, count: counts[day] || 0 });
    }
    return out;
  }
  function sum(list) { return list.reduce(function (a, d) { return a + d.count; }, 0); }

  function change(now, before) {
    if (!before) return now ? '<span class="delta up">new</span>' : "";
    var pct = Math.round((now - before) / before * 100);
    var cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
    return '<span class="delta ' + cls + '">' + (pct > 0 ? "+" : "") + pct + "%</span>";
  }

  function tiles(stats) {
    var last = byDay(stats, 0, DAYS), prev = byDay(stats, DAYS, DAYS);
    var week = sum(last.slice(-7)), weekBefore = sum(last.slice(-14, -7));
    var month = sum(last), monthBefore = sum(prev);
    var t = [
      ["Today", num(last[last.length - 1].count), "Yesterday: " + num(last[last.length - 2].count)],
      ["Last 7 days", num(week), change(week, weekBefore) + " vs the 7 days before"],
      ["Last 30 days", num(month), change(month, monthBefore) + " vs the 30 days before"],
    ];
    $("visitors-tiles").innerHTML = t.map(function (x) {
      return '<div class="stat"><span class="stat-label">' + x[0] + '</span><strong class="stat-value">' + x[1] + '</strong><span class="stat-note">' + x[2] + "</span></div>";
    }).join("");
    return last;
  }

  // Bars for the last 30 days. Plain SVG, one series, so no legend: the
  // heading names it. Each bar has a <title> for hover and screen readers.
  function chart(days) {
    // Drawn at the container's real width so the labels stay 11px on phones.
    var W = $("visitors-chart").clientWidth || 720, H = 200, top = 12, bottom = 22, left = 32;
    shown = days;
    var max = Math.max.apply(null, days.map(function (d) { return d.count; }));
    var step = niceStep(max), ceil = Math.max(step, Math.ceil(max / step) * step);
    var plotH = H - top - bottom, slot = (W - left) / days.length, bw = Math.max(4, slot - 4);
    var y = function (v) { return top + plotH - v / ceil * plotH; };
    var svg = "";
    for (var v = 0; v <= ceil; v += step) {
      svg += '<line class="grid" x1="' + left + '" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
        '<text class="tick" x="' + (left - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + num(v) + "</text>";
    }
    days.forEach(function (d, i) {
      var x = left + i * slot + (slot - bw) / 2, h = Math.max(0, y(0) - y(d.count));
      var label = new Date(d.day + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
      // Wide transparent hit area, so thin bars are easy to hover.
      svg += '<g class="bar"><title>' + esc(label) + ": " + num(d.count) + " visitor" + (d.count === 1 ? "" : "s") + "</title>" +
        '<rect class="hit" x="' + (left + i * slot) + '" y="' + top + '" width="' + slot + '" height="' + plotH + '"/>' +
        (h ? '<path class="mark" d="' + roundTop(x, y(0), bw, h) + '"/>' : "") + "</g>";
      if (i % 7 === days.length % 7 || i === days.length - 1) {
        var last = i === days.length - 1;
        svg += '<text class="tick" x="' + (last ? x + bw : x + bw / 2) + '" y="' + (H - 6) + '" text-anchor="' + (last ? "end" : "middle") + '">' +
          esc(last ? "Today" : new Date(d.day + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })) + "</text>";
      }
    });
    $("visitors-chart").innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Visitors per day, last ' + DAYS + ' days">' + svg + "</svg>";
  }
  function niceStep(max) {
    if (max <= 4) return 1;
    var raw = max / 4, pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / pow;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
  }
  // A bar with 4px rounded top corners, square at the baseline.
  function roundTop(x, base, w, h) {
    var r = Math.min(4, w / 2, h);
    return "M" + x + "," + base + "V" + (base - h + r) + "Q" + x + "," + (base - h) + " " + (x + r) + "," + (base - h) +
      "H" + (x + w - r) + "Q" + (x + w) + "," + (base - h) + " " + (x + w) + "," + (base - h + r) + "V" + base + "Z";
  }

  function list(el, rows, empty) {
    var max = rows.reduce(function (a, r) { return Math.max(a, r.count); }, 0);
    el.innerHTML = rows.length ? rows.map(function (r) {
      return '<li><span class="top-name" title="' + esc(r.name) + '">' + esc(r.name) + '</span><span class="top-count">' + num(r.count) + "</span>" +
        '<span class="top-bar" style="width:' + (max ? r.count / max * 100 : 0) + '%"></span></li>';
    }).join("") : '<li class="top-empty">' + empty + "</li>";
  }

  // ---------- Loading ----------
  function load() {
    if (!code) return show("setup");
    if (!read(KEY)) return show("key");
    show("stats");
    status("Loading…");
    var start = "?start=" + daysAgo(DAYS * 2 - 1);
    var recent = "?start=" + daysAgo(DAYS - 1) + "&limit=8";
    Promise.all([
      api("/stats/total" + start),
      api("/stats/hits" + recent),
      api("/stats/toprefs" + recent),
    ]).then(function (res) {
      var days = tiles(res[0].stats);
      chart(days);
      list($("visitors-pages"), (res[1].hits || []).map(function (h) {
        return { name: pageName(h.path), count: h.count };
      }), "No visits yet.");
      list($("visitors-refs"), (res[2].stats || []).map(function (s) {
        return { name: s.name || "Direct or unknown", count: s.count };
      }), "No referrals yet.");
      status("");
    }).catch(function (err) {
      if (err.status === 401 || err.status === 403) {
        store(KEY, null);
        show("key");
        $("visitors-key-error").textContent = "That API key was not accepted. Paste a new one.";
        $("visitors-key-error").hidden = false;
        return;
      }
      status("Could not load visitor numbers: " + err.message);
    });
  }

  function pageName(path) {
    var p = String(path || "").replace(/^\/data-repository/, "") || "/";
    var names = { "/": "Home", "/index.html": "Home", "/services.html": "Services", "/contact.html": "Contact" };
    if (names[p]) return names[p];
    var id = /dataset\.html\?id=(.+)$/.exec(p);
    if (id) { try { return "Dataset: " + decodeURIComponent(id[1]); } catch (e) { return "Dataset: " + id[1]; } }
    return p;
  }

  // ---------- Wiring ----------
  $("visitors-key").addEventListener("submit", function (e) {
    e.preventDefault();
    var key = this.elements.key.value.trim();
    if (!key) return;
    store(KEY, key);
    this.elements.key.value = "";
    $("visitors-key-error").hidden = true;
    load();
  });
  $("visitors-refresh").addEventListener("click", load);
  $("visitors-forget").addEventListener("click", function () {
    store(KEY, null);
    load();
  });

  // "Don't count my visits": count.js skips counting while this flag is set, so
  // the admin's own browsing doesn't inflate the numbers.
  var self = $("visitors-self");
  self.checked = read(NO_COUNT) === "t";
  self.addEventListener("change", function () { store(NO_COUNT, self.checked ? "t" : null); });

  if (code) $("visitors-open").href = "https://" + code + ".goatcounter.com";
  else $("visitors-actions").hidden = true;

  var resizing;
  window.addEventListener("resize", function () {
    clearTimeout(resizing);
    resizing = setTimeout(function () { if (shown && !$("visitors-stats").hidden) chart(shown); }, 150);
  });

  window.Visitors = {
    load: load,
    signOut: function () { store(KEY, null); },
  };
})();
