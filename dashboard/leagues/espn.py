"""ESPN: a league id in, every team in that league out.

This only reads leagues their manager has made viewable to the public
(League → Settings → Basic Settings, "Make league viewable to public"). A
private league needs the reader's ESPN login cookies, and this site does not
ask for anyone's login to another site. ESPN has no official API for leagues:
this is the same unofficial endpoint ESPN's own web app reads, so it can
change without notice, and ESPN's terms restrict automated access. It is here
because it touches no credentials, and it should be the first thing reviewed
if this site ever charges money.

One call reads the league's settings, teams and rosters:

    /apis/v3/games/ffl/seasons/<season>/segments/0/leagues/<id>?view=mTeam&view=mRoster&view=mSettings

ESPN does not say which team is yours without a login, so the page asks.
"""

from __future__ import annotations

import re

import requests

from ..config import CURRENT_SEASON
from ..odds.common import team_abbr
from ..odds.espn_proj import ESPN_TEAMS, POSITION
from .common import TIMEOUT, LeagueError, Roster, dst_entry, match_player, scoring_from_rec, slots_from_counts

URL = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league}"
#: ESPN lineup slot ids -> the site's slots. RB/WR (3) and WR/TE (5) count as
#: FLEX; OP (7, any offensive player) is a superflex.
SLOT = {0: "QB", 2: "RB", 3: "FLEX", 4: "WR", 5: "FLEX", 6: "TE", 7: "SFLEX", 16: "DST", 17: "K", 23: "FLEX"}
BENCH, IR = 20, 21
RECEPTIONS = 53


def league_id_from(text: str) -> str:
    """The id on its own, or pasted inside the league's URL (…?leagueId=123456)."""
    text = (text or "").strip()
    m = re.search(r"leagueId=(\d+)", text) or re.fullmatch(r"(\d+)", text)
    if not m:
        raise LeagueError("That is not an ESPN league id. It is the number after leagueId= in your league's web address.")
    return m.group(1)


def fetch(league: str, season: int) -> dict:
    try:
        r = requests.get(URL.format(season=season, league=league),
                         params=[("view", "mTeam"), ("view", "mRoster"), ("view", "mSettings")], timeout=TIMEOUT)
    except requests.RequestException as e:
        raise LeagueError(f"ESPN did not answer ({type(e).__name__}). Try again in a minute.", 502) from e
    if r.status_code in (401, 403):
        raise LeagueError("This league is private. Its manager can open it to the public in ESPN under League → "
                          "Settings → Basic Settings → \"Make league viewable to public\"; then try again.", 403)
    if r.status_code == 404:
        raise LeagueError(f"ESPN has no {season} league with id {league}.", 404)
    if not r.ok:
        raise LeagueError(f"ESPN answered {r.status_code}. Try again in a minute.", 502)
    try:
        return r.json()
    except ValueError as e:
        raise LeagueError("ESPN sent back something other than a league. It may be private.", 502) from e


def _player_entry(p: dict) -> tuple[dict | None, str]:
    pos = POSITION.get(p.get("defaultPositionId"))
    team = team_abbr(ESPN_TEAMS.get(p.get("proTeamId")))
    label = f"{p.get('fullName')} ({pos or '?'}, {team or 'FA'})"
    if pos == "DST":
        return dst_entry(team), label
    return match_player(p.get("fullName"), pos, team, espn_id=str(p.get("id")) if p.get("id") is not None else None), label


def parse(data: dict, season: int) -> dict:
    settings = data.get("settings") or {}
    items = (settings.get("scoringSettings") or {}).get("scoringItems") or []
    rec = next((i.get("points") for i in items if i.get("statId") == RECEPTIONS), 0.0)
    counts: dict[str, int] = {}
    for sid, n in ((settings.get("rosterSettings") or {}).get("lineupSlotCounts") or {}).items():
        slot = SLOT.get(int(sid))
        if slot and n:
            counts[slot] = counts.get(slot, 0) + int(n)
    members = {m.get("id"): m.get("displayName") or " ".join(filter(None, [m.get("firstName"), m.get("lastName")]))
               for m in data.get("members") or []}
    teams = []
    for t in data.get("teams") or []:
        out = Roster()
        for e in (t.get("roster") or {}).get("entries") or []:
            p = ((e.get("playerPoolEntry") or {}).get("player")) or {}
            entry, label = _player_entry(p)
            out.add(entry, label, starting=e.get("lineupSlotId") not in (BENCH, IR))
        name = t.get("name") or " ".join(filter(None, [t.get("location"), t.get("nickname")])) or t.get("abbrev") or f"Team {t.get('id')}"
        owner = next((members.get(o) for o in t.get("owners") or [] if members.get(o)), None)
        teams.append(out.team(t.get("id"), name, owner))
    return {"platform": "espn", "leagues": [{
        "league_id": str(data.get("id")), "name": settings.get("name") or "ESPN league", "season": season,
        "scoring": scoring_from_rec(rec), "slots": slots_from_counts(counts), "teams": teams}]}


def import_league(text: str, season: int = CURRENT_SEASON) -> dict:
    league = league_id_from(text)
    return parse(fetch(league, season), season)
