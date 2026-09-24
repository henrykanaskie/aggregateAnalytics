import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { buildCast, Cast, EMPTY_CAST } from "../lib/tourcast";
import { useMeta } from "../state";
import { useLens } from "../lib/profile";
import { clearSticky, readSticky, writeSticky } from "../lib/sticky";
import { useMobile } from "../lib/useMobile";
import type { RosterEntry } from "./MyRoster";
import { ICONS, IconClose, IconChevron } from "./Icons";
import Spark from "./Spark";
import { chaptersFor, Ctx } from "./tourSteps";

// The machinery that walks the tour in tourSteps.tsx. It drives the app to
// each step's page the way a user would, finds what the step points at, lights
// it, and places the card beside it (on a phone, docked along the bottom). A
// step whose target never turns up is skipped if it was optional, and
// otherwise falls back to the tab its page lives under. The tour is long, so it
// is walked by page: a contents menu jumps to any page, "Skip page" moves on,
// and opened from a page it starts on that page.

const text = (v: string | ((x: Ctx) => string), x: Ctx) => (typeof v === "string" ? v : v(x));

interface Box { top: number; left: number; width: number; height: number }

interface Spot { ring: Box; card: { top: number; left: number } | null; dock: "top" | "bottom" | null }

const CARD_W = 400;
const GAP = 16;
/** Room the phone's pinned header takes at the top of the screen. */
const PHONE_TOP = 66;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** A panel can be several times taller than the window, and a ring drawn
 *  around the whole of it is a ring nobody can see. What gets lit is the part
 *  that is actually on screen, stopping short of wherever the card sits. */
function clip(b: Box, floor: number, cap: number): Box {
  let { top, height } = b;
  if (top < 12) { height += top - 12; top = 12; }
  height = Math.max(36, Math.min(height, cap, floor - top));
  return { ...b, top, height };
}

/** Where the ring and card belong for a target at `r` (screen coordinates),
 *  or, with no target, a closed ring in the middle and the card centred. */
function spotFor(r: Box | null, mobile: boolean, cardH: number, lastDock: "top" | "bottom", safe: { top: number; bottom: number }): Spot {
  const vh = window.innerHeight, vw = window.innerWidth;
  const cardW = Math.min(CARD_W, vw - 24);
  // On a phone the card is a sheet at the bottom, clear of the home indicator,
  // or at the top under the notch; it glides between the two like anything else.
  const docked = (d: "top" | "bottom") => ({ top: d === "top" ? 10 + safe.top : vh - cardH - 10 - safe.bottom, left: 0 });
  if (!r) {
    const cy = mobile ? (lastDock === "bottom" ? (vh - cardH) / 2 : (vh + cardH) / 2) : vh / 2;
    return { ring: { top: cy, left: vw / 2, width: 0, height: 0 }, card: mobile ? docked(lastDock) : { top: Math.max(12, (vh - cardH) / 2), left: Math.max(12, (vw - cardW) / 2) }, dock: mobile ? lastDock : null };
  }
  let ring: Box, card: Spot["card"] = null, dock: Spot["dock"] = null;
  if (mobile) {
    // On a phone the card is a sheet along the bottom, where the thumb is,
    // and moves to the top only when what it describes is down there itself.
    // Targets are scrolled up under the header, so one that still starts in
    // the lower half is fixed down there (the tab bar) and wants the top.
    dock = r.top > vh * 0.5 ? "top" : "bottom";
    ring = clip(r, dock === "bottom" ? vh - cardH - 28 - safe.bottom : vh - 12, vh);
    card = docked(dock);
  } else {
    ring = clip(r, vh - 24, vh * 0.55);
    // A wide panel with no room above or below it would end up under the
    // card, so less of it is lit and the card sits beneath what is.
    if (ring.top + ring.height + GAP + cardH > vh - 12 && ring.top - GAP - cardH < 12) {
      const room = vh - 12 - cardH - GAP - ring.top;
      if (room >= 90) ring = { ...ring, height: room };
    }
    const below = ring.top + ring.height + GAP + cardH <= vh - 12;
    card = {
      top: clamp(below ? ring.top + ring.height + GAP : ring.top - GAP - cardH, 12, vh - cardH - 12),
      left: clamp(ring.left + ring.width / 2 - cardW / 2, 12, vw - cardW - 12),
    };
  }
  // The ring is kept inside the screen: a bar that runs edge to edge would
  // otherwise lose its sides.
  const l = Math.max(ring.left, 8), rt = Math.min(ring.left + ring.width, vw - 8);
  const t = Math.max(ring.top, 8), b = Math.min(ring.top + ring.height, vh - 8);
  return { ring: { top: t, left: l, width: Math.max(0, rt - l), height: Math.max(0, b - t) }, card, dock };
}

// Motion. A move from one step to the next is one glide on a gentle
// ease-in-out, the page scrolling on the same curve and for the same time so
// the ring and what it points at arrive together. Between steps the ring stays
// glued to its target, so scrolling carries it along exactly, and anything
// that shifts under it (a table filling in) is eased toward rather than
// jumped to.
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const ease = (t: number) => 0.5 - Math.cos(Math.PI * t) / 2;
const glideFor = (dist: number) => (reduced() ? 0 : clamp(520 + Math.abs(dist) * 0.1, 620, 1000));
const mix = (a: number, b: number, p: number) => a + (b - a) * p;
const mixBox = (a: Box, b: Box, p: number): Box => ({ top: mix(a.top, b.top, p), left: mix(a.left, b.left, p), width: mix(a.width, b.width, p), height: mix(a.height, b.height, p) });

let scrollAnim = 0;
/** Where a running glideScroll will stop, so the ring and card can head for
 *  where their target will be rather than chase it while it slides past. */
let scrollGoal: number | null = null;
/** Scroll the page to `y` over `ms` on the tour's curve. A wheel or a touch
 *  from the reader takes over at once. */
function glideScroll(y: number, ms: number) {
  cancelAnimationFrame(scrollAnim);
  const from = window.scrollY, to = clamp(y, 0, document.documentElement.scrollHeight - window.innerHeight);
  if (!ms || Math.abs(to - from) < 2) { scrollGoal = null; window.scrollTo(0, to); return; }
  scrollGoal = to;
  // Progress advances by at most a normal frame each tick, so a frame the
  // page spends busy (a chart mounting) slows the scroll rather than skips it.
  let elapsed = 0, last = performance.now();
  const stop = () => { cancelAnimationFrame(scrollAnim); scrollGoal = null; off(); };
  const off = () => { window.removeEventListener("wheel", stop); window.removeEventListener("touchstart", stop); };
  window.addEventListener("wheel", stop, { passive: true, once: true });
  window.addEventListener("touchstart", stop, { passive: true, once: true });
  const frame = (now: number) => {
    elapsed += Math.min(now - last, 20); last = now;
    const p = Math.min(1, elapsed / ms);
    window.scrollTo(0, mix(from, to, ease(p)));
    if (p < 1) scrollAnim = requestAnimationFrame(frame); else { scrollGoal = null; off(); }
  };
  scrollAnim = requestAnimationFrame(frame);
}

/** True when the url the step wants is not the one on screen. Only the params
 *  the step names are compared, so anything a page adds for itself is left
 *  alone rather than being navigated away again a moment later. */
function needsNav(want: string, pathname: string, search: string): boolean {
  const [path, query] = want.split("?");
  if (pathname !== path) return true;
  const have = new URLSearchParams(search);
  for (const [k, v] of new URLSearchParams(query ?? "")) if (have.get(k) !== v) return true;
  return false;
}

export default function Tour({ onDone, startPath }: { onDone: () => void; startPath?: string }) {
  const { meta, settings } = useMeta();
  const lens = useLens();
  const mobile = useMobile();
  // Fixed for the length of the tour, so the count does not shift under the
  // reader if a setting changes halfway through.
  const [CHAPTERS] = useState(() => chaptersFor(lens, mobile));
  const [STEPS] = useState(() => CHAPTERS.flatMap((ch, k) => ch.steps.map((step) => ({ ...step, ch: k }))));
  const [i, setI] = useState(() => {
    // Opened from a page, the tour starts on that page's chapter.
    const k = startPath && startPath !== "/" ? CHAPTERS.findIndex((ch) => ch.path === startPath) : -1;
    return k < 0 ? 0 : STEPS.findIndex((s) => s.ch === k);
  });
  // Which way the reader is going, so an optional step that is not there is
  // skipped in the same direction.
  const dir = useRef<1 | -1>(1);
  const [menu, setMenu] = useState(false);
  const [cast, setCast] = useState<Cast | null>(null);
  // What the step points at, found by the timer below and followed frame by
  // frame by the motion loop, which moves the ring and card itself.
  const [lit, setLit] = useState(false);
  const target = useRef<Element | null>(null);
  const glide = useRef(0);
  const [dock, setDock] = useState<"top" | "bottom">("bottom");
  const cardRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const safeRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const scrolled = useRef(-1);
  const prepped = useRef(-1);
  // When this step started and whether its own target has been seen yet, so a
  // ring left over from the last step is let go of rather than lit under the
  // new step's words.
  const started = useRef({ i: -1, t: 0, path: "" });
  const foundFor = useRef(-1);
  const nav = useNavigate();
  const loc = useLocation();
  if (started.current.i !== i) started.current = { i, t: Date.now(), path: loc.pathname };
  const step = STEPS[i];
  const chapter = CHAPTERS[step.ch];
  const last = i === STEPS.length - 1;
  const ctx: Ctx = { c: cast ?? EMPTY_CAST, lens, mobile };
  const sel = step.sel ? (typeof step.sel === "string" ? step.sel : step.sel(ctx)) : null;

  const go = (n: number, d: 1 | -1) => { dir.current = d; setMenu(false); if (n >= STEPS.length) onDone(); else setI(Math.max(0, n)); };
  const next = () => go(i + 1, 1);
  const back = () => go(i - 1, -1);
  const firstOf = (k: number) => STEPS.findIndex((s) => s.ch === k);
  const nextPage = step.ch + 1 < CHAPTERS.length - 1 ? firstOf(step.ch + 1) : -1;

  // Some steps switch a page's own tab or view to show it. Those choices are
  // remembered by the page, so they are put back as they were when the tour
  // ends: the visitor's Fantasy tab should not open on My team because the
  // tour went there.
  useEffect(() => {
    const keys = ["fantasy.view", "results.tab"];
    const before = keys.map((k) => [k, readSticky<unknown>(k, undefined)] as const);
    return () => before.forEach(([k, v]) => (v === undefined ? clearSticky(k) : writeSticky(k, v)));
  }, []);

  // One pass at the start finds a player, game, team and coach worth opening,
  // the visitor's own where they have told us. It runs while the home steps are
  // being read, so by the time the tour opens a player it is already there.
  useEffect(() => {
    if (!meta) return;
    let live = true;
    const prefer = { team: lens.profile?.team ?? null, roster: lens.fantasy ? readSticky<RosterEntry[]>("fantasy.roster", []) : [] };
    buildCast(meta, settings, prefer).then((c) => live && setCast(c)).catch(() => live && setCast(EMPTY_CAST));
    return () => { live = false; };
  }, [meta]);

  const held = step.needsCast && !cast;
  const want = held ? null : step.where?.(ctx) ?? null;

  // The route changes first: the element a step points at does not exist until
  // its page is mounted and its data has landed.
  useEffect(() => {
    if (want && needsNav(want, loc.pathname, loc.search)) nav(want);
  }, [want, loc.pathname, loc.search]);

  // Pages arrive from the network and tables settle after they paint, so the
  // target is re-measured for as long as the step is up. One timer covers late
  // content, scrolling and window resizes alike.
  useEffect(() => {
    const lose = () => { target.current = null; setLit(false); };
    if (!sel) { lose(); return; }
    // Crossing to another page: let the ring go rather than leaving it sitting
    // over whatever has taken the old element's place.
    if (want && loc.pathname !== want.split("?")[0]) lose();
    const tick = () => {
      // A step that needs the page in a particular state (a tab, a view) sets
      // it first, once its page is up, and measures on the next beat.
      if (step.prep && prepped.current !== i) {
        if (want && loc.pathname !== want.split("?")[0]) return;
        if (step.prep()) prepped.current = i;
        return;
      }
      const el = document.querySelector(sel);
      if (!el) {
        // An optional panel that may not be here keeps the ring where it was
        // while the page is checked, so a skip glides straight on to the next
        // step instead of closing and reopening in between.
        if (foundFor.current !== i && Date.now() - started.current.t > 300) (step.optional ? setLit(false) : lose());
        return;
      }
      foundFor.current = i;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      if (scrolled.current !== i) {
        scrolled.current = i;
        const fixed = getComputedStyle(el).position === "fixed" || !!el.closest(".topbar, .tabbar");
        // On a phone the card owns the bottom of the screen, so the target is
        // brought up under the header instead of into the middle. Centring a
        // panel taller than the window lands halfway down it, past the part
        // that says what it is, so those go to the top on desktop too.
        let dy = 0;
        if (!fixed) dy = mobile || r.height > window.innerHeight - 120 ? r.top - (mobile ? PHONE_TOP : 84) : r.top + r.height / 2 - window.innerHeight / 2;
        // The ring's glide takes as long as the scroll, so both land at once.
        glide.current = glideFor(Math.max(Math.abs(dy), 300));
        if (dy) glideScroll(window.scrollY + dy, glide.current);
      }
      target.current = el;
      setLit(true);
    };
    tick();
    const timer = window.setInterval(tick, 80);
    return () => window.clearInterval(timer);
  }, [i, sel, want, loc.pathname, mobile]);

  // A page that never renders its target (nothing pulled for the week, say)
  // should still get its say: after a beat the tab it lives under is lit up
  // instead, and failing that the card is simply centred.
  const [gaveUp, setGaveUp] = useState(false);
  const [onTab, setOnTab] = useState(false);
  // The clock starts once the step's page is on screen: a slow page load is
  // not a missing panel.
  const arrived = !held && (!want || loc.pathname === want.split("?")[0]);
  useEffect(() => {
    setGaveUp(false);
    setOnTab(false);
    if (!arrived) return;
    // An optional panel on a page that was already up gets a short look; one
    // on a page still loading gets longer.
    const settled = started.current.path === want?.split("?")[0];
    const t = window.setTimeout(() => setGaveUp(true), step.optional ? (settled ? 1400 : 3000) : 2500);
    return () => window.clearTimeout(t);
  }, [i, arrived]);
  useEffect(() => {
    if (!gaveUp || lit) return;
    // Not on this page for this visitor (under More, or only on a finished
    // game): move on the way they were going.
    if (step.optional) { go(i + dir.current, dir.current); return; }
    const path = want?.split("?")[0];
    const tab = path && document.querySelector(`[data-tour="nav:${path}"]`);
    if (!tab) { setOnTab(true); return; }
    glide.current = glideFor(300);
    target.current = tab;
    setLit(true);
    setOnTab(true);
  }, [gaveUp, lit, want]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (menu ? setMenu(false) : onDone());
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Enter and Space press whatever has focus, and Next is what should have it.
  useEffect(() => { nextRef.current?.focus({ preventScroll: true }); }, [i]);

  // The motion loop. Runs for the life of the tour and writes the ring's and
  // card's positions straight to the page, so nothing re-renders per frame.
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;
  useEffect(() => {
    const pad = 6;
    const a = { ring: null as Box | null, card: null as Spot["card"], from: null as Spot | null, t0: 0, dur: 0, key: undefined as Element | null | undefined, lost: 0, run: 0, y: window.scrollY, fixed: true, dock: "bottom" as "top" | "bottom", h: 0, last: performance.now() };
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const ringEl = ringRef.current, cardEl = cardRef.current, inner = innerRef.current;
      if (!ringEl || !cardEl || !inner) return;
      const dt = Math.min(64, now - a.last); a.last = now;
      // The glide's clock, which never jumps more than a normal frame.
      a.run += Math.min(dt, 20);
      const mob = mobileRef.current;
      // The card's height follows its words smoothly; placement uses where it
      // is headed, so the card does not wander while it grows.
      const h = inner.offsetHeight;
      // Border-box: the card's own border is added on top of its contents.
      if (Math.abs(h - a.h) > 0.5) { a.h = h; cardEl.style.height = `${h + cardEl.offsetHeight - cardEl.clientHeight}px`; }
      let el = target.current;
      if (el && !el.isConnected) el = null;
      const r = el?.getBoundingClientRect();
      if (el !== a.key) a.fixed = !el || getComputedStyle(el).position === "fixed" || !!el.closest(".topbar, .tabbar");
      // Aim for where the target will be once the page stops scrolling, not
      // where it is mid-scroll: chasing a moving target is what makes a ring
      // swing past and come back.
      const ahead = a.fixed || scrollGoal === null ? 0 : scrollGoal - window.scrollY;
      const box = r && (r.width || r.height) ? { top: r.top - ahead, left: r.left, width: r.width, height: r.height } : null;
      if (!box) el = null;
      // A target that has just gone (the page is changing under it) is held
      // for a moment: the next one usually turns up within a beat, and gliding
      // straight there beats closing the ring and opening it again.
      if (!el && a.key && a.ring) {
        if (!a.lost) a.lost = now;
        if (now - a.lost < 350) {
          a.y = window.scrollY;
          writeOut(a.ring, a.card, true);
          return;
        }
      } else a.lost = 0;
      const sp = safeRef.current ? getComputedStyle(safeRef.current) : null;
      const safe = { top: parseFloat(sp?.paddingTop ?? "0") || 0, bottom: parseFloat(sp?.paddingBottom ?? "0") || 0 };
      const want = spotFor(box, mob, h, a.dock, safe);
      // A card docked at the bottom keeps its bottom edge still while its
      // height eases to fit new words, so it is placed by the height it has
      // right now rather than the one it is heading for.
      if (mob && want.card && want.dock === "bottom") want.card = { ...want.card, top: window.innerHeight - cardEl.offsetHeight - 10 - safe.bottom };
      if (want.dock && want.dock !== a.dock) { a.dock = want.dock; setDock(want.dock); if (!(a.from && a.run - a.t0 < a.dur) && a.ring) { a.from = { ring: a.ring, card: a.card, dock: null }; a.t0 = a.run; a.dur = glideFor(300); } }
      // Scrolling the reader does themselves carries a settled ring and card
      // with the page. The tour's own scroll is already allowed for above.
      const dy = window.scrollY - a.y; a.y = window.scrollY;
      const gliding = a.from && a.dur && a.run - a.t0 < a.dur;
      if (dy && !a.fixed && a.ring && !gliding && scrollGoal === null) { a.ring = { ...a.ring, top: a.ring.top - dy }; if (a.card) a.card = { ...a.card, top: a.card.top - dy }; }
      if (el !== a.key) {
        // A new target: one glide from wherever things are now.
        a.key = el;
        a.from = a.ring ? { ring: a.ring, card: a.card ?? want.card, dock: null } : null;
        a.t0 = a.run;
        a.dur = el ? glide.current || glideFor(300) : reduced() ? 0 : 480;
      }
      const p = a.from && a.dur ? Math.min(1, (a.run - a.t0) / a.dur) : 1;
      if (a.from && p < 1) {
        const e = ease(p);
        a.ring = mixBox(a.from.ring, want.ring, e);
        a.card = want.card && a.from.card ? { top: mix(a.from.card.top, want.card.top, e), left: mix(a.from.card.left, want.card.left, e) } : want.card;
      } else {
        // Settled: ease toward anything that moves under the ring, at a rate
        // that does not depend on the frame rate.
        const k = reduced() || !a.ring ? 1 : 1 - Math.pow(1 - 0.2, dt / 16.7);
        a.ring = a.ring ? mixBox(a.ring, want.ring, k) : want.ring;
        // A settled phone card sits exactly on its dock.
        const kc = mob ? 1 : k;
        a.card = want.card && a.card ? { top: mix(a.card.top, want.card.top, kc), left: mix(a.card.left, want.card.left, kc) } : want.card;
      }
      writeOut(a.ring, a.card, !!el);
    };
    const writeOut = (g: Box, card: Spot["card"], on: boolean) => {
      const ringEl = ringRef.current!, cardEl = cardRef.current!;
      const q = pad * clamp(Math.min(g.width, g.height) / 24, 0, 1);
      ringEl.style.transform = `translate3d(${g.left - q}px, ${g.top - q}px, 0)`;
      ringEl.style.width = `${g.width + q * 2}px`;
      ringEl.style.height = `${g.height + q * 2}px`;
      ringEl.classList.toggle("off", !on);
      if (card) cardEl.style.transform = `translate3d(${card.left}px, ${card.top}px, 0)`;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // A sideways swipe on the card turns the page, the way a phone expects.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current; touch.current = null;
    if (!s) return;
    const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? next : back)();
  };

  const waiting = !!sel && !lit;
  const Icon = chapter.path ? ICONS[chapter.path] : null;
  const empty = onTab && step.ifEmpty;
  return (
    <div className={`tour ${mobile ? "phone" : ""}`} role="dialog" aria-modal="true" aria-label="Guided tour">
      <div className="tour-veil" />
      <div ref={safeRef} className="tour-safe" aria-hidden="true" />
      <div ref={ringRef} className="tour-ring off" />
      <div ref={cardRef} className={`tour-card ${mobile ? `dock-${dock}` : ""}`} style={mobile ? undefined : { width: Math.min(CARD_W, window.innerWidth - 24) }} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div ref={innerRef} className="tour-inner">
        <div className="tour-top">
          <button className={`tour-chapter ${menu ? "open" : ""}`} aria-expanded={menu} aria-haspopup="menu" title="Jump to another page" onClick={() => setMenu(!menu)}>
            {Icon ? <Icon size={15} active /> : <Spark size={14} />}{chapter.label}<IconChevron size={12} />
          </button>
          <span className="tour-count">{i + 1} / {STEPS.length}</span>
          <button className="tour-x" aria-label="End the tour" onClick={onDone}><IconClose size={16} /></button>
        </div>
        {/* One segment per page, so it reads as where you are in the site as
            well as how far through the tour. */}
        <div className="tour-progress" aria-hidden="true">
          {CHAPTERS.map((ch, k) => {
            const from = firstOf(k), n = ch.steps.length;
            const fill = k < step.ch ? 1 : k > step.ch ? 0 : (i - from + 1) / n;
            return <span key={ch.key} style={{ flex: n }}><i style={{ transform: `scaleX(${fill})` }} /></span>;
          })}
        </div>
        {menu ? (
          <div className="tour-menu" role="menu">
            {CHAPTERS.map((ch, k) => {
              const CI = ch.path ? ICONS[ch.path] : null;
              return (
                <button key={ch.key} role="menuitem" className={k === step.ch ? "on" : k < step.ch ? "done" : ""} onClick={() => go(firstOf(k), 1)}>
                  <span className="tour-menu-icon">{CI ? <CI size={16} active={k === step.ch} /> : <Spark size={14} />}</span>
                  <span className="tour-menu-label">{ch.label}</span>
                  <span className="tour-menu-n">{ch.steps.length}</span>
                </button>
              );
            })}
          </div>
        ) : <>
          {/* An optional step says nothing until its panel turns up: if it
              never does, the tour moves on without having described it. */}
          {!(step.optional && !lit) && (
            <div key={i} className="tour-body" aria-live="polite">
              <h2>{text(step.title, ctx)}</h2>
              <div className="tour-text">{step.body(ctx)}</div>
            </div>
          )}
          {empty && <div className="tour-empty">{step.ifEmpty}</div>}
          {waiting && !empty && <div className="tour-wait"><span className="spin" /> {held ? "finding a live example" : step.optional ? "checking this page" : "opening it"}…</div>}
        </>}
        <div className="tour-actions">
          {i === 0
            ? <button className="btn ghost" onClick={onDone}>Skip tour</button>
            : <button className="btn" onClick={back}>Back</button>}
          <div className="spacer" />
          {!mobile && <span className="tour-keys" aria-hidden="true"><kbd>←</kbd><kbd>→</kbd></span>}
          {nextPage > i + 1 && <button className="linkish tour-skip" onClick={() => go(nextPage, 1)}>Skip page</button>}
          <button ref={nextRef} className="btn primary" onClick={next}>{last ? "Finish" : i === 0 ? "Show me" : "Next"}</button>
        </div>
        </div>
      </div>
    </div>
  );
}
