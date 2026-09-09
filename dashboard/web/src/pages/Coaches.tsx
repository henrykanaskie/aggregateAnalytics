import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Link as RLink } from "react-router-dom";
import { api2, api3, CoachProfile, CoachSummary, CoachUsageRow } from "../api";
import { fmtPct } from "../lib/format";
import { Banner, Field, Seg, Spinner, TeamTag } from "../components/common";
import { fmtStat } from "../lib/format";
import { useMeta } from "../state";
import { rankClass } from "./Teams";

export default function Coaches() {
  const { meta } = useMeta();
  const [sp, setSp] = useSearchParams();
  const name = sp.get("coach") ?? "";
  const [list, setList] = useState<CoachSummary[]>([]);
  const [prof, setProf] = useState<CoachProfile | null>(null);
  const [usage, setUsage] = useState<CoachUsageRow[]>([]);
  const [side, setSide] = useState<"off" | "def">("off");
  const [q, setQ] = useState("");
  const [onlyActive, setOnlyActive] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api2.coaches().then(setList).catch((e) => setErr(String(e))); }, []);
  useEffect(() => { if (name) { setProf(null); setUsage([]); api2.coach(name).then(setProf).catch((e) => setErr(String(e))); api3.coachUsage(name).then((d) => setUsage(d.rows)).catch(() => setUsage([])); } }, [name]);
  const metrics = (prof?.metrics ?? meta?.team_metrics ?? []).filter((m) => m.side === side);
  const fp = useMemo(() => (prof?.fingerprint ?? []).filter((f) => f.side === side && f.seasons >= 2), [prof, side]);
  const shown = useMemo(() => list.filter((c) => (!onlyActive || c.current_team) && (!q || c.coach.toLowerCase().includes(q.toLowerCase()))), [list, onlyActive, q]);
  if (meta && !meta.team_table_ready) return <Banner kind="warn">The team tendency table is not built yet. Run <code>python -m dashboard.stats.team</code> and reload.</Banner>;
  return (
    <div>
      <div className="page-head"><div><h1>Coaches</h1><div className="muted small">A head coach's tendencies over every game he coached, with the league rank each season. "Feeds his running backs" becomes a number: RB target share, and how many seasons it ranked in the top third.</div></div></div>
      {err && <Banner kind="err">{err}</Banner>}
      <div className="grid grid-main" style={{ gridTemplateColumns: "340px minmax(0,1fr)" }}>
        <div className="panel" style={{ alignSelf: "start" }}>
          <div className="controls" style={{ marginBottom: 8 }}>
            <input className="input" placeholder="filter coaches…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
            <button className={`chip ${onlyActive ? "on" : ""}`} onClick={() => setOnlyActive(!onlyActive)}>2026 HCs</button>
          </div>
          <div className="tbl-wrap" style={{ maxHeight: "70vh" }}>
            <table className="tbl compact">
              <thead><tr><th className="left">Coach</th><th className="left">Now</th><th>Yrs</th><th>W-L</th></tr></thead>
              <tbody>{shown.map((c) => <tr key={c.coach} className={`clickable ${c.coach === name ? "hl" : ""}`} onClick={() => setSp({ coach: c.coach })}><td className="left">{c.coach}</td><td className="left">{c.current_team ? <TeamTag abbr={c.current_team} /> : <span className="faint small">{c.first_season}–{c.last_season}</span>}</td><td className="num muted">{c.seasons}</td><td className="num muted">{c.wins}-{c.losses}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
        <div className="grid" style={{ alignContent: "start" }}>
          {!name && <div className="empty">Pick a coach.</div>}
          {name && !prof && !err && <div className="empty"><Spinner /></div>}
          {prof && (
            <>
              <div className="panel">
                <div className="panel-head">
                  <div><h2>{prof.coach}</h2><div className="muted small">{prof.current_team ? <>2026: <Link to={`/teams?team=${prof.current_team}`}><TeamTag abbr={prof.current_team} name /></Link> · </> : null}{prof.seasons.length} seasons · {prof.seasons.reduce((a, s) => a + s.win, 0)}-{prof.seasons.reduce((a, s) => a + s.loss, 0)} · teams {[...new Set(prof.seasons.map((s) => s.team))].join(", ")}</div></div>
                  <Field label="Side"><Seg value={side} options={[{ v: "off", l: "Offense" }, { v: "def", l: "Defense" }]} onChange={setSide} /></Field>
                </div>
                <h3 style={{ marginBottom: 6 }}>Tendency fingerprint</h3>
                <div className="hint" style={{ marginBottom: 8 }}>Average league percentile of each tendency across the coach's seasons (regular season). Far from the middle = a consistent identity. "Top ⅓" counts the seasons ranked in the top third of the league.</div>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead><tr><th className="left">Tendency</th><th>Career</th><th style={{ width: 180 }}>Percentile</th><th>Seasons</th><th>Top ⅓</th><th>Bottom ⅓</th></tr></thead>
                    <tbody>{fp.map((f) => (
                      <tr key={f.key}><td className="left">{f.label}</td><td className="num">{fmtStat(f.career, f.fmt as any)}</td>
                        <td><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div className="bar" style={{ flex: 1, marginTop: 0 }}><div style={{ width: `${f.mean_pct * 100}%`, background: f.good === "none" ? "var(--accent)" : (f.good === "high" ? f.mean_pct : 1 - f.mean_pct) >= 0.5 ? "var(--over)" : "var(--under)" }} /></div><span className="num tiny" style={{ width: 30 }}>{Math.round(f.mean_pct * 100)}</span></div></td>
                        <td className="num muted">{f.seasons}</td><td className={`num ${f.top_third >= f.seasons / 2 ? "over" : ""}`}>{f.top_third}</td><td className={`num ${f.bottom_third >= f.seasons / 2 ? "under" : ""}`}>{f.bottom_third}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </div>
              {usage.length > 0 && (
                <div className="panel">
                  <div className="panel-head"><h3>Who got the ball · lead RB, WR and TE each season</h3><span className="hint">shares are of the team's regular-season targets / carries</span></div>
                  <div className="tbl-wrap"><table className="tbl compact tight">
                    <thead><tr><th className="left">Season</th><th className="left">Team</th><th className="left">RB1</th><th>Carry share</th><th>RB2 share</th><th>RB1 tgt/g</th><th>RB tgt share</th><th className="left">WR1</th><th>Tgt share</th><th className="left">TE1</th><th>Tgt share</th></tr></thead>
                    <tbody>{usage.slice().reverse().map((u) => (
                      <tr key={`${u.season}-${u.team}`}><td className="left">{u.season}</td><td className="left"><TeamTag abbr={u.team} /></td>
                        <td className="left">{u.rb1 ? <RLink to={`/research?player=${u.rb1.player_id}`}>{u.rb1.name}</RLink> : "–"}</td><td className="num">{u.rb1 ? fmtPct(u.rb1.carry_share) : "–"}</td><td className="num muted">{u.rb2_carry_share !== undefined ? fmtPct(u.rb2_carry_share) : "–"}</td><td className="num">{u.rb1 ? u.rb1.targets_pg.toFixed(1) : "–"}</td><td className="num">{fmtPct(u.rb_target_share)}</td>
                        <td className="left">{u.wr1 ? <RLink to={`/research?player=${u.wr1.player_id}`}>{u.wr1.name}</RLink> : "–"}</td><td className="num">{u.wr1 ? fmtPct(u.wr1.target_share) : "–"}</td>
                        <td className="left">{u.te1 ? <RLink to={`/research?player=${u.te1.player_id}`}>{u.te1.name}</RLink> : "–"}</td><td className="num">{u.te1 ? fmtPct(u.te1.target_share) : "–"}</td></tr>
                    ))}</tbody>
                  </table></div>
                </div>
              )}
              <div className="panel">
                <div className="panel-head"><h3>Season by season · {side === "off" ? "offense" : "defense"}</h3><span className="hint">rank shown small; green/red = top/bottom quarter where direction matters · <span className="scroll-hint">scroll sideways for all {metrics.length} metrics</span></span></div>
                <div className="tbl-wrap">
                  <table className="tbl wide">
                    <thead><tr><th className="left">Season</th><th className="left">Team</th><th>W-L</th><th>PPG</th>{metrics.map((m) => <th key={m.key} title={m.note || undefined}>{m.label}</th>)}</tr></thead>
                    <tbody>{prof.seasons.slice().reverse().map((s) => (
                      <tr key={`${s.season}-${s.team}`}><td className="left">{s.season}</td><td className="left"><TeamTag abbr={s.team} /></td><td className="num muted">{s.win}-{s.loss}</td><td className="num muted">{fmtStat(s.ppg, "dec1")}</td>
                        {metrics.map((m) => { const v = s[m.key] as number | null; const r = s[`${m.key}_rank`] as number | null; return <td key={m.key} className={`num ${rankClass(r, s.n_teams, m.good)}`} title={r ? `rank ${r} of ${s.n_teams}` : ""}>{v === null || v === undefined ? "–" : <>{fmtStat(v, m.fmt as any)} <span className="faint tiny">{r}</span></>}</td>; })}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
