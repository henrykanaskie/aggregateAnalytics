/* grid.js: the reusable data grid, filter builder, paging and export UI.
   Owned by Agent C. Exposes window.Grid before app.js loads so sql.js and
   chart.js can render result tables with the same component.

   Grid.create(opts) -> {
     el, load(), setDataset(name), setResult(payload), getState(),
     setState(state), setFilters(list), addFilter(f), destroy()
   }

   opts:
     dataset            string, puts the grid in dataset mode (fetches /api/rows)
     mode               "dataset" | "static"   (inferred from `dataset`)
     pageSize           default 100
     columns            initial visible columns
     filters            initial filter list
     sort, dir          initial sort
     maxDefaultColumns  default 25, the cap applied to wide datasets
     exportSpec(fmt, scope) -> object|null    static mode export wiring
     deriveSpec() -> object|null              static mode "save as dataset" body
     deriveScopeText   copy explaining what a static-mode save writes
     acceptFilterEvents defaults to true in dataset mode: listens for the
                        window CustomEvent("explorer:filter", {detail:{col,op,value}})
     onLoad(payload)    called after every successful load
     onStateChange(st)  called whenever the query state changes
     emptyText          text for the no-rows state
*/
(function () {
  "use strict";

  var el = U.el;

  var PAGE_SIZES = [25, 100, 250, 1000];

  var OPS_BY_KIND = {
    numeric: ["=", "!=", ">", ">=", "<", "<=", "between", "in", "not_in", "is_null", "not_null"],
    temporal: ["=", "!=", ">", ">=", "<", "<=", "between", "is_null", "not_null"],
    string: ["=", "!=", "contains", "not_contains", "starts_with", "ends_with",
             "in", "not_in", "is_null", "not_null"],
    bool: ["=", "!=", "is_null", "not_null"],
    other: ["=", "!=", "is_null", "not_null"]
  };

  var OP_LABEL = {
    "=": "=", "!=": "!=", ">": ">", ">=": ">=", "<": "<", "<=": "<=",
    "in": "in", "not_in": "not in", "contains": "contains",
    "not_contains": "not contains", "starts_with": "starts with",
    "ends_with": "ends with", "is_null": "is null", "not_null": "is not null",
    "between": "between"
  };

  var NO_VALUE = { is_null: 1, not_null: 1 };
  var LIST_OPS = { "in": 1, "not_in": 1 };

  /* What an analyst should see first when a dataset is too wide to render
     whole. Ordered by importance, not by schema position: identity and context
     first, then game situation, then the value columns. Anything not listed is
     only used to top the selection up to the cap. */
  var PRIORITY = [
    // identity and context
    "season", "week", "game_id", "game_date", "gameday", "season_type",
    "posteam", "defteam", "home_team", "away_team", "team", "recent_team",
    "team_abbr", "club_code", "opponent_team",
    "player_id", "gsis_id", "player_name", "player_display_name",
    "display_name", "full_name", "position", "depth_team",
    // situation
    "qtr", "down", "ydstogo", "yardline_100", "score_differential",
    "play_type", "desc",
    // outcome and value
    "yards_gained", "epa", "wp", "cpoe", "success", "touchdown",
    "air_yards", "yards_after_catch", "wpa", "fantasy_points",
    "offense_snaps", "offense_pct", "play_id"
  ];

  // ------------------------------------------------------------- utilities --

  function kindOf(schema, name) {
    if (!schema || !schema.columns) return "other";
    for (var i = 0; i < schema.columns.length; i++) {
      if (schema.columns[i].name === name) return schema.columns[i].kind || "other";
    }
    return "other";
  }

  function kindFromDtype(dt) {
    var d = String(dt || "");
    if (/^(Int|UInt|Float|Decimal)/.test(d)) return "numeric";
    if (/^(Utf8|String|Categorical|Enum)/.test(d)) return "string";
    if (/^Boolean/.test(d)) return "bool";
    if (/^(Date|Datetime|Time|Duration)/.test(d)) return "temporal";
    return "other";
  }

  function opsFor(kind) { return OPS_BY_KIND[kind] || OPS_BY_KIND.other; }

  function coerceScalar(raw, kind) {
    var s = String(raw);
    if (kind === "numeric") {
      var t = s.trim();
      if (t === "") return null;
      var n = Number(t);
      return Number.isNaN(n) ? t : n;
    }
    if (kind === "bool") {
      var b = s.trim().toLowerCase();
      if (b === "true" || b === "1" || b === "t" || b === "yes") return true;
      if (b === "false" || b === "0" || b === "f" || b === "no") return false;
      return s;
    }
    return s;
  }

  function coerceList(raw, kind) {
    return String(raw).split(",").map(function (p) { return p.trim(); })
      .filter(function (p) { return p !== ""; })
      .map(function (p) { return coerceScalar(p, kind); });
  }

  function filterLabelValue(f) {
    if (NO_VALUE[f.op]) return "";
    if (Array.isArray(f.value)) {
      if (f.op === "between") return f.value[0] + " and " + f.value[1];
      var head = f.value.slice(0, 4).join(", ");
      return f.value.length > 4 ? head + ", +" + (f.value.length - 4) : head;
    }
    return String(f.value);
  }

  /** Anchor a popover under an element; returns a close function. */
  function popover(anchor, node) {
    document.body.appendChild(node);
    var r = anchor.getBoundingClientRect();
    node.style.top = Math.round(r.bottom + window.scrollY + 4) + "px";
    var left = Math.round(r.left + window.scrollX);
    var w = node.offsetWidth || 280;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    node.style.left = left + "px";

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
      node.remove();
    }
    function onDoc(e) {
      if (node.contains(e.target) || anchor.contains(e.target)) return;
      close();
    }
    function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); close(); } }
    setTimeout(function () {
      document.addEventListener("mousedown", onDoc, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    return close;
  }

  // ------------------------------------------------------------------ grid --

  function create(opts) {
    opts = opts || {};

    var st = {
      mode: opts.mode || (opts.dataset ? "dataset" : "static"),
      dataset: opts.dataset || null,
      schema: null,
      allColumns: [],          // every column name known for the dataset
      columns: opts.columns ? opts.columns.slice() : null,   // visible subset
      autoTrimmed: false,
      filters: opts.filters ? opts.filters.slice() : [],
      sort: opts.sort || null,
      dir: opts.dir || "asc",
      offset: 0,
      limit: opts.pageSize || 100,
      total: null,
      elapsed: null,
      payload: null,
      loading: false,
      error: null,
      seq: 0,
      widths: {}
    };
    var maxDefault = opts.maxDefaultColumns || 25;
    var isDataset = st.mode === "dataset";

    // ---- DOM skeleton
    var root = el("div.grid");

    var btnColumns = el("button.btn.sm", { text: "Columns", title: "Choose visible columns" });
    var btnRefresh = el("button.btn.sm.ghost", { text: "Reload", title: "Re-run the query" });
    var btnCopy = el("button.btn.sm", { text: "Copy TSV", title: "Copy the current page as TSV" });
    var btnCsv = el("button.btn.sm", { text: "CSV" });
    var btnPq = el("button.btn.sm", { text: "Parquet" });
    var selScope = el("select.select.sm", { title: "What the export covers" },
      el("option", { value: "page", text: "current page" }),
      el("option", { value: "all", text: "full result" }));
    var btnDerive = el("button.btn.sm", { text: "Save as dataset",
      title: "Write this result to data/derived and add it to the catalog" });
    var btnSave = el("button.btn.sm.ghost", { text: "Save view" });

    var tools = el("div.grid-tools", null, btnCopy,
      el("span.hint", { text: "export" }), selScope, btnCsv, btnPq,
      btnDerive, btnSave);
    var toolbar = el("div.grid-toolbar");
    if (isDataset) toolbar.appendChild(btnColumns);
    if (isDataset) toolbar.appendChild(btnRefresh);
    toolbar.appendChild(tools);

    var chips = el("div.chips");
    var filterBar = el("div.grid-filters", null, el("span.hint", { text: "filters" }), chips);

    var note = el("div.grid-note", { hidden: true });
    var scroll = el("div.grid-scroll");
    var table = el("table.dt");
    var thead = el("thead");
    var tbody = el("tbody");
    table.appendChild(thead); table.appendChild(tbody);
    var state = el("div.grid-state", { hidden: true });
    scroll.appendChild(table); scroll.appendChild(state);

    var readout = el("span.readout", { text: "" });
    var btnFirst = el("button.btn.sm", { text: "First" });
    var btnPrev = el("button.btn.sm", { text: "Prev" });
    var btnNext = el("button.btn.sm", { text: "Next" });
    var selSize = el("select.select.sm", {},
      PAGE_SIZES.map(function (n) {
        return el("option", { value: n, text: n + " rows", selected: n === st.limit });
      }));
    var pager = el("div.pager", null, btnFirst, btnPrev, btnNext);
    var foot = el("div.grid-foot");
    if (isDataset) { foot.appendChild(pager); foot.appendChild(selSize); }
    foot.appendChild(readout);

    root.appendChild(toolbar);
    if (isDataset && opts.showFilters !== false) root.appendChild(filterBar);
    root.appendChild(note);
    root.appendChild(scroll);
    root.appendChild(foot);

    // ---- state plumbing
    function emitState() {
      if (typeof opts.onStateChange === "function") {
        try { opts.onStateChange(getState()); } catch (e) { console.error(e); }
      }
    }

    function getState() {
      return {
        dataset: st.dataset, columns: st.columns ? st.columns.slice() : null,
        filters: JSON.parse(JSON.stringify(st.filters)),
        sort: st.sort, dir: st.dir, offset: st.offset, limit: st.limit
      };
    }

    function showState(kind, msgNode) {
      U.clear(state);
      if (!kind) { state.hidden = true; return; }
      state.hidden = false;
      state.appendChild(msgNode);
    }

    function setLoading(on) {
      st.loading = on;
      if (on) {
        showState("loading", el("div.row", null, el("span.spinner"),
          el("span.muted", { text: "querying " + (st.dataset || "result") + "..." })));
      } else if (!st.error) {
        showState(null);
      }
    }

    function setError(msg) {
      st.error = msg;
      var retry = el("button.btn.sm", { text: "Retry", onclick: function () { load(); } });
      showState("error", el("div.col", { style: { alignItems: "center", gap: "10px" } },
        el("div.err", { text: "Query failed" }),
        el("div.err-msg", { text: String(msg) }),
        isDataset ? retry : null));
    }

    // ---- schema / columns
    function defaultColumns(all) {
      if (all.length <= maxDefault) { st.autoTrimmed = false; return all.slice(); }
      var pick = [], seen = {};
      PRIORITY.forEach(function (p) {
        if (all.indexOf(p) !== -1 && !seen[p] && pick.length < maxDefault) {
          pick.push(p); seen[p] = 1;
        }
      });
      for (var i = 0; i < all.length && pick.length < maxDefault; i++) {
        if (!seen[all[i]]) { pick.push(all[i]); seen[all[i]] = 1; }
      }
      // keep them in schema order so the grid reads like the file
      pick.sort(function (a, b) { return all.indexOf(a) - all.indexOf(b); });
      st.autoTrimmed = true;
      return pick;
    }

    function renderNote() {
      U.clear(note);
      var bits = [];
      if (st.autoTrimmed && st.columns && st.allColumns.length) {
        bits.push(el("span", { text: "Showing " + st.columns.length + " of " +
          st.allColumns.length + " columns. " + (st.dataset || "This dataset") +
          " is too wide to render whole." }));
        bits.push(el("button.btn.sm.ghost", {
          text: "Choose columns",
          onclick: function () { openColumnManager(btnColumns.offsetParent ? btnColumns : note); }
        }));
      }
      if (st.payload && st.payload.truncated) {
        bits.push(el("span.warn", { text: "Result truncated by the server." }));
      }
      if (!bits.length) { note.hidden = true; return; }
      bits.forEach(function (b) { note.appendChild(b); });
      note.hidden = false;
    }

    async function loadSchema() {
      if (!st.dataset) return;
      var cached = Store.get("schema");
      var sch = (cached && cached.dataset === st.dataset) ? cached : null;
      if (!sch) sch = await API.get("schema", { dataset: st.dataset });
      st.schema = sch;
      st.allColumns = (sch.columns || []).map(function (c) { return c.name; });
      if (!st.columns || !st.columns.length) st.columns = defaultColumns(st.allColumns);
      else st.columns = st.columns.filter(function (c) { return st.allColumns.indexOf(c) !== -1; });
      if (!st.columns.length) st.columns = defaultColumns(st.allColumns);
    }

    // ---- loading
    async function load() {
      if (!isDataset) { render(); return; }
      if (!st.dataset) {
        showState("empty", el("div.empty",
          null, el("span.empty-h", { text: "No dataset selected" }),
          "Pick one from the catalog on the left."));
        return;
      }
      var mine = ++st.seq;
      st.error = null;
      setLoading(true);
      try {
        if (!st.schema || st.schema.dataset !== st.dataset) await loadSchema();
        var params = {
          dataset: st.dataset, offset: st.offset, limit: st.limit
        };
        if (st.sort) { params.sort = st.sort; params.dir = st.dir; }
        if (st.columns && st.columns.length &&
            st.columns.length !== st.allColumns.length) params.columns = st.columns.join(",");
        if (st.filters.length) params.filters = st.filters;
        var payload = await API.get("rows", params);
        if (mine !== st.seq) return;
        st.payload = payload;
        st.total = payload.total === undefined ? null : payload.total;
        st.elapsed = payload.elapsed_ms;
        st.error = null;
        setLoading(false);
        render();
        if (typeof opts.onLoad === "function") opts.onLoad(payload);
      } catch (e) {
        if (mine !== st.seq) return;
        st.loading = false;
        setError(e && e.message ? e.message : String(e));
        U.toast(e && e.message ? e.message : String(e), "error");
      }
      emitState();
    }

    var loadDebounced = U.debounce(function () { st.offset = 0; load(); }, 260);

    /** Static mode: hand the grid a row payload straight from any endpoint. */
    function setResult(payload) {
      st.mode = "static";
      st.payload = payload || null;
      st.error = null;
      st.loading = false;
      if (payload) {
        st.allColumns = (payload.columns || []).slice();
        st.columns = st.allColumns.slice();
        st.total = payload.total === undefined ? null : payload.total;
        st.elapsed = payload.elapsed_ms;
        st.offset = payload.offset || 0;
        st.limit = payload.limit || (payload.rows || []).length;
      }
      render();
    }

    function setDataset(name) {
      if (name === st.dataset) return;
      st.dataset = name;
      st.mode = "dataset";
      isDataset = true;
      st.schema = null;
      st.allColumns = [];
      st.columns = null;
      st.filters = [];
      st.sort = null; st.dir = "asc";
      st.offset = 0;
      st.total = null;
      st.payload = null;
      renderChips();
      load();
    }

    // ---- rendering
    function render() {
      renderNote();
      renderHead();
      renderBody();
      renderFoot();
    }

    function colKind(name, idx) {
      if (st.schema) return kindOf(st.schema, name);
      var p = st.payload;
      if (p && p.dtypes && p.dtypes[idx] !== undefined) return kindFromDtype(p.dtypes[idx]);
      return "other";
    }

    function renderHead() {
      U.clear(thead);
      var p = st.payload;
      var cols = (p && p.columns) || st.columns || [];
      if (!cols.length) return;
      var tr = el("tr");
      tr.appendChild(el("th.freeze.num", { text: "#", title: "row number" }));
      cols.forEach(function (name, i) {
        var kind = colKind(name, i);
        var numeric = kind === "numeric";
        var th = el("th" + (numeric ? ".num" : "") + ".sortable", {
          title: name + "  " + ((p && p.dtypes && p.dtypes[i]) || kind)
        });
        th.appendChild(document.createTextNode(name));
        if (st.sort === name) {
          th.appendChild(el("span.sort-ind", { text: st.dir === "asc" ? "^" : "v" }));
        }
        if (st.widths[name]) th.style.width = st.widths[name] + "px";
        th.addEventListener("click", function () { cycleSort(name); });
        tr.appendChild(th);
      });
      thead.appendChild(tr);
    }

    function cycleSort(name) {
      if (st.sort !== name) { st.sort = name; st.dir = "asc"; }
      else if (st.dir === "asc") { st.dir = "desc"; }
      else { st.sort = null; st.dir = "asc"; }
      st.offset = 0;
      if (isDataset) load();
      else { sortStatic(); render(); }
    }

    function sortStatic() {
      var p = st.payload;
      if (!p || !p.rows) return;
      if (!st.sort) return;
      var i = p.columns.indexOf(st.sort);
      if (i < 0) return;
      var sign = st.dir === "desc" ? -1 : 1;
      p.rows = p.rows.slice().sort(function (a, b) {
        var x = a[i], y = b[i];
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        if (x === y) return 0;
        return (x < y ? -1 : 1) * sign;
      });
    }

    function renderBody() {
      U.clear(tbody);
      var p = st.payload;
      if (!p) { return; }
      var cols = p.columns || [];
      var rows = p.rows || [];
      if (!rows.length) {
        showState("empty", el("div.empty",
          null, el("span.empty-h", { text: "No rows" }),
          opts.emptyText || (st.filters.length
            ? "No rows matched these filters. Loosen or remove a chip above."
            : "This query returned nothing.")));
        return;
      }
      if (!st.loading && !st.error) showState(null);

      var kinds = cols.map(function (c, i) { return colKind(c, i); });
      var frag = document.createDocumentFragment();
      for (var r = 0; r < rows.length; r++) {
        var tr = el("tr");
        tr.appendChild(el("td.freeze.num.rownum", { text: U.n(st.offset + r + 1) }));
        for (var c = 0; c < cols.length; c++) {
          var v = rows[r][c];
          var isNull = v === null || v === undefined;
          var td = el("td" + (kinds[c] === "numeric" ? ".num" : "") + (isNull ? ".null" : ""), {
            text: U.cell(v),
            title: isNull ? "null" : String(v)
          });
          td._raw = v;
          tr.appendChild(td);
        }
        frag.appendChild(tr);
      }
      tbody.appendChild(frag);
    }

    tbody.addEventListener("click", function (e) {
      var td = e.target.closest ? e.target.closest("td") : null;
      if (!td || !tbody.contains(td)) return;
      if (td.classList.contains("rownum")) return;
      var v = td._raw;
      if (v === null || v === undefined) return;
      try {
        navigator.clipboard.writeText(String(v));
        U.toast("Copied: " + String(v).slice(0, 60));
      } catch (err) { U.toast("Clipboard unavailable", "error"); }
    });

    function renderFoot() {
      var p = st.payload;
      var n = p && p.rows ? p.rows.length : 0;
      var start = n ? st.offset + 1 : 0;
      var end = st.offset + n;
      var parts = [];
      if (n) {
        if (st.total === null || st.total === undefined) {
          parts.push(U.n(start) + "-" + U.n(end) + " of an unknown total");
        } else {
          parts.push(U.n(start) + "-" + U.n(end) + " of " + U.n(st.total) + " rows");
        }
      } else if (p) {
        parts.push("0 rows");
      }
      if (st.elapsed !== null && st.elapsed !== undefined) parts.push(U.ms(st.elapsed));
      if (st.columns && st.allColumns.length) {
        parts.push(st.columns.length + " of " + st.allColumns.length + " cols");
      }
      readout.textContent = parts.join(" · ");

      var atStart = st.offset <= 0;
      btnFirst.disabled = atStart;
      btnPrev.disabled = atStart;
      var known = st.total !== null && st.total !== undefined;
      btnNext.disabled = known ? (st.offset + st.limit >= st.total) : (n < st.limit);
      var noRows = !p || !n;
      btnCopy.disabled = noRows;
      btnCsv.disabled = noRows && isDataset === false;
    }

    btnFirst.addEventListener("click", function () { st.offset = 0; load(); });
    btnPrev.addEventListener("click", function () {
      st.offset = Math.max(0, st.offset - st.limit); load();
    });
    btnNext.addEventListener("click", function () { st.offset += st.limit; load(); });
    selSize.addEventListener("change", function () {
      st.limit = parseInt(selSize.value, 10) || 100;
      st.offset = 0;
      load();
    });
    btnRefresh.addEventListener("click", function () { load(); });

    // ---- column manager
    function openColumnManager(anchor) {
      if (!st.allColumns.length) { U.toast("Schema is not loaded yet"); return; }
      var chosen = {};
      (st.columns || []).forEach(function (c) { chosen[c] = 1; });

      var search = el("input.input.sm", { type: "search", placeholder: "Filter columns", spellcheck: "false" });
      var list = el("div.toggle-list");
      var count = el("span.hint");

      function updateCount() {
        var k = Object.keys(chosen).length;
        count.textContent = k + " of " + st.allColumns.length + " selected";
      }

      function paint() {
        U.clear(list);
        var q = search.value.trim().toLowerCase();
        var shown = 0;
        st.allColumns.forEach(function (name) {
          if (q && name.toLowerCase().indexOf(q) === -1) return;
          if (shown >= 400) return;
          shown++;
          var cb = el("input", { type: "checkbox", checked: !!chosen[name] });
          cb.addEventListener("change", function () {
            if (cb.checked) chosen[name] = 1; else delete chosen[name];
            updateCount();
          });
          list.appendChild(el("label", {}, cb, el("span", { text: name }),
            el("span.kind", { text: kindOf(st.schema, name) })));
        });
        if (!shown) list.appendChild(el("div.dropdown-empty", { text: "No column matches." }));
      }
      search.addEventListener("input", paint);
      paint();
      updateCount();

      var pop = el("div.popover", { style: { width: "330px", maxWidth: "330px" } },
        el("div.popover-h", { text: "Visible columns" }),
        el("div.popover-b", null, search, list, el("div.row.spread", null, count,
          el("div.row.tight",
            null, el("button.btn.sm.ghost", {
              text: "All", onclick: function () {
                st.allColumns.forEach(function (c) { chosen[c] = 1; }); paint(); updateCount();
              }
            }),
            el("button.btn.sm.ghost", {
              text: "None", onclick: function () { chosen = {}; paint(); updateCount(); }
            }),
            el("button.btn.sm.ghost", {
              text: "Default", onclick: function () {
                chosen = {}; defaultColumns(st.allColumns).forEach(function (c) { chosen[c] = 1; });
                paint(); updateCount();
              }
            })))),
        el("div.popover-f",
          null, el("button.btn.sm.ghost", { text: "Cancel", onclick: function () { close(); } }),
          el("button.btn.sm.primary", {
            text: "Apply", onclick: function () {
              var next = st.allColumns.filter(function (c) { return chosen[c]; });
              if (!next.length) { U.toast("Select at least one column", "error"); return; }
              st.columns = next;
              st.autoTrimmed = next.length < st.allColumns.length;
              close();
              st.offset = 0;
              load();
            }
          })));
      var close = popover(anchor, pop);
      search.focus();
    }
    btnColumns.addEventListener("click", function () { openColumnManager(btnColumns); });

    // ---- filter builder
    function renderChips() {
      U.clear(chips);
      st.filters.forEach(function (f, i) {
        var chip = el("span.chip",
          null, el("span.chip-k", { text: f.col }),
          el("span.chip-op", { text: OP_LABEL[f.op] || f.op }),
          NO_VALUE[f.op] ? null : el("span.chip-v", { text: filterLabelValue(f) }),
          el("button.chip-x", {
            text: "x", title: "Remove", onclick: function (e) {
              e.stopPropagation();
              st.filters.splice(i, 1);
              renderChips(); st.offset = 0; load();
            }
          }));
        chip.addEventListener("click", function () { openFilterEditor(chip, i); });
        chips.appendChild(chip);
      });
      var add = el("span.chip.add", { text: "+ filter" });
      add.addEventListener("click", function () { openFilterEditor(add, -1); });
      chips.appendChild(add);
      if (st.filters.length > 1) {
        chips.appendChild(el("button.btn.sm.ghost", {
          text: "clear all", onclick: function () {
            st.filters = []; renderChips(); st.offset = 0; load();
          }
        }));
      }
    }

    function openFilterEditor(anchor, index) {
      if (!st.allColumns.length) { U.toast("Schema is not loaded yet"); return; }
      var existing = index >= 0 ? st.filters[index] : null;
      var cur = {
        col: existing ? existing.col : "",
        op: existing ? existing.op : "=",
        value: existing ? existing.value : ""
      };

      var colInput = el("input.input.sm", {
        type: "text", placeholder: "column", spellcheck: "false",
        value: cur.col, autocomplete: "off"
      });
      var colDrop = el("div.dropdown", { hidden: true, style: { position: "static", maxHeight: "170px" } });
      var opSel = el("select.select.sm");
      var valWrap = el("div.col", { style: { gap: "4px", position: "relative" } });
      var kindTag = el("span.kind", { text: "" });

      function currentKind() { return kindOf(st.schema, cur.col); }

      function paintCols() {
        U.clear(colDrop);
        var q = colInput.value.trim().toLowerCase();
        var hits = st.allColumns.filter(function (c) {
          return !q || c.toLowerCase().indexOf(q) !== -1;
        }).slice(0, 60);
        if (!hits.length) {
          colDrop.appendChild(el("div.dropdown-empty", { text: "No column matches." }));
        }
        hits.forEach(function (c) {
          colDrop.appendChild(el("button.dropdown-item", {
            type: "button",
            onclick: function () {
              cur.col = c;
              colInput.value = c;
              colDrop.hidden = true;
              paintOps();
              paintValue();
            }
          }, el("span.mono", { text: c }), el("span.sub", { text: kindOf(st.schema, c) })));
        });
        colDrop.hidden = false;
      }
      colInput.addEventListener("input", function () { cur.col = colInput.value.trim(); paintCols(); });
      colInput.addEventListener("focus", paintCols);

      function paintOps() {
        var kind = currentKind();
        kindTag.textContent = cur.col ? kind : "";
        var ops = opsFor(kind);
        U.clear(opSel);
        ops.forEach(function (o) {
          opSel.appendChild(el("option", { value: o, text: OP_LABEL[o] || o, selected: o === cur.op }));
        });
        if (ops.indexOf(cur.op) === -1) { cur.op = ops[0]; opSel.value = ops[0]; }
      }
      opSel.addEventListener("change", function () { cur.op = opSel.value; paintValue(); });

      var suggestTimer = null;

      function paintValue() {
        U.clear(valWrap);
        var kind = currentKind();
        if (NO_VALUE[cur.op]) {
          valWrap.appendChild(el("span.hint", { text: "This operator takes no value." }));
          return;
        }
        if (cur.op === "between") {
          var a = el("input.input.sm", {
            placeholder: "from",
            value: Array.isArray(cur.value) ? cur.value[0] : ""
          });
          var b = el("input.input.sm", {
            placeholder: "to",
            value: Array.isArray(cur.value) ? cur.value[1] : ""
          });
          function sync() { cur.value = [a.value, b.value]; }
          a.addEventListener("input", sync); b.addEventListener("input", sync);
          valWrap.appendChild(el("div.row.tight", null, a, el("span.hint", { text: "to" }), b));
          return;
        }
        var initial = Array.isArray(cur.value) ? cur.value.join(", ") : (cur.value === undefined ? "" : String(cur.value));
        var input = el("input.input.sm", {
          placeholder: LIST_OPS[cur.op] ? "comma separated values" : "value",
          value: initial, spellcheck: "false", autocomplete: "off"
        });
        var drop = el("div.dropdown", { hidden: true, style: { maxHeight: "150px" } });
        input.addEventListener("input", function () {
          cur.value = input.value;
          if (kind === "string" && st.dataset) scheduleSuggest();
        });
        input.addEventListener("focus", function () {
          if (kind === "string" && st.dataset) scheduleSuggest();
        });
        cur.value = initial;

        function scheduleSuggest() {
          clearTimeout(suggestTimer);
          suggestTimer = setTimeout(suggest, 200);
        }
        async function suggest() {
          var q = input.value;
          if (LIST_OPS[cur.op]) {
            var parts = q.split(",");
            q = parts[parts.length - 1].trim();
          }
          try {
            var res = await API.get("distinct", {
              dataset: st.dataset, column: cur.col, limit: 40,
              q: q || undefined,
              filters: st.filters.length ? st.filters : undefined
            });
            U.clear(drop);
            var vals = res.values || [];
            if (!vals.length) { drop.hidden = true; return; }
            vals.forEach(function (v) {
              var isNull = v.value === null || v.value === undefined;
              var label = isNull ? "null" : String(v.value);
              drop.appendChild(el("button.dropdown-item", {
                type: "button",
                title: isNull ? "Switches this filter to is null" : label,
                onclick: function () {
                  /* /api/distinct reports nulls as a value. Inserting the text
                     "null" would filter for the literal string, so pick the
                     operator that actually means it. */
                  if (isNull) {
                    cur.op = "is_null";
                    opSel.value = "is_null";
                    paintValue();
                    return;
                  }
                  if (LIST_OPS[cur.op]) {
                    var segs = input.value.split(",");
                    segs[segs.length - 1] = " " + label;
                    input.value = segs.join(",").replace(/^\s+/, "") + ", ";
                  } else {
                    input.value = label;
                  }
                  cur.value = input.value;
                  drop.hidden = true;
                  input.focus();
                }
              }, el("span.mono", { text: label }),
                 el("span.sub", { text: U.compact(v.count) })));
            });
            drop.hidden = false;
          } catch (e) { drop.hidden = true; }
        }

        valWrap.appendChild(input);
        valWrap.appendChild(drop);
        if (kind === "string" && st.dataset) {
          valWrap.appendChild(el("span.hint", { text: "Suggestions come from the column's distinct values." }));
        }
        setTimeout(function () { input.focus(); input.select(); }, 0);
      }

      function build() {
        if (!cur.col || st.allColumns.indexOf(cur.col) === -1) {
          U.toast("Pick a column from the list", "error");
          return null;
        }
        var kind = currentKind();
        var f = { col: cur.col, op: cur.op };
        if (NO_VALUE[cur.op]) return f;
        if (cur.op === "between") {
          var arr = Array.isArray(cur.value) ? cur.value : ["", ""];
          if (String(arr[0]).trim() === "" || String(arr[1]).trim() === "") {
            U.toast("between needs both a from and a to value", "error");
            return null;
          }
          f.value = [coerceScalar(arr[0], kind), coerceScalar(arr[1], kind)];
          return f;
        }
        if (LIST_OPS[cur.op]) {
          var list = coerceList(cur.value, kind);
          if (!list.length) { U.toast("Enter at least one value", "error"); return null; }
          f.value = list;
          return f;
        }
        if (String(cur.value).trim() === "") { U.toast("Enter a value", "error"); return null; }
        f.value = coerceScalar(cur.value, kind);
        return f;
      }

      paintOps();
      paintValue();

      var pop = el("div.popover",
        null, el("div.popover-h", { text: index >= 0 ? "Edit filter" : "Add filter" }),
        el("div.popover-b",
          null, el("div.field", null, el("span.field-label", {}, "column ", kindTag),
            colInput, colDrop),
          el("div.field", null, el("span.field-label", { text: "operator" }), opSel),
          el("div.field", null, el("span.field-label", { text: "value" }), valWrap)),
        el("div.popover-f",
          null, index >= 0 ? el("button.btn.sm.danger", {
            text: "Remove", onclick: function () {
              st.filters.splice(index, 1); close(); renderChips(); st.offset = 0; load();
            }
          }) : null,
          el("button.btn.sm.ghost", { text: "Cancel", onclick: function () { close(); } }),
          el("button.btn.sm.primary", {
            text: index >= 0 ? "Update" : "Add", onclick: apply
          })));

      function apply() {
        var f = build();
        if (!f) return;
        if (index >= 0) st.filters[index] = f; else st.filters.push(f);
        close();
        renderChips();
        st.offset = 0;
        load();
      }
      pop.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); apply(); }
      });

      var close = popover(anchor, pop);
      if (!cur.col) setTimeout(function () { colInput.focus(); }, 0);
    }

    function addFilter(f) {
      if (!f || !f.col) return;
      // replace an existing filter on the same column and operator
      var i = st.filters.findIndex(function (x) { return x.col === f.col && x.op === f.op; });
      if (i >= 0) st.filters[i] = f; else st.filters.push(f);
      renderChips();
      st.offset = 0;
      loadDebounced();
    }

    function setFilters(list) {
      st.filters = (list || []).slice();
      renderChips();
      st.offset = 0;
      load();
    }

    // ---- external filter events
    function onExternalFilter(e) {
      var d = e.detail || {};
      if (!d.col) return;
      if (!st.allColumns.length || st.allColumns.indexOf(d.col) === -1) {
        U.toast("Column " + d.col + " is not in " + (st.dataset || "this dataset"), "error");
        return;
      }
      addFilter({ col: d.col, op: d.op || "=", value: d.value });
      U.toast("Filter added: " + d.col + " " + (d.op || "=") + " " + d.value);
    }
    var listening = false;
    if (isDataset && opts.acceptFilterEvents !== false) {
      window.addEventListener("explorer:filter", onExternalFilter);
      listening = true;
    }

    // ---- toolbar actions
    btnCopy.addEventListener("click", function () {
      var p = st.payload;
      if (!p || !p.rows || !p.rows.length) { U.toast("Nothing to copy"); return; }
      U.copyTSV(p.columns, p.rows).then(function () {
        U.toast("Copied " + p.rows.length + " rows as TSV");
      }, function () { U.toast("Clipboard unavailable", "error"); });
    });

    function exportSpec(format) {
      var scope = selScope.value;
      if (!isDataset) {
        var base = typeof opts.exportSpec === "function" ? opts.exportSpec(format, scope) : null;
        if (!base) return null;
        base.format = format;
        return base;
      }
      var spec = {
        source: "rows",
        format: format,
        dataset: st.dataset,
        filters: st.filters,
        columns: (st.columns && st.columns.length &&
                  st.columns.length !== st.allColumns.length) ? st.columns : null,
        limit: scope === "page" ? st.limit : null,
        offset: scope === "page" ? st.offset : 0,
        filename: st.dataset + (scope === "page" ? "_page" : "") + "." + format
      };
      if (st.sort) { spec.sort = st.sort; spec.dir = st.dir; }
      return spec;
    }

    async function doExport(format) {
      var spec = exportSpec(format);
      if (!spec) { U.toast("This view cannot be exported", "error"); return; }
      var btn = format === "csv" ? btnCsv : btnPq;
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "...";
      try {
        var res = await API.postDownload("export", spec, spec.filename || ("export." + format));
        /* A page export always hits its own limit, so the server's truncation
           flag is only news when the user asked for the full result. */
        var cut = res && res.truncated && spec.limit === null;
        U.toast(cut ? "Export written, truncated at the server row cap"
                    : "Export written: " + (spec.filename || format));
      } catch (e) {
        U.toast(e && e.message ? e.message : String(e), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
    btnCsv.addEventListener("click", function () { doExport("csv"); });
    btnPq.addEventListener("click", function () { doExport("parquet"); });

    /* Save as dataset: the same source dispatch the export uses, minus the
       format, handed to the shared flow in app.js. */
    function deriveSpec() {
      if (!isDataset) {
        return typeof opts.deriveSpec === "function"
          ? opts.deriveSpec()
          : (typeof opts.exportSpec === "function" ? opts.exportSpec(null, "all") : null);
      }
      var spec = {
        source: "rows",
        dataset: st.dataset,
        filters: st.filters,
        columns: (st.columns && st.columns.length &&
                  st.columns.length !== st.allColumns.length) ? st.columns : null
      };
      if (st.sort) { spec.sort = st.sort; spec.dir = st.dir; }
      return spec;
    }

    btnDerive.addEventListener("click", function () {
      if (typeof window.SaveDataset !== "function") {
        U.toast("Saving datasets is not available", "error");
        return;
      }
      var spec = deriveSpec();
      if (!spec) { U.toast("This view cannot be saved as a dataset", "error"); return; }
      if (spec.format) delete spec.format;
      if (spec.filename) delete spec.filename;
      var meta = { note: suggestViewName() };
      if (isDataset) {
        var known = st.total !== null && st.total !== undefined;
        meta.scopes = [
          { id: "all", label: "the full filtered result" +
              (known ? " (" + U.n(st.total) + " rows)" : ""), limit: null, offset: 0 },
          { id: "page", label: "this page only (" + U.n(st.limit) + " rows from " +
              U.n(st.offset + 1) + ")", limit: st.limit, offset: st.offset }
        ];
        meta.defaultScope = selScope.value === "page" ? "page" : "all";
        meta.name = window.App && window.App.suggestDatasetName
          ? window.App.suggestDatasetName(st.dataset + "_subset") : "";
      } else {
        meta.scopeText = opts.deriveScopeText || "the full result of this query";
      }
      window.SaveDataset(spec, meta);
    });

    btnSave.addEventListener("click", function () {
      if (window.App && typeof window.App.saveView === "function") {
        window.App.saveView({
          kind: isDataset ? "rows" : "rows",
          name: suggestViewName(),
          payload: Object.assign({ tab: Store.get("tab") }, getState())
        });
      } else {
        U.toast("Saved views are not available", "error");
      }
    });

    function suggestViewName() {
      var bits = [st.dataset || "result"];
      st.filters.slice(0, 2).forEach(function (f) {
        bits.push(f.col + " " + (OP_LABEL[f.op] || f.op) +
          (NO_VALUE[f.op] ? "" : " " + filterLabelValue(f)));
      });
      return bits.join(" · ").slice(0, 70);
    }

    function setState(next) {
      if (!next) return;
      if (next.dataset && next.dataset !== st.dataset) {
        st.dataset = next.dataset;
        st.schema = null;
        st.allColumns = [];
      }
      st.columns = next.columns ? next.columns.slice() : st.columns;
      st.filters = next.filters ? next.filters.slice() : [];
      st.sort = next.sort || null;
      st.dir = next.dir || "asc";
      st.offset = next.offset || 0;
      st.limit = next.limit || st.limit;
      selSize.value = String(st.limit);
      renderChips();
      load();
    }

    function destroy() {
      st.seq++;
      if (listening) window.removeEventListener("explorer:filter", onExternalFilter);
      root.remove();
    }

    renderChips();
    renderFoot();
    if (isDataset && st.dataset) load();
    else if (isDataset) {
      showState("empty", el("div.empty",
        null, el("span.empty-h", { text: "No dataset selected" }),
        "Pick one from the catalog on the left."));
    }

    return {
      el: root,
      load: load,
      setDataset: setDataset,
      setResult: setResult,
      setFilters: setFilters,
      addFilter: addFilter,
      getState: getState,
      setState: setState,
      deriveSpec: deriveSpec,
      setLoading: function (on) { setLoading(on); },
      setError: function (m) { setError(m); },
      destroy: destroy
    };
  }

  window.Grid = {
    create: create,
    OPS_BY_KIND: OPS_BY_KIND,
    OP_LABEL: OP_LABEL,
    kindFromDtype: kindFromDtype
  };
})();
