"""The coordinator scrape and the role-aware coach profiles.

The parser tests are pure -- they run on wikitext fragments taken verbatim
from the pages that broke earlier versions of it, so a regression names the
team that will go missing. The profile tests need the parquet cache.
"""

import polars as pl
import pytest

from data_handling.fetch_coordinators import clean_name, page_title, parse_staff
from dashboard.stats import coaches as coaches_mod


# --- the wikitext parser ----------------------------------------------------

def test_plain_staff_lines():
    staff, found = parse_staff("==Staff==\n*Offensive coordinator – [[Alex Van Pelt]]\n"
                               "*Defensive coordinator – [[DeMarcus Covington]]\n")
    assert found
    assert staff["OC"] == [("Alex Van Pelt", "Offensive coordinator")]
    assert staff["DC"] == [("DeMarcus Covington", "Defensive coordinator")]


@pytest.mark.parametrize("line,role,name", [
    # A coordinator who also holds another job: 2004 Packers, 2025 Giants,
    # 2025 Raiders. Splitting the title on "/" is what makes these readable.
    ("* Assistant head coach/Defensive coordinator – [[Bob Slowik]]", "DC", "Bob Slowik"),
    ("*Interim defensive coordinator/outside linebackers – [[Charlie Bullen]]", "DC", "Charlie Bullen"),
    ("*Interim offensive coordinator/quarterbacks – [[Greg Olson (American football)|Greg Olson]]", "OC", "Greg Olson"),
    ("*Offensive coordinator/tight ends – [[Tim Kelly (American football)|Tim Kelly]]", "OC", "Tim Kelly"),
    # Washington links the job title itself.
    ("* [[Offensive coordinator]] – [[David Blough]]", "OC", "David Blough"),
    # An em dash and a spaced hyphen both appear in the older articles.
    ("* Offensive coordinator — [[Ernie Zampese]]", "OC", "Ernie Zampese"),
    ("* Defensive coordinator - [[Steve Sidwell]]", "DC", "Steve Sidwell"),
])
def test_titles_that_still_mean_coordinator(line, role, name):
    staff, _ = parse_staff("==Staff==\n" + line)
    assert [n for n, _ in staff[role]] == [name]


@pytest.mark.parametrize("line", [
    # Different jobs that merely contain the word. Folding these in would
    # credit an offense's identity to its running-backs coach.
    "* Assistant offensive coordinator – [[Nobody At All]]",
    "* Run game coordinator/offensive line – [[Kevin Carberry]]",
    "* Pass game coordinator – [[Kefense Hynson]]",
    "* Offensive quality control coordinator – [[Someone Else]]",
    "* Special teams coordinator – [[Dave Toub]]",
    "* Strength and conditioning coordinator – [[Evan Marcus]]",
])
def test_titles_that_do_not(line):
    staff, _ = parse_staff("==Staff==\n" + line)
    assert staff["OC"] == [] and staff["DC"] == []


def test_vacancy_is_not_the_same_as_an_unread_page():
    """Belichick's 2010 Patriots had neither coordinator. The staff section was
    found, so downstream can record a verified vacancy rather than a gap."""
    staff, found = parse_staff("==Staff==\n* Head coach – [[Bill Belichick]]\n"
                               "* Defensive backs – [[Corwin Brown]]\n")
    assert found and staff["OC"] == [] and staff["DC"] == []
    assert parse_staff("A page with no staff section at all.")[1] is False


def test_co_coordinators_keep_their_order():
    staff, _ = parse_staff("==Staff==\n*Co-offensive coordinator – [[First Named]]\n"
                           "*Co-offensive coordinator – [[Second Named]]\n")
    assert [n for n, _ in staff["OC"]] == ["First Named", "Second Named"]


def test_clean_name_drops_disambiguation_and_asides():
    assert clean_name("[[Scott Turner (American football coach)|Scott Turner]]") == "Scott Turner"
    assert clean_name("[[Mike Kafka]] ''(interim)''") == "Mike Kafka"


@pytest.mark.parametrize("team,season,expected", [
    ("LV", 2005, "2005 Oakland Raiders season"),
    ("LV", 2021, "2021 Las Vegas Raiders season"),
    ("LA", 2015, "2015 St. Louis Rams season"),
    ("LAC", 2016, "2016 San Diego Chargers season"),
    ("WAS", 2019, "2019 Washington Redskins season"),
    ("WAS", 2020, "2020 Washington Football Team season"),
    ("WAS", 2022, "2022 Washington Commanders season"),
])
def test_page_titles_follow_the_franchise_of_the_day(team, season, expected):
    """A relocation renames the article, so asking for the current name would
    quietly return nothing for every season before the move."""
    assert page_title(team, season) == expected


# --- the profiles built on top ---------------------------------------------

@pytest.mark.needs_data
def test_role_vocabulary_is_consistent():
    assert set(coaches_mod.ROLES) == set(coaches_mod.ROLE_SIDES) == set(coaches_mod.ROLE_LABEL)
    assert coaches_mod.ROLE_SIDES["OC"] == ("off",)
    assert coaches_mod.ROLE_SIDES["DC"] == ("def",)


@pytest.mark.needs_data
def test_unknown_role_is_rejected():
    with pytest.raises(ValueError):
        coaches_mod.role_seasons("ST")


@pytest.mark.needs_data
def test_coordinator_rows_are_named_and_dated():
    if not coaches_mod.have_coordinators():
        pytest.skip("coordinator table not fetched")
    co = coaches_mod.coordinators()
    assert co["coach"].null_count() == 0, "vacancies must be dropped, not carried as null names"
    assert set(co["role"].unique()) <= {"OC", "DC"}
    assert co["season"].min() >= 1999


@pytest.mark.needs_data
def test_a_coordinator_is_only_graded_on_his_own_side():
    """The whole point of separating the roles: an OC's fingerprint must not
    average in the ranks of a defense he had nothing to do with."""
    if not coaches_mod.have_coordinators():
        pytest.skip("coordinator table not fetched")
    oc = coaches_mod.coordinator_seasons().filter(pl.col("role") == "OC")
    if oc.is_empty():
        pytest.skip("no OC seasons")
    name = oc["coach"][0]
    prof = coaches_mod.staff_profile(name, "OC")
    assert prof is not None
    assert {f["side"] for f in prof["fingerprint"]} <= {"off"}
    dc_name = coaches_mod.coordinator_seasons().filter(pl.col("role") == "DC")["coach"][0]
    assert {f["side"] for f in coaches_mod.staff_profile(dc_name, "DC")["fingerprint"]} <= {"def"}


@pytest.mark.needs_data
def test_head_coach_profile_still_spans_both_sides():
    prof = coaches_mod.staff_profile(coaches_mod.coach_seasons()["coach"][0], "HC")
    assert prof["attribution"] == "game"
    assert {f["side"] for f in prof["fingerprint"]} == {"off", "def"}


@pytest.mark.needs_data
def test_coordinator_seasons_match_the_team_season():
    """A coordinator is dated by season, so his numbers must be exactly the
    team's -- not a subset of its games, the way a fired head coach's are."""
    if not coaches_mod.have_coordinators():
        pytest.skip("coordinator table not fetched")
    cs = coaches_mod.coordinator_seasons()
    row = cs.filter(pl.col("epa_play").is_not_null()).head(1).to_dicts()[0]
    team_season = coaches_mod.season_ranks().filter(
        (pl.col("season") == row["season"]) & (pl.col("team") == row["team"])).to_dicts()[0]
    assert row["epa_play"] == pytest.approx(team_season["epa_play"])
    assert row["epa_play_rank"] == team_season["epa_play_rank"]


@pytest.mark.needs_data
def test_missing_cache_is_survivable():
    """The dashboard predates this table and has to serve without it."""
    assert isinstance(coaches_mod.have_coordinators(), bool)
    assert coaches_mod.role_seasons("HC").height > 0


def test_a_table_that_arrives_after_boot_is_picked_up(tmp_path, monkeypatch):
    """The failure this guards against is silent and lasts for the life of the
    process: an API server that starts while the scrape is still running --
    which is the normal order, since the weekly refresh writes this file long
    after the app is up -- used to memoise "there is no table" and go on
    telling every visitor to run a command they had already run.
    """
    missing = tmp_path / "coordinators.parquet"
    monkeypatch.setattr(coaches_mod, "dataset_path", lambda name: missing)
    coaches_mod._read_coordinators.cache_clear()
    assert coaches_mod.have_coordinators() is False

    pl.DataFrame({"season": pl.Series([2026], dtype=pl.Int32), "team": ["KC"], "role": ["OC"],
                  "coach": ["Someone Named"], "title": ["Offensive coordinator"],
                  "slot": pl.Series([0], dtype=pl.Int32)}).write_parquet(missing)
    monkeypatch.setattr(coaches_mod, "scan", lambda name: pl.scan_parquet(missing))
    assert coaches_mod.have_coordinators() is True
    assert coaches_mod.coordinators()["coach"].to_list() == ["Someone Named"]
    coaches_mod._read_coordinators.cache_clear()
