/** Turning a league rank into the colour it should carry.
 *
 * The rule everywhere: colour means *percentile*, and one scale serves every
 * percentile on the dashboard, from a coach's career bar to a single cell in a
 * team table. Under 30 is red, 30 to 49 orange, 50 to 69 yellow, 70 to 89
 * purple, 90 and up green. Purple rather than blue: blue is the accent that
 * marks the selected chip, the focused row and every link, and a rank that
 * shared it looked selected. The number is what is coloured: a 91st-percentile
 * pass rate is green because it is a 91, whether or not passing that much is
 * a virtue. Where a metric is better low (EPA allowed, sacks taken), the
 * percentile is taken the good way round first, so green always means good
 * and never "the most of a bad thing".
 */

/** 1 = the highest value in the league that season, 0 = the lowest. */
export function pctile(rank: number | null | undefined, n: number | null | undefined): number | null {
  if (!rank || !n || n < 2) return null;
  return 1 - (rank - 1) / (n - 1);
}

export type Band = "red" | "orange" | "yellow" | "purple" | "green";

/** The band a percentile (0 to 1) falls in, on the number as it is displayed. */
export function band(pct: number | null | undefined): Band | null {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return null;
  const p = Math.round(pct * 100);
  return p < 30 ? "red" : p < 50 ? "orange" : p < 70 ? "yellow" : p < 90 ? "purple" : "green";
}

/** How to say the scale in a hint, so every page describes it the same way. */
export const PCT_LEGEND = "red under 30, orange to 49, yellow to 69, purple to 89, green from 90";

/** The percentile the good way round: for a metric that is better low, a
 *  value at the bottom of the league is the top of this scale. */
export function oriented(pct: number | null | undefined, good?: string | null): number | null | undefined {
  return good === "low" && pct !== null && pct !== undefined ? 1 - pct : pct;
}

const token = (b: Band) => `var(--pct-${b})`;
const mix = (t: string, alpha: number) => `color-mix(in srgb, ${t} ${Math.round(alpha * 100)}%, transparent)`;

/** The solid colour for a percentile: bars, swatches, anything not carrying text. */
export function pctColor(pct: number | null | undefined, good?: string | null): string | undefined {
  const b = band(oriented(pct, good));
  return b ? token(b) : undefined;
}

/** Background tint for a table cell showing a ranked value.
 *
 * A tint rather than coloured text: these tables are dense and wide, and a
 * fixed alpha keeps the number readable in every band and both themes.
 */
/** The rank as a reader expects it. The tables rank by value, 1 = highest,
 *  which for "EPA allowed" or "sacks taken" makes 1 the worst in the league.
 *  Where lower is better the shown rank counts from the best instead, so 1 is
 *  always the best where "best" means anything, and the highest value where
 *  it does not (pass rate, blitz rate). Colour is worked out from the raw
 *  rank and the direction, so it needs no such flip. */
export function shownRank(rank: number | null | undefined, n: number | null | undefined, good?: string | null): number | null {
  if (rank === null || rank === undefined) return null;
  return good === "low" && n ? n - rank + 1 : rank;
}
export function rankTint(rank: number | null | undefined, n: number | null | undefined, good?: string | null): string | undefined {
  const b = band(oriented(pctile(rank, n), good));
  return b ? mix(token(b), 0.3) : undefined;
}

/** Fill for a percentile bar. The bar's length is the percentile; the colour is its band. */
export function barFill(pct: number | null | undefined, good?: string | null): string {
  return pctColor(pct, good) ?? "var(--border-2)";
}
