import type { GameRow } from "../api";

export interface Filters {
  n: number | null;                    // last N games (null = all)
  seasons: number[] | null;            // null = all loaded
  seasonType: "ALL" | "REG" | "POST";
  venue: "ALL" | "HOME" | "AWAY";
  opponent: string | null;
  role: "ALL" | "FAV" | "DOG";
  minSnapPct: number | null;
  weather: "ALL" | "INDOORS" | "OUTDOORS" | "COLD" | "WINDY";
  qb: string | null;                  // starting QB name (for non-QBs)
}
export const DEFAULT_FILTERS: Filters = { n: 10, seasons: null, seasonType: "ALL", venue: "ALL", opponent: null, role: "ALL", minSnapPct: null, weather: "ALL", qb: null };
export const isCold = (r: GameRow) => r.indoors === false && typeof r.temp === "number" && r.temp <= 40;
export const isWindy = (r: GameRow) => r.indoors === false && typeof r.wind === "number" && r.wind >= 15;

export function applyFilters(rows: GameRow[], f: Filters, ignoreN = false): GameRow[] {
  let out = rows;
  if (f.seasons && f.seasons.length) out = out.filter((r) => f.seasons!.includes(r.season));
  if (f.seasonType !== "ALL") out = out.filter((r) => r.season_type === f.seasonType);
  if (f.venue !== "ALL") out = out.filter((r) => (f.venue === "HOME" ? r.home : !r.home));
  if (f.opponent) out = out.filter((r) => r.opponent === f.opponent);
  if (f.role !== "ALL") out = out.filter((r) => r.favorite !== null && (f.role === "FAV" ? r.favorite : !r.favorite));
  if (f.minSnapPct !== null) out = out.filter((r) => typeof r.snap_offense_pct === "number" && (r.snap_offense_pct as number) >= f.minSnapPct!);
  if (f.weather === "INDOORS") out = out.filter((r) => r.indoors === true);
  else if (f.weather === "OUTDOORS") out = out.filter((r) => r.indoors === false);
  else if (f.weather === "COLD") out = out.filter(isCold);
  else if (f.weather === "WINDY") out = out.filter(isWindy);
  if (f.qb) out = out.filter((r) => r.qb_name === f.qb);
  if (!ignoreN && f.n) out = out.slice(-f.n);
  return out;
}

export const val = (r: GameRow, key: string): number | null => {
  const v = r[key];
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
};

export interface Summary {
  n: number; over: number; under: number; push: number; rate: number | null; avg: number | null; median: number | null;
  min: number | null; max: number | null; std: number | null; streak: { side: "over" | "under"; n: number } | null;
}
export function summarize(rows: GameRow[], key: string, line: number | null): Summary {
  const vals = rows.map((r) => val(r, key)).filter((v): v is number => v !== null);
  const n = vals.length;
  const s: Summary = { n, over: 0, under: 0, push: 0, rate: null, avg: null, median: null, min: null, max: null, std: null, streak: null };
  if (!n) return s;
  const sorted = [...vals].sort((a, b) => a - b);
  s.avg = vals.reduce((a, b) => a + b, 0) / n;
  s.median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  s.min = sorted[0]; s.max = sorted[n - 1];
  s.std = Math.sqrt(vals.reduce((a, v) => a + (v - s.avg!) ** 2, 0) / n);
  if (line !== null) {
    for (const v of vals) { if (v > line) s.over++; else if (v < line) s.under++; else s.push++; }
    const dec = n - s.push;
    s.rate = dec ? s.over / dec : null;
    let side: "over" | "under" | null = null, k = 0;
    for (let i = vals.length - 1; i >= 0; i--) {
      const v = vals[i]; const sd = v > line ? "over" : v < line ? "under" : null;
      if (sd === null) break;
      if (side === null) side = sd;
      if (sd !== side) break;
      k++;
    }
    s.streak = side && k ? { side, n: k } : null;
  }
  return s;
}

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Suggest a "line" for a stat with no market: median of the last 10, snapped to .5. */
export function suggestLine(rows: GameRow[], key: string): number | null {
  const vals = rows.slice(-10).map((r) => val(r, key)).filter((v): v is number => v !== null);
  const m = median(vals);
  if (m === null) return null;
  const snapped = Math.round(m) - 0.5;
  return snapped < 0 ? 0.5 : snapped;
}

export function rolling(rows: GameRow[], key: string, w: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < rows.length; i++) {
    const win = rows.slice(Math.max(0, i - w + 1), i + 1).map((r) => val(r, key)).filter((v): v is number => v !== null);
    out.push(win.length ? win.reduce((a, b) => a + b, 0) / win.length : null);
  }
  return out;
}

export interface Split { label: string; rows: GameRow[]; }
export function splits(rows: GameRow[], position?: string | null): Split[] {
  const by = (pred: (r: GameRow) => boolean) => rows.filter(pred);
  const out: Split[] = [
    { label: "All", rows },
    { label: "Home", rows: by((r) => r.home) },
    { label: "Away", rows: by((r) => !r.home) },
    { label: "Favorite", rows: by((r) => r.favorite === true) },
    { label: "Underdog", rows: by((r) => r.favorite === false) },
    { label: "Division game", rows: by((r) => r.div_game === 1 || r.div_game === true) },
    { label: "Regular season", rows: by((r) => r.season_type === "REG") },
    { label: "Playoffs", rows: by((r) => r.season_type === "POST") },
    { label: "Total ≥ 47", rows: by((r) => typeof r.total_line === "number" && r.total_line >= 47) },
    { label: "Total < 47", rows: by((r) => typeof r.total_line === "number" && r.total_line < 47) },
    { label: "Won", rows: by((r) => r.result === "W") },
    { label: "Lost", rows: by((r) => r.result === "L") },
    { label: "Indoors", rows: by((r) => r.indoors === true) },
    { label: "Outdoors", rows: by((r) => r.indoors === false) },
    { label: "Cold (≤40°F)", rows: by(isCold) },
    { label: "Freezing (≤32°F)", rows: by((r) => r.indoors === false && typeof r.temp === "number" && r.temp <= 32) },
    { label: "Windy (15+ mph)", rows: by(isWindy) },
  ];
  if (position !== "QB") {
    const qbs = new Map<string, number>();
    for (const r of rows) if (r.qb_name) qbs.set(r.qb_name, (qbs.get(r.qb_name) ?? 0) + 1);
    if (qbs.size > 1) for (const [qb] of [...qbs].sort((a, b) => b[1] - a[1])) out.push({ label: `with ${qb}`, rows: rows.filter((r) => r.qb_name === qb) });
  }
  const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => b - a);
  for (const s of seasons) out.push({ label: String(s), rows: rows.filter((r) => r.season === s) });
  return out.filter((s) => s.rows.length > 0);
}

export const POSITION_PRESETS: Record<string, string[]> = {
  QB: ["attempts", "completions", "passing_yards", "passing_tds", "passing_interceptions", "yards_per_attempt", "passing_cpoe", "rushing_yards", "ngs_pass_avg_time_to_throw", "pfr_pass_pressure_pct"],
  RB: ["carries", "rushing_yards", "yards_per_carry", "targets", "receptions", "receiving_yards", "rush_rec_yards", "snap_offense_pct", "ngs_rush_ryoe", "xp_rush_yards"],
  WR: ["targets", "receptions", "receiving_yards", "receiving_tds", "target_share", "adot", "air_yards_share", "snap_offense_pct", "xp_rec_yards", "ngs_rec_avg_separation"],
  TE: ["targets", "receptions", "receiving_yards", "receiving_tds", "target_share", "snap_offense_pct", "xp_rec_yards", "catch_rate"],
  K: ["fg_made", "fg_att", "pat_made", "kicking_points", "fg_long"],
  DEF: ["def_tackles_solo", "def_tackle_assists", "tackles_combined", "def_sacks", "def_qb_hits", "def_pass_defended", "snap_defense_pct"],
};
export const presetFor = (pos: string | null | undefined): string[] => {
  if (!pos) return POSITION_PRESETS.WR;
  if (POSITION_PRESETS[pos]) return POSITION_PRESETS[pos];
  if (["LB", "DE", "DT", "CB", "S", "SS", "FS", "OLB", "ILB", "MLB", "NT", "DB", "EDGE"].includes(pos)) return POSITION_PRESETS.DEF;
  if (pos === "FB") return POSITION_PRESETS.RB;
  return POSITION_PRESETS.WR;
};
export const DEFAULT_MARKET_FOR: Record<string, string> = { QB: "player_pass_yds", RB: "player_rush_yds", WR: "player_reception_yds", TE: "player_reception_yds", K: "player_kicking_points", DEF: "player_tackles_assists" };
