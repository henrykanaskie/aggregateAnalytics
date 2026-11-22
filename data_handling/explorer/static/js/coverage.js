/* coverage.js -- the Coverage tab: season by dataset heatmap.

   The interactive successor to the static grid in data_handling/profile.py.
   The thing worth reading here is the ragged left edge: the first shaded cell
   in a row is where that dataset's usable history actually starts, whatever
   the play-by-play goes back to. Everything on this screen is arranged to
   make that edge obvious. */
(function () {
  "use strict";

  var el = U.el;

  var SORTS = [
    ["start", "first season"],
    ["name", "name"],
    ["total", "total rows"],
    ["peak", "peak season"]
  ];

  function firstSeason(d) {
    var years = Object.keys(d.counts || {}).map(Number).filter(function (y) {
      return d.counts[String(y)] > 0;
    });
    return years.length ? Math.min.apply(null, years) : null;
  }

  function lastSeason(d) {
    var years = Object.keys(d.counts || {}).map(Number).filter(function (y) {
      return d.counts[String(y)] > 0;
    });
    return years.length ? Math.max.apply(null, years) : null;
  }

  function CoverageTab() {
    var root = null, els = {}, data = null, sortKey = "start", sortDir = 1;

    function goBrowse(name, year) {
      if (window.App && typeof App.setDataset === "function") App.setDataset(name);
      else Store.set("dataset", name);
      if (window.App && typeof App.showTab === "function") App.showTab("browse");
      // Let the grid mount and pick up the new dataset before filtering.
      setTimeout(function () {
        if (window.App && typeof App.insertFilter === "function") {
          App.insertFilter("season", "=", year);
        } else {
          window.dispatchEvent(new CustomEvent("explorer:filter", {
            detail: { col: "season", op: "=", value: year }
          }));
        }
      }, 60);
    }

    function sorted(list) {
      var out = list.slice();
      out.sort(function (a, b) {
        var av, bv;
        if (sortKey === "name") { av = a.name; bv = b.name; }
        else if (sortKey === "total") { av = a.total || 0; bv = b.total || 0; }
        else if (sortKey === "peak") { av = a.peak || 0; bv = b.peak || 0; }
        else {
          av = firstSeason(a); bv = firstSeason(b);
          if (av === null) av = 9999;
          if (bv === null) bv = 9999;
          // Tie-break on the longer history first, so the staircase reads clean.
          if (av === bv) { av = -(a.total || 0); bv = -(b.total || 0); }
        }
        if (av < bv) return -sortDir;
        if (av > bv) return sortDir;
        return a.name < b.name ? -1 : 1;
      });
      return out;
    }

    function cellTip(name, year, n, peak) {
      if (!n) return name + " " + year + "\nno data";
      return name + " " + year + "\n" + U.n(n) + " rows" +
        "\n" + Math.round(100 * n / peak) + "% of this dataset's peak season";
    }

    function render() {
      U.clear(els.grid);
      if (!data) {
        els.grid.appendChild(el("div.empty", { text: "loading coverage ..." }));
        return;
      }
      var years = data.seasons || [];
      var seasonal = (data.datasets || []).filter(function (d) {
        return d.counts && Object.keys(d.counts).length;
      });
      var flat = (data.datasets || []).filter(function (d) {
        return !d.counts || !Object.keys(d.counts).length;
      });

      var head = el("tr", null,
        el("th.lbl", null, el("span.field-label", { text: "dataset" })),
        el("th.rowsub", { text: "from" }),
        years.map(function (y) {
          return el("th", { title: String(y), text: String(y).slice(2) });
        }),
        el("th.rowsub", { text: "rows" }));

      var body = sorted(seasonal).map(function (d) {
        var start = firstSeason(d);
        var end = lastSeason(d);
        var peak = d.peak || Math.max.apply(null,
          Object.keys(d.counts).map(function (k) { return d.counts[k]; })) || 1;

        var cells = years.map(function (y) {
          var n = d.counts[String(y)] || 0;
          var box = el("div.cell");
          if (n > 0) {
            // Opacity encodes rows that season relative to this dataset's peak.
            box.style.background = "var(--full)";
            box.style.opacity = (0.32 + 0.68 * Math.min(1, n / peak)).toFixed(2);
            box.style.cursor = "pointer";
            box.setAttribute("tabindex", "0");
            box.setAttribute("role", "button");
          } else {
            // Absent stays flat --none and is never given the ramp colour, so
            // "missing" and "thin but present" can never be confused.
            box.style.background = "var(--none)";
          }
          if (y === start) {
            // The whole point of the view: mark where usable history starts.
            box.style.boxShadow = "inset 2px 0 0 var(--ink)";
          }
          var tip = cellTip(d.name, y, n, peak);
          box.title = tip;
          if (n > 0) {
            box.addEventListener("mouseenter", function (e) {
              if (window.Chart) Chart.showTip(tip, e.pageX, e.pageY);
            });
            box.addEventListener("mousemove", function (e) {
              if (window.Chart) Chart.moveTip(e.pageX, e.pageY);
            });
            box.addEventListener("mouseleave", function () {
              if (window.Chart) Chart.hideTip();
            });
            box.addEventListener("click", function () { goBrowse(d.name, y); });
            box.addEventListener("keydown", function (ev) {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                goBrowse(d.name, y);
              }
            });
          }
          return el("td", null, box);
        });

        var late = start !== null && start >= 2013;
        return el("tr", null,
          el("td.lbl", null,
            el("button.btn.sm.ghost.mono", {
              type: "button", text: d.name,
              title: "open " + d.name + " in Browse",
              onclick: function () {
                if (window.App && App.setDataset) App.setDataset(d.name);
                else Store.set("dataset", d.name);
                if (window.App && App.showTab) App.showTab("browse");
              }
            })),
          el("td.rowsub" + (late ? ".warn" : ""), {
            text: start === null ? "·" : String(start),
            title: start === null ? "" :
              d.name + " covers " + start + " to " + end +
              (late ? ", so anything before " + start + " has no history here" : "")
          }),
          cells,
          el("td.rowsub", { text: U.compact(d.total) }));
      });

      els.grid.appendChild(el("table.cov", null,
        el("thead", null, head), el("tbody", null, body)));

      if (flat.length) {
        els.grid.appendChild(el("div.side-sec-h", { text: "no season dimension" }));
        var chips = el("div.chips");
        flat.forEach(function (d) {
          chips.appendChild(el("button.chip", {
            type: "button",
            title: d.name + ": " + U.n(d.total) + " rows, not split by season",
            onclick: function () {
              if (window.App && App.setDataset) App.setDataset(d.name);
              else Store.set("dataset", d.name);
              if (window.App && App.showTab) App.showTab("browse");
            }
          }, el("span.chip-k", { text: d.name }),
             el("span.chip-v", { text: U.compact(d.total) })));
        });
        els.grid.appendChild(chips);
      }

      renderCallout(seasonal, years);
    }

    /** The ragged left edge, stated in words as well as drawn. */
    function renderCallout(seasonal, years) {
      U.clear(els.callout);
      if (!seasonal.length) return;
      var lo = years.length ? years[0] : null;
      var late = seasonal
        .map(function (d) { return { name: d.name, start: firstSeason(d), total: d.total }; })
        .filter(function (d) { return d.start !== null && d.start > lo; })
        .sort(function (a, b) { return b.start - a.start; });

      var full = seasonal.length - late.length;
      els.callout.appendChild(el("div.kpi", null,
        el("div", null,
          el("span.v", { text: String(seasonal.length) }),
          el("span.k", { text: "seasonal datasets" })),
        el("div", null,
          el("span.v", { text: String(full) }),
          el("span.k", { text: "reaching back to " + lo })),
        el("div", null,
          el("span.v" + (late.length ? ".warn" : ""), { text: String(late.length) }),
          el("span.k", { text: "starting later" })),
        el("div", null,
          el("span.v", { text: U.compact(data.totals ? data.totals.rows :
            seasonal.reduce(function (a, d) { return a + (d.total || 0); }, 0)) }),
          el("span.k", { text: "rows across seasons" }))));

      if (!late.length) return;
      var chips = el("div.chips", null,
        el("span.field-label", { text: "history starts at" }));
      late.slice(0, 24).forEach(function (d) {
        chips.appendChild(el("button.chip", {
          type: "button",
          title: d.name + " has nothing before " + d.start +
            ". Click to browse its first season.",
          onclick: function () { goBrowse(d.name, d.start); }
        }, el("span.chip-k", { text: d.name }),
           el("span.chip-v", { text: String(d.start) })));
      });
      els.callout.appendChild(chips);
    }

    function legend() {
      function sw(bg, opacity) {
        return el("span.sw", { style: { background: bg, opacity: opacity || 1 } });
      }
      return el("div.legend", null,
        el("span", null, sw("var(--none)"), " no data that season"),
        el("span", null, sw("var(--full)", "0.34"), " thin season"),
        el("span", null, sw("var(--full)", "1"), " peak season"),
        el("span", null,
          el("span.sw", { style: { background: "var(--none)", boxShadow: "inset 2px 0 0 var(--ink)" } }),
          " first season on record"),
        el("span.hint", { text: "shade is relative to each dataset's own peak, not across datasets" }));
    }

    function load() {
      U.clear(els.grid);
      els.grid.appendChild(el("div.empty", null, el("span.spinner"), " reading Parquet metadata"));
      API.get("coverage").then(function (res) {
        data = res;
        render();
      }).catch(function (err) {
        U.clear(els.grid);
        els.grid.appendChild(el("div.err-msg", { text: String(err.message || err) }));
        U.toast(err.message || err, "error");
      });
    }

    function mount(node) {
      root = node;
      U.clear(root);
      root.classList.add("col");   // additive: .tabhost must survive
      root.style.overflow = "auto";
      root.style.padding = "10px";
      root.style.gap = "10px";

      els.sort = el("select.select.sm", { "aria-label": "sort datasets" },
        SORTS.map(function (p) { return el("option", { value: p[0], text: p[1] }); }));
      els.sort.value = sortKey;
      els.sort.addEventListener("change", function () {
        sortKey = els.sort.value;
        sortDir = sortKey === "name" || sortKey === "start" ? 1 : -1;
        els.dir.textContent = sortDir > 0 ? "ascending" : "descending";
        render();
      });
      els.dir = el("button.btn.sm.ghost", {
        type: "button", text: "ascending",
        title: "flip the sort direction",
        onclick: function () {
          sortDir = -sortDir;
          els.dir.textContent = sortDir > 0 ? "ascending" : "descending";
          render();
        }
      });
      els.callout = el("div.col");
      els.grid = el("div.dt-wrap");

      root.appendChild(el("div.panel.panel-b.col", null,
        el("div.panel-note", {
          text: "Read the left edge first. The first shaded cell in a row is " +
            "where that dataset's usable history actually starts, and it is the " +
            "real constraint on any feature built from it. Click a cell to browse " +
            "that dataset and season."
        }),
        els.callout,
        el("div.field-row", null,
          el("div.field", null, el("label.field-label", { text: "sort by" }), els.sort),
          el("div.field", null, el("label.field-label", { text: "order" }), els.dir),
          el("div.field", null,
            el("label.field-label", { text: " " }),
            el("button.btn.sm", { type: "button", text: "reload", onclick: load })))));

      root.appendChild(el("div.panel.panel-b.col", null, legend(), els.grid));
      load();
    }

    return {
      id: "coverage", label: "Coverage", key: "v",
      mount: mount,
      onDatasetChange: function () { /* the heatmap spans every dataset */ },
      onShow: function () { if (root && !data) load(); },
      getViewPayload: function () {
        return { kind: "rows", name: "coverage", payload: { tab: "coverage", sort: sortKey } };
      },
      onRestore: function (payload) {
        if (payload && payload.sort) {
          sortKey = payload.sort;
          if (els.sort) els.sort.value = sortKey;
          render();
        }
      }
    };
  }

  if (window.Tabs && Tabs.register) Tabs.register(CoverageTab());
})();
