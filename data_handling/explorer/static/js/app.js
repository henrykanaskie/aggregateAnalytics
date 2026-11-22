/* app.js: shell, catalog sidebar, tab bar and router, saved views, global
   entity search, keyboard shortcuts, toasts, global error handling.
   Owned by Agent C. Boots last, after every tab module has registered.

   Exposes window.App for the tab modules:
     App.setDataset(name)          switch the active dataset
     App.showTab(id)               switch tab (also updates location.hash)
     App.saveView({kind, name, payload})   open the save dialog
     App.refreshViews()            reload the saved-view list
     App.insertFilter(col, op, v)  dispatch the explorer:filter event
     App.reloadCatalog()           re-fetch /api/catalog and repaint the sidebar
     App.catalogEntry(name)        the catalog record for one dataset
     App.describeSpec(source, s)   readable one-liner for a derive/export spec

   window.SaveDataset(spec, meta) is the shared "save this result as a dataset"
   flow (Addendum 1). spec is the /api/derive body without name/note/overwrite;
   meta is {name, note, scopeText, scopes:[{id,label,limit,offset}],
   defaultScope}. It resolves to the /api/derive response, or null if cancelled,
   and refreshes the catalog itself.

   A tab module may optionally implement:
     getViewPayload() -> {kind, name, payload}   for the Save view affordance
     onRestore(payload)                           to restore a saved view
*/
(function () {
  "use strict";

  var el = U.el;

  /* Canonical tab order and keys. A module that failed to load still gets a
     tab, so the nav never silently loses a section. */
  var TAB_ORDER = ["browse", "schema", "sql", "chart", "coverage"];
  var TAB_META = {
    browse: { label: "Browse", key: "g", file: "js/grid.js" },
    schema: { label: "Schema", key: "s", file: "js/schema.js" },
    sql: { label: "SQL", key: "q", file: "js/sql.js" },
    chart: { label: "Chart", key: "c", file: "js/chart.js" },
    coverage: { label: "Coverage", key: "v", file: "js/coverage.js" }
  };

  /* /api/search hands back GSIS ids ("00-0033873"), so these are only the
     columns that actually hold a GSIS id. pfr_player_id is deliberately absent:
     it holds a Pro Football Reference id, and filtering it by a GSIS id matches
     nothing at all. */
  var PLAYER_ID_COLS = ["player_id", "gsis_id", "player_gsis_id",
    "passer_player_id", "rusher_player_id", "receiver_player_id",
    "fantasy_player_id"];
  var TEAM_COLS = ["team", "posteam", "recent_team", "team_abbr", "club_code",
    "home_team", "defteam"];

  var mounted = {};     // tab id -> {tab, host}
  var views = [];
  var catalogFilter = "";
  var dom = {};

  // ------------------------------------------------------------------ misc --

  function msg(e) { return e && e.message ? e.message : String(e); }

  /** DELETE helper; api.js only ships get/post/postDownload. */
  async function del(path, params) {
    var qs = new URLSearchParams(params || {});
    var res = await fetch("/api/" + path + (qs.toString() ? "?" + qs : ""), { method: "DELETE" });
    var text = await res.text();
    var body = {};
    try { body = text ? JSON.parse(text) : {}; } catch (e) { throw new Error(text.slice(0, 300)); }
    if (!res.ok || body.error) throw new Error(body.error || ("HTTP " + res.status));
    return body;
  }

  // --------------------------------------------------------------- sidebar --

  function datasetEntries() {
    var cat = Store.get("catalog");
    if (!cat || !cat.datasets) return [];
    var q = catalogFilter.trim().toLowerCase();
    return cat.datasets.filter(function (d) {
      if (!q) return true;
      return (d.name || "").toLowerCase().indexOf(q) !== -1 ||
             (d.note || "").toLowerCase().indexOf(q) !== -1;
    });
  }

  function datasetRow(d) {
    var active = Store.get("dataset") === d.name;
    var seasons = Array.isArray(d.seasons) && d.seasons.length === 2
      ? d.seasons[0] + "-" + d.seasons[1] : null;
    var meta = [];
    if (d.rows !== null && d.rows !== undefined) meta.push(U.compact(d.rows) + " rows");
    if (d.mb !== null && d.mb !== undefined) meta.push(U.mb(d.mb));
    if (seasons) meta.push(seasons);

    var name = el("div.ds-name", null, el("span", { text: d.name }));
    if (d.stale) name.appendChild(el("span.badge.warn", { text: "stale", title: "manifest and disk disagree" }));
    if (d.status && d.status !== "ok") name.appendChild(el("span.badge.bad", { text: String(d.status) }));

    if (d.kind === "derived") {
      name.appendChild(el("span.badge.accent", { text: d.source || "derived",
        title: "Derived dataset, built from a " + (d.source || "saved") + " result" }));
    }

    var btn = el("button.ds" + (active ? ".active" : ""), {
      title: d.note || d.name,
      onclick: function () { setDataset(d.name); }
    }, name, el("div.ds-meta", null, meta.map(function (m) { return el("span", { text: m }); })));
    if (d.note) btn.appendChild(el("div.ds-note", { text: d.note }));
    if (d.kind !== "derived") return btn;

    return el("div.ds-row" + (active ? ".active" : ""), btn,
      el("button.ds-del", {
        text: "x", title: "Delete the derived dataset " + d.name,
        onclick: function (e) { e.stopPropagation(); confirmDeleteDerived(d); }
      }));
  }

  function confirmDeleteDerived(d) {
    var body = el("div.modal-b",
      null, el("p", {}, "Delete the derived dataset ", el("span.mono", { text: d.name }),
        "? The Parquet file is removed from data/derived."),
      d.note ? el("p.hint", { text: d.note }) : null,
      el("p.hint", { text: "It can be rebuilt from its spec, which is shown in the provenance bar." }));
    var go = el("button.btn.danger", { text: "Delete" });
    var m = modal("Delete derived dataset", body, [
      el("button.btn.ghost", { text: "Cancel", onclick: function () { m.close(); } }), go
    ]);
    go.addEventListener("click", async function () {
      go.disabled = true;
      try {
        await del("derive", { name: d.name });
        m.close();
        U.toast("Deleted dataset: " + d.name);
        if (Store.get("dataset") === d.name) Store.set("dataset", null);
        var cat = await loadCatalog(false);
        if (!Store.get("dataset")) {
          var next = pickInitialDataset(cat);
          if (next) setDataset(next);
        }
      } catch (e) {
        go.disabled = false;
        U.toast(msg(e), "error");
      }
    });
  }

  function renderSidebar() {
    var side = dom.sidebar;
    U.clear(side);
    var cat = Store.get("catalog");

    // catalog section
    var totals = cat && cat.totals ? cat.totals : null;
    var head = el("div.side-sec-h",
      null, el("span", { text: "Datasets" }),
      totals ? el("span.hint.num", {
        text: U.n(totals.datasets) + " · " + U.compact(totals.rows) + " · " + U.mb(totals.mb)
      }) : null);

    var search = el("input.input.sm#ds-search", {
      type: "search", placeholder: "Search datasets  /", spellcheck: "false",
      value: catalogFilter
    });
    search.addEventListener("input", function () {
      catalogFilter = search.value;
      renderList();
    });
    dom.dsSearch = search;

    var list = el("div.ds-list");
    var sec = el("div.side-sec", null, head, el("div.side-search", null, search), list);
    side.appendChild(sec);

    function renderList() {
      U.clear(list);
      var ds = datasetEntries();
      if (!cat) {
        for (var i = 0; i < 6; i++) {
          list.appendChild(el("div", { style: { padding: "7px 12px" } }, el("span.shimmer")));
        }
        return;
      }
      if (!ds.length) {
        list.appendChild(el("div.empty", { text: "No dataset matches." }));
        return;
      }
      var groups = [
        ["Derived", ds.filter(function (d) { return d.kind === "derived"; })],
        ["Seasonal", ds.filter(function (d) { return d.kind === "seasonal"; })],
        ["Static", ds.filter(function (d) {
          return d.kind !== "seasonal" && d.kind !== "derived";
        })]
      ];
      groups.forEach(function (g) {
        if (!g[1].length) return;
        list.appendChild(el("div.ds-group", { text: g[0] + " · " + g[1].length }));
        g[1].forEach(function (d) { list.appendChild(datasetRow(d)); });
      });
    }
    renderList();
    dom.renderList = renderList;

    // saved views section
    var vhead = el("div.side-sec-h", null, el("span", { text: "Saved views" }),
      el("button.btn.sm.ghost", { text: "reload", onclick: function () { refreshViews(); } }));
    var vlist = el("div.ds-list");
    side.appendChild(el("div.side-sec", null, vhead, vlist));
    dom.viewList = vlist;
    renderViews();
  }

  function renderViews() {
    var host = dom.viewList;
    if (!host) return;
    U.clear(host);
    if (!views.length) {
      host.appendChild(el("div.empty", { style: { padding: "10px 12px", textAlign: "left" } },
        "No saved views yet. Use Save view from a tab."));
      return;
    }
    views.forEach(function (v) {
      var when = (v.created_at || "").slice(0, 10);
      host.appendChild(el("div.view-item",
        null, el("button.view-name", {
          title: (v.kind || "") + "  " + (v.created_at || ""),
          text: v.name || v.id,
          onclick: function () { restoreView(v); }
        }),
        el("span.view-meta", { text: v.kind || "" }),
        el("button.chip-x", {
          text: "x", title: "Delete this view " + (when ? "(" + when + ")" : ""),
          onclick: function () { deleteView(v); }
        })));
    });
  }

  // ---------------------------------------------------------- saved  views --

  function normalizeViews(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.views)) return payload.views;
    return [];
  }

  /* POST /api/views answers {"view": {...}}; DELETE answers {"views": [...]}.
     Accept the bare record too, so either shape works. */
  function normalizeView(payload) {
    if (!payload) return null;
    if (payload.view && payload.view.id) return payload.view;
    return payload.id ? payload : null;
  }

  async function refreshViews() {
    try {
      views = normalizeViews(await API.get("views"));
    } catch (e) {
      views = [];
      console.warn("views unavailable:", msg(e));
    }
    renderViews();
  }

  function tabForKind(kind) {
    if (kind === "sql") return "sql";
    if (kind === "aggregate") return "chart";
    return "browse";
  }

  async function restoreView(v) {
    var payload = v.payload || {};
    var tabId = payload.tab || tabForKind(v.kind);
    try {
      if (payload.dataset && payload.dataset !== Store.get("dataset")) {
        await setDataset(payload.dataset);
      }
      showTab(tabId);
      var m = mounted[tabId];
      if (m && m.tab && typeof m.tab.onRestore === "function") {
        m.tab.onRestore(payload);
        U.toast("Restored view: " + (v.name || v.id));
      } else {
        U.toast("The " + tabId + " tab cannot restore a saved view", "error");
      }
    } catch (e) { U.toast(msg(e), "error"); }
  }

  async function deleteView(v) {
    try {
      var res = await del("views", { id: v.id });
      if (res && Array.isArray(res.views)) views = res.views;
      else views = views.filter(function (x) { return x.id !== v.id; });
      renderViews();
      U.toast("View deleted");
    } catch (e) { U.toast(msg(e), "error"); }
  }

  function saveView(spec) {
    spec = spec || {};
    var name = el("input.input", {
      value: spec.name || (Store.get("dataset") || "view"),
      placeholder: "View name"
    });
    var body = el("div.modal-b", null, el("div.field",
      null, el("span.field-label", { text: "name" }), name,
      el("span.hint", { text: "Saved to explorer/cache/views.json. Kind: " + (spec.kind || "rows") })));
    var save = el("button.btn.primary", { text: "Save" });
    var m = modal("Save view", body, [
      el("button.btn.ghost", { text: "Cancel", onclick: function () { m.close(); } }), save
    ]);
    save.addEventListener("click", async function () {
      var n = name.value.trim();
      if (!n) { U.toast("Give the view a name", "error"); return; }
      save.disabled = true;
      try {
        var res = await API.post("views", {
          name: n, kind: spec.kind || "rows", payload: spec.payload || {}
        });
        m.close();
        U.toast("Saved view: " + n);
        var rec = normalizeView(res);
        if (rec) { views.push(rec); renderViews(); }
        else refreshViews();
      } catch (e) {
        save.disabled = false;
        U.toast(msg(e), "error");
      }
    });
    setTimeout(function () { name.focus(); name.select(); }, 0);
  }

  function saveActiveTabView() {
    var id = Store.get("tab");
    var m = mounted[id];
    var spec = null;
    if (m && m.tab && typeof m.tab.getViewPayload === "function") {
      try { spec = m.tab.getViewPayload(); } catch (e) { console.error(e); }
    }
    if (!spec) {
      U.toast("The " + (id || "current") + " tab has nothing to save", "error");
      return;
    }
    if (!spec.payload) spec = { kind: spec.kind, name: spec.name, payload: spec };
    spec.payload.tab = id;
    if (!spec.payload.dataset) spec.payload.dataset = Store.get("dataset");
    saveView(spec);
  }

  // ------------------------------------------------------ derived datasets --

  var NAME_RE = /^[a-z][a-z0-9_]{0,48}$/;

  function catalogEntry(name) {
    var cat = Store.get("catalog");
    if (!cat || !cat.datasets) return null;
    return cat.datasets.filter(function (d) { return d.name === name; })[0] || null;
  }

  function suggestDatasetName(seed) {
    var base = String(seed || "result").toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    if (!base || !/^[a-z]/.test(base)) base = "d_" + base;
    var name = base, i = 2;
    while (catalogEntry(name)) { name = base + "_" + i; i++; }
    return name.slice(0, 49);
  }

  /** Shared save-as-dataset flow. Agent D calls this from sql.js / chart.js.
      spec: the /api/derive body without name/note/overwrite.
      meta: {name, note, scopes:[{id,label,limit,offset}], defaultScope}. */
  function SaveDataset(spec, meta) {
    spec = spec || {};
    meta = meta || {};
    var scopes = meta.scopes && meta.scopes.length ? meta.scopes : null;

    var name = el("input.input", {
      value: meta.name || suggestDatasetName(spec.dataset || spec.source || "result"),
      placeholder: "lower_snake_case", spellcheck: "false", autocomplete: "off"
    });
    var note = el("input.input", {
      value: meta.note || "", placeholder: "What is in this dataset, and why",
      spellcheck: "false"
    });
    var scopeSel = scopes ? el("select.select", {}, scopes.map(function (s) {
      return el("option", { value: s.id, text: s.label, selected: s.id === meta.defaultScope });
    })) : null;
    var overwrite = el("input", { type: "checkbox" });
    var overwriteRow = el("label.checkbox", { hidden: true }, overwrite,
      el("span", { text: "Overwrite the existing derived dataset" }));
    var problem = el("div.hint");
    function say(cls, text) {
      problem.classList.remove("hint", "err", "warn");
      problem.classList.add(cls);
      problem.textContent = text;
    }

    function validate() {
      var v = name.value.trim();
      var existing = catalogEntry(v);
      overwriteRow.hidden = !(existing && existing.kind === "derived");
      if (!v) { say("hint", "Give the dataset a name."); return false; }
      if (!NAME_RE.test(v)) {
        say("err", "Names are lower case, start with a letter, and use only " +
          "a-z, 0-9 and underscore (max 49 characters).");
        return false;
      }
      if (existing && existing.kind !== "derived") {
        say("err", v + " is already a raw dataset. Pick another name.");
        return false;
      }
      if (existing) {
        say("warn", v + " already exists as a derived dataset. Tick overwrite to replace it.");
        return !!overwrite.checked;
      }
      say("hint", "Saved to data/derived/" + v + ".parquet and added to the catalog.");
      return true;
    }
    name.addEventListener("input", function () { validate(); sync(); });
    overwrite.addEventListener("change", function () { validate(); sync(); });

    var save = el("button.btn.primary", { text: "Save dataset" });
    function sync() { save.disabled = !validate(); }

    var body = el("div.modal-b", null, el("div.col", { style: { gap: "12px" } },
      el("div.field", null, el("span.field-label", { text: "dataset name" }), name),
      el("div.field", null, el("span.field-label", { text: "note" }), note),
      scopeSel
        ? el("div.field", null, el("span.field-label", { text: "what gets saved" }), scopeSel)
        : el("div.field", null, el("span.field-label", { text: "what gets saved" }),
            el("span.hint", { text: meta.scopeText || "the full result of this query" })),
      overwriteRow,
      el("div.field", null, el("span.field-label", { text: "source" }),
        el("pre.code", { text: describeSpecText(spec.source, spec) })),
      problem));

    var resolveFn = null;
    var out = new Promise(function (r) { resolveFn = r; });
    var m = modal("Save as dataset", body, [
      el("button.btn.ghost", {
        text: "Cancel", onclick: function () { m.close(); resolveFn(null); }
      }), save
    ]);
    sync();
    setTimeout(function () { name.focus(); name.select(); }, 0);

    save.addEventListener("click", async function () {
      if (!validate()) return;
      var payload = Object.assign({}, spec);
      payload.name = name.value.trim();
      payload.note = note.value.trim();
      if (overwrite.checked) payload.overwrite = true;
      if (scopeSel) {
        var chosen = scopes.filter(function (s) { return s.id === scopeSel.value; })[0];
        if (chosen) {
          payload.limit = chosen.limit === undefined ? null : chosen.limit;
          if (chosen.offset !== undefined) payload.offset = chosen.offset;
        }
      }
      save.disabled = true;
      save.textContent = "Saving...";
      try {
        var res = await API.post("derive", payload);
        m.close();
        var n = res && res.rows !== undefined ? U.n(res.rows) + " rows" : "saved";
        U.toast("Dataset " + payload.name + ": " + n +
          (res && res.truncated ? " (truncated at the row cap)" : ""));
        await loadCatalog(false);
        resolveFn(res);
      } catch (e) {
        save.disabled = false;
        save.textContent = "Save dataset";
        U.toast(msg(e), "error");
      }
    });
    return out;
  }

  function describeFilters(filters) {
    if (!filters || !filters.length) return "no filters";
    return filters.map(function (f) {
      if (f.op === "is_null" || f.op === "not_null") return f.col + " " + f.op;
      var v = Array.isArray(f.value)
        ? (f.op === "between" ? f.value[0] + ".." + f.value[1] : f.value.join("|"))
        : f.value;
      return f.col + " " + f.op + " " + v;
    }).join(", ");
  }

  /** One readable line describing how a result was built. */
  function describeSpecText(source, spec) {
    spec = spec || {};
    if (source === "sql") return String(spec.sql || "").trim() || "sql";
    if (source === "aggregate") {
      var g = (spec.group_by || []).join(", ") || "no grouping";
      var mets = (spec.metrics || []).map(function (m) {
        return (m.agg || "?") + "(" + (m.col || "*") + ")";
      }).join(", ");
      return (spec.dataset || "?") + "  group by " + g + "  ->  " + (mets || "no metrics") +
        "\nwhere " + describeFilters(spec.filters);
    }
    if (source === "join") {
      var l = (spec.left && spec.left.dataset) || "?";
      var r = (spec.right && spec.right.dataset) || "?";
      var on = (spec.on || []).map(function (p) { return p[0] + " = " + p[1]; }).join(", ");
      return l + "  " + (spec.how || "inner") + " join  " + r + "  on " + (on || "?");
    }
    var cols = spec.columns && spec.columns.length ? spec.columns.length + " columns" : "all columns";
    return (spec.dataset || "?") + "  " + cols +
      (spec.sort ? "  sorted by " + spec.sort + " " + (spec.dir || "asc") : "") +
      "\nwhere " + describeFilters(spec.filters);
  }

  function renderProvenance() {
    var host = dom.prov;
    if (!host) return;
    var d = catalogEntry(Store.get("dataset"));
    if (!d || d.kind !== "derived") { host.hidden = true; U.clear(host); return; }
    U.clear(host);
    var spec = d.spec || {};
    var source = d.source || spec.source || "rows";
    var detail = el("pre.code", { text: describeSpecText(source, spec), hidden: true });

    var toggle = el("button.btn.sm.ghost", { text: "Show spec" });
    toggle.addEventListener("click", function () {
      detail.hidden = !detail.hidden;
      toggle.textContent = detail.hidden ? "Show spec" : "Hide spec";
    });

    var line = el("div.prov-line",
      null, el("span.prov-k", { text: "derived" }),
      el("span.badge.accent", { text: source }),
      el("span.prov-sum", { text: describeSpecText(source, spec).split("\n").join("  ") }),
      el("div.prov-actions",
        null, d.created_at ? el("span.hint", { text: String(d.created_at).slice(0, 16).replace("T", " ") }) : null,
        toggle,
        el("button.btn.sm", {
          text: "Load into builder", onclick: function () { loadIntoBuilder(d); }
        }),
        el("button.btn.sm.danger", {
          text: "Delete", onclick: function () { confirmDeleteDerived(d); }
        })));

    host.appendChild(line);
    if (d.note) host.appendChild(el("div.prov-line", null, el("span.prov-k", { text: "note" }),
      el("span.muted", { text: d.note })));
    host.appendChild(detail);
    host.hidden = false;
  }

  async function loadIntoBuilder(d) {
    var spec = d.spec || {};
    var source = d.source || spec.source || "rows";
    var target = source === "sql" ? "sql" : (source === "aggregate" ? "chart" : "browse");
    try {
      if (spec.dataset && source !== "sql") await setDataset(spec.dataset);
      showTab(target);
      var m = mounted[target];
      if (m && m.tab && typeof m.tab.onRestore === "function") {
        m.tab.onRestore(Object.assign({ tab: target, source: source }, spec));
        U.toast("Loaded the spec behind " + d.name + " into the " + target + " tab");
      } else {
        U.toast("The " + target + " tab cannot load this spec. It is shown in the provenance bar.", "error");
      }
    } catch (e) { U.toast(msg(e), "error"); }
  }

  // -------------------------------------------------------------- datasets --

  async function setDataset(name) {
    if (!name) return;
    if (Store.get("dataset") !== name) {
      Store.set("schema", null);
      Store.set("dataset", name);
    }
    renderHeaderDataset();
    renderProvenance();
    if (dom.renderList) dom.renderList();
    try {
      var sch = await API.get("schema", { dataset: name });
      if (Store.get("dataset") !== name) return;
      Store.set("schema", sch);
      renderHeaderDataset();
      renderProvenance();
    } catch (e) {
      U.toast("Schema for " + name + ": " + msg(e), "error");
    }
  }

  function renderHeaderDataset() {
    var host = dom.hdrDataset;
    if (!host) return;
    U.clear(host);
    var name = Store.get("dataset");
    if (!name) { host.appendChild(el("span.muted", { text: "no dataset" })); return; }
    var cat = Store.get("catalog");
    var d = cat && cat.datasets
      ? cat.datasets.filter(function (x) { return x.name === name; })[0] : null;
    var sch = Store.get("schema");
    host.appendChild(el("span.name", { text: name }));
    var bits = [];
    if (d) {
      if (d.rows !== null && d.rows !== undefined) bits.push(U.n(d.rows) + " rows");
      if (d.cols) bits.push(d.cols + " cols");
      if (Array.isArray(d.seasons) && d.seasons.length === 2) bits.push(d.seasons[0] + "-" + d.seasons[1]);
    } else if (sch) {
      if (sch.rows) bits.push(U.n(sch.rows) + " rows");
      if (sch.columns) bits.push(sch.columns.length + " cols");
    }
    if (bits.length) host.appendChild(el("span.meta", { text: bits.join(" · ") }));
  }

  Store.subscribe("dataset", function (name) {
    Object.keys(mounted).forEach(function (id) {
      var t = mounted[id].tab;
      if (t && typeof t.onDatasetChange === "function") {
        try { t.onDatasetChange(name); } catch (e) { console.error(e); U.toast(msg(e), "error"); }
      }
    });
  });

  // ------------------------------------------------------------------ tabs --

  function registerBrowseTab() {
    var grid = null;
    Tabs.register({
      id: "browse",
      label: "Browse",
      key: "g",
      mount: function (host) {
        grid = Grid.create({
          dataset: Store.get("dataset"),
          pageSize: 100,
          acceptFilterEvents: true
        });
        host.appendChild(grid.el);
      },
      onDatasetChange: function (name) { if (grid) grid.setDataset(name); },
      onShow: function () { if (grid && !grid.getState().dataset && Store.get("dataset")) grid.setDataset(Store.get("dataset")); },
      getViewPayload: function () {
        if (!grid) return null;
        return { kind: "rows", name: null, payload: grid.getState() };
      },
      onRestore: function (payload) { if (grid) grid.setState(payload); }
    });
  }

  function orderedTabs() {
    var registered = Tabs.all();
    var byId = {};
    registered.forEach(function (t) { if (t && t.id) byId[t.id] = t; });
    var out = [];
    TAB_ORDER.forEach(function (id) {
      if (byId[id]) { out.push(byId[id]); delete byId[id]; }
      else out.push(stubTab(id));
    });
    registered.forEach(function (t) { if (t && t.id && byId[t.id]) out.push(t); });
    return out;
  }

  function stubTab(id) {
    var meta = TAB_META[id] || { label: id, file: "js/" + id + ".js" };
    return {
      id: id, label: meta.label, key: meta.key, missing: true,
      mount: function (host) {
        host.appendChild(el("div.wrap-pad", null, el("div.empty",
          null, el("span.empty-h", { text: meta.label + " is unavailable" }),
          "The module " + meta.file + " did not load or did not register a tab. " +
          "The rest of the explorer keeps working.")));
      }
    };
  }

  function renderTabBar() {
    var bar = dom.tabbar;
    U.clear(bar);
    orderedTabs().forEach(function (t) {
      var b = el("button.tab" + (t.missing ? ".missing" : "") +
        (Store.get("tab") === t.id ? ".active" : ""), {
        role: "tab", type: "button",
        title: t.missing ? "Module not loaded" : ("Shortcut: " + (t.key || TAB_META[t.id] && TAB_META[t.id].key || "")),
        onclick: function () { showTab(t.id); }
      }, el("span", { text: t.label || t.id }));
      var k = t.key || (TAB_META[t.id] && TAB_META[t.id].key);
      if (k) b.appendChild(el("span.tab-key", { text: k }));
      bar.appendChild(b);
    });
  }

  function showTab(id) {
    var tabs = orderedTabs();
    var tab = tabs.filter(function (t) { return t.id === id; })[0];
    if (!tab) { tab = tabs[0]; id = tab && tab.id; }
    if (!tab) return;

    Store.set("tab", id);
    if (location.hash !== "#" + id) {
      try { history.replaceState(null, "", "#" + id); } catch (e) { location.hash = id; }
    }
    renderTabBar();

    Object.keys(mounted).forEach(function (k) { mounted[k].host.hidden = k !== id; });

    if (!mounted[id]) {
      var host = el("div.tabhost");
      dom.tabpanel.appendChild(host);
      mounted[id] = { tab: tab, host: host };
      try {
        tab.mount(host);
        if (typeof tab.onDatasetChange === "function" && Store.get("dataset")) {
          tab.onDatasetChange(Store.get("dataset"));
        }
      } catch (e) {
        console.error(e);
        U.clear(host);
        host.appendChild(el("div.wrap-pad", null, el("div.empty",
          null, el("span.empty-h", { text: (tab.label || id) + " failed to start" }),
          el("div.err-msg", { text: msg(e) }))));
      }
    }
    var m = mounted[id];
    m.host.hidden = false;
    if (m.tab && typeof m.tab.onShow === "function") {
      try { m.tab.onShow(); } catch (e) { console.error(e); }
    }
  }

  function tabFromHash() {
    var h = (location.hash || "").replace(/^#/, "").trim();
    return h || "browse";
  }

  // ---------------------------------------------------------- entity search --

  function candidateColumn(list) {
    var sch = Store.get("schema");
    if (!sch || !sch.columns) return null;
    var names = {};
    sch.columns.forEach(function (c) { names[c.name] = 1; });
    for (var i = 0; i < list.length; i++) if (names[list[i]]) return list[i];
    return null;
  }

  function insertFilter(col, op, value) {
    window.dispatchEvent(new CustomEvent("explorer:filter", {
      detail: { col: col, op: op || "=", value: value }
    }));
  }

  function pickEntity(id, label, cols) {
    try { navigator.clipboard.writeText(String(id)); } catch (e) { /* no clipboard */ }
    var col = candidateColumn(cols);
    var ds = Store.get("dataset");
    if (!col) {
      U.toast("Copied " + id + ". " + (ds || "The active dataset") + " has no matching id column.");
      return;
    }
    showTab("browse");
    insertFilter(col, "=", id);
    U.toast("Copied " + id + " and filtered " + col + " = " + id + "  (" + label + ")");
  }

  function renderEntityResults(res) {
    var host = dom.entityResults;
    U.clear(host);
    var players = (res && res.players) || [];
    var teams = (res && res.teams) || [];
    if (!players.length && !teams.length) {
      host.appendChild(el("div.dropdown-empty", { text: "No player or team matched." }));
      host.hidden = false;
      return;
    }
    if (players.length) {
      host.appendChild(el("div.dropdown-group", { text: "Players" }));
      players.forEach(function (p) {
        var id = p.gsis_id || p.player_id || p.id;
        var sub = [p.position, p.team, p.status].filter(Boolean).join(" · ");
        host.appendChild(el("button.dropdown-item", {
          type: "button",
          title: id,
          onclick: function () { closeEntity(); pickEntity(id, p.display_name || id, PLAYER_ID_COLS); }
        }, el("span", { text: p.display_name || p.full_name || id }),
           el("span.sub", { text: sub || String(id) })));
      });
    }
    if (teams.length) {
      host.appendChild(el("div.dropdown-group", { text: "Teams" }));
      teams.forEach(function (t) {
        var id = t.team_abbr || t.team || t.abbr;
        host.appendChild(el("button.dropdown-item", {
          type: "button",
          onclick: function () { closeEntity(); pickEntity(id, t.team_name || id, TEAM_COLS); }
        }, el("span", { text: t.team_name || id }), el("span.sub", { text: String(id) })));
      });
    }
    host.hidden = false;
  }

  function closeEntity() {
    if (dom.entityResults) dom.entityResults.hidden = true;
  }

  var runEntitySearch = U.debounce(async function (q) {
    if (!q || q.length < 2) { closeEntity(); return; }
    try {
      var res = await API.get("search", { q: q, limit: 20 });
      if (dom.entitySearch.value.trim() !== q) return;
      renderEntityResults(res);
    } catch (e) {
      U.clear(dom.entityResults);
      dom.entityResults.appendChild(el("div.dropdown-empty.err", { text: msg(e) }));
      dom.entityResults.hidden = false;
    }
  }, 250);

  // ---------------------------------------------------------------- modals --

  function modal(title, bodyNode, footNodes) {
    var overlay = el("div.overlay");
    var box = el("div.modal",
      null, el("div.modal-h", null, el("span", { text: title }),
        el("button.btn.sm.ghost", { text: "close", onclick: close })),
      bodyNode,
      footNodes && footNodes.length ? el("div.modal-f", null, footNodes) : null);
    overlay.appendChild(box);
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    openOverlays.push(close);
    function close() {
      overlay.remove();
      var i = openOverlays.indexOf(close);
      if (i >= 0) openOverlays.splice(i, 1);
    }
    return { el: overlay, close: close };
  }

  var openOverlays = [];

  var SHORTCUTS = [
    ["/", "Focus the dataset search"],
    ["g", "Browse tab"],
    ["s", "Schema tab"],
    ["q", "SQL tab"],
    ["c", "Chart tab"],
    ["v", "Coverage tab"],
    ["f", "Focus the player and team search"],
    ["r", "Reload the catalog"],
    ["?", "This overlay"],
    ["Esc", "Close overlays and dropdowns"]
  ];

  function showHelp() {
    var grid = el("div.shortcut-grid");
    SHORTCUTS.forEach(function (s) {
      grid.appendChild(el("div.k", null, el("span.kbd", { text: s[0] })));
      grid.appendChild(el("div", { text: s[1] }));
    });
    modal("Keyboard shortcuts", el("div.modal-b", null, grid,
      el("p.hint", { style: { marginBottom: "0" } },
        "Click any grid cell to copy its value. Click a column header to sort. " +
        "Filter chips are editable: click one to change it."))
      , []);
  }

  function closeTopOverlay() {
    if (openOverlays.length) { openOverlays[openOverlays.length - 1](); return true; }
    if (dom.entityResults && !dom.entityResults.hidden) { closeEntity(); return true; }
    return false;
  }

  // ------------------------------------------------------------- shortcuts --

  function isTyping(e) {
    var t = e.target;
    if (!t) return false;
    var tag = (t.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || t.isContentEditable;
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (closeTopOverlay()) { e.preventDefault(); return; }
      if (isTyping(e) && e.target.blur) e.target.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e)) return;

    if (e.key === "/") { e.preventDefault(); if (dom.dsSearch) { dom.dsSearch.focus(); dom.dsSearch.select(); } return; }
    if (e.key === "?") { e.preventDefault(); showHelp(); return; }
    if (e.key === "f") { e.preventDefault(); if (dom.entitySearch) dom.entitySearch.focus(); return; }
    if (e.key === "r") { e.preventDefault(); loadCatalog(true); return; }

    var hit = orderedTabs().filter(function (t) {
      var k = t.key || (TAB_META[t.id] && TAB_META[t.id].key);
      return k === e.key;
    })[0];
    if (hit) { e.preventDefault(); showTab(hit.id); }
  });

  window.addEventListener("hashchange", function () {
    var id = tabFromHash();
    if (id !== Store.get("tab")) showTab(id);
  });

  // -------------------------------------------------------- global  errors --

  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    U.toast(r && r.message ? r.message : String(r), "error");
    console.error("unhandled rejection:", r);
  });
  window.addEventListener("error", function (e) {
    if (e && e.target && e.target.tagName === "SCRIPT") {
      console.warn("script failed to load:", e.target.src);
      return;   // a missing tab module is handled by the stub tab
    }
    if (e && e.message) U.toast(e.message, "error");
  }, true);

  // ------------------------------------------------------------------ boot --

  async function loadCatalog(announce) {
    try {
      var cat = await API.get("catalog");
      Store.set("catalog", cat);
      renderSidebar();
      if (dom.hdrDatadir && cat.data_dir) dom.hdrDatadir.textContent = cat.data_dir;
      renderHeaderDataset();
      renderProvenance();
      if (announce) U.toast("Catalog reloaded: " + ((cat.datasets || []).length) + " datasets");
      return cat;
    } catch (e) {
      U.toast("Catalog: " + msg(e), "error");
      U.clear(dom.sidebar);
      dom.sidebar.appendChild(el("div.side-sec", null, el("div.empty",
        null, el("span.empty-h", { text: "Catalog unavailable" }),
        el("div.err-msg", { text: msg(e) }))));
      return null;
    }
  }

  function pickInitialDataset(cat) {
    if (!cat || !cat.datasets || !cat.datasets.length) return null;
    var names = cat.datasets.map(function (d) { return d.name; });
    var pref = ["pbp", "schedules", "player_stats_week"];
    for (var i = 0; i < pref.length; i++) if (names.indexOf(pref[i]) !== -1) return pref[i];
    return names[0];
  }

  async function boot() {
    dom.sidebar = document.getElementById("sidebar");
    dom.tabbar = document.getElementById("tabbar");
    dom.tabpanel = document.getElementById("tabpanel");
    dom.prov = document.getElementById("prov");
    dom.hdrDataset = document.getElementById("hdr-dataset");
    dom.hdrDatadir = document.getElementById("hdr-datadir");
    dom.entitySearch = document.getElementById("entity-search");
    dom.entityResults = document.getElementById("entity-results");

    registerBrowseTab();
    renderSidebar();
    renderTabBar();

    document.getElementById("btn-help").addEventListener("click", showHelp);
    document.getElementById("btn-save-view").addEventListener("click", saveActiveTabView);

    dom.entitySearch.addEventListener("input", function () {
      runEntitySearch(dom.entitySearch.value.trim());
    });
    dom.entitySearch.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeEntity(); dom.entitySearch.blur(); }
    });
    document.addEventListener("mousedown", function (e) {
      var wrap = document.getElementById("entity-wrap");
      if (wrap && !wrap.contains(e.target)) closeEntity();
    });

    var cat = await loadCatalog(false);
    var initial = pickInitialDataset(cat);
    if (initial) await setDataset(initial);

    showTab(tabFromHash());
    refreshViews();
  }

  window.App = {
    setDataset: setDataset,
    showTab: showTab,
    saveView: saveView,
    refreshViews: refreshViews,
    insertFilter: insertFilter,
    modal: modal,
    saveDataset: SaveDataset,
    describeSpec: describeSpecText,
    suggestDatasetName: suggestDatasetName,
    catalogEntry: catalogEntry,
    reloadCatalog: function () { return loadCatalog(false); }
  };
  window.SaveDataset = SaveDataset;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
