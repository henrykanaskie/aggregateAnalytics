// Typed client for dashboard/api/app.py.

import { cached, invalidate, prime } from "./lib/cache";

export interface Team {
  team_abbr: string; team_name: string; team_nick: string; team_conf: string; team_division: string;
  team_color: string; team_color2: string; team_logo_espn: string;
}
export interface StatDef { key: string; label: string; group: string; fmt: "int" | "dec1" | "dec2" | "pct"; since: number; note: string; positions: string[]; }
export interface MarketDef { key: string; label: string; stat: string | null; kind: "ou" | "yesno"; group: string; threshold: number; positions: string[]; espn: boolean; }
export interface SourceStatus { last_pull: string | null; pulls: number; rows: number; books: number; }
export interface FeedStatus { ok: boolean; at: string; props: number; games: number; error: string | null; last_ok: string | null }
export interface OddsStatus { feeds?: Record<string, FeedStatus>; has_sgo_key?: boolean; sgo_usage?: { month: string; objects: number; limit: number } | null; has_odds_api_key: boolean; status: Record<string, { props?: SourceStatus; games?: SourceStatus }>; oddsapi_usage: { at: string; remaining: number | null; used: number | null; last_cost: number | null; note: string } | null; }
export interface Meta {
  season: number; week: number; stats_season: number; data_version?: string; default_since: number; teams: Team[]; stats: StatDef[]; stat_groups: string[];
  markets: MarketDef[]; books: Record<string, string>; odds: OddsStatus; datasets: string[];
  split_dims: { key: string; label: string; roles: string[]; since: number; note: string }[];
  team_metrics: TeamMetric[]; team_table_ready: boolean; current_coaches: Record<string, string>;
  have_coordinators: boolean; coach_roles: CoachRole[];
}
export interface PlayerLite { player_id: string; name: string; position: string; team: string; first_season: number; last_season: number; games: number; headshot: string | null; jersey_number: string | null; status: string | null; }
export interface Player extends PlayerLite { birth_date: string | null; height: number | null; weight: number | null; college_name: string | null; draft_year: number | null; draft_round: number | null; draft_pick: number | null; draft_team: string | null; rookie_season: number | null; years_of_experience: number | null; espn_id: string | null; pfr_id: string | null; last_season_ppr: number | null; }
export type GameRow = Record<string, number | string | boolean | null> & {
  season: number; week: number; season_type: "REG" | "POST"; game_id: string; gameday: string | null; team: string; opponent: string;
  home: boolean; team_score: number | null; opp_score: number | null; margin: number | null; result: string | null;
  team_spread: number | null; total_line: number | null; total: number | null; implied_team_total: number | null; favorite: boolean | null;
  temp: number | null; wind: number | null; indoors: boolean | null; roof: string | null; qb_id: string | null; qb_name: string | null;
};
export interface GameLog { player_id: string; rows: GameRow[]; available: Record<string, number>; }
export interface BookLine { book: string; title: string; line: number | null; over: number | null; under: number | null; open_line: number | null; yes: number | null; no: number | null; source: string; last_update: string | null; delta: number | null; flag: "low" | "high" | null; novig_over?: number | null; moved?: number | null; implied?: number | null; novig_yes?: number | null; }
export interface FormWindow { n: number; over: number; push: number; rate: number | null; avg: number | null; }
export interface Form { n: number; avg: number; last: number; l5: FormWindow; l10: FormWindow; season: { n: number; over: number; rate: number }; }
export interface BoardRow {
  game_id: string | null; event_id: string; home_team: string; away_team: string; commence_time: string | null; market: string; market_label: string;
  stat: string | null; kind: "ou" | "yesno"; group: string; threshold: number; player_id: string | null; player_name: string; team: string | null;
  position: string | null; headshot: string | null; sources: string[]; consensus: number; mean_line: number; n_books: number; min_line: number; max_line: number;
  line_spread: number; outliers: string[]; best_over: { book: string; title: string; line: number | null; price: number } | null;
  best_under: { book: string; title: string; line: number | null; price: number } | null; books: BookLine[]; form?: Form | null; proj?: Proj | null;
}
export interface Board { season: number; week: number; sources: string[]; pulled_at: string | null; n: number; rows: BoardRow[]; alerts?: Alert[]; }
export interface ScheduleGame { game_id: string; season: number; week: number; game_type: string; gameday: string; gametime: string; home_team: string; away_team: string; home_score: number | null; away_score: number | null; spread_line: number | null; total_line: number | null; home_moneyline: number | null; away_moneyline: number | null; }
export interface HistoryRow { pulled_at: string; source: string; book: string; market: string; side: string; line: number | null; price: number | null; open_line: number | null; }
export interface PlayerLines { player_id: string; season: number; week: number; game: ScheduleGame | null; sources: string[]; markets: BoardRow[]; history: HistoryRow[]; }
export interface GamePrediction { game_id: string; model_version: string; logged_at: string; season: number; week: number; pred_margin: number; pred_win_prob: number; market_spread: number | null; market_total: number | null; notes: string | null; }
export interface GamesBook { book: string; title: string; source: string; [k: string]: any; }
export interface GamesResponse { season: number; week: number; sources: string[]; games: (ScheduleGame & { books: GamesBook[]; predictions: GamePrediction[] })[]; }
export interface PredictionsResponse { season: number; week: number; games: GamePrediction[]; props: any[]; prop_contract: Record<string, string>; prop_file: string; prop_file_exists: boolean; }
export interface PullResult { source: string; season: number; week: number; props: number; games: number; matched: number; files: string[]; usage: any; log: string[]; }

// The site is behind one password (webauth/). A 401 means the cookie is
// missing or expired: go to the box. The page reloads after it is entered.
function toPasswordBox(): never {
  window.location.replace("/password");
  throw new Error("password required");
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (r.status === 401) toPasswordBox();
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
  return r.json();
}

// Every read goes through the shared cache (lib/cache.ts): a fresh hit never
// touches the network, so leaving a tab and coming back costs nothing, and
// concurrent callers for the same URL share one request.
export const apiGet = <T,>(url: string): Promise<T> => cached<T>(url, fetchJson);
const get = apiGet;

/** Straight to the network, then into the cache. For the one read that has to
 *  be current to be useful: meta carries the data version, and reading it
 *  from a ten-minute-fresh copy would hide a deploy for ten minutes. */
export const apiFresh = <T,>(url: string): Promise<T> => fetchJson<T>(url).then((d) => { prime(url, d); return d; });

// Endpoints are declared once as a URL builder. `api.board(opts)` fetches;
// `api.board.url(opts)` is the same string as a cache key, which is what
// useQuery needs to read the cache before the first paint.
type Ep<A extends any[], T> = ((...a: A) => Promise<T>) & { url: (...a: A) => string };
const ep = <T,>() => <A extends any[]>(url: (...a: A) => string): Ep<A, T> => Object.assign((...a: A) => get<T>(url(...a)), { url });

/** Who this browser is, as the server sees it. `admin` decides whether the
 *  controls that pull lines or write to the log are drawn at all: a viewer
 *  holds a valid session and would get a 403 from every one of them, and a
 *  button that always fails is worse than no button. `admin_note` is why,
 *  when the reason is configuration rather than the password typed. */
export interface Session { authenticated: boolean; admin: boolean; admin_note: string | null; }
export const session = async (): Promise<Session> => {
  try {
    const r = await fetch("/api/auth/me");
    if (!r.ok) return { authenticated: false, admin: false, admin_note: null };
    return await r.json();
  } catch { return { authenticated: false, admin: false, admin_note: null }; }
};

export async function signOut(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.replace("/password");
}
const qs = (o: Record<string, any>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  meta: ep<Meta>()(() => "/api/meta"),
  search: ep<PlayerLite[]>()((q: string, opts: { limit?: number; position?: string; team?: string; active?: boolean } = {}) => `/api/players${qs({ q, ...opts })}`),
  player: ep<Player>()((id: string) => `/api/players/${id}`),
  gamelog: ep<GameLog>()((id: string, since: number) => `/api/players/${id}/gamelog${qs({ since })}`),
  playerLines: ep<PlayerLines>()((id: string, season?: number, week?: number, includeSample = false) => `/api/players/${id}/lines${qs({ season, week, include_sample: includeSample })}`),
  board: ep<Board>()((o: { season?: number; week?: number; market?: string[]; book?: string; include_sample?: boolean; scale?: number; form?: boolean }) => `/api/odds/board${qs(o)}`),
  games: ep<GamesResponse>()((season?: number, week?: number, includeSample = false) => `/api/odds/games${qs({ season, week, include_sample: includeSample })}`),
  schedule: ep<ScheduleGame[]>()((season?: number, week?: number) => `/api/schedule${qs({ season, week })}`),
  predictions: ep<PredictionsResponse>()((season?: number, week?: number, player_id?: string) => `/api/predictions${qs({ season, week, player_id })}`),
  status: ep<OddsStatus>()(() => "/api/odds/status"),
  teamPlayers: ep<{ player_id: string; name: string; position: string; games: number; ppr: number; headshot: string | null }[]>()((team: string, season: number) => `/api/teams/${team}/players${qs({ season })}`),
  pull: async (body: Record<string, any>) => {
    const r = await fetch("/api/odds/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) toPasswordBox();
    if (!r.ok) throw new Error((await r.json()).detail ?? r.statusText);
    invalidate(ODDS);   // a pull rewrites the snapshot store under every lines view
    return r.json() as Promise<PullResult>;
  },
};

// What a write makes wrong. Anything derived from the odds snapshots or from
// the graded log has to be dropped so the next read goes back to the API.
const ODDS = /^\/api\/(odds|meta|schedule|predictions|matchups|grading)\b|\/lines(\?|$)/;
const GRADED = /^\/api\/(grading|predictions)\b|^\/api\/odds\/board/;

// --- play-by-play splits, team tendencies, coaches ---------------------------
export interface SplitLevel { level: string; plays: number; share: number; [k: string]: number | string | null; }
export interface SplitDim { key: string; label: string; note: string; since: number; n: number; levels: SplitLevel[]; }
export interface Splits { role: "rush" | "rec" | "pass"; n_plays: number; since: number; metrics: [string, string, string][]; dims: SplitDim[]; roles: Record<string, number>; }
export interface SplitGames { role: string; dim: string; label?: string; games: { game_id: string; season: number; week: number; season_type: string; opponent: string; levels: Record<string, Record<string, number | null>> }[]; }
export interface TeamMetric { key: string; label: string; fmt: "pct" | "dec1" | "dec2" | "int"; side: "off" | "def"; since: number; note: string; good: "high" | "low" | "none"; }
export type TeamSeasonRow = Record<string, number | string | null> & { season: number; team: string; games: number; n_teams: number };
/** How a blended row was made: this season so far weighed against the last
 *  one. ``weights`` is this season's share per kind of number. */
export interface BlendInfo { season: number; prior_season: number; games: number; prior_games: number; through_week: number; weights: { scheme: number; tendency: number; efficiency: number }; off_staff_changed?: boolean; def_staff_changed?: boolean; games_min?: number; }
/** One number read against a specific opponent: the team's usual, what the
 *  other side draws from everyone, and the projection for this game. */
export interface H2HShift { key: string; label: string; fmt: string; side: "off" | "def"; usual: number; usual_rank: number | null; drawn: number; drawn_rank: number; expected: number; expected_rank: number; n_teams: number; by: string; moved: number; }
export interface TeamTendencies { now?: (TeamSeasonRow & { blend: BlendInfo }) | null; team: string; since: number; seasons: TeamSeasonRow[]; games: (Record<string, number | string | boolean | null> & { season: number; week: number; game_id: string; opponent: string; home: boolean })[]; coaches: { season: number; coach: string; games: number; wins: number; losses: number }[]; coordinators: { season: number; OC: string | null; DC: string | null }[]; current_coach: string | null; metrics: TeamMetric[]; }
export interface LeagueTendencies { season: number; teams: TeamSeasonRow[]; metrics: TeamMetric[]; coaches: Record<string, string>; blended: boolean; can_blend: boolean; blend: BlendInfo | null; }
export type CoachRoleKey = "HC" | "OC" | "DC";
export interface CoachRole { key: CoachRoleKey; label: string; sides: string[]; attribution: "game" | "season"; }
export interface CoachSummary { role: CoachRoleKey; coach: string; first_season: number; last_season: number; seasons: number; games: number; wins: number; losses: number; teams: string[]; current_team: string | null; has_history: boolean; }
export interface Fingerprint { key: string; label: string; side: string; fmt: string; good: string; mean_pct: number; seasons: number; top_third: number; bottom_third: number; career: number | null; }
export interface CoachProfile { coach: string; role: CoachRoleKey; role_label: string; sides: string[]; attribution: "game" | "season"; also: { role: CoachRoleKey; label: string; seasons: number; first_season: number; last_season: number }[]; season_roles: Partial<Record<CoachRoleKey, number>>; current_team: string | null; seasons: (TeamSeasonRow & { coach: string; held: CoachRoleKey; win: number; loss: number; tie: number; ppg: number | null; opp_ppg: number | null })[]; career: Record<string, number | null>; fingerprint: Fingerprint[]; metrics: TeamMetric[]; }

export interface MatchupSide { team: string; season: TeamSeasonRow | null; last4: Record<string, number | null> | null; coach: string | null; blend: BlendInfo | null; h2h: H2HShift[]; }
export interface Matchup { season: number; week: number; season_used: number; team: MatchupSide; opponent: MatchupSide; metrics: TeamMetric[]; }

export const api2 = {
  matchup: ep<Matchup>()((team: string, opponent: string) => `/api/matchup${qs({ team, opponent })}`),
  splits: ep<Splits>()((id: string, o: { role?: string; dim?: string[]; since?: number; season_type?: string; stat?: string }) => `/api/players/${id}/splits${qs(o)}`),
  splitGames: ep<SplitGames>()((id: string, role: string, dim: string, since: number) => `/api/players/${id}/splits/games${qs({ role, dim, since })}`),
  teamTendencies: ep<TeamTendencies>()((team: string, since: number, season_type = "REG") => `/api/teams/${team}/tendencies${qs({ since, season_type })}`),
  // `blend` is only sent to turn it off, so the default request stays one URL
  // for the prefetcher and the page alike.
  league: ep<LeagueTendencies>()((season: number, blend = true) => `/api/tendencies/league${qs({ season, blend: blend ? undefined : false })}`),
  coaches: ep<CoachSummary[]>()((role: string = "HC") => `/api/coaches?role=${role}`),
  coach: ep<CoachProfile>()((name: string, role: string = "HC") => `/api/coaches/${encodeURIComponent(name)}?role=${role}`),
};

// --- context: defense vs position, usage, injuries --------------------------
export type DvpRow = Record<string, number | string | null> & { defense: string; games: number; n_teams: number };
export interface Dvp { blended?: boolean; prior_season?: number; position: string; season: number; stats: string[]; labels: Record<string, string>; season_row: DvpRow | null; last4: Record<string, number> | null; log: Record<string, any>[]; }
export interface DvpLeague { blended?: boolean; prior_season?: number | null; season: number; position: string; stats: string[]; labels: Record<string, string>; league: DvpRow[]; team: string; log: Record<string, any>[]; }
export interface UsageRow { depth_rank?: number | null; stats_team?: string | null; new_to_team?: boolean; player_id: string; player_display_name: string; position: string; games: number; targets: number; receptions: number; receiving_yards: number; receiving_tds: number; carries: number; rushing_yards: number; rushing_tds: number; attempts: number; passing_yards: number; passing_tds: number; fantasy_points_ppr: number; receiving_air_yards: number; target_share: number | null; carry_share: number | null; air_share: number | null; targets_pg: number; carries_pg: number; ppr_pg: number; touches_pg: number; team_games: number; }
export interface UsageTop { name: string; player_id: string; games: number; target_share: number; carry_share: number; targets_pg: number; carries_pg: number; touches_pg: number; ppr_pg: number; }
export interface CoachUsageRow { team: string; season: number; team_games: number; rb1?: UsageTop; wr1?: UsageTop; te1?: UsageTop; rb2_carry_share?: number; rb_target_share: number | null; }
export interface InjuryRow { season: number; week: number; game_type: string; team: string; gsis_id: string; full_name: string; position: string; report_primary_injury: string | null; report_secondary_injury: string | null; report_status: string | null; practice_primary_injury: string | null; practice_status: string | null; }

export const api3 = {
  matchup: ep<Matchup & { dvp?: Dvp }>()((team: string, opponent: string, position?: string | null) => `/api/matchup${qs({ team, opponent, position })}`),
  dvp: ep<DvpLeague>()((team: string, position: string, season: number, blend = true) => `/api/teams/${team}/dvp${qs({ position, season, blend: blend ? undefined : false })}`),
  usage: ep<{ team: string; season: number; rows: UsageRow[] }>()((team: string, season: number) => `/api/teams/${team}/usage${qs({ season })}`),
  coachUsage: ep<{ coach: string; rows: CoachUsageRow[] }>()((name: string, role: string = "HC") => `/api/coaches/${encodeURIComponent(name)}/usage?role=${role}`),
  playerInjuries: ep<{ rows: InjuryRow[] }>()((id: string) => `/api/players/${id}/injuries`),
  teamInjuries: ep<{ team: string; season: number; week: number; latest_week_available: number | null; as_of?: string | null; rows: InjuryRow[] }>()((team: string, season?: number, week?: number) => `/api/teams/${team}/injuries${qs({ season, week })}`),
};

// --- game matchups -------------------------------------------------------------
/** The prop line an angle can be read against (dashboard/stats/angle_grades.py, line_context): a
 *  player's consensus line, or the sum of a position's, next to the same players' usual. */
export interface AngleLine { market: string; what: string; line: number; books: number | null; usual: number | null; usual_label: string; players?: string[]; }
export interface Angle { title: string; detail: string; lean: "over" | "under" | "neutral"; tags: string[]; strength: number; offense?: string; defense: string; player_id?: string; player?: string; position?: string; line?: AngleLine; }
export interface DefPlayer { status?: string | null; injury?: string | null; stats_team?: string | null; new_to_team?: boolean; player_id: string | null; name: string; position: string; group: string; games: number; snap_pct: number; headshot: string | null; targets: number; targets_pg: number | null; catch_rate: number | null; yards_allowed: number; yards_per_target: number | null; td_allowed: number | null; ints: number | null; adot_faced: number | null; pressures: number | null; sacks: number | null; tackles: number | null; missed_tackle_pct: number | null; }
export interface MatchupSideFull { offense: string; defense: string; usage_season?: number; usage_label?: string; offense_block: MatchupSide; defense_block: MatchupSide; dvp: Record<string, { season_row: DvpRow | null; last4: Record<string, number> | null; stats: string[] }>; angles: Angle[]; player_angles: Angle[]; offense_personnel: (UsageRow & { headshot?: string | null; status?: string | null; injury?: string | null })[]; defense_personnel: DefPlayer[]; }
export interface H2H { game_id: string; season: number; week: number; game_type: string; gameday: string; home_team: string; away_team: string; roof: string | null; a: string; b: string; a_home: boolean; a_pts: number; b_pts: number; margin: number; total: number; a_spread: number | null; total_line: number | null; a_cover: boolean | null; over: boolean | null; a_coach: string | null; b_coach: string | null; a_qb: string | null; b_qb: string | null; stars: { team: string; player_id: string; name: string; position: string; line: string; ppr: number }[]; }
export interface GameMatchup { game: ScheduleGame & Record<string, any>; season_used: number; blend: BlendInfo | null; sides: MatchupSideFull[]; metrics: TeamMetric[]; dvp_labels: Record<string, string>; history: H2H[]; venue: Record<string, any>; props: (BoardRow & { status?: string | null })[]; lines: any[]; predictions: GamePrediction[]; injuries: Record<string, InjuryRow[]>; sources: string[]; shares?: Record<string, GameShares>; }
/** Who got the ball in a played game (dashboard/stats/matchups.game_shares). */
export interface ShareRow { player_id: string; name: string; position: string; n: number; share: number | null; games: number; yards: number | null; td: number; receptions: number | null; }
export interface ZoneRow { player_id: string; name: string; position: string; n: number; games: number; games_here: number; share: number; td: number; ez: number | null; usual: number | null; usual_n: number | null; }
export interface ZoneShares { label: string; yards: number; carries: { total: number; rows: ZoneRow[] }; targets: { total: number; rows: ZoneRow[] }; }
export type ZoneKey = "rz" | "i10" | "gl";
export interface BoxShares { team_carries: number; team_targets: number; games: number; carries: ShareRow[]; targets: ShareRow[]; zones?: Record<ZoneKey, ZoneShares>; }
/** One game, and the team's season through that game's week (nothing after it). */
export interface GameShares extends BoxShares { season?: BoxShares & { weeks: number[] }; }
export const api4 = {
  gameMatchup: ep<GameMatchup>()((gameId: string, includeSample = false) => `/api/matchups/${gameId}${qs({ include_sample: includeSample })}`),
};

// --- projections, grading, teammates, correlations, adjustment, alerts -------------
export interface Proj { value: number; base: number; median: number; sd: number; factor: number; factor_ctx: { allowed: number; league: number; rank: number | null; n_teams?: number | null; games: number; season: number; prior_games?: number | null; blended?: boolean } | null; n: number; low: number; high: number; p_over: number | null; edge: number | null; model_version: string; }
export interface Alert { kind: "move" | "outlier" | "injury"; severity: number; player_id: string | null; player: string; team: string | null; market: string | null; market_label: string | null; game_id: string | null; title: string; detail: string; at?: string | null; }
export interface Teammate { player_id: string; name: string; position: string; games_with: number; games_without: number; eligible: string[]; }
export interface TeammatePresence { teammates: Teammate[]; presence: Record<string, string[]>; since?: number; }
export interface CorrRow { with: string; player_id: string | null; name?: string; position?: string; stat: string; r: number; n: number; }
export interface DvpFactors { stat: string; dvp_stat: string | null; factors: Record<string, Record<string, number>>; }
export interface GradeSummary { n: number; weeks: [number, number][]; by_book: { book: string; n: number; over_rate: number; push_rate: number; mae: number; bias: number }[]; by_market: { market: string; n: number; over_rate: number; push_rate: number; mae: number; bias: number }[]; signals: GradeSignal[]; movement: GradeSignal[]; models: { model_version: string; n: number; hit_rate: number | null; n_strong: number; hit_rate_strong: number | null; pred_mae: number; line_mae: number | null }[]; }
// A matchup angle rebuilt as of kickoff and checked against the game: the
// number it was about (measure), where that number usually sits (baseline) and
// where it landed (actual). dashboard/stats/angle_grades.py.
export interface GradedAngle { season: number; week: number; game_id: string; offense: string; defense: string; kind: "team" | "player"; family: string; title: string; detail: string; lean: "over" | "under" | "neutral"; strength: number; tags: string[]; player_id: string | null; player: string | null; position: string | null; team: string | null; measure: string; direction: "up" | "down"; baseline: number | null; baseline_label: string; actual: number | null; fmt: string; verdict: "hit" | "miss" | "absent" | "injured"; line: number | null; line_result: "over" | "under" | "push" | null; market: string | null;
  /** What the players with a line actually did, and whether that beat the line the way the angle leaned. */
  line_actual?: number | null; line_verdict?: "hit" | "miss" | null; line_words?: string | null;
  /** Plain-sentence versions, built by the server when the grades are read. */
  said?: string; happened?: string; evidence?: string | null; note?: string | null; verdict_words?: string;
  /** Box and blitz angles: whether the thing the angle was about happened in
   *  that game, from FTN's charting, and how the snaps it was about went. */
  in_game?: InGame | null; }
export interface InGame { snaps: number; of: number; label: string; unit: string; premise: string; split: string; on_n: number; on_sum: number; off_n: number; off_sum: number; }
export interface AngleFamily { family: string; kind: "team" | "player"; n: number; hits: number; rate: number; lean: string;
  /** Against the closing line, only the calls that had one. */
  line_n?: number; line_hits?: number; }
export interface GradeSignal { id: string; signal: string; n: number; hit_rate: number }
/** One signal opened up: every graded line it fired on (dashboard/odds/grading.py). */
export interface SignalLines { id: string; signal: string; why: string; n: number; hits: number;
  rows: { season: number; week: number; game_id: string; book: string; market: string; player_id: string; player_name: string; team: string | null; line: number; open_line: number | null; moved: number | null; actual: number; result: "over" | "under"; l5_rate: number | null; l10_rate: number | null; form_n: number; hit: boolean }[]; }
/** One row of the track record opened up: every graded call behind it. */
export interface AngleFamilyRecord { family: string; kind: "team" | "player"; lean: string; season: number | null; weeks: [number, number][]; why: string | null; n: number; hits: number; absent: number; injured?: number;
  graded_on: { measure: string; baseline_label: string; direction: "up" | "down" } | null; prop: { n: number; agreed: number } | null;
  premise: { label: string; unit: string; games: number; snaps: number; of: number; on: number | null; off: number | null; never: number } | null; rows: GradedAngle[]; }
export interface AngleTrackRecord { season: number | null; current: boolean; weeks: [number, number][]; n: number; hits: number; absent?: number; injured?: number; line_n?: number; line_hits?: number; families: AngleFamily[]; by_kind: { kind: string; n: number; hits: number; rate: number; line_n?: number; line_hits?: number }[]; best: GradedAngle[]; }
/** value: ESPN's projection when it has one ("espn"), the site's baseline otherwise.
 *  low / high: a bad week and a good week (20th and 80th percentile) simulated
 *  from the player's own games around that value. base: the site's baseline. */
export interface FantasyProj { value: number; low: number; high: number; base: number | null; last3: number | null; source?: "espn" | "baseline" }
export interface FantasyRecent { season: number; week: number; opp: string | null; pts: Record<"ppr" | "half" | "std", number | null> }
export interface FantasyPlayer {
  player_id: string; name: string; position: "QB" | "RB" | "WR" | "TE" | "K" | "DST"; team: string; depth_rank: number | null; headshot: string | null;
  new_to_team: boolean; stats_team: string | null; target_share: number | null; carry_share: number | null;
  status: string | null; injury: string | null; opponent: string; home: boolean; game_id: string; gameday: string | null; implied: number | null;
  games: number; factor: number; matchup_rank: number | null; matchup_n: number | null;
  /** Kickers and D/STs say what their matchup is in words; skill players use rank and position. */
  matchup_text?: string | null;
  /** D/ST only: the points its opponent is expected to score. */
  opp_implied?: number | null;
  /** The last few games, oldest first, scored in every format. */
  recent?: FantasyRecent[];
  proj: Record<"ppr" | "half" | "std", FantasyProj | null>; role: { last3: number; before: number } | null;
}
export interface FantasyWeek {
  season: number; week: number; byes: string[]; injury_week: number | null; players: FantasyPlayer[];
  games: { game_id: string; home_team: string; away_team: string; gameday: string | null; gametime: string | null; total: number | null; home_implied: number | null; away_implied: number | null }[];
  method: { n_games: number; min_games: number; espn?: number; floor_q?: number; ceiling_q?: number };
}
export const apiFantasy = {
  fantasyWeek: ep<FantasyWeek>()((season: number, week: number) => `/api/fantasy/week${qs({ season, week })}`),
};

// League imports (dashboard/leagues/). Each is someone's own roster, read on
// their behalf, so these skip the shared cache: a second import should see
// the trade made since the first.
export interface ImportedTeam { team_id: string; name: string; owner: string | null; players: { player_id: string; name: string; position: string; team: string | null }[]; starters: string[]; unmatched: string[] }
export interface ImportedLeague { league_id: string; name: string; season: number; scoring: { format: "ppr" | "half" | "std"; rec: number } | null; slots: Record<"QB" | "RB" | "WR" | "TE" | "FLEX" | "SFLEX" | "K" | "DST", number> | null; teams: ImportedTeam[] }
export interface LeagueImport { platform: "sleeper" | "espn" | "yahoo"; leagues: ImportedLeague[] }
async function leagueGet<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (r.status === 401) toPasswordBox();
  if (!r.ok) throw new Error(await r.json().then((j) => j.detail).catch(() => r.statusText));
  return r.json();
}
export const apiLeagues = {
  status: () => leagueGet<{ sleeper: boolean; espn: boolean; yahoo: boolean }>("/api/leagues/status"),
  sleeper: (username: string) => leagueGet<LeagueImport>(`/api/leagues/sleeper${qs({ username })}`),
  espn: (league: string) => leagueGet<LeagueImport>(`/api/leagues/espn${qs({ league })}`),
  /** A full-page trip to Yahoo's sign-in; the result comes back through sessionStorage. */
  yahooStart: () => { window.location.href = "/api/leagues/yahoo/start"; },
};
/** Where the Yahoo callback leaves its result (dashboard/leagues/router.py, HANDOFF_KEY). */
export const LEAGUE_HANDOFF = "league.import";

export const api5 = {
  teammates: ep<TeammatePresence>()((id: string) => `/api/players/${id}/teammates`),
  correlations: ep<{ stat: string; rows: CorrRow[] }>()((id: string, stat: string) => `/api/players/${id}/correlations${qs({ stat })}`),
  dvpFactors: ep<DvpFactors>()((position: string, stat: string, since: number) => `/api/dvp/factors${qs({ position, stat, since })}`),
  gradeSummary: ep<GradeSummary>()((season?: number) => `/api/grading/summary${qs({ season })}`),
  angleReview: ep<GradedAngle[]>()((gameId: string) => `/api/grading/angles/${gameId}`),
  angleTrack: ep<AngleTrackRecord>()((weeks = 22) => `/api/grading/angles/track-record${qs({ weeks })}`),
  angleFamily: ep<AngleFamilyRecord>()((family: string, kind: string, lean: string, weeks = 22) => `/api/grading/angles/family${qs({ family, kind, lean, weeks })}`),
  signalLines: ep<SignalLines>()((id: string, season?: number) => `/api/grading/signals/${id}${qs({ season })}`),
  gradeRun: async (season: number, week: number, include_sample = false) => {
    const r = await fetch("/api/grading/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ season, week, include_sample }) });
    invalidate(GRADED);
    return r.json() as Promise<{ graded: number }>;
  },
  logBaseline: async (season?: number, week?: number) => {
    const r = await fetch("/api/projections/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ season, week }) });
    invalidate(GRADED);
    return r.json() as Promise<{ logged: number; week: number }>;
  },
};

// --- scatter ---------------------------------------------------------------------
export type ScatterRow = Record<string, number | string | null> & { player_id: string; name: string; team: string; position: string; games: number; headshot: string | null };
export const api6 = {
  scatterPlayers: ep<{ season: number; position: string; rows: ScatterRow[] }>()((season: number, position: string, min_games = 4) => `/api/scatter/players${qs({ season, position, min_games })}`),
};

// --- team shares -----------------------------------------------------------------
/** player_id -> share of this team's carries or targets. */
type ShareMap = Record<string, number>;
export interface TeamGame { week: number; opponent: string; game_id: string }
/** A team's regular season, or one game of it, as share charts, with the
 *  shares they are read against (dashboard/stats/matchups.team_season_shares). */
export interface TeamShares extends Partial<BoxShares> {
  team: string; season: number; weeks: number[]; games: number;
  /** Set when one game is asked for rather than the whole season. */
  week?: number | null; game?: TeamGame | null; schedule: TeamGame[];
  /** What the charts are read against: last season, or the season a single game belongs to. */
  last?: { label: string; games: number; carries?: ShareMap; targets?: ShareMap; zones?: Record<ZoneKey, { carries: ShareMap; targets: ShareMap }> };
}
export const api7 = {
  teamShares: ep<TeamShares>()((team: string, season?: number, week?: number) => `/api/teams/${team}/shares${qs({ season, week })}`),
};
