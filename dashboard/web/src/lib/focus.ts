/** "Focus mode": which stats matter for this player and this prop.
 *  The sets are deliberately small. Focus is about pulling the eye to the
 *  handful of numbers that move a line, not colouring everything. */

const BY_MARKET: Record<string, string[]> = {
  player_pass_yds: ["passing_yards", "attempts", "completions", "yards_per_attempt", "passing_air_yards", "adot", "passing_cpoe", "pfr_pass_pressure_pct", "sacks_suffered"],
  player_pass_tds: ["passing_tds", "attempts", "passing_yards", "xp_pass_tds", "passing_epa"],
  player_pass_completions: ["completions", "attempts", "comp_pct", "ngs_pass_expected_comp_pct", "passing_cpoe"],
  player_pass_attempts: ["attempts", "completions", "passing_yards", "sacks_suffered"],
  player_pass_interceptions: ["passing_interceptions", "attempts", "pfr_pass_bad_throw_pct", "pfr_pass_pressure_pct"],
  player_pass_longest_completion: ["long_completion", "passing_air_yards", "ngs_pass_avg_intended_air_yards", "passing_20"],
  player_pass_rush_yds: ["pass_rush_yards", "passing_yards", "rushing_yards", "carries", "attempts"],
  player_rush_yds: ["rushing_yards", "carries", "yards_per_carry", "snap_offense_pct", "xp_rush_yards", "ngs_rush_ryoe", "pfr_rush_yac_avg", "rushing_10"],
  player_rush_attempts: ["carries", "rushing_yards", "snap_offense_pct", "touches", "opportunities"],
  player_rush_longest: ["long_rush", "rushing_10", "rushing_20", "carries"],
  player_rush_tds: ["rushing_tds", "carries", "xp_rush_tds", "total_tds"],
  player_reception_yds: ["receiving_yards", "targets", "receptions", "target_share", "adot", "air_yards_share", "yards_per_target", "xp_rec_yards", "snap_offense_pct"],
  player_receptions: ["receptions", "targets", "catch_rate", "target_share", "xp_receptions", "snap_offense_pct", "adot"],
  player_reception_longest: ["long_reception", "adot", "receiving_20", "receiving_air_yards"],
  player_reception_tds: ["receiving_tds", "targets", "xp_rec_tds", "total_tds", "receiving_air_yards"],
  player_rush_reception_yds: ["rush_rec_yards", "rushing_yards", "receiving_yards", "carries", "targets", "touches"],
  player_rush_reception_tds: ["rush_rec_tds", "rushing_tds", "receiving_tds", "xp_rush_tds", "xp_rec_tds"],
  player_anytime_td: ["total_tds", "rushing_tds", "receiving_tds", "xp_rush_tds", "xp_rec_tds", "carries", "targets"],
  player_1st_td: ["total_tds", "xp_rush_tds", "xp_rec_tds"],
  player_last_td: ["total_tds", "xp_rush_tds", "xp_rec_tds"],
  player_kicking_points: ["kicking_points", "fg_made", "fg_att", "pat_made", "pat_att"],
  player_field_goals: ["fg_made", "fg_att", "fg_pct", "fg_long"],
  player_pats: ["pat_made", "pat_att"],
  player_tackles_assists: ["tackles_combined", "def_tackles_solo", "def_tackle_assists", "snap_defense_pct"],
  player_solo_tackles: ["def_tackles_solo", "tackles_combined", "snap_defense_pct"],
  player_assists: ["def_tackle_assists", "tackles_combined", "snap_defense_pct"],
  player_sacks: ["def_sacks", "def_qb_hits", "def_tackles_for_loss", "snap_defense_pct"],
  player_defensive_interceptions: ["def_interceptions", "def_pass_defended", "snap_defense_pct"],
};

const BY_POSITION: Record<string, string[]> = {
  QB: ["passing_yards", "attempts", "completions", "passing_tds", "passing_interceptions", "yards_per_attempt", "rushing_yards", "passing_cpoe", "pfr_pass_pressure_pct"],
  RB: ["carries", "rushing_yards", "yards_per_carry", "targets", "receptions", "receiving_yards", "rush_rec_yards", "snap_offense_pct", "touches"],
  WR: ["targets", "receptions", "receiving_yards", "target_share", "adot", "air_yards_share", "snap_offense_pct", "xp_rec_yards"],
  TE: ["targets", "receptions", "receiving_yards", "target_share", "snap_offense_pct", "xp_rec_yards", "catch_rate"],
  K: ["fg_made", "fg_att", "pat_made", "kicking_points"],
  DEF: ["def_tackles_solo", "def_tackle_assists", "tackles_combined", "def_sacks", "snap_defense_pct"],
};

export function importantStats(market: string | null, statKey: string, position: string | null): string[] {
  const base = (market && BY_MARKET[market]) || BY_POSITION[position ?? ""] || BY_POSITION[["LB", "DE", "DT", "CB", "S", "SS", "FS", "OLB", "ILB", "MLB", "NT", "DB"].includes(position ?? "") ? "DEF" : "WR"];
  return [...new Set([statKey, ...base])];
}

/** Team-tendency rows worth reading for this position (offense side, then defense side). */
export const TEAM_FOCUS: Record<string, { off: string[]; def: string[] }> = {
  QB: { off: ["pass_rate", "proe", "neutral_pass_rate", "plays_pg", "sec_per_play", "pa_rate", "deep_rate", "sack_rate_taken", "int_rate"], def: ["def_pass_epa", "def_pressure_rate", "def_blitz_rate", "def_man_rate", "def_two_high_rate", "def_sack_rate", "def_int_rate", "def_explosive_rate"] },
  RB: { off: ["pass_rate", "rb_target_share", "lead_rb_share", "rb_touch_pg", "plays_pg", "rz_pass_rate", "gtg_rush_rate", "rz_rb_target_share"], def: ["def_rush_epa", "def_box_avg", "def_rb_target_share", "def_success_rate", "def_rz_td_rate", "def_two_high_rate"] },
  WR: { off: ["pass_rate", "proe", "wr_target_share", "deep_rate", "adot", "plays_pg", "pa_rate", "rz_wr_target_share"], def: ["def_pass_epa", "def_man_rate", "def_cover1_rate", "def_two_high_rate", "def_deep_rate_faced", "def_explosive_rate", "def_pressure_rate"] },
  TE: { off: ["pass_rate", "te_target_share", "rz_te_target_share", "p12_rate", "plays_pg"], def: ["def_te_target_share", "def_pass_epa", "def_two_high_rate", "def_man_rate", "def_rz_td_rate"] },
  K: { off: ["fga_pg", "rz_td_rate", "rz_trips_pg", "third_down_conv"], def: ["def_fga_pg", "def_rz_td_rate", "def_third_down_conv"] },
  DEF: { off: ["pass_rate", "plays_pg", "sec_per_play", "rb_carry_share"], def: ["def_pass_rate_faced", "def_success_rate"] },
};
export const teamFocus = (position: string | null) => TEAM_FOCUS[position ?? ""] ?? (["LB", "DE", "DT", "CB", "S", "SS", "FS", "OLB", "ILB", "MLB", "NT", "DB"].includes(position ?? "") ? TEAM_FOCUS.DEF : TEAM_FOCUS.WR);
