"""The game spine: one tidy row per game, franchise ids canonicalised.

Everything downstream -- Elo, the QB layer, the margin regression, the weekly
prediction script -- reads this instead of touching ``schedules`` directly.
That keeps the relocation handling and the sign conventions in exactly one
place.

Sign conventions, fixed here once so nothing downstream has to re-derive them:

    margin       = home_score - away_score   (positive = home won)
    spread_line  = market's expected margin, same orientation
                   (verified: corr(spread_line, margin) = +0.43,
                    mean spread_line +2.25 vs mean margin +2.34)

So a model's error against the market is directly ``pred_margin - spread_line``
with no sign flip, and the market's own error is ``spread_line - margin``.
"""

from __future__ import annotations

import polars as pl

from .data import scan
from .teams import canonical_team_expr

#: Columns carried through from schedules untouched.
_PASSTHROUGH = [
    "roof", "surface", "temp", "wind", "stadium_id",
    "home_qb_id", "away_qb_id", "home_qb_name", "away_qb_name",
    "home_coach", "away_coach", "referee",
    "home_moneyline", "away_moneyline", "total_line", "total",
]

SPINE_COLUMNS = [
    "game_id", "season", "week", "game_type", "is_regular", "gameday",
    "home", "away", "home_score", "away_score", "margin", "played",
    "spread_line", "neutral", "div_game", "overtime",
    "home_rest", "away_rest", "rest_diff",
] + _PASSTHROUGH


def build_game_spine(schedules: pl.DataFrame | pl.LazyFrame) -> pl.DataFrame:
    """Pure transform: raw ``schedules`` -> the spine. No I/O, so it is testable
    against a handful of synthetic rows."""
    lf = schedules.lazy()
    have = lf.collect_schema()

    gameday = (
        pl.col("gameday").str.to_date(strict=False)
        if have["gameday"] == pl.String
        else pl.col("gameday")
    )

    out = lf.with_columns(
        home=canonical_team_expr("home_team"),
        away=canonical_team_expr("away_team"),
        gameday=gameday,
        # `result` is home - away, but recompute where it is null and the
        # scores are present so a partially-populated row still resolves.
        margin=pl.coalesce(
            pl.col("result").cast(pl.Int64),
            (pl.col("home_score") - pl.col("away_score")).cast(pl.Int64),
        ),
        neutral=(pl.col("location") == "Neutral").fill_null(False),
        div_game=pl.col("div_game").cast(pl.Boolean).fill_null(False),
        overtime=pl.col("overtime").cast(pl.Boolean),
        is_regular=(pl.col("game_type") == "REG"),
        rest_diff=(pl.col("home_rest") - pl.col("away_rest")).cast(pl.Int64),
    ).with_columns(
        # A game is "played" only once a final margin exists. Future games are
        # already in the table with lines attached and scores null -- that is
        # what makes Week 1 predictable before kickoff.
        played=pl.col("margin").is_not_null(),
    )

    keep = [c for c in SPINE_COLUMNS if c in out.collect_schema().names()]
    return out.select(keep).sort(["season", "week", "game_id"]).collect()


def load_games(
    *,
    seasons: range | list[int] | None = None,
    regular_season_only: bool = False,
    played_only: bool = False,
    source: pl.DataFrame | pl.LazyFrame | None = None,
) -> pl.DataFrame:
    """Load the spine from the parquet cache (or an in-memory ``source``)."""
    df = build_game_spine(scan("schedules") if source is None else source)
    if seasons is not None:
        df = df.filter(pl.col("season").is_in(list(seasons)))
    if regular_season_only:
        df = df.filter(pl.col("is_regular"))
    if played_only:
        df = df.filter(pl.col("played"))
    return df


def team_games(spine: pl.DataFrame) -> pl.DataFrame:
    """Long format: two rows per game, one per participant.

    Rating loops and per-team rollups want this shape; ``margin`` is flipped so
    it is always from the perspective of ``team``.
    """
    common = [c for c in ("game_id", "season", "week", "game_type", "gameday",
                          "played", "neutral", "div_game", "spread_line") if c in spine.columns]
    home = spine.select(
        *common,
        pl.col("home").alias("team"),
        pl.col("away").alias("opponent"),
        pl.lit(True).alias("is_home"),
        pl.col("margin"),
        pl.col("home_score").alias("points_for"),
        pl.col("away_score").alias("points_against"),
        pl.col("home_rest").alias("rest"),
        pl.col("home_qb_id").alias("qb_id"),
    )
    away = spine.select(
        *common,
        pl.col("away").alias("team"),
        pl.col("home").alias("opponent"),
        pl.lit(False).alias("is_home"),
        (-pl.col("margin")).alias("margin"),
        pl.col("away_score").alias("points_for"),
        pl.col("home_score").alias("points_against"),
        pl.col("away_rest").alias("rest"),
        pl.col("away_qb_id").alias("qb_id"),
    )
    return pl.concat([home, away]).sort(["season", "week", "game_id", "is_home"])


def upcoming(spine: pl.DataFrame, season: int, week: int) -> pl.DataFrame:
    """The slate to predict: scheduled, not yet played."""
    return spine.filter(
        (pl.col("season") == season) & (pl.col("week") == week) & ~pl.col("played")
    )
