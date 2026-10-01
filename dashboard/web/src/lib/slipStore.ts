// Where saved picks live between visits. YOURS TO WRITE: everything else in
// the feature (the Board buttons, the slip drawer, the My bets page, the
// grading endpoint) is built against the four functions at the bottom and
// already works, but only for as long as the tab stays open, because these
// are stubs.
//
// What the rest of the app expects:
//   loadSlip()      called once when the app starts. Return what was saved, or
//                   EMPTY. Must not throw: a private window, a full quota or a
//                   blocked storage should give an empty slip, not a white page.
//   saveSlip(s)     called after every change with the whole state. Must not
//                   throw either.
//   shareLink(p)    a URL that, opened in another browser, lets someone add
//                   this parlay to their own slip. Throw if not supported; the
//                   share button then says so.
//   readShared(qs)  the reverse: given location.search, the parlay a share
//                   link carried, or null. The My bets page calls it on load.
//
// Things worth deciding while you are in here: what happens when the shape of
// Leg changes after people already have picks saved (a version number?), how
// much a share link should carry (the whole leg, or just enough to look the
// rest up), and whether anything should ever be pruned.

export type Side = "over" | "under" | "yes" | "no";

/** One pick, frozen as it was when it was added: the line is the one taken,
 *  which is what it is graded against, not wherever the market closed. */
export interface Leg {
  id: string;
  season: number;
  week: number;
  game_id: string;
  player_id: string;
  player_name: string;
  team: string | null;
  position: string | null;
  /** "AWAY@HOME", for display. */
  matchup: string;
  market: string;
  market_label: string;
  /** The catalog stat behind the market; what correlations are keyed on. */
  stat: string | null;
  kind: "ou" | "yesno";
  side: Side;
  /** null for yes/no markets, which have no line. */
  line: number | null;
  /** The book whose line was taken, or null for the cross-book consensus. */
  book: string | null;
  added_at: string;
}

/** A named group of legs. One leg is a single bet; the page treats it the same. */
export interface Parlay {
  id: string;
  name: string;
  legs: Leg[];
  created_at: string;
}

export interface SlipState {
  /** Legs being collected on the Board, not yet saved as a parlay. */
  draft: Leg[];
  parlays: Parlay[];
}

export const EMPTY: SlipState = { draft: [], parlays: [] };

export function loadSlip(): SlipState {
  // TODO: read what saveSlip wrote.
  return EMPTY;
}

export function saveSlip(_s: SlipState): void {
  // TODO: persist it.
}

export function shareLink(_p: Parlay): string {
  // TODO: encode the parlay into a URL pointing at /bets.
  throw new Error("sharing is not wired up yet");
}

export function readShared(_search: string): Parlay | null {
  // TODO: decode what shareLink produced.
  return null;
}
