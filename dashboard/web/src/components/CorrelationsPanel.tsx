import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api5, CorrRow } from "../api";

/** Same-game correlations for parlay building. */
export default function CorrelationsPanel({ playerId, statKey, statLabel }: { playerId: string; statKey: string; statLabel: string }) {
  const [rows, setRows] = useState<CorrRow[] | null>(null);
  useEffect(() => { setRows(null); api5.correlations(playerId, statKey).then((d) => setRows(d.rows)).catch(() => setRows([])); }, [playerId, statKey]);
  if (!rows) return <div className="hint">loading…</div>;
  if (!rows.length) return <div className="hint">Not enough shared games to correlate (needs 8+).</div>;
  return (
    <div>
      <div className="tbl-wrap"><table className="tbl compact">
        <thead><tr><th className="left">{statLabel} moves with…</th><th>r</th><th>n</th><th style={{ width: 120 }}></th></tr></thead>
        <tbody>{rows.slice(0, 14).map((c, i) => (
          <tr key={i}><td className="left">{c.player_id ? <Link to={`/research?player=${c.player_id}`}>{c.with}</Link> : c.with}</td>
            <td className={`num ${c.r > 0 ? "over" : "under"}`}>{c.r > 0 ? "+" : ""}{c.r.toFixed(2)}</td><td className="num muted">{c.n}</td>
            <td><div className="bar" style={{ marginTop: 0 }}><div style={{ width: `${Math.min(100, Math.abs(c.r) * 100)}%`, background: c.r > 0 ? "var(--over)" : "var(--under)" }} /></div></td></tr>
        ))}</tbody>
      </table></div>
      <div className="hint" style={{ marginTop: 6 }}>Pearson r over shared games since three seasons ago. Positive = the two tend to hit together (a same-game parlay leg that helps); negative = they trade off. Anything under about 0.3 is weak.</div>
    </div>
  );
}
