import polars as pl
import pytest

from nfl.teams import (
    ALIASES, EXPANSION_ELO, FRANCHISES, RELOCATIONS, UnknownTeam,
    ERA_OVERRIDES, canonical_team, canonical_team_expr, canonicalize,
    dedupe_team_table, franchise_ids, initial_elo, is_active, team_info,
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


# --- pre-1999 abbreviations found by the dataset sweep ---------------------

@pytest.mark.parametrize("abbr,expected", [
    ("PHX", "ARI"),   # Phoenix Cardinals, rosters_weekly.draft_club
    ("PHO", "ARI"),   # Phoenix Cardinals, draft_picks
    ("RAM", "LA"),    # Los Angeles Rams pre-1995, draft_picks
    ("RAI", "LV"),    # Los Angeles Raiders
])
def test_defunct_abbreviations_map(abbr, expected):
    assert canonical_team(abbr) == expected


@pytest.mark.parametrize("abbr,season,expected", [
    ("HOU", 1993, "TEN"),   # Houston Oilers -> Titans lineage
    ("HOU", 1996, "TEN"),   # last Oilers season
    ("HOU", 2002, "HOU"),   # Texans, a different franchise entirely
    ("STL", 1985, "ARI"),   # St. Louis Cardinals
    ("STL", 1987, "ARI"),
    ("STL", 2005, "LA"),    # St. Louis Rams
    ("BAL", 1981, "IND"),   # Baltimore Colts
    ("BAL", 2000, "BAL"),   # Ravens
])
def test_era_collisions_resolve_by_season(abbr, season, expected):
    assert canonical_team(abbr, season) == expected


def test_era_overrides_never_fire_inside_the_modelling_window():
    """The invariant that makes this change safe: every cutoff predates 1999,
    so passing a season can never alter a result for 1999+ data."""
    assert all(cutoff < 1999 for cutoff, _ in ERA_OVERRIDES.values())
    for abbr in ERA_OVERRIDES:
        for season in (1999, 2005, 2026):
            assert canonical_team(abbr, season) == canonical_team(abbr)


def test_season_is_optional_and_default_is_the_modern_meaning():
    assert canonical_team("HOU") == "HOU"
    assert canonical_team("STL") == "LA"
    assert canonical_team("BAL") == "BAL"


def test_cleveland_is_never_remapped():
    """The Browns' history stayed in Cleveland through the 1996-98 gap; the
    Ravens are a 1996 expansion team. CLE -> CLE in every era."""
    assert "CLE" not in ERA_OVERRIDES
    for season in (1985, 1995, 1999, 2026):
        assert canonical_team("CLE", season) == "CLE"


def test_expr_applies_era_overrides_row_by_row():
    df = pl.DataFrame({
        "season": [1993, 2002, 1985, 2005, 1981, 2000],
        "team": ["HOU", "HOU", "STL", "STL", "BAL", "BAL"],
    })
    got = df.with_columns(canonical_team_expr("team", season="season").alias("f"))
    assert got["f"].to_list() == ["TEN", "HOU", "ARI", "LA", "IND", "BAL"]


def test_expr_without_season_uses_modern_meaning():
    df = pl.DataFrame({"season": [1993], "team": ["HOU"]})
    got = df.with_columns(canonical_team_expr("team").alias("f"))
    assert got["f"].to_list() == ["HOU"]


def test_canonicalize_rejects_a_missing_season_column():
    df = pl.DataFrame({"team": ["HOU"]})
    with pytest.raises(KeyError):
        canonicalize(df, "team", season="season")
