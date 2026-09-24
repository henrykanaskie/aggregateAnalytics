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
    assert ag._verdict(4.4, 4.4, "up") == "miss"      # a tie did not move the way it said
    assert ag._verdict(None, 4.4, "up") is None


def test_every_call_is_a_hit_or_a_miss():
    """No margin: a small move the way the angle said is a hit, a small move
    the other way a miss. Nothing drops out of the record for being close."""
    assert ag._verdict(0.071, 0.070, "up", "pct") == "hit"
    assert ag._verdict(0.069, 0.070, "up", "pct") == "miss"
    assert ag._verdict(62.0, 60.0, "up", "dec1") == "hit"
    assert ag._verdict(59.9, 60.0, "up", "dec1") == "miss"
    # Exactly on a whole-number line is a miss: neither side came in.
    assert ag.line_verdict("push", "up") == "miss" and ag.line_verdict("push", "down") == "miss"


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


def test_a_played_games_angles_are_served_from_the_file(monkeypatch):
    """The matchup page reads a played game's angles back instead of
    rescanning play-by-play for every key player."""
    import polars as pl
    base = {k: None for k in ag.SCHEMA} | {"season": 2026, "week": 1, "game_id": "2026_01_NE_SEA",
                                           "strength": 1, "tags": ["rushing"], "lean": "under"}
    df = pl.DataFrame([
        base | {"offense": "NE", "defense": "SEA", "kind": "player", "title": "A vs stacked boxes",
                "player_id": "1", "player": "A", "position": "RB", "verdict": "hit"},
        base | {"offense": "SEA", "defense": "NE", "kind": "player", "title": "B vs man coverage",
                "player_id": "2", "player": "B", "position": "WR", "verdict": None},
        base | {"offense": "NE", "defense": "SEA", "kind": "team", "title": "Heavy boxes vs the run", "verdict": "miss"},
    ], schema=ag.SCHEMA)
    monkeypatch.setattr(ag, "_fresh", lambda: df)
    got = ag.pregame("2026_01_NE_SEA")
    assert set(got) == {"NE", "SEA"}
    # Ungraded angles come back too: they are what the page showed.
    assert [a["title"] for a in got["SEA"]] == ["B vs man coverage"]
    assert got["NE"][0]["tags"] == ["rushing"] and got["NE"][0]["defense"] == "SEA"
    assert ag.pregame("2026_01_NOPE") is None
    # The review panel only wants the ones with a verdict.
    assert [r["title"] for r in ag.for_game("2026_01_NE_SEA")] == ["A vs stacked boxes", "Heavy boxes vs the run"]


def test_every_family_says_why_it_should_work():
    """Opening a row of the track record shows the case for that kind of
    angle; a family without one opens to a record and no reason."""
    try:
        g = ag.graded()
    except FileNotFoundError:
        pytest.skip("no graded angles")
    fams = g.filter(g["verdict"].is_not_null()).select("family", "lean").unique().to_dicts()
    missing = sorted({(f["family"], f["lean"]) for f in fams if ag.why(f["family"], f["lean"]) is None})
    assert not missing, missing


def test_a_family_opens_to_the_games_behind_its_record(monkeypatch):
    import polars as pl
    base = {k: None for k in ag.SCHEMA} | {"season": 2026, "kind": "player", "family": "{player} vs stacked boxes",
                                           "lean": "under", "strength": 1, "tags": [], "direction": "down",
                                           "fmt": "dec1", "measure": "yards / carry", "baseline_label": "his previous 16 games",
                                           "offense": "NE", "defense": "SEA", "position": "RB", "detail": "d"}
    df = pl.DataFrame([
        base | {"week": 1, "game_id": "2026_01_NE_SEA", "player": "A", "player_id": "a", "title": "A vs stacked boxes", "verdict": "hit", "line_result": "under"},
        base | {"week": 2, "game_id": "2026_02_NE_SEA", "player": "A", "player_id": "a", "title": "A vs stacked boxes", "verdict": "miss", "line_result": "over"},
        # Same title leaning the other way is a different call.
        base | {"week": 2, "game_id": "2026_02_NE_SEA", "player": "C", "player_id": "c", "title": "C vs stacked boxes", "verdict": "hit", "lean": "over"},
    ], schema=ag.SCHEMA)
    monkeypatch.setattr(ag, "_fresh", lambda: df)
    monkeypatch.setattr(ag, "CURRENT_SEASON", 2026)
    r = ag.family_record("{player} vs stacked boxes", "player", "under")
    assert (r["n"], r["hits"]) == (2, 1) and "pushes" not in r
    assert r["prop"] == {"n": 2, "agreed": 1}
    assert [x["week"] for x in r["rows"]] == [2, 1]             # newest first
    assert all(x["said"] for x in r["rows"]) and r["why"]
    assert r["graded_on"]["measure"] == "yards / carry"


def test_the_premise_adds_up_across_games():
    """A stacked-box record says how often the box was actually stacked, and
    counts a game toward "where it happened" only when it did."""
    ig = lambda on, on_sum, off, off_sum: {"snaps": on, "of": on + off, "label": "8+ box", "unit": "yards a carry",
                                           "on_n": on, "on_sum": on_sum, "off_n": off, "off_sum": off_sum}
    rows = [{"verdict": "hit", "in_game": ig(0, 0.0, 13, 33.0)},
            {"verdict": "hit", "in_game": ig(4, 6.0, 16, 80.0)},
            {"verdict": "miss", "in_game": ig(2, 10.0, 10, 50.0)},
            {"verdict": "hit", "in_game": None}]
    p = ag._premise_total(rows)
    assert (p["snaps"], p["of"], p["games"], p["never"]) == (6, 45, 3, 1)
    assert p["on"] == pytest.approx(16 / 6) and p["off"] == pytest.approx(163 / 39)


def test_only_box_and_blitz_angles_have_a_premise():
    assert ag.in_game({"family": "Pass-heavy offense into a stingy pass defense"}) is None


def test_box_angles_only_count_games_where_the_box_showed_up(monkeypatch):
    """0 of 13 carries into a stacked box: the back's slow day is not the
    stacked-box call coming true, so it counts neither way."""
    import polars as pl
    base = {k: None for k in ag.SCHEMA} | {"season": 2026, "week": 1, "kind": "player", "family": "{player} vs stacked boxes",
                                           "lean": "under", "strength": 1, "tags": [], "direction": "down", "fmt": "dec1", "title": "A vs stacked boxes", "offense": "NE", "defense": "SEA",
                                           "baseline_label": "his previous 16 games", "baseline": 5.0, "actual": 3.0}
    df = ag._with_margin(pl.DataFrame([
        base | {"game_id": "a", "premise_snaps": 0, "premise_of": 13},     # right on the number, box never stacked
        base | {"game_id": "b", "premise_snaps": 3, "premise_of": 20},     # box stacked: a real hit
        base | {"game_id": "c", "premise_snaps": None},                    # not charted: graded on the game as before
        base | {"game_id": "d", "premise_snaps": 0, "actual": None},       # did not play: still no verdict
    ], schema=ag.SCHEMA))
    assert df["verdict"].to_list() == [ag.ABSENT, "hit", "hit", None]
    monkeypatch.setattr(ag, "_fresh", lambda: df)
    monkeypatch.setattr(ag, "CURRENT_SEASON", 2026)
    t = ag.track_record()
    assert (t["n"], t["hits"], t["absent"]) == (2, 2, 1)


def test_only_box_angles_store_a_premise():
    assert ag._premise_cols({"family": "{player} vs the blitz"}) == {"premise_snaps": None, "premise_of": None}
    assert ag._premise_cols({"family": "Pass-heavy offense into a stingy pass defense"})["premise_snaps"] is None


def test_line_verdict_is_the_line_going_the_way_the_angle_leaned():
    assert ag.line_verdict("over", "up") == "hit" and ag.line_verdict("under", "down") == "hit"
    assert ag.line_verdict("over", "down") == "miss" and ag.line_verdict("push", "up") == "miss"
    assert ag.line_verdict(None, "up") is None


def _fake_lines(monkeypatch, by_game):
    """Closing lines per game, as _game_lines returns them."""
    monkeypatch.setattr(ag, "_game_lines", lambda season, week, gid: tuple(
        {"player_id": f"{gid}{i}", "player_name": n, "team": t, "position": pos, "market": mk, "line": ln, "actual": act}
        for i, (n, t, pos, mk, ln, act) in enumerate(by_game.get(gid, []))))


def test_track_record_counts_each_player_line_as_a_call(monkeypatch):
    """A team angle is read as its players' lines one by one, not the
    position's lines added up: two backs, one under and one over, are one
    right and one wrong, whatever their total did."""
    import polars as pl
    base = {k: None for k in ag.SCHEMA} | {"season": 2026, "week": 1, "kind": "team", "family": "{def} has clamped RBs",
                                           "lean": "under", "strength": 1, "tags": ["RB"], "direction": "down", "offense": "CIN",
                                           "defense": "CLE", "fmt": "dec1", "baseline_label": "CIN's usual", "measure": "RB rushing yards"}
    df = ag._with_margin(pl.DataFrame([
        base | {"game_id": "A", "actual": 60.0, "baseline": 90.0},     # hit on the average
        base | {"game_id": "B", "actual": 80.0, "baseline": 90.0},     # hit
        base | {"game_id": "C", "actual": 99.0, "baseline": 90.0},     # miss, no lines
    ], schema=ag.SCHEMA))
    _fake_lines(monkeypatch, {
        "A": [("Back One", "CIN", "RB", "player_rush_yds", 55.5, 40.0), ("Back Two", "CIN", "RB", "player_rush_yds", 20.5, 20.0),
              ("A Receiver", "CIN", "WR", "player_reception_yds", 50.5, 10.0),      # not a rushing line: not this angle's
              ("Their Back", "CLE", "RB", "player_rush_yds", 60.5, 10.0)],          # the other side: not this angle's
        "B": [("Back One", "CIN", "RB", "player_rush_yds", 55.5, 70.0)],
    })
    monkeypatch.setattr(ag, "_fresh", lambda: df)
    monkeypatch.setattr(ag, "CURRENT_SEASON", 2026)
    t = ag.track_record()
    assert (t["n"], t["hits"]) == (3, 2) and (t["line_n"], t["line_hits"]) == (3, 2)
    fam = t["families"][0]
    assert (fam["line_n"], fam["line_hits"]) == (3, 2)
    r = ag.family_record("{def} has clamped RBs", "team", "under")
    assert [ln["player"] for ln in r["rows"][-1]["lines"]] == ["Back One", "Back Two"]
    assert r["prop"] == {"n": 3, "agreed": 2}


def test_a_team_angle_points_at_the_right_lines():
    assert ag.line_targets("Heavy boxes vs the run", ["rushing"]) == ("off", [("player_rush_yds", ("RB",))])
    assert ag.line_targets("{def} has clamped WRs", ["WR"]) == ("off", [("player_reception_yds", ("WR",))])
    assert ag.line_targets("{def} takes tight ends away", ["receptions", "TE", "matchup"]) == ("off", [("player_receptions", ("TE",))])
    assert ag.line_targets("Mobile QB vs a run defense that leaks", ["rushing", "QB"]) == ("off", [("player_rush_yds", ("QB",))])
    assert ag.line_targets("{off} rarely goes down: {def}'s sack rate should dip", ["sacks", "defense"])[0] == "def"
    assert ag.line_targets("Wind", ["passing", "kicking", "total"]) == \
        ("off", [("player_field_goals", ("K",)), ("player_kicking_points", ("K",)), ("player_pass_yds", ("QB",))])
    assert ag.line_targets("Kicker volume", ["kicking"]) == ("off", [("player_field_goals", ("K",)), ("player_kicking_points", ("K",))])
    assert ag.line_targets("Red zone favours touchdowns", ["touchdowns"]) is None


def test_a_position_angle_reads_against_the_offenses_own_usual(monkeypatch):
    r = {k: None for k in ag.SCHEMA} | {"kind": "team", "season": 2026, "week": 1, "game_id": "G", "offense": "ATL",
                                       "defense": "CAR", "team": "ATL", "direction": "up", "lean": "over",
                                       "family": "{def} has been generous to RBs", "tags": ["RB"],
                                       "measure": "RB rushing yards", "fmt": "dec1", "actual": 123.0, "baseline": 118.7,
                                       "baseline_label": "ATL's usual"}
    assert "than they usually do" in ag._said(r) and "league" not in ag._said(r)
    assert "their usual 118.7" in ag._happened(r)
    _fake_lines(monkeypatch, {"G": [("Bijan Robinson", "ATL", "RB", "player_rush_yds", 85.5, 101.0),
                                    ("Tyler Allgeier", "ATL", "RB", "player_rush_yds", 30.5, 22.0)]})
    w = ag._line_words(r)
    assert "Bijan Robinson 85.5 rushing yards, had 101 (over)" in w and "Tyler Allgeier 30.5" in w
    assert "1 of 2 went over" in w

def test_a_player_who_got_hurt_still_counts_with_a_note(monkeypatch):
    """Under half his usual snaps and on the next week's report: the call
    counts as usual and carries a note. Low snaps alone (a benched backup) or
    a listing alone (a knock he played through) carry none."""
    import polars as pl
    base = {k: None for k in ag.SCHEMA} | {"season": 2026, "week": 1, "kind": "player", "family": "{player} vs man coverage",
                                           "lean": "under", "strength": 1, "tags": [], "direction": "down", "fmt": "dec1",
                                           "baseline_label": "his previous 16 games", "baseline": 60.0, "actual": 20.0,
                                           "line_result": "under", "usual_snap_pct": 0.8, "title": "A vs man coverage",
                                           "offense": "NE", "defense": "SEA", "measure": "receiving yards", "player": "A"}
    rows = [base | {"game_id": "g", "player_id": "hurt", "snap_pct": 0.2},       # low snaps, then listed: noted
            base | {"game_id": "g", "player_id": "benched", "snap_pct": 0.2},    # low snaps, not listed
            base | {"game_id": "g", "player_id": "knock", "snap_pct": 0.75}]     # listed, played his snaps
    listed = pl.DataFrame({"season": [2026, 2026], "week": [1, 1], "player_id": ["hurt", "knock"]},
                          schema={"season": pl.Int32, "week": pl.Int32, "player_id": pl.String})
    monkeypatch.setattr(ag, "_hurt_next_week", lambda seasons: listed)
    df = ag._with_margin(pl.DataFrame(rows, schema=ag.SCHEMA))
    assert df["verdict"].to_list() == ["hit", "hit", "hit"] and df["line_verdict"].to_list() == ["hit", "hit", "hit"]
    assert df["hurt"].to_list() == [True, False, False]
    monkeypatch.setattr(ag, "_box", lambda ids: pl.DataFrame(schema={"game_id": pl.String, "player_id": pl.String, "team": pl.String}))
    notes = [r["note"] for r in ag.explain(df.to_dicts())]
    assert notes[0].startswith("He got hurt in the game: 20% of the snaps against his usual 80%")
    assert "got hurt" not in notes[1] and "got hurt" not in notes[2]
    monkeypatch.setattr(ag, "_fresh", lambda: df)
    monkeypatch.setattr(ag, "CURRENT_SEASON", 2026)
    t = ag.track_record()
    assert (t["n"], t["hits"], t["hurt"]) == (3, 3, 1)
