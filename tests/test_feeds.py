"""Losing a lines feed: the Sports Game Odds parser, its monthly budget, and
the ``auto`` chain that keeps pulling when ESPN stops answering."""

from __future__ import annotations

import json
from argparse import Namespace
from datetime import datetime, timezone

import pytest

from dashboard.odds import pull, sgo

# One game as the Sports Game Odds docs lay it out: odds keyed by
# {statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}, per-book numbers
# under byBookmaker, and a players map.
EVENT = {
    "eventID": "abc123",
    "status": {"startsAt": "2026-09-27T17:00:00.000Z"},
    "teams": {"home": {"teamID": "BUFFALO_BILLS_NFL", "names": {"short": "BUF", "long": "Buffalo Bills"}},
              "away": {"teamID": "LOS_ANGELES_CHARGERS_NFL", "names": {"short": "LAC", "long": "Los Angeles Chargers"}}},
    "players": {"JAMES_COOK_1_NFL": {"name": "James Cook", "teamID": "BUFFALO_BILLS_NFL"}},
    "odds": {
        "rushing_yards-JAMES_COOK_1_NFL-game-ou-over": {
            "statID": "rushing_yards", "statEntityID": "JAMES_COOK_1_NFL", "playerID": "JAMES_COOK_1_NFL",
            "periodID": "game", "betTypeID": "ou", "sideID": "over",
            "byBookmaker": {"draftkings": {"odds": "-115", "overUnder": "72.5", "available": True},
                            "fanduel": {"odds": "-110", "overUnder": "71.5", "available": True},
                            "betmgm": {"odds": "-110", "overUnder": "70.5", "available": False}}},
        "rushing_yards-JAMES_COOK_1_NFL-game-ou-under": {
            "statID": "rushing_yards", "statEntityID": "JAMES_COOK_1_NFL", "playerID": "JAMES_COOK_1_NFL",
            "periodID": "game", "betTypeID": "ou", "sideID": "under",
            "byBookmaker": {"draftkings": {"odds": "-105", "overUnder": "72.5"}}},
        # Anytime TD offered as over/under 0.5: the same bet as yes/no.
        "touchdowns-JAMES_COOK_1_NFL-game-ou-over": {
            "statID": "touchdowns", "playerID": "JAMES_COOK_1_NFL", "statEntityID": "JAMES_COOK_1_NFL",
            "periodID": "game", "betTypeID": "ou", "sideID": "over",
            "byBookmaker": {"draftkings": {"odds": "+120", "overUnder": "0.5"}}},
        "rushing_yards-JAMES_COOK_1_NFL-1h-ou-over": {
            "statID": "rushing_yards", "playerID": "JAMES_COOK_1_NFL", "statEntityID": "JAMES_COOK_1_NFL",
            "periodID": "1h", "betTypeID": "ou", "sideID": "over", "byBookmaker": {"draftkings": {"odds": "-110", "overUnder": "35.5"}}},
        "punting_numPunts-JAMES_COOK_1_NFL-game-ou-over": {
            "statID": "punting_numPunts", "playerID": "JAMES_COOK_1_NFL", "statEntityID": "JAMES_COOK_1_NFL",
            "periodID": "game", "betTypeID": "ou", "sideID": "over", "byBookmaker": {"draftkings": {"odds": "-110", "overUnder": "0.5"}}},
        "points-home-game-sp-home": {
            "statID": "points", "statEntityID": "home", "periodID": "game", "betTypeID": "sp", "sideID": "home",
            "byBookmaker": {"draftkings": {"odds": "-110", "spread": "-6.5"}}},
        "points-all-game-ou-over": {
            "statID": "points", "statEntityID": "all", "periodID": "game", "betTypeID": "ou", "sideID": "over",
            "byBookmaker": {"draftkings": {"odds": "-108", "overUnder": "50.5"}}},
        "points-home-game-ou-over": {    # a team total, not a game line
            "statID": "points", "statEntityID": "home", "periodID": "game", "betTypeID": "ou", "sideID": "over",
            "byBookmaker": {"draftkings": {"odds": "-110", "overUnder": "28.5"}}},
    },
}


@pytest.fixture
def offline(monkeypatch, tmp_path):
    """No cache and no network: names and games resolve from the fixture."""
    monkeypatch.setattr(sgo, "match_name", lambda name, teams=(): "00-0037248" if name == "James Cook" else None)
    monkeypatch.setattr(sgo, "match_game", lambda season, home, away, starts, week=None: {"game_id": f"2026_03_{away}_{home}"})
    monkeypatch.setattr(sgo, "SGO_USAGE_PATH", tmp_path / "sgo_usage.json")
    monkeypatch.setattr(pull, "FEED_STATUS_PATH", tmp_path / "feed_status.json")
    return tmp_path


def test_sgo_event_becomes_prop_and_game_rows(offline):
    at = datetime(2026, 9, 26, tzinfo=timezone.utc)
    props, games, skipped = sgo.parse_event(EVENT, 2026, 3, at)
    ry = [r for r in props if r["market"] == "player_rush_yds"]
    # Full game only, unavailable books dropped: DK over and under, FD over.
    assert sorted((r["book"], r["side"], r["line"], r["price"]) for r in ry) == [
        ("draftkings", "Over", 72.5, -115), ("draftkings", "Under", 72.5, -105), ("fanduel", "Over", 71.5, -110)]
    assert {r["player_id"] for r in ry} == {"00-0037248"} and {r["team"] for r in ry} == {"BUF"}
    assert all(r["game_id"] == "2026_03_LAC_BUF" and r["source"] == "sgo" for r in props)
    td = [r for r in props if r["market"] == "player_anytime_td"]
    assert [(r["side"], r["line"], r["price"]) for r in td] == [("Yes", None, 120)]
    assert skipped == {"punting_numPunts": 1}
    assert sorted((g["market"], g["side"], g["line"]) for g in games) == [("spreads", "BUF", -6.5), ("totals", "Over", 50.5)]


def test_sgo_refuses_a_pull_that_would_cross_the_monthly_budget(offline, monkeypatch):
    monkeypatch.setattr(sgo, "SGO_MONTHLY_OBJECTS", 20)
    (offline / "sgo_usage.json").write_text(json.dumps({"month": sgo._month(), "objects": 10}))
    monkeypatch.setattr(sgo, "_get", lambda params: pytest.fail("must not spend past the budget"))
    monkeypatch.setattr(sgo, "week_window", lambda s, w: ("a", "b"))
    with pytest.raises(sgo.SgoError, match="monthly budget"):
        sgo.fetch_events(2026, 3, expected=16)
    # A new month starts from zero.
    (offline / "sgo_usage.json").write_text(json.dumps({"month": "2020-01", "objects": 999}))
    assert sgo.usage()["objects"] == 0


def _args(**kw):
    base = dict(season=2026, week=3, markets=None, bookmakers=None, games=None, max_credits=250, no_games=False, dry_run=False)
    return Namespace(**{**base, **kw})


def _fake_pull(outcomes: dict, calls: list):
    def run(source, season, week, **kw):
        calls.append((source, kw.get("markets")))
        out = outcomes[source]
        if isinstance(out, Exception):
            raise out
        return {"source": source, "props": out[0], "games": out[1], "matched": out[0], "files": [], "usage": None}
    return run


def test_auto_keeps_pulling_when_espn_is_down(offline, monkeypatch):
    calls: list = []
    monkeypatch.setattr(pull, "run_pull", _fake_pull({"espn": RuntimeError("403 Forbidden"), "sgo": (900, 48)}, calls))
    monkeypatch.setattr(pull, "sgo_api_key", lambda: "k")
    monkeypatch.setattr(pull, "odds_api_key", lambda: "k")
    assert pull.auto(_args()) == 0
    # The Odds API is not spent while a free feed brought props.
    assert [c[0] for c in calls] == ["espn", "sgo"]
    status = json.loads((offline / "feed_status.json").read_text())
    assert status["espn"]["ok"] is False and "403" in status["espn"]["error"]
    assert status["sgo"]["ok"] is True and status["sgo"]["last_ok"]


def test_auto_falls_back_to_the_odds_api_only_when_both_free_feeds_fail(offline, monkeypatch):
    calls: list = []
    monkeypatch.setattr(pull, "run_pull", _fake_pull({"espn": RuntimeError("down"), "sgo": RuntimeError("down"), "oddsapi": (400, 0)}, calls))
    monkeypatch.setattr(pull, "sgo_api_key", lambda: "k")
    monkeypatch.setattr(pull, "odds_api_key", lambda: "k")
    monkeypatch.setattr("dashboard.odds.theoddsapi.usage", lambda: {"remaining": 300})
    assert pull.auto(_args()) == 0
    assert calls[-1] == ("oddsapi", pull.FALLBACK_ODDSAPI_MARKETS)


def test_auto_reports_failure_when_nothing_answers(offline, monkeypatch):
    calls: list = []
    monkeypatch.setattr(pull, "run_pull", _fake_pull({"espn": RuntimeError("down")}, calls))
    monkeypatch.setattr(pull, "sgo_api_key", lambda: None)
    monkeypatch.setattr(pull, "odds_api_key", lambda: None)
    assert pull.auto(_args()) == 1
    # A failure keeps the time of the last success for the banner.
    (offline / "feed_status.json").write_text(json.dumps({"espn": {"ok": True, "last_ok": "2026-09-20T10:00:00+00:00"}}))
    pull.auto(_args())
    assert json.loads((offline / "feed_status.json").read_text())["espn"]["last_ok"] == "2026-09-20T10:00:00+00:00"


def test_licensed_feeds_can_never_be_committed_to_the_public_repo():
    # The repo is public; Sports Game Odds' terms forbid redistributing its
    # data as downloadable files. git itself must refuse to stage them.
    import subprocess
    from pathlib import Path
    from dashboard.odds.store import LICENSED_SOURCES
    root = Path(__file__).resolve().parents[1]
    paths = [f"data/odds/{d}/20260927T150000Z_{s}.parquet" for s in LICENSED_SOURCES for d in ("props", "games")]
    paths.append("data/odds/graded/licensed/lines_2026_03.parquet")
    out = subprocess.run(["git", "check-ignore", *paths], cwd=root, capture_output=True, text=True).stdout.split()
    assert sorted(out) == sorted(paths)
    # ESPN snapshots are still tracked, as before.
    assert subprocess.run(["git", "check-ignore", "-q", "data/odds/props/20260927T150000Z_espn.parquet"], cwd=root).returncode == 1


def test_grading_keeps_licensed_rows_out_of_the_public_file(tmp_path, monkeypatch):
    import polars as pl
    from dashboard.odds import grading
    monkeypatch.setattr(grading, "GRADED_DIR", tmp_path)
    monkeypatch.setattr(grading, "LICENSED_DIR", tmp_path / "licensed")
    rows = pl.DataFrame({"season": [2026] * 3, "week": [3] * 3, "source": ["espn", "sgo", "oddsapi"], "line": [1.5, 2.5, 3.5]})
    lic = pl.col("source").is_in(list(grading.LICENSED_SOURCES))
    for part, d in ((rows.filter(~lic), grading.GRADED_DIR), (rows.filter(lic), grading.LICENSED_DIR)):
        d.mkdir(parents=True, exist_ok=True)
        part.write_parquet(d / "lines_2026_03.parquet")
    assert pl.read_parquet(tmp_path / "lines_2026_03.parquet")["source"].to_list() == ["espn"]
    # The site still reads both.
    assert sorted(grading.graded_lines(2026)["source"].to_list()) == ["espn", "oddsapi", "sgo"]
    assert grading.graded_weeks(2026) == {3}
