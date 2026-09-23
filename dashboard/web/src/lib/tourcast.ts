import { api, apiGet, Board, Meta, ScheduleGame } from "../api";
import { readSticky } from "./sticky";
import type { Settings } from "../state";

// The tour cannot point at a chart nobody has asked for. Before it opens
// Research, Matchups, Teams or Coaches it goes and finds a real player, game,
// team and coach from this week, then drives the pages to them the way a user
// would. Everything here reads through the shared cache, and the URLs are the
// same ones the pages themselves build, so on a warmed app this costs nothing.

export interface Cast {
  playerId: string | null;
  playerName: string | null;
  market: string | null;
  gameId: string | null;
  team: string | null;
  coach: string | null;
  /** False when no lines have been pulled: the copy softens rather than lies. */
  fromLines: boolean;
  /** The player came off the visitor's own fantasy roster. */
  fromRoster: boolean;
  /** The team is the visitor's favorite, so the copy can say so. */
  favTeam: boolean;
}

/** What the visitor has already told the site, so the tour can open their own
 *  player and their own team instead of a stranger's. */
export interface Prefer { team: string | null; roster: { player_id: string; name: string; position: string; team: string | null }[] }

export const EMPTY_CAST: Cast = { playerId: null, playerName: null, market: null, gameId: null, team: null, coach: null, fromLines: false, fromRoster: false, favTeam: false };
const SKILL = ["QB", "RB", "WR", "TE"];
// Whichever prop has the most books on it is not always one a newcomer would
// recognise, so the plain ones are preferred where they exist.
const PLAIN = ["player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions", "player_rush_attempts"];

export async function buildCast(meta: Meta, settings: Settings, prefer: Prefer = { team: null, roster: [] }): Promise<Cast> {
  const cast: Cast = { ...EMPTY_CAST };

  // Same URL the board page builds, so this is a cache hit rather than a scan.
  const boardUrl = api.board.url({
    week: readSticky<number | null>("board.week", null) ?? meta.week,
    include_sample: settings.includeSample,
  });
  const board = await apiGet<Board>(boardUrl).catch(() => null);

  // The most heavily booked prop belonging to a skill player: the most books
  // means the most for the research page to show, and a kicker or a defence
  // would leave half its panels empty.
  const rank = (r: { market: string; n_books: number }) => (PLAIN.includes(r.market) ? 100 : 0) + r.n_books;
  const pick = (board?.rows ?? [])
    .filter((r) => r.player_id && r.kind === "ou" && SKILL.includes(r.position ?? ""))
    .sort((a, b) => rank(b) - rank(a) || b.n_books - a.n_books)[0];
  // Someone who has entered a roster would rather see one of their own. The
  // board row still supplies a game and a line when that player has one.
  const mine = prefer.roster.find((r) => SKILL.includes(r.position));
  if (mine) {
    const row = (board?.rows ?? []).filter((r) => r.player_id === mine.player_id && r.kind === "ou").sort((a, b) => rank(b) - rank(a))[0];
    cast.playerId = mine.player_id;
    cast.playerName = mine.name;
    cast.market = row?.market ?? null;
    cast.team = mine.team ?? row?.team ?? null;
    cast.gameId = row?.game_id ?? null;
    cast.fromLines = !!row;
    cast.fromRoster = true;
  } else if (pick) {
    cast.playerId = pick.player_id;
    cast.playerName = pick.player_name;
    cast.market = pick.market;
    cast.team = pick.team ?? pick.home_team;
    cast.gameId = pick.game_id;
    cast.fromLines = true;
  }

  const schedule = await api.schedule(meta.season, meta.week).catch(() => [] as ScheduleGame[]);
  // A favorite team's own game is the one worth opening, bye weeks aside.
  const favGame = prefer.team ? schedule.find((g) => g.home_team === prefer.team || g.away_team === prefer.team) : null;
  if (favGame) cast.gameId = favGame.game_id;
  if (!cast.gameId && schedule.length) {
    // The player's own game when the board row did not carry an id, otherwise
    // just the first one on the slate.
    const his = cast.team ? schedule.find((g) => g.home_team === cast.team || g.away_team === cast.team) : null;
    const g = his ?? schedule[0];
    cast.gameId = g.game_id;
    cast.team = cast.team ?? g.home_team;
  }

  // Nothing pulled yet: fall back to last season's leading scorer on whichever
  // team is playing, which every page can still say something about.
  if (!cast.playerId && cast.team) {
    const roster = await api.teamPlayers(cast.team, meta.stats_season).catch(() => []);
    const top = roster.find((p) => SKILL.includes(p.position));
    if (top) { cast.playerId = top.player_id; cast.playerName = top.name; }
  }

  // Teams and Coaches open on the favorite when there is one.
  if (prefer.team) { cast.team = prefer.team; cast.favTeam = true; }
  const coaches = meta.current_coaches ?? {};
  cast.coach = (cast.team ? coaches[cast.team] : null) ?? Object.values(coaches)[0] ?? null;
  return cast;
}
