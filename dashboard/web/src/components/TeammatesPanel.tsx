import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api5, GameRow, StatDef, TeammatePresence } from "../api";
import { fmtPct, fmtStat } from "../lib/format";
import { summarize } from "../lib/stats";

/** With / without each key teammate, for the current stat and line. */
export default function TeammatesPanel({ playerId, rows, statKey, stat, line, onFilter, active }: { playerId: string; rows: GameRow[]; statKey: string; stat?: StatDef; line: number | null; onFilter: (ids: string[] | null, label: string | null, key?: string | null) => void; active: string | null }) {
  const [data, setData] = useState<TeammatePresence | null>(null);
  useEffect(() => { setData(null); api5.teammates(playerId).then(setData).catch(() => setData({ teammates: [], presence: {} })); }, [playerId]);
  const table = useMemo(() => {
    if (!data) return [];
    return data.teammates.map((t) => {
      const withSet = new Set(data.presence[t.player_id] ?? []);
      const elig = new Set(t.eligible);
      const withRows = rows.filter((r) => withSet.has(r.game_id));
      const withoutRows = rows.filter((r) => elig.has(r.game_id) && !withSet.has(r.game_id));
      return { t, w: summarize(withRows, statKey, line), wo: summarize(withoutRows, statKey, line), withIds: [...withSet], withoutIds: withoutRows.map((r) => r.game_id) };
    });
  }, [data, rows, statKey, line]);
  if (!data) return <div className="hint">loading…</div>;
  if (!data.teammates.length) return <div className="hint">No snap-count data for this player's recent teams (snap counts start in 2013).</div>;
  return (
    <div>
      <div className="tbl-wrap">
        <table className="tbl compact">
          <thead><tr><th className="left">Teammate</th><th>With</th><th>Avg</th><th>Over</th><th>Without</th><th>Avg</th><th>Over</th><th>Δ avg</th></tr></thead>
          <tbody>
            {table.map(({ t, w, wo, withIds, withoutIds }) => {
              const d = w.avg !== null && wo.avg !== null ? wo.avg - w.avg : null;
              const sel = active === `without:${t.player_id}` ? "without" : active === `with:${t.player_id}` ? "with" : null;
              return (
                <tr key={t.player_id}>
                  <td className="left"><Link to={`/research?player=${t.player_id}`}>{t.name}</Link> <span className="muted">{t.position}</span></td>
                  <td className={`num clickable ${sel === "with" ? "focus-col" : ""}`} onClick={() => onFilter(sel === "with" ? null : withIds, sel === "with" ? null : `with ${t.name}`, sel === "with" ? null : `with:${t.player_id}`)} title="filter to these games">{w.n}</td>
                  <td className="num">{fmtStat(w.avg, stat?.fmt)}</td><td className={`num ${w.rate === null ? "muted" : w.rate >= 0.6 ? "over" : w.rate <= 0.4 ? "under" : ""}`}>{fmtPct(w.rate)}</td>
                  <td className={`num clickable ${sel === "without" ? "focus-col" : ""}`} onClick={() => onFilter(sel === "without" ? null : withoutIds, sel === "without" ? null : `without ${t.name}`, sel === "without" ? null : `without:${t.player_id}`)} title="filter to these games">{wo.n}</td>
                  <td className="num">{wo.n ? fmtStat(wo.avg, stat?.fmt) : <span className="faint">–</span>}</td><td className={`num ${wo.rate === null ? "muted" : wo.rate >= 0.6 ? "over" : wo.rate <= 0.4 ? "under" : ""}`}>{wo.n ? fmtPct(wo.rate) : ""}</td>
                  <td className={`num ${d === null ? "muted" : d > 0 ? "over" : d < 0 ? "under" : ""}`}>{d === null ? "–" : (d > 0 ? "+" : "") + fmtStat(d, stat?.fmt === "int" ? "dec1" : stat?.fmt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>"Without" counts only games in seasons the teammate was on the roster, so a 2023 game is not scored as without a 2025 arrival. Click a count to filter the whole page to those games. Since {data.since}.</div>
    </div>
  );
}
