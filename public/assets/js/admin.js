// Admin CMS: list, create, edit and delete datasets. There is no server:
// datasets.json lives in the GitHub repository, and every save is a commit made
// with the admin's own GitHub token through the Contents API. The push then
// triggers the Pages workflow, which redeploys the public site.
(function () {
  "use strict";

  var CMS = window.SITE.cms;
  var TOKEN_KEY = "geosai-cms-token";
  var $ = function (id) { return document.getElementById(id); };
  var state = { items: [], editing: null, token: null, branch: CMS.branch };

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
        var err = new Error(data.message || "GitHub returned HTTP " + r.status);
        err.status = r.status;
        if (r.status === 401) {
          clearToken();
          show("login");
          err.message = "GitHub rejected the token (expired or revoked). Please sign in again.";
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

  function readFile() {
    return gh("GET", repoPath() + "/contents/" + CMS.path + "?ref=" + encodeURIComponent(state.branch)).then(function (file) {
      return { sha: file.sha, items: JSON.parse(fromBase64(file.content)) };
    });
  }

  // Reads the latest file, applies `change` to it, and commits the result with
  // the sha just read. If someone else committed in between (409), retry once
  // on top of their version instead of overwriting it.
  function commit(change, message, retried) {
    return readFile().then(function (file) {
      var items = window.Schema.validateAll(change(file.items));
      return gh("PUT", repoPath() + "/contents/" + CMS.path, {
        message: message,
        content: toBase64(JSON.stringify(items, null, 2) + "\n"),
        sha: file.sha,
        branch: state.branch,
      }).then(function () { return items; });
    }).catch(function (err) {
      if ((err.status === 409 || err.status === 422) && !retried) return commit(change, message, true);
      throw err;
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
        throw new Error("This token cannot write to " + CMS.owner + "/" + CMS.repo + ". Give it Contents: Read and write on this repository.");
      }
      state.branch = CMS.branch || repo.default_branch;
      $("who").innerHTML = (me.avatar_url ? '<img src="' + esc(me.avatar_url) + '" alt="">' : "") + esc(me.login);
      return loadList();
    }).catch(function (err) {
      if (err.status === 404) {
        clearToken();
        err.message = "Repository " + CMS.owner + "/" + CMS.repo + " was not found with this token. Check that the token has access to it.";
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
    return readFile().then(function (file) {
      state.items = file.items;
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

  function saved(items, text) {
    state.items = items;
    drawList();
    show("list");
    notice(text + " The public site updates in about a minute.");
  }

  $("rows").addEventListener("click", function (e) {
    var edit = e.target.getAttribute("data-edit");
    var del = e.target.getAttribute("data-delete");
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
    if (f.imageRemove.checked) f.image.value = "";
    showPreview(f.imageRemove.checked ? "" : state.image);
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
      (d.attributes || []).forEach(attrRow);
    } else {
      attrRow();
    }
    showPreview(state.image);
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
    record.updated = today();
    if (!id && state.items.some(function (x) { return x.id === record.id; })) {
      $("form-error").textContent = 'A dataset with id "' + record.id + '" already exists.';
      $("form-error").hidden = false;
      return;
    }
    var oldImage = (current() || {}).image || "";
    var file = f.image.files[0];
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
    $("rows").innerHTML = "";
    notice("");
    show("login");
  });

  // ---------- Boot ----------
  $("repo-name").textContent = CMS.owner + "/" + CMS.repo;
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
