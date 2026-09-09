import { useEffect } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
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
import { warmAll } from "./lib/prefetch";
import { clearSticky, readSticky, useSticky, writeSticky } from "./lib/sticky";
import { MetaProvider, useMeta } from "./state";

// Which player, coach, team or game a page is showing lives in the query
// string, and a plain link to "/coaches" would throw it away. Each tab points
// at wherever that section was last left, so switching away and back returns to
// the same view rather than an empty one.
const SECTIONS: [string, string][] = [
  ["/research", "Research"], ["/board", "Lines board"], ["/matchups", "Matchups"], ["/games", "Games"],
  ["/teams", "Teams"], ["/coaches", "Coaches"], ["/predictions", "Predictions"], ["/results", "Results"], ["/settings", "Settings"],
];

function Tabs() {
  const loc = useLocation();
  const [last, setLast] = useSticky<Record<string, string>>("nav.last", {});
  useEffect(() => {
    const hit = SECTIONS.find(([path]) => path === loc.pathname);
    if (!hit) return;
    const full = loc.pathname + loc.search;
    setLast((prev) => (prev[hit[0]] === full ? prev : { ...prev, [hit[0]]: full }));
  }, [loc.pathname, loc.search]);
  return (
    <nav className="nav">
      {SECTIONS.map(([path, label]) => <NavLink key={path} to={last[path] ?? path}>{label}</NavLink>)}
    </nav>
  );
}

function Shell() {
  const { meta, error, settings, setSettings } = useMeta();
  const nav = useNavigate();
  // Week pickers are sticky and now outlive the browser session, so a week
  // chosen by hand has to be let go of once the league moves past it.
  useEffect(() => {
    if (!meta) return;
    const now = `${meta.season}-${meta.week}`;
    if (readSticky<string | null>("nfl.week", null) === now) return;
    for (const k of ["board.week", "games.week", "matchups.week", "predictions.week", "results.week", "settings.week"]) clearSticky(k);
    writeSticky("nfl.week", now);
  }, [meta]);
  // Load every tab in the background as soon as meta lands, so opening one is
  // a render rather than a round trip.
  useEffect(() => { if (meta) warmAll(meta, settings); }, [meta, settings.includeSample, settings.since, settings.thresholdScale]);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="dot" />Props Research{meta && <span className="muted" style={{ fontWeight: 400 }}> · {meta.season} wk {meta.week}</span>}</div>
        <Tabs />
        <div className="spacer" />
        <PlayerSearch onSelect={(p) => nav(`/research?player=${p.player_id}`)} placeholder="Jump to player…" />
        <button className="theme-btn" title="toggle light / dark" onClick={() => setSettings({ theme: settings.theme === "dark" ? "light" : "dark" })}>{settings.theme === "dark" ? "Light" : "Dark"}</button>
      </header>
      <main className="main">
        {error && <div className="banner err">API unreachable: {error}. Start it with <code>uvicorn dashboard.api.app:app --port 8017</code>.</div>}
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/research" element={<Research />} />
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
    </div>
  );
}
export default function App() { return <MetaProvider><Shell /></MetaProvider>; }
