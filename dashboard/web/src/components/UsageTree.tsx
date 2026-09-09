import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api3, UsageRow } from "../api";
import { fmtPct } from "../lib/format";
import { Seg } from "./common";

/** Who gets the touches on a team-season: shares of targets, carries and air yards. */
export default function UsageTree({ team, season }: { team: string; season: number }) {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [mode, setMode] = useState<"targets" | "carries">("targets");
  useEffect(() => { api3.usage(team, season).then((d) => setRows(d.rows)).catch(() => setRows([])); }, [team, season]);
  const shown = useMemo(() => {
    const key = mode === "targets" ? "targets" : "carries";
    return rows.filter((r) => r[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, 14);
  }, [rows, mode]);
  const max = (shown.length ? (mode === "targets" ? shown[0].target_share : shown[0].carry_share) : 1) || 1;
  if (!rows.length) return <div className="hint">No stat lines for {team} in {season}.</div>;
  return (
    <div>
      <div className="panel-head"><h3>Usage tree · {team} {season}</h3><Seg value={mode} options={[{ v: "targets", l: "Targets" }, { v: "carries", l: "Carries" }]} onChange={setMode} /></div>
      <table className="tbl">
        <thead><tr><th className="left">Player</th><th className="left">Pos</th><th>G</th><th style={{ width: 160 }}>Share</th><th>{mode === "targets" ? "Tgt/g" : "Car/g"}</th><th>Air yds share</th><th>Touches/g</th><th>PPR/g</th></tr></thead>
        <tbody>
          {shown.map((r) => { const share = (mode === "targets" ? r.target_share : r.carry_share) ?? 0; return (
            <tr key={r.player_id}>
              <td className="left"><Link to={`/research?player=${r.player_id}`}>{r.player_display_name}</Link></td><td className="left muted">{r.position}</td><td className="num muted">{r.games}</td>
              <td><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div className="bar" style={{ flex: 1, marginTop: 0 }}><div style={{ width: `${(share / max) * 100}%`, background: "var(--accent)" }} /></div><span className="num tiny" style={{ width: 34 }}>{fmtPct(share)}</span></div></td>
              <td className="num">{(mode === "targets" ? r.targets_pg : r.carries_pg).toFixed(1)}</td><td className="num muted">{mode === "targets" ? fmtPct(r.air_share) : "–"}</td><td className="num">{r.touches_pg.toFixed(1)}</td><td className="num">{r.ppr_pg.toFixed(1)}</td>
            </tr>
          ); })}
        </tbody>
      </table>
    </div>
  );
}
