import type { Mode, Profile } from "./profile";

/** Page arrangements per mode.
 *
 *  A layout is a list of rows; each row is a set of columns with relative
 *  widths, and each column stacks one or more panels by id. The ids are the
 *  ones a page gives its panels (``research:chart`` ...). What a layout leaves
 *  out is not lost: any panel the profile still shows but no row placed goes
 *  into a closing two-column row, and panels the profile moved away go to
 *  "More" as before. So a layout only has to say what matters most, and where.
 *
 *  The arrangements are built around the question each kind of visitor opens a
 *  player page to answer:
 *  - fantasy: "what will he score, and is his role growing?" The fantasy
 *    snapshot leads, next to this week's matchup and injuries; usage (shares,
 *    teammates) sits right under the points chart, where it explains it.
 *  - betting: "how often does he clear this number, and where is the best
 *    one?" The chart against the line leads beside the books and the
 *    projection; distribution and splits of that same line come next.
 *  - learn: "what kind of player is this?" The chart leads next to where he
 *    sits among his position; situational splits and the full log follow.
 */

export type Cell = string | string[];
export interface Row { cols: number[]; cells: Cell[] }

const R = (cols: number[], ...cells: Cell[]): Row => ({ cols, cells });

const RESEARCH: Record<Exclude<Mode, "default">, Row[]> = {
  // Each lead row stacks two panels on its wide side, so the tall column beside
  // it (a matchup table, the books) is matched rather than left hanging.
  fantasy: [
    R([2, 1], ["research:fantasy", "research:chart"], ["research:matchup", "research:injuries"]),
    R([1, 1], "research:shares", "research:teammates"),
    R([1], "research:gamelog"),
    R([1, 1], "research:peers", "research:splits"),
  ],
  betting: [
    R([2, 1], ["research:chart", "research:tiles"], ["research:books", "research:prediction"]),
    R([1, 1, 1], "research:distribution", "research:splits", "research:injuries"),
    R([1, 1], "research:teammates", "research:correlations"),
    R([1], "research:gamelog"),
    R([1, 1], "research:matchup", "research:pbp"),
  ],
  learn: [
    R([3, 2], ["research:chart", "research:tiles"], "research:peers"),
    R([1, 1], "research:pbp", "research:splits"),
    R([1], "research:gamelog"),
    R([1, 1], "research:shares", "research:mini"),
    R([1, 1], "research:matchup", "research:injuries"),
  ],
};

/** The research layout for a profile, or null for the classic two columns.
 *  "Tables first" swaps the lead chart for the game log, and the chart takes
 *  the log's place further down. */
export function researchLayout(mode: Mode, profile: Profile | null): Row[] | null {
  if (mode === "default") return null;
  const rows = RESEARCH[mode];
  if (profile?.view !== "tables") return rows;
  const swap = (id: string) => (id === "research:chart" ? "research:gamelog" : id === "research:gamelog" ? "research:chart" : id);
  return rows.map((r) => ({ cols: r.cols, cells: r.cells.map((c) => (Array.isArray(c) ? c.map(swap) : swap(c))) }));
}

/** One line on how to read the page, for someone who said they are new. */
export const RESEARCH_GUIDE: Record<Exclude<Mode, "default">, string> = {
  fantasy: "Start with the snapshot: points per game, how often he has a big week or a dud, and whether his role (targets and carries) is growing. The matchup panel says how much this week's defense gives up to his position.",
  betting: "The chart shows every game against this week's line: green cleared it, red did not. The books show who has the best number, and the distribution and splits below say how often he clears it and when.",
  learn: "The chart is his game-by-game history for whichever stat you pick; the scatter places him among everyone at his position. Splits below break the same stat down by situation.",
};
