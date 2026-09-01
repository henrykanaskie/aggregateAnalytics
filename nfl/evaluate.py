"""Scoring, baselines and walk-forward validation.

The point of this module is that the *judging* of a model should be fixed and
boring, so that the only thing that varies between experiments is the model. 

Measured on the live nflverse schedules, 2023-2025 regular + post season:

    closing line       MAE  9.786    <- will not be beaten
    league-mean margin MAE 11.079    <- must be beaten
    sd(margin)             14.33
    mean margin (HFA)      +2.41

Note the roadmap's sigma of ~12.7 is the spread of margins *around the market
line* (residual sd), not the raw sd of margin. Both are computed by
:func:`margin_summary` so the distinction stays visible.
"""

from __future__ import annotations

import math
from collections.abc import Iterator, Sequence

import polars as pl

Vector = Sequence[float] | pl.Series


def _s(x: Vector) -> pl.Series:
    return (x if isinstance(x, pl.Series) else pl.Series(values=list(x))).cast(pl.Float64)


def _paired(pred: Vector, actual: Vector) -> tuple[pl.Series, pl.Series]:
    """Drop pairs where either side is null; both metrics need both sides."""
    p, a = _s(pred), _s(actual)
    if len(p) != len(a):
        raise ValueError(f"length mismatch: {len(p)} predictions vs {len(a)} outcomes")
    keep = p.is_not_null() & a.is_not_null()
    return p.filter(keep), a.filter(keep)


# --------------------------------------------------------------------------
# Point-prediction metrics
# --------------------------------------------------------------------------

def mae(pred: Vector, actual: Vector) -> float:
    p, a = _paired(pred, actual)
    return float((p - a).abs().mean())


def rmse(pred: Vector, actual: Vector) -> float:
    p, a = _paired(pred, actual)
    return float(((p - a) ** 2).mean() ** 0.5)


def bias(pred: Vector, actual: Vector) -> float:
    """Mean signed error. Persistently non-zero means a systematic lean --
    usually a mis-estimated home field advantage."""
    p, a = _paired(pred, actual)
    return float((p - a).mean())


def margin_summary(margin: Vector, market: Vector | None = None) -> dict[str, float]:
    m = _s(margin).drop_nulls()
    out = {"n": float(len(m)), "mean_margin": float(m.mean()), "sd_margin": float(m.std())}
    if market is not None:
        p, a = _paired(market, margin)
        out["market_mae"] = float((p - a).abs().mean())
        out["residual_sd"] = float((a - p).std())  # the sigma to use for win prob
    return out


# --------------------------------------------------------------------------
# Probability metrics
# --------------------------------------------------------------------------

def brier(prob: Vector, outcome: Vector) -> float:
    """Mean squared error of a probability forecast. Lower is better."""
    p, o = _paired(prob, outcome)
    return float(((p - o) ** 2).mean())


def log_loss(prob: Vector, outcome: Vector, *, eps: float = 1e-15) -> float:
    p, o = _paired(prob, outcome)
    p = p.clip(eps, 1 - eps)
    return float(-(o * p.log() + (1 - o) * (1 - p).log()).mean())


def reliability_table(prob: Vector, outcome: Vector, *, bins: int = 10) -> pl.DataFrame:
    """Bucket forecasts and compare predicted to observed frequency.

    The diagonal is perfect calibration. Read it alongside ``resolution`` --
    a model that always says 0.63 sits on the diagonal and is worthless.
    """
    p, o = _paired(prob, outcome)
    edges = [i / bins for i in range(bins + 1)]
    df = pl.DataFrame({"p": p, "o": o}).with_columns(
        bin=pl.col("p").cut(edges[1:-1], labels=[str(i) for i in range(bins)])
        .cast(pl.String).cast(pl.Int32)
    )
    return (
        df.group_by("bin")
        .agg(
            n=pl.len(),
            mean_pred=pl.col("p").mean(),
            observed=pl.col("o").mean(),
        )
        .with_columns(gap=(pl.col("mean_pred") - pl.col("observed")))
        .sort("bin")
    )


def brier_decomposition(prob: Vector, outcome: Vector, *, bins: int = 10) -> dict[str, float]:
    """Murphy decomposition:  Brier = reliability - resolution + uncertainty.

    reliability  how far each bucket's observed rate sits from its forecast
                 (lower better -- this is calibration error)
    resolution   how far the buckets spread away from the base rate
                 (HIGHER better -- this is the part that carries information)
    uncertainty  variance of the outcome itself; a property of the games,
                 not of the model, so it is the same for every competitor
    """
    p, o = _paired(prob, outcome)
    n = len(p)
    obar = float(o.mean())
    tbl = reliability_table(p, o, bins=bins)
    rel = float((tbl["n"] / n * (tbl["mean_pred"] - tbl["observed"]) ** 2).sum())
    res = float((tbl["n"] / n * (tbl["observed"] - obar) ** 2).sum())
    unc = obar * (1 - obar)
    return {
        "brier": brier(p, o),
        "reliability": rel,
        "resolution": res,
        "uncertainty": unc,
        "decomposed": rel - res + unc,
    }


# --------------------------------------------------------------------------
# Margin <-> probability
# --------------------------------------------------------------------------

def _norm_cdf(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def margin_to_win_prob(margin: Vector | float, sigma: float = 13.0) -> pl.Series | float:
    """P(home wins) from a predicted margin, via a fitted normal.

    ``sigma`` should be the residual sd of your own model, not the sd of raw
    margins -- fit it, do not inherit it. :func:`margin_summary` reports the
    market's for reference.
    """
    if isinstance(margin, (int, float)):
        return _norm_cdf(float(margin) / sigma)
    return _s(margin).map_elements(
        lambda m: None if m is None else _norm_cdf(m / sigma), return_dtype=pl.Float64
    )


# --------------------------------------------------------------------------
# Baselines
# --------------------------------------------------------------------------

def constant_baseline(games: pl.DataFrame, *, value: float | None = None) -> pl.Series:
    """Predict the same margin for every game. If ``value`` is None, uses the
    in-sample mean margin -- i.e. home field advantage and nothing else.

    This is the floor. A model that does not clear it has a bug, not a
    weak signal.
    """
    if value is None:
        value = float(games["margin"].drop_nulls().mean())
    return pl.Series("constant", [value] * games.height, dtype=pl.Float64)


def market_baseline(games: pl.DataFrame) -> pl.Series:
    """The closing line. The ceiling; treat closing to within ~1.0 MAE as the
    realistic target."""
    return games["spread_line"].cast(pl.Float64).rename("market")


def compare(
    predictions: dict[str, Vector],
    actual: Vector,
    *,
    market: Vector | None = None,
) -> pl.DataFrame:
    """One table, every competitor, sorted best-first.

    ``vs_market`` is the MAE gap to the closing line: positive means worse
    than the market, which is the expected outcome.
    """
    market_mae = mae(market, actual) if market is not None else None
    rows = []
    for name, pred in predictions.items():
        p, a = _paired(pred, actual)
        rows.append({
            "model": name,
            "n": len(p),
            "mae": mae(p, a),
            "rmse": rmse(p, a),
            "bias": bias(p, a),
            "vs_market": None if market_mae is None else mae(p, a) - market_mae,
        })
    return pl.DataFrame(rows).sort("mae")


# --------------------------------------------------------------------------
# Walk-forward validation
# --------------------------------------------------------------------------

def walk_forward_splits(
    seasons: Sequence[int], *, min_train: int = 5, step: int = 1
) -> Iterator[tuple[list[int], list[int]]]:
    """Expanding-window season splits: ``(train_seasons, test_seasons)``.

    Expanding rather than sliding because ratings are cumulative -- you never
    want to throw away rating history you have already earned. Nothing here
    ever lets a test season into its own training set, which is the one
    mistake that makes a model look brilliant and be worthless.
    """
    s = sorted(set(seasons))
    if len(s) <= min_train:
        raise ValueError(f"need more than {min_train} seasons, got {len(s)}")
    i = min_train
    while i < len(s):
        yield s[:i], s[i : i + step]
        i += step
