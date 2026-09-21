import { Link } from "react-router-dom";
import { Angle, AngleTrackRecord, GradedAngle } from "../api";
import { fmtLine, fmtPct } from "../lib/format";
import { TeamTag } from "./common";

// Rates such as sack rate live under 10%, where whole percents make 7.1% and
// 7.0% read as the same number and a correct call look like a tie.
export const fmtMeasure = (v: number | null, fmt: string) =>
  v === null ? "–" : fmt === "pct" ? `${(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%` : fmt === "dec2" ? (Number(v.toFixed(2)) > 0 ? "+" : "") + v.toFixed(2).replace(/^-0\.00$/, "0.00") : fmt === "int" ? v.toFixed(0) : v.toFixed(1);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The angle with its names taken out, matching angle_grades.family() on the
 *  server, so an upcoming game's angle finds its kind in the track record. */
export const trackKey = (a: Angle, offense: string, defense: string) => `${familyOf(a, offense, defense)}|${a.lean}`;
export function familyOf(a: Angle, offense: string, defense: string): string {
  let t = a.title;
  if (a.player) t = t.split(a.player).join("{player}");
  t = t.replace(new RegExp(`\\b${esc(defense)}\\b`, "g"), "{def}");
  return t.replace(new RegExp(`\\b${esc(offense)}\\b`, "g"), "{off}");
}

export type TrackIndex = Map<string, { n: number; hits: number }>;
export const trackIndex = (t: AngleTrackRecord | null | undefined): TrackIndex =>
  new Map((t?.families ?? []).map((f) => [`${f.family}|${f.lean}`, { n: f.n, hits: f.hits }]));

/** "7-3 last 8 wks": how this kind of angle has done lately. */
export function TrackChip({ rec, weeks }: { rec?: { n: number; hits: number }; weeks: number }) {
  // No record: either a context note that is never graded, or a kind of
  // angle that has not come up in a graded game yet. Neither has a number.
  if (!rec) return null;
  const r = rec.hits / rec.n;
  const cls = rec.n >= 5 ? (r >= 0.6 ? "over" : r <= 0.4 ? "under" : "") : "";
  return <span className={`pill ${cls}`} style={{ whiteSpace: "nowrap", flexShrink: 0, textTransform: "none", letterSpacing: 0 }} title={`This kind of angle was right ${rec.hits} of ${rec.n} times in the last ${weeks} graded weeks: the number it was about moved the way it said`}>{rec.hits}-{rec.n - rec.hits} · {weeks} wks</span>;
}

const ORDER = { hit: 0, miss: 1, push: 2 } as const;
const Mark = ({ v }: { v: GradedAngle["verdict"] }) =>
  <span className={`pill ${v === "hit" ? "over" : v === "miss" ? "under" : ""}`} style={{ minWidth: 58, textAlign: "center" }}>{v === "hit" ? "✓ called it" : v === "miss" ? "✗ missed" : "≈ push"}</span>;

export function Outcome({ a }: { a: GradedAngle }) {
  const arrow = a.direction === "up" ? "above" : "below";
  return (
    <span className="small">
      {a.team && a.kind === "team" ? <b>{a.team} </b> : null}{a.measure}: <b className={`num ${a.verdict === "hit" ? "over" : a.verdict === "miss" ? "under" : ""}`}>{fmtMeasure(a.actual, a.fmt)}</b>
      {a.baseline_label === "at least one"
        ? <span className="muted"> (said at least one)</span>
        : <span className="muted"> vs {fmtMeasure(a.baseline, a.fmt)} {a.baseline_label} (said {arrow})</span>}
      {a.line !== null && <span className="muted"> · line {fmtLine(a.line)}, went <b className={a.line_result === (a.lean === "over" ? "over" : "under") ? "over" : a.line_result === "push" ? "" : "under"}>{a.line_result}</b></span>}
    </span>
  );
}

/** A played game's angles, as they read before kickoff, next to what
 *  happened. */
export function AngleReview({ rows, home, away, score }: { rows: GradedAngle[]; home: string; away: string; score: string }) {
  const dec = rows.filter((r) => r.verdict !== "push");
  const hits = dec.filter((r) => r.verdict === "hit").length;
  const pushes = rows.length - dec.length;
  const sides = [away, home].map((off) => ({ off, rows: rows.filter((r) => r.offense === off) }));
  return (
    <div className="panel" data-tour="matchup-review">
      <div className="panel-head">
        <h3>How the calls did · final {score}</h3>
        <span className="hint"><b className={hits / Math.max(1, dec.length) >= 0.5 ? "over" : "under"}>{hits} of {dec.length}</b> right ({fmtPct(hits / Math.max(1, dec.length))}){pushes ? ` · ${pushes} push${pushes > 1 ? "es" : ""}` : ""}</span>
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>Every angle below is rebuilt from what was known before kickoff (team numbers through the week before, player splits up to this game), then checked on the number it was about. A team angle is right when that team's number in this game landed on the side of its usual that the angle said; a player angle when his game landed on that side of his previous 16. A move of less than 5% of the usual number (at least half a point for rates, 0.02 for EPA) is a push and does not count either way. Where a prop line was posted it is shown too.</div>
      <div className="grid grid-2">
        {sides.map(({ off, rows: rs }) => (
          <div key={off}>
            <div className="small" style={{ marginBottom: 6 }}><TeamTag abbr={off} /> <b>offense</b> <span className="muted">· {rs.filter((r) => r.verdict === "hit").length} of {rs.filter((r) => r.verdict !== "push").length} right</span></div>
            {rs.length === 0 && <div className="hint">No gradeable angles on this side.</div>}
            <div className="grid" style={{ gap: 6 }}>
              {[...rs].sort((a, b) => (a.verdict === b.verdict ? b.strength - a.strength : ORDER[a.verdict] - ORDER[b.verdict])).map((a, i) => (
                <div key={i} className="tile" style={{ borderLeft: `3px solid var(--${a.verdict === "hit" ? "over" : a.verdict === "miss" ? "under" : "border-2"})`, padding: "8px 10px" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <Mark v={a.verdict} />
                    <span style={{ fontWeight: 600 }}>{a.player_id ? <Link to={`/research?player=${a.player_id}`}>{a.title}</Link> : a.title}</span>
                    {a.strength >= 2 && <span className="faint tiny">strong</span>}
                  </div>
                  <div style={{ marginTop: 3 }}><Outcome a={a} /></div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
