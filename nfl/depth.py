"""Depth charts, across the 2025 schema break.

nflverse did not extend this table in 2025, it replaced it. The two eras share
exactly three column names (``season``, ``gsis_id``, and nothing else that
means the same thing), so there is no union that works:

    2001-2024   season, club_code, week, game_type, depth_team,
                position, depth_position, gsis_id, full_name, ...
    2025-       season, dt, team, player_name, espn_id, gsis_id,
                pos_grp, pos_abb, pos_slot, pos_rank

The old format labels a row with the *week* it applies to and ranks players
with ``depth_team`` ("1", "2", "3"). The new one is a firehose of timestamped
snapshots -- 221 of them in 2025 -- with no week at all, ranking players with
``pos_rank`` and naming positions in ``pos_abb``. Row counts tell the story:
37,312 in 2024, 554,215 in 2025.

Because :func:`nfl.data.scan` sets ``missing_columns="insert"``, unioning the
raw files *succeeds* and hands back 2001-2024 intact with every 2025+ row
nulled out in week, position and depth_team. Nothing raises. That is why
``depth_charts`` is listed in :data:`nfl.data.UNSAFE_UNION` and why this module
exists.

The unified frame keeps both time keys rather than inventing one:

    week    the legacy label. Null for 2025+, which has no such concept.
    asof    the snapshot timestamp (UTC). Null for 2001-2024, which has none.

Do not fill either one in from the other. For leakage-safe work on the modern
era, ``asof`` is what you want, and it is strictly better than a week label:
it lets you ask what the depth chart said on Tuesday morning rather than
trusting a label applied after the fact.
"""

from __future__ import annotations

import polars as pl

from .data import dataset_files
from .teams import canonical_team_expr

#: The unified schema, in order. Both eras are projected onto exactly this.
DEPTH_COLUMNS = [
    "season", "week", "asof", "team", "position", "rank",
    "gsis_id", "player_name", "game_type",
]

#: nflverse timestamps look like "2026-03-14T07:32:09Z". Stored as a *string*,
#: not a datetime, so it has to be parsed rather than cast.
_DT_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def is_modern(columns: list[str]) -> bool:
    """Which era a file belongs to, decided by content rather than by year.

    Keyed on ``pos_rank`` because that column exists only in the new format.
    Sniffing the columns rather than hardcoding "2025 and later" means a
    back-fill or a re-cut of an old season is handled correctly, and a future
    third format fails the ``_normalize`` dispatch loudly instead of being
    mislabelled as one of these two.
    """
    return "pos_rank" in columns


def _normalize_legacy(lf: pl.LazyFrame) -> pl.LazyFrame:
    return lf.select(
        season=pl.col("season").cast(pl.Int32),
        week=pl.col("week").cast(pl.Int32, strict=False),
        asof=pl.lit(None, dtype=pl.Datetime("us")),
        team=canonical_team_expr("club_code"),
        position=pl.col("position").cast(pl.String),
        # "1"/"2"/"3" as strings; the new format uses integers for the same idea.
        rank=pl.col("depth_team").cast(pl.Int32, strict=False),
        gsis_id=pl.col("gsis_id").cast(pl.String),
        player_name=pl.col("full_name").cast(pl.String),
        game_type=pl.col("game_type").cast(pl.String),
    )


def _normalize_modern(lf: pl.LazyFrame) -> pl.LazyFrame:
    return lf.select(
        season=pl.col("season").cast(pl.Int32),
        week=pl.lit(None, dtype=pl.Int32),
        asof=pl.col("dt").str.to_datetime(_DT_FORMAT, time_unit="us", strict=False),
        team=canonical_team_expr("team"),
        position=pl.col("pos_abb").cast(pl.String),
        rank=pl.col("pos_rank").cast(pl.Int32),
        gsis_id=pl.col("gsis_id").cast(pl.String),
        player_name=pl.col("player_name").cast(pl.String),
        game_type=pl.lit(None, dtype=pl.String),
    )


def normalize_depth_chart(source: pl.DataFrame | pl.LazyFrame) -> pl.LazyFrame:
    """Project one era's frame onto :data:`DEPTH_COLUMNS`. Pure, so it is
    testable against a handful of synthetic rows in either format."""
    lf = source.lazy()
    names = lf.collect_schema().names()
    if is_modern(names):
        return _normalize_modern(lf)
    if "depth_team" in names:
        return _normalize_legacy(lf)
    raise ValueError(
        "depth chart frame matches neither known format: expected 'pos_rank' "
        f"(2025+) or 'depth_team' (2001-2024), got {sorted(names)[:12]}"
    )


def load_depth_charts(
    *, seasons: range | list[int] | None = None, position: str | None = None
) -> pl.DataFrame:
    """Every cached depth chart, both eras, on one schema.

    Read file by file rather than as a glob: the whole point is that the files
    disagree, so they have to be normalised before they can be stacked.
    """
    frames = [
        normalize_depth_chart(pl.scan_parquet(f)) for f in dataset_files("depth_charts")
    ]
    if not frames:
        raise FileNotFoundError("no depth_charts files cached")
    lf = pl.concat(frames, how="vertical")
    if seasons is not None:
        lf = lf.filter(pl.col("season").is_in(list(seasons)))
    if position is not None:
        lf = lf.filter(pl.col("position") == position)
    return lf.select(DEPTH_COLUMNS).sort(["season", "team", "position", "rank"]).collect()


def starters(depth: pl.DataFrame, *, position: str = "QB") -> pl.DataFrame:
    """The top of the chart at one position.

    On the modern era this still returns one row per snapshot, not one per
    week: 32 teams x 221 snapshots. Narrowing that to "the chart as it stood
    before a given kickoff" is a `join_asof` against ``asof``, which is
    deliberately left to the caller -- the game spine is what supplies the
    kickoff time, and this module does not import it.
    """
    return depth.filter((pl.col("position") == position) & (pl.col("rank") == 1))
