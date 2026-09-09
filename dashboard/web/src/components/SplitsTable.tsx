import type { GameRow, StatDef } from "../api";
import { fmtPct, fmtStat } from "../lib/format";
import { splits, summarize } from "../lib/stats";

export default function SplitsTable({ rows, statKey, stat, line, position }: { rows: GameRow[]; statKey: string; stat?: StatDef; line: number | null; position?: string | null }) {
  const all = summarize(rows, statKey, line);
  return (
    <div className="tbl-wrap">
      <table className="tbl compact">
        <thead><tr><th className="left">Split</th><th>G</th><th>Avg</th><th>Med</th><th>vs all</th><th>Over %</th><th>O-U-P</th></tr></thead>
        <tbody>
          {splits(rows, position).map((sp) => {
            const s = summarize(sp.rows, statKey, line);
            const d = s.avg !== null && all.avg !== null ? s.avg - all.avg : null;
            return (
              <tr key={sp.label} className="split-row">
                <td className="left">{sp.label}</td>
                <td className="num muted">{s.n}</td>
                <td className="num">{fmtStat(s.avg, stat?.fmt)}</td>
                <td className="num muted">{fmtStat(s.median, stat?.fmt)}</td>
                <td className={`num ${d === null || Math.abs(d) < 1e-9 ? "muted" : d > 0 ? "over" : "under"}`}>{d === null ? "–" : (d > 0 ? "+" : "") + fmtStat(d, stat?.fmt === "int" ? "dec1" : stat?.fmt)}</td>
                <td className={`num ${s.rate === null ? "muted" : s.rate >= 0.6 ? "over" : s.rate <= 0.4 ? "under" : ""}`}>{fmtPct(s.rate)}</td>
                <td className="num muted">{line === null ? "–" : `${s.over}-${s.under}-${s.push}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
