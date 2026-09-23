import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

const same = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

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
  // The old target holds its place until the new one has been found, so the
  // ring glides across a page instead of blinking out in between.
  const [box, setBox] = useState<Box | null>(null);
  const [lit, setLit] = useState(false);
  const [cardH, setCardH] = useState(220);
  const cardRef = useRef<HTMLDivElement>(null);
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
    if (!sel) { setLit(false); return; }
    // Crossing to another page: let the ring go rather than leaving it sitting
    // over whatever has taken the old element's place.
    if (want && loc.pathname !== want.split("?")[0]) setLit(false);
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
        if (foundFor.current !== i && Date.now() - started.current.t > 300) setLit(false);
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
        if (!fixed) {
          if (mobile || r.height > window.innerHeight - 120) window.scrollTo({ top: window.scrollY + r.top - (mobile ? PHONE_TOP : 84), behavior: "smooth" });
          else el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
      const found = { top: r.top, left: r.left, width: r.width, height: r.height };
      setBox((prev) => (same(prev, found) ? prev : found));
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
    const r = tab.getBoundingClientRect();
    setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
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

  // Knowing the card's own height lets it be placed by its top edge in every
  // case, and a single animated property is what makes it slide rather than
  // jump when it flips to the other side of a target.
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight ?? 0;
    if (h && Math.abs(h - cardH) > 1) setCardH(h);
  });

  // A sideways swipe on the card turns the page, the way a phone expects.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current; touch.current = null;
    if (!s) return;
    const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? next : back)();
  };

  const vh = window.innerHeight, vw = window.innerWidth;
  let place: React.CSSProperties, dock: "top" | "bottom" | null = null;
  let shown: Box | null = null;
  if (mobile) {
    // On a phone the card is a sheet along the bottom, where the thumb is,
    // and moves to the top only when what it describes is down there itself.
    // The stylesheet places it, so the safe areas are its to account for.
    // Targets are scrolled up under the header, so one that still starts in
    // the lower half is fixed down there (the tab bar) and wants the top.
    dock = box && box.top > vh * 0.5 ? "top" : "bottom";
    shown = box ? clip(box, dock === "bottom" ? vh - cardH - 28 : vh - 12, vh) : null;
    place = {};
  } else {
    let top: number, left: number;
    shown = box ? clip(box, vh - 24, vh * 0.55) : null;
    // A wide panel with no room above or below it would end up under the
    // card, so less of it is lit and the card sits beneath what is.
    if (shown && shown.top + shown.height + GAP + cardH > vh - 12 && shown.top - GAP - cardH < 12) {
      const room = vh - 12 - cardH - GAP - shown.top;
      if (room >= 90) shown = { ...shown, height: room };
    }
    const cardW = Math.min(CARD_W, vw - 24);
    const target = lit ? shown : null;
    if (target) {
      const below = target.top + target.height + GAP + cardH <= vh - 12;
      top = clamp(below ? target.top + target.height + GAP : target.top - GAP - cardH, 12, vh - cardH - 12);
      left = clamp(target.left + target.width / 2 - cardW / 2, 12, vw - cardW - 12);
    } else {
      top = Math.max(12, (vh - cardH) / 2);
      left = Math.max(12, (vw - cardW) / 2);
    }
    place = { top, left, width: cardW };
  }
  // The ring is kept inside the screen: a bar that runs edge to edge would
  // otherwise lose its sides.
  if (shown) {
    const l = Math.max(shown.left, 8), r = Math.min(shown.left + shown.width, vw - 8);
    const t = Math.max(shown.top, 8), b = Math.min(shown.top + shown.height, vh - 8);
    shown = { top: t, left: l, width: Math.max(0, r - l), height: Math.max(0, b - t) };
  }
  const target = lit ? shown : null;

  const waiting = !!sel && !lit;
  const pad = 6;
  const Icon = chapter.path ? ICONS[chapter.path] : null;
  const empty = onTab && step.ifEmpty;
  return (
    <div className={`tour ${mobile ? "phone" : ""}`} role="dialog" aria-modal="true" aria-label="Guided tour">
      <div className={`tour-veil ${target ? "" : "solid"}`} />
      <div
        className={`tour-ring ${target ? "" : "off"}`}
        style={shown ? { top: shown.top - pad, left: shown.left - pad, width: shown.width + pad * 2, height: shown.height + pad * 2 } : undefined}
      />
      <div ref={cardRef} className={`tour-card ${dock ? `dock-${dock}` : ""}`} style={place} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
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
  );
}
