import type { GameRow } from "../api";
import { Scoring, SCORING_LABEL } from "../lib/profile";
import { val } from "../lib/stats";

// The fantasy read on one player, from the game log alone: what they score,
// how steady it is, and whether the role behind it is growing or shrinking.

// Boom and bust lines per position and scoring, roughly a top-12 week and a
// week that loses a matchup on its own. Receptions are worth a point in PPR,
// so pass catchers' lines drop as the per-catch value does.
const MARKS: Record<string, Record<Scoring, [number, number]>> = {
  QB: { ppr: [24, 14], half: [24, 14], std: [24, 14] },
  RB: { ppr: [20, 8], half: [17, 7], std: [14, 5] },
  WR: { ppr: [20, 8], half: [17, 6], std: [14, 5] },
  TE: { ppr: [15, 6], half: [13, 5], std: [11, 4] },
  K: { ppr: [12, 5], half: [12, 5], std: [12, 5] },
  DST: { ppr: [12, 3], half: [12, 3], std: [12, 3] },
};
export const marksFor = (pos: string, s: Scoring) => (MARKS[pos === "FB" ? "RB" : pos] ?? MARKS.WR)[s];

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function pct(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const f1 = (v: number | null) => (v === null ? "–" : v.toFixed(1));
const pc = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const nums = (rows: GameRow[], k: string) => rows.map((r) => val(r, k)).filter((v): v is number => v !== null);

export default function FantasySnapshot({ rows, statKey, scoring, position, name }: { rows: GameRow[]; statKey: string; scoring: Scoring; position: string; name: string }) {
  const reg = rows.filter((r) => r.season_type === "REG");
  if (!reg.length) return <div className="hint">No regular-season games on record yet.</div>;
  const season = reg[reg.length - 1].season;
  const cur = reg.filter((r) => r.season === season);
  const prev = reg.filter((r) => r.season === season - 1);
  const recent = reg.slice(-16);
  const pts = nums(recent, statKey);
  const [boom, bust] = marksFor(position, scoring);

  // Touchdowns' share of the points: a high share is a player whose week turns
  // on a coin flip near the goal line.
  const tdPts = recent.reduce((a, r) => a + 6 * ((val(r, "rushing_tds") ?? 0) + (val(r, "receiving_tds") ?? 0)) + 4 * (val(r, "passing_tds") ?? 0), 0);
  const totPts = pts.reduce((a, b) => a + b, 0);

  const last3 = reg.slice(-3);
  const trend = (k: string) => ({ now: mean(nums(last3, k)), base: mean(nums(cur.length >= 4 ? cur : recent, k)) });
  const usage: { k: string; label: string; fmt: (v: number | null) => string }[] = [
    { k: "snap_offense_pct", label: "Snap share", fmt: pc },
    ...(position !== "QB" && position !== "K" ? [{ k: "target_share", label: "Target share", fmt: pc }] : []),
    ...(position === "RB" || position === "QB" ? [{ k: "carries", label: "Carries / game", fmt: f1 }] : []),
    ...(position === "WR" || position === "TE" || position === "RB" ? [{ k: "targets", label: "Targets / game", fmt: f1 }] : []),
  ];

  const Tile = ({ k, v, s, tone }: { k: string; v: string; s: string; tone?: "over" | "under" }) => (
    <div className="tile"><div className="k">{k}</div><div className="v" style={tone ? { color: `var(--${tone})` } : undefined}>{v}</div><div className="s">{s}</div></div>
  );
  const ppgNow = mean(nums(cur, statKey)), ppgPrev = mean(nums(prev, statKey)), l5 = mean(nums(reg.slice(-5), statKey));
  return (
    <>
      <div className="tiles">
        <Tile k={`${season} per game`} v={f1(ppgNow)} s={`${cur.length} game${cur.length === 1 ? "" : "s"}${ppgPrev !== null ? ` · ${season - 1}: ${f1(ppgPrev)}` : ""}`} />
        <Tile k="Last 5" v={f1(l5)} s={ppgNow !== null && l5 !== null ? `${l5 >= ppgNow ? "+" : ""}${(l5 - ppgNow).toFixed(1)} vs ${season}` : "per game"} tone={ppgNow !== null && l5 !== null ? (l5 - ppgNow > 2 ? "over" : l5 - ppgNow < -2 ? "under" : undefined) : undefined} />
        <Tile k="Floor" v={f1(pct(pts, 0.2))} s="a bad week, last 16" />
        <Tile k="Ceiling" v={f1(pct(pts, 0.8))} s="a good week, last 16" />
        <Tile k={`Boom ≥ ${boom}`} v={pc(pts.length ? pts.filter((x) => x >= boom).length / pts.length : null)} s={`of the last ${pts.length} games`} tone="over" />
        <Tile k={`Bust < ${bust}`} v={pc(pts.length ? pts.filter((x) => x < bust).length / pts.length : null)} s={`of the last ${pts.length} games`} tone="under" />
        {position !== "K" && <Tile k="From touchdowns" v={pc(totPts > 0 ? tdPts / totPts : null)} s="share of points, last 16" />}
      </div>
      {usage.length > 0 && (
        <div className="tbl-wrap" style={{ marginTop: 10 }}>
          <table className="tbl compact">
            <thead><tr><th className="left">Role</th><th>Last 3</th><th>{cur.length >= 4 ? season : "Last 16"}</th><th>Trend</th></tr></thead>
            <tbody>{usage.map((u) => { const t = trend(u.k); if (t.now === null && t.base === null) return null; const d = t.now !== null && t.base ? (t.now - t.base) / t.base : null; return (
              <tr key={u.k}><td className="left">{u.label}</td><td className="num">{u.fmt(t.now)}</td><td className="num muted">{u.fmt(t.base)}</td>
                <td className={`num ${d === null ? "muted" : d > 0.1 ? "over" : d < -0.1 ? "under" : ""}`}>{d === null ? "–" : d > 0.1 ? "growing" : d < -0.1 ? "shrinking" : "steady"}</td></tr>
            ); })}</tbody>
          </table>
        </div>
      )}
      <div className="hint" style={{ marginTop: 8 }}>Scoring is {SCORING_LABEL[scoring]}, regular season only. Boom and bust lines are rough marks for a {position === "FB" ? "RB" : position} week that wins or loses a matchup on its own. A role that is growing matters more than last week's points: usage predicts the next game better than the score of the last one. {name}'s full game-by-game chart is below.</div>
    </>
  );
}
