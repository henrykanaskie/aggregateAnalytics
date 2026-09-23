"""Which weeks the weekly grading run picks up. The grade itself needs the
parquet cache; this is the scheduling logic around it, which does not."""

from __future__ import annotations

import polars as pl
import pytest

from dashboard.odds import grading


@pytest.fixture
def weeks(monkeypatch):
    """Fake the three sources weeks_to_grade consults."""
    def setup(played: set[int], lines: set[int], graded: set[int]):
        monkeypatch.setattr(grading, "played_weeks", lambda season: played)
        monkeypatch.setattr(grading, "weeks_with_lines", lambda season: lines)
        monkeypatch.setattr(grading, "graded_weeks", lambda season: graded)
    return setup


def test_ungraded_weeks_are_picked_up(weeks):
    weeks(played={1, 2, 3}, lines={1, 2, 3}, graded={1})
    assert grading.weeks_to_grade(2026) == [2, 3]


def test_the_newest_week_is_always_regraded(weeks):
    """nflverse revises box scores for days after the games, so last week's
    grade is regraded once even though a file for it already exists."""
    weeks(played={1, 2, 3}, lines={1, 2, 3}, graded={1, 2, 3})
    assert grading.weeks_to_grade(2026) == [3]


def test_weeks_the_archive_never_covered_are_skipped(weeks):
    """Weeks played before the line pulls started can never be graded; asking
    again every Tuesday would just rescan the archive for nothing."""
    weeks(played={1, 2, 3, 4}, lines={3, 4}, graded=set())
    assert grading.weeks_to_grade(2026) == [3, 4]


def test_all_regrades_every_finished_week(weeks):
    weeks(played={1, 2, 3}, lines={1, 2, 3}, graded={1, 2, 3})
    assert grading.weeks_to_grade(2026, regrade_all=True) == [1, 2, 3]


def test_an_explicit_week_wins(weeks):
    weeks(played=set(), lines=set(), graded=set())
    assert grading.weeks_to_grade(2026, week=7) == [7]


def test_nothing_finished_yet_is_not_an_error(weeks, capsys):
    weeks(played=set(), lines={1}, graded=set())
    assert grading.weeks_to_grade(2026) == []
    assert grading.main(["--season", "2026"]) == 0
    assert "nothing finished to grade yet" in capsys.readouterr().out


def test_one_bad_week_does_not_cost_the_others(weeks, monkeypatch, capsys):
    weeks(played={1, 2}, lines={1, 2}, graded=set())
    graded = pl.DataFrame({"game_id": ["a"], "book": ["draftkings"]})

    def grade_week(season, week, *a, **k):
        if week == 1:
            raise RuntimeError("boom")
        return graded

    monkeypatch.setattr(grading, "grade_week", grade_week)
    assert grading.main(["--season", "2026"]) == 1        # reported, not swallowed
    assert "wk02: 1 rows" in capsys.readouterr().out       # week 2 still graded


def test_a_signal_opens_to_the_lines_behind_its_rate(monkeypatch):
    """The drill-down and the summary count the same lines the same way."""
    rows = [
        {"season": 2026, "week": 1, "game_id": "g", "book": "dk", "market": "m", "player_id": str(i), "player_name": f"P{i}",
         "team": "T", "kind": "ou", "line": 10.0, "open_line": o, "moved": 10.0 - o, "actual": a, "result": r,
         "error": a - 10.0, "abs_error": abs(a - 10.0), "l5_rate": 0.8, "l10_rate": l10, "form_n": 10}
        for i, (l10, o, a, r) in enumerate([(0.8, 9.5, 12.0, "over"), (0.7, 10.5, 8.0, "under"), (0.9, 10.0, 11.0, "over"), (0.5, 9.0, 12.0, "over")])
    ]
    df = pl.DataFrame(rows)
    monkeypatch.setattr(grading, "graded_lines", lambda season=None: df)
    monkeypatch.setattr(grading, "graded_preds", lambda season=None: pl.DataFrame())
    s = {x["id"]: x for x in grading.summary()["signals"] + grading.summary()["movement"]}
    for sid in ("l10_over", "moved_toward"):
        d = grading.signal_lines(sid)
        assert d["n"] == s[sid]["n"] and d["hits"] / d["n"] == pytest.approx(s[sid]["hit_rate"])
    assert (grading.signal_lines("l10_over")["n"], grading.signal_lines("l10_over")["hits"]) == (3, 2)
    assert grading.signal_lines("nope") is None
