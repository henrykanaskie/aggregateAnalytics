import { useMeta } from "../state";

/** What someone told the "Tailor it to me" questions, and everything the pages
 *  derive from it. The profile is the single contract between the questions
 *  and the layout: the quiz only ever writes one, and pages only ever read the
 *  `Lens` built from it, so either side can change without the other. */

export type Purpose = "betting" | "fantasy" | "learn";
export type FocusPos = "QB" | "RB" | "WR" | "TE" | "K" | "DST";
export type Scoring = "ppr" | "half" | "std";
/** What someone usually comes to do first; it decides the home page's lead
 *  and which page each mode puts first. */
export type Start = "player" | "games" | "fantasy" | "betting";
/** The page arrangement a profile gets. "default" is the untailored one. */
export type Mode = "fantasy" | "betting" | "learn" | "default";

export interface Profile {
  purposes: Purpose[];      // at least one
  positions: FocusPos[];    // empty = every position
  defense: "yes" | "some" | "no";   // players and teams / teams only / neither
  scoring: Scoring;
  depth: "quick" | "deep";
  team: string | null;
  start: Start;
  /** Season-long picks a weekly lineup; best ball and DFS live on ceilings. */
  fantasyFormat: "season" | "bestball" | "dfs";
  betStyle: "props" | "games" | "both";
  /** Whether the lead of a page is a chart or a table. */
  view: "charts" | "tables";
  /** New: explanations stay. Experienced: the page drops them for density. */
  experience: "new" | "pro";
  /** Panels moved back up by hand, by id, whatever the rules say about them. */
  pinned: string[];
}

export const EMPTY_PROFILE: Profile = {
  purposes: [], positions: [], defense: "some", scoring: "ppr", depth: "deep", team: null, pinned: [],
  start: "player", fantasyFormat: "season", betStyle: "both", view: "charts", experience: "new",
};

export const FANTASY_KEY: Record<Scoring, string> = { ppr: "fantasy_points_ppr", half: "fantasy_points_half", std: "fantasy_points" };
export const SCORING_LABEL: Record<Scoring, string> = { ppr: "PPR", half: "half PPR", std: "standard" };

export const DEF_POSITIONS = ["LB", "DE", "DT", "CB", "S", "SS", "FS", "OLB", "ILB", "MLB", "NT", "DB", "EDGE", "SAF"];
export const isDefPos = (p: string | null | undefined) => DEF_POSITIONS.includes(p ?? "");

/** Where a fantasy row links: a D/ST is a team, not a player. */
export const fantasyHref = (p: { player_id: string; position: string; team: string | null }, stat?: string) =>
  p.position === "DST" ? `/teams?team=${p.team}` : `/research?player=${p.player_id}${stat ? `&stat=${stat}` : ""}`;
/** The fantasy stat a player's page should chart: kickers have their own scoring. */
export const fantasyStatFor = (position: string, key: string) => (position === "K" ? "fantasy_points_k" : key);

/** Where a panel belongs. An empty tag set is for everyone. */
export interface Tags {
  /** Only for these purposes; omitted = everyone. */
  for?: Purpose[];
  /** "team": team defense tendencies. "players": individual defenders. */
  defense?: "team" | "players";
  /** Detail a "just the essentials" profile can live without. */
  deep?: boolean;
}

export function fits(p: Profile | null, t: Tags): boolean {
  if (!p) return true;
  if (t.for && !t.for.some((x) => p.purposes.includes(x))) return false;
  if (t.defense === "players" && p.defense !== "yes") return false;
  if (t.defense === "team" && p.defense === "no") return false;
  if (t.deep && p.depth === "quick") return false;
  return true;
}

export interface Words { line: string; lines: string; over: string; under: string }
const BET_WORDS: Words = { line: "line", lines: "lines", over: "over", under: "under" };
const PLAIN_WORDS: Words = { line: "benchmark", lines: "benchmarks", over: "above", under: "below" };

export interface Lens {
  profile: Profile | null;
  /** Which arrangement the pages use (see lib/layouts.ts). */
  mode: Mode;
  /** Fantasy formats that play for the big week rather than the safe one. */
  ceiling: boolean;
  /** The tabs, most useful first for this profile. */
  tabOrder: string[];
  /** Lines, books and hit rates against a line are the point. */
  betting: boolean;
  fantasy: boolean;
  fantasyKey: string;
  words: Words;
  /** Whether a panel with these tags goes on the page or into "More". */
  shows: (id: string, t: Tags) => boolean;
  /** Stat groups to leave out of pickers. */
  hideGroups: Set<string>;
}

/** The mode a profile lays out in: what they come to do first, when that is
 *  one of the things they said they are here for, else their first purpose. */
export function modeOf(p: Profile | null): Mode {
  if (!p || !p.purposes.length) return "default";
  const want: Record<Start, Purpose> = { fantasy: "fantasy", betting: "betting", player: p.purposes[0], games: p.purposes.includes("betting") && p.betStyle !== "props" ? "betting" : "learn" };
  const m = want[p.start];
  return p.purposes.includes(m) ? m : p.purposes[0];
}

const BASE_ORDER = ["/research", "/fantasy", "/board", "/matchups", "/games", "/teams", "/coaches", "/predictions", "/results", "/settings"];
function tabOrderOf(p: Profile | null, mode: Mode): string[] {
  if (!p) return BASE_ORDER;
  const first: string[] =
    mode === "fantasy" ? ["/fantasy", "/research", "/matchups", "/teams"]
      : mode === "betting" ? (p.betStyle === "games" ? ["/games", "/matchups", "/board", "/research"] : ["/board", "/research", "/matchups", "/games"])
      : p.start === "games" ? ["/matchups", "/teams", "/research", "/coaches"] : ["/research", "/teams", "/coaches", "/matchups"];
  return [...first, ...BASE_ORDER.filter((x) => !first.includes(x))];
}

export function lensOf(stored: Profile | null): Lens {
  // Profiles saved before a question existed get its default.
  const profile = stored ? { ...EMPTY_PROFILE, ...stored } : null;
  const mode = modeOf(profile);
  const betting = !profile || profile.purposes.includes("betting");
  const fantasy = !!profile && profile.purposes.includes("fantasy");
  return {
    profile, betting, fantasy, mode, tabOrder: tabOrderOf(profile, mode),
    ceiling: !!profile && fantasy && profile.fantasyFormat !== "season",
    fantasyKey: FANTASY_KEY[profile?.scoring ?? "ppr"],
    words: betting ? BET_WORDS : PLAIN_WORDS,
    shows: (id, t) => !!profile?.pinned.includes(id) || fits(profile, t),
    hideGroups: new Set(profile?.defense === "no" ? ["Defense"] : []),
  };
}

export function useLens(): Lens {
  const { settings } = useMeta();
  return lensOf(settings.profile);
}

/** The pages, in the order the nav shows them, and who each is for. */
export const TABS: { path: string; label: string; tags: Tags }[] = [
  { path: "/research", label: "Research", tags: {} },
  { path: "/fantasy", label: "Fantasy", tags: { for: ["fantasy"] } },
  { path: "/board", label: "Lines board", tags: { for: ["betting"] } },
  { path: "/matchups", label: "Matchups", tags: {} },
  { path: "/games", label: "Games", tags: { for: ["betting"] } },
  { path: "/teams", label: "Teams", tags: {} },
  { path: "/coaches", label: "Coaches", tags: { deep: true } },
  { path: "/predictions", label: "Predictions", tags: { for: ["betting"], deep: true } },
  { path: "/results", label: "Results", tags: { for: ["betting"] } },
  { path: "/settings", label: "Settings", tags: {} },
];

/** Plain-language summary of a profile, for Settings and the quiz's last step. */
export function describe(p: Profile, teamName?: string): string[] {
  const out: string[] = [];
  const names: Record<Purpose, string> = { betting: "betting props", fantasy: "fantasy football", learn: "following the game" };
  out.push(`Here for ${p.purposes.map((x) => names[x]).join(" and ")}`);
  const START: Record<Start, string> = { player: "Usually starts by looking up a player", games: "Usually starts with this week's games", fantasy: "Usually starts with their fantasy team", betting: "Usually starts with the betting lines" };
  out.push(START[p.start]);
  if (p.purposes.includes("fantasy")) {
    const l = SCORING_LABEL[p.scoring];
    out.push(`${l[0].toUpperCase()}${l.slice(1)} scoring, ${{ season: "season-long", bestball: "best ball", dfs: "daily fantasy" }[p.fantasyFormat]}`);
  }
  if (p.purposes.includes("betting")) out.push({ props: "Bets player props", games: "Bets spreads and totals", both: "Bets props and game lines" }[p.betStyle]);
  out.push(p.positions.length ? `Most interested in ${p.positions.join(", ")}` : "Every position");
  out.push(p.defense === "yes" ? "Defense included, down to individual defenders" : p.defense === "some" ? "Team defense only, no individual defenders" : "No defense");
  out.push(`${p.depth === "quick" ? "Just the essentials" : "Every detail"}, ${p.view === "charts" ? "charts first" : "tables first"}, ${p.experience === "new" ? "with explanations" : "no hand-holding"}`);
  if (p.team) out.push(`Favorite team: ${teamName ?? p.team}`);
  return out;
}

/** Split a page's panels into the ones on the page and the ones in "More",
 *  keeping each group in the page's own order. */
export function arrange<T extends { id: string; tags: Tags }>(lens: Lens, items: T[]): { shown: T[]; tucked: T[] } {
  const shown: T[] = [], tucked: T[] = [];
  for (const it of items) (lens.shows(it.id, it.tags) ? shown : tucked).push(it);
  return { shown, tucked };
}
