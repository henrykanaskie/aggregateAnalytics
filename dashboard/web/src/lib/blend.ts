import { BlendInfo } from "../api";

const pct = (w: number) => `${Math.round(w * 100)}%`;

/** One line on how a blended number was made, for the hint under a table. */
export function blendNote(b: BlendInfo | null | undefined): string {
  if (!b) return "";
  if (!b.games) return `No ${b.season} games yet, so this is ${b.prior_season} pulled toward league average.`;
  const games = b.games_min !== undefined && b.games_min !== b.games ? `${b.games_min}-${b.games} games` : `${b.games} game${b.games === 1 ? "" : "s"}`;
  return `${b.season} so far (${games}) weighed against ${b.prior_season}: this season counts ${pct(b.weights.scheme)} on scheme `
    + `(box, coverage, personnel), ${pct(b.weights.tendency)} on play-calling (pass rate, pace, targets) and ${pct(b.weights.efficiency)} on efficiency (EPA, red zone, sacks), rising every week.`;
}

/** Short label for a column or header: "2026 blend" or "2026". */
export const blendLabel = (b: BlendInfo | null | undefined, season?: number) => b ? `${b.season} blend` : `${season ?? ""}`;

/** Which side of the ball had a coaching change, for the "last year counts less" note. */
export function staffNote(b: BlendInfo | null | undefined, side: "off" | "def"): string {
  if (!b) return "";
  const changed = side === "off" ? b.off_staff_changed : b.def_staff_changed;
  return changed ? `New ${side === "off" ? "offensive" : "defensive"} play-caller since ${b.prior_season}, so ${b.prior_season} is pulled harder toward league average.` : "";
}
