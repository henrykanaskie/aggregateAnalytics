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
