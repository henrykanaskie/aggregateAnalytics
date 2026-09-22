"""The post-game angle grader: which number each angle is about, and that
no angle the matchup page can raise goes ungraded by accident."""

from __future__ import annotations

import re

import pytest

from dashboard.stats import angle_grades as ag
from dashboard.stats import matchups as mu


def test_box_angle_is_about_the_offenses_run_game():
    c = ag.team_check("Heavy boxes vs the run", "NO", "DET")
    assert c == {"kind": "metric", "side": "off", "metric": "rush_epa", "dir": "down", "vs": "team"}


def test_head_to_head_angles_read_their_metric_from_the_template():
    title = "DET likely to load the box more than usual against NO"
    assert ag.team_check(title, "NO", "DET")["metric"] == "def_box_avg"
    assert ag.team_check(title, "NO", "DET")["side"] == "def"
    assert ag.team_check(title, "NO", "DET")["dir"] == "up"
    light = ag.team_check("DET likely to lighten the box against NO: room for the run", "NO", "DET")
    assert light["dir"] == "down"


def test_defense_vs_position_angles():
    assert ag.team_check("SEA has clamped RBs", "NE", "SEA") == {"kind": "pos", "pos": "RB", "stat": "rushing_yards", "dir": "down"}
    assert ag.team_check("SEA has been generous to WRs", "NE", "SEA")["dir"] == "up"


def test_family_strips_names_but_not_words_containing_them():
    """"LA" is a team; "Light boxes" must not become "{def}ight boxes"."""
    assert ag.family("LA likely to load the box more than usual against LAC", "LAC", "LA") == \
        "{def} likely to load the box more than usual against {off}"
    assert ag.family("Light boxes: room to run", "LAC", "LA") == "Light boxes: room to run"
    assert ag.family("Jahmyr Gibbs vs stacked boxes", "DET", "GB", "Jahmyr Gibbs") == "{player} vs stacked boxes"


def test_verdict_follows_the_direction():
    assert ag._verdict(3.1, 4.4, "down", "dec1") == "hit"
    assert ag._verdict(5.0, 4.4, "down", "dec1") == "miss"
    assert ag._verdict(4.4, 4.4, "up") == "push"
    assert ag._verdict(None, 4.4, "up") is None


def test_tiny_moves_are_pushes():
    # sack rate 7.1% vs 7.0%: inside the half-point floor
    assert ag._verdict(0.071, 0.070, "up", "pct") == "push"
    assert ag._verdict(0.085, 0.070, "up", "pct") == "hit"
    # EPA near zero still needs 0.02 of movement
    assert ag._verdict(0.01, 0.00, "up", "dec2") == "push"
    assert ag._verdict(0.15, 0.18, "down", "dec2") == "hit"
    # plays: 5% of 60 is 3
    assert ag._verdict(62.0, 60.0, "up", "dec1") == "push"
    assert ag._verdict(64.0, 60.0, "up", "dec1") == "hit"


def test_thresholds_have_no_margin():
    """Under the closing total by half a point is under."""
    assert ag._verdict(44.0, 44.5, "down", "dec1", "closing total") == "hit"
    assert ag._verdict(1.0, 0.5, "up", "int", "at least one") == "hit"


def _every_team_angle(season: int) -> set[str]:
    from dashboard.stats.blend import blended, matchup_view
    table = blended(season)
    rows = {r["team"]: r for r in table.to_dicts()}
    titles: set[tuple[str, str, str]] = set()
    for o in rows:
        for d in rows:
            if o == d:
                continue
            off, deff, _ = matchup_view(rows[o], rows[d], table)
            dvp = {p: {"passing_yards": 250.0, "passing_yards_rank": 1, "rushing_yards": 90.0, "rushing_yards_rank": 32,
                       "receiving_yards": 150.0, "receiving_yards_rank": 1, "n_teams": 32} for p in ag.POSITIONS}
            for spread in (-10, 10):
                venue = {"wind": 20, "roof": "outdoors", "temp": 10}
                for a in mu.side_team_angles(off, deff, o, d, dvp, spread, venue):
                    titles.add((a["title"], o, d))
    return titles


def test_every_team_angle_is_graded_or_marked_context():
    """A new angle in matchups.py needs a row in TEAM_CHECKS (or a place in
    CONTEXT_ONLY), or the review page will quietly leave it out."""
    try:
        titles = _every_team_angle(2025)
    except FileNotFoundError:
        pytest.skip("team table not built")
    missing = sorted({t for t, o, d in titles
                      if ag.team_check(t, o, d) is None and not any(re.search(p, t) for p in ag.CONTEXT_ONLY)})
    assert not missing, missing


def _graded(monkeypatch, seasons_weeks):
    import polars as pl
    rows = [{k: None for k in ag.SCHEMA} | {"season": s, "week": w, "game_id": f"{s}_{w:02d}_A_B", "kind": "team",
             "family": "Heavy boxes vs the run", "lean": "under", "strength": 1, "tags": [], "verdict": "hit",
             "actual": 1.0, "baseline": 2.0, "direction": "down", "fmt": "dec2", "baseline_label": "x"}
            for s, w in seasons_weeks]
    df = pl.DataFrame(rows, schema=ag.SCHEMA)
    monkeypatch.setattr(ag, "_fresh", lambda: df)
    monkeypatch.setattr(ag, "CURRENT_SEASON", 2026)


def test_track_record_is_this_season_only(monkeypatch):
    _graded(monkeypatch, [(2025, 17), (2025, 18), (2026, 1), (2026, 2)])
    t = ag.track_record()
    assert t["season"] == 2026 and t["current"]
    assert t["weeks"] == [(2026, 1), (2026, 2)] and t["n"] == 2


def test_track_record_falls_back_to_last_season_before_week_one(monkeypatch):
    _graded(monkeypatch, [(2024, 18), (2025, 17), (2025, 18)])
    t = ag.track_record(weeks=1)
    assert t["season"] == 2025 and not t["current"]
    assert t["weeks"] == [(2025, 18)]
