import type { FantasyProj, FantasyRecent } from "../api";
import type { Scoring } from "../lib/profile";

// The floor-to-ceiling strip with a player's recent games laid over it: the
// band is this week's simulated range (bad week to good week), the white tick
// the projection, and each dot a past game on the same scale, the newest
// largest and brightest. Whether his real weeks land inside the range, above
// it or below it reads at a glance.

const label = (g: FantasyRecent) => `${g.season !== undefined ? `${g.season} ` : ""}wk ${g.week}${g.opp ? ` vs ${g.opp}` : ""}`;

export default function RangeBar({ b, recent, scoring, max, dots = true }: {
  b: FantasyProj; recent?: FantasyRecent[]; scoring: Scoring; max: number; dots?: boolean;
}) {
  const at = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  const games = dots ? (recent ?? []).filter((g) => g.pts[scoring] !== null && g.pts[scoring] !== undefined) : [];
  const inRange = games.filter((g) => g.pts[scoring]! >= b.low && g.pts[scoring]! <= b.high).length;
  const title = `floor ${b.low.toFixed(1)} · projection ${b.value.toFixed(1)} · ceiling ${b.high.toFixed(1)}`
    + (games.length ? ` · ${inRange} of his ${games.length} game${games.length === 1 ? "" : "s"} this season inside the range` : "");
  return (
    <div className={`range-bar ${games.length ? "with-dots" : ""}`} title={title}>
      <span className="band" style={{ left: at(b.low), width: `calc(${at(b.high)} - ${at(b.low)})` }} />
      <span className="tick" style={{ left: at(b.value) }} />
      {games.map((g, i) => {
        const v = g.pts[scoring]!;
        const age = games.length - 1 - i;   // 0 = the latest game
        return (
          <span key={`${g.season}-${g.week}`} className={`dot ${age === 0 ? "latest" : ""} ${v > b.high ? "above" : v < b.low ? "below" : ""} ${v > max ? "clipped" : ""}`}
            style={{ left: at(v), opacity: Math.max(0.25, 1 - age * 0.09) }} title={`${label(g)}: ${v.toFixed(1)}`} />
        );
      })}
    </div>
  );
}

/** One scale for a list of bars, so they compare: the highest ceiling, and
 *  past games up to half again beyond it (a single monster week should not
 *  squash everyone else's bar; past that it pins to the edge). */
export function rangeMax(items: { b: FantasyProj | null; recent?: FantasyRecent[] }[], scoring: Scoring): number {
  const highs = items.map((x) => x.b?.high ?? 0);
  const top = Math.max(10, ...highs);
  const past = items.flatMap((x) => (x.recent ?? []).map((g) => g.pts[scoring] ?? 0));
  return Math.max(top, Math.min(top * 1.5, ...past.length ? [Math.max(...past)] : [0]));
}
