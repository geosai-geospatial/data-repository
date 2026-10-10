// Admin CMS: list, create, edit and delete datasets. There is no server:
// datasets.json lives in the GitHub repository, and every save is a commit made
// with the admin's own GitHub token through the Contents API. The push then
// triggers the Pages workflow, which redeploys the public site.
(function () {
  "use strict";

  // Where saves are committed. Kept here rather than in config.js, which every
  // public page loads. Leave branch empty to use the default branch.
  var CMS = {
    owner: "geosai-geospatial",
    repo: "data-repository",
    branch: "",
    path: "public/data/datasets.json",
    // Admin-only Google Drive folder links, kept outside public/.
    linksPath: "cms/drive-links.json",
  };
  var TOKEN_KEY = "geosai-cms-token";
  var $ = function (id) { return document.getElementById(id); };
  var state = { items: [], links: {}, editing: null, token: null, branch: CMS.branch, layer: null, mapFile: null };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------- Token storage ----------
  // sessionStorage by default (gone when the tab closes); localStorage only if
  // the admin ticks "Remember". Storage can throw in private modes, so guard it.
  function readToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }
  function saveToken(token, remember) {
    try { (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token); } catch (e) { /* in-memory only */ }
  }
  function clearToken() {
    state.token = null;
    try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  // ---------- GitHub API ----------
  function gh(method, path, body) {
    return fetch("https://api.github.com" + path, {
      method: method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + state.token,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.ok) return data;
        var err = new Error(data.message || "Request failed (HTTP " + r.status + ")");
        err.status = r.status;
        if (r.status === 401) {
          clearToken();
          show("login");
          err.message = "Your session has expired. Please sign in again.";
        }
        throw err;
      });
    });
  }

  function repoPath() {
    return "/repos/" + encodeURIComponent(CMS.owner) + "/" + encodeURIComponent(CMS.repo);
  }

  // UTF-8 safe base64 (dataset text contains characters like ± and ≥).
  function toBase64(text) {
    return bytesToBase64(new TextEncoder().encode(text));
  }
  function bytesToBase64(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function fromBase64(b64) {
    var bin = atob(b64.replace(/\s/g, "")), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // `fallback` is the content to start from when the file does not exist yet.
  function readFile(path, fallback) {
    return gh("GET", repoPath() + "/contents/" + path + "?ref=" + encodeURIComponent(state.branch)).then(function (file) {
      return { sha: file.sha, items: JSON.parse(fromBase64(file.content)) };
    }).catch(function (err) {
      if (err.status === 404 && fallback !== undefined) return { sha: null, items: fallback };
      throw err;
    });
  }

  // Reads the latest file, applies `change` to it, and commits the result with
  // the sha just read. If someone else committed in between (409), retry once
  // on top of their version instead of overwriting it.
  function writeJson(path, fallback, check, change, message, retried) {
    return readFile(path, fallback).then(function (file) {
      var items = check(change(file.items));
      var body = { message: message, content: toBase64(JSON.stringify(items, null, 2) + "\n"), branch: state.branch };
      if (file.sha) body.sha = file.sha;
      return gh("PUT", repoPath() + "/contents/" + path, body).then(function () { return items; });
    }).catch(function (err) {
      if ((err.status === 409 || err.status === 422) && !retried) return writeJson(path, fallback, check, change, message, true);
      throw err;
    });
  }

  function commit(change, message) {
    return writeJson(CMS.path, undefined, function (list) { return window.Schema.validateAll(list, { keepAll: true }); }, change, message);
  }

  function commitLinks(change, message) {
    return writeJson(CMS.linksPath, {}, window.Schema.validateLinks, change, message).then(function (links) {
      state.links = links;
      return links;
    });
  }

  // ---------- Images ----------
  // Images are stored beside datasets.json: dataset.image is "data/images/<id>.png",
  // relative to the site root, which is the folder two levels above CMS.path.
  var IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
  var IMAGE_MAX = 5 * 1024 * 1024;
  var SITE_ROOT = CMS.path.replace(/[^/]*\/[^/]*$/, "");

  function fileSha(repoFile) {
    return gh("GET", repoPath() + "/contents/" + repoFile + "?ref=" + encodeURIComponent(state.branch))
      .then(function (file) { return file.sha; })
      .catch(function (err) { if (err.status === 404) return null; throw err; });
  }

  function uploadImage(id, file) {
    var image = "data/images/" + id + "." + IMAGE_TYPES[file.type];
    var repoFile = SITE_ROOT + image;
    return Promise.all([file.arrayBuffer(), fileSha(repoFile)]).then(function (res) {
      var body = { message: "CMS: image " + id, content: bytesToBase64(new Uint8Array(res[0])), branch: state.branch };
      if (res[1]) body.sha = res[1];
      return gh("PUT", repoPath() + "/contents/" + repoFile, body);
    }).then(function () { return image; });
  }

  // Best effort: a leftover image file is harmless, so a failure here is not an error.
  function deleteImage(image, id) {
    if (!image) return Promise.resolve();
    var repoFile = SITE_ROOT + image;
    return fileSha(repoFile).then(function (sha) {
      if (sha) return gh("DELETE", repoPath() + "/contents/" + repoFile, { message: "CMS: remove image " + id, sha: sha, branch: state.branch });
    }).catch(function () { /* ignore */ });
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function show(view) {
    ["login", "list", "form"].forEach(function (v) { $("view-" + v).hidden = v !== view; });
    window.scrollTo(0, 0);
  }

  function notice(text) {
    $("notice").textContent = text;
    $("notice").hidden = !text;
  }

  // ---------- Sign in ----------
  // The token is accepted only if GitHub says it can push to the repository:
  // write access to the repo is what makes someone an admin.
  function signIn(token) {
    state.token = token;
    return Promise.all([gh("GET", "/user"), gh("GET", repoPath())]).then(function (res) {
      var me = res[0], repo = res[1];
      if (!repo.permissions || !repo.permissions.push) {
        clearToken();
        throw new Error("This access key cannot make changes.");
      }
      state.branch = CMS.branch || repo.default_branch;
      $("who").innerHTML = (me.avatar_url ? '<img src="' + esc(me.avatar_url) + '" alt="">' : "") + esc(me.login);
      return loadList();
    }).catch(function (err) {
      if (err.status === 401 || err.status === 404) {
        clearToken();
        err.message = "Invalid access key.";
      }
      throw err;
    });
  }

  $("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var lf = this.elements, token = lf.token.value.trim();
    if (!token) return;
    $("btn-login").disabled = true;
    $("login-error").hidden = true;
    signIn(token).then(function () {
      saveToken(token, lf.remember.checked);
      lf.token.value = "";
    }).catch(function (err) {
      clearToken();
      $("login-error").textContent = err.message;
      $("login-error").hidden = false;
    }).finally(function () { $("btn-login").disabled = false; });
  });

  // ---------- List ----------
  function loadList() {
    return Promise.all([readFile(CMS.path), readFile(CMS.linksPath, {})]).then(function (res) {
      state.items = res[0].items;
      state.links = res[1].items;
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
      var hidden = d.published === false;
      var status = hidden ? '<span class="badge">Hidden</span>' : '<span class="badge cat">Visible</span>';
      return (
        "<tr" + (hidden ? ' class="is-hidden"' : "") + "><td><strong>" + esc(d.title) + '</strong><div class="small"><a href="dataset.html?id=' + encodeURIComponent(d.id) + '" target="_blank" rel="noopener">' + esc(d.id) + "</a></div></td>" +
        "<td>" + esc(d.category) + "</td><td>" + (d.free ? '<span class="badge free">Free</span>' : esc(d.price)) + "</td><td>" + status + "</td><td>" + esc(d.updated || "") + "</td>" +
        '<td class="row-actions">' +
        (state.links[d.id] ? '<a class="link" href="' + esc(state.links[d.id]) + '" target="_blank" rel="noopener noreferrer">Drive ↗</a>' : "") +
        '<button type="button" class="link" data-toggle="' + esc(d.id) + '">' + (hidden ? "Show" : "Hide") + "</button>" +
        '<button type="button" class="link" data-edit="' + esc(d.id) + '">Edit</button>' +
        '<button type="button" class="link danger" data-delete="' + esc(d.id) + '">Delete</button></td></tr>'
      );
    }).join("");
  }

  function saved(items, text) {
    state.items = items;
    drawList();
    show("list");
    notice(text + " The public site updates in about a minute.");
  }

  $("rows").addEventListener("click", function (e) {
    var edit = e.target.getAttribute("data-edit");
    var del = e.target.getAttribute("data-delete");
    var toggle = e.target.getAttribute("data-toggle");
    if (toggle) {
      var t = state.items.filter(function (x) { return x.id === toggle; })[0];
      var reveal = t.published === false;
      e.target.disabled = true;
      // Flip only the visibility flag on the latest file; "updated" is about the data, so it stays.
      commit(function (items) {
        var x = items.filter(function (x) { return x.id === toggle; })[0];
        if (!x) throw new Error("This dataset was deleted in the meantime. Reload the page.");
        x.published = reveal;
        return items;
      }, "CMS: " + (reveal ? "show " : "hide ") + toggle).then(function (items) {
        saved(items, (reveal ? "“" + t.title + "” is visible on the website again." : "Hid “" + t.title + "” from the website."));
      }).catch(function (err) { e.target.disabled = false; alert(err.message); });
    }
    if (edit) openForm(state.items.filter(function (d) { return d.id === edit; })[0]);
    if (del) {
      var d = state.items.filter(function (x) { return x.id === del; })[0];
      if (!confirm("Delete “" + d.title + "”? (It stays in the repository's git history.)")) return;
      e.target.disabled = true;
      commit(function (items) {
        return items.filter(function (x) { return x.id !== del; });
      }, "CMS: delete " + del).then(function (items) {
        deleteImage(d.image, del);
        saved(items, "Deleted “" + d.title + "”.");
        if (state.links[del]) {
          commitLinks(function (links) { delete links[del]; return links; }, "CMS: remove Drive link " + del)
            .then(drawList).catch(function () { /* a leftover link is harmless */ });
        }
      }).catch(function (err) { e.target.disabled = false; alert(err.message); });
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

  function showPreview(src) {
    $("image-preview").src = src || "";
    $("image-preview").hidden = !src;
  }

  f.image.addEventListener("change", function () {
    var file = f.image.files[0];
    $("form-error").hidden = true;
    if (file) clearMap();
    if (!file) { showPreview(state.image); return; }
    var problem = !IMAGE_TYPES[file.type] ? "The image must be a PNG, JPEG or WebP file." :
      file.size > IMAGE_MAX ? "The image is larger than 5 MB. Please export a smaller one." : "";
    if (problem) {
      f.image.value = "";
      showPreview(state.image);
      $("form-error").textContent = problem;
      $("form-error").hidden = false;
      return;
    }
    f.imageRemove.checked = false;
    var reader = new FileReader();
    reader.onload = function () { showPreview(reader.result); };
    reader.readAsDataURL(file);
  });
  f.imageRemove.addEventListener("change", function () {
    if (f.imageRemove.checked) { f.image.value = ""; clearMap(); }
    showPreview(f.imageRemove.checked ? "" : state.image);
  });

  // ---------- Coverage map from data ----------
  // The GeoJSON/shapefile is read and drawn in this browser (staticmap.js); the
  // finished PNG takes the place of an uploaded coverage image when saving.
  var basemap = null;
  function loadBasemap() {
    basemap = basemap || fetch("data/basemap.json").then(function (r) {
      if (!r.ok) throw new Error("The basemap could not be loaded (HTTP " + r.status + ").");
      return r.json();
    }).catch(function (err) { basemap = null; throw err; });
    return basemap;
  }

  function mapStatus(text, isError) {
    $("map-status").textContent = text;
    $("map-status").className = "small" + (isError ? " error" : "");
    $("map-status").hidden = !text;
  }

  // Drops the generated map (not the loaded data), e.g. when an image file is picked instead.
  function clearMap() {
    if (!state.mapFile) return;
    state.mapFile = null;
    $("map-download").hidden = true;
    mapStatus(state.layer ? "Map discarded. Click “Make map” to draw it again." : "");
  }

  function resetMapMaker() {
    state.layer = null;
    state.mapFile = null;
    $("map-file").value = "";
    $("map-options").hidden = true;
    $("map-download").hidden = true;
    mapStatus("");
  }

  function fmt(n) { return Number(n).toLocaleString("id-ID"); }

  $("map-file").addEventListener("change", function () {
    var input = this;
    state.layer = null;
    state.mapFile = null;
    $("map-options").hidden = true;
    $("map-download").hidden = true;
    if (!input.files.length) { mapStatus(""); return; }
    mapStatus("Reading " + input.files[0].name + "…");
    window.StaticMap.load(input.files).then(function (layer) {
      state.layer = layer;
      var b = layer.bbox.map(function (v) { return v.toFixed(3); });
      mapStatus(fmt(layer.features.length) + " features · " + layer.geometry + " · " + layer.fields.length + " fields · " +
        layer.crs + " · extent " + b[0] + ", " + b[1] + " to " + b[2] + ", " + b[3]);
      var options = window.StaticMap.categoryFields(layer);
      $("map-field").innerHTML = '<option value="">One colour</option>' + options.map(function (n) {
        return '<option value="' + esc(n) + '">' + esc(n) + "</option>";
      }).join("");
      $("map-title").value = f.title.value.trim() || input.files[0].name.replace(/\.[^.]+$/, "");
      $("map-layer").value = f.title.value.trim() || "Areal data";
      delete $("map-layer").dataset.touched;
      $("map-options").hidden = false;
    }).catch(function (err) {
      mapStatus(err.message || "The file could not be read.", true);
    });
  });

  $("map-layer").addEventListener("input", function () { this.dataset.touched = "1"; });
  $("map-field").addEventListener("change", function () {
    if ($("map-layer").dataset.touched) return;
    $("map-layer").value = this.value || f.title.value.trim() || "Areal data";
  });

  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, type, quality); });
  }

  $("btn-map-make").addEventListener("click", function () {
    var btn = this, layer = state.layer;
    if (!layer) return;
    btn.disabled = true;
    mapStatus("Drawing the map…");
    var canvas = document.createElement("canvas");
    var fonts = document.fonts ? Promise.all([document.fonts.load("400 16px Inter"), document.fonts.load("600 16px Inter"), document.fonts.load("700 16px Inter")]).catch(function () {}) : Promise.resolve();
    Promise.all([loadBasemap(), fonts]).then(function (res) {
      var field = $("map-field").value;
      var year = f.year.value.trim();
      window.StaticMap.render(canvas, layer, res[0], {
        title: $("map-title").value.trim() || f.title.value.trim(),
        subtitle: [f.coverage.value.trim(), year ? "Tahun " + year : "", fmt(layer.features.length) + " fitur"].filter(Boolean).join("  ·  "),
        field: field,
        legendTitle: field ? $("map-layer").value.trim() || field : "",
        layerName: field ? "" : $("map-layer").value.trim() || "Areal data",
        source: f.source.value.trim(),
        credit: window.SITE.name,
        date: new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" }),
      });
      // PNG keeps lines and text crisp; fall back to WebP if it is over the size limit.
      return toBlob(canvas, "image/png").then(function (blob) {
        return blob && blob.size <= IMAGE_MAX ? blob : toBlob(canvas, "image/webp", 0.92);
      });
    }).then(function (blob) {
      if (!blob || blob.size > IMAGE_MAX) throw new Error("The map image is larger than 5 MB.");
      var name = (state.editing || f.id.value.trim() || "map") + "." + IMAGE_TYPES[blob.type];
      state.mapFile = new File([blob], name, { type: blob.type });
      f.image.value = "";
      f.imageRemove.checked = false;
      var reader = new FileReader();
      reader.onload = function () {
        showPreview(reader.result);
        $("map-download").href = reader.result;
        $("map-download").download = name;
        $("map-download").hidden = false;
      };
      reader.readAsDataURL(blob);
      mapStatus("Map ready (" + Math.round(blob.size / 1024) + " KB). It is saved as the coverage image when you click Save.");
    }).catch(function (err) {
      mapStatus(err.message || "The map could not be drawn.", true);
    }).finally(function () { btn.disabled = false; });
  });

  // Copies what the file knows into the form: extent, geometry, feature count,
  // and attribute names/types (descriptions already typed in are kept).
  $("btn-map-fill").addEventListener("click", function () {
    if (!state.layer) return;
    var sum = window.StaticMap.summary(state.layer);
    sum.bbox.forEach(function (v, i) { f["bbox" + i].value = v; });
    f.features.value = sum.features;
    f.geometry.value = sum.geometry;
    if (!f.crs.value.trim()) f.crs.value = sum.crs;
    if (!f.format.value.trim()) f.format.value = sum.format;
    var have = {};
    Array.prototype.forEach.call($("attrs").children, function (row) {
      var name = row.querySelector('[data-k="name"]').value.trim();
      if (name) have[name] = row; else row.remove();
    });
    var added = 0;
    sum.attributes.forEach(function (a) {
      if (have[a.name]) {
        var type = have[a.name].querySelector('[data-k="type"]');
        if (!type.value.trim()) type.value = a.type;
      } else { attrRow(a); added++; }
    });
    if (!$("attrs").children.length) attrRow();
    mapStatus("Filled the bounding box, geometry, feature count (" + fmt(sum.features) + ") and " + added + " new attribute" + (added === 1 ? "" : "s") + ". Review them before saving.");
  });

  function openForm(d) {
    state.editing = d ? d.id : null;
    state.image = d && d.image ? d.image + "?v=" + encodeURIComponent(d.updated || "") : "";
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
      f.free.checked = d.free === true;
      f.download.value = d.download || "";
      (d.attributes || []).forEach(attrRow);
    } else {
      attrRow();
    }
    showPreview(state.image);
    resetMapMaker();
    f.drive.value = d ? state.links[d.id] || "" : "";
    $("image-remove-wrap").hidden = !(d && d.image);
    show("form");
    f.title.focus();
  }

  // Auto-fill the slug from the title for new datasets until the user edits it.
  f.title.addEventListener("input", function () {
    if (state.editing || f.id.dataset.touched) return;
    f.id.value = f.title.value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  });
  f.id.addEventListener("input", function () { f.id.dataset.touched = "1"; });

  function current() {
    return state.editing ? state.items.filter(function (x) { return x.id === state.editing; })[0] : null;
  }

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
      bbox: hasBbox ? bbox : null,
      image: current() && !f.imageRemove.checked ? current().image : "",
      attributes: Array.prototype.map.call($("attrs").children, function (row) {
        var a = {};
        row.querySelectorAll("input").forEach(function (inp) { a[inp.getAttribute("data-k")] = inp.value.trim(); });
        return a;
      }).filter(function (a) { return a.name || a.type || a.description; }),
      published: f.published.checked,
      free: f.free.checked,
      download: f.download.value,
    };
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = $("btn-save"), id = state.editing, record;
    $("form-error").hidden = true;
    try {
      record = window.Schema.validate(readForm());
    } catch (err) {
      $("form-error").textContent = err.message;
      $("form-error").hidden = false;
      return;
    }
    var drive = f.drive.value.trim();
    try {
      window.Schema.validateLinks(drive ? { x: drive } : {});
    } catch (err) {
      $("form-error").textContent = "The Google Drive link must start with https://drive.google.com/";
      $("form-error").hidden = false;
      return;
    }
    record.updated = today();
    if (!id && state.items.some(function (x) { return x.id === record.id; })) {
      $("form-error").textContent = 'A dataset with id "' + record.id + '" already exists.';
      $("form-error").hidden = false;
      return;
    }
    var oldImage = (current() || {}).image || "";
    var file = f.image.files[0] || state.mapFile;
    btn.disabled = true;
    // Upload the image first, so datasets.json never points at a file that isn't there.
    (file ? uploadImage(record.id, file) : Promise.resolve(record.image)).then(function (image) {
      record.image = image;
      return commit(function (items) {
        if (id) {
          var i = items.findIndex(function (x) { return x.id === id; });
          if (i < 0) throw new Error("This dataset was deleted in the meantime. Reload the page.");
          items[i] = record;
        } else {
          if (items.some(function (x) { return x.id === record.id; })) throw new Error('A dataset with id "' + record.id + '" already exists.');
          items.push(record);
        }
        return items;
      }, "CMS: " + (id ? "update " : "add ") + record.id);
    }).then(function (items) {
      if (oldImage && oldImage !== record.image) deleteImage(oldImage, record.id);
      if (drive === (state.links[record.id] || "")) return items;
      // The link lives in its own admin-only file, committed after the dataset.
      return commitLinks(function (links) {
        if (drive) links[record.id] = drive; else delete links[record.id];
        return links;
      }, "CMS: Drive link " + record.id).then(function () { return items; }, function (err) {
        state.items = items;
        drawList();
        throw new Error("The dataset was saved, but the Drive link was not: " + err.message);
      });
    }).then(function (items) {
      saved(items, "Saved “" + record.title + "”.");
    }).catch(function (err) {
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
    clearToken();
    state.items = [];
    state.links = {};
    $("rows").innerHTML = "";
    notice("");
    show("login");
  });

  // ---------- Boot ----------
  var stored = readToken();
  if (!stored) {
    show("login");
  } else {
    signIn(stored).catch(function (err) {
      clearToken();
      show("login");
      $("login-error").textContent = err.message;
      $("login-error").hidden = false;
    });
  }
})();
