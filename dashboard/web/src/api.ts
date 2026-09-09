// Typed client for dashboard/api/app.py.

export interface Team {
  team_abbr: string; team_name: string; team_nick: string; team_conf: string; team_division: string;
  team_color: string; team_color2: string; team_logo_espn: string;
}
export interface StatDef { key: string; label: string; group: string; fmt: "int" | "dec1" | "dec2" | "pct"; since: number; note: string; positions: string[]; }
export interface MarketDef { key: string; label: string; stat: string | null; kind: "ou" | "yesno"; group: string; threshold: number; positions: string[]; espn: boolean; }
export interface SourceStatus { last_pull: string | null; pulls: number; rows: number; books: number; }
export interface OddsStatus { has_odds_api_key: boolean; status: Record<string, { props?: SourceStatus; games?: SourceStatus }>; oddsapi_usage: { at: string; remaining: number | null; used: number | null; last_cost: number | null; note: string } | null; }
export interface Meta {
  season: number; week: number; default_since: number; teams: Team[]; stats: StatDef[]; stat_groups: string[];
  markets: MarketDef[]; books: Record<string, string>; odds: OddsStatus; datasets: string[];
  split_dims: { key: string; label: string; roles: string[]; since: number; note: string }[];
  team_metrics: TeamMetric[]; team_table_ready: boolean; current_coaches: Record<string, string>;
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

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (r.status === 401) toPasswordBox();
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
  return r.json();
}

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
  meta: () => get<Meta>("/api/meta"),
  search: (q: string, opts: { limit?: number; position?: string; team?: string; active?: boolean } = {}) => get<PlayerLite[]>(`/api/players${qs({ q, ...opts })}`),
  player: (id: string) => get<Player>(`/api/players/${id}`),
  gamelog: (id: string, since: number) => get<GameLog>(`/api/players/${id}/gamelog${qs({ since })}`),
  playerLines: (id: string, season?: number, week?: number, includeSample = false) => get<PlayerLines>(`/api/players/${id}/lines${qs({ season, week, include_sample: includeSample })}`),
  board: (o: { season?: number; week?: number; market?: string[]; book?: string; include_sample?: boolean; scale?: number; form?: boolean }) => get<Board>(`/api/odds/board${qs(o)}`),
  games: (season?: number, week?: number, includeSample = false) => get<GamesResponse>(`/api/odds/games${qs({ season, week, include_sample: includeSample })}`),
  schedule: (season?: number, week?: number) => get<ScheduleGame[]>(`/api/schedule${qs({ season, week })}`),
  predictions: (season?: number, week?: number) => get<PredictionsResponse>(`/api/predictions${qs({ season, week })}`),
  status: () => get<OddsStatus>("/api/odds/status"),
  teamPlayers: (team: string, season: number) => get<{ player_id: string; name: string; position: string; games: number; ppr: number; headshot: string | null }[]>(`/api/teams/${team}/players${qs({ season })}`),
  pull: async (body: Record<string, any>) => {
    const r = await fetch("/api/odds/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) toPasswordBox();
    if (!r.ok) throw new Error((await r.json()).detail ?? r.statusText);
    return r.json() as Promise<PullResult>;
  },
};

// --- play-by-play splits, team tendencies, coaches ---------------------------
export interface SplitLevel { level: string; plays: number; share: number; [k: string]: number | string | null; }
export interface SplitDim { key: string; label: string; note: string; since: number; n: number; levels: SplitLevel[]; }
export interface Splits { role: "rush" | "rec" | "pass"; n_plays: number; since: number; metrics: [string, string, string][]; dims: SplitDim[]; roles: Record<string, number>; }
export interface SplitGames { role: string; dim: string; label?: string; games: { game_id: string; season: number; week: number; season_type: string; opponent: string; levels: Record<string, Record<string, number | null>> }[]; }
export interface TeamMetric { key: string; label: string; fmt: "pct" | "dec1" | "dec2" | "int"; side: "off" | "def"; since: number; note: string; good: "high" | "low" | "none"; }
export type TeamSeasonRow = Record<string, number | string | null> & { season: number; team: string; games: number; n_teams: number };
export interface TeamTendencies { team: string; since: number; seasons: TeamSeasonRow[]; games: (Record<string, number | string | boolean | null> & { season: number; week: number; game_id: string; opponent: string; home: boolean })[]; coaches: { season: number; coach: string; games: number; wins: number; losses: number }[]; current_coach: string | null; metrics: TeamMetric[]; }
export interface LeagueTendencies { season: number; teams: TeamSeasonRow[]; metrics: TeamMetric[]; coaches: Record<string, string>; }
export interface CoachSummary { coach: string; first_season: number; last_season: number; seasons: number; games: number; wins: number; losses: number; teams: string[]; current_team: string | null; }
export interface Fingerprint { key: string; label: string; side: string; fmt: string; good: string; mean_pct: number; seasons: number; top_third: number; bottom_third: number; career: number | null; }
export interface CoachProfile { coach: string; current_team: string | null; seasons: (TeamSeasonRow & { coach: string; win: number; loss: number; tie: number; ppg: number | null; opp_ppg: number | null })[]; career: Record<string, number | null>; fingerprint: Fingerprint[]; metrics: TeamMetric[]; }

export interface MatchupSide { team: string; season: TeamSeasonRow | null; last4: Record<string, number | null> | null; coach: string | null; }
export interface Matchup { season_used: number; team: MatchupSide; opponent: MatchupSide; metrics: TeamMetric[]; }

export const api2 = {
  matchup: (team: string, opponent: string) => get<Matchup>(`/api/matchup${qs({ team, opponent })}`),
  splits: (id: string, o: { role?: string; dim?: string[]; since?: number; season_type?: string; stat?: string }) => get<Splits>(`/api/players/${id}/splits${qs(o)}`),
  splitGames: (id: string, role: string, dim: string, since: number) => get<SplitGames>(`/api/players/${id}/splits/games${qs({ role, dim, since })}`),
  teamTendencies: (team: string, since: number, season_type = "REG") => get<TeamTendencies>(`/api/teams/${team}/tendencies${qs({ since, season_type })}`),
  league: (season: number) => get<LeagueTendencies>(`/api/tendencies/league${qs({ season })}`),
  coaches: () => get<CoachSummary[]>("/api/coaches"),
  coach: (name: string) => get<CoachProfile>(`/api/coaches/${encodeURIComponent(name)}`),
};

// --- context: defense vs position, usage, injuries --------------------------
export type DvpRow = Record<string, number | string | null> & { defense: string; games: number; n_teams: number };
export interface Dvp { position: string; season: number; stats: string[]; labels: Record<string, string>; season_row: DvpRow | null; last4: Record<string, number> | null; log: Record<string, any>[]; }
export interface DvpLeague { season: number; position: string; stats: string[]; labels: Record<string, string>; league: DvpRow[]; team: string; log: Record<string, any>[]; }
export interface UsageRow { player_id: string; player_display_name: string; position: string; games: number; targets: number; receptions: number; receiving_yards: number; receiving_tds: number; carries: number; rushing_yards: number; rushing_tds: number; attempts: number; passing_yards: number; passing_tds: number; fantasy_points_ppr: number; receiving_air_yards: number; target_share: number; carry_share: number; air_share: number; targets_pg: number; carries_pg: number; ppr_pg: number; touches_pg: number; team_games: number; }
export interface UsageTop { name: string; player_id: string; games: number; target_share: number; carry_share: number; targets_pg: number; carries_pg: number; touches_pg: number; ppr_pg: number; }
export interface CoachUsageRow { team: string; season: number; team_games: number; rb1?: UsageTop; wr1?: UsageTop; te1?: UsageTop; rb2_carry_share?: number; rb_target_share: number | null; }
export interface InjuryRow { season: number; week: number; game_type: string; team: string; gsis_id: string; full_name: string; position: string; report_primary_injury: string | null; report_secondary_injury: string | null; report_status: string | null; practice_primary_injury: string | null; practice_status: string | null; }

export const api3 = {
  matchup: (team: string, opponent: string, position?: string | null) => get<Matchup & { dvp?: Dvp }>(`/api/matchup${qs({ team, opponent, position })}`),
  dvp: (team: string, position: string, season: number) => get<DvpLeague>(`/api/teams/${team}/dvp${qs({ position, season })}`),
  usage: (team: string, season: number) => get<{ team: string; season: number; rows: UsageRow[] }>(`/api/teams/${team}/usage${qs({ season })}`),
  coachUsage: (name: string) => get<{ coach: string; rows: CoachUsageRow[] }>(`/api/coaches/${encodeURIComponent(name)}/usage`),
  playerInjuries: (id: string) => get<{ rows: InjuryRow[] }>(`/api/players/${id}/injuries`),
  teamInjuries: (team: string, season?: number, week?: number) => get<{ team: string; season: number; week: number; latest_week_available: number | null; rows: InjuryRow[] }>(`/api/teams/${team}/injuries${qs({ season, week })}`),
};

// --- game matchups -------------------------------------------------------------
export interface Angle { title: string; detail: string; lean: "over" | "under" | "neutral"; tags: string[]; strength: number; offense?: string; defense: string; player_id?: string; player?: string; position?: string; }
export interface DefPlayer { player_id: string | null; name: string; position: string; group: string; games: number; snap_pct: number; headshot: string | null; targets: number; targets_pg: number | null; catch_rate: number | null; yards_allowed: number; yards_per_target: number | null; td_allowed: number | null; ints: number | null; adot_faced: number | null; pressures: number | null; sacks: number | null; tackles: number | null; missed_tackle_pct: number | null; }
export interface MatchupSideFull { offense: string; defense: string; offense_block: MatchupSide; defense_block: MatchupSide; dvp: Record<string, { season_row: DvpRow | null; last4: Record<string, number> | null; stats: string[] }>; angles: Angle[]; player_angles: Angle[]; offense_personnel: (UsageRow & { headshot?: string | null })[]; defense_personnel: DefPlayer[]; }
export interface H2H { game_id: string; season: number; week: number; game_type: string; gameday: string; home_team: string; away_team: string; roof: string | null; a: string; b: string; a_home: boolean; a_pts: number; b_pts: number; margin: number; total: number; a_spread: number | null; total_line: number | null; a_cover: boolean | null; over: boolean | null; a_coach: string | null; b_coach: string | null; a_qb: string | null; b_qb: string | null; stars: { team: string; player_id: string; name: string; position: string; line: string; ppr: number }[]; }
export interface GameMatchup { game: ScheduleGame & Record<string, any>; season_used: number; sides: MatchupSideFull[]; metrics: TeamMetric[]; dvp_labels: Record<string, string>; history: H2H[]; venue: Record<string, any>; props: BoardRow[]; lines: any[]; predictions: GamePrediction[]; injuries: Record<string, InjuryRow[]>; sources: string[]; }
export const api4 = {
  gameMatchup: (gameId: string, includeSample = false) => get<GameMatchup>(`/api/matchups/${gameId}${qs({ include_sample: includeSample })}`),
};

// --- projections, grading, teammates, correlations, adjustment, alerts -------------
export interface Proj { value: number; base: number; median: number; sd: number; factor: number; factor_ctx: { allowed: number; league: number; rank: number | null; games: number; season: number } | null; n: number; low: number; high: number; p_over: number | null; edge: number | null; model_version: string; }
export interface Alert { kind: "move" | "outlier" | "injury"; severity: number; player_id: string | null; player: string; team: string | null; market: string | null; market_label: string | null; game_id: string | null; title: string; detail: string; }
export interface Teammate { player_id: string; name: string; position: string; games_with: number; games_without: number; eligible: string[]; }
export interface TeammatePresence { teammates: Teammate[]; presence: Record<string, string[]>; since?: number; }
export interface CorrRow { with: string; player_id: string | null; name?: string; position?: string; stat: string; r: number; n: number; }
export interface DvpFactors { stat: string; dvp_stat: string | null; factors: Record<string, Record<string, number>>; }
export interface GradeSummary { n: number; weeks: [number, number][]; by_book: { book: string; n: number; over_rate: number; push_rate: number; mae: number; bias: number }[]; by_market: { market: string; n: number; over_rate: number; push_rate: number; mae: number; bias: number }[]; signals: { signal: string; n: number; hit_rate: number }[]; movement: { signal: string; n: number; hit_rate: number }[]; models: { model_version: string; n: number; hit_rate: number | null; n_strong: number; hit_rate_strong: number | null; pred_mae: number; line_mae: number | null }[]; }
export const api5 = {
  teammates: (id: string) => get<TeammatePresence>(`/api/players/${id}/teammates`),
  correlations: (id: string, stat: string) => get<{ stat: string; rows: CorrRow[] }>(`/api/players/${id}/correlations${qs({ stat })}`),
  dvpFactors: (position: string, stat: string, since: number) => get<DvpFactors>(`/api/dvp/factors${qs({ position, stat, since })}`),
  gradeSummary: (season?: number) => get<GradeSummary>(`/api/grading/summary${qs({ season })}`),
  gradeRun: async (season: number, week: number, include_sample = false) => { const r = await fetch("/api/grading/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ season, week, include_sample }) }); return r.json() as Promise<{ graded: number }>; },
  logBaseline: async (season?: number, week?: number) => { const r = await fetch("/api/projections/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ season, week }) }); return r.json() as Promise<{ logged: number; week: number }>; },
};
