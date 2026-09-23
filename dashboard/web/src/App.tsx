import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import PlayerSearch from "./components/PlayerSearch";
import Tour from "./components/Tour";
import Welcome from "./components/Welcome";
import Tailor from "./components/Tailor";
import Sheet from "./components/Sheet";
import { ICONS, IconClose, IconHelp, IconMenu, IconMoon, IconMore, IconSearch, IconSliders, IconSun } from "./components/Icons";
import { useMobile } from "./lib/useMobile";
import Spark from "./components/Spark";
import { arrange, TABS, useLens } from "./lib/profile";
import { gameWeek, warmAll } from "./lib/prefetch";
import { clearSticky, readSticky, useSticky, writeSticky } from "./lib/sticky";
import { MetaProvider, useMeta } from "./state";
import type { Meta } from "./api";
import { Spinner } from "./components/common";

// Each page is its own chunk, so a phone paints the one it opened on without
// first downloading every chart on every other tab. The rest are fetched as
// soon as the first page is up (see Shell), so switching tabs stays instant.
const PAGES = {
  Board: () => import("./pages/Board"), Games: () => import("./pages/Games"), Predictions: () => import("./pages/Predictions"),
  Research: () => import("./pages/Research"), Settings: () => import("./pages/Settings"), Teams: () => import("./pages/Teams"),
  Matchups: () => import("./pages/Matchups"), Results: () => import("./pages/Results"), Coaches: () => import("./pages/Coaches"),
  Fantasy: () => import("./pages/Fantasy"), Home: () => import("./pages/Home"),
};
const Board = lazy(PAGES.Board), Games = lazy(PAGES.Games), Predictions = lazy(PAGES.Predictions), Research = lazy(PAGES.Research),
  Settings = lazy(PAGES.Settings), Teams = lazy(PAGES.Teams), Matchups = lazy(PAGES.Matchups), Results = lazy(PAGES.Results),
  Coaches = lazy(PAGES.Coaches), Fantasy = lazy(PAGES.Fantasy), Home = lazy(PAGES.Home);

// Which player, coach, team or game a page is showing lives in the query
// string, and a plain link to "/coaches" would throw it away. Each tab points
// at wherever that section was last left, so switching away and back returns to
// the same view rather than an empty one. The tabs themselves, and who each is
// for, live in lib/profile.
const SECTIONS: [string, string][] = TABS.map((t) => [t.path, t.label]);

// The Matchups tab remembers the game it was left on, but only while that game
// is in the week the page would open to. Otherwise, once the league moves on,
// the tab brings back last week's game under this week's slate.
function tabLink(path: string, last: string | undefined, meta: Meta | null): string {
  if (!last) return path;
  if (path !== "/matchups" || !meta) return last;
  const game = new URLSearchParams(last.split("?")[1] ?? "").get("game");
  if (!game) return last;
  const gw = gameWeek(game);
  const week = readSticky<number | null>("matchups.week", null) ?? meta.week;
  return gw && gw.season === meta.season && gw.week === week ? last : path;
}

/** The tabs in the order this profile reaches for them, ready for arrange(). */
function orderedTabs(lens: ReturnType<typeof useLens>) {
  return [...TABS].sort((a, b) => lens.tabOrder.indexOf(a.path) - lens.tabOrder.indexOf(b.path)).map((t) => ({ ...t, id: `tab:${t.path}` }));
}

function Tabs() {
  const loc = useLocation();
  const { meta } = useMeta();
  const [last, setLast] = useSticky<Record<string, string>>("nav.last", {});
  useEffect(() => {
    const hit = SECTIONS.find(([path]) => path === loc.pathname);
    if (!hit) return;
    const full = loc.pathname + loc.search;
    setLast((prev) => (prev[hit[0]] === full ? prev : { ...prev, [hit[0]]: full }));
  }, [loc.pathname, loc.search]);
  // On a phone the tabs scroll sideways, so the lit one is brought into view
  // rather than left somewhere past the edge.
  useEffect(() => { document.querySelector<HTMLElement>(".nav a.active")?.scrollIntoView({ inline: "nearest", block: "nearest" }); }, [loc.pathname]);
  // Tabs come in the order this profile reaches for them, and the ones
  // outside it go behind "More" rather than away.
  const { shown, tucked } = arrange(useLens(), orderedTabs(useLens()));
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [loc.pathname]);
  const inMore = tucked.some((t) => t.path === loc.pathname);
  // Whether the tab strip runs past its box, for the fade on its edge.
  const strip = useRef<HTMLElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth - el.scrollLeft - el.clientWidth > 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener("scroll", check, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener("scroll", check); };
  }, [shown.length]);
  return (
    <>
      <nav className={`nav ${overflowing ? "overflowing" : ""}`} data-tour="nav" ref={strip}>
        {shown.map((t) => <NavLink key={t.path} to={tabLink(t.path, last[t.path], meta)} data-tour={`nav:${t.path}`}>{t.label}</NavLink>)}
      </nav>
      {tucked.length > 0 && (
        <div className="nav-more">
          <button className={`nav-more-btn ${inMore ? "active" : ""}`} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>{inMore ? tucked.find((t) => t.path === loc.pathname)!.label : "More"} ▾</button>
          {open && <>
            <div className="nav-more-veil" onClick={() => setOpen(false)} />
            <div className="nav-more-menu" role="menu">
              <div className="hint">Outside your interests</div>
              {tucked.map((t) => <NavLink key={t.path} role="menuitem" to={tabLink(t.path, last[t.path], meta)} data-tour={`nav:${t.path}`}>{t.label}</NavLink>)}
            </div>
          </>}
        </div>
      )}
    </>
  );
}

// Phones get the app's own shape: a slim header that slides away while
// reading, and the sections as a tab bar under the thumb. Four sections sit in
// the bar (the first four the profile puts forward); everything else, Settings
// included, is one tap away in the More sheet.
function BottomNav({ onMore, moreOpen }: { onMore: () => void; moreOpen: boolean }) {
  const loc = useLocation();
  const { meta } = useMeta();
  const [last] = useSticky<Record<string, string>>("nav.last", {});
  const { shown } = arrange(useLens(), orderedTabs(useLens()));
  const bar = shown.filter((t) => t.path !== "/settings").slice(0, 4);
  const at = bar.findIndex((t) => t.path === loc.pathname);
  const hereInMore = at < 0 && TABS.find((t) => t.path === loc.pathname);
  // Home is not a tab, so nothing is lit there.
  const idx = moreOpen || hereInMore ? bar.length : at;
  return (
    <nav className="tabbar" data-tour="nav" style={{ ["--n" as string]: bar.length + 1, ["--i" as string]: idx }}>
      <span className="tabbar-pill" aria-hidden="true" style={idx < 0 ? { opacity: 0 } : undefined} />
      {bar.map((t) => {
        const Icon = ICONS[t.path];
        return (
          <NavLink key={t.path} to={tabLink(t.path, last[t.path], meta)} data-tour={`nav:${t.path}`} className={({ isActive }) => (isActive && !moreOpen ? "on" : "")}
            onClick={(e) => { if (loc.pathname === t.path) { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); } }}>
            {({ isActive }) => <><Icon active={isActive && !moreOpen} /><span>{t.label.replace("Lines board", "Board")}</span></>}
          </NavLink>
        );
      })}
      <button className={moreOpen || hereInMore ? "on" : ""} onClick={onMore} aria-haspopup="dialog">
        {hereInMore && !moreOpen ? ICONS[hereInMore.path]({ active: true }) : <IconMore active={moreOpen} />}<span>{hereInMore && !moreOpen ? hereInMore.label : "More"}</span>
      </button>
    </nav>
  );
}

function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const loc = useLocation();
  const { meta } = useMeta();
  const [last] = useSticky<Record<string, string>>("nav.last", {});
  const { shown, tucked } = arrange(useLens(), orderedTabs(useLens()));
  const bar = new Set(shown.filter((t) => t.path !== "/settings").slice(0, 4).map((t) => t.path));
  const rest = shown.filter((t) => !bar.has(t.path));
  const tile = (t: (typeof TABS)[number], k: number) => {
    const Icon = ICONS[t.path];
    return (
      <NavLink key={t.path} to={tabLink(t.path, last[t.path], meta)} onClick={onClose} className={`more-tile ${loc.pathname === t.path ? "on" : ""}`} style={{ animationDelay: `${40 + k * 30}ms` }}>
        <span className="more-tile-icon"><Icon size={28} active={loc.pathname === t.path} /></span>{t.label}
      </NavLink>
    );
  };
  return (
    <Sheet open={open} onClose={onClose} title={<b>All sections</b>}>
      <div className="more-grid">{rest.map(tile)}</div>
      {tucked.length > 0 && <>
        <div className="sheet-label">Outside your interests</div>
        <div className="more-grid">{tucked.map((t, k) => tile(t, rest.length + k))}</div>
      </>}
    </Sheet>
  );
}

function MobileHeader({ onSearch, onMenu, pinned }: { onSearch: () => void; onMenu: () => void; pinned: boolean }) {
  const { meta } = useMeta();
  // Down hides the header, any move back up brings it back, and it never
  // leaves while the page is near the top.
  const [away, setAway] = useState(false);
  const y0 = useRef(0);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY, d = y - y0.current;
      if (Math.abs(d) < 6) return;
      setAway(d > 0 && y > 80);
      y0.current = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header className={`topbar mtop ${away && !pinned ? "away" : ""}`}>
      <Link to="/" className="brand" data-tour="brand" aria-label="Home">
        <span className="dot" />Aggregate Analytics
        {meta && <span className="week-chip">Wk {meta.week}</span>}
      </Link>
      <div className="spacer" />
      <button className="icon-btn" aria-label="Search players" data-tour="search" onClick={onSearch}><IconSearch /></button>
      <button className="icon-btn" aria-label="Menu" onClick={onMenu}><IconMenu /></button>
    </header>
  );
}

function MenuSheet({ open, onClose, onTailor, onWelcome }: { open: boolean; onClose: () => void; onTailor: () => void; onWelcome: () => void }) {
  const { settings, setSettings } = useMeta();
  const dark = settings.theme === "dark";
  return (
    <Sheet open={open} onClose={onClose} title={<b>Aggregate Analytics</b>}>
      <div className="menu-list">
        <button className="menu-row" onClick={onTailor}>
          <span className="menu-icon"><IconSliders /></span>
          <span><b>{settings.profile ? "Tailored to you" : "Tailor it to me"}</b><span className="sub">{settings.profile ? "Change your answers and the pages rearrange" : "A few quick questions, and every page rearranges around them"}</span></span>
        </button>
        <button className="menu-row" onClick={onWelcome}>
          <span className="menu-icon"><IconHelp /></span>
          <span><b>Welcome and tour</b><span className="sub">What the numbers are, and a one-minute walk through</span></span>
        </button>
        <div className="menu-row static">
          <span className="menu-icon">{dark ? <IconMoon /> : <IconSun />}</span>
          <span><b>Appearance</b></span>
          <div className="theme-switch" role="radiogroup" aria-label="Theme">
            <button role="radio" aria-checked={!dark} className={!dark ? "on" : ""} onClick={() => setSettings({ theme: "light" })}><IconSun size={18} /> Light</button>
            <button role="radio" aria-checked={dark} className={dark ? "on" : ""} onClick={() => setSettings({ theme: "dark" })}><IconMoon size={18} /> Dark</button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

function SearchSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  return (
    <Sheet open={open} onClose={onClose} tall className="search-sheet"
      title={<><b>Find a player</b><button className="icon-btn" aria-label="Close" onClick={onClose}><IconClose /></button></>}>
      {open && <PlayerSearch inline autoFocus placeholder="Name, e.g. Bijan Robinson" onSelect={(p) => { onClose(); nav(`/research?player=${p.player_id}`); }} />}
    </Sheet>
  );
}


function rollWeek(meta: Meta): void {
  const now = `${meta.season}-${meta.week}`;
  if (readSticky<string | null>("nfl.week", null) === now) return;
  for (const k of ["fantasy.week", "board.week", "games.week", "matchups.week", "predictions.week", "results.week", "settings.week"]) clearSticky(k);
  writeSticky("nfl.week", now);
}

type Stage = "welcome" | "tour" | "tailor" | null;

function Shell() {
  const { meta, error, settings, setSettings } = useMeta();
  const nav = useNavigate();
  // Shown once, then never again unless the ? in the header asks for it.
  const [stage, setStage] = useState<Stage>(() => (readSticky("onboard.seen.v1", false) ? null : "welcome"));
  const close = () => { writeSticky("onboard.seen.v1", true); setStage(null); };
  // Week pickers are sticky and now outlive the browser session, so a week
  // chosen by hand has to be let go of once the league moves past it. Done
  // during render rather than in an effect: the tabs and the page below read
  // these on this same render, and an effect would only run after they had
  // already come up on last week.
  if (meta) rollWeek(meta);
  // Load every tab in the background as soon as meta lands, so opening one is
  // a render rather than a round trip.
  useEffect(() => { if (meta) warmAll(meta, settings); }, [meta, settings.includeSample, settings.since]);
  useEffect(() => {
    const go = () => Object.values(PAGES).forEach((load) => load().catch(() => {}));
    const t = window.setTimeout(go, 1200);
    return () => window.clearTimeout(t);
  }, []);
  const mobile = useMobile();
  const loc = useLocation();
  // A tailored profile gives the whole site its mode's colour (see the
  // data-mode rules in styles.css); untailored, the attribute is absent.
  const { mode } = useLens();
  useEffect(() => {
    if (mode === "default") document.documentElement.removeAttribute("data-mode");
    else document.documentElement.setAttribute("data-mode", mode);
  }, [mode]);
  const [sheet, setSheet] = useState<"more" | "search" | "menu" | null>(null);
  useEffect(() => setSheet(null), [loc.pathname, loc.search]);
  // On a phone a new section starts at its top: arriving halfway down a page
  // you have never scrolled is disorienting on a small screen.
  useEffect(() => { if (mobile) window.scrollTo(0, 0); }, [loc.pathname]);
  // The browser chrome on a phone takes the page's own header colour.
  useEffect(() => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-2").trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg || "#1a1a1a");
  }, [settings.theme]);
  return (
    <div className={`app ${mobile ? "is-phone" : ""}`}>
      {mobile ? (
        <MobileHeader onSearch={() => setSheet("search")} onMenu={() => setSheet("menu")} pinned={stage === "tour"} />
      ) : (
        <header className="topbar">
          <Link to="/" className="brand" data-tour="brand" title="Home"><span className="dot" />Aggregate Analytics{meta && <span className="muted" style={{ fontWeight: 400 }}> · {meta.season} wk {meta.week}</span>}</Link>
          <Tabs />
          <div className="spacer" />
          <div data-tour="search"><PlayerSearch onSelect={(p) => nav(`/research?player=${p.player_id}`)} placeholder="Jump to player…" /></div>
          <button className={`tailor-btn ${settings.profile ? "set" : ""}`} title={settings.profile ? "Your layout is tailored. Change the answers any time." : "Answer a few questions and the pages rearrange around what you care about"} onClick={() => setStage("tailor")}>
            <Spark /><span className="label">{settings.profile ? "Tailored" : "Tailor"}</span>
          </button>
          <button className="theme-btn" title="Welcome notes and guided tour" onClick={() => setStage("welcome")}>?</button>
          <button className="theme-btn" title="toggle light / dark" onClick={() => setSettings({ theme: settings.theme === "dark" ? "light" : "dark" })}>{settings.theme === "dark" ? "Light" : "Dark"}</button>
        </header>
      )}
      <main className="main">
        {error && <div className="banner err">API unreachable: {error}. Start it with <code>uvicorn dashboard.api.app:app --port 8017</code>.</div>}
        <div className="page" key={loc.pathname}>
          <Suspense fallback={<div className="empty"><Spinner /></div>}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/research" element={<Research />} />
            <Route path="/fantasy" element={<Fantasy />} />
            <Route path="/board" element={<Board />} />
            <Route path="/games" element={<Games />} />
            <Route path="/matchups" element={<Matchups />} />
            <Route path="/teams" element={<Teams />} />
            <Route path="/coaches" element={<Coaches />} />
            <Route path="/predictions" element={<Predictions />} />
            <Route path="/results" element={<Results />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
          </Suspense>
        </div>
      </main>
      {mobile && <>
        <BottomNav onMore={() => setSheet(sheet === "more" ? null : "more")} moreOpen={sheet === "more"} />
        <MoreSheet open={sheet === "more"} onClose={() => setSheet(null)} />
        <SearchSheet open={sheet === "search"} onClose={() => setSheet(null)} />
        <MenuSheet open={sheet === "menu"} onClose={() => setSheet(null)}
          onTailor={() => { setSheet(null); setStage("tailor"); }} onWelcome={() => { setSheet(null); setStage("welcome"); }} />
      </>}
      {stage === "welcome" && <Welcome onTour={() => { writeSticky("onboard.seen.v1", true); setStage("tour"); }} onTailor={() => { writeSticky("onboard.seen.v1", true); setStage("tailor"); }} onSkip={close} />}
      {stage === "tailor" && <Tailor onDone={close} onCancel={close} />}
      {stage === "tour" && <Tour onDone={close} />}
    </div>
  );
}
export default function App() { return <MetaProvider><Shell /></MetaProvider>; }
