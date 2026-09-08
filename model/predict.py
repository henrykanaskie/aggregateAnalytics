
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import polars as pl

from data_handling.ingest import PRED_SCHEMA, log_predictions
from model.elo import EloParams, run_elo
from nfl.data import PRED_PATH, TRACK_CSV
from nfl.evaluate import fit_sigma, margin_to_win_prob
from nfl.games import load_games


SIGMA_FROM = 2020
PROB_BOUNDS = (0.05, 0.95)
RATING_BOUNDS = (1200.0, 1800.0)


class SanityCheckFailed(AssertionError):
    """Raised when a slate is too suspect to write to the permanent log."""

def predict_week(
    season: int,
    week: int,
    params: EloParams = EloParams(),
    model_version: str = "elo-v1",
    rated: pl.DataFrame | None = None,
    games: pl.DataFrame | None = None,
) -> pl.DataFrame:
    if games is None:
        games = load_games()
    if rated is None:
        rated = run_elo(games, params)

    played_recent = rated.filter(
        (pl.col("season") >= SIGMA_FROM) & pl.col("margin").is_not_null()
    )
    sigma = fit_sigma(played_recent["pred_margin"], played_recent["margin"])

    slate = rated.filter(
        pl.col("margin").is_null()
        & (pl.col("season") == season)
        & (pl.col("week") == week)
    )
    # `run_elo` keeps only the rating columns; kickoff comes from the spine so
    # that `check_slate` can refuse a game that has already started.
    if "kickoff" in games.columns:
        slate = slate.join(games.select("game_id", "kickoff"), on="game_id", how="left")
    return slate.with_columns(
        pred_win_prob=margin_to_win_prob(slate["pred_margin"], sigma=sigma),
        model_version=pl.lit(model_version),
        notes=pl.lit(
            f"sigma={sigma:.3f} k={params.k} hfa={params.hfa} "
            f"carryover={params.carryover} ppe={params.points_per_elo}"
        ),
    )


def check_slate(preds: pl.DataFrame, *, now: datetime | None = None) -> None:
    """Refuse a slate that should not reach the permanent log.

    ``now`` is injectable for tests; it must be timezone-aware because
    ``kickoff`` is stored in UTC.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("`now` must be timezone-aware; kickoff is stored in UTC")

    fail = []
    if preds.height == 0:
        fail.append("slate is empty (already played, or wrong season/week?)")
    if preds["game_id"].n_unique() != preds.height:
        fail.append("duplicate game_id in the slate")
    for col in ("pred_margin", "pred_win_prob", "spread_line"):
        if preds[col].null_count():
            fail.append(f"{col} has {preds[col].null_count()} nulls")

    lo, hi = PROB_BOUNDS
    if preds.height and not preds["pred_win_prob"].is_between(lo, hi).all():
        worst = preds["pred_win_prob"]
        fail.append(f"win prob outside [{lo}, {hi}]: {worst.min():.3f}-{worst.max():.3f}")

    rlo, rhi = RATING_BOUNDS
    ratings = pl.concat([preds["pre_home_elo"], preds["pre_away_elo"]])
    if preds.height and not ratings.is_between(rlo, rhi).all():
        fail.append(f"rating outside [{rlo}, {rhi}]: {ratings.min():.1f}-{ratings.max():.1f}")

    # A prediction logged after kickoff is not a prediction. A null kickoff is
    # "unknown", which is not the same as "not started" -- refuse that too.
    if "kickoff" in preds.columns and preds.height:
        unknown = preds.filter(pl.col("kickoff").is_null())["game_id"].to_list()
        if unknown:
            fail.append(f"kickoff unknown for {unknown}")
        started = preds.filter(pl.col("kickoff") <= now)["game_id"].to_list()
        if started:
            fail.append(f"already kicked off: {started}")

    if fail:
        raise SanityCheckFailed("; ".join(fail))


def _existing(season: int, week: int, model_version: str) -> int:
    if not PRED_PATH.exists():
        return 0
    prior = pl.read_parquet(PRED_PATH)
    if prior.height == 0:
        return 0
    return prior.filter(
        (pl.col("season") == season)
        & (pl.col("week") == week)
        & (pl.col("model_version") == model_version)
    ).height


def log_week(preds: pl.DataFrame) -> pl.DataFrame:
    """Append a slate to the prediction log, then read it back and verify.
    """
    check_slate(preds)

    season, week = preds["season"][0], preds["week"][0]
    version = preds["model_version"][0]
    if (prior := _existing(season, week, version)):
        print(
            f"[warn] {prior} predictions already logged for {season} week {week} "
            f"under {version!r}. Appending anyway; score on the earliest "
            f"logged_at per game."
        )

    # Naive UTC, so it compares cleanly against `kickoff` once localised.
    # Rows logged before 2026-09-09 carry naive *local* machine time instead;
    # treat their `logged_at` as approximate when scoring.
    stamped_at = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = (
        preds.rename({"spread_line": "market_spread", "total_line": "market_total"})
        .with_columns(logged_at=stamped_at)
        .to_dicts()
    )
    log_predictions(rows)

    written = pl.read_parquet(PRED_PATH).filter(pl.col("logged_at") == stamped_at)
    if written.height != preds.height:
        raise SanityCheckFailed(
            f"wrote {preds.height} rows but read back {written.height}"
        )
    blank = [c for c in PRED_SCHEMA if c != "notes" and written[c].null_count() == written.height]
    if blank:
        raise SanityCheckFailed(
            f"columns written entirely null (a rename typo?): {blank}"
        )
    print(f"[ok] logged {written.height} predictions at {stamped_at:%Y-%m-%d %H:%M:%S} UTC")
    csv = export_track_record()
    print(f"[ok] track record re-exported to {csv}; commit it before kickoff")
    return written


def export_track_record(src: Path = PRED_PATH, dst: Path = TRACK_CSV) -> Path:
    """Write the whole prediction log as a git-tracked CSV.

    Full re-export every time, so the file is always the complete record and a
    commit diff shows exactly the rows that were appended.
    """
    log = pl.read_parquet(src).sort("logged_at", "game_id")
    dst.parent.mkdir(parents=True, exist_ok=True)
    log.write_csv(dst)
    return dst


def slate_view(preds: pl.DataFrame) -> pl.DataFrame:

    return preds.select(
        matchup=pl.col("away") + " @ " + pl.col("home"),
        pick=pl.when(pl.col("pred_margin") > 0).then(pl.col("home")).otherwise(pl.col("away")),
        by=pl.col("pred_margin").abs().round(1),
        conf=pl.max_horizontal(pl.col("pred_win_prob"), 1 - pl.col("pred_win_prob")).round(3),
        mkt_fav=pl.when(pl.col("spread_line") > 0).then(pl.col("home")).otherwise(pl.col("away")),
        line=pl.col("spread_line").abs(),
        agree=(pl.col("pred_margin") > 0) == (pl.col("spread_line") > 0),
    ).sort("conf", descending=True)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Predict and log one week's slate.")
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--week", type=int, default=1)
    ap.add_argument("--model-version", default="elo-v1")
    ap.add_argument("--log", action="store_true",
                    help="write to the prediction log; without it, print only")
    ap.add_argument("--export", action="store_true",
                    help="only re-export the log to track_record/predictions.csv")
    args = ap.parse_args()

    if args.export:
        print(f"[ok] exported to {export_track_record()}")
        raise SystemExit(0)

    preds = predict_week(args.season, args.week, model_version=args.model_version)
    with pl.Config(tbl_rows=-1, tbl_width_chars=160, fmt_str_lengths=24, float_precision=2):
        print(slate_view(preds))
    print(f"\n{preds.height} games, agree with the market on "
          f"{int(slate_view(preds)['agree'].sum())}")

    if args.log:
        log_week(preds)
    else:
        check_slate(preds)
        print("[dry run] sanity checks passed. Re-run with --log to write.")
