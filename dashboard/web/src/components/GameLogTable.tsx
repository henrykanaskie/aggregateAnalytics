import { useMemo, useState } from "react";
import type { GameRow } from "../api";
import { fmtStat } from "../lib/format";
import { val } from "../lib/stats";
import { useMeta } from "../state";
import StatPicker from "./StatPicker";

interface Props { rows: GameRow[]; columns: string[]; setColumns: (c: string[]) => void; statKey: string; line: number | null; available?: Record<string, number>; position?: string | null; picked?: string | null; onPick?: (id: string) => void; important?: Set<string> | null; }

const CTX = ["game", "score", "spread", "total"];

export default function GameLogTable({ rows, columns, setColumns, statKey, line, available, position, picked, onPick, important }: Props) {
  const fc = (k: string) => (important ? (important.has(k) ? "focus-col" : "dim") : "");
  const { statByKey } = useMeta();
  const [sort, setSort] = useState<{ k: string; d: 1 | -1 } | null>(null);
  const [adding, setAdding] = useState(false);
  const [newCol, setNewCol] = useState(statKey);
  const cols = useMemo(() => [statKey, ...columns.filter((c) => c !== statKey)], [columns, statKey]);
  const sorted = useMemo(() => {
    const r = [...rows].reverse();
    if (!sort) return r;
    return r.sort((a, b) => {
      const av = sort.k === "date" ? a.season * 100 + a.week : val(a, sort.k) ?? -Infinity;
      const bv = sort.k === "date" ? b.season * 100 + b.week : val(b, sort.k) ?? -Infinity;
      return (av > bv ? 1 : av < bv ? -1 : 0) * sort.d;
    });
  }, [rows, sort]);
  const toggle = (k: string) => setSort((s) => (s?.k === k ? (s.d === -1 ? { k, d: 1 } : null) : { k, d: -1 }));
  const cls = (r: GameRow, k: string) => {
    if (k !== statKey || line === null) return "num";
    const v = val(r, k);
    return v === null ? "num" : v > line ? "num over" : v < line ? "num under" : "num push";
  };
  return (
    <div>
      <div className="panel-head">
        <h3>Game log · {rows.length} games</h3>
        <div className="actions">
          <div className="chips">
            {cols.map((c) => (
              <span key={c} className={`chip ${c === statKey ? "on" : ""} ${important && important.has(c) && c !== statKey ? "focus-chip" : ""} ${important && !important.has(c) ? "dim" : ""}`}>{statByKey.get(c)?.label ?? c}{c !== statKey && <button onClick={() => setColumns(columns.filter((x) => x !== c))} title="remove">×</button>}</span>
            ))}
          </div>
          {adding ? (
            <>
              <StatPicker value={newCol} onChange={setNewCol} available={available} position={position} />
              <button className="btn sm primary" onClick={() => { if (!columns.includes(newCol)) setColumns([...columns, newCol]); setAdding(false); }}>Add</button>
              <button className="btn sm ghost" onClick={() => setAdding(false)}>Cancel</button>
            </>
          ) : <button className="btn sm" onClick={() => setAdding(true)}>+ column</button>}
        </div>
      </div>
      <div className="tbl-wrap" style={{ maxHeight: 520 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th className="left" onClick={() => toggle("date")}>Game {sort?.k === "date" ? (sort.d === -1 ? "↓" : "↑") : ""}</th>
              <th className="left">Result</th>
              <th className={important ? "dim" : ""}>Spread</th>
              <th className={important ? "dim" : ""}>Total</th>
              {position !== "QB" && <th className={`left ${important ? "dim" : ""}`}>QB</th>}
              <th className={`left ${important ? "dim" : ""}`} title="roof · temperature · wind (outdoor games only)">Wx</th>
              {cols.map((c) => <th key={c} className={fc(c)} onClick={() => toggle(c)} title={statByKey.get(c)?.note || undefined}>{statByKey.get(c)?.label ?? c} {sort?.k === c ? (sort.d === -1 ? "↓" : "↑") : ""}</th>)}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.game_id} className={`${picked === r.game_id ? "hl" : ""} clickable`} onClick={() => onPick?.(r.game_id)}>
                <td className="left"><span className="muted">{r.season}</span> {r.season_type === "POST" ? "P" : "W"}{r.week} <span className="muted">{r.home ? "vs" : "@"}</span> {r.opponent}</td>
                <td className="left"><span className={r.result === "W" ? "over" : r.result === "L" ? "under" : ""}>{r.result ?? "–"}</span> <span className="muted num">{r.team_score ?? ""}{r.team_score !== null ? "-" : ""}{r.opp_score ?? ""}</span></td>
                <td className={`num muted ${important ? "dim" : ""}`}>{r.team_spread === null ? "–" : (r.team_spread > 0 ? "+" : "") + r.team_spread}</td>
                <td className={`num muted ${important ? "dim" : ""}`}>{r.total_line ?? "–"}</td>
                {position !== "QB" && <td className={`left small muted ${important ? "dim" : ""}`}>{r.qb_name ? r.qb_name.split(" ").slice(-1)[0] : "–"}</td>}
                <td className={`left small muted ${important ? "dim" : ""}`}>{r.indoors ? "dome" : r.temp !== null ? `${r.temp}° ${r.wind !== null ? `${r.wind}mph` : ""}` : "–"}</td>
                {cols.map((c) => <td key={c} className={`${cls(r, c)} ${fc(c)}`}>{fmtStat(val(r, c), statByKey.get(c)?.fmt)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
