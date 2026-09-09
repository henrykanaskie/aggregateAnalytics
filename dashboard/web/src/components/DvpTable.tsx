import { useEffect, useState } from "react";
import { api3, DvpLeague } from "../api";
import { Seg, TeamTag } from "./common";

/** League table of what each defense allows to a position, per game. */
export default function DvpTable({ season, highlight, onPick }: { season: number; highlight?: string; onPick?: (team: string) => void }) {
  const [pos, setPos] = useState("RB");
  const [data, setData] = useState<DvpLeague | null>(null);
  const [sortKey, setSortKey] = useState<string | null>(null);
  useEffect(() => { api3.dvp("ALL", pos, season).then(setData).catch(() => setData(null)); }, [pos, season]);
  if (!data) return null;
  const key = sortKey ?? data.stats[0];
  const rows = [...data.league].sort((a, b) => ((b[key] as number) ?? 0) - ((a[key] as number) ?? 0));
  return (
    <div>
      <div className="panel-head"><h3>Defense vs position · {season}</h3><Seg value={pos} options={["QB", "RB", "WR", "TE"].map((p) => ({ v: p, l: p }))} onChange={setPos} /></div>
      <div className="hint" style={{ marginBottom: 6 }}>Per-game totals allowed to {pos}s, regular season. Rank 1 = most allowed (the friendliest matchup). Click a column to sort.</div>
      <div className="tbl-wrap" style={{ maxHeight: 520 }}>
        <table className="tbl">
          <thead><tr><th className="left">Defense</th><th>G</th>{data.stats.map((k) => <th key={k} className={k === key ? "over" : ""} onClick={() => setSortKey(k)}>{data.labels[k]}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.defense} className={`clickable ${r.defense === highlight ? "hl" : ""}`} onClick={() => onPick?.(r.defense)}>
                <td className="left"><TeamTag abbr={r.defense} /></td><td className="num muted">{r.games}</td>
                {data.stats.map((k) => { const rank = r[`${k}_rank`] as number; const pct = 1 - (rank - 1) / (r.n_teams - 1); return <td key={k} className={`num ${pct >= 0.75 ? "over" : pct <= 0.25 ? "under" : ""}`} title={`rank ${rank}`}>{(r[k] as number).toFixed(1)} <span className="faint tiny">{rank}</span></td>; })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
