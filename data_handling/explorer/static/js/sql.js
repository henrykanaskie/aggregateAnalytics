/* sql.js -- the SQL console.

   Every dataset is registered as a polars SQL table under its own name, and so
   is every derived dataset, which is the main reason derived datasets exist:
   save a filtered join, then query it here by name. */
(function () {
  "use strict";

  var el = U.el;

  var HISTORY_KEY = "explorer.sql.history";
  var DRAFT_KEY = "explorer.sql.draft";
  var HISTORY_MAX = 50;
  var LIMITS = [100, 500, 1000, 5000];

  /* Worked examples, each verified against the real cache before shipping.
     They double as a tour of what is in the data. */
  var EXAMPLES = [
    {
      label: "Team EPA per play, 2024",
      sql: "select posteam as team,\n" +
           "       count(*) as plays,\n" +
           "       avg(epa) as epa_per_play,\n" +
           "       avg(success) as success_rate\n" +
           "from pbp\n" +
           "where season = 2024 and play_type in ('pass', 'run')\n" +
           "group by posteam\n" +
           "order by epa_per_play desc"
    },
    {
      label: "Scoring by season",
      sql: "select season,\n" +
           "       count(*) as games,\n" +
           "       avg(total) as points_per_game,\n" +
           "       avg(total_line) as vegas_total\n" +
           "from schedules\n" +
           "where game_type = 'REG' and total is not null\n" +
           "group by season\n" +
           "order by season"
    },
    {
      label: "Top PPR seasons, 2024",
      sql: "select player_display_name as player, position, team,\n" +
           "       sum(fantasy_points_ppr) as ppr,\n" +
           "       sum(targets) as targets\n" +
           "from player_stats_week\n" +
           "where season = 2024 and season_type = 'REG'\n" +
           "group by player_display_name, position, team\n" +
           "order by ppr desc\n" +
           "limit 25"
    },
    {
      label: "Third down pass rate by team",
      sql: "select posteam as team,\n" +
           "       count(*) as third_downs,\n" +
           "       avg(pass) as pass_rate\n" +
           "from pbp\n" +
           "where season = 2024 and down = 3 and play_type in ('pass', 'run')\n" +
           "group by posteam\n" +
           "order by pass_rate desc"
    },
    {
      label: "Join: snap share in domes",
      sql: "select sc.team,\n" +
           "       count(*) as player_games,\n" +
           "       avg(sc.offense_pct) as avg_off_snap_pct\n" +
           "from snap_counts sc\n" +
           "join schedules g on sc.game_id = g.game_id\n" +
           "where g.season = 2024 and g.roof in ('dome', 'closed')\n" +
           "group by sc.team\n" +
           "order by avg_off_snap_pct desc"
    },
    {
      label: "Missingness: wind is outdoors only",
      sql: "select roof,\n" +
           "       count(*) as games,\n" +
           "       sum(case when wind is null then 1 else 0 end) as wind_missing,\n" +
           "       avg(wind) as avg_wind\n" +
           "from schedules\n" +
           "where season >= 2015\n" +
           "group by roof\n" +
           "order by games desc"
    },
    {
      label: "Deep targets, 2024",
      sql: "select receiver_player_name as receiver, posteam as team,\n" +
           "       count(*) as deep_targets,\n" +
           "       avg(epa) as epa_per_target,\n" +
           "       avg(air_yards) as avg_air_yards\n" +
           "from pbp\n" +
           "where season = 2024 and play_type = 'pass' and air_yards >= 20\n" +
           "group by receiver_player_name, posteam\n" +
           "order by deep_targets desc\n" +
           "limit 20"
    },
    {
      label: "Coverage: rows per season",
      sql: "select season, count(*) as rows_that_season\n" +
           "from snap_counts\n" +
           "group by season\n" +
           "order by season"
    }
  ];

  function loadHistory() {
    try {
      var raw = window.localStorage.getItem(HISTORY_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function saveHistory(list) {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
    } catch (e) { /* private mode or quota: history is a convenience, not state */ }
  }

  function firstLine(sql) {
    var t = String(sql).replace(/\s+/g, " ").trim();
    return t.length > 78 ? t.slice(0, 77) + "…" : t;
  }

  function SqlTab() {
    var root = null, els = {}, history = loadHistory();
    var catalog = null, expanded = {}, lastPayload = null, lastSql = "";
    var grid = null;

    // ------------------------------------------------------------- editor --

    function insertAtCursor(text) {
      var ta = els.editor;
      var start = ta.selectionStart, end = ta.selectionEnd;
      var before = ta.value.slice(0, start), after = ta.value.slice(end);
      // Space out identifiers so clicking two names in a row does not glue them.
      var sep = before && !/[\s(.,]$/.test(before) ? " " : "";
      ta.value = before + sep + text + after;
      var pos = start + sep.length + text.length;
      ta.setSelectionRange(pos, pos);
      ta.focus();
      persistDraft();
    }

    function persistDraft() {
      try { window.localStorage.setItem(DRAFT_KEY, els.editor.value); } catch (e) { /* ok */ }
    }

    function onEditorKey(ev) {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        runQuery();
        return;
      }
      if (ev.key === "Tab") {
        ev.preventDefault();
        var ta = els.editor;
        var start = ta.selectionStart, end = ta.selectionEnd;
        if (start === end) {
          ta.value = ta.value.slice(0, start) + "  " + ta.value.slice(end);
          ta.setSelectionRange(start + 2, start + 2);
        } else {
          // Indent or outdent whole lines for a block selection.
          var lineStart = ta.value.lastIndexOf("\n", start - 1) + 1;
          var block = ta.value.slice(lineStart, end);
          var out = ev.shiftKey
            ? block.replace(/^ {1,2}/gm, "")
            : block.replace(/^/gm, "  ");
          ta.value = ta.value.slice(0, lineStart) + out + ta.value.slice(end);
          ta.setSelectionRange(lineStart, lineStart + out.length);
        }
        persistDraft();
      }
    }

    // ------------------------------------------------------------- results --

    function setStatus(node) {
      U.clear(els.status);
      if (node) els.status.appendChild(node);
    }

    function showError(message) {
      U.clear(els.results);
      els.results.appendChild(el("div.col", null,
        el("div.err", { text: "query failed" }),
        el("div.err-msg", { text: String(message) })));
    }

    function runQuery() {
      var sql = els.editor.value.trim();
      if (!sql) { U.toast("nothing to run", "error"); return; }
      var limit = Number(els.limit.value) || 500;
      lastSql = sql;
      setStatus(el("span.readout", { text: "running ..." }));
      U.clear(els.results);
      els.results.appendChild(el("div.empty", null, el("span.spinner"), " running"));
      var t0 = Date.now();
      API.post("sql", { sql: sql, limit: limit }).then(function (payload) {
        lastPayload = payload;
        renderResult(payload, Date.now() - t0);
        pushHistory(sql, payload);
      }).catch(function (err) {
        lastPayload = null;
        setStatus(el("span.readout.err", { text: "error" }));
        showError(err.message || err);
      });
    }

    function renderResult(payload, wallMs) {
      U.clear(els.results);
      var n = (payload.rows || []).length;
      setStatus(el("span.readout", {
        text: U.n(n) + " row" + (n === 1 ? "" : "s") + " x " +
          (payload.columns || []).length + " cols, " +
          U.ms(payload.elapsed_ms === undefined ? wallMs : payload.elapsed_ms) +
          (payload.truncated ? ", truncated at the row limit" : "")
      }));
      if (!n) {
        els.results.appendChild(el("div.empty", null,
          el("span.empty-h", { text: "no rows" }),
          "the query ran but matched nothing"));
        return;
      }
      if (grid && grid.destroy) { try { grid.destroy(); } catch (e) { /* ok */ } grid = null; }
      var sql = lastSql, lim = Number(els.limit.value) || 500;
      grid = window.Chart && Chart.mountResult
        ? Chart.mountResult(els.results, payload, {
            emptyText: "no rows",
            exportSpec: function (fmt, scope) {
              return { source: "sql", sql: sql, limit: scope === "page" ? lim : null };
            },
            deriveSpec: function () { return { source: "sql", sql: sql, limit: null }; },
            deriveScopeText: "the full result of this query, not just the previewed rows"
          })
        : null;
      if (!grid && !els.results.firstChild) {
        els.results.appendChild(plainTable(payload));
      }
    }

    function plainTable(payload) {
      var cols = payload.columns || [], dtypes = payload.dtypes || [];
      var numeric = dtypes.map(function (d) { return /Int|Float|UInt|Decimal/.test(String(d)); });
      var wrap = el("div.dt-wrap");
      wrap.appendChild(el("table.dt", null,
        el("thead", null, el("tr", null, cols.map(function (c, i) {
          return el("th" + (numeric[i] ? ".num" : ""), { text: c, title: dtypes[i] || "" });
        }))),
        el("tbody", null, (payload.rows || []).map(function (r) {
          return el("tr", null, r.map(function (v, i) {
            return el("td" + (numeric[i] ? ".num" : "") +
              (v === null || v === undefined ? ".null" : ""), { text: U.cell(v) });
          }));
        }))));
      return wrap;
    }

    // ------------------------------------------------------------- history --

    function pushHistory(sql, payload) {
      history = history.filter(function (h) { return h.sql !== sql; });
      history.unshift({
        sql: sql, ts: Date.now(),
        rows: (payload.rows || []).length,
        ms: payload.elapsed_ms
      });
      history = history.slice(0, HISTORY_MAX);
      saveHistory(history);
      renderHistory();
    }

    function renderHistory() {
      U.clear(els.history);
      if (!history.length) {
        els.history.appendChild(el("div.hint", { text: "nothing run yet" }));
        return;
      }
      history.forEach(function (h) {
        els.history.appendChild(el("button.btn.sm.ghost.hist-item", {
          type: "button",
          title: h.sql + "\n\n" + U.n(h.rows) + " rows, " + U.ms(h.ms),
          style: { display: "block", width: "100%", textAlign: "left" },
          onclick: function () {
            els.editor.value = h.sql;
            persistDraft();
            els.editor.focus();
          }
        }, el("span.mono", { text: firstLine(h.sql) })));
      });
    }

    // ----------------------------------------------------------- reference --

    function renderReference() {
      U.clear(els.ref);
      if (!catalog) {
        els.ref.appendChild(el("div.empty", { text: "loading tables ..." }));
        return;
      }
      var groups = [
        { key: "derived", label: "derived tables",
          note: "saved results, queryable by name like any other table" },
        { key: "seasonal", label: "seasonal" },
        { key: "static", label: "static" }
      ];
      var byKind = {};
      catalog.datasets.forEach(function (d) {
        (byKind[d.kind] = byKind[d.kind] || []).push(d);
      });
      // Anything with an unexpected kind still gets listed.
      Object.keys(byKind).forEach(function (k) {
        if (!groups.some(function (g) { return g.key === k; })) groups.push({ key: k, label: k });
      });

      groups.forEach(function (g) {
        var list = byKind[g.key] || [];
        if (!list.length && g.key !== "derived") return;
        els.ref.appendChild(el("div.side-sec-h", { text: g.label }));
        if (g.note) els.ref.appendChild(el("div.hint", { text: g.note }));
        if (!list.length) {
          els.ref.appendChild(el("div.hint", {
            text: "none yet. Save a result as a dataset and it appears here."
          }));
          return;
        }
        list.forEach(function (d) { els.ref.appendChild(tableRow(d)); });
      });
    }

    function tableRow(d) {
      var body = el("div.ref-cols");
      body.hidden = !expanded[d.name];

      var head = el("div.row.tight", null,
        el("button.btn.sm.ghost", {
          type: "button", text: expanded[d.name] ? "-" : "+",
          title: "show columns", style: { minWidth: "22px" },
          onclick: function () {
            expanded[d.name] = !expanded[d.name];
            this.textContent = expanded[d.name] ? "-" : "+";
            body.hidden = !expanded[d.name];
            if (expanded[d.name] && !body.firstChild) loadColumns(d.name, body);
          }
        }),
        el("button.btn.sm.ghost.mono", {
          type: "button", text: d.name, title: (d.note || "") + "\nclick to insert the table name",
          onclick: function () { insertAtCursor(d.name); }
        }),
        el("span.hint", { text: d.cols + " cols, " + U.compact(d.rows) + " rows" }));

      if (expanded[d.name]) loadColumns(d.name, body);
      return el("div.ref-table", null, head, body);
    }

    function loadColumns(name, host) {
      U.clear(host);
      host.appendChild(el("div.hint", { text: "loading ..." }));
      API.get("schema", { dataset: name }).then(function (sc) {
        U.clear(host);
        host.appendChild(el("div.toggle-list", null, (sc.columns || []).map(function (c) {
          return el("button.btn.sm.ghost.mono", {
            type: "button", title: c.dtype + " (" + c.kind + ")",
            style: { display: "block", width: "100%", textAlign: "left" },
            onclick: function () { insertAtCursor(c.name); }
          }, el("span", { text: c.name }), el("span.kind", { text: " " + c.dtype }));
        })));
      }).catch(function (e) {
        U.clear(host);
        host.appendChild(el("div.err-msg", { text: String(e.message || e) }));
      });
    }

    function loadCatalog() {
      API.get("catalog").then(function (c) {
        catalog = c;
        renderReference();
      }).catch(function (e) {
        U.clear(els.ref);
        els.ref.appendChild(el("div.err-msg", { text: String(e.message || e) }));
      });
    }

    // ------------------------------------------------------------- actions --

    function saveView() {
      var sql = els.editor.value.trim();
      if (!sql) { U.toast("nothing to save", "error"); return; }
      var payload = { kind: "sql", name: firstLine(sql), payload: { sql: sql, limit: Number(els.limit.value) || 500 } };
      if (window.App && typeof App.saveView === "function") { App.saveView(payload); return; }
      var name = window.prompt("Save this query as:", payload.name);
      if (!name) return;
      API.post("views", { name: name, kind: "sql", payload: payload.payload })
        .then(function () { U.toast("saved view: " + name); })
        .catch(function (e) { U.toast(e.message || e, "error"); });
    }

    function saveAsDataset() {
      var sql = (lastSql || els.editor.value).trim();
      if (!sql) { U.toast("run a query first", "error"); return; }
      var spec = { source: "sql", sql: sql, limit: null };
      var meta = {
        name: "", note: firstLine(sql),
        scopeText: "Writes the full result of this query, not just the previewed rows.",
        scopes: [
          { id: "all", label: "full result", limit: null },
          { id: "preview", label: "previewed rows only", limit: Number(els.limit.value) || 500 }
        ],
        defaultScope: "all"
      };
      var done = function () { loadCatalog(); };
      if (window.Chart && Chart.saveDataset) {
        var r = Chart.saveDataset(spec, meta, done);
        if (r && r.then) r.then(function (res) { if (res) done(); });
      } else {
        U.toast("save as dataset is unavailable", "error");
      }
    }

    function exportCsv() {
      var sql = (lastSql || els.editor.value).trim();
      if (!sql) { U.toast("run a query first", "error"); return; }
      API.postDownload("export", {
        source: "sql", sql: sql, format: "csv",
        limit: Number(els.limit.value) || 500, filename: "query.csv"
      }, "query.csv").then(function (r) {
        if (r.truncated) U.toast("export truncated at the row cap");
      }).catch(function (e) { U.toast(e.message || e, "error"); });
    }

    // -------------------------------------------------------------- mount --

    function mount(node) {
      root = node;
      U.clear(root);
      root.classList.add("row", "top");   // additive: .tabhost must survive
      root.style.display = "flex";
      root.style.flexDirection = "row";    // .tabhost is a column, this pane is not
      root.style.alignItems = "stretch";
      root.style.gap = "10px";
      root.style.padding = "10px";
      root.style.overflow = "hidden";
      root.style.flex = "1 1 auto";
      root.style.minHeight = "0";

      els.ref = el("div.col");
      var refPanel = el("div.panel.panel-b.col", {
        style: { width: "236px", flex: "0 0 236px", overflow: "auto" }
      }, el("div.side-sec-h", { text: "tables" }), els.ref);

      els.editor = el("textarea.textarea", {
        rows: 9, spellcheck: "false", "aria-label": "SQL query",
        placeholder: "select posteam, avg(epa) as epa from pbp where season = 2024 group by posteam",
        onkeydown: onEditorKey,
        oninput: persistDraft
      });
      try {
        var draft = window.localStorage.getItem(DRAFT_KEY);
        if (draft) els.editor.value = draft;
      } catch (e) { /* ok */ }

      els.limit = el("select.select.sm", { "aria-label": "row limit" },
        LIMITS.map(function (n) {
          return el("option", { value: String(n), text: U.n(n) + " rows" });
        }));
      els.limit.value = "500";

      els.status = el("span.readout");
      els.results = el("div.col", { style: { flex: "1 1 auto", minHeight: "0", overflow: "auto" } });
      els.history = el("div.col");

      var exampleChips = el("div.chips", null,
        el("span.field-label", { text: "examples" }),
        EXAMPLES.map(function (ex) {
          return el("button.chip", {
            type: "button", text: ex.label, title: ex.sql,
            onclick: function () {
              els.editor.value = ex.sql;
              persistDraft();
              els.editor.focus();
              runQuery();
            }
          });
        }));

      var actions = el("div.row.wrap", null,
        el("button.btn.primary", { type: "button", text: "run", onclick: runQuery }),
        el("span.hint", { text: navigator.platform.indexOf("Mac") >= 0 ? "Cmd+Enter" : "Ctrl+Enter" }),
        els.limit,
        el("button.btn", { type: "button", text: "save view", onclick: saveView }),
        el("button.btn", {
          type: "button", text: "save as dataset",
          title: "write this result to data/derived, then query it by name here",
          onclick: saveAsDataset
        }),
        el("button.btn.ghost", { type: "button", text: "export csv", onclick: exportCsv }),
        el("button.btn.ghost", {
          type: "button", text: "clear history",
          onclick: function () { history = []; saveHistory(history); renderHistory(); }
        }),
        els.status);

      var main = el("div.col", {
        style: { flex: "1 1 auto", minWidth: "0", minHeight: "0", overflow: "hidden" }
      },
        el("div.panel.panel-b.col", null, exampleChips, els.editor, actions),
        el("div.panel.col", {
          style: { flex: "1 1 auto", minHeight: "0", overflow: "hidden" }
        }, els.results));

      var histPanel = el("div.panel.panel-b.col", {
        style: { width: "220px", flex: "0 0 220px", overflow: "auto" }
      }, el("div.side-sec-h", { text: "history" }), els.history);

      root.appendChild(refPanel);
      root.appendChild(main);
      root.appendChild(histPanel);

      renderHistory();
      loadCatalog();
    }

    return {
      id: "sql", label: "SQL", key: "q",
      mount: mount,
      onDatasetChange: function (name) {
        // The console is not bound to the active dataset, but a fresh catalog
        // keeps the table list honest after a derived dataset is saved.
        if (!root) return;
        if (catalog && !catalog.datasets.some(function (d) { return d.name === name; })) {
          loadCatalog();
        }
      },
      onShow: function () { if (root) loadCatalog(); },
      getViewPayload: function () {
        return {
          kind: "sql", name: firstLine(els.editor.value || "query"),
          payload: { sql: els.editor.value, limit: Number(els.limit.value) || 500 }
        };
      },
      onRestore: function (payload) {
        if (!payload || !root) return;
        var sql = payload.sql || (payload.payload && payload.payload.sql);
        if (!sql) return;
        els.editor.value = sql;
        if (payload.limit) els.limit.value = String(payload.limit);
        persistDraft();
        runQuery();
      }
    };
  }

  if (window.Tabs && Tabs.register) Tabs.register(SqlTab());
})();
