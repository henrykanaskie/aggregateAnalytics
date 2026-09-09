"""The stat catalog: every number the dashboard can chart, in one registry.

A ``Stat`` is a column in the joined per-player game log (see
:mod:`dashboard.stats.gamelog`). Raw columns come straight from nflverse;
derived ones are polars expressions over the joined frame. The frontend gets
this registry as JSON and builds its pickers from it, so adding a stat here is
the whole job.

Columns pulled in from secondary tables are prefixed so nothing collides:
``snap_*`` (snap_counts), ``ngs_rec_*`` / ``ngs_rush_*`` / ``ngs_pass_*``
(Next Gen Stats), ``pfr_*`` (PFR advanced), ``xp_*`` (ff_opportunity expected
values), ``long_*`` (play-by-play longest plays).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import polars as pl


@dataclass(frozen=True)
class Stat:
    key: str
    label: str
    group: str
    fmt: str = "int"          # int | dec1 | dec2 | pct
    since: int = 1999         # first season the source covers
    expr: pl.Expr | None = None   # None => raw column named `key`
    note: str = ""
    positions: tuple[str, ...] = ()   # hint for the picker; empty = all


def _ratio(num: str, den: str) -> pl.Expr:
    return (
        pl.when(pl.col(den) > 0)
        .then(pl.col(num).cast(pl.Float64) / pl.col(den))
        .otherwise(None)
    )


def _sum(*cols: str) -> pl.Expr:
    out = pl.col(cols[0]).fill_null(0)
    for c in cols[1:]:
        out = out + pl.col(c).fill_null(0)
    return out


PASS = ("QB",)
RUSH = ("RB", "QB", "WR", "FB")
REC = ("WR", "TE", "RB", "FB")
DEF = ("LB", "DE", "DT", "CB", "S", "SS", "FS", "OLB", "ILB", "MLB", "NT", "DB", "EDGE")
K = ("K",)

STATS: list[Stat] = [
    # --- Passing ----------------------------------------------------------
    Stat("passing_yards", "Passing yards", "Passing", positions=PASS),
    Stat("passing_tds", "Passing TDs", "Passing", positions=PASS),
    Stat("completions", "Completions", "Passing", positions=PASS),
    Stat("attempts", "Pass attempts", "Passing", positions=PASS),
    Stat("passing_interceptions", "Interceptions thrown", "Passing", positions=PASS),
    Stat("comp_pct", "Completion %", "Passing", "pct", expr=_ratio("completions", "attempts"), positions=PASS),
    Stat("yards_per_attempt", "Yards / attempt", "Passing", "dec1", expr=_ratio("passing_yards", "attempts"), positions=PASS),
    Stat("passing_air_yards", "Passing air yards", "Passing", since=2006, positions=PASS),
    Stat("passing_yards_after_catch", "Passing YAC", "Passing", since=2006, positions=PASS),
    Stat("passing_first_downs", "Passing first downs", "Passing", positions=PASS),
    Stat("sacks_suffered", "Sacks taken", "Passing", positions=PASS),
    Stat("passing_epa", "Passing EPA", "Passing", "dec2", positions=PASS),
    Stat("passing_cpoe", "CPOE", "Passing", "dec1", since=2006, positions=PASS, note="Completion % over expected"),
    Stat("pacr", "PACR", "Passing", "dec2", since=2006, positions=PASS, note="Passing yards / air yards"),
    Stat("passing_20", "20+ yd completions", "Passing", positions=PASS),
    Stat("pass_rush_yards", "Pass + rush yards", "Passing", expr=_sum("passing_yards", "rushing_yards"), positions=PASS),
    Stat("pass_rush_rec_yards", "Pass + rush + rec yards", "Passing", expr=_sum("passing_yards", "rushing_yards", "receiving_yards")),
    Stat("pass_rush_rec_tds", "Pass + rush + rec TDs", "Passing", expr=_sum("passing_tds", "rushing_tds", "receiving_tds")),
    Stat("long_completion", "Longest completion", "Passing", positions=PASS, note="From play-by-play"),

    # --- Rushing ----------------------------------------------------------
    Stat("rushing_yards", "Rushing yards", "Rushing", positions=RUSH),
    Stat("carries", "Carries", "Rushing", positions=RUSH),
    Stat("rushing_tds", "Rushing TDs", "Rushing", positions=RUSH),
    Stat("yards_per_carry", "Yards / carry", "Rushing", "dec1", expr=_ratio("rushing_yards", "carries"), positions=RUSH),
    Stat("rushing_first_downs", "Rushing first downs", "Rushing", positions=RUSH),
    Stat("rushing_epa", "Rushing EPA", "Rushing", "dec2", positions=RUSH),
    Stat("rushing_fumbles_lost", "Rushing fumbles lost", "Rushing", positions=RUSH),
    Stat("rushing_10", "10+ yd rushes", "Rushing", positions=RUSH),
    Stat("rushing_20", "20+ yd rushes", "Rushing", positions=RUSH),
    Stat("long_rush", "Longest rush", "Rushing", positions=RUSH, note="From play-by-play"),

    # --- Receiving --------------------------------------------------------
    Stat("receiving_yards", "Receiving yards", "Receiving", positions=REC),
    Stat("receptions", "Receptions", "Receiving", positions=REC),
    Stat("targets", "Targets", "Receiving", positions=REC),
    Stat("receiving_tds", "Receiving TDs", "Receiving", positions=REC),
    Stat("catch_rate", "Catch rate", "Receiving", "pct", expr=_ratio("receptions", "targets"), positions=REC),
    Stat("yards_per_target", "Yards / target", "Receiving", "dec1", expr=_ratio("receiving_yards", "targets"), positions=REC),
    Stat("yards_per_reception", "Yards / reception", "Receiving", "dec1", expr=_ratio("receiving_yards", "receptions"), positions=REC),
    Stat("adot", "aDOT", "Receiving", "dec1", since=2006, expr=_ratio("receiving_air_yards", "targets"), positions=REC, note="Average depth of target"),
    Stat("receiving_air_yards", "Air yards", "Receiving", since=2006, positions=REC),
    Stat("receiving_yards_after_catch", "YAC", "Receiving", since=2006, positions=REC),
    Stat("receiving_first_downs", "Receiving first downs", "Receiving", positions=REC),
    Stat("receiving_epa", "Receiving EPA", "Receiving", "dec2", positions=REC),
    Stat("racr", "RACR", "Receiving", "dec2", since=2006, positions=REC, note="Receiving yards / air yards"),
    Stat("receiving_20", "20+ yd receptions", "Receiving", positions=REC),
    Stat("long_reception", "Longest reception", "Receiving", positions=REC, note="From play-by-play"),

    # --- Combined ---------------------------------------------------------
    Stat("rush_rec_yards", "Rush + rec yards", "Combined", expr=_sum("rushing_yards", "receiving_yards"), positions=RUSH + REC),
    Stat("rush_rec_tds", "Rush + rec TDs", "Combined", expr=_sum("rushing_tds", "receiving_tds"), positions=RUSH + REC),
    Stat("total_tds", "Total TDs (any)", "Combined",
         expr=_sum("rushing_tds", "receiving_tds", "special_teams_tds", "fumble_recovery_tds", "def_tds"),
         note="Anytime-TD basis: rushing, receiving, return, recovery, defensive"),
    Stat("touches", "Touches", "Combined", expr=_sum("carries", "receptions"), positions=RUSH + REC),
    Stat("opportunities", "Opportunities", "Combined", expr=_sum("carries", "targets"), positions=RUSH + REC, note="Carries + targets"),

    # --- Usage ------------------------------------------------------------
    Stat("target_share", "Target share", "Usage", "pct", since=2006, positions=REC),
    Stat("air_yards_share", "Air yards share", "Usage", "pct", since=2006, positions=REC),
    Stat("wopr", "WOPR", "Usage", "dec2", since=2006, positions=REC, note="1.5 x target share + 0.7 x air yards share"),
    Stat("snap_offense_pct", "Offensive snap %", "Usage", "pct", since=2013),
    Stat("snap_offense", "Offensive snaps", "Usage", since=2013),
    Stat("snap_defense_pct", "Defensive snap %", "Usage", "pct", since=2013, positions=DEF),
    Stat("snap_defense", "Defensive snaps", "Usage", since=2013, positions=DEF),
    Stat("snap_st_pct", "Special teams snap %", "Usage", "pct", since=2013),

    # --- Expected (ff_opportunity) ----------------------------------------
    Stat("xp_rec_yards", "Expected rec yards", "Expected", "dec1", since=2006, positions=REC),
    Stat("xp_rec_yards_diff", "Rec yards over expected", "Expected", "dec1", since=2006, positions=REC),
    Stat("xp_receptions", "Expected receptions", "Expected", "dec1", since=2006, positions=REC),
    Stat("xp_rec_tds", "Expected rec TDs", "Expected", "dec2", since=2006, positions=REC),
    Stat("xp_rush_yards", "Expected rush yards", "Expected", "dec1", since=2006, positions=RUSH),
    Stat("xp_rush_yards_diff", "Rush yards over expected", "Expected", "dec1", since=2006, positions=RUSH),
    Stat("xp_rush_tds", "Expected rush TDs", "Expected", "dec2", since=2006, positions=RUSH),
    Stat("xp_pass_yards", "Expected pass yards", "Expected", "dec1", since=2006, positions=PASS),
    Stat("xp_pass_tds", "Expected pass TDs", "Expected", "dec2", since=2006, positions=PASS),
    Stat("xp_fantasy_points", "Expected fantasy pts", "Expected", "dec1", since=2006),
    Stat("xp_fantasy_points_diff", "Fantasy pts over expected", "Expected", "dec1", since=2006),

    # --- Next Gen Stats ---------------------------------------------------
    Stat("ngs_rec_avg_separation", "Avg separation", "Next Gen", "dec1", since=2016, positions=REC),
    Stat("ngs_rec_avg_cushion", "Avg cushion", "Next Gen", "dec1", since=2016, positions=REC),
    Stat("ngs_rec_avg_intended_air_yards", "Avg intended air yards", "Next Gen", "dec1", since=2016, positions=REC),
    Stat("ngs_rec_share_intended_air_yards", "Share of intended air yards", "Next Gen", "pct", since=2016, positions=REC),
    Stat("ngs_rec_avg_yac", "Avg YAC", "Next Gen", "dec1", since=2016, positions=REC),
    Stat("ngs_rec_avg_expected_yac", "Avg expected YAC", "Next Gen", "dec1", since=2016, positions=REC),
    Stat("ngs_rec_yac_above_expectation", "YAC over expected", "Next Gen", "dec2", since=2016, positions=REC),
    Stat("ngs_rush_efficiency", "Rush efficiency", "Next Gen", "dec2", since=2016, positions=RUSH, note="Yards travelled per rushing yard, lower is more north-south"),
    Stat("ngs_rush_pct_8_defenders", "% vs 8+ in box", "Next Gen", "dec1", since=2016, positions=RUSH),
    Stat("ngs_rush_avg_time_to_los", "Avg time to LOS", "Next Gen", "dec2", since=2016, positions=RUSH),
    Stat("ngs_rush_expected_yards", "Expected rush yards (NGS)", "Next Gen", "dec1", since=2018, positions=RUSH),
    Stat("ngs_rush_ryoe", "RYOE", "Next Gen", "dec1", since=2018, positions=RUSH, note="Rush yards over expected"),
    Stat("ngs_rush_ryoe_per_att", "RYOE / attempt", "Next Gen", "dec2", since=2018, positions=RUSH),
    Stat("ngs_pass_avg_time_to_throw", "Avg time to throw", "Next Gen", "dec2", since=2016, positions=PASS),
    Stat("ngs_pass_avg_completed_air_yards", "Avg completed air yards", "Next Gen", "dec1", since=2016, positions=PASS),
    Stat("ngs_pass_avg_intended_air_yards", "Avg intended air yards", "Next Gen", "dec1", since=2016, positions=PASS),
    Stat("ngs_pass_aggressiveness", "Aggressiveness %", "Next Gen", "dec1", since=2016, positions=PASS),
    Stat("ngs_pass_avg_air_yards_to_sticks", "Air yards to sticks", "Next Gen", "dec1", since=2016, positions=PASS),
    Stat("ngs_pass_cpoe", "CPOE (NGS)", "Next Gen", "dec1", since=2016, positions=PASS),
    Stat("ngs_pass_expected_comp_pct", "Expected completion %", "Next Gen", "dec1", since=2016, positions=PASS),
    Stat("ngs_pass_passer_rating", "Passer rating", "Next Gen", "dec1", since=2016, positions=PASS),

    # --- PFR advanced -----------------------------------------------------
    Stat("pfr_rec_broken_tackles", "Broken tackles (rec)", "PFR", since=2018, positions=REC),
    Stat("pfr_rec_drops", "Drops", "PFR", since=2018, positions=REC),
    Stat("pfr_rec_drop_pct", "Drop %", "PFR", "pct", since=2018, positions=REC),
    Stat("pfr_rec_rating_when_targeted", "Passer rating when targeted", "PFR", "dec1", since=2018, positions=REC),
    Stat("pfr_rush_ybc", "Yards before contact", "PFR", since=2018, positions=RUSH),
    Stat("pfr_rush_ybc_avg", "YBC / carry", "PFR", "dec1", since=2018, positions=RUSH),
    Stat("pfr_rush_yac", "Yards after contact", "PFR", since=2018, positions=RUSH),
    Stat("pfr_rush_yac_avg", "YAC / carry", "PFR", "dec1", since=2018, positions=RUSH),
    Stat("pfr_rush_broken_tackles", "Broken tackles (rush)", "PFR", since=2018, positions=RUSH),
    Stat("pfr_pass_bad_throws", "Bad throws", "PFR", since=2018, positions=PASS),
    Stat("pfr_pass_bad_throw_pct", "Bad throw %", "PFR", "dec1", since=2018, positions=PASS),
    Stat("pfr_pass_times_pressured", "Times pressured", "PFR", since=2018, positions=PASS),
    Stat("pfr_pass_pressure_pct", "Pressure %", "PFR", "pct", since=2018, positions=PASS),
    Stat("pfr_pass_times_blitzed", "Times blitzed", "PFR", since=2018, positions=PASS),
    Stat("pfr_pass_times_hurried", "Times hurried", "PFR", since=2018, positions=PASS),
    Stat("pfr_pass_times_hit", "Times hit", "PFR", since=2018, positions=PASS),
    Stat("pfr_pass_drops", "Drops by receivers", "PFR", since=2018, positions=PASS),

    # --- Defense ----------------------------------------------------------
    Stat("def_tackles_solo", "Solo tackles", "Defense", positions=DEF),
    Stat("def_tackle_assists", "Assisted tackles", "Defense", positions=DEF),
    Stat("tackles_combined", "Tackles + assists", "Defense", expr=_sum("def_tackles_solo", "def_tackle_assists"), positions=DEF),
    Stat("def_tackles_for_loss", "Tackles for loss", "Defense", positions=DEF),
    Stat("def_sacks", "Sacks", "Defense", "dec1", positions=DEF),
    Stat("def_qb_hits", "QB hits", "Defense", positions=DEF),
    Stat("def_interceptions", "Interceptions", "Defense", positions=DEF),
    Stat("def_pass_defended", "Passes defended", "Defense", positions=DEF),
    Stat("def_fumbles_forced", "Forced fumbles", "Defense", positions=DEF),
    Stat("def_tds", "Defensive TDs", "Defense", positions=DEF),

    # --- Kicking ----------------------------------------------------------
    Stat("fg_made", "FG made", "Kicking", positions=K),
    Stat("fg_att", "FG attempts", "Kicking", positions=K),
    Stat("fg_pct", "FG %", "Kicking", "pct", expr=_ratio("fg_made", "fg_att"), positions=K),
    Stat("fg_long", "Longest FG", "Kicking", positions=K),
    Stat("pat_made", "PAT made", "Kicking", positions=K),
    Stat("pat_att", "PAT attempts", "Kicking", positions=K),
    Stat("kicking_points", "Kicking points", "Kicking",
         expr=pl.col("fg_made").fill_null(0) * 3 + pl.col("pat_made").fill_null(0), positions=K),

    # --- Fantasy ----------------------------------------------------------
    Stat("fantasy_points", "Fantasy pts (std)", "Fantasy", "dec1"),
    Stat("fantasy_points_ppr", "Fantasy pts (PPR)", "Fantasy", "dec1"),
]

BY_KEY: dict[str, Stat] = {s.key: s for s in STATS}
GROUPS: list[str] = list(dict.fromkeys(s.group for s in STATS))

#: Raw player_stats_week columns that the catalog reads, directly or via expr.
RAW_STAT_COLUMNS: list[str] = [
    "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions",
    "sacks_suffered", "passing_air_yards", "passing_yards_after_catch", "passing_first_downs",
    "passing_epa", "passing_cpoe", "pacr", "passing_20",
    "carries", "rushing_yards", "rushing_tds", "rushing_first_downs", "rushing_epa",
    "rushing_fumbles_lost", "rushing_10", "rushing_20",
    "targets", "receptions", "receiving_yards", "receiving_tds", "receiving_air_yards",
    "receiving_yards_after_catch", "receiving_first_downs", "receiving_epa", "racr",
    "receiving_20", "target_share", "air_yards_share", "wopr",
    "special_teams_tds", "fumble_recovery_tds", "def_tds",
    "def_tackles_solo", "def_tackle_assists", "def_tackles_for_loss", "def_sacks",
    "def_qb_hits", "def_interceptions", "def_pass_defended", "def_fumbles_forced",
    "fg_made", "fg_att", "fg_long", "pat_made", "pat_att",
    "fantasy_points", "fantasy_points_ppr",
]

#: Non-stat columns every game-log row carries.
CONTEXT_COLUMNS: list[str] = [
    "season", "week", "season_type", "game_type", "game_id", "gameday", "team", "opponent",
    "home", "team_score", "opp_score", "margin", "result", "team_spread", "total_line",
    "total", "implied_team_total", "favorite", "div_game", "roof", "surface", "position",
    "temp", "wind", "indoors", "qb_id", "qb_name",
]


def derived_exprs() -> list[pl.Expr]:
    return [s.expr.alias(s.key) for s in STATS if s.expr is not None]


def catalog_json() -> list[dict]:
    return [
        {
            "key": s.key, "label": s.label, "group": s.group, "fmt": s.fmt,
            "since": s.since, "note": s.note, "positions": list(s.positions),
        }
        for s in STATS
    ]
