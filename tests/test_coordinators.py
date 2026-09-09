"""The coordinator scrape and the role-aware coach profiles.

The parser tests are pure -- they run on wikitext fragments taken verbatim
from the pages that broke earlier versions of it, so a regression names the
team that will go missing. The profile tests need the parquet cache.
"""

import polars as pl
import pytest

from data_handling.fetch_coordinators import clean_name, page_title, parse_staff, seasons_to_fetch
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


@pytest.mark.parametrize("raw,expected", [
    # Wikipedia hangs editorial notes off the name. Left on, each one becomes a
    # separate person: Gregg Williams had eleven rows and a twelfth under the
    # dagger, and that orphan lost both his other seasons and the link to his
    # head-coaching record.
    ("[[Matt Canada]]; fired after Week 11", "Matt Canada"),
    ("[[Ken Dorsey]]; fired after Week 10", "Ken Dorsey"),
    ("[[Alan Williams]]; resigned on September 20", "Alan Williams"),
    ("[[Gregg Williams]]\u2020", "Gregg Williams"),
    # A comma is not a cut: this is how his name is spelled on all five of his
    # seasons, and trimming it would split him instead of joining him.
    ("[[Pete Carmichael, Jr]]", "Pete Carmichael, Jr"),
])
def test_editorial_notes_are_not_part_of_a_name(raw, expected):
    assert clean_name(raw) == expected


@pytest.mark.needs_data
def test_a_cache_scraped_before_that_rule_is_healed_on_load():
    """The archive is complete, so the weekly job will never refetch those
    seasons: a published table that is merely wrong would keep the annotation
    for good unless the reader strips it too."""
    if not coaches_mod.have_coordinators():
        pytest.skip("coordinator table not fetched")
    names = coaches_mod.coordinators()["coach"].unique().to_list()
    assert not [n for n in names if ";" in n or "\u2020" in n or "\u2021" in n]
    assert "Pete Carmichael, Jr" in names, "a legitimate suffix must survive"


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


# --- what a run actually covers --------------------------------------------

FULL = set(range(1999, 2027))


def test_a_named_season_is_a_refresh_when_the_archive_is_complete():
    assert seasons_to_fetch([2026], 2026, FULL) == [2026]


def test_the_first_run_backfills_instead_of_shipping_one_season():
    """The weekly job asks for the current season on a runner whose cache came
    from the release. Until a run has uploaded this table there is nothing to
    merge into, and honouring the argument would publish a single season: no
    history, no fingerprints, every coordinator a first-year hire.
    """
    got = seasons_to_fetch([2026], 2026, set())
    assert got[0] == 1999 and got[-1] == 2026 and len(got) == 28


def test_a_one_season_archive_heals_rather_than_staying_broken():
    """This is the case that actually shipped. A run like the one above leaves
    a file behind, so a check for "is there a file" says yes and refreshes 2026
    into a 2026-only archive -- for good. Compare the seasons instead.
    """
    assert len(seasons_to_fetch([2026], 2026, {2026})) == 28


def test_a_gap_in_the_middle_is_filled_too():
    assert seasons_to_fetch([2026], 2026, FULL - {2011, 2012}) == [2011, 2012, 2026]


def test_no_argument_means_the_whole_archive():
    assert seasons_to_fetch([], 2026, FULL) == list(range(1999, 2027))


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
def test_a_coordinator_brings_his_head_coaching_seasons_with_him():
    """The whole reason an ex-head-coach's page was wrong: it showed only the
    seasons under his newest title, so a man with twenty years of offenses read
    as a first-year hire."""
    if not coaches_mod.have_coordinators():
        pytest.skip("coordinator table not fetched")
    hc = coaches_mod.coach_seasons()
    oc = coaches_mod.role_seasons("OC")
    # Sorted, and only men whose head-coaching years are not already inside
    # their coordinator years: an interim promoted in November holds both jobs
    # in one season, and that season is counted once, so he would widen nothing.
    both = sorted(set(oc["coach"].to_list()) & set(hc["coach"].to_list()))
    name = next((n for n in both
                 if hc.filter(pl.col("coach") == n)
                 .join(oc.filter(pl.col("coach") == n).select("season", "team"),
                       on=["season", "team"], how="anti").height > 0), None)
    if name is None:
        pytest.skip("nobody in this cache held both jobs in different seasons")
    own = oc.filter(pl.col("coach") == name).height
    acc = coaches_mod.accountable_seasons(name, "OC")
    assert acc.height > own
    assert set(acc["held"].unique().to_list()) == {"OC", "HC"}


@pytest.mark.needs_data
def test_a_season_held_under_both_jobs_is_counted_once():
    """A coordinator promoted to interim head coach is in both tables for that
    year. It is one season of evidence."""
    if not coaches_mod.have_coordinators():
        pytest.skip("coordinator table not fetched")
    for role in ("OC", "DC"):
        acc = coaches_mod.accountable_all(role)
        if acc.is_empty():
            continue
        keys = acc.select("coach", "season", "team")
        assert keys.height == keys.unique().height, f"{role} double-counts a season"


@pytest.mark.needs_data
def test_holding_the_role_is_what_gets_you_a_page():
    """Head-coaching seasons are supporting evidence for a coordinator, not a
    door for every head coach in the league to appear under OC."""
    if not coaches_mod.have_coordinators():
        pytest.skip("coordinator table not fetched")
    oc_names = set(coaches_mod.role_seasons("OC")["coach"].to_list()) | set(
        n for n, _ in coaches_mod._current_teams("OC").items())
    pure_hc = [n for n in coaches_mod.coach_seasons()["coach"].unique().to_list() if n not in oc_names]
    assert pure_hc, "expected at least one head coach who never held OC"
    assert coaches_mod.accountable_seasons(pure_hc[0], "OC").is_empty()
    assert coaches_mod.staff_profile(pure_hc[0], "OC") is None


@pytest.mark.needs_data
def test_the_list_agrees_with_the_profile():
    """A sidebar saying two years beside a page showing six is worse than
    either number on its own."""
    if not coaches_mod.have_coordinators():
        pytest.skip("coordinator table not fetched")
    rows = [r for r in coaches_mod.staff_list("OC") if r["has_history"]][:25]
    for r in rows:
        prof = coaches_mod.staff_profile(r["coach"], "OC")
        assert prof is not None
        assert r["seasons"] == len({s["season"] for s in prof["seasons"]}), r["coach"]


@pytest.mark.needs_data
def test_head_coach_profile_still_spans_both_sides():
    prof = coaches_mod.staff_profile(coaches_mod.coach_seasons()["coach"][0], "HC")
    assert prof["attribution"] == "game"
    assert {f["side"] for f in prof["fingerprint"]} == {"off", "def"}


def test_which_job_answers_for_which_side():
    assert coaches_mod.accountable_for("HC", "off") and coaches_mod.accountable_for("HC", "def")
    assert coaches_mod.accountable_for("OC", "off") and not coaches_mod.accountable_for("OC", "def")
    assert coaches_mod.accountable_for("DC", "def") and not coaches_mod.accountable_for("DC", "off")


@pytest.mark.needs_data
def test_a_head_coach_brings_his_coordinator_seasons_to_the_right_side_only():
    """The mirror of the coordinator case, and the trap in it: a year spent
    running an offense is evidence about offense. Counting it toward his
    defense would credit him with a unit he never called."""
    if not coaches_mod.have_coordinators():
        pytest.skip("coordinator table not fetched")
    hc = coaches_mod.accountable_all("HC")
    mixed = (hc.filter(pl.col("held") != "HC")["coach"].unique().to_list())
    if not mixed:
        pytest.skip("nobody in this cache has held both jobs")
    name = next((n for n in mixed
                 if {"HC", "OC"} <= set(coaches_mod.accountable_seasons(n, "HC")["held"].to_list())), None)
    if name is None:
        pytest.skip("no head coach with offensive-coordinator history")
    prof = coaches_mod.staff_profile(name, "HC")
    roles = prof["season_roles"]
    want_off = sum(n for r, n in roles.items() if coaches_mod.accountable_for(r, "off"))
    want_def = sum(n for r, n in roles.items() if coaches_mod.accountable_for(r, "def"))
    assert want_off > want_def, "an OC past should widen offence and not defence"
    assert max(f["seasons"] for f in prof["fingerprint"] if f["side"] == "off") == want_off
    assert max(f["seasons"] for f in prof["fingerprint"] if f["side"] == "def") == want_def


@pytest.mark.needs_data
def test_no_season_counts_toward_a_side_it_did_not_answer_for():
    if not coaches_mod.have_coordinators():
        pytest.skip("coordinator table not fetched")
    for role in coaches_mod.ROLES:
        acc = coaches_mod.accountable_all(role)
        if acc.is_empty():
            continue
        held = set(acc["held"].unique().to_list())
        # Every job present must answer for at least one side the page shows.
        assert all(any(coaches_mod.accountable_for(h, sd) for sd in coaches_mod.ROLE_SIDES[role]) for h in held)


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
