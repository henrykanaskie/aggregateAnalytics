import { useEffect, useState } from "react";
import { api3, InjuryRow } from "../api";
import { useMeta } from "../state";
import { fmtDate } from "../lib/format";

const short = (s: string | null) => !s ? "–" : s.startsWith("Full") ? "Full" : s.startsWith("Limited") ? "Limited" : s.startsWith("Did Not") ? "DNP" : s.startsWith("Out") ? "Out" : s;
const statusClass = (s: string | null) => s === "Out" || s === "Doubtful" ? "under" : s === "Questionable" || s === "DNP" || s === "Limited" ? "push" : "";
// The listing's status: the game designation once there is one, else how
// much of practice he took part in, which is all the report holds mid-week.
const listed = (r: InjuryRow) => (r.report_status && r.report_status !== "Note" ? r.report_status : r.practice_status ? short(r.practice_status) : null);

/** The player's own injury history plus both teams' current report. */
export default function InjuryPanel({ playerId, team, opponent }: { playerId: string; team: string | null; opponent: string | null }) {
  const { meta } = useMeta();
  const [mine, setMine] = useState<InjuryRow[]>([]);
  const [reports, setReports] = useState<{ team: string; week: number; latest: number | null; asOf: string | null; rows: InjuryRow[] }[]>([]);
  useEffect(() => {
    let alive = true;
    setMine([]);
    api3.playerInjuries(playerId).then((d) => alive && setMine(d.rows)).catch(() => alive && setMine([]));
    return () => { alive = false; };
  }, [playerId]);
  useEffect(() => {
    if (!meta) return;
    let alive = true;
    Promise.all([team, opponent].filter((t): t is string => !!t).map((t) => api3.teamInjuries(t).then((d) => ({ team: t, week: d.week, latest: d.latest_week_available, asOf: d.as_of ?? null, rows: d.rows }))))
      .then((r) => alive && setReports(r)).catch(() => alive && setReports([]));
    return () => { alive = false; };
  }, [meta, team, opponent]);
  const flagged = mine.filter((r) => r.report_status && r.report_status !== "Note");
  return (
    <div>
      <div className="small" style={{ marginBottom: 6 }}><b>Player</b> · {flagged.length} game-status listings on record{mine.length ? `, latest ${mine[0].season} wk ${mine[0].week}: ${mine[0].report_status ?? "no status"} (${short(mine[0].practice_status)})` : ""}</div>
      {flagged.length > 0 && (
        <details><summary className="hint clickable">history</summary>
          <div className="tbl-wrap" style={{ maxHeight: 200 }}><table className="tbl compact"><thead><tr><th className="left">Season</th><th>Wk</th><th className="left">Injury</th><th className="left">Status</th><th className="left">Practice</th></tr></thead>
            <tbody>{flagged.map((r, i) => <tr key={i}><td className="left">{r.season}</td><td className="num">{r.week}</td><td className="left">{r.report_primary_injury ?? r.practice_primary_injury ?? "–"}</td><td className={`left ${statusClass(r.report_status)}`}>{r.report_status}</td><td className="left muted">{short(r.practice_status)}</td></tr>)}</tbody></table></div>
        </details>
      )}
      {reports.map((rep) => {
        const rows = rep.rows.filter((r) => listed(r));
        return (
          <div key={rep.team} style={{ marginTop: 8 }}>
            <div className="small"><b>{rep.team}</b> report, week {rep.week}{rep.rows.length === 0 ? <span className="hint"> · nothing filed yet{rep.asOf ? ` (feed as of ${fmtDate(rep.asOf)})` : ""}</span> : null}</div>
            {rows.length > 0 && <div className="chips" style={{ marginTop: 4 }}>{rows.map((r, i) => <span key={i} className={`chip`} title={`${r.report_primary_injury ?? ""} · ${r.practice_status ?? ""}`}><span className={statusClass(listed(r))}>{listed(r)}</span> {r.full_name} <span className="muted">{r.position}</span></span>)}</div>}
          </div>
        );
      })}
      <div className="hint" style={{ marginTop: 6 }}>Reports refresh with every lines pull, a few times a day{reports[0]?.asOf ? `; this feed is from ${fmtDate(reports[0].asOf)}` : ""}.</div>
    </div>
  );
}
