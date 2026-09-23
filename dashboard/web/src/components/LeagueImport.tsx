import { useEffect, useState } from "react";
import { apiLeagues, ImportedLeague, ImportedTeam, LeagueImport as Result } from "../api";
import { Seg, Spinner } from "./common";

// Bring a roster in from the league someone actually plays in, instead of
// adding players one at a time. Three ways in, one result shape:
//   Sleeper: a username (Sleeper's API is public, nothing to sign in to)
//   ESPN: a league id, for leagues their manager has made public
//   Yahoo: sign in with Yahoo (its official API), which comes back as a page load
// Nothing is saved until "Use this team"; then the roster, the lineup slots
// and the starters replace what this browser had.

type Platform = "sleeper" | "espn" | "yahoo";
const NAME: Record<Platform, string> = { sleeper: "Sleeper", espn: "ESPN", yahoo: "Yahoo" };

export default function LeagueImport({ initial, onApply, onClose }: {
  /** A Yahoo result handed back by the sign-in round trip, if one just arrived. */
  initial?: Result | { error: string } | null;
  onApply: (team: ImportedTeam, league: ImportedLeague) => void;
  onClose?: () => void;
}) {
  const [platform, setPlatform] = useState<Platform>(initial && "platform" in initial ? initial.platform : "sleeper");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initial && "error" in initial ? initial.error : null);
  const [result, setResult] = useState<Result | null>(initial && "platform" in initial ? initial : null);
  const [leagueIx, setLeagueIx] = useState(0);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [yahooReady, setYahooReady] = useState<boolean | null>(null);

  useEffect(() => { apiLeagues.status().then((s) => setYahooReady(s.yahoo)).catch(() => setYahooReady(false)); }, []);

  const league = result?.leagues[leagueIx] ?? null;
  // Sleeper and Yahoo only return the person's own team; ESPN returns the
  // whole league, so there the team has to be picked.
  const team = league ? (league.teams.length === 1 ? league.teams[0] : league.teams.find((t) => t.team_id === teamId) ?? null) : null;

  const run = async () => {
    if (!text.trim()) return;
    setBusy(true); setError(null); setResult(null); setLeagueIx(0); setTeamId(null);
    try {
      const r = platform === "sleeper" ? await apiLeagues.sleeper(text) : await apiLeagues.espn(text);
      if (!r.leagues.length) setError(`No ${NAME[platform]} leagues with a team of yours this season.`);
      else setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="league-import">
      <div className="li-head">
        <b>Import from your league</b>
        {onClose && <button className="linkish small" onClick={onClose}>close</button>}
      </div>
      <Seg value={platform} options={[{ v: "sleeper", l: "Sleeper" }, { v: "espn", l: "ESPN" }, { v: "yahoo", l: "Yahoo" }]}
        onChange={(v) => { setPlatform(v); setError(null); setResult(null); setText(""); }} />

      {platform === "yahoo" ? (
        <div className="li-row">
          <button className="btn primary" disabled={!yahooReady} onClick={apiLeagues.yahooStart}>Sign in with Yahoo</button>
          <span className="hint">{yahooReady === false ? "Yahoo import is not set up on this site yet." : "You sign in on Yahoo's own page; this site never sees your password and keeps nothing."}</span>
        </div>
      ) : (
        <form className="li-row" onSubmit={(e) => { e.preventDefault(); run(); }}>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} aria-label={platform === "sleeper" ? "Sleeper username" : "ESPN league id or link"}
            placeholder={platform === "sleeper" ? "Sleeper username" : "League id, or paste the league's link"} />
          <button className="btn primary" type="submit" disabled={busy || !text.trim()}>{busy ? <Spinner /> : "Find my team"}</button>
        </form>
      )}
      {platform === "espn" && !result && <div className="hint">Public leagues only. If yours is private, its manager can turn on "Make league viewable to public" in ESPN under League → Settings → Basic Settings.</div>}
      {error && <div className="hint" style={{ color: "var(--under)" }}>{error}</div>}

      {result && league && (
        <div className="li-result">
          {result.leagues.length > 1 && (
            <label className="li-row"><span className="hint">League</span>
              <select className="input" value={leagueIx} onChange={(e) => { setLeagueIx(Number(e.target.value)); setTeamId(null); }}>
                {result.leagues.map((l, i) => <option key={l.league_id} value={i}>{l.name}</option>)}
              </select></label>
          )}
          {league.teams.length > 1 && (
            <label className="li-row"><span className="hint">Your team</span>
              <select className="input" value={teamId ?? ""} onChange={(e) => setTeamId(e.target.value || null)}>
                <option value="">Pick your team…</option>
                {league.teams.map((t) => <option key={t.team_id} value={t.team_id}>{t.name}{t.owner ? ` (${t.owner})` : ""}</option>)}
              </select></label>
          )}
          {team && <>
            <div className="small">
              <b>{team.name}</b> in {league.name}: {team.players.length} players, {team.starters.length} starting
              {league.scoring ? <> · {league.scoring.format === "ppr" ? "PPR" : league.scoring.format === "half" ? "half PPR" : "standard"} ({league.scoring.rec} a catch)</> : null}
            </div>
            {team.unmatched.length > 0 && (
              <div className="hint" style={{ color: "var(--push)" }}>
                Could not find {team.unmatched.length === 1 ? "one player" : `${team.unmatched.length} players`} here, so {team.unmatched.length === 1 ? "he stays" : "they stay"} out: {team.unmatched.join(", ")}. Add {team.unmatched.length === 1 ? "him" : "them"} by hand if needed.
              </div>
            )}
            <div className="li-row">
              <button className="btn primary" onClick={() => onApply(team, league)}>Use this team</button>
              <span className="hint">Replaces the roster, lineup slots and starters saved in this browser.</span>
            </div>
          </>}
        </div>
      )}
    </div>
  );
}
