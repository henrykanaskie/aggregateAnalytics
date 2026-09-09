/** Turning a league rank into the colour it should carry.
 *
 * The rule everywhere: colour means *percentile*, not the size of the number.
 * A 65% pass rate tells you nothing on its own -- it is the rank against the
 * other 31 teams that says whether that is a lot -- so the shading is driven
 * by the rank and the raw value is left to the text.
 *
 * Two thirds of the metric catalogue (44 of 68) is marked ``good: "none"``:
 * pass rate, shotgun rate, personnel, target shares. Those are tendencies, not
 * achievements, and colouring them green would claim a fast offense is a good
 * one. They shade by intensity instead, so an extreme rank still reads as
 * extreme without being called a credit. Only where the direction genuinely
 * means better or worse does the hue become green or red.
 */

/** 1 = the highest value in the league that season, 0 = the lowest. */
export function pctile(rank: number | null | undefined, n: number | null | undefined): number | null {
  if (!rank || !n || n < 2) return null;
  return 1 - (rank - 1) / (n - 1);
}

/** How much of a credit this rank is: 1 = as good as it gets, 0 = as bad. */
function goodness(pct: number, good: string): number {
  return good === "high" ? pct : 1 - pct;
}

const mix = (token: string, alpha: number) =>
  `color-mix(in srgb, ${token} ${Math.round(alpha * 100)}%, transparent)`;

/** The token a metric's rank should be drawn in, before any alpha. */
function hue(pct: number, good: string): string {
  if (good === "none") return "var(--accent)";
  return goodness(pct, good) >= 0.5 ? "var(--over)" : "var(--under)";
}

/** How far from the middle this rank sits, 0 at the median and 1 at either end. */
function extremity(pct: number, good: string): number {
  return good === "none" ? pct : Math.abs(goodness(pct, good) - 0.5) * 2;
}

/** Background tint for a table cell showing a ranked value.
 *
 * A tint rather than coloured text: these tables are dense and wide, and text
 * that fades with the rank is text you cannot read at the faint end.
 */
export function rankTint(rank: number | null | undefined, n: number | null | undefined,
                         good: string): string | undefined {
  const pct = pctile(rank, n);
  if (pct === null) return undefined;
  return mix(hue(pct, good), 0.04 + extremity(pct, good) * 0.34);
}

/** Fill for a percentile bar.
 *
 * The bar's *length* is already the percentile, so the alpha here keeps a
 * floor: at the bottom of the league the bar is four pixels wide, and a faint
 * four pixels is an empty cell.
 */
export function barFill(pct: number | null | undefined, good: string): string {
  if (pct === null || pct === undefined) return "var(--border-2)";
  return mix(hue(pct, good), 0.5 + extremity(pct, good) * 0.5);
}
