import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api3, Dvp, Matchup, TeamMetric } from "../api";
import { fmtStat } from "../lib/format";
import { PCT_LEGEND, rankTint } from "../lib/rank";
import { TeamTag } from "./common";
import { teamFocus } from "../lib/focus";

const OFF = ["pass_rate", "proe", "neutral_pass_rate", "plays_pg", "sec_per_play", "shotgun_rate", "p11_rate", "pa_rate", "rb_target_share", "te_target_share", "lead_rb_share", "rz_td_rate", "rz_pass_rate", "epa_play"];
const DEF = ["def_epa_play", "def_pass_epa", "def_rush_epa", "def_success_rate", "def_explosive_rate", "def_pass_rate_faced", "def_rb_target_share", "def_te_target_share", "def_pressure_rate", "def_blitz_rate", "def_man_rate", "def_box_avg", "def_rz_td_rate"];

/** The player's offense and the opponent's defense, side by side with ranks,
 *  plus what the opponent allows to the player's position. */
export default function MatchupPanel({ team, opponent, position, focus = false }: { team: string | null; opponent: string | null; position?: string | null; focus?: boolean }) {
  const tf = focus ? teamFocus(position ?? null) : null;
  const [data, setData] = useState<(Matchup & { dvp?: Dvp }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!team || !opponent) return;
    let alive = true;
    setData(null); setErr(null);
    api3.matchup(team, opponent, position).then((d) => alive && setData(d)).catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [team, opponent, position]);
  if (!team || !opponent) return <div className="hint">No game scheduled this week.</div>;
  if (err) return <div className="hint">{err.includes("503") ? "Team tendency table not built yet (python -m dashboard.stats.team)." : err}</div>;
  if (!data) return null;
  const mdefs = new Map(data.metrics.map((m) => [m.key, m]));
  const Block = ({ side, keys, title, hot }: { side: Matchup["team"]; keys: string[]; title: string; hot?: string[] }) => (
    <div style={{ marginBottom: 10 }}>
      <div className="small" style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span><Link to={`/teams?team=${side.team}`}><TeamTag abbr={side.team} /></Link> <b>{title}</b></span>
        <span className="hint">{side.coach ? <Link to={`/coaches?coach=${encodeURIComponent(side.coach)}`}>{side.coach}</Link> : null} · {data.season_used}</span>
      </div>
      <div className="tbl-wrap"><table className="tbl compact">
        <thead><tr><th className="left">Metric</th><th>{data.season_used}</th><th>Rank</th><th>Last 4</th></tr></thead>
        <tbody>
          {keys.map((k) => {
            const m = mdefs.get(k) as TeamMetric | undefined; if (!m || !side.season) return null;
            const v = side.season[k] as number | null; const r = side.season[`${k}_rank`] as number | null; const l4 = side.last4?.[k] ?? null;
            if (v === null || v === undefined) return null;
            const cls = hot ? (hot.includes(k) ? "focus-row" : "dim") : "";
            return <tr key={k} className={cls}><td className="left" title={m.note || undefined}>{m.label}</td><td className="num">{fmtStat(v, m.fmt as any)}</td><td className="num" style={{ background: rankTint(r, side.season.n_teams) }}>{r ?? "–"}</td><td className="num muted">{fmtStat(l4, m.fmt as any)}</td></tr>;
          })}
        </tbody>
      </table></div>
    </div>
  );
  const d = data.dvp;
  return (
    <div>
      {d && d.season_row && (
        <div style={{ marginBottom: 10 }}>
          <div className="small" style={{ marginBottom: 4 }}><TeamTag abbr={opponent} /> <b>vs {d.position}s</b> <span className="hint">per game allowed, {d.season} · rank 1 = most allowed</span></div>
          <div className="tbl-wrap"><table className="tbl compact">
            <thead><tr><th className="left">Stat</th><th>Per game</th><th>Rank</th><th>Last 4</th></tr></thead>
            <tbody>
              {d.stats.map((k) => { const v = d.season_row![k] as number; const r = d.season_row![`${k}_rank`] as number; const n = d.season_row!.n_teams;
                return <tr key={k}><td className="left">{d.labels[k]}</td><td className="num">{v.toFixed(1)}</td><td className="num" style={{ background: rankTint(r, n) }}>{r}</td><td className="num muted">{d.last4 ? d.last4[k].toFixed(1) : "–"}</td></tr>; })}
            </tbody>
          </table></div>
          {d.log.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary className="hint clickable">what {d.position}s did against them in {d.season} ({d.log.length} lines)</summary>
              <div className="tbl-wrap" style={{ maxHeight: 220 }}><table className="tbl compact"><thead><tr><th className="left">Wk</th><th className="left">Player</th>{d.stats.map((k) => <th key={k}>{d.labels[k]}</th>)}</tr></thead>
                <tbody>{d.log.map((r, i) => <tr key={i}><td className="left muted">{r.week}</td><td className="left"><Link to={`/research?player=${r.player_id}`}>{r.player_display_name}</Link> <span className="muted">{r.team}</span></td>{d.stats.map((k) => <td key={k} className="num">{typeof r[k] === "number" ? (Number.isInteger(r[k]) ? r[k] : r[k].toFixed(1)) : "–"}</td>)}</tr>)}</tbody></table></div>
            </details>
          )}
        </div>
      )}
      <Block side={data.team} keys={tf ? [...new Set([...tf.off, ...OFF])] : OFF} title="offense" hot={tf?.off} />
      <Block side={data.opponent} keys={tf ? [...new Set([...tf.def, ...DEF])] : DEF} title="defense" hot={tf?.def} />
      <div className="hint">Ranks are among 32 teams in the season shown, 1 = highest value; shading is the percentile, {PCT_LEGEND}.</div>
    </div>
  );
}
