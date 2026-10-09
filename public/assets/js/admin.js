// Admin CMS: list, create, edit and delete datasets through /api/datasets.
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var state = { items: [], editing: null };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    }).then(function (r) {
      if (r.status === 401) { show("login"); throw new Error("Your session has expired. Please sign in again."); }
      if (r.status === 204) return null;
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
        return data;
      });
    });
  }

  function show(view) {
    ["login", "list", "form"].forEach(function (v) { $("view-" + v).hidden = v !== view; });
    window.scrollTo(0, 0);
  }

  // ---------- List ----------
  function loadList() {
    return api("GET", "/api/datasets?all=1").then(function (items) {
      state.items = items;
      drawList();
      show("list");
    });
  }

  function drawList() {
    if (!state.items.length) {
      $("rows").innerHTML = '<tr><td colspan="6" class="empty">No datasets yet. Click “New dataset” to add one.</td></tr>';
      return;
    }
    $("rows").innerHTML = state.items.map(function (d) {
      var status = d.published === false ? '<span class="badge">Draft</span>' : '<span class="badge cat">Published</span>';
      return (
        "<tr><td><strong>" + esc(d.title) + '</strong><div class="small"><a href="dataset.html?id=' + encodeURIComponent(d.id) + '" target="_blank" rel="noopener">' + esc(d.id) + "</a></div></td>" +
        "<td>" + esc(d.category) + "</td><td>" + esc(d.price) + "</td><td>" + status + "</td><td>" + esc(d.updated || "") + "</td>" +
        '<td class="row-actions"><button type="button" class="link" data-edit="' + esc(d.id) + '">Edit</button>' +
        '<button type="button" class="link danger" data-delete="' + esc(d.id) + '">Delete</button></td></tr>'
      );
    }).join("");
  }

  $("rows").addEventListener("click", function (e) {
    var edit = e.target.getAttribute("data-edit");
    var del = e.target.getAttribute("data-delete");
    if (edit) openForm(state.items.filter(function (d) { return d.id === edit; })[0]);
    if (del) {
      var d = state.items.filter(function (x) { return x.id === del; })[0];
      if (!confirm("Delete “" + d.title + "”? This cannot be undone.")) return;
      api("DELETE", "/api/datasets/" + encodeURIComponent(del)).then(loadList).catch(function (err) { alert(err.message); });
    }
  });

  // ---------- Form ----------
  var form = $("form");
  var f = form.elements;

  function attrRow(a) {
    a = a || {};
    var row = document.createElement("div");
    row.className = "attr-row";
    row.innerHTML =
      '<input placeholder="Column (e.g. NAMA_PT)" data-k="name" value="' + esc(a.name) + '">' +
      '<input placeholder="Type (e.g. Text)" data-k="type" value="' + esc(a.type) + '">' +
      '<input placeholder="Description" data-k="description" value="' + esc(a.description) + '">' +
      '<button type="button" class="link danger" aria-label="Remove attribute">✕</button>';
    row.querySelector("button").addEventListener("click", function () { row.remove(); });
    $("attrs").appendChild(row);
  }

  function openForm(d) {
    state.editing = d ? d.id : null;
    form.reset();
    $("form-error").hidden = true;
    $("attrs").innerHTML = "";
    $("form-title").textContent = d ? "Edit: " + d.title : "New dataset";
    f.id.disabled = Boolean(d);
    delete f.id.dataset.touched;

    var cats = [];
    state.items.forEach(function (x) { if (cats.indexOf(x.category) < 0) cats.push(x.category); });
    $("categories").innerHTML = cats.map(function (c) { return '<option value="' + esc(c) + '">'; }).join("");

    if (d) {
      ["id", "title", "category", "price", "summary", "coverage", "source", "year", "crs", "geometry", "size"].forEach(function (k) {
        f[k].value = d[k] == null ? "" : d[k];
      });
      f.features.value = d.features || "";
      f.description.value = (d.description || []).join("\n\n");
      f.format.value = (d.format || []).join(", ");
      (d.bbox || []).forEach(function (v, i) { f["bbox" + i].value = v; });
      f.published.checked = d.published !== false;
      (d.attributes || []).forEach(attrRow);
    } else {
      attrRow();
    }
    show("form");
    f.title.focus();
  }

  // Auto-fill the slug from the title for new datasets until the user edits it.
  f.title.addEventListener("input", function () {
    if (state.editing || f.id.dataset.touched) return;
    f.id.value = f.title.value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  });
  f.id.addEventListener("input", function () { f.id.dataset.touched = "1"; });

  function readForm() {
    var bbox = [0, 1, 2, 3].map(function (i) { return f["bbox" + i].value; });
    var hasBbox = bbox.some(function (v) { return v !== ""; });
    return {
      id: state.editing || f.id.value.trim(),
      title: f.title.value,
      category: f.category.value,
      price: f.price.value,
      summary: f.summary.value,
      description: f.description.value.split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean),
      coverage: f.coverage.value,
      source: f.source.value,
      year: f.year.value,
      format: f.format.value.split(",").map(function (f) { return f.trim(); }).filter(Boolean),
      crs: f.crs.value,
      geometry: f.geometry.value,
      features: f.features.value === "" ? 0 : Number(f.features.value),
      size: f.size.value,
      bbox: hasBbox ? bbox.map(Number) : null,
      attributes: Array.prototype.map.call($("attrs").children, function (row) {
        var a = {};
        row.querySelectorAll("input").forEach(function (inp) { a[inp.getAttribute("data-k")] = inp.value.trim(); });
        return a;
      }).filter(function (a) { return a.name || a.type || a.description; }),
      published: f.published.checked,
    };
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = $("btn-save");
    btn.disabled = true;
    $("form-error").hidden = true;
    var req = state.editing
      ? api("PUT", "/api/datasets/" + encodeURIComponent(state.editing), readForm())
      : api("POST", "/api/datasets", readForm());
    req.then(loadList).catch(function (err) {
      $("form-error").textContent = err.message;
      $("form-error").hidden = false;
    }).finally(function () { btn.disabled = false; });
  });

  $("btn-add-attr").addEventListener("click", function () { attrRow(); });
  $("btn-new").addEventListener("click", function () { openForm(null); });
  document.querySelectorAll("[data-back]").forEach(function (el) {
    el.addEventListener("click", function (e) { e.preventDefault(); show("list"); });
  });
  $("btn-logout").addEventListener("click", function () {
    api("POST", "/auth/logout").then(function () { show("login"); });
  });

  // ---------- Boot ----------
  fetch("/api/me", { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      if (!me) return show("login");
      $("who").innerHTML = (me.avatar ? '<img src="' + esc(me.avatar) + '" alt="">' : "") + esc(me.login);
      return loadList();
    })
    .catch(function (err) { alert(err.message); });
})();
