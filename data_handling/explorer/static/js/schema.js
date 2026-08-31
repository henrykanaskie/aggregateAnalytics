/* schema.js -- the Schema tab: column browser plus an incremental column
   profiler.

   The point of this screen is missingness. pbp has 372 columns and a good
   share of them are too null to model on; the profiler makes that obvious
   before you build a feature on top of one. Thresholds match
   data_handling/profile.py: under 5% is fine, under 40% is a warning, above
   that the column is effectively unusable. */
(function () {
  "use strict";

  var el = U.el;

  var KINDS = ["numeric", "string", "bool", "temporal", "other"];
  var MAX_PROFILE = 60;      // contract cap per /api/profile request
  var BATCH = 10;            // columns per request, so results stream in

  function nullClass(pct) {
    if (pct === null || pct === undefined) return "ok";
    return pct < 5 ? "ok" : (pct < 40 ? "warn" : "bad");
  }

  /** Missingness bar in the style of profile.py's null_cell. */
  function nullCell(pct) {
    if (pct === null || pct === undefined) {
      return el("span.null", { text: "·" });
    }
    var cls = nullClass(pct);
    var wrap = el("span.row.tight");
    wrap.appendChild(el("span.nullbar", {
      style: { width: Math.max(1, Math.round(pct * 0.72)) + "px" }
    }));
    wrap.appendChild(el("span.num." + cls, { text: pct.toFixed(1) + "%" }));
    return wrap;
  }

  function goBrowse(col, op, value) {
    if (window.App && typeof App.showTab === "function") App.showTab("browse");
    if (window.App && typeof App.insertFilter === "function") {
      App.insertFilter(col, op, value);
    } else {
      window.dispatchEvent(new CustomEvent("explorer:filter", {
        detail: { col: col, op: op, value: value }
      }));
    }
  }

  function SchemaTab() {
    var root = null;
    var schema = null;
    var dataset = null;
    var selected = new Set();
    var results = {};        // column name -> profile record
    var order = [];          // profiled column order
    var els = {};
    var search = "";
    var kindFilter = "";
    var sortKey = "index";
    var sortDir = 1;
    var run = null;          // {cancelled: bool} token for the active profile run
    var profileMeta = null;  // {n_rows, season, elapsed_ms}
    var sortResultsBy = "null_pct";

    // ------------------------------------------------------------ column list

    function visibleColumns() {
      var cols = (schema && schema.columns) || [];
      var q = search.trim().toLowerCase();
      var out = cols.map(function (c, i) { return { c: c, i: i }; });
      if (q) {
        out = out.filter(function (r) {
          return r.c.name.toLowerCase().indexOf(q) >= 0 ||
                 String(r.c.dtype).toLowerCase().indexOf(q) >= 0;
        });
      }
      if (kindFilter) out = out.filter(function (r) { return r.c.kind === kindFilter; });
      var key = sortKey;
      out.sort(function (a, b) {
        var av, bv;
        if (key === "index") { av = a.i; bv = b.i; }
        else { av = String(a.c[key]).toLowerCase(); bv = String(b.c[key]).toLowerCase(); }
        if (av < bv) return -sortDir;
        if (av > bv) return sortDir;
        return a.i - b.i;
      });
      return out;
    }

    function renderList() {
      var rows = visibleColumns();
      U.clear(els.list);
      if (!schema) {
        els.list.appendChild(el("div.empty", { text: "pick a dataset in the sidebar" }));
        return;
      }
      if (!rows.length) {
        els.list.appendChild(el("div.empty", { text: "no columns match" }));
        updateCounts();
        return;
      }

      function th(label, key, cls) {
        var active = key && sortKey === key;
        var node = el("th" + (cls || "") + (key ? ".sortable" : "") +
          (active ? (sortDir > 0 ? ".sorted-asc" : ".sorted-desc") : ""), {
          onclick: key ? function () {
            if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = 1; }
            renderList();
          } : null
        }, label);
        if (active) node.appendChild(el("span.sort-ind", { text: sortDir > 0 ? "^" : "v" }));
        return node;
      }

      var head = el("thead", null, el("tr", null,
        el("th", { style: { width: "24px" } }),
        th("#", "index", ".num"),
        th("column", "name"),
        th("dtype", "dtype"),
        th("kind", "kind"),
        el("th", { text: "null" })));

      var body = el("tbody", null, rows.map(function (r) {
        var name = r.c.name;
        var box = el("input", {
          type: "checkbox", checked: selected.has(name),
          "aria-label": "profile " + name,
          onchange: function () {
            if (this.checked) selected.add(name); else selected.delete(name);
            updateCounts();
          }
        });
        var prof = results[name];
        var tr = el("tr", null,
          el("td", null, box),
          el("td.num.rownum", { text: String(r.i) }),
          el("td", null, el("span.mono", { text: name })),
          el("td", null, el("span.dtype", { text: r.c.dtype })),
          el("td", null, el("span.kind", { text: r.c.kind })),
          el("td", null, prof ? nullCell(prof.null_pct) : el("span.null", { text: "·" })));
        tr.addEventListener("click", function (ev) {
          if (ev.target === box) return;
          box.checked = !box.checked;
          if (box.checked) selected.add(name); else selected.delete(name);
          updateCounts();
          tr.classList.toggle("sel", box.checked);
        });
        if (selected.has(name)) tr.classList.add("sel");
        return tr;
      }));

      var table = el("table.dt", null, head, body);
      els.list.appendChild(table);
      updateCounts();
    }

    function updateCounts() {
      var total = ((schema && schema.columns) || []).length;
      var shown = visibleColumns().length;
      els.counts.textContent = shown + " of " + total + " columns, " +
        selected.size + " selected" +
        (selected.size > MAX_PROFILE ? " (only the first " + MAX_PROFILE + " will be profiled)" : "");
    }

    // ------------------------------------------------------------- profiling

    function selectionList() {
      var cols = (schema && schema.columns) || [];
      // Keep the dataset's own column order, not click order.
      return cols.map(function (c) { return c.name; })
        .filter(function (n) { return selected.has(n); })
        .slice(0, MAX_PROFILE);
    }

    function startProfile(names) {
      if (run) run.cancelled = true;
      var token = { cancelled: false };
      run = token;
      results = {};
      order = [];
      profileMeta = null;
      U.clear(els.profile);
      els.summary.hidden = true;

      var season = els.season.value ? Number(els.season.value) : null;
      var batches = [];
      for (var i = 0; i < names.length; i += BATCH) batches.push(names.slice(i, i + BATCH));
      var done = 0;
      els.stop.hidden = false;

      function progress(text) {
        els.progress.textContent = text;
      }

      function next() {
        if (token.cancelled) { progress("cancelled after " + done + " of " + names.length + " columns"); els.stop.hidden = true; return; }
        if (!batches.length) {
          els.stop.hidden = true;
          progress(names.length + " columns profiled" +
            (profileMeta ? ", " + U.n(profileMeta.n_rows) + " rows" : "") +
            (profileMeta && profileMeta.cached ? ", cached" : ""));
          renderSummary();
          return;
        }
        var batch = batches.shift();
        progress("profiling " + (done + 1) + "-" + (done + batch.length) +
          " of " + names.length + " ...");
        API.get("profile", {
          dataset: dataset, columns: batch.join(","), season: season
        }).then(function (res) {
          if (token.cancelled) return;
          profileMeta = { n_rows: res.n_rows, season: res.season, cached: res.cached };
          (res.columns || []).forEach(function (c) {
            results[c.name] = c;
            order.push(c.name);
            els.profile.appendChild(profileCard(c));
          });
          done += batch.length;
          renderSummary();
          // Reflect the new null percentages back into the column list.
          refreshListNulls();
          setTimeout(next, 0);   // yield so the browser paints between batches
        }).catch(function (err) {
          if (token.cancelled) return;
          els.stop.hidden = true;
          progress("");
          els.profile.appendChild(el("div.err-msg", {
            text: "profile failed for " + batch.join(", ") + ": " + (err.message || err)
          }));
          U.toast(err.message || err, "error");
        });
      }
      next();
    }

    function refreshListNulls() {
      // Cheap targeted update: re-render only if the list is currently shown.
      var trs = els.list.querySelectorAll("tbody tr");
      for (var i = 0; i < trs.length; i++) {
        var tr = trs[i];
        var nameEl = tr.querySelector(".mono");
        if (!nameEl) continue;
        var prof = results[nameEl.textContent];
        if (!prof) continue;
        var cell = tr.lastElementChild;
        if (cell && cell.dataset.filled !== "1") {
          U.clear(cell);
          cell.appendChild(nullCell(prof.null_pct));
          cell.dataset.filled = "1";
        }
      }
    }

    function renderSummary() {
      var recs = order.map(function (n) { return results[n]; }).filter(Boolean);
      if (!recs.length) { els.summary.hidden = true; return; }
      var bad = recs.filter(function (c) { return (c.null_pct || 0) >= 40; });
      var warn = recs.filter(function (c) { return (c.null_pct || 0) >= 5 && (c.null_pct || 0) < 40; });
      var empty = recs.filter(function (c) { return (c.null_pct || 0) >= 99.999; });
      U.clear(els.summary);
      els.summary.hidden = false;
      function kpi(v, k, cls) {
        return el("div", null,
          el("span.v" + (cls ? "." + cls : ""), { text: String(v) }),
          el("span.k", { text: k }));
      }
      els.summary.appendChild(el("div.kpi", null,
        kpi(recs.length, "columns profiled"),
        kpi(profileMeta ? U.compact(profileMeta.n_rows) : "·",
          "rows scanned" + (profileMeta && profileMeta.season ? " (" + profileMeta.season + ")" : "")),
        kpi(bad.length, "over 40% null", bad.length ? "bad" : ""),
        kpi(warn.length, "5% to 40% null", warn.length ? "warn" : ""),
        kpi(empty.length, "entirely null", empty.length ? "bad" : "")));
      if (bad.length) {
        var chips = el("div.chips", null, el("span.field-label", { text: "unusable here" }));
        bad.slice()
          .sort(function (a, b) { return b.null_pct - a.null_pct; })
          .slice(0, 24)
          .forEach(function (c) {
            chips.appendChild(el("button.chip", {
              type: "button",
              title: c.null_pct.toFixed(1) + "% null, click to browse the rows where it is null",
              onclick: function () { goBrowse(c.name, "is_null"); }
            },
            el("span.chip-k", { text: c.name }),
            el("span.chip-v.bad", { text: c.null_pct.toFixed(0) + "%" })));
          });
        els.summary.appendChild(chips);
      }
    }

    /** One profiled column: missingness first, then shape. */
    function profileCard(c) {
      var isNum = c.kind === "numeric";
      var head = el("div.row.wrap", null,
        el("span.mono.strong", { text: c.name }),
        el("span.dtype", { text: c.dtype }),
        nullCell(c.null_pct),
        el("span.hint", {
          text: c.n_unique === null || c.n_unique === undefined
            ? "" : U.n(c.n_unique) + " distinct"
        }),
        (c.null_pct !== null && c.null_pct !== undefined && c.null_pct >= 40)
          ? el("span.badge.bad", { text: "high null" }) : null,
        (c.null_pct !== null && c.null_pct !== undefined && c.null_pct >= 99.999)
          ? el("span.badge.bad", { text: "empty" }) : null,
        el("span.fill"),
        el("button.btn.sm.ghost", {
          type: "button", text: "browse nulls",
          title: "Browse tab, filtered to rows where " + c.name + " is null",
          onclick: function () { goBrowse(c.name, "is_null"); }
        }),
        el("button.btn.sm.ghost", {
          type: "button", text: "browse present",
          title: "Browse tab, filtered to rows where " + c.name + " has a value",
          onclick: function () { goBrowse(c.name, "not_null"); }
        }));

      var body;
      if (isNum) {
        var stats = el("table.dt.stats", null,
          el("thead", null, el("tr", null,
            ["min", "p25", "median", "p75", "max", "mean", "std"].map(function (h) {
              return el("th.num", { text: h });
            }))),
          el("tbody", null, el("tr", null,
            [c.min, c.p25, c.p50, c.p75, c.max, c.mean, c.std].map(function (v) {
              return el("td.num" + (v === null || v === undefined ? ".null" : ""),
                { text: U.cell(v) });
            }))));
        var spark = null;
        if (c.histogram && c.histogram.edges && c.histogram.counts) {
          spark = window.Chart
            ? Chart.histogram({
                edges: c.histogram.edges, counts: c.histogram.counts,
                height: 74, xLabel: null, yLabel: null,
                ariaLabel: "distribution of " + c.name
              })
            : null;
        }
        body = el("div.col", null, stats, spark);
      } else if (c.top_values && c.top_values.length) {
        var maxCount = Math.max.apply(null, c.top_values.map(function (t) { return t.count || 0; }));
        body = el("table.dt.topvals", null,
          el("tbody", null, c.top_values.slice(0, 12).map(function (t) {
            var isNull = t.value === null || t.value === undefined;
            var pct = maxCount ? (t.count / maxCount) : 0;
            var barCell = el("td", { style: { width: "45%" } });
            barCell.appendChild(el("span.nullbar", {
              style: {
                width: Math.max(1, Math.round(pct * 160)) + "px",
                background: isNull ? "var(--none)" : "var(--c0)",
                height: "9px"
              }
            }));
            var label = el("td", null, isNull
              ? el("span.null", { text: "(null)" })
              : el("button.btn.sm.ghost.mono", {
                  type: "button", text: U.cell(t.value),
                  title: "browse rows where " + c.name + " = " + t.value,
                  onclick: function () { goBrowse(c.name, "=", t.value); }
                }));
            return el("tr", null, label, el("td.num", { text: U.n(t.count) }), barCell);
          })));
      } else {
        body = el("div.hint", { text: "no value summary for this column kind" });
      }

      return el("div.panel.panel-b.col.profile-card", null, head, body);
    }

    // ---------------------------------------------------------------- mount

    function copyColumns() {
      var names = selected.size
        ? selectionList()
        : visibleColumns().map(function (r) { return r.c.name; });
      var text = names.join(", ");
      navigator.clipboard.writeText(text).then(function () {
        U.toast("copied " + names.length + " column names");
      }).catch(function (e) { U.toast(e.message || e, "error"); });
    }

    function mount(node) {
      root = node;
      U.clear(root);
      root.classList.add("col");   // additive: .tabhost must survive
      root.style.overflow = "auto";
      root.style.padding = "10px";
      root.style.gap = "10px";

      els.search = el("input.input.sm", {
        type: "search", placeholder: "filter columns", "aria-label": "filter columns",
        oninput: U.debounce(function () { search = els.search.value; renderList(); }, 140)
      });
      els.kinds = el("div.chips", null,
        [["", "all"]].concat(KINDS.map(function (k) { return [k, k]; }))
          .map(function (pair) {
            var b = el("button.chip" + (pair[0] === kindFilter ? ".on" : ""), {
              type: "button", text: pair[1],
              onclick: function () {
                kindFilter = pair[0];
                Array.prototype.forEach.call(els.kinds.children, function (c) {
                  c.classList.remove("on");
                });
                b.classList.add("on");
                renderList();
              }
            });
            return b;
          }));
      els.season = el("select.select.sm", {
        "aria-label": "season", onchange: function () { /* applied on next profile */ }
      });
      els.counts = el("span.readout", { text: "" });
      els.progress = el("span.readout", { text: "" });
      els.list = el("div.dt-wrap", { style: { maxHeight: "320px" } });
      els.profile = el("div.col");
      els.summary = el("div.col", { hidden: true });
      els.stop = el("button.btn.sm.danger", {
        type: "button", text: "stop", hidden: true,
        onclick: function () { if (run) run.cancelled = true; els.stop.hidden = true; }
      });

      var toolbar = el("div.panel.panel-b.col", null,
        el("div.field-row", null,
          el("div.field", null,
            el("label.field-label", { text: "find" }), els.search),
          el("div.field", null,
            el("label.field-label", { text: "kind" }), els.kinds),
          el("div.field", null,
            el("label.field-label", { text: "season" }), els.season)),
        el("div.row.wrap", null,
          el("button.btn.primary", {
            type: "button", text: "profile selected",
            onclick: function () {
              var names = selectionList();
              if (!names.length) { U.toast("select some columns first", "error"); return; }
              startProfile(names);
            }
          }),
          el("button.btn", {
            type: "button", text: "profile all",
            title: "profiles the first " + MAX_PROFILE + " columns currently listed",
            onclick: function () {
              var names = visibleColumns().map(function (r) { return r.c.name; }).slice(0, MAX_PROFILE);
              if (!names.length) { U.toast("nothing to profile", "error"); return; }
              selected = new Set(names);
              renderList();
              startProfile(names);
            }
          }),
          el("button.btn", {
            type: "button", text: "select visible",
            onclick: function () {
              visibleColumns().slice(0, MAX_PROFILE).forEach(function (r) { selected.add(r.c.name); });
              renderList();
            }
          }),
          el("button.btn.ghost", {
            type: "button", text: "clear",
            onclick: function () { selected.clear(); renderList(); }
          }),
          el("button.btn.ghost", {
            type: "button", text: "copy column list",
            title: "copies the selected columns, or every listed column if none are selected",
            onclick: copyColumns
          }),
          els.stop, els.counts, els.progress));

      root.appendChild(toolbar);
      root.appendChild(el("div.panel", null, els.list));
      root.appendChild(els.summary);
      root.appendChild(els.profile);

      var ds = Store.get("dataset");
      if (ds) onDatasetChange(ds);
      else renderList();
    }

    function fillSeasons() {
      U.clear(els.season);
      els.season.appendChild(el("option", { value: "", text: "all seasons" }));
      var sr = schema && schema.seasons;
      if (sr && sr.length === 2) {
        for (var y = sr[1]; y >= sr[0]; y--) {
          els.season.appendChild(el("option", { value: String(y), text: String(y) }));
        }
      }
      els.season.disabled = !(sr && sr.length === 2);
    }

    function onDatasetChange(name) {
      if (!root || name === dataset) return;
      dataset = name;
      schema = null;
      selected.clear();
      results = {};
      order = [];
      if (run) run.cancelled = true;
      U.clear(els.profile);
      els.summary.hidden = true;
      els.progress.textContent = "";
      U.clear(els.list);
      els.list.appendChild(el("div.empty", { text: "loading schema ..." }));
      API.get("schema", { dataset: name }).then(function (sc) {
        if (dataset !== name) return;
        schema = sc;
        Store.set("schema", sc);
        fillSeasons();
        renderList();
      }).catch(function (err) {
        U.clear(els.list);
        els.list.appendChild(el("div.err-msg", { text: String(err.message || err) }));
        U.toast(err.message || err, "error");
      });
    }

    return {
      id: "schema", label: "Schema", key: "s",
      mount: mount,
      onDatasetChange: onDatasetChange,
      onShow: function () {
        var ds = Store.get("dataset");
        if (root && ds && ds !== dataset) onDatasetChange(ds);
      },
      getViewPayload: function () {
        return {
          kind: "rows",
          name: (dataset || "schema") + " profile",
          payload: {
            tab: "schema", dataset: dataset,
            columns: selectionList(),
            season: els.season && els.season.value ? Number(els.season.value) : null
          }
        };
      },
      onRestore: function (payload) {
        if (!payload || !payload.dataset) return;
        if (window.App && App.setDataset) App.setDataset(payload.dataset);
        else Store.set("dataset", payload.dataset);
        var cols = payload.columns || [];
        var apply = function () {
          selected = new Set(cols);
          if (els.season && payload.season) els.season.value = String(payload.season);
          renderList();
          if (cols.length) startProfile(cols.slice(0, MAX_PROFILE));
        };
        if (schema && dataset === payload.dataset) apply();
        else setTimeout(apply, 400);
      }
    };
  }

  if (window.Tabs && Tabs.register) Tabs.register(SchemaTab());
})();
