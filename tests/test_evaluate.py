import math

import polars as pl
import pytest

from nfl.evaluate import (
    bias, brier, brier_decomposition, compare, constant_baseline, log_loss,
    mae, margin_summary, margin_to_win_prob, market_baseline, reliability_table,
    rmse, walk_forward_splits,
)


# --- point metrics ---------------------------------------------------------

def test_mae_rmse_bias_known_values():
    pred, actual = [1.0, 2.0, 3.0], [2.0, 2.0, 6.0]
    assert mae(pred, actual) == pytest.approx(4 / 3)
    assert rmse(pred, actual) == pytest.approx(math.sqrt(10 / 3))
    assert bias(pred, actual) == pytest.approx(-4 / 3)


def test_perfect_prediction_scores_zero():
    a = [3.0, -7.0, 0.0]
    assert mae(a, a) == 0.0 and rmse(a, a) == 0.0 and bias(a, a) == 0.0


def test_nulls_are_dropped_pairwise():
    """Unplayed games carry a line but no margin; they must not poison the mean."""
    assert mae([1.0, 99.0], [2.0, None]) == pytest.approx(1.0)


def test_length_mismatch_raises():
    with pytest.raises(ValueError):
        mae([1.0, 2.0], [1.0])


def test_margin_summary_separates_raw_sd_from_residual_sd():
    margin = [10.0, -3.0, 0.0, 7.0]
    market = [7.0, -1.0, 1.0, 3.0]
    out = margin_summary(margin, market)
    assert out["n"] == 4
    assert out["sd_margin"] != out["residual_sd"]      # the roadmap's 14.3 vs 12.7
    assert out["market_mae"] == pytest.approx(2.5)


# --- probability metrics ---------------------------------------------------

def test_brier_known_value():
    assert brier([1.0, 0.0], [1.0, 0.0]) == 0.0
    assert brier([0.5, 0.5], [1.0, 0.0]) == pytest.approx(0.25)


def test_log_loss_is_finite_at_the_extremes():
    assert math.isfinite(log_loss([0.0, 1.0], [1.0, 0.0]))


def test_reliability_table_is_flat_for_a_calibrated_forecast():
    # 100 games at p=0.75, exactly 75 of which the home team wins
    prob = [0.75] * 100
    outcome = [1.0] * 75 + [0.0] * 25
    tbl = reliability_table(prob, outcome, bins=10)
    assert tbl.height == 1
    assert tbl["gap"][0] == pytest.approx(0.0)


def test_decomposition_identity_holds():
    """Brier == reliability - resolution + uncertainty."""
    prob = [0.25] * 40 + [0.75] * 40
    outcome = [1.0] * 10 + [0.0] * 30 + [1.0] * 30 + [0.0] * 10
    d = brier_decomposition(prob, outcome)
    assert d["decomposed"] == pytest.approx(d["brier"], abs=1e-9)


def test_uninformative_forecast_has_zero_resolution():
    """The roadmap's warning: 0.63 for every game is calibrated and useless."""
    outcome = [1.0] * 63 + [0.0] * 37
    d = brier_decomposition([0.63] * 100, outcome)
    assert d["resolution"] == pytest.approx(0.0)
    assert d["reliability"] == pytest.approx(0.0)      # calibrated...
    assert d["brier"] == pytest.approx(d["uncertainty"], abs=1e-9)  # ...and worthless


def test_a_sharp_forecast_earns_resolution():
    prob = [0.9] * 50 + [0.1] * 50
    outcome = [1.0] * 45 + [0.0] * 5 + [1.0] * 5 + [0.0] * 45
    sharp = brier_decomposition(prob, outcome)
    flat = brier_decomposition([0.5] * 100, outcome)
    assert sharp["resolution"] > flat["resolution"]
    assert sharp["brier"] < flat["brier"]


# --- margin <-> probability ------------------------------------------------

def test_pick_em_is_a_coin_flip():
    assert margin_to_win_prob(0.0) == pytest.approx(0.5)


def test_win_prob_is_monotone_and_symmetric():
    assert margin_to_win_prob(7.0) > margin_to_win_prob(3.0) > 0.5
    assert margin_to_win_prob(7.0) + margin_to_win_prob(-7.0) == pytest.approx(1.0)


def test_smaller_sigma_means_more_confidence():
    assert margin_to_win_prob(7.0, sigma=10.0) > margin_to_win_prob(7.0, sigma=20.0)


def test_win_prob_vectorised():
    got = margin_to_win_prob(pl.Series([0.0, 13.0]), sigma=13.0)
    assert got.to_list()[0] == pytest.approx(0.5)
    assert got.to_list()[1] == pytest.approx(0.8413, abs=1e-3)


# --- baselines and comparison ----------------------------------------------

def _games():
    return pl.DataFrame({
        "margin": [10.0, -3.0, 0.0, 7.0],
        "spread_line": [7.0, -1.0, 1.0, 3.0],
    })


def test_constant_baseline_defaults_to_mean_margin():
    g = _games()
    b = constant_baseline(g)
    assert b.len() == g.height
    assert b[0] == pytest.approx(3.5)
    assert constant_baseline(g, value=0.0)[0] == 0.0


def test_market_baseline_is_the_line():
    assert market_baseline(_games()).to_list() == [7.0, -1.0, 1.0, 3.0]


def test_compare_sorts_best_first_and_reports_gap_to_market():
    g = _games()
    tbl = compare(
        {"good": g["margin"], "bad": [0.0, 0.0, 0.0, 0.0]},
        g["margin"],
        market=market_baseline(g),
    )
    assert tbl["model"].to_list() == ["good", "bad"]
    assert tbl["mae"][0] == 0.0
    assert tbl["vs_market"][0] == pytest.approx(-2.5)   # beats the line here


# --- walk-forward ----------------------------------------------------------

def test_walk_forward_never_leaks_the_test_season_into_training():
    for train, test in walk_forward_splits(range(1999, 2026), min_train=5):
        assert set(train).isdisjoint(test)
        assert max(train) < min(test)


def test_walk_forward_window_expands():
    splits = list(walk_forward_splits(range(2000, 2010), min_train=5))
    sizes = [len(tr) for tr, _ in splits]
    assert sizes == sorted(sizes) and sizes[0] == 5
    assert [te for _, te in splits][0] == [2005]


def test_walk_forward_needs_enough_history():
    with pytest.raises(ValueError):
        list(walk_forward_splits([1999, 2000], min_train=5))
