"""The prediction log's gatekeeping.

`check_slate` is the last thing between a slate and the permanent record, so
its refusals are the behaviour under test. The kickoff rule is the one that
turns "I logged before kickoff" from a claim into an invariant.
"""

from datetime import datetime, timedelta, timezone

import polars as pl
import pytest

from model.elo import run_elo
from model.predict import (
    SanityCheckFailed, check_slate, export_track_record, log_week, predict_week,
)

NOW = datetime(2026, 9, 8, 12, 0, tzinfo=timezone.utc)


def _slate(**overrides) -> pl.DataFrame:
    """One clean, loggable game. Override a column to break one rule."""
    base = {
        "game_id": ["2026_01_NE_SEA"],
        "season": [2026], "week": [1],
        "home": ["SEA"], "away": ["NE"],
        "pre_home_elo": [1520.0], "pre_away_elo": [1480.0],
        "pred_margin": [3.6], "margin": [None],
        "spread_line": [3.5], "total_line": [44.5],
        "pred_win_prob": [0.61],
        "model_version": ["elo-test"], "notes": ["synthetic"],
        "kickoff": [NOW + timedelta(days=1)],
    }
    base.update(overrides)
    return pl.DataFrame(base, schema_overrides={
        "margin": pl.Int64,
        "kickoff": pl.Datetime("us", "UTC"),
    })


def test_clean_slate_passes():
    check_slate(_slate(), now=NOW)


def test_game_that_already_kicked_off_is_refused():
    with pytest.raises(SanityCheckFailed, match="already kicked off"):
        check_slate(_slate(kickoff=[NOW - timedelta(minutes=1)]), now=NOW)


def test_kickoff_exactly_now_counts_as_started():
    with pytest.raises(SanityCheckFailed, match="already kicked off"):
        check_slate(_slate(kickoff=[NOW]), now=NOW)


def test_unknown_kickoff_is_refused_not_assumed_future():
    with pytest.raises(SanityCheckFailed, match="kickoff unknown"):
        check_slate(_slate(kickoff=[None]), now=NOW)


def test_slate_without_kickoff_column_skips_the_rule():
    """A rated frame handed in directly has no spine columns; the other
    checks still run, the kickoff one cannot."""
    check_slate(_slate().drop("kickoff"), now=NOW)


def test_now_must_be_timezone_aware():
    with pytest.raises(ValueError, match="timezone-aware"):
        check_slate(_slate(), now=datetime(2026, 9, 8, 12, 0))


def test_other_rules_still_fire():
    with pytest.raises(SanityCheckFailed, match="win prob outside"):
        check_slate(_slate(pred_win_prob=[0.99]), now=NOW)
    with pytest.raises(SanityCheckFailed, match="spread_line has 1 nulls"):
        check_slate(_slate(spread_line=[None]), now=NOW)


# --- predict_week carries kickoff from the spine ------------------------------

def _games() -> pl.DataFrame:
    """A spine-shaped frame: enough 2024 results to fit sigma, one 2026 game."""
    played = 6
    return pl.DataFrame({
        "game_id": [f"2024_0{i+1}_A_B" for i in range(played)] + ["2026_01_NE_SEA"],
        "season": [2024] * played + [2026],
        "week": list(range(1, played + 1)) + [1],
        "home": ["SEA", "NE", "SEA", "NE", "SEA", "NE", "SEA"],
        "away": ["NE", "SEA", "NE", "SEA", "NE", "SEA", "NE"],
        "margin": [7, -3, 10, 0, 4, -6, None],
        "neutral": [False] * (played + 1),
        "spread_line": [3.0, -1.0, 4.5, 1.0, 2.5, -2.0, 3.5],
        "total_line": [44.0] * (played + 1),
        "kickoff": [NOW - timedelta(days=300 - i) for i in range(played)]
                   + [NOW + timedelta(days=1)],
    }, schema_overrides={"margin": pl.Int64, "kickoff": pl.Datetime("us", "UTC")})


def test_predict_week_joins_kickoff_and_passes_checks():
    games = _games()
    preds = predict_week(2026, 1, model_version="elo-test", games=games)
    assert preds.height == 1
    assert preds["kickoff"][0] == games["kickoff"][-1]
    check_slate(preds, now=NOW)


def test_predict_week_without_kickoff_in_games_still_predicts():
    preds = predict_week(2026, 1, model_version="elo-test", games=_games().drop("kickoff"))
    assert "kickoff" not in preds.columns
    assert preds.height == 1


# --- the log and its tracked export ------------------------------------------

def test_log_week_writes_parquet_and_csv(tmp_path, monkeypatch, capsys):
    pred_path = tmp_path / "predictions.parquet"
    csv_path = tmp_path / "track" / "predictions.csv"
    monkeypatch.setattr("model.predict.PRED_PATH", pred_path)
    monkeypatch.setattr("model.predict.TRACK_CSV", csv_path)
    monkeypatch.setattr("data_handling.ingest.PRED_PATH", pred_path)

    # export_track_record binds its defaults at definition time; pass them.
    monkeypatch.setattr("model.predict.export_track_record",
                        lambda: export_track_record(pred_path, csv_path))

    # log_week uses the real clock, so the kickoff must be unambiguously future.
    written = log_week(_slate(kickoff=[datetime(2099, 1, 1, tzinfo=timezone.utc)]))
    assert written.height == 1
    assert csv_path.exists()
    csv = pl.read_csv(csv_path)
    assert csv.height == 1
    assert csv["market_spread"][0] == 3.5           # renamed on the way in
    assert "logged_at" in csv.columns
    assert "UTC" in capsys.readouterr().out


def test_log_week_refuses_a_started_game_before_writing(tmp_path, monkeypatch):
    pred_path = tmp_path / "predictions.parquet"
    monkeypatch.setattr("model.predict.PRED_PATH", pred_path)
    monkeypatch.setattr("data_handling.ingest.PRED_PATH", pred_path)
    with pytest.raises(SanityCheckFailed):
        log_week(_slate(kickoff=[datetime(2000, 1, 1, tzinfo=timezone.utc)]))
    assert not pred_path.exists()
