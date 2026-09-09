import { useState } from "react";
import { api3, DvpLeague } from "../api";
import { Seg, TeamTag } from "./common";
import { PCT_LEGEND, rankTint, shownRank } from "../lib/rank";
import { useSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";

/** League table of what each defense allows to a position, per game. */
export default function DvpTable({ season, highlight, onPick }: { season: number; highlight?: string; onPick?: (team: string) => void }) {
  const [pos, setPos] = useSticky("dvp.pos", "RB");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const { data } = useQuery<DvpLeague>(api3.dvp.url("ALL", pos, season));
  if (!data) return null;
  const key = sortKey ?? data.stats[0];
  const rows = [...data.league].sort((a, b) => ((b[key] as number) ?? 0) - ((a[key] as number) ?? 0));
  return (
    <div>
      <div className="panel-head"><h3>Defense vs position · {season}</h3><Seg value={pos} options={["QB", "RB", "WR", "TE"].map((p) => ({ v: p, l: p }))} onChange={setPos} /></div>
      <div className="hint" style={{ marginBottom: 6 }}>Per-game totals allowed to {pos}s, regular season. Rank 1 = fewest allowed, the stingiest defense; 32 = the friendliest matchup. Shading is generosity, {PCT_LEGEND}. Click a column to sort.</div>
      <div className="tbl-wrap" style={{ maxHeight: 520 }}>
        <table className="tbl">
          <thead><tr><th className="left">Defense</th><th>G</th>{data.stats.map((k) => <th key={k} className={k === key ? "over" : ""} onClick={() => setSortKey(k)}>{data.labels[k]}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.defense} className={`clickable ${r.defense === highlight ? "hl" : ""}`} onClick={() => onPick?.(r.defense)}>
                <td className="left"><TeamTag abbr={r.defense} /></td><td className="num muted">{r.games}</td>
                {data.stats.map((k) => { const rank = r[`${k}_rank`] as number; return <td key={k} className="num" style={{ background: rankTint(rank, r.n_teams) }} title={`rank ${shownRank(rank, r.n_teams, "low")} of ${r.n_teams}, 1 = fewest allowed`}>{(r[k] as number).toFixed(1)} <span className="faint tiny">{shownRank(rank, r.n_teams, "low")}</span></td>; })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
