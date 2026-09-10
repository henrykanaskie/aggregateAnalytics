"""Time-zone and surface context, checked on hand-built schedules."""

import polars as pl

from nfl.context import game_context, surface_kind, venue_tz, HOME_TZ


def _sched(rows):
    base = {"season": 2025, "gameday": "2025-11-02", "gametime": "13:00", "location": "Home", "stadium": None, "surface": "grass"}
    return pl.DataFrame([{**base, **r} for r in rows])


def test_surface_kinds():
    assert surface_kind("grass") == "grass"
    assert surface_kind("dessograss") == "grass"
    assert surface_kind("fieldturf") == "turf"
    assert surface_kind("a_turf") == "turf"
    assert surface_kind("") is None and surface_kind(None) is None


def test_west_coast_team_at_an_early_eastern_kickoff():
    ctx = game_context(_sched([{"game_id": "2025_09_SEA_WAS", "home_team": "WAS", "away_team": "SEA", "stadium": "Northwest Stadium"}]))
    r = ctx.row(0, named=True)
    assert r["venue_tz"] == "America/New_York" and r["away_tz"] == "America/Los_Angeles"
    assert r["away_tz_shift"] == 3 and r["away_travel_east"] is True
    assert r["away_body_hour"] == 10.0      # 1 pm Eastern is 10 am to a Seattle body
    assert r["home_body_hour"] == 13.0 and r["kickoff_venue_hour"] == 13.0


def test_arizona_keeps_standard_time_all_year():
    # In November Denver is back on standard time and agrees with Phoenix;
    # in July Denver is an hour ahead, so Phoenix sits an hour west of it.
    nov = game_context(_sched([{"game_id": "a", "home_team": "ARI", "away_team": "DEN", "stadium": "State Farm Stadium", "gameday": "2025-11-02"}])).row(0, named=True)
    jul = game_context(_sched([{"game_id": "b", "home_team": "ARI", "away_team": "DEN", "stadium": "State Farm Stadium", "gameday": "2025-07-15"}])).row(0, named=True)
    assert nov["away_tz_shift"] == 0 and jul["away_tz_shift"] == -1


def test_london_game_is_east_of_both_teams():
    ctx = game_context(_sched([{"game_id": "2025_05_MIN_CLE", "home_team": "CLE", "away_team": "MIN", "location": "Neutral", "stadium": "Tottenham Stadium", "gametime": "09:30", "gameday": "2025-10-05"}]))
    r = ctx.row(0, named=True)
    assert r["venue_tz"] == "Europe/London"
    assert r["kickoff_venue_hour"] == 14.5          # 9:30 Eastern is 2:30 pm in London
    assert r["home_tz_shift"] == 5 and r["away_tz_shift"] == 6


def test_relocated_franchises_use_their_city_of_the_day():
    assert HOME_TZ["STL"] == "America/Chicago" and HOME_TZ["LA"] == "America/Los_Angeles"
    assert HOME_TZ["SD"] == HOME_TZ["LAC"] and HOME_TZ["OAK"] == HOME_TZ["LV"]


def test_us_neutral_site_resolves_to_its_tenant():
    sched = _sched([
        {"game_id": "h", "home_team": "ARI", "away_team": "SF", "stadium": "State Farm Stadium"},
        {"game_id": "sb", "home_team": "KC", "away_team": "PHI", "location": "Neutral", "stadium": "State Farm Stadium"},
    ])
    assert venue_tz("State Farm Stadium", "KC", {"State Farm Stadium": "America/Phoenix"}) == "America/Phoenix"
    r = game_context(sched).filter(pl.col("game_id") == "sb").row(0, named=True)
    assert r["venue_tz"] == "America/Phoenix" and r["home_tz_shift"] == -1


def test_surface_change_reads_against_the_visitors_usual_surface():
    sched = _sched([
        {"game_id": "a1", "home_team": "NO", "away_team": "ATL", "surface": "sportturf"},
        {"game_id": "a2", "home_team": "NO", "away_team": "TB", "surface": "sportturf"},
        {"game_id": "g1", "home_team": "GB", "away_team": "CHI", "surface": "grass"},
        {"game_id": "x", "home_team": "NO", "away_team": "GB", "surface": "sportturf"},
    ])
    r = game_context(sched).filter(pl.col("game_id") == "x").row(0, named=True)
    assert r["venue_surface"] == "turf" and r["away_usual_surface"] == "grass"
    assert r["away_surface_change"] is True and r["home_surface_change"] is False
