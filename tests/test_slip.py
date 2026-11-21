"""Grading a saved pick at the line it was taken. The box-score lookup needs
the parquet cache, so it is faked here; what is tested is the decision."""

from __future__ import annotations

import polars as pl
import pytest

from dashboard.odds import slip

GAME = "2026_03_ATL_GB"


@pytest.fixture
def box(monkeypatch):
    """One game in the cache: player A caught 5 for 62 and did not score."""
    df = pl.DataFrame({"player_id": ["A"], "game_id": [GAME], "receptions": [5.0], "receiving_yards": [62.0], "total_tds": [0.0]})
    monkeypatch.setattr(slip, "_actuals", lambda season, week, stats: df.select(["player_id", "game_id"] + [s for s in stats if s in df.columns]))


def leg(**kw):
    base = {"id": "1", "season": 2026, "week": 3, "game_id": GAME, "player_id": "A", "market": "player_receptions", "side": "over", "line": 4.5}
    return {**base, **kw}


def status(l):
    return slip.grade_legs([l])[0]["status"]


def test_graded_at_the_line_taken(box):
    assert status(leg(line=4.5)) == "hit"
    assert status(leg(line=5.5)) == "miss"
    assert status(leg(line=5.5, side="under")) == "hit"


def test_whole_number_line_can_push(box):
    assert status(leg(line=5.0)) == "push"


def test_yes_no_markets_ignore_the_line(box):
    assert status(leg(market="player_anytime_td", side="yes", line=None)) == "miss"
    assert status(leg(market="player_anytime_td", side="no", line=None)) == "hit"


def test_player_missing_from_a_loaded_game_is_void(box):
    assert status(leg(player_id="B")) == "void"


def test_game_not_in_the_cache_is_pending(box):
    assert status(leg(game_id="2026_03_DAL_NYG")) == "pending"


def test_unknown_market_does_not_break_the_rest(box):
    out = slip.grade_legs([leg(id="x", market="nope"), leg(id="y")])
    assert [r["status"] for r in out] == ["unknown", "hit"]
