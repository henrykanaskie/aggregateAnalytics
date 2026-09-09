"""The predictions slot.

Game level reads ``data/predictions.parquet`` (schema in
``data_handling.ingest.PRED_SCHEMA``). Player level reads
``data/derived/prop_predictions.parquet`` when it exists. That file does not
exist yet; this is the contract the model will write to:

    logged_at      datetime   when the call was made (must precede kickoff)
    model_version  str
    season, week   int
    game_id        str        nflverse id
    player_id      str        gsis id
    market         str        canonical key from dashboard.odds.markets
    pred           float      point prediction (mean) for the stat
    p_over         float      probability of clearing ``line`` (optional)
    line           float      the line the probability refers to (optional)
    book           str        where that line came from (optional)
    notes          str

Nothing here computes a prediction. It only surfaces what was logged.
"""

from __future__ import annotations

import polars as pl

from nfl.data import PRED_PATH

from .config import PROP_PRED_PATH

PROP_PRED_SCHEMA = {
    "logged_at": pl.Datetime, "model_version": pl.String, "season": pl.Int64, "week": pl.Int64,
    "game_id": pl.String, "player_id": pl.String, "market": pl.String, "pred": pl.Float64,
    "p_over": pl.Float64, "line": pl.Float64, "book": pl.String, "notes": pl.String,
}


def game_predictions(season: int | None = None, week: int | None = None) -> pl.DataFrame:
    if not PRED_PATH.exists():
        return pl.DataFrame()
    df = pl.read_parquet(PRED_PATH)
    if season is not None:
        df = df.filter(pl.col("season") == season)
    if week is not None:
        df = df.filter(pl.col("week") == week)
    # Latest logged row per game and model version.
    return df.sort("logged_at").group_by(["game_id", "model_version"], maintain_order=True).last()


def prop_predictions(season: int | None = None, week: int | None = None) -> pl.DataFrame:
    if not PROP_PRED_PATH.exists():
        return pl.DataFrame(schema=PROP_PRED_SCHEMA)
    df = pl.read_parquet(PROP_PRED_PATH)
    if season is not None:
        df = df.filter(pl.col("season") == season)
    if week is not None:
        df = df.filter(pl.col("week") == week)
    return df.sort("logged_at").group_by(["player_id", "market", "model_version"], maintain_order=True).last()
