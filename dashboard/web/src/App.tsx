import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import PlayerSearch from "./components/PlayerSearch";
import Board from "./pages/Board";
import Games from "./pages/Games";
import Predictions from "./pages/Predictions";
import Research from "./pages/Research";
import Settings from "./pages/Settings";
import Teams from "./pages/Teams";
import Matchups from "./pages/Matchups";
import Results from "./pages/Results";
import Coaches from "./pages/Coaches";
import Fantasy from "./pages/Fantasy";
import Tour from "./components/Tour";
import Welcome from "./components/Welcome";
import Tailor from "./components/Tailor";
import { arrange, TABS, useLens } from "./lib/profile";
import { gameWeek, warmAll } from "./lib/prefetch";
import { clearSticky, readSticky, useSticky, writeSticky } from "./lib/sticky";
import { MetaProvider, useMeta } from "./state";
import type { Meta } from "./api";

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
  // Tabs outside the tailored profile go behind "More" rather than away.
  const { shown, tucked } = arrange(useLens(), TABS.map((t) => ({ ...t, id: `tab:${t.path}` })));
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [loc.pathname]);
  const inMore = tucked.some((t) => t.path === loc.pathname);
  return (
    <>
      <nav className="nav" data-tour="nav">
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

// "/" opens the lines board for anyone here for betting (and anyone who has
// not said), the fantasy week for fantasy players, and research for the rest.
function Home() {
  const { betting, fantasy } = useLens();
  return betting ? <Board /> : <Navigate to={fantasy ? "/fantasy" : "/research"} replace />;
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
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" data-tour="brand"><span className="dot" />Aggregate Analytics{meta && <span className="muted" style={{ fontWeight: 400 }}> · {meta.season} wk {meta.week}</span>}</div>
        <Tabs />
        <div className="spacer" />
        <div data-tour="search"><PlayerSearch onSelect={(p) => nav(`/research?player=${p.player_id}`)} placeholder="Jump to player…" /></div>
        <button className="theme-btn" title="Answer a few questions and the pages rearrange around what you care about" onClick={() => setStage("tailor")}>{settings.profile ? "Tailored" : "Tailor"}</button>
        <button className="theme-btn" title="Welcome notes and guided tour" onClick={() => setStage("welcome")}>?</button>
        <button className="theme-btn" title="toggle light / dark" onClick={() => setSettings({ theme: settings.theme === "dark" ? "light" : "dark" })}>{settings.theme === "dark" ? "Light" : "Dark"}</button>
      </header>
      <main className="main">
        {error && <div className="banner err">API unreachable: {error}. Start it with <code>uvicorn dashboard.api.app:app --port 8017</code>.</div>}
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
      </main>
      {stage === "welcome" && <Welcome onTour={() => { writeSticky("onboard.seen.v1", true); setStage("tour"); }} onTailor={() => { writeSticky("onboard.seen.v1", true); setStage("tailor"); }} onSkip={close} />}
      {stage === "tailor" && <Tailor onDone={close} onCancel={close} />}
      {stage === "tour" && <Tour onDone={close} />}
    </div>
  );
}
export default function App() { return <MetaProvider><Shell /></MetaProvider>; }
