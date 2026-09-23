"""Yahoo: sign in with Yahoo, that person's teams out.

Yahoo has an official Fantasy Sports API. It is read through OAuth 2.0, the
"Sign in with Yahoo" button pattern: the person is sent to Yahoo, signs in
there (this site never sees their password), agrees to share their fantasy
data, and Yahoo sends them back here with a one-time code. The server trades
that code for an access token, reads their teams, and throws the token away.
Nothing is stored: the next import signs in again.

Setting it up once (see dashboard/leagues/README.md):
  1. Create an app at https://developer.yahoo.com/apps/ with the
     "Fantasy Sports: Read" permission.
  2. Its redirect URI is this site's /api/leagues/yahoo/callback, over https.
  3. Set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET (and YAHOO_REDIRECT_URI when
     the host sits behind a proxy that hides its own address).

The API answers in XML by default, which is far more regular than its JSON,
so XML is what is read here:

    /users;use_login=1/games;game_keys=nfl/teams   -> the person's teams this season
    /team/<team_key>/roster                         -> a team's players and their slots
    /league/<league_key>/settings                   -> scoring and lineup slots
"""

from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from urllib.parse import urlencode

import requests

from ..config import CURRENT_SEASON
from .common import TIMEOUT, LeagueError, Roster, dst_entry, match_player, scoring_from_rec, slots_from_counts

AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth"
TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token"
API = "https://fantasysports.yahooapis.com/fantasy/v2"
#: Yahoo's stat id for a reception in NFL leagues.
RECEPTIONS = "11"
#: Yahoo roster positions -> the site's slots. R/T (RB or TE) has no slot of
#: its own here and counts as FLEX, which also takes a WR.
SLOT = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "W/R/T": "FLEX", "W/R": "RBWR", "W/T": "WRTE", "R/T": "FLEX",
        "Q/W/R/T": "SFLEX", "K": "K", "DEF": "DST"}
NOT_STARTING = {"BN", "IR", "IR+", "NA"}


def credentials() -> tuple[str, str] | None:
    cid, secret = os.environ.get("YAHOO_CLIENT_ID"), os.environ.get("YAHOO_CLIENT_SECRET")
    return (cid, secret) if cid and secret else None


def authorize_url(redirect_uri: str, state: str) -> str:
    creds = credentials()
    if not creds:
        raise LeagueError("Yahoo import is not set up on this site yet.", 503)
    return f"{AUTH_URL}?{urlencode({'client_id': creds[0], 'redirect_uri': redirect_uri, 'response_type': 'code', 'state': state})}"


def exchange(code: str, redirect_uri: str) -> str:
    """The one-time code Yahoo sent back -> an access token (good for an hour)."""
    creds = credentials()
    if not creds:
        raise LeagueError("Yahoo import is not set up on this site yet.", 503)
    try:
        r = requests.post(TOKEN_URL, auth=creds, timeout=TIMEOUT,
                          data={"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri})
    except requests.RequestException as e:
        raise LeagueError(f"Yahoo did not answer ({type(e).__name__}). Try again.", 502) from e
    if not r.ok:
        raise LeagueError("Yahoo would not finish signing in. Start the import again.", 502)
    return r.json()["access_token"]


def _strip(root: ET.Element) -> ET.Element:
    """Drop Yahoo's XML namespace so paths read as plain names."""
    for el in root.iter():
        el.tag = el.tag.split("}", 1)[-1]
    return root


def _get(path: str, token: str) -> ET.Element:
    try:
        r = requests.get(f"{API}{path}", headers={"Authorization": f"Bearer {token}"}, timeout=TIMEOUT)
    except requests.RequestException as e:
        raise LeagueError(f"Yahoo did not answer ({type(e).__name__}). Try again.", 502) from e
    if not r.ok:
        raise LeagueError(f"Yahoo answered {r.status_code} reading your leagues.", 502)
    return _strip(ET.fromstring(r.content))


def _text(el: ET.Element | None, path: str) -> str | None:
    x = el.find(path) if el is not None else None
    return x.text if x is not None and x.text else None


def parse_teams(root: ET.Element) -> list[dict]:
    """The person's teams: [{team_key, league_key, name, season}]."""
    out = []
    for game in root.iter("game"):
        season = _text(game, "season")
        for t in game.iter("team"):
            key = _text(t, "team_key")
            if key:
                out.append({"team_key": key, "league_key": key.rsplit(".t.", 1)[0], "name": _text(t, "name") or key,
                            "owner": _text(t, "managers/manager/nickname"), "season": int(season) if season else CURRENT_SEASON})
    return out


def parse_roster(root: ET.Element) -> Roster:
    out = Roster()
    for p in root.iter("player"):
        name = _text(p, "name/full")
        pos = _text(p, "primary_position") or (_text(p, "display_position") or "").split(",")[0]
        team = _text(p, "editorial_team_abbr")
        label = f"{name} ({pos}, {(team or 'FA').upper()})"
        entry = dst_entry(team) if pos == "DEF" else match_player(name, pos, team)
        out.add(entry, label, starting=_text(p, "selected_position/position") not in NOT_STARTING)
    return out


def parse_settings(root: ET.Element) -> tuple[dict | None, dict | None, str | None]:
    """(scoring, slots, league name) from a league's settings."""
    league = next(root.iter("league"), None)
    rec = 0.0
    for s in root.iter("stat"):
        if _text(s, "stat_id") == RECEPTIONS and s.find("value") is not None:
            rec = float(_text(s, "value") or 0)
    counts: dict[str, int] = {}
    for rp in root.iter("roster_position"):
        slot = SLOT.get(_text(rp, "position") or "")
        if slot:
            counts[slot] = counts.get(slot, 0) + int(_text(rp, "count") or 0)
    return scoring_from_rec(rec), slots_from_counts(counts), _text(league, "name")


def import_with_token(token: str) -> dict:
    teams = parse_teams(_get("/users;use_login=1/games;game_keys=nfl/teams", token))
    if not teams:
        raise LeagueError("That Yahoo account has no NFL fantasy teams this season.", 404)
    leagues = []
    for t in teams:
        scoring, slots, league_name = parse_settings(_get(f"/league/{t['league_key']}/settings", token))
        roster = parse_roster(_get(f"/team/{t['team_key']}/roster", token))
        leagues.append({"league_id": t["league_key"], "name": league_name or "Yahoo league", "season": t["season"],
                        "scoring": scoring, "slots": slots, "teams": [roster.team(t["team_key"], t["name"], t["owner"])]})
    return {"platform": "yahoo", "leagues": leagues}
