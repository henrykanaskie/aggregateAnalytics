import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
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
import { MetaProvider, useMeta } from "./state";

function Shell() {
  const { meta, error, settings, setSettings } = useMeta();
  const nav = useNavigate();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="dot" />Props Research{meta && <span className="muted" style={{ fontWeight: 400 }}> · {meta.season} wk {meta.week}</span>}</div>
        <nav className="nav">
          <NavLink to="/research">Research</NavLink>
          <NavLink to="/board">Lines board</NavLink>
          <NavLink to="/matchups">Matchups</NavLink>
          <NavLink to="/games">Games</NavLink>
          <NavLink to="/teams">Teams</NavLink>
          <NavLink to="/coaches">Coaches</NavLink>
          <NavLink to="/predictions">Predictions</NavLink>
          <NavLink to="/results">Results</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
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
