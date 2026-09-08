import polars as pl

from nfl.games import build_game_spine, team_games, upcoming


def test_relocated_home_team_is_canonicalised(raw_schedules):
    """A 2005 Rams home game must land under the same id as a 2026 Rams game."""
    spine = build_game_spine(raw_schedules)
    assert spine.filter(pl.col("game_id") == "2005_01_SEA_STL")["home"][0] == "LA"
    assert spine.filter(pl.col("game_id") == "2005_01_NE_OAK")["home"][0] == "LV"


def test_margin_is_home_minus_away(raw_schedules):
    spine = build_game_spine(raw_schedules)
    row = spine.filter(pl.col("game_id") == "2005_01_SEA_STL")
    assert row["margin"][0] == -14        # home 10, away 24
    assert row["home_score"][0] == 10


def test_margin_recomputed_when_result_missing(raw_schedules):
    df = raw_schedules.with_columns(pl.lit(None, dtype=pl.Int64).alias("result"))
    spine = build_game_spine(df)
    played = spine.filter(pl.col("played")).sort("game_id")
    assert played["margin"].to_list() == [7, -14]   # NE_OAK, then SEA_STL


def test_unplayed_game_keeps_its_line_but_has_no_margin(raw_schedules):
    """This is what makes Week 1 predictable before kickoff."""
    spine = build_game_spine(raw_schedules)
    future = spine.filter(pl.col("game_id") == "2026_01_NE_SEA")
    assert future["played"][0] is False
    assert future["margin"][0] is None
    assert future["spread_line"][0] == 3.5


def test_flags_and_derived_columns(raw_schedules):
    spine = build_game_spine(raw_schedules)
    oak = spine.filter(pl.col("game_id") == "2005_01_NE_OAK")
    assert oak["neutral"][0] is True
    assert oak["div_game"][0] is False
    assert oak["rest_diff"][0] == -3       # home 7 - away 10
    assert spine["is_regular"].all()


def test_gameday_parsed_to_date(raw_schedules):
    spine = build_game_spine(raw_schedules)
    assert spine.schema["gameday"] == pl.Date


def test_sorted_by_season_week(raw_schedules):
    spine = build_game_spine(raw_schedules)
    assert spine["season"].to_list() == sorted(spine["season"].to_list())


def test_team_games_has_two_rows_per_game_with_flipped_margin(raw_schedules):
    spine = build_game_spine(raw_schedules)
    tg = team_games(spine)
    assert tg.height == 2 * spine.height

    g = tg.filter(pl.col("game_id") == "2005_01_SEA_STL").sort("is_home")
    away, home = g.row(0, named=True), g.row(1, named=True)
    assert home["team"] == "LA" and home["margin"] == -14
    assert away["team"] == "SEA" and away["margin"] == 14
    assert home["opponent"] == "SEA" and away["opponent"] == "LA"
    assert home["points_for"] == 10 and away["points_for"] == 24


def test_upcoming_returns_only_unplayed(raw_schedules):
    spine = build_game_spine(raw_schedules)
    assert upcoming(spine, 2026, 1)["game_id"].to_list() == ["2026_01_NE_SEA"]
    assert upcoming(spine, 2005, 1).height == 0


# --- kickoff -----------------------------------------------------------------

def test_kickoff_is_utc_from_eastern_wall_clock(raw_schedules):
    """nflverse `gametime` is Eastern. 16:05 EDT on 2005-09-11 is 20:05 UTC."""
    spine = build_game_spine(raw_schedules)
    assert spine.schema["kickoff"] == pl.Datetime("us", "UTC")
    row = spine.filter(pl.col("game_id") == "2005_01_SEA_STL")
    assert str(row["kickoff"][0]) == "2005-09-11 20:05:00+00:00"


def test_primetime_kickoff_crosses_midnight_in_utc(raw_schedules):
    """A 20:20 ET kickoff is the *next* calendar day in UTC. Anything that
    compares kickoff to a date rather than a datetime gets this wrong."""
    spine = build_game_spine(raw_schedules)
    row = spine.filter(pl.col("game_id") == "2026_01_NE_SEA")
    assert str(row["kickoff"][0]) == "2026-09-10 00:20:00+00:00"
    assert row["gameday"][0].isoformat() == "2026-09-09"


def test_null_gametime_leaves_kickoff_null_not_midnight(raw_schedules):
    df = raw_schedules.with_columns(gametime=pl.Series(["16:05", None, "20:20"]))
    spine = build_game_spine(df)
    assert spine.filter(pl.col("game_id") == "2005_01_NE_OAK")["kickoff"][0] is None
    assert spine["kickoff"].null_count() == 1


def test_spine_without_gametime_column_still_builds(raw_schedules):
    spine = build_game_spine(raw_schedules.drop("gametime"))
    assert "kickoff" in spine.columns
    assert spine["kickoff"].null_count() == spine.height
