"""League imports (dashboard/leagues/), against recorded shapes of each
platform's answers. No network and no parquet cache: the player index is a
small fake, and every outbound call is replaced."""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from dashboard.leagues import common, espn, router as router_mod, sleeper, yahoo

PLAYERS = [
    {"gsis_id": "00-ARSB", "display_name": "Amon-Ra St. Brown", "position": "WR", "latest_team": "DET", "espn_id": "4374302", "last_season": 2026},
    {"gsis_id": "00-KW3", "display_name": "Kenneth Walker III", "position": "RB", "latest_team": "KC", "espn_id": "4567048", "last_season": 2026},
    {"gsis_id": "00-JA", "display_name": "Josh Allen", "position": "QB", "latest_team": "BUF", "espn_id": "3918298", "last_season": 2026},
    # A defender of the same name must never take the quarterback's place.
    {"gsis_id": "00-JA-LB", "display_name": "Josh Allen", "position": "LB", "latest_team": "JAX", "espn_id": None, "last_season": 2026},
    {"gsis_id": "00-MHJ", "display_name": "Marvin Harrison Jr.", "position": "WR", "latest_team": "ARI", "espn_id": "4432708", "last_season": 2026},
    {"gsis_id": "00-BA", "display_name": "Brandon Aubrey", "position": "K", "latest_team": "DAL", "espn_id": "3953687", "last_season": 2026},
]


@pytest.fixture(autouse=True)
def fake_index(monkeypatch):
    by_name, by_gsis, by_espn = {}, {}, {}
    for r in PLAYERS:
        by_name.setdefault(common.norm_name(r["display_name"]), []).append(r)
        by_gsis[r["gsis_id"]] = r
        if r["espn_id"]:
            by_espn[r["espn_id"]] = r
    monkeypatch.setattr(common, "_index", lambda: (by_name, by_gsis, by_espn))


# --- matching -----------------------------------------------------------------

def test_names_match_across_punctuation_suffixes_and_ids():
    assert common.norm_name("Amon-Ra St. Brown") == common.norm_name("Amon Ra St Brown")
    assert common.match_player("Kenneth Walker", "RB", "KC")["player_id"] == "00-KW3"
    assert common.match_player("Marvin Harrison Jr", "WR", "ARI")["player_id"] == "00-MHJ"
    assert common.match_player("Josh Allen", "QB", "BUF")["player_id"] == "00-JA"
    assert common.match_player("anyone", "WR", None, espn_id="4374302")["player_id"] == "00-ARSB"
    assert common.match_player("anyone", "WR", None, gsis_id=" 00-ARSB")["player_id"] == "00-ARSB"   # Sleeper pads some ids
    assert common.match_player("Nobody Real", "WR", "DAL") is None
    assert common.dst_entry("wsh") == {"player_id": "DST-WAS", "name": "WAS D/ST", "position": "DST", "team": "WAS"}


def test_scoring_picks_the_nearest_format():
    assert common.scoring_from_rec(1)["format"] == "ppr"
    assert common.scoring_from_rec(0.5)["format"] == "half"
    assert common.scoring_from_rec(0)["format"] == "std"
    assert common.scoring_from_rec(None) is None


# --- Sleeper ------------------------------------------------------------------

def test_sleeper_player_database_is_trimmed_while_it_parses():
    raw = json.dumps({"4866": {"player_id": "4866", "full_name": "Amon-Ra St. Brown", "position": "WR", "team": "DET",
                               "gsis_id": "00-ARSB", "espn_id": 4374302, "metadata": {"x": 1}, "college": "USC"},
                      "9999": {"player_id": "9999", "full_name": "A Linebacker", "position": "LB", "team": "DAL"},
                      "KC": {"player_id": "KC", "position": "DEF", "team": "KC"}})
    data = {k: v for k, v in json.loads(raw, object_hook=sleeper._trim).items() if v}
    assert set(data) == {"4866", "KC"} and set(data["4866"]) == set(sleeper.KEEP)


def test_sleeper_import_finds_the_users_own_roster(monkeypatch):
    answers = {
        "/user/henry": {"user_id": "u1", "display_name": "Henry"},
        "/user/u1/leagues/nfl/2026": [{"league_id": "L1", "name": "Work league", "scoring_settings": {"rec": 0.5},
                                       "roster_positions": ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF", "BN", "BN"]}],
        "/league/L1/rosters": [{"roster_id": 1, "owner_id": "someone-else", "players": ["6904"]},
                               {"roster_id": 2, "owner_id": "u1", "players": ["4866", "6904", "KC", "12345"], "starters": ["4866", "KC", "0"]}],
    }
    monkeypatch.setattr(sleeper, "_get", lambda path: answers.get(path))
    monkeypatch.setattr(sleeper, "players", lambda: {
        "4866": {"full_name": "Amon-Ra St. Brown", "position": "WR", "team": "DET", "gsis_id": None, "espn_id": 4374302},
        "6904": {"full_name": "Josh Allen", "position": "QB", "team": "BUF", "gsis_id": "00-JA", "espn_id": None},
        "KC": {"full_name": None, "position": "DEF", "team": "KC", "gsis_id": None, "espn_id": None},
        "12345": {"full_name": "Practice Squad Guy", "position": "WR", "team": "DAL", "gsis_id": None, "espn_id": None}})
    out = sleeper.import_user("@henry", 2026)
    lg = out["leagues"][0]
    assert out["platform"] == "sleeper" and lg["name"] == "Work league" and lg["scoring"]["format"] == "half"
    assert lg["slots"] == {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "RBWR": 0, "WRTE": 0, "FLEX": 1, "SFLEX": 1, "K": 1, "DST": 1}
    team = lg["teams"][0]
    assert [p["player_id"] for p in team["players"]] == ["00-ARSB", "00-JA", "DST-KC"]
    assert team["starters"] == ["00-ARSB", "DST-KC"]
    assert team["unmatched"] == ["Practice Squad Guy (WR, DAL)"]


def test_sleeper_unknown_user_says_so(monkeypatch):
    monkeypatch.setattr(sleeper, "_get", lambda path: None)
    with pytest.raises(common.LeagueError, match="no user called ghost"):
        sleeper.import_user("ghost")


# --- ESPN ---------------------------------------------------------------------

ESPN_LEAGUE = {
    "id": 123456,
    "settings": {"name": "The Big One",
                 "scoringSettings": {"scoringItems": [{"statId": 53, "points": 1.0}, {"statId": 4, "points": 6.0}]},
                 "rosterSettings": {"lineupSlotCounts": {"0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "16": 1, "17": 1, "20": 7, "21": 1}}},
    "members": [{"id": "{M1}", "displayName": "hkan"}],
    "teams": [{"id": 3, "name": "Gibbs Me Points", "owners": ["{M1}"], "roster": {"entries": [
        {"lineupSlotId": 4, "playerPoolEntry": {"player": {"id": 4374302, "fullName": "Amon-Ra St. Brown", "defaultPositionId": 3, "proTeamId": 8}}},
        {"lineupSlotId": 20, "playerPoolEntry": {"player": {"id": 1, "fullName": "Kenneth Walker III", "defaultPositionId": 2, "proTeamId": 12}}},
        {"lineupSlotId": 16, "playerPoolEntry": {"player": {"id": -16028, "fullName": "Commanders D/ST", "defaultPositionId": 16, "proTeamId": 28}}},
        {"lineupSlotId": 21, "playerPoolEntry": {"player": {"id": 2, "fullName": "Hurt Nobody", "defaultPositionId": 3, "proTeamId": 6}}},
    ]}}],
}


def test_espn_league_parses_every_team_with_slots_and_scoring():
    lg = espn.parse(ESPN_LEAGUE, 2026)["leagues"][0]
    assert lg["name"] == "The Big One" and lg["scoring"] == {"format": "ppr", "rec": 1.0}
    assert lg["slots"] == {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "RBWR": 0, "WRTE": 0, "FLEX": 1, "SFLEX": 0, "K": 1, "DST": 1}
    team = lg["teams"][0]
    assert team["name"] == "Gibbs Me Points" and team["owner"] == "hkan"
    assert [p["player_id"] for p in team["players"]] == ["00-ARSB", "00-KW3", "DST-WAS"]
    assert team["starters"] == ["00-ARSB", "DST-WAS"]            # bench (20) and IR (21) are not starting
    assert team["unmatched"] == ["Hurt Nobody (WR, DAL)"]


def test_espn_league_id_comes_from_a_pasted_url_and_private_leagues_explain_themselves(monkeypatch):
    assert espn.league_id_from("https://fantasy.espn.com/football/league?leagueId=987654&seasonId=2026") == "987654"
    assert espn.league_id_from(" 42 ") == "42"
    with pytest.raises(common.LeagueError):
        espn.league_id_from("my league")

    class R:
        status_code, ok = 401, False
    monkeypatch.setattr(espn.requests, "get", lambda *a, **k: R())
    with pytest.raises(common.LeagueError, match="viewable to public") as e:
        espn.import_league("42")
    assert e.value.status == 403


# --- Yahoo --------------------------------------------------------------------

NS = 'xmlns="http://fantasysports.yahooapis.com/fantasy/v2/base.rng"'
Y_TEAMS = f"""<fantasy_content {NS}><users><user><games><game><season>2026</season><teams>
  <team><team_key>461.l.7777.t.4</team_key><name>Henry's Team</name><managers><manager><nickname>Henry</nickname></manager></managers></team>
</teams></game></games></user></users></fantasy_content>"""
Y_ROSTER = f"""<fantasy_content {NS}><team><roster><players>
  <player><name><full>Josh Allen</full></name><editorial_team_abbr>Buf</editorial_team_abbr><display_position>QB</display_position>
    <primary_position>QB</primary_position><selected_position><position>QB</position></selected_position></player>
  <player><name><full>Marvin Harrison Jr.</full></name><editorial_team_abbr>Ari</editorial_team_abbr><display_position>WR</display_position>
    <primary_position>WR</primary_position><selected_position><position>BN</position></selected_position></player>
  <player><name><full>Washington</full></name><editorial_team_abbr>Was</editorial_team_abbr><display_position>DEF</display_position>
    <primary_position>DEF</primary_position><selected_position><position>DEF</position></selected_position></player>
</players></roster></team></fantasy_content>"""
Y_SETTINGS = f"""<fantasy_content {NS}><league><name>Yahoo Pals</name><settings>
  <stat_categories><stats><stat><stat_id>11</stat_id><name>Receptions</name></stat></stats></stat_categories>
  <roster_positions>
    <roster_position><position>QB</position><count>1</count></roster_position>
    <roster_position><position>WR</position><count>3</count></roster_position>
    <roster_position><position>W/R/T</position><count>1</count></roster_position>
    <roster_position><position>DEF</position><count>1</count></roster_position>
    <roster_position><position>BN</position><count>6</count></roster_position>
  </roster_positions>
  <stat_modifiers><stats><stat><stat_id>11</stat_id><value>0.5</value></stat></stats></stat_modifiers>
</settings></league></fantasy_content>"""


def test_yahoo_teams_rosters_and_settings_parse(monkeypatch):
    pages = {"/users;use_login=1/games;game_keys=nfl/teams": Y_TEAMS, "/league/461.l.7777/settings": Y_SETTINGS,
             "/team/461.l.7777.t.4/roster": Y_ROSTER}
    monkeypatch.setattr(yahoo, "_get", lambda path, token: yahoo._strip(yahoo.ET.fromstring(pages[path])))
    lg = yahoo.import_with_token("tok")["leagues"][0]
    assert lg["league_id"] == "461.l.7777" and lg["name"] == "Yahoo Pals" and lg["scoring"]["format"] == "half"
    assert lg["slots"]["WR"] == 3 and lg["slots"]["FLEX"] == 1 and lg["slots"]["DST"] == 1
    team = lg["teams"][0]
    assert team["name"] == "Henry's Team" and team["owner"] == "Henry"
    assert [p["player_id"] for p in team["players"]] == ["00-JA", "00-MHJ", "DST-WAS"]
    assert team["starters"] == ["00-JA", "DST-WAS"]


# --- the routes ---------------------------------------------------------------

@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router_mod.router)
    return TestClient(app, follow_redirects=False)


def test_yahoo_without_credentials_is_reported_not_attempted(client, monkeypatch):
    monkeypatch.delenv("YAHOO_CLIENT_ID", raising=False)
    monkeypatch.delenv("YAHOO_CLIENT_SECRET", raising=False)
    assert client.get("/api/leagues/status").json()["yahoo"] is False
    assert client.get("/api/leagues/yahoo/start").status_code == 503


def test_yahoo_round_trip_checks_state_and_hands_the_result_to_the_page(client, monkeypatch):
    monkeypatch.setenv("YAHOO_CLIENT_ID", "cid")
    monkeypatch.setenv("YAHOO_CLIENT_SECRET", "sec")
    start = client.get("/api/leagues/yahoo/start")
    assert start.status_code == 302 and "api.login.yahoo.com" in start.headers["location"]
    state = client.cookies.get(router_mod.STATE_COOKIE)
    assert state and f"state={state}" in start.headers["location"]

    # A callback whose state this browser did not start is refused.
    forged = client.get("/api/leagues/yahoo/callback", params={"code": "c", "state": "not-mine"})
    assert "did not start here" in forged.text

    monkeypatch.setattr(yahoo, "exchange", lambda code, uri: "tok")
    monkeypatch.setattr(yahoo, "import_with_token", lambda tok: {"platform": "yahoo", "leagues": [{"name": "</script><b>x"}]})
    client.cookies.set(router_mod.STATE_COOKIE, state)
    ok = client.get("/api/leagues/yahoo/callback", params={"code": "c", "state": state})
    assert ok.status_code == 200 and "sessionStorage.setItem" in ok.text and "/fantasy?import=yahoo" in ok.text
    assert "</script><b>" not in ok.text                          # a team name cannot break out of the script


def test_sleeper_route_turns_errors_into_readable_answers(client, monkeypatch):
    monkeypatch.setattr(sleeper, "_get", lambda path: None)
    r = client.get("/api/leagues/sleeper", params={"username": "ghost"})
    assert r.status_code == 404 and "no user called ghost" in r.json()["detail"]


def test_narrow_flex_slots_come_through_from_every_platform():
    assert sleeper.league_slots(["QB", "WRRB_FLEX", "REC_FLEX", "FLEX"])["RBWR"] == 1
    assert sleeper.league_slots(["REC_FLEX"])["WRTE"] == 1
    lg = espn.parse({**ESPN_LEAGUE, "settings": {**ESPN_LEAGUE["settings"], "rosterSettings": {"lineupSlotCounts": {"3": 1, "5": 1, "23": 1}}}}, 2026)
    assert {k: v for k, v in lg["leagues"][0]["slots"].items() if v} == {"RBWR": 1, "WRTE": 1, "FLEX": 1}
    assert yahoo.SLOT["W/T"] == "WRTE" and yahoo.SLOT["W/R"] == "RBWR"
