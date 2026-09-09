"""One row per game for one player, with every catalog stat attached.

The base is ``player_stats_week``. Everything else is a left join keyed on
whichever id the source table uses:

    schedules       game_id                     opponent, score, spread, total
    snap_counts     pfr_player_id + game_id     snap shares (2013+)
    pfr_rec/rush/pass  pfr_player_id + game_id  drops, contact yards, pressure (2018+)
    ngs_*           player_gsis_id + season + week + season_type   (2016+)
    ff_opportunity  player_id + game_id         expected yards / TDs / points (2006+)
    pbp             receiver/rusher/passer id   longest play per game

Every join is optional: a missing or empty table leaves its columns null
rather than failing, so a partial cache still produces a usable log.
"""

from __future__ import annotations

from functools import lru_cache

import polars as pl

from nfl.data import RAW_DIR, scan

from .catalog import CONTEXT_COLUMNS, RAW_STAT_COLUMNS, STATS, derived_exprs

_BASE_COLS = ["player_id", "season", "week", "season_type", "game_id", "team",
              "opponent_team", "position"] + RAW_STAT_COLUMNS

_SCHED_COLS = ["game_id", "gameday", "game_type", "home_team", "away_team", "home_score",
               "away_score", "spread_line", "total_line", "total", "div_game", "roof", "surface",
               "temp", "wind", "home_qb_id", "away_qb_id", "home_qb_name", "away_qb_name"]


@lru_cache(maxsize=1)
def players_master() -> pl.DataFrame:
    return pl.read_parquet(RAW_DIR / "players.parquet")


def _player_ids(player_id: str) -> dict:
    row = players_master().filter(pl.col("gsis_id") == player_id)
    if row.is_empty():
        return {"pfr_id": None, "name": None, "espn_id": None}
    r = row.row(0, named=True)
    return {"pfr_id": r.get("pfr_id"), "name": r.get("display_name"), "espn_id": r.get("espn_id")}


def _safe(name: str) -> pl.LazyFrame | None:
    try:
        return scan(name)
    except FileNotFoundError:
        return None


def _rename(lf: pl.LazyFrame, mapping: dict[str, str], key: str = "game_id") -> pl.LazyFrame:
    have = lf.collect_schema().names()
    cols = [pl.col(k).alias(v) for k, v in mapping.items() if k in have]
    return lf.select(pl.col(key), *cols).unique(subset=[key], keep="first")


def _snaps(pfr_id: str | None, name: str | None) -> pl.LazyFrame | None:
    lf = _safe("snap_counts")
    if lf is None:
        return None
    if pfr_id:
        lf = lf.filter(pl.col("pfr_player_id") == pfr_id)
    elif name:
        lf = lf.filter(pl.col("player") == name)
    else:
        return None
    return _rename(lf, {
        "offense_snaps": "snap_offense", "offense_pct": "snap_offense_pct",
        "defense_snaps": "snap_defense", "defense_pct": "snap_defense_pct",
        "st_snaps": "snap_st", "st_pct": "snap_st_pct",
    })


def _pfr(table: str, pfr_id: str | None, mapping: dict[str, str]) -> pl.LazyFrame | None:
    lf = _safe(table)
    if lf is None or not pfr_id:
        return None
    return _rename(lf.filter(pl.col("pfr_player_id") == pfr_id), mapping)


def _ngs(table: str, player_id: str, mapping: dict[str, str]) -> pl.LazyFrame | None:
    lf = _safe(table)
    if lf is None:
        return None
    lf = lf.filter((pl.col("player_gsis_id") == player_id) & (pl.col("week") > 0))
    have = lf.collect_schema().names()
    cols = [pl.col(k).alias(v) for k, v in mapping.items() if k in have]
    return (
        lf.select("season", "week", "season_type", *cols)
        .unique(subset=["season", "week", "season_type"], keep="first")
    )


def _xp(player_id: str) -> pl.LazyFrame | None:
    lf = _safe("ff_opportunity")
    if lf is None:
        return None
    return _rename(lf.filter(pl.col("player_id") == player_id), {
        "rec_yards_gained_exp": "xp_rec_yards", "rec_yards_gained_diff": "xp_rec_yards_diff",
        "receptions_exp": "xp_receptions", "rec_touchdown_exp": "xp_rec_tds",
        "rush_yards_gained_exp": "xp_rush_yards", "rush_yards_gained_diff": "xp_rush_yards_diff",
        "rush_touchdown_exp": "xp_rush_tds", "pass_yards_gained_exp": "xp_pass_yards",
        "pass_touchdown_exp": "xp_pass_tds", "total_fantasy_points_exp": "xp_fantasy_points",
        "total_fantasy_points_diff": "xp_fantasy_points_diff",
    })


def _longest(player_id: str) -> pl.LazyFrame | None:
    pbp = _safe("pbp")
    if pbp is None:
        return None
    pbp = pbp.select("game_id", "receiver_player_id", "rusher_player_id", "passer_player_id",
                     "receiving_yards", "rushing_yards", "passing_yards", "complete_pass")
    rec = (pbp.filter((pl.col("receiver_player_id") == player_id) & (pl.col("complete_pass") == 1))
           .group_by("game_id").agg(pl.col("receiving_yards").max().alias("long_reception")))
    rush = (pbp.filter(pl.col("rusher_player_id") == player_id)
            .group_by("game_id").agg(pl.col("rushing_yards").max().alias("long_rush")))
    pas = (pbp.filter((pl.col("passer_player_id") == player_id) & (pl.col("complete_pass") == 1))
           .group_by("game_id").agg(pl.col("passing_yards").max().alias("long_completion")))
    return rec.join(rush, on="game_id", how="full", coalesce=True).join(pas, on="game_id", how="full", coalesce=True)


def _with_context(lf: pl.LazyFrame) -> pl.LazyFrame:
    sched = scan("schedules").select(_SCHED_COLS)
    sched_schema = sched.collect_schema()
    if sched_schema["gameday"] != pl.String:
        sched = sched.with_columns(pl.col("gameday").cast(pl.String))
    home = pl.col("team") == pl.col("home_team")
    exp_margin = pl.when(home).then(pl.col("spread_line")).otherwise(-pl.col("spread_line"))
    return (
        lf.join(sched, on="game_id", how="left")
        .with_columns(home=home)
        .with_columns(
            team_score=pl.when(home).then(pl.col("home_score")).otherwise(pl.col("away_score")),
            opp_score=pl.when(home).then(pl.col("away_score")).otherwise(pl.col("home_score")),
            exp_margin=exp_margin,
            opponent=pl.coalesce(
                pl.col("opponent_team"),
                pl.when(home).then(pl.col("away_team")).otherwise(pl.col("home_team")),
            ),
            # The player's own team's starting QB that day, so a receiver's
            # log can be split by who was throwing to him.
            qb_id=pl.when(home).then(pl.col("home_qb_id")).otherwise(pl.col("away_qb_id")),
            qb_name=pl.when(home).then(pl.col("home_qb_name")).otherwise(pl.col("away_qb_name")),
            # Weather is only recorded for outdoor games; a dome is a dome.
            indoors=pl.col("roof").is_in(["dome", "closed"]),
        )
        .with_columns(
            margin=pl.col("team_score") - pl.col("opp_score"),
            team_spread=-pl.col("exp_margin"),
            favorite=pl.col("exp_margin") > 0,
            implied_team_total=(pl.col("total_line") + pl.col("exp_margin")) / 2,
        )
        .with_columns(
            result=pl.when(pl.col("margin") > 0).then(pl.lit("W"))
            .when(pl.col("margin") < 0).then(pl.lit("L"))
            .when(pl.col("margin") == 0).then(pl.lit("T"))
            .otherwise(None)
        )
    )


@lru_cache(maxsize=512)
def game_log(player_id: str) -> pl.DataFrame:
    ids = _player_ids(player_id)
    pfr_id, name = ids["pfr_id"], ids["name"]

    lf = (
        scan("player_stats_week")
        .filter(pl.col("player_id") == player_id)
        .select(_BASE_COLS)
    )
    lf = _with_context(lf)

    game_joins = [
        _snaps(pfr_id, name),
        _pfr("pfr_rec", pfr_id, {
            "receiving_broken_tackles": "pfr_rec_broken_tackles", "receiving_drop": "pfr_rec_drops",
            "receiving_drop_pct": "pfr_rec_drop_pct", "receiving_rat": "pfr_rec_rating_when_targeted",
        }),
        _pfr("pfr_rush", pfr_id, {
            "rushing_yards_before_contact": "pfr_rush_ybc", "rushing_yards_before_contact_avg": "pfr_rush_ybc_avg",
            "rushing_yards_after_contact": "pfr_rush_yac", "rushing_yards_after_contact_avg": "pfr_rush_yac_avg",
            "rushing_broken_tackles": "pfr_rush_broken_tackles",
        }),
        _pfr("pfr_pass", pfr_id, {
            "passing_bad_throws": "pfr_pass_bad_throws", "passing_bad_throw_pct": "pfr_pass_bad_throw_pct",
            "times_pressured": "pfr_pass_times_pressured", "times_pressured_pct": "pfr_pass_pressure_pct",
            "times_blitzed": "pfr_pass_times_blitzed", "times_hurried": "pfr_pass_times_hurried",
            "times_hit": "pfr_pass_times_hit", "passing_drops": "pfr_pass_drops",
        }),
        _xp(player_id),
        _longest(player_id),
    ]
    for j in game_joins:
        if j is not None:
            lf = lf.join(j, on="game_id", how="left")

    week_joins = [
        _ngs("ngs_receiving", player_id, {
            "avg_separation": "ngs_rec_avg_separation", "avg_cushion": "ngs_rec_avg_cushion",
            "avg_intended_air_yards": "ngs_rec_avg_intended_air_yards",
            "percent_share_of_intended_air_yards": "ngs_rec_share_intended_air_yards",
            "avg_yac": "ngs_rec_avg_yac", "avg_expected_yac": "ngs_rec_avg_expected_yac",
            "avg_yac_above_expectation": "ngs_rec_yac_above_expectation",
        }),
        _ngs("ngs_rushing", player_id, {
            "efficiency": "ngs_rush_efficiency",
            "percent_attempts_gte_eight_defenders": "ngs_rush_pct_8_defenders",
            "avg_time_to_los": "ngs_rush_avg_time_to_los", "expected_rush_yards": "ngs_rush_expected_yards",
            "rush_yards_over_expected": "ngs_rush_ryoe",
            "rush_yards_over_expected_per_att": "ngs_rush_ryoe_per_att",
        }),
        _ngs("ngs_passing", player_id, {
            "avg_time_to_throw": "ngs_pass_avg_time_to_throw",
            "avg_completed_air_yards": "ngs_pass_avg_completed_air_yards",
            "avg_intended_air_yards": "ngs_pass_avg_intended_air_yards",
            "aggressiveness": "ngs_pass_aggressiveness",
            "avg_air_yards_to_sticks": "ngs_pass_avg_air_yards_to_sticks",
            "completion_percentage_above_expectation": "ngs_pass_cpoe",
            "expected_completion_percentage": "ngs_pass_expected_comp_pct",
            "passer_rating": "ngs_pass_passer_rating",
        }),
    ]
    for j in week_joins:
        if j is not None:
            lf = lf.join(j, on=["season", "week", "season_type"], how="left")

    df = lf.collect()

    # NGS reports its share as 0-100; the catalog formats pct as a fraction.
    if "ngs_rec_share_intended_air_yards" in df.columns:
        df = df.with_columns(pl.col("ngs_rec_share_intended_air_yards") / 100)

    # Guarantee every catalog key exists so the frontend never special-cases.
    missing = [s.key for s in STATS if s.key not in df.columns and s.expr is None]
    if missing:
        df = df.with_columns([pl.lit(None, dtype=pl.Float64).alias(k) for k in missing])
    df = df.with_columns(derived_exprs())

    keys = [s.key for s in STATS]
    return (
        df.select(CONTEXT_COLUMNS + keys)
        .sort(["season", "week"])
    )


def availability(df: pl.DataFrame) -> dict[str, int]:
    """Count of games with a non-null, non-zero value per catalog stat, so the
    picker can hide what a player has no data for (kicking stats on a WR,
    snap counts before 2013)."""
    keys = [s.key for s in STATS]
    counts = df.select([
        (pl.col(k).is_not_null() & (pl.col(k) != 0)).sum().alias(k) for k in keys
    ]).row(0, named=True)
    return {k: int(v) for k, v in counts.items()}


def recent_values(player_ids: list[str], stat_keys: list[str], seasons: list[int]) -> dict[str, dict[str, list]]:
    """Batch version for the odds board: ``{player_id: {stat: [values...]}}``
    ordered oldest to newest, regular season and playoffs alike. Only stats
    derivable from ``player_stats_week`` are supported; anything else comes
    back as an empty list."""
    base_keys = {s.key for s in STATS if s.expr is None and s.key in RAW_STAT_COLUMNS}
    derived = {s.key: s.expr for s in STATS if s.expr is not None}
    wanted = [k for k in stat_keys if k in base_keys or k in derived]
    if not wanted or not player_ids:
        return {}
    lf = (
        scan("player_stats_week")
        .filter(pl.col("season").is_in(seasons) & pl.col("player_id").is_in(player_ids))
        .select(["player_id", "season", "week"] + RAW_STAT_COLUMNS)
        .with_columns([derived[k].alias(k) for k in wanted if k in derived])
        .sort(["season", "week"])
        .group_by("player_id", maintain_order=True)
        .agg([pl.col(k).alias(k) for k in wanted]
             + [pl.col("season").alias("_season"), pl.col("week").alias("_week")])
    )
    out: dict[str, dict[str, list]] = {}
    for row in lf.collect().to_dicts():
        pid = row.pop("player_id")
        out[pid] = {k: [None if (v is None or v != v) else v for v in row[k]] for k in wanted}
        out[pid]["_season"] = row["_season"]
        out[pid]["_week"] = row["_week"]
    return out


def recent_longest(player_ids: list[str], seasons: list[int]) -> dict[str, dict[str, list]]:
    """Batch longest-play values (from play-by-play) for the board's form
    columns: ``{player_id: {"long_reception": [...], "long_rush": [...],
    "long_completion": [...]}}`` ordered oldest to newest. One scan."""
    if not player_ids:
        return {}
    pbp = (
        scan("pbp")
        .filter(pl.col("season").is_in(seasons))
        .select("game_id", "season", "week", "receiver_player_id", "rusher_player_id", "passer_player_id",
                "receiving_yards", "rushing_yards", "passing_yards", "complete_pass")
    )
    ids = pl.Series(player_ids)
    parts = {
        "long_reception": pbp.filter(pl.col("receiver_player_id").is_in(ids) & (pl.col("complete_pass") == 1))
        .group_by(["receiver_player_id", "game_id", "season", "week"]).agg(pl.col("receiving_yards").max().alias("v"))
        .rename({"receiver_player_id": "player_id"}),
        "long_rush": pbp.filter(pl.col("rusher_player_id").is_in(ids))
        .group_by(["rusher_player_id", "game_id", "season", "week"]).agg(pl.col("rushing_yards").max().alias("v"))
        .rename({"rusher_player_id": "player_id"}),
        "long_completion": pbp.filter(pl.col("passer_player_id").is_in(ids) & (pl.col("complete_pass") == 1))
        .group_by(["passer_player_id", "game_id", "season", "week"]).agg(pl.col("passing_yards").max().alias("v"))
        .rename({"passer_player_id": "player_id"}),
    }
    out: dict[str, dict[str, list]] = {}
    for key, lf in parts.items():
        df = lf.sort(["season", "week"]).group_by("player_id", maintain_order=True).agg(pl.col("v")).collect()
        for r in df.to_dicts():
            out.setdefault(r["player_id"], {})[key] = r["v"]
    return out
