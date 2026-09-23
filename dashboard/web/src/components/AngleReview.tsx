import { Link } from "react-router-dom";
import { Angle, AngleTrackRecord, GradedAngle } from "../api";
import { fmtLine, fmtPct } from "../lib/format";
import { TeamTag } from "./common";

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

/** A family read as a sentence: "{player} vs stacked boxes" as "Player vs
 *  stacked boxes", "{def} has clamped RBs" as "The defense has clamped RBs". */
export function prettyFamily(f: string): string {
  const t = f.replace(/\{player\}/g, "Player").replace(/\{def\}/g, "the defense").replace(/\{off\}/g, "the offense");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export type TrackIndex = Map<string, { n: number; hits: number }>;
export const trackIndex = (t: AngleTrackRecord | null | undefined): TrackIndex =>
  new Map((t?.families ?? []).map((f) => [`${f.family}|${f.lean}`, { n: f.n, hits: f.hits }]));

/** "7-3 in 2026": how this kind of angle has done this season. */
export function TrackChip({ rec, season }: { rec?: { n: number; hits: number }; season: number | null }) {
  // No record: either a context note that is never graded, or a kind of
  // angle that has not come up in a graded game yet. Neither has a number.
  if (!rec) return null;
  const r = rec.hits / rec.n;
  const cls = rec.n >= 5 ? (r >= 0.6 ? "over" : r <= 0.4 ? "under" : "") : "";
  return <span className={`pill ${cls}`} style={{ whiteSpace: "nowrap", flexShrink: 0, textTransform: "none", letterSpacing: 0 }} title={`This kind of angle was right ${rec.hits} of ${rec.n} times in ${season}: the number it was about moved the way it said`}>{rec.hits}-{rec.n - rec.hits} in {season}</span>;
}

const ORDER = { hit: 0, miss: 1, push: 2, absent: 3 } as const;
export const Mark = ({ v }: { v: GradedAngle["verdict"] }) =>
  <span className={`pill ${v === "hit" ? "over" : v === "miss" ? "under" : ""}`} style={{ minWidth: 58, textAlign: "center" }}>{v === "hit" ? "✓ called it" : v === "miss" ? "✗ missed" : v === "absent" ? "– didn't happen" : "≈ push"}</span>;

const MARKET_STAT: Record<string, string> = { player_pass_yds: "passing yards", player_rush_yds: "rushing yards", player_reception_yds: "receiving yards" };

/** What the angle said, what happened, and the box score behind it. */
export function Outcome({ a }: { a: GradedAngle }) {
  const tone = a.verdict === "hit" ? "over" : a.verdict === "miss" ? "under" : "";
  const lineAgreed = a.line_result === (a.lean === "over" ? "over" : "under");
  return (
    <div className="small" style={{ display: "grid", gap: 2 }}>
      <div className="muted">{a.said}</div>
      <div><b className={tone}>{a.happened}</b></div>
      {a.evidence && <div className="muted">{a.evidence}.</div>}
      {a.line !== null && a.line_result && (
        <div className="muted">Prop line was {fmtLine(a.line)} {a.market ? MARKET_STAT[a.market] ?? "" : ""}: he went <b className={a.line_result === "push" ? "" : lineAgreed ? "over" : "under"}>{a.line_result}</b>{a.line_result === "push" ? "" : lineAgreed ? ", the way the angle leaned" : ", against the angle"}.</div>
      )}
      {(a.verdict === "push" || a.verdict === "absent") && <div className="faint">{a.verdict_words}</div>}
      {a.note && <div className="faint">{a.note}</div>}
    </div>
  );
}

/** A played game's angles, as they read before kickoff, next to what
 *  happened. */
export function AngleReview({ rows, home, away, score }: { rows: GradedAngle[]; home: string; away: string; score: string }) {
  const dec = rows.filter((r) => r.verdict === "hit" || r.verdict === "miss");
  const hits = dec.filter((r) => r.verdict === "hit").length;
  const pushes = rows.length - dec.length;
  const sides = [away, home].map((off) => ({ off, rows: rows.filter((r) => r.offense === off) }));
  return (
    <div className="panel" data-tour="matchup-review">
      <div className="panel-head">
        <h3>How the calls did · final {score}</h3>
        <span className="hint"><b className={hits / Math.max(1, dec.length) >= 0.5 ? "over" : "under"}>{hits} of {dec.length}</b> right ({fmtPct(hits / Math.max(1, dec.length))}){pushes ? ` · ${pushes} not counted` : ""}</span>
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>Each call is what the matchup page said before kickoff, using only what was known then. It is right when the number it was about moved the way it said, against that team's or player's usual. A move smaller than 5% of the usual is too close to call and counts neither way.</div>
      <div className="grid grid-2">
        {sides.map(({ off, rows: rs }) => (
          <div key={off}>
            <div className="small" style={{ marginBottom: 6 }}><TeamTag abbr={off} /> <b>offense</b> <span className="muted">· {rs.filter((r) => r.verdict === "hit").length} of {rs.filter((r) => r.verdict === "hit" || r.verdict === "miss").length} right</span></div>
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
