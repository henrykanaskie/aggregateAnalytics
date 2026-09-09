"""Append-only snapshot store for sportsbook lines.

Every pull writes one parquet file per source under ``data/odds/props/`` and
``data/odds/games/``. Nothing is ever rewritten, so line movement is
reconstructable later from the ``pulled_at`` column. This is the "clock 2"
archive from the roadmap, generalised to props.

Rows are long-format: one row per (book, market, player, side). ``line`` is
the point; ``price`` is American odds and may be null when a source publishes
lines without prices (ESPN does).
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import polars as pl

from ..config import GAMES_DIR, PROPS_DIR

PROP_SCHEMA: dict[str, pl.DataType] = {
    "pulled_at": pl.Datetime("us", "UTC"),
    "source": pl.String,          # espn | oddsapi | sample
    "book": pl.String,            # draftkings, fanduel, ...
    "book_title": pl.String,
    "season": pl.Int32,
    "week": pl.Int32,
    "game_id": pl.String,         # nflverse id when the event could be matched
    "event_id": pl.String,        # provider-native id
    "commence_time": pl.String,
    "home_team": pl.String,
    "away_team": pl.String,
    "team": pl.String,            # player's team when known
    "market": pl.String,          # canonical key from markets.py
    "player_name": pl.String,
    "player_id": pl.String,       # gsis id when matched
    "side": pl.String,            # Over | Under | Yes | No
    "line": pl.Float64,
    "price": pl.Int32,            # American odds
    "open_line": pl.Float64,
    "open_price": pl.Int32,
    "last_update": pl.String,
}

GAME_SCHEMA: dict[str, pl.DataType] = {
    "pulled_at": pl.Datetime("us", "UTC"),
    "source": pl.String,
    "book": pl.String,
    "book_title": pl.String,
    "season": pl.Int32,
    "week": pl.Int32,
    "game_id": pl.String,
    "event_id": pl.String,
    "commence_time": pl.String,
    "home_team": pl.String,
    "away_team": pl.String,
    "market": pl.String,          # spreads | totals | h2h
    "side": pl.String,            # team abbr, or Over/Under
    "line": pl.Float64,
    "price": pl.Int32,
    "open_line": pl.Float64,
    "open_price": pl.Int32,
    "last_update": pl.String,
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _frame(rows: list[dict], schema: dict) -> pl.DataFrame:
    if not rows:
        return pl.DataFrame(schema=schema)
    df = pl.DataFrame(rows, schema_overrides=schema)
    for c, dt in schema.items():
        if c not in df.columns:
            df = df.with_columns(pl.lit(None, dtype=dt).alias(c))
    return df.select(list(schema)).cast(schema)


def _write(rows: list[dict], schema: dict, directory: Path, source: str, pulled_at: datetime) -> Path | None:
    df = _frame(rows, schema)
    if df.is_empty():
        return None
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{pulled_at:%Y%m%dT%H%M%SZ}_{source}.parquet"
    df.write_parquet(path, compression="zstd")
    return path


def write_props(rows: list[dict], source: str, pulled_at: datetime | None = None) -> Path | None:
    return _write(rows, PROP_SCHEMA, PROPS_DIR, source, pulled_at or now_utc())


def write_games(rows: list[dict], source: str, pulled_at: datetime | None = None) -> Path | None:
    return _write(rows, GAME_SCHEMA, GAMES_DIR, source, pulled_at or now_utc())


def _scan(directory: Path, schema: dict) -> pl.LazyFrame:
    files = sorted(directory.glob("*.parquet")) if directory.is_dir() else []
    if not files:
        return pl.DataFrame(schema=schema).lazy()
    return pl.scan_parquet(files, missing_columns="insert", extra_columns="ignore").cast(schema)


def scan_props() -> pl.LazyFrame:
    return _scan(PROPS_DIR, PROP_SCHEMA)


def scan_games() -> pl.LazyFrame:
    return _scan(GAMES_DIR, GAME_SCHEMA)


def _latest(lf: pl.LazyFrame, keys: list[str], season: int | None, week: int | None,
            include_sample: bool) -> pl.DataFrame:
    if season is not None:
        lf = lf.filter(pl.col("season") == season)
    if week is not None:
        lf = lf.filter(pl.col("week") == week)
    df = lf.collect()
    if df.is_empty():
        return df
    if not include_sample and (df["source"] != "sample").any():
        # Real data wins: never mix generated lines with live ones.
        df = df.filter(pl.col("source") != "sample")
    return (
        df.sort("pulled_at")
        .group_by(keys, maintain_order=True)
        .last()
    )


PROP_KEYS = ["source", "book", "game_id", "market", "player_name", "side"]
GAME_KEYS = ["source", "book", "game_id", "market", "side"]


def latest_props(season: int | None = None, week: int | None = None, include_sample: bool = False) -> pl.DataFrame:
    """Newest row per (source, book, game, market, player, side)."""
    return _latest(scan_props(), PROP_KEYS, season, week, include_sample)


def latest_games(season: int | None = None, week: int | None = None, include_sample: bool = False) -> pl.DataFrame:
    return _latest(scan_games(), GAME_KEYS, season, week, include_sample)


def prop_history(player_id: str, market: str | None = None, season: int | None = None,
                 week: int | None = None) -> pl.DataFrame:
    """Every snapshot for one player, for line-movement charts."""
    lf = scan_props().filter(pl.col("player_id") == player_id)
    if market:
        lf = lf.filter(pl.col("market") == market)
    if season is not None:
        lf = lf.filter(pl.col("season") == season)
    if week is not None:
        lf = lf.filter(pl.col("week") == week)
    return lf.sort(["market", "book", "side", "pulled_at"]).collect()


def status() -> dict:
    """Per-source pull history, for the settings page."""
    out: dict[str, dict] = {}
    for kind, lf in (("props", scan_props()), ("games", scan_games())):
        summary = (
            lf.group_by("source")
            .agg(pl.col("pulled_at").max().alias("last_pull"),
                 pl.col("pulled_at").n_unique().alias("pulls"),
                 pl.len().alias("rows"),
                 pl.col("book").n_unique().alias("books"))
            .collect()
        )
        for r in summary.to_dicts():
            src = out.setdefault(r["source"], {})
            src[kind] = {
                "last_pull": r["last_pull"].isoformat() if r["last_pull"] else None,
                "pulls": r["pulls"], "rows": r["rows"], "books": r["books"],
            }
    return out
