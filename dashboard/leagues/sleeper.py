"""Sleeper: a username in, that person's teams out.

Sleeper's API is public and read-only: no key, no login, no token to keep.
Four calls cover it:

    /v1/user/<username>                        -> the user's id
    /v1/user/<id>/leagues/nfl/<season>         -> their leagues, with scoring and slots
    /v1/league/<league_id>/rosters             -> every roster; theirs is the one they own
    /v1/players/nfl                            -> who each player id is

The last is Sleeper's whole player database (several megabytes), which its
docs ask callers to fetch at most once a day. It is fetched on first use, cut
down to the few fields needed here while it is parsed, and kept on disk for a
day. Its players carry the NFL's own gsis id and ESPN's id, which is how most
of them are matched; the rest match by name.
"""

from __future__ import annotations

import json
import time

import requests

from nfl.data import DATA_ROOT

from ..config import CURRENT_SEASON
from .common import TIMEOUT, LeagueError, Roster, dst_entry, match_player, scoring_from_rec, slots_from_counts

BASE = "https://api.sleeper.app/v1"
PLAYERS_PATH = DATA_ROOT / "leagues" / "sleeper_players.json"
PLAYERS_MAX_AGE = 24 * 3600
KEEP = ("full_name", "position", "team", "gsis_id", "espn_id")
POSITIONS = {"QB", "RB", "WR", "TE", "K", "DEF"}
#: Sleeper roster_positions -> the site's slots, the narrow flexes included.
SLOT = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "FLEX": "FLEX", "WRRB_FLEX": "RBWR", "REC_FLEX": "WRTE",
        "SUPER_FLEX": "SFLEX", "K": "K", "DEF": "DST"}


def _get(path: str):
    try:
        r = requests.get(f"{BASE}{path}", timeout=TIMEOUT)
    except requests.RequestException as e:
        raise LeagueError(f"Sleeper did not answer ({type(e).__name__}). Try again in a minute.", 502) from e
    if r.status_code == 404:
        return None
    if not r.ok:
        raise LeagueError(f"Sleeper answered {r.status_code}. Try again in a minute.", 502)
    return r.json()


def _trim(d: dict) -> dict:
    """Called by the JSON parser on every object as it is built: a player
    keeps five fields, so the full database is never held in memory at once."""
    if "player_id" in d and "position" in d:
        return {k: d.get(k) for k in KEEP} if d.get("position") in POSITIONS else {}
    return d


def players() -> dict[str, dict]:
    if PLAYERS_PATH.exists() and time.time() - PLAYERS_PATH.stat().st_mtime < PLAYERS_MAX_AGE:
        try:
            return json.loads(PLAYERS_PATH.read_text())
        except json.JSONDecodeError:
            pass
    try:
        r = requests.get(f"{BASE}/players/nfl", timeout=60)
        r.raise_for_status()
    except requests.RequestException as e:
        raise LeagueError("Could not load Sleeper's player list. Try again in a minute.", 502) from e
    data = {k: v for k, v in json.loads(r.text, object_hook=_trim).items() if v}
    PLAYERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PLAYERS_PATH.write_text(json.dumps(data))
    return data


def entry_for(pid: str, db: dict[str, dict]) -> tuple[dict | None, str]:
    """Our roster entry for a Sleeper player id, and a label if it fails."""
    p = db.get(pid)
    if p is None:
        # Team defenses are keyed by the team's abbreviation ("KC").
        return (dst_entry(pid), f"{pid} D/ST") if pid.isalpha() else (None, f"Sleeper player {pid}")
    if p.get("position") == "DEF":
        return dst_entry(p.get("team") or pid), f"{pid} D/ST"
    label = f"{p.get('full_name')} ({p.get('position')}, {p.get('team') or 'FA'})"
    return match_player(p.get("full_name"), p.get("position"), p.get("team"), espn_id=p.get("espn_id"), gsis_id=p.get("gsis_id")), label


def league_slots(positions: list[str] | None) -> dict | None:
    counts: dict[str, int] = {}
    for p in positions or []:
        if p in SLOT:
            counts[SLOT[p]] = counts.get(SLOT[p], 0) + 1
    return slots_from_counts(counts)


def build_team(roster: dict, db: dict[str, dict], name: str) -> dict:
    out = Roster()
    starting = {s for s in roster.get("starters") or [] if s and s != "0"}
    for pid in roster.get("players") or []:
        entry, label = entry_for(str(pid), db)
        out.add(entry, label, starting=str(pid) in starting)
    return out.team(roster.get("roster_id"), name)


def import_user(username: str, season: int = CURRENT_SEASON) -> dict:
    username = username.strip().lstrip("@")
    if not username:
        raise LeagueError("Type your Sleeper username.")
    user = _get(f"/user/{username}")
    if not user:
        raise LeagueError(f"Sleeper has no user called {username}. It is the name on your profile, not your email.", 404)
    uid = user["user_id"]
    leagues = _get(f"/user/{uid}/leagues/nfl/{season}") or []
    if not leagues:
        raise LeagueError(f"{user.get('display_name') or username} is in no {season} Sleeper leagues.", 404)
    db = players()
    out = []
    for lg in leagues:
        rosters = _get(f"/league/{lg['league_id']}/rosters") or []
        mine = next((r for r in rosters if r.get("owner_id") == uid or uid in (r.get("co_owners") or [])), None)
        if mine is None:
            continue
        out.append({"league_id": str(lg["league_id"]), "name": lg.get("name") or "Sleeper league", "season": season,
                    "scoring": scoring_from_rec((lg.get("scoring_settings") or {}).get("rec")),
                    "slots": league_slots(lg.get("roster_positions")),
                    "teams": [build_team(mine, db, user.get("display_name") or username)]})
    return {"platform": "sleeper", "leagues": out}
