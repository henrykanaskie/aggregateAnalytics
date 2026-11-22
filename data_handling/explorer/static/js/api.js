/* Shared frontend runtime: fetch helpers, global store, tab registry, utils.
   Owned by no agent, read it, use it, do not redefine its exports. */
(function () {
  "use strict";

  // ---------------------------------------------------------------- fetch ---
  async function handle(res) {
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`Bad response (${res.status}): ${text.slice(0, 300)}`); }
    if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  const API = {
    /** GET /api/<path> with query params. */
    async get(path, params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params || {})) {
        if (v === undefined || v === null || v === "") continue;
        qs.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
      const url = `/api/${path}${qs.toString() ? "?" + qs : ""}`;
      return handle(await fetch(url));
    },

    /** POST JSON to /api/<path>. */
    async post(path, body) {
      return handle(await fetch(`/api/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }));
    },

    /** POST that saves the response as a file download. */
    async postDownload(path, body, fallbackName) {
      const res = await fetch(`/api/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      if (!res.ok) {
        const t = await res.text();
        let msg = t;
        try { msg = JSON.parse(t).error || t; } catch { /* raw */ }
        throw new Error(msg);
      }
      const disp = res.headers.get("Content-Disposition") || "";
      const m = /filename="?([^";]+)"?/.exec(disp);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = m ? m[1] : (fallbackName || "export");
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { truncated: res.headers.get("X-Export-Truncated") === "true" };
    },
  };

  // ---------------------------------------------------------------- store ---
  const _subs = new Map();   // key -> Set<fn>
  const Store = {
    state: {
      catalog: null,      // /api/catalog payload
      dataset: null,      // active dataset name
      schema: null,       // /api/schema payload for the active dataset
      tab: null,          // active tab id
    },
    get(k) { return Store.state[k]; },
    set(k, v) {
      if (Store.state[k] === v) return v;
      Store.state[k] = v;
      (_subs.get(k) || []).forEach((fn) => { try { fn(v); } catch (e) { console.error(e); } });
      return v;
    },
    /** subscribe(key, fn) -> unsubscribe */
    subscribe(k, fn) {
      if (!_subs.has(k)) _subs.set(k, new Set());
      _subs.get(k).add(fn);
      return () => _subs.get(k).delete(fn);
    },
  };

  // ----------------------------------------------------------------- tabs ---
  const _tabs = [];
  const Tabs = {
    /** register({id, label, key, mount(el), onDatasetChange(name), onShow()}) */
    register(tab) { _tabs.push(tab); },
    all() { return _tabs.slice(); },
    byId(id) { return _tabs.find((t) => t.id === id) || null; },
  };

  // ---------------------------------------------------------------- utils ---
  const NUM = new Intl.NumberFormat("en-US");

  const U = {
    /** Element factory: el("div.cls#id", {attrs}, ...children) */
    el(spec, attrs, ...kids) {
      const m = /^([a-zA-Z0-9-]+)?((?:[.#][\w-]+)*)$/.exec(spec) || [];
      const node = document.createElement(m[1] || "div");
      for (const part of (m[2] || "").match(/[.#][\w-]+/g) || []) {
        if (part[0] === ".") node.classList.add(part.slice(1));
        else node.id = part.slice(1);
      }
      for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "text") node.textContent = v;
        else if (k === "html") node.innerHTML = v;
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
        else node.setAttribute(k, v === true ? "" : v);
      }
      for (const kid of kids.flat(Infinity)) {
        if (kid === null || kid === undefined || kid === false) continue;
        node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
      }
      return node;
    },

    clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; },

    n(v) { return v === null || v === undefined ? "" : NUM.format(v); },

    /** Compact count: 1.28M, 49.5K, 942 */
    compact(v) {
      if (v === null || v === undefined) return "";
      const a = Math.abs(v);
      if (a >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
      if (a >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
      if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
      return String(v);
    },

    mb(v) {
      if (v === null || v === undefined) return "";
      return v >= 1000 ? (v / 1000).toFixed(1) + " GB" : (v < 1 ? v.toFixed(2) : v.toFixed(0)) + " MB";
    },

    /** Cell rendering: nulls become a muted dot, floats get sane precision. */
    cell(v) {
      if (v === null || v === undefined) return "·";
      if (typeof v === "number") {
        if (Number.isInteger(v)) return NUM.format(v);
        const a = Math.abs(v);
        if (a !== 0 && (a < 1e-4 || a >= 1e9)) return v.toExponential(3);
        return v.toFixed(a < 1 ? 4 : a < 100 ? 3 : 2);
      }
      if (typeof v === "boolean") return v ? "true" : "false";
      return String(v);
    },

    isNumeric(kind) { return kind === "numeric"; },

    ms(v) { return v === null || v === undefined ? "" : (v >= 1000 ? (v / 1000).toFixed(2) + "s" : v + "ms"); },

    debounce(fn, wait) {
      let t;
      return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait === undefined ? 220 : wait);
      };
    },

    /** Toast notification; app.js provides the container. */
    toast(msg, kind) {
      const host = document.getElementById("toasts");
      if (!host) { (kind === "error" ? console.error : console.log)(msg); return; }
      const t = U.el("div.toast" + (kind ? "." + kind : ""), { text: String(msg) });
      host.appendChild(t);
      setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 400); }, kind === "error" ? 7000 : 3500);
    },

    copyTSV(columns, rows) {
      const body = [columns.join("\t")]
        .concat(rows.map((r) => r.map((v) => (v === null || v === undefined ? "" : String(v))).join("\t")))
        .join("\n");
      return navigator.clipboard.writeText(body);
    },
  };

  window.API = API;
  window.Store = Store;
  window.Tabs = Tabs;
  window.U = U;
})();
