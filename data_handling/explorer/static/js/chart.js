/* chart.js -- hand-rolled SVG charts (bar, line, scatter, histogram) plus the
   Chart builder tab over POST /api/aggregate.

   Loads before the other tab modules: window.Chart must exist at load time.
   No libraries, no CDN, no CSS of its own. Colors come from CSS custom
   properties so light and dark themes both work from one palette. */
(function () {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";

  // ------------------------------------------------------------- svg utils --
  function s(name, attrs, kids) {
    var n = document.createElementNS(NS, name);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        n.setAttribute(k, v === true ? "" : String(v));
      }
    }
    if (kids !== null && kids !== undefined) {
      var list = Array.isArray(kids) ? kids : [kids];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c === null || c === undefined || c === false) continue;
        n.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
      }
    }
    return n;
  }

  function titled(node, text) {
    node.appendChild(s("title", null, String(text)));
    return node;
  }

  /** Rough text width for layout. 0.58em average for the UI font at `px`. */
  function textW(str, px) {
    return String(str === null || str === undefined ? "" : str).length * (px || 11) * 0.58;
  }

  function truncate(str, n) {
    var v = String(str === null || str === undefined ? "" : str);
    return v.length <= n ? v : v.slice(0, Math.max(1, n - 1)) + "…";
  }

  // --------------------------------------------------------------- palette --
  var FALLBACK = {
    ink: "#14171A", muted: "#5D666E", rule: "#D6DADD", paper: "#F6F7F7",
    panel: "#FFFFFF", steel: "#2C5F7C", full: "#1F6F4A", part: "#B8860B",
    bad: "#9B2C2C", none: "#E8EAEC"
  };

  /** Read the live theme from CSS custom properties on :root. */
  function palette(host) {
    var root = document.documentElement;
    var cs = getComputedStyle(root);
    var hs = host && host.nodeType === 1 ? getComputedStyle(host) : null;
    function v(name, fb) {
      var x = cs.getPropertyValue(name);
      if ((!x || !x.trim()) && hs) x = hs.getPropertyValue(name);
      x = x && x.trim();
      return x || fb;
    }
    var p = {
      ink: v("--ink", FALLBACK.ink),
      muted: v("--muted", FALLBACK.muted),
      rule: v("--rule", FALLBACK.rule),
      paper: v("--paper", FALLBACK.paper),
      panel: v("--panel", FALLBACK.panel),
      steel: v("--steel", FALLBACK.steel),
      full: v("--full", FALLBACK.full),
      part: v("--part", FALLBACK.part),
      bad: v("--bad", FALLBACK.bad),
      none: v("--none", FALLBACK.none)
    };
    // Series ramp: app.css defines --c0 .. --c5 in both themes.
    var fb = ["#2C5F7C", "#B8860B", "#1F6F4A", "#9B2C2C", "#5B4B8A", "#7A6A55"];
    var ramp = [];
    for (var i = 0; i < 6; i++) ramp.push(v("--c" + i, fb[i]));
    p.series = ramp;
    p.faint = v("--faint", p.muted);
    p.warn = v("--warn", "#8A5A00");
    p.ok = v("--ok", p.full);
    return p;
  }

  // ---------------------------------------------------------- nice numbers --
  function niceNum(x, round) {
    if (!isFinite(x) || x <= 0) return 1;
    var exp = Math.floor(Math.log10(x));
    var f = x / Math.pow(10, exp);
    var nf;
    if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
    else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * Math.pow(10, exp);
  }

  /** Loose-labelled axis: expands [min,max] to round numbers, returns ticks. */
  function niceScale(min, max, maxTicks, opts) {
    opts = opts || {};
    if (min === null || min === undefined || !isFinite(min)) min = 0;
    if (max === null || max === undefined || !isFinite(max)) max = min + 1;
    if (max < min) { var t = min; min = max; max = t; }
    if (opts.zeroBase) { if (min > 0) min = 0; if (max < 0) max = 0; }
    if (min === max) {
      // All-identical values: pad symmetrically so the mark is not on the edge.
      var pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
      min -= pad; max += pad;
    }
    maxTicks = Math.max(2, maxTicks || 6);
    var range = niceNum(max - min, false);
    var step = niceNum(range / (maxTicks - 1), true);
    var lo = Math.floor(min / step) * step;
    var hi = Math.ceil(max / step) * step;
    if (opts.integer && step < 1) step = 1;
    var ticks = [];
    var eps = step * 1e-9;
    for (var v = lo; v <= hi + eps; v += step) ticks.push(Math.abs(v) < eps ? 0 : v);
    if (ticks.length > 40) ticks = ticks.slice(0, 40);
    return { lo: lo, hi: hi, step: step, ticks: ticks };
  }

  /** How many ticks an axis of `px` pixels can carry without crowding. */
  function tickBudget(px, per) {
    return Math.max(2, Math.min(12, Math.floor(px / (per || 72))));
  }

  /** Tick formatter chosen from the step size, so 0.05 steps keep 2 decimals. */
  function tickFormatter(step, override) {
    if (typeof override === "function") return override;
    var a = Math.abs(step);
    var d = a >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(a)));
    return function (v) {
      if (v === null || v === undefined || !isFinite(v)) return "";
      if (Math.abs(v) >= 1e5) return window.U ? U.compact(v) : String(v);
      var out = v.toFixed(d);
      return out === "-0" ? "0" : out;
    };
  }

  function fmtValue(v) {
    if (window.U && U.cell) return U.cell(v);
    return v === null || v === undefined ? "·" : String(v);
  }

  // --------------------------------------------------------------- tooltip --
  /* One shared tooltip node on <body>, styled by app.css `.chart-tip`
     (position: absolute), so coordinates are page-relative. */
  var TIP = null;
  function tipNode() {
    if (TIP && TIP.isConnected) return TIP;
    TIP = document.createElement("div");
    TIP.className = "chart-tip";
    TIP.hidden = true;
    document.body.appendChild(TIP);
    return TIP;
  }

  function showTip(text, x, y) {
    var t = tipNode();
    t.textContent = text;
    t.hidden = false;
    moveTip(x, y);
  }

  function moveTip(x, y) {
    if (!TIP || TIP.hidden) return;
    var w = TIP.offsetWidth || 160, h = TIP.offsetHeight || 30;
    var left = x + 14, top = y + 16;
    if (left + w > window.scrollX + window.innerWidth - 8) left = x - w - 14;
    if (top + h > window.scrollY + window.innerHeight - 8) top = y - h - 12;
    TIP.style.left = Math.max(2, left) + "px";
    TIP.style.top = Math.max(2, top) + "px";
  }

  function hideTip() { if (TIP) TIP.hidden = true; }

  /** Wire hover / focus tooltip behaviour onto one mark. */
  function hoverable(node, text) {
    titled(node, text);
    node.addEventListener("mouseenter", function (e) { showTip(text, e.pageX, e.pageY); });
    node.addEventListener("mousemove", function (e) { moveTip(e.pageX, e.pageY); });
    node.addEventListener("mouseleave", hideTip);
    node.addEventListener("focus", function () {
      var r = node.getBoundingClientRect();
      showTip(text, r.left + window.scrollX + r.width / 2, r.top + window.scrollY);
    });
    node.addEventListener("blur", hideTip);
    return node;
  }

  // ------------------------------------------------------------ responsive --
  /** Build an <svg> that redraws itself on container resize and theme flips. */
  function responsive(spec, draw) {
    var H = Math.max(40, spec.height || 260);
    var svg = s("svg", {
      "class": "chart" + (spec.className ? " " + spec.className : ""),
      height: H,
      role: "img",
      "aria-label": spec.ariaLabel || spec.title || "chart",
      preserveAspectRatio: "xMidYMid meet"
    });
    svg.style.display = "block";
    svg.style.overflow = "visible";

    var lastW = -1;
    function render(w) {
      var W = Math.max(140, Math.round(w || spec.width || 640));
      if (W === lastW) return;
      lastW = W;
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      try { draw(svg, W, H, palette(svg.parentNode || document.body)); }
      catch (err) {
        console.error("chart render failed", err);
        svg.appendChild(s("text", {
          x: 10, y: 20, "class": "chart-empty", fill: FALLBACK.muted, "font-size": 12
        }, "chart error: " + (err && err.message ? err.message : err)));
      }
    }

    if (spec.width) {
      svg.style.width = spec.width + "px";
      svg.setAttribute("width", spec.width);
      render(spec.width);
    } else {
      svg.style.width = "100%";
      render(640);
      if (typeof ResizeObserver === "function") {
        var ro = new ResizeObserver(function (entries) {
          var w = entries[0] && entries[0].contentRect.width;
          if (w > 0) render(w);
        });
        // Observe after attach so the first measurement is a real layout.
        requestAnimationFrame(function () { try { ro.observe(svg); } catch (e) { /* detached */ } });
        svg.__ro = ro;
      }
    }

    // Theme flip: force a redraw so palette() is re-read.
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onTheme = function () { var w = lastW; lastW = -1; render(w); };
      if (mq.addEventListener) mq.addEventListener("change", onTheme);
      else if (mq.addListener) mq.addListener(onTheme);
    }

    svg.__redraw = function () { var w = lastW; lastW = -1; render(w); };
    return svg;
  }

  function emptyChart(spec, message) {
    return responsive(spec, function (svg, W, H, p) {
      svg.appendChild(s("text", {
        x: W / 2, y: H / 2, "class": "chart-empty", fill: p.faint || p.muted,
        "text-anchor": "middle", "font-size": 12.5
      }, message || "no data"));
    });
  }

  // ----------------------------------------------------------- axis pieces --
  function gridlines(g, p, opts) {
    // opts: {x1,x2,y1,y2, vertical, positions}
    opts.positions.forEach(function (v) {
      var a = opts.vertical
        ? { x1: v, x2: v, y1: opts.y1, y2: opts.y2 }
        : { x1: opts.x1, x2: opts.x2, y1: v, y2: v };
      g.appendChild(s("line", {
        "class": "gridline", x1: a.x1, x2: a.x2, y1: a.y1, y2: a.y2,
        stroke: p.rule, "stroke-width": 1, "shape-rendering": "crispEdges"
      }));
    });
  }

  function axisText(x, y, text, p, extra) {
    var a = {
      "class": "tick-label", x: x, y: y, fill: p.muted, "font-size": 10.5,
      "font-family": "ui-monospace,SFMono-Regular,Menlo,monospace"
    };
    for (var k in extra || {}) a[k] = extra[k];
    return s("text", a, text);
  }

  function axisLabel(x, y, text, p, rotate) {
    return s("text", {
      "class": "axis-label", x: x, y: y, fill: p.muted, "font-size": 11,
      "text-anchor": "middle",
      transform: rotate ? "rotate(-90 " + x + " " + y + ")" : null
    }, text);
  }

  // ------------------------------------------------------------------- bar --
  /**
   * Chart.bar({data:[{label, value, note?}], height, xLabel, yLabel,
   *            horizontal, color, valueFormat, zeroBase})
   */
  function bar(spec) {
    spec = spec || {};
    var data = (spec.data || []).filter(function (d) { return d && d.label !== undefined; });
    if (!data.length) return emptyChart(spec, spec.emptyText || "no rows to chart");

    var horizontal = !!spec.horizontal;
    var vals = data.map(function (d) { return typeof d.value === "number" && isFinite(d.value) ? d.value : null; });
    var present = vals.filter(function (v) { return v !== null; });
    if (!present.length) return emptyChart(spec, "all values are null");

    return responsive(spec, function (svg, W, H, p) {
      var color = spec.color || p.steel;
      var vmin = Math.min.apply(null, present);
      var vmax = Math.max.apply(null, present);
      var sc = niceScale(vmin, vmax, horizontal ? 6 : 6,
        { zeroBase: spec.zeroBase !== false });
      var fmt = tickFormatter(sc.step, spec.valueFormat);

      var maxTickW = Math.max.apply(null, sc.ticks.map(function (t) { return textW(fmt(t), 10.5); }));

      if (horizontal) {
        var labelW = Math.min(180, Math.max.apply(null,
          data.map(function (d) { return textW(truncate(d.label, 26), 10.5); })) + 10);
        var m = { t: 10, r: 16, b: (spec.xLabel ? 34 : 22), l: labelW + (spec.yLabel ? 14 : 0) };
        var pw = Math.max(20, W - m.l - m.r), ph = Math.max(20, H - m.t - m.b);
        var x = function (v) { return m.l + (v - sc.lo) / (sc.hi - sc.lo || 1) * pw; };
        var band = ph / data.length;
        var bh = Math.max(2, Math.min(26, band * 0.72));

        gridlines(svg, p, {
          vertical: true, y1: m.t, y2: m.t + ph,
          positions: sc.ticks.map(x)
        });
        sc.ticks.forEach(function (t) {
          svg.appendChild(axisText(x(t), m.t + ph + 13, fmt(t), p, { "text-anchor": "middle" }));
        });

        var zero = x(sc.lo <= 0 && sc.hi >= 0 ? 0 : sc.lo);
        data.forEach(function (d, i) {
          var cy = m.t + i * band + band / 2;
          svg.appendChild(axisText(m.l - 7, cy + 3.5, truncate(d.label, 26), p,
            { "text-anchor": "end" }));
          if (vals[i] === null) return;
          var xv = x(vals[i]);
          var rect = s("rect", {
            "class": "mark bar", x: Math.min(zero, xv), y: cy - bh / 2,
            width: Math.max(1, Math.abs(xv - zero)), height: bh,
            fill: color, rx: 1, tabindex: 0
          });
          hoverable(rect, d.label + "\n" + (spec.valueName || "value") + ": " + fmtValue(d.value) +
            (d.note ? "\n" + d.note : ""));
          svg.appendChild(rect);
        });
        svg.appendChild(s("line", {
          "class": "axis-line", x1: zero, x2: zero, y1: m.t, y2: m.t + ph,
          stroke: p.ink, "stroke-width": 1, "shape-rendering": "crispEdges"
        }));
        if (spec.xLabel) svg.appendChild(axisLabel(m.l + pw / 2, H - 4, spec.xLabel, p));
      } else {
        var rotate = false, tickFont = 10.5;
        var maxLabelW = Math.max.apply(null, data.map(function (d) { return textW(d.label, tickFont); }));
        var slotW = (W - 60) / data.length;
        rotate = maxLabelW > slotW - 3;
        var maxChars = rotate ? 18 : Math.max(2, Math.floor(slotW / (tickFont * 0.58)));
        var bottom = (rotate ? Math.min(86, 16 + Math.min(maxLabelW, 18 * tickFont * 0.58)) : 20)
          + (spec.xLabel ? 16 : 6);
        var m2 = { t: 10, r: 12, b: bottom, l: Math.max(34, maxTickW + 10) + (spec.yLabel ? 14 : 0) };
        var pw2 = Math.max(20, W - m2.l - m2.r), ph2 = Math.max(20, H - m2.t - m2.b);
        var y = function (v) { return m2.t + ph2 - (v - sc.lo) / (sc.hi - sc.lo || 1) * ph2; };
        var band2 = pw2 / data.length;
        var bw = Math.max(1, Math.min(48, band2 * 0.72));

        gridlines(svg, p, {
          vertical: false, x1: m2.l, x2: m2.l + pw2,
          positions: sc.ticks.map(y)
        });
        sc.ticks.forEach(function (t) {
          svg.appendChild(axisText(m2.l - 7, y(t) + 3.5, fmt(t), p, { "text-anchor": "end" }));
        });

        var zeroY = y(sc.lo <= 0 && sc.hi >= 0 ? 0 : sc.lo);
        data.forEach(function (d, i) {
          var cx = m2.l + i * band2 + band2 / 2;
          var lbl = truncate(d.label, maxChars);
          var ty = m2.t + ph2 + (rotate ? 12 : 14);
          svg.appendChild(titled(axisText(rotate ? cx : cx, ty, lbl, p, {
            "text-anchor": rotate ? "end" : "middle",
            transform: rotate ? "rotate(-45 " + cx + " " + ty + ")" : null
          }), String(d.label)));
          if (vals[i] === null) return;
          var yv = y(vals[i]);
          var r2 = s("rect", {
            "class": "mark bar", x: cx - bw / 2, y: Math.min(zeroY, yv),
            width: bw, height: Math.max(1, Math.abs(yv - zeroY)),
            fill: color, rx: 1, tabindex: 0
          });
          hoverable(r2, d.label + "\n" + (spec.valueName || "value") + ": " + fmtValue(d.value) +
            (d.note ? "\n" + d.note : ""));
          svg.appendChild(r2);
        });
        svg.appendChild(s("line", {
          "class": "axis-line", x1: m2.l, x2: m2.l + pw2, y1: zeroY, y2: zeroY,
          stroke: p.ink, "stroke-width": 1, "shape-rendering": "crispEdges"
        }));
        if (spec.yLabel) svg.appendChild(axisLabel(11, m2.t + ph2 / 2, spec.yLabel, p, true));
        if (spec.xLabel) svg.appendChild(axisLabel(m2.l + pw2 / 2, H - 3, spec.xLabel, p));
      }
    });
  }

  // ------------------------------------------------------------------ line --
  /**
   * Chart.line({series:[{name, points:[{x,y}]}], height, xLabel, yLabel,
   *             xFormat, yFormat, xCategories})
   * Nulls in a series break the path rather than interpolating across them.
   */
  function line(spec) {
    spec = spec || {};
    var series = spec.series || (spec.data ? [{ name: spec.name || "", points: spec.data }] : []);
    series = series.filter(function (se) { return se && se.points && se.points.length; });
    var total = series.reduce(function (a, se) { return a + se.points.length; }, 0);
    if (!total) return emptyChart(spec, spec.emptyText || "no rows to chart");

    var xs = [], ys = [];
    series.forEach(function (se) {
      se.points.forEach(function (pt) {
        var px = pt.x, py = pt.y;
        if (typeof px === "number" && isFinite(px)) xs.push(px);
        if (typeof py === "number" && isFinite(py)) ys.push(py);
      });
    });
    if (!ys.length) return emptyChart(spec, "all values are null");
    if (!xs.length) return emptyChart(spec, "no numeric x values");

    return responsive(spec, function (svg, W, H, p) {
      var ysc = niceScale(Math.min.apply(null, ys), Math.max.apply(null, ys), 6, { zeroBase: !!spec.zeroBase });
      var yfmt = tickFormatter(ysc.step, spec.yFormat);
      var maxTickW = Math.max.apply(null, ysc.ticks.map(function (t) { return textW(yfmt(t), 10.5); }));
      var legendH = series.length > 1 ? 16 : 0;
      var m = {
        t: 10 + legendH, r: 14, b: 22 + (spec.xLabel ? 15 : 0),
        l: Math.max(34, maxTickW + 10) + (spec.yLabel ? 14 : 0)
      };
      var pw = Math.max(20, W - m.l - m.r), ph = Math.max(20, H - m.t - m.b);
      // The x axis hugs the data: a season axis should not run 1990 to 2030
      // because the data happens to span 1999 to 2026.
      var xlo = Math.min.apply(null, xs), xhi = Math.max.apply(null, xs);
      if (xlo === xhi) { var xp = Math.abs(xlo) * 0.05 || 0.5; xlo -= xp; xhi += xp; }
      var xsc = niceScale(xlo, xhi, tickBudget(pw), { zeroBase: false });
      var xfmt = tickFormatter(xsc.step, spec.xFormat);
      var xeps = xsc.step * 1e-6;
      var xticks = xsc.ticks.filter(function (t) { return t >= xlo - xeps && t <= xhi + xeps; });
      if (xticks.length < 2) xticks = [xlo, xhi];
      var x = function (v) { return m.l + (v - xlo) / (xhi - xlo || 1) * pw; };
      var y = function (v) { return m.t + ph - (v - ysc.lo) / (ysc.hi - ysc.lo || 1) * ph; };

      gridlines(svg, p, { vertical: false, x1: m.l, x2: m.l + pw, positions: ysc.ticks.map(y) });
      ysc.ticks.forEach(function (t) {
        svg.appendChild(axisText(m.l - 7, y(t) + 3.5, yfmt(t), p, { "text-anchor": "end" }));
      });
      xticks.forEach(function (t) {
        svg.appendChild(axisText(x(t), m.t + ph + 14, xfmt(t), p, { "text-anchor": "middle" }));
      });
      svg.appendChild(s("line", {
        "class": "axis-line", x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph,
        stroke: p.ink, "stroke-width": 1, "shape-rendering": "crispEdges"
      }));

      series.forEach(function (se, si) {
        var color = se.color || p.series[si % p.series.length];
        var run = [], runs = [];
        se.points.forEach(function (pt) {
          var ok = typeof pt.x === "number" && isFinite(pt.x) &&
                   typeof pt.y === "number" && isFinite(pt.y);
          if (ok) run.push(pt);
          else if (run.length) { runs.push(run); run = []; }
        });
        if (run.length) runs.push(run);

        runs.forEach(function (r) {
          if (r.length === 1) {
            svg.appendChild(s("circle", {
              "class": "mark point s" + si, cx: x(r[0].x), cy: y(r[0].y), r: 3, fill: color
            }));
            return;
          }
          var d = r.map(function (pt, i) {
            return (i ? "L" : "M") + x(pt.x).toFixed(2) + " " + y(pt.y).toFixed(2);
          }).join(" ");
          svg.appendChild(s("path", {
            "class": "mark line s" + si, d: d, fill: "none", stroke: color,
            "stroke-width": 1.6, "stroke-linejoin": "round", "stroke-linecap": "round"
          }));
        });

        // Point hit targets: capped so a 1000-point line stays cheap.
        var pts = se.points.filter(function (pt) {
          return typeof pt.x === "number" && isFinite(pt.x) && typeof pt.y === "number" && isFinite(pt.y);
        });
        var stride = Math.max(1, Math.ceil(pts.length / 240));
        var showDots = pts.length <= 80;
        pts.forEach(function (pt, i) {
          if (i % stride) return;
          if (showDots) {
            svg.appendChild(s("circle", {
              "class": "mark point s" + si, cx: x(pt.x), cy: y(pt.y), r: 2.4,
              fill: color, stroke: p.panel, "stroke-width": 0.8
            }));
          }
          var hit = s("circle", {
            cx: x(pt.x), cy: y(pt.y), r: 7, fill: "transparent", tabindex: 0,
            "class": "mark-hit"
          });
          hoverable(hit, (se.name ? se.name + "\n" : "") +
            (spec.xName || "x") + ": " + fmtValue(pt.x) + "\n" +
            (spec.yName || "y") + ": " + fmtValue(pt.y) +
            (pt.note ? "\n" + pt.note : ""));
          svg.appendChild(hit);
        });
      });

      if (series.length > 1) {
        var lx = m.l;
        series.forEach(function (se, si) {
          var color = se.color || p.series[si % p.series.length];
          var name = truncate(se.name === "" || se.name === null ? "(null)" : se.name, 18);
          svg.appendChild(s("rect", { x: lx, y: 3, width: 9, height: 3, fill: color, rx: 1 }));
          svg.appendChild(axisText(lx + 13, 9, name, p, { fill: p.muted }));
          lx += 13 + textW(name, 10.5) + 14;
        });
      }
      if (spec.yLabel) svg.appendChild(axisLabel(11, m.t + ph / 2, spec.yLabel, p, true));
      if (spec.xLabel) svg.appendChild(axisLabel(m.l + pw / 2, H - 3, spec.xLabel, p));
    });
  }

  // --------------------------------------------------------------- scatter --
  /** Chart.scatter({data:[{x,y,label,note}], xLabel, yLabel, height}) */
  function scatter(spec) {
    spec = spec || {};
    var data = (spec.data || []).filter(function (d) {
      return d && typeof d.x === "number" && isFinite(d.x) &&
             typeof d.y === "number" && isFinite(d.y);
    });
    if (!data.length) return emptyChart(spec, spec.emptyText || "no plottable points");

    return responsive(spec, function (svg, W, H, p) {
      var xs = data.map(function (d) { return d.x; });
      var ys = data.map(function (d) { return d.y; });
      var xsc = niceScale(Math.min.apply(null, xs), Math.max.apply(null, xs),
        tickBudget(Math.max(80, (spec.width || 640) - 60), 90), { zeroBase: false });
      var ysc = niceScale(Math.min.apply(null, ys), Math.max.apply(null, ys), 6, { zeroBase: false });
      var xfmt = tickFormatter(xsc.step, spec.xFormat);
      var yfmt = tickFormatter(ysc.step, spec.yFormat);
      var maxTickW = Math.max.apply(null, ysc.ticks.map(function (t) { return textW(yfmt(t), 10.5); }));
      var m = {
        t: 10, r: 14, b: 22 + (spec.xLabel ? 15 : 0),
        l: Math.max(34, maxTickW + 10) + (spec.yLabel ? 14 : 0)
      };
      var pw = Math.max(20, W - m.l - m.r), ph = Math.max(20, H - m.t - m.b);
      var x = function (v) { return m.l + (v - xsc.lo) / (xsc.hi - xsc.lo || 1) * pw; };
      var y = function (v) { return m.t + ph - (v - ysc.lo) / (ysc.hi - ysc.lo || 1) * ph; };

      gridlines(svg, p, { vertical: false, x1: m.l, x2: m.l + pw, positions: ysc.ticks.map(y) });
      gridlines(svg, p, { vertical: true, y1: m.t, y2: m.t + ph, positions: xsc.ticks.map(x) });
      ysc.ticks.forEach(function (t) {
        svg.appendChild(axisText(m.l - 7, y(t) + 3.5, yfmt(t), p, { "text-anchor": "end" }));
      });
      xsc.ticks.forEach(function (t) {
        svg.appendChild(axisText(x(t), m.t + ph + 14, xfmt(t), p, { "text-anchor": "middle" }));
      });
      svg.appendChild(s("line", {
        "class": "axis-line", x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph,
        stroke: p.ink, "stroke-width": 1, "shape-rendering": "crispEdges"
      }));

      var r = data.length > 400 ? 2 : data.length > 120 ? 2.6 : 3.4;
      var color = spec.color || p.steel;
      data.forEach(function (d) {
        var c = s("circle", {
          "class": "mark point", cx: x(d.x), cy: y(d.y), r: r, fill: color,
          "fill-opacity": data.length > 300 ? 0.5 : 0.78, tabindex: 0
        });
        hoverable(c, (d.label ? d.label + "\n" : "") +
          (spec.xName || spec.xLabel || "x") + ": " + fmtValue(d.x) + "\n" +
          (spec.yName || spec.yLabel || "y") + ": " + fmtValue(d.y) +
          (d.note ? "\n" + d.note : ""));
        svg.appendChild(c);
      });

      // Label the extremes only, so the plot stays readable.
      if (spec.labelExtremes !== false && data.length <= 400) {
        var byY = data.slice().sort(function (a, b) { return b.y - a.y; });
        var picks = byY.slice(0, 3).concat(byY.slice(-3));
        picks.forEach(function (d) {
          if (!d.label) return;
          svg.appendChild(axisText(x(d.x) + 6, y(d.y) - 5, truncate(d.label, 18), p,
            { fill: p.ink, "font-size": 9.5 }));
        });
      }
      if (spec.yLabel) svg.appendChild(axisLabel(11, m.t + ph / 2, spec.yLabel, p, true));
      if (spec.xLabel) svg.appendChild(axisLabel(m.l + pw / 2, H - 3, spec.xLabel, p));
    });
  }

  // ------------------------------------------------------------- histogram --
  /**
   * Chart.histogram({edges:[n+1], counts:[n], height, xLabel, yLabel, compact})
   * Also accepts {values:[...]} and bins them. `compact: true` draws a bare
   * sparkline with no axes, for the schema profiler.
   */
  function histogram(spec) {
    spec = spec || {};
    var edges = spec.edges, counts = spec.counts;

    if ((!edges || !counts) && Array.isArray(spec.values)) {
      var vs = spec.values.filter(function (v) { return typeof v === "number" && isFinite(v); });
      if (!vs.length) return emptyChart(spec, "no numeric values");
      var lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
      var nb = Math.max(1, Math.min(spec.bins || 24, vs.length));
      if (lo === hi) { hi = lo + 1; nb = 1; }
      edges = []; counts = new Array(nb).fill(0);
      for (var i = 0; i <= nb; i++) edges.push(lo + (hi - lo) * i / nb);
      vs.forEach(function (v) {
        var b = Math.floor((v - lo) / (hi - lo) * nb);
        if (b >= nb) b = nb - 1;
        if (b < 0) b = 0;
        counts[b] += 1;
      });
    }

    if (!Array.isArray(edges) || !Array.isArray(counts) || !counts.length) {
      return emptyChart(spec, spec.emptyText || "no histogram");
    }
    if (edges.length !== counts.length + 1) {
      // Tolerate a same-length edges array by treating it as left edges.
      if (edges.length === counts.length) {
        var w = counts.length > 1 ? edges[1] - edges[0] : 1;
        edges = edges.concat([edges[edges.length - 1] + w]);
      } else {
        return emptyChart(spec, "malformed histogram");
      }
    }

    var maxCount = Math.max.apply(null, counts.map(function (c) { return c || 0; }));
    if (!isFinite(maxCount) || maxCount <= 0) return emptyChart(spec, "empty histogram");

    if (spec.compact) {
      var cspec = {
        height: spec.height || 26, width: spec.width || 120,
        className: "sparkline", ariaLabel: spec.ariaLabel || "distribution"
      };
      return responsive(cspec, function (svg, W, H, p) {
        var bw = W / counts.length;
        counts.forEach(function (c, i) {
          var h = Math.max(c > 0 ? 1 : 0, (c / maxCount) * (H - 2));
          if (!h) return;
          var rect = s("rect", {
            "class": "mark bar", x: i * bw, y: H - h,
            width: Math.max(0.8, bw - 0.6), height: h,
            fill: spec.color || p.steel, "fill-opacity": 0.82
          });
          titled(rect, fmtValue(edges[i]) + " to " + fmtValue(edges[i + 1]) + ": " +
            (window.U ? U.n(c) : c));
          svg.appendChild(rect);
        });
      });
    }

    return responsive(spec, function (svg, W, H, p) {
      var ysc = niceScale(0, maxCount, 5, { zeroBase: true, integer: true });
      var yfmt = spec.yFormat || function (v) { return window.U ? U.compact(v) : String(v); };
      var xlo = edges[0], xhi = edges[edges.length - 1];
      var xsc = niceScale(xlo, xhi, 7, { zeroBase: false });
      var xfmt = tickFormatter(xsc.step, spec.xFormat);
      var maxTickW = Math.max.apply(null, ysc.ticks.map(function (t) { return textW(yfmt(t), 10.5); }));
      var m = {
        t: 10, r: 12, b: 22 + (spec.xLabel ? 15 : 0),
        l: Math.max(32, maxTickW + 10) + (spec.yLabel ? 14 : 0)
      };
      var pw = Math.max(20, W - m.l - m.r), ph = Math.max(20, H - m.t - m.b);
      // Bars use the raw edge domain; ticks use the nice domain clipped to it.
      var x = function (v) { return m.l + (v - xlo) / ((xhi - xlo) || 1) * pw; };
      var y = function (v) { return m.t + ph - (v / (ysc.hi || 1)) * ph; };

      gridlines(svg, p, { vertical: false, x1: m.l, x2: m.l + pw, positions: ysc.ticks.map(y) });
      ysc.ticks.forEach(function (t) {
        svg.appendChild(axisText(m.l - 7, y(t) + 3.5, yfmt(t), p, { "text-anchor": "end" }));
      });
      xsc.ticks.forEach(function (t) {
        if (t < xlo || t > xhi) return;
        svg.appendChild(axisText(x(t), m.t + ph + 14, xfmt(t), p, { "text-anchor": "middle" }));
      });

      counts.forEach(function (c, i) {
        var x0 = x(edges[i]), x1 = x(edges[i + 1]);
        var h = c > 0 ? Math.max(1, (c / (ysc.hi || 1)) * ph) : 0;
        if (!h) return;
        var rect = s("rect", {
          "class": "mark bar", x: x0, y: m.t + ph - h,
          width: Math.max(0.8, x1 - x0 - 0.7), height: h,
          fill: spec.color || p.steel, "fill-opacity": 0.86, tabindex: 0
        });
        hoverable(rect, "[" + fmtValue(edges[i]) + ", " + fmtValue(edges[i + 1]) + ")\n" +
          "count: " + (window.U ? U.n(c) : c));
        svg.appendChild(rect);
      });

      svg.appendChild(s("line", {
        "class": "axis-line", x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph,
        stroke: p.ink, "stroke-width": 1, "shape-rendering": "crispEdges"
      }));
      if (spec.yLabel) svg.appendChild(axisLabel(11, m.t + ph / 2, spec.yLabel, p, true));
      if (spec.xLabel) svg.appendChild(axisLabel(m.l + pw / 2, H - 3, spec.xLabel, p));
    });
  }

  // ------------------------------------------- shared plain result renderer --
  /** Fallback table used when window.Grid is unavailable. */
  function resultTable(payload, opts) {
    opts = opts || {};
    var cols = (payload && payload.columns) || [];
    var rows = (payload && payload.rows) || [];
    var dtypes = (payload && payload.dtypes) || [];
    var wrap = document.createElement("div");
    wrap.className = "dt-wrap";
    wrap.style.overflow = "auto";
    if (opts.maxHeight) wrap.style.maxHeight = opts.maxHeight;
    if (!cols.length) {
      wrap.appendChild(U.el("div.empty", { text: "no columns" }));
      return wrap;
    }
    var numeric = dtypes.map(function (d) { return /Int|Float|UInt|Decimal/.test(String(d)); });
    var thead = U.el("thead", null, U.el("tr", null, cols.map(function (c, i) {
      return U.el("th" + (numeric[i] ? ".num" : ""), { text: c, title: c + " : " + (dtypes[i] || "") });
    })));
    var body = rows.slice(0, opts.limit || 500).map(function (r) {
      return U.el("tr", null, r.map(function (v, i) {
        var td = U.el("td" + (numeric[i] ? ".num" : ""), { text: U.cell(v) });
        if (v === null || v === undefined) td.classList.add("muted");
        return td;
      }));
    });
    var table = U.el("table.dt", null, thead, U.el("tbody", null, body));
    wrap.appendChild(table);
    return wrap;
  }

  /** Mount a row payload into `host`, preferring the shared Grid component. */
  function mountResult(host, payload, opts) {
    U.clear(host);
    if (window.Grid && typeof Grid.create === "function") {
      try {
        var g = Grid.create(Object.assign({ mode: "static", paging: false }, opts || {}));
        if (g && g.el && typeof g.setResult === "function") {
          host.appendChild(g.el);
          g.setResult(payload);
          return g;
        }
        if (g && typeof g.destroy === "function") g.destroy();
      } catch (e) {
        console.warn("Grid unavailable, falling back to a plain table", e);
      }
    }
    host.appendChild(resultTable(payload, opts));
    return null;
  }

  /* "Save as dataset": use Agent C's shared flow if it exists, otherwise a
     minimal local prompt posting the same /api/derive payload. */
  function saveDataset(spec, meta, onDone) {
    meta = meta || {};
    if (typeof window.SaveDataset === "function") {
      return window.SaveDataset(spec, meta);
    }
    var name = window.prompt(
      "Save this result as a dataset.\nName (lowercase letters, digits, underscore):",
      meta.name || "");
    if (!name) return;
    name = String(name).trim();
    if (!/^[a-z][a-z0-9_]{0,48}$/.test(name)) {
      U.toast("invalid name: use lowercase letters, digits and underscores", "error");
      return;
    }
    var note = window.prompt("Note (optional): what is this?", meta.note || "") || "";
    var body = Object.assign({}, spec, { name: name, note: note });
    U.toast("saving " + name + " ...");
    function post(b) {
      return API.post("derive", b).then(function (res) {
        U.toast("saved dataset " + res.name + ": " + U.n(res.rows) + " rows, " +
          res.cols + " cols" + (res.truncated ? " (truncated)" : ""));
        if (window.App && typeof App.reloadCatalog === "function") App.reloadCatalog();
        if (onDone) onDone(res);
      });
    }
    post(body).catch(function (e) {
      var msg = String(e.message || e);
      if (/exist|collid|overwrite/i.test(msg) && window.confirm(msg + "\n\nOverwrite it?")) {
        body.overwrite = true;
        post(body).catch(function (e2) { U.toast(e2.message || e2, "error"); });
      } else {
        U.toast(msg, "error");
      }
    });
  }

  window.Chart = {
    bar: bar, line: line, scatter: scatter, histogram: histogram,
    saveDataset: saveDataset,
    palette: palette, niceScale: niceScale, tickFormatter: tickFormatter,
    resultTable: resultTable, mountResult: mountResult,
    svg: s, truncate: truncate, hoverable: hoverable,
    showTip: showTip, moveTip: moveTip, hideTip: hideTip
  };

  // ==========================================================================
  // Chart builder tab
  // ==========================================================================

  var AGGS = ["mean", "sum", "count", "count_distinct", "median", "min", "max",
              "std", "var", "p25", "p75"];
  var OPS = ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "contains",
             "not_contains", "starts_with", "ends_with", "between",
             "is_null", "not_null"];
  var NO_VALUE_OPS = { is_null: 1, not_null: 1 };
  var TYPES = ["bar", "bar (horizontal)", "line", "scatter", "histogram"];

  /* Presets. Every column referenced here was checked against the real
     Parquet schemas before shipping; see the verification notes in the repo. */
  var PRESETS = [
    {
      label: "EPA per play by team, 2024",
      note: "pbp, pass and run plays only",
      state: {
        dataset: "pbp", type: "bar",
        group_by: ["posteam"],
        metrics: [{ col: "epa", agg: "mean" }],
        filters: [
          { col: "season", op: "=", value: 2024 },
          { col: "play_type", op: "in", value: ["pass", "run"] }
        ],
        order_by: { col: "epa_mean", dir: "desc" }, limit: 32
      }
    },
    {
      label: "Points per game by season",
      note: "schedules, regular season, combined final score",
      state: {
        dataset: "schedules", type: "line",
        group_by: ["season"],
        metrics: [{ col: "total", agg: "mean" }],
        filters: [{ col: "game_type", op: "=", value: "REG" }],
        order_by: { col: "season", dir: "asc" }, limit: 100
      }
    },
    {
      label: "Snap share leaders, 2024",
      note: "snap_counts, mean offense snap pct, WR / RB / TE only",
      state: {
        dataset: "snap_counts", type: "bar (horizontal)",
        group_by: ["player"],
        metrics: [{ col: "offense_pct", agg: "mean" }],
        filters: [
          { col: "season", op: "=", value: 2024 },
          { col: "position", op: "in", value: ["WR", "RB", "TE"] }
        ],
        order_by: { col: "offense_pct_mean", dir: "desc" }, limit: 20
      }
    },
    {
      label: "Pass rate by down, 2024",
      note: "pbp, share of plays that were passes",
      state: {
        dataset: "pbp", type: "bar",
        group_by: ["down"],
        metrics: [{ col: "pass", agg: "mean" }],
        filters: [
          { col: "season", op: "=", value: 2024 },
          { col: "play_type", op: "in", value: ["pass", "run"] }
        ],
        order_by: { col: "down", dir: "asc" }, limit: 10
      }
    },
    {
      label: "QB CPOE vs EPA, 2024",
      note: "pbp, top 40 passers by attempts",
      state: {
        dataset: "pbp", type: "scatter",
        group_by: ["passer_player_name"],
        metrics: [{ col: "cpoe", agg: "mean" }, { col: "epa", agg: "mean" }],
        filters: [
          { col: "season", op: "=", value: 2024 },
          { col: "play_type", op: "=", value: "pass" }
        ],
        order_by: { col: "n", dir: "desc" }, limit: 40
      }
    },
    {
      label: "Team pass EPA by week, 2024",
      note: "team_stats_week, regular season",
      state: {
        dataset: "team_stats_week", type: "line",
        group_by: ["week"],
        metrics: [{ col: "passing_epa", agg: "mean" }],
        filters: [
          { col: "season", op: "=", value: 2024 },
          { col: "season_type", op: "=", value: "REG" }
        ],
        order_by: { col: "week", dir: "asc" }, limit: 30
      }
    }
  ];

  function alias(m) {
    if (!m || !m.col) return "n";
    if (m.col === "*") return "n";
    return (m.col + "_" + m.agg).replace(/[^\w]/g, "_");
  }

  var _schemaCache = {};
  function schemaFor(name) {
    if (!name) return Promise.resolve(null);
    if (_schemaCache[name]) return _schemaCache[name];
    _schemaCache[name] = API.get("schema", { dataset: name }).catch(function (e) {
      delete _schemaCache[name];
      throw e;
    });
    return _schemaCache[name];
  }

  function selectEl(cls, options, value, onchange) {
    var sel = U.el("select" + (cls || ".select.sm"), { onchange: onchange });
    options.forEach(function (o) {
      var val = Array.isArray(o) ? o[0] : o;
      var txt = Array.isArray(o) ? o[1] : o;
      sel.appendChild(U.el("option", { value: val, text: txt }));
    });
    sel.value = value === null || value === undefined ? "" : String(value);
    if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0;
    return sel;
  }

  function field(labelText, control, hint) {
    return U.el("div.field", null,
      U.el("label.field-label", { text: labelText }),
      control,
      hint ? U.el("span.hint", { text: hint }) : null);
  }

  function asNum(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (v === null || v === undefined || v === "") return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function ChartTab() {
    var root = null, schema = null, applying = false;
    var els = {};
    var lastPayload = null;
    var state = {
      dataset: null, type: "bar",
      group_by: [], metrics: [{ col: "", agg: "mean" }],
      filters: [], order_by: { col: "", dir: "desc" }, limit: 32
    };

    // ------------------------------------------------------------- helpers --
    function cols(kindFilter) {
      var list = (schema && schema.columns) || [];
      if (!kindFilter) return list;
      return list.filter(function (c) { return kindFilter.indexOf(c.kind) >= 0; });
    }
    function colKind(name) {
      var list = (schema && schema.columns) || [];
      for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i].kind;
      return null;
    }
    function metricAliases() {
      var out = [];
      state.metrics.forEach(function (m) { if (m.col) out.push(alias(m)); });
      if (out.indexOf("n") < 0) out.push("n");
      return out;
    }
    function orderOptions() {
      return state.group_by.concat(metricAliases());
    }

    function buildSpec() {
      var metrics = [];
      state.metrics.forEach(function (m) {
        if (!m.col) return;
        metrics.push({ col: m.col, agg: m.agg, alias: alias(m) });
      });
      var hasCount = metrics.some(function (m) { return m.alias === "n"; });
      if (!hasCount) metrics.push({ col: "*", agg: "count", alias: "n" });
      var order = state.order_by && state.order_by.col ? state.order_by : null;
      if (order && orderOptions().indexOf(order.col) < 0) order = null;
      return {
        dataset: state.dataset,
        filters: normalizeFilters(),
        group_by: state.group_by.slice(),
        metrics: metrics,
        order_by: order,
        limit: Number(state.limit) || 50
      };
    }

    // ---------------------------------------------------------- filter row --
    function filterRow(f, idx) {
      var colSel = selectEl(".select.sm",
        [["", "column"]].concat(cols().map(function (c) { return [c.name, c.name]; })),
        f.col, function () { f.col = this.value; });
      var opSel = selectEl(".select.sm", OPS, f.op, function () {
        f.op = this.value;
        valInput.style.display = NO_VALUE_OPS[f.op] ? "none" : "";
      });
      var initial = f.value === null || f.value === undefined
        ? (f.raw === undefined || f.raw === null ? "" : String(f.raw))
        : (Array.isArray(f.value) ? f.value.join(", ") : String(f.value));
      var valInput = U.el("input.input.sm", {
        type: "text", value: initial, placeholder: "value",
        oninput: function () { f.raw = this.value; }
      });
      // Set the property as well as the attribute: never rely on the value
      // attribute reflecting into the property.
      valInput.value = initial;
      if (NO_VALUE_OPS[f.op]) valInput.style.display = "none";
      f.raw = initial;
      var del = U.el("button.btn.sm.ghost", {
        type: "button", text: "remove", title: "remove this filter",
        onclick: function () {
          state.filters.splice(state.filters.indexOf(f), 1);
          renderFilters();
        }
      });
      return U.el("div.row.tight", null, colSel, opSel, valInput, del);
    }

    function renderFilters() {
      U.clear(els.filters);
      if (!state.filters.length) {
        els.filters.appendChild(U.el("span.hint", { text: "no filters" }));
      }
      state.filters.forEach(function (f, i) { els.filters.appendChild(filterRow(f, i)); });
    }

    /** Turn the typed filter text into the contract's filter JSON. */
    function normalizeFilters() {
      var out = [];
      state.filters.forEach(function (f) {
        if (!f.col || !f.op) return;
        if (NO_VALUE_OPS[f.op]) { out.push({ col: f.col, op: f.op }); return; }
        var raw = f.raw !== undefined ? f.raw : f.value;
        if (raw === null || raw === undefined || raw === "") return;
        var numeric = colKind(f.col) === "numeric";
        function coerce(x) {
          var t = String(x).trim();
          if (!numeric) return t;
          var n = Number(t);
          return isFinite(n) && t !== "" ? n : t;
        }
        var parts;
        if (Array.isArray(raw)) parts = raw;
        else parts = String(raw).split(",");
        if (f.op === "in" || f.op === "not_in") {
          out.push({ col: f.col, op: f.op, value: parts.map(coerce) });
        } else if (f.op === "between") {
          if (parts.length < 2) return;
          out.push({ col: f.col, op: f.op, value: [coerce(parts[0]), coerce(parts[1])] });
        } else {
          out.push({ col: f.col, op: f.op, value: coerce(Array.isArray(raw) ? raw[0] : raw) });
        }
      });
      return out;
    }

    // ------------------------------------------------------------ controls --
    function refreshControls() {
      var colOpts = [["", "(none)"]].concat(cols().map(function (c) {
        return [c.name, c.name + "  " + c.kind];
      }));
      var numOpts = [["", "(none)"]].concat(cols(["numeric"]).map(function (c) {
        return [c.name, c.name];
      }));

      function repop(sel, opts, val) {
        var keep = val;
        U.clear(sel);
        opts.forEach(function (o) { sel.appendChild(U.el("option", { value: o[0], text: o[1] })); });
        sel.value = keep === null || keep === undefined ? "" : String(keep);
        if (sel.selectedIndex < 0) sel.selectedIndex = 0;
      }

      repop(els.gb1, colOpts, state.group_by[0] || "");
      repop(els.gb2, colOpts, state.group_by[1] || "");
      repop(els.m1col, numOpts, (state.metrics[0] && state.metrics[0].col) || "");
      repop(els.m2col, numOpts, (state.metrics[1] && state.metrics[1].col) || "");
      els.m1agg.value = (state.metrics[0] && state.metrics[0].agg) || "mean";
      els.m2agg.value = (state.metrics[1] && state.metrics[1].agg) || "mean";
      els.type.value = state.type;
      els.limit.value = String(state.limit);
      repop(els.order, orderOptions().map(function (c) { return [c, c]; }),
        (state.order_by && state.order_by.col) || "");
      els.dir.value = (state.order_by && state.order_by.dir) || "desc";
      renderFilters();
    }

    function readControls() {
      state.group_by = [els.gb1.value, els.gb2.value].filter(Boolean);
      state.metrics = [];
      if (els.m1col.value) state.metrics.push({ col: els.m1col.value, agg: els.m1agg.value });
      if (els.m2col.value) state.metrics.push({ col: els.m2col.value, agg: els.m2agg.value });
      state.type = els.type.value;
      state.limit = Number(els.limit.value) || 50;
      state.order_by = { col: els.order.value, dir: els.dir.value };
      // state.filters is intentionally left alone: the rendered filter rows
      // hold references to those objects, so replacing them would orphan the
      // inputs. buildSpec() normalizes them at request time instead.
    }

    // -------------------------------------------------------------- render --
    function drawChart(payload) {
      U.clear(els.chart);
      if (!payload || !payload.rows || !payload.rows.length) {
        els.chart.appendChild(U.el("div.chart-empty", { text: "no rows returned" }));
        return;
      }
      var idx = {};
      payload.columns.forEach(function (c, i) { idx[c] = i; });
      var gb = state.group_by;
      var mAliases = state.metrics.map(alias);
      var m1 = mAliases[0], m2 = mAliases[1];
      var rows = payload.rows;
      var nIdx = idx.n;

      function labelOf(r) {
        return gb.map(function (g) {
          var v = r[idx[g]];
          return v === null || v === undefined ? "(null)" : String(v);
        }).join(" · ") || "all";
      }
      function noteOf(r) {
        return nIdx === undefined ? "" : "n: " + U.n(r[nIdx]);
      }

      var type = state.type;
      var height = Math.max(220, Math.min(520, type.indexOf("horizontal") >= 0
        ? 40 + rows.length * 20 : 300));

      if (type === "histogram") {
        var vals = rows.map(function (r) { return asNum(r[idx[m1]]); })
          .filter(function (v) { return v !== null; });
        els.chart.appendChild(histogram({
          values: vals, bins: 24, height: 280,
          xLabel: m1, yLabel: "groups", ariaLabel: "distribution of " + m1
        }));
        return;
      }

      if (type === "scatter") {
        if (!m2) {
          els.chart.appendChild(U.el("div.chart-empty", {
            text: "scatter needs two metrics: pick a second metric column"
          }));
          return;
        }
        els.chart.appendChild(scatter({
          data: rows.map(function (r) {
            return {
              x: asNum(r[idx[m1]]), y: asNum(r[idx[m2]]),
              label: labelOf(r), note: noteOf(r)
            };
          }),
          height: 340, xLabel: m1, yLabel: m2, xName: m1, yName: m2,
          ariaLabel: m2 + " against " + m1
        }));
        return;
      }

      if (type === "line") {
        var xcol = gb[0];
        var numericX = rows.every(function (r) { return asNum(r[idx[xcol]]) !== null; });
        if (!numericX) {
          els.chart.appendChild(U.el("div.panel-note", {
            text: "line needs a numeric first group-by column, showing bars instead"
          }));
        } else {
          var series;
          if (gb.length > 1) {
            var bySeries = new Map();
            rows.forEach(function (r) {
              var k = r[idx[gb[1]]];
              k = k === null || k === undefined ? "(null)" : String(k);
              if (!bySeries.has(k)) bySeries.set(k, []);
              bySeries.get(k).push({ x: asNum(r[idx[xcol]]), y: asNum(r[idx[m1]]), note: noteOf(r) });
            });
            series = Array.from(bySeries.entries()).slice(0, 8).map(function (e) {
              e[1].sort(function (a, b) { return a.x - b.x; });
              return { name: e[0], points: e[1] };
            });
          } else {
            var pts = rows.map(function (r) {
              return { x: asNum(r[idx[xcol]]), y: asNum(r[idx[m1]]), note: noteOf(r) };
            }).sort(function (a, b) { return a.x - b.x; });
            series = [{ name: m1, points: pts }];
          }
          els.chart.appendChild(line({
            series: series, height: 320, xLabel: xcol, yLabel: m1,
            xName: xcol, yName: m1,
            xFormat: /season|year|week/i.test(xcol)
              ? function (v) { return String(Math.round(v)); } : null,
            ariaLabel: m1 + " by " + xcol
          }));
          return;
        }
      }

      els.chart.appendChild(bar({
        data: rows.map(function (r) {
          return { label: labelOf(r), value: asNum(r[idx[m1]]), note: noteOf(r) };
        }),
        horizontal: type.indexOf("horizontal") >= 0,
        height: height,
        xLabel: type.indexOf("horizontal") >= 0 ? m1 : gb.join(" · "),
        yLabel: type.indexOf("horizontal") >= 0 ? null : m1,
        valueName: m1,
        ariaLabel: m1 + " by " + gb.join(" and ")
      }));
    }

    function setStatus(text, kind) {
      U.clear(els.status);
      els.status.className = "readout" + (kind === "error" ? " err" : "");
      els.status.appendChild(document.createTextNode(text));
    }

    function run() {
      readControls();
      if (!state.dataset) { U.toast("pick a dataset first", "error"); return; }
      if (!state.group_by.length) { U.toast("pick at least one group-by column", "error"); return; }
      if (!state.metrics.length) { U.toast("pick a metric column", "error"); return; }
      var spec = buildSpec();
      setStatus("running...");
      els.chart.classList.add("loading");
      var t0 = Date.now();
      API.post("aggregate", spec).then(function (payload) {
        lastPayload = payload;
        els.chart.classList.remove("loading");
        setStatus((payload.rows || []).length + " groups, " +
          U.ms(payload.elapsed_ms !== undefined ? payload.elapsed_ms : Date.now() - t0) +
          (payload.truncated ? ", truncated" : ""));
        drawChart(payload);
        var gs = buildSpec();
        mountResult(els.table, payload, {
          emptyText: "no groups matched",
          // Wire the grid's own export / save-as-dataset buttons to this
          // aggregate, so they act on the query rather than the page.
          exportSpec: function (fmt, scope) {
            return {
              source: "aggregate", dataset: gs.dataset, filters: gs.filters,
              group_by: gs.group_by, metrics: gs.metrics, order_by: gs.order_by,
              limit: scope === "page" ? gs.limit : null
            };
          },
          deriveSpec: function () {
            return {
              source: "aggregate", dataset: gs.dataset, filters: gs.filters,
              group_by: gs.group_by, metrics: gs.metrics, order_by: gs.order_by,
              limit: gs.limit
            };
          },
          deriveScopeText: "the " + (payload.rows || []).length +
            " aggregated rows this chart is built from"
        });
      }).catch(function (err) {
        els.chart.classList.remove("loading");
        setStatus(String(err.message || err), "error");
        U.toast(err.message || err, "error");
      });
    }

    function applyState(next, thenRun) {
      applying = true;
      state = {
        dataset: next.dataset, type: next.type || "bar",
        group_by: (next.group_by || []).slice(),
        metrics: (next.metrics || []).map(function (m) { return { col: m.col, agg: m.agg }; }),
        filters: (next.filters || []).map(function (f) {
          return { col: f.col, op: f.op, value: f.value, raw: undefined };
        }),
        order_by: next.order_by ? { col: next.order_by.col, dir: next.order_by.dir } : { col: "", dir: "desc" },
        limit: next.limit || 32
      };
      if (Store.get("dataset") !== state.dataset) {
        if (window.App && typeof App.setDataset === "function") App.setDataset(state.dataset);
        else Store.set("dataset", state.dataset);
      }
      schemaFor(state.dataset).then(function (sc) {
        schema = sc;
        refreshControls();
        applying = false;
        if (thenRun) run();
      }).catch(function (e) {
        applying = false;
        U.toast(e.message || e, "error");
      });
    }

    /** A restorable snapshot: UI state with wire-format filters. */
    function viewState(spec) {
      return {
        dataset: state.dataset, type: state.type,
        group_by: state.group_by.slice(),
        metrics: state.metrics.map(function (m) { return { col: m.col, agg: m.agg }; }),
        filters: spec.filters, order_by: state.order_by, limit: state.limit
      };
    }

    function saveView() {
      readControls();
      var name = window.prompt("Save this chart as:",
        (state.dataset || "chart") + " " + state.metrics.map(alias).join(", "));
      if (!name) return;
      var spec = buildSpec();
      API.post("views", {
        name: name, kind: "aggregate",
        payload: { state: viewState(spec), spec: spec }
      }).then(function () {
        U.toast("saved view: " + name);
      }).catch(function (e) { U.toast(e.message || e, "error"); });
    }

    // ---------------------------------------------------------------- mount --
    function mount(el) {
      root = el;
      U.clear(root);

      var presetBar = U.el("div.chips", null,
        U.el("span.field-label", { text: "presets" }),
        PRESETS.map(function (pr) {
          return U.el("button.chip", {
            type: "button", text: pr.label, title: pr.note,
            onclick: function () { applyState(pr.state, true); }
          });
        }));

      els.gb1 = selectEl(".select.sm", [["", "(none)"]], "");
      els.gb2 = selectEl(".select.sm", [["", "(none)"]], "");
      els.m1col = selectEl(".select.sm", [["", "(none)"]], "");
      els.m1agg = selectEl(".select.sm", AGGS, "mean");
      els.m2col = selectEl(".select.sm", [["", "(none)"]], "");
      els.m2agg = selectEl(".select.sm", AGGS, "mean");
      els.type = selectEl(".select.sm", TYPES, "bar");
      els.order = selectEl(".select.sm", [["", "(none)"]], "");
      els.dir = selectEl(".select.sm", [["desc", "desc"], ["asc", "asc"]], "desc");
      els.limit = selectEl(".select.sm", ["10", "20", "32", "50", "100", "200", "500"], "32");
      els.filters = U.el("div.col");
      els.status = U.el("span.readout", { text: "pick columns, then run" });
      els.chart = U.el("div.chart-host");
      els.table = U.el("div.dt-wrap");

      var controls = U.el("div.panel.panel-b.col", null,
        presetBar,
        U.el("div.field-row", null,
          field("group by", els.gb1),
          field("then by", els.gb2),
          field("metric", els.m1col),
          field("agg", els.m1agg),
          field("metric 2", els.m2col),
          field("agg 2", els.m2agg)),
        U.el("div.field-row", null,
          field("chart", els.type),
          field("sort by", els.order),
          field("direction", els.dir),
          field("limit", els.limit),
          U.el("div.field", null,
            U.el("label.field-label", { text: "filters" }),
            U.el("button.btn.sm", {
              type: "button", text: "add filter",
              onclick: function () {
                state.filters.push({ col: "", op: "=", value: "", raw: "" });
                renderFilters();
              }
            }))),
        els.filters,
        U.el("div.row.wrap", null,
          U.el("button.btn.primary", { type: "button", text: "run", onclick: run }),
          U.el("button.btn", { type: "button", text: "save view", onclick: saveView }),
          U.el("button.btn", {
            type: "button", text: "save as dataset",
            title: "write this aggregate to data/derived as a queryable dataset",
            onclick: function () {
              if (!lastPayload) { U.toast("run the chart first", "error"); return; }
              var spec = buildSpec();
              saveDataset({
                source: "aggregate", limit: spec.limit,
                dataset: spec.dataset, filters: spec.filters,
                group_by: spec.group_by, metrics: spec.metrics,
                order_by: spec.order_by
              }, {
                name: (spec.dataset + "_by_" + spec.group_by.join("_"))
                  .toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 48),
                note: spec.dataset + ": " + spec.metrics.map(function (m) {
                  return m.agg + "(" + m.col + ")";
                }).join(", ") + " by " + spec.group_by.join(", "),
                scopeText: "Writes the " + (lastPayload.rows || []).length +
                  " aggregated rows currently shown."
              });
            }
          }),
          els.status));

      // Add to whatever app.js put on the host (.tabhost drives tab hiding
      // and the flex layout); never overwrite className.
      root.classList.add("col");
      root.style.overflow = "auto";
      root.style.padding = "10px";
      root.style.gap = "10px";
      root.appendChild(controls);
      root.appendChild(U.el("div.panel.panel-b", null, els.chart));
      root.appendChild(U.el("div.panel", null, els.table));

      var ds = Store.get("dataset");
      if (ds) onDatasetChange(ds);
    }

    function onDatasetChange(name) {
      if (applying || !root) return;
      if (name === state.dataset) return;
      state.dataset = name;
      state.group_by = [];
      state.metrics = [{ col: "", agg: "mean" }];
      state.filters = [];
      state.order_by = { col: "", dir: "desc" };
      lastPayload = null;
      if (els.chart) U.clear(els.chart);
      if (els.table) U.clear(els.table);
      schemaFor(name).then(function (sc) {
        schema = sc;
        refreshControls();
        setStatus(name + ": " + ((sc && sc.columns) || []).length + " columns");
      }).catch(function (e) { U.toast(e.message || e, "error"); });
    }

    return {
      id: "chart", label: "Chart", key: "c",
      mount: mount,
      onDatasetChange: onDatasetChange,
      onShow: function () {
        if (root && !schema) {
          var ds = Store.get("dataset");
          if (ds) onDatasetChange(ds);
        }
      },
      onRestore: function (payload) {
        if (!payload) return;
        var st = payload.state || payload;
        if (!st || !st.dataset) return;
        applyState(st, true);
      },
      getViewPayload: function () {
        readControls();
        var spec = buildSpec();
        return {
          kind: "aggregate",
          name: (state.dataset || "chart") + " " + state.metrics.map(alias).join(", "),
          payload: { state: viewState(spec), spec: spec }
        };
      }
    };
  }

  if (window.Tabs && Tabs.register) Tabs.register(ChartTab());
})();
