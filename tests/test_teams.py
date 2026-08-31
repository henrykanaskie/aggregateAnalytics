import polars as pl
import pytest

from nfl.teams import (
    ALIASES, EXPANSION_ELO, FRANCHISES, RELOCATIONS, UnknownTeam,
    canonical_team, canonical_team_expr, canonicalize, dedupe_team_table,
    franchise_ids, initial_elo, is_active, team_info,
)
from tests.conftest import SCHEDULE_ABBREVIATIONS


def test_thirty_two_franchises_total():
    assert len(FRANCHISES) == 32


@pytest.mark.parametrize("season", range(2002, 2027))
def test_thirty_two_franchises_every_season_from_2002(season):
    """The roadmap's stated acceptance criterion for canonical_team()."""
    assert len(franchise_ids(season)) == 32


@pytest.mark.parametrize("season", [1999, 2000, 2001])
def test_thirty_one_franchises_before_houston(season):
    assert len(franchise_ids(season)) == 31
    assert "HOU" not in franchise_ids(season)


def test_every_real_schedule_abbreviation_maps():
    """Nothing nflverse actually emits may fall through."""
    unmapped = [a for a in SCHEDULE_ABBREVIATIONS if a not in ALIASES]
    assert unmapped == []


def test_thirty_five_abbreviations_collapse_to_thirty_two_franchises():
    resolved = {canonical_team(a) for a in SCHEDULE_ABBREVIATIONS}
    assert len(SCHEDULE_ABBREVIATIONS) == 35
    assert len(resolved) == 32


@pytest.mark.parametrize(
    "old,new",
    [("STL", "LA"), ("LAR", "LA"), ("SD", "LAC"), ("SDG", "LAC"),
     ("OAK", "LV"), ("LVR", "LV")],
)
def test_relocations_collapse(old, new):
    """The whole point: a franchise keeps one rating across a move."""
    assert canonical_team(old) == canonical_team(new) == new


def test_relocation_table_is_consistent_with_aliases():
    for modern, (historic, _year) in RELOCATIONS.items():
        assert canonical_team(historic) == modern


def test_aliases_resolve_to_real_franchise_ids():
    assert set(ALIASES.values()) == set(FRANCHISES)


def test_no_franchise_id_is_an_alias_of_another():
    for fid in FRANCHISES:
        assert ALIASES[fid] == fid


def test_unknown_team_raises_by_default():
    with pytest.raises(UnknownTeam):
        canonical_team("XYZ")
    with pytest.raises(UnknownTeam):
        canonical_team(None)


def test_unknown_team_returns_none_when_not_strict():
    assert canonical_team("XYZ", strict=False) is None
    assert canonical_team(None, strict=False) is None


def test_case_and_whitespace_insensitive():
    assert canonical_team(" stl ") == "LA"
    assert canonical_team("Sd") == "LAC"


def test_expr_matches_scalar():
    df = pl.DataFrame({"t": SCHEDULE_ABBREVIATIONS})
    got = df.select(canonical_team_expr("t"))["t"].to_list()
    assert got == [canonical_team(a) for a in SCHEDULE_ABBREVIATIONS]


def test_expr_strict_raises_on_unknown():
    df = pl.DataFrame({"t": ["STL", "XYZ"]})
    with pytest.raises(Exception):
        df.select(canonical_team_expr("t"))


def test_canonicalize_rewrites_only_present_columns():
    df = pl.DataFrame({"home_team": ["STL"], "away_team": ["SD"], "other": [1]})
    out = canonicalize(df, "home_team", "away_team", "missing_col")
    assert out["home_team"].to_list() == ["LA"]
    assert out["away_team"].to_list() == ["LAC"]
    assert out["other"].to_list() == [1]


def test_is_active():
    assert not is_active("HOU", 2001)
    assert is_active("HOU", 2002)
    assert is_active("STL", 1999)   # via canonical LA


def test_expansion_team_starts_below_average():
    assert initial_elo("HOU", 2002) == EXPANSION_ELO
    assert initial_elo("HOU", 2003) == 1500.0
    assert initial_elo("DAL", 2002) == 1500.0
    # 1999 is the start of the data window, not an expansion year
    assert initial_elo("CLE", 1999) == 1500.0


# --- team metadata: the duplicate-row hazard -------------------------------

def test_dedupe_collapses_duplicate_franchise_rows(raw_teams):
    out = dedupe_team_table(raw_teams)
    assert raw_teams.height == 8
    assert out.height == 4                      # LA, LAC, LV, SEA
    assert out["franchise"].n_unique() == 4


def test_dedupe_keeps_the_modern_name(raw_teams):
    out = dedupe_team_table(raw_teams)
    names = dict(zip(out["franchise"], out["team_name"]))
    assert names["LA"] == "Los Angeles Rams"        # not "St. Louis Rams"
    assert names["LAC"] == "Los Angeles Chargers"   # not "San Diego Chargers"
    assert names["LV"] == "Las Vegas Raiders"       # not "Oakland Raiders"


def test_joining_raw_teams_inflates_rows_but_team_info_does_not(raw_teams):
    """The bug, demonstrated, then shown fixed.

    Naively canonicalising `teams` and joining gives a Rams game three rows.
    """
    games = pl.DataFrame({"game_id": ["g1", "g2"], "home": ["LA", "SEA"]})

    naive = games.join(
        raw_teams.with_columns(canonical_team_expr("team_abbr").alias("home")),
        on="home", how="left",
    )
    assert naive.height == 4          # the Rams game silently became three rows

    fixed = games.join(
        dedupe_team_table(raw_teams), left_on="home", right_on="franchise", how="left",
    )
    assert fixed.height == games.height == 2


def test_team_info_rejects_a_table_that_is_not_all_32(raw_teams):
    with pytest.raises(AssertionError):
        team_info(raw_teams)          # fixture only covers 4 franchises
