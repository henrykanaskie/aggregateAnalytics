"""Matchup context that is not about one player: defense vs position, team
usage trees, injury reports.

All three come from the weekly box-score table, which means they work for
every season since 1999 (injuries since 2009) and cost one grouped scan.
"""

from __future__ import annotations

from functools import lru_cache

import polars as pl

from nfl.data import scan

POS_GROUPS: dict[str, list[str]] = {"QB": ["QB"], "RB": ["RB", "FB", "HB"], "WR": ["WR"], "TE": ["TE"]}
_POS_EXPR = (
    pl.when(pl.col("position").is_in(POS_GROUPS["RB"])).then(pl.lit("RB"))
    .when(pl.col("position").is_in(["QB", "WR", "TE"])).then(pl.col("position"))
    .otherwise(None)
)

DVP_STATS = ["targets", "receptions", "receiving_yards", "receiving_tds", "carries", "rushing_yards",
             "rushing_tds", "passing_yards", "passing_tds", "passing_interceptions", "fantasy_points_ppr"]
DVP_LABELS = {"targets": "Targets", "receptions": "Rec", "receiving_yards": "Rec yds", "receiving_tds": "Rec TD",
              "carries": "Carries", "rushing_yards": "Rush yds", "rushing_tds": "Rush TD", "passing_yards": "Pass yds",
              "passing_tds": "Pass TD", "passing_interceptions": "INT", "fantasy_points_ppr": "PPR pts"}
DVP_BY_POS = {
    "QB": ["passing_yards", "passing_tds", "passing_interceptions", "rushing_yards", "fantasy_points_ppr"],
    "RB": ["carries", "rushing_yards", "rushing_tds", "targets", "receptions", "receiving_yards", "fantasy_points_ppr"],
    "WR": ["targets", "receptions", "receiving_yards", "receiving_tds", "fantasy_points_ppr"],
    "TE": ["targets", "receptions", "receiving_yards", "receiving_tds", "fantasy_points_ppr"],
}


@lru_cache(maxsize=1)
def dvp_games() -> pl.DataFrame:
    """Per (game, defense, position group): totals allowed."""
    return (
        scan("player_stats_week")
        .with_columns(pos=_POS_EXPR)
        .filter(pl.col("pos").is_not_null() & pl.col("opponent_team").is_not_null())
        .group_by(["season", "week", "season_type", "game_id", "opponent_team", "pos"])
        .agg([pl.col(c).sum() for c in DVP_STATS])
        .rename({"opponent_team": "defense"})
        .sort(["season", "week"])
        .collect()
    )


def dvp_table(season: int, position: str, season_type: str = "REG") -> pl.DataFrame:
    """League table: per-game averages allowed to a position, with ranks
    (1 = most allowed, the matchup a bettor wants)."""
    g = dvp_games().filter((pl.col("season") == season) & (pl.col("pos") == position))
    if season_type in ("REG", "POST"):
        g = g.filter(pl.col("season_type") == season_type)
    t = g.group_by("defense").agg([pl.len().alias("games")] + [pl.col(c).mean().alias(c) for c in DVP_STATS])
    return t.with_columns([pl.col(c).rank(method="min", descending=True).alias(f"{c}_rank") for c in DVP_STATS]
                          + [pl.len().alias("n_teams")]).sort("defense")


def dvp_recent(defense: str, position: str, n: int = 4) -> dict | None:
    g = dvp_games().filter((pl.col("defense") == defense) & (pl.col("pos") == position)).tail(n)
    if g.is_empty():
        return None
    return {**{c: float(g[c].mean()) for c in DVP_STATS}, "games": g.height}


def dvp_log(defense: str, position: str, season: int) -> pl.DataFrame:
    """What every player of that position did against this defense."""
    return (
        scan("player_stats_week")
        .with_columns(pos=_POS_EXPR)
        .filter((pl.col("opponent_team") == defense) & (pl.col("pos") == position) & (pl.col("season") == season))
        .select(["season", "week", "season_type", "game_id", "player_id", "player_display_name", "team"] + DVP_STATS)
        .filter((pl.col("targets").fill_null(0) + pl.col("carries").fill_null(0) + pl.col("passing_yards").fill_null(0).abs()) > 0)
        .sort(["week", "fantasy_points_ppr"], descending=[False, True])
        .collect()
    )


# --- usage trees ------------------------------------------------------------

USAGE_COLS = ["targets", "receptions", "receiving_yards", "receiving_tds", "carries", "rushing_yards", "rushing_tds",
              "attempts", "passing_yards", "passing_tds", "fantasy_points_ppr"]


@lru_cache(maxsize=4)
def league_usage(season: int, season_type: str = "REG") -> pl.DataFrame:
    """Every player in a season with shares of their own team's targets,
    carries and air yards.

    League-wide in one pass because the shares are only meaningful against the
    team the touches came from, and a player who moved in the off-season has to
    be read against the team he played for, not the one he is on now. A player
    traded mid-season gets one row per team.
    """
    lf = scan("player_stats_week").filter(pl.col("season") == season)
    if season_type in ("REG", "POST"):
        lf = lf.filter(pl.col("season_type") == season_type)
    df = lf.select(["player_id", "player_display_name", "position", "team", "week", "receiving_air_yards"] + USAGE_COLS).collect()
    if df.is_empty():
        return df
    totals = df.group_by("team").agg(
        pl.col("week").n_unique().alias("team_games"),
        pl.col("targets").sum().alias("_t"),
        pl.col("carries").sum().alias("_c"),
        pl.col("receiving_air_yards").sum().alias("_ay"),
    )
    return (
        df.group_by(["player_id", "player_display_name", "position", "team"])
        .agg([pl.len().alias("games")] + [pl.col(c).sum() for c in USAGE_COLS] + [pl.col("receiving_air_yards").sum()])
        .join(totals, on="team", how="left")
        .with_columns(
            target_share=pl.col("targets") / pl.max_horizontal(pl.col("_t"), pl.lit(1)),
            carry_share=pl.col("carries") / pl.max_horizontal(pl.col("_c"), pl.lit(1)),
            air_share=pl.col("receiving_air_yards") / pl.max_horizontal(pl.col("_ay"), pl.lit(1)),
            targets_pg=pl.col("targets") / pl.col("games"), carries_pg=pl.col("carries") / pl.col("games"),
            ppr_pg=pl.col("fantasy_points_ppr") / pl.col("games"),
            touches_pg=(pl.col("carries") + pl.col("receptions")) / pl.col("games"),
        )
        .drop("_t", "_c", "_ay")
        .filter((pl.col("targets") + pl.col("carries") + pl.col("attempts")) > 0)
        .sort("fantasy_points_ppr", descending=True)
    )


def team_usage(team: str, season: int, season_type: str = "REG") -> pl.DataFrame:
    """Every player on a team-season with shares of targets, carries and
    air yards, so 'who gets the touches' is one table."""
    return league_usage(season, season_type).filter(pl.col("team") == team)


def coach_usage(team_seasons: list[tuple[str, int]]) -> list[dict]:
    """For each (team, season) a coach had: the top RB / WR / TE and their
    shares, so a coach's distribution habits read as a table."""
    rows = []
    for team, season in team_seasons:
        u = team_usage(team, season)
        if u.is_empty():
            continue
        r: dict = {"team": team, "season": season, "team_games": int(u["team_games"][0])}
        for pos, key in (("RB", "rb1"), ("WR", "wr1"), ("TE", "te1")):
            sub = u.filter(pl.col("position") == pos)
            if pos == "RB":
                sub = sub.sort("carries", descending=True)
            else:
                sub = sub.sort("targets", descending=True)
            if sub.is_empty():
                continue
            top = sub.row(0, named=True)
            r[key] = {"name": top["player_display_name"], "player_id": top["player_id"], "games": top["games"],
                      "target_share": top["target_share"], "carry_share": top["carry_share"],
                      "targets_pg": top["targets_pg"], "carries_pg": top["carries_pg"], "touches_pg": top["touches_pg"],
                      "ppr_pg": top["ppr_pg"]}
            # second back's carry share tells you committee vs bell cow
            if pos == "RB" and sub.height > 1:
                r["rb2_carry_share"] = sub.row(1, named=True)["carry_share"]
        rb = u.filter(pl.col("position") == "RB")
        r["rb_target_share"] = float(rb["target_share"].sum()) if not rb.is_empty() else None
        rows.append(r)
    return sorted(rows, key=lambda x: x["season"])


# --- injuries ----------------------------------------------------------------

_INJ_COLS = ["season", "week", "game_type", "team", "gsis_id", "full_name", "position", "report_primary_injury",
             "report_secondary_injury", "report_status", "practice_primary_injury", "practice_status"]


def _inj() -> pl.LazyFrame | None:
    try:
        return scan("injuries").select(_INJ_COLS)
    except FileNotFoundError:
        return None


def player_injuries(player_id: str) -> pl.DataFrame:
    lf = _inj()
    if lf is None:
        return pl.DataFrame()
    return lf.filter(pl.col("gsis_id") == player_id).sort(["season", "week"], descending=[True, True]).collect()


def team_injuries(team: str, season: int, week: int) -> pl.DataFrame:
    lf = _inj()
    if lf is None:
        return pl.DataFrame()
    return (
        lf.filter((pl.col("team") == team) & (pl.col("season") == season) & (pl.col("week") == week))
        .sort(["report_status", "position"]).collect()
    )


def latest_injury_week(season: int) -> int | None:
    lf = _inj()
    if lf is None:
        return None
    w = lf.filter(pl.col("season") == season).select(pl.col("week").max()).collect().item()
    return int(w) if w is not None else None
