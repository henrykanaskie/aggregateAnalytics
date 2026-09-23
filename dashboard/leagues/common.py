"""What every league import shares: turning another site's players into ours,
and its league settings into the scoring and lineup slots this site uses.

Each platform names players by its own id. Where the platform also hands over
an id nflverse knows (ESPN's own id, Sleeper's copy of the NFL's gsis id) that
settles it. Otherwise the player is found by name, position and team, which is
what a person would do, and the few that still match nobody are reported by
name rather than silently dropped.

Every import comes back in one shape, so the page has one thing to read:

    {"platform": "sleeper", "leagues": [
        {"league_id": "...", "name": "...", "season": 2026,
         "scoring": {"format": "ppr", "rec": 1.0} | None,
         "slots": {"QB": 1, "RB": 2, ...} | None,
         "teams": [{"team_id": "...", "name": "...", "owner": "...",
                    "players": [RosterEntry...], "starters": [player_id...],
                    "unmatched": ["Some Name (WR, DAL)", ...]}]}]}
"""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

import polars as pl

from nfl.data import RAW_DIR

from ..config import CURRENT_SEASON
from ..odds.common import team_abbr

FANTASY_POSITIONS = ("QB", "RB", "WR", "TE", "K")
#: The site's lineup slots (web/src/components/MyRoster.tsx, Slots).
SLOT_KEYS = ("QB", "RB", "WR", "TE", "FLEX", "SFLEX", "K", "DST")
TIMEOUT = 20


class LeagueError(Exception):
    """Something the person importing can fix, said in words they can act on."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


_SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")


def norm_name(name: str | None) -> str:
    """'Amon-Ra St. Brown' and 'Amon Ra St Brown' are one key, and so are
    'Kenneth Walker III' and 'Kenneth Walker'."""
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[.'`]", "", s).replace("-", " ")
    s = _SUFFIX.sub(" ", s)
    return " ".join(s.split())


@lru_cache(maxsize=1)
def _index() -> tuple[dict[str, list[dict]], dict[str, dict], dict[str, dict]]:
    """Players who could be on a fantasy roster now: by name, by gsis id, by
    ESPN id. Anyone whose last season is two or more years gone is left out,
    so a retired namesake (Marvin Harrison, 2008) cannot take the place of
    the one playing now."""
    df = (pl.read_parquet(RAW_DIR / "players.parquet",
                          columns=["gsis_id", "display_name", "position", "latest_team", "espn_id", "last_season", "rookie_season"])
          .filter(pl.col("position").is_in(FANTASY_POSITIONS) & pl.col("gsis_id").is_not_null()
                  & ((pl.col("last_season") >= CURRENT_SEASON - 1) | (pl.col("rookie_season") >= CURRENT_SEASON))))
    by_name: dict[str, list[dict]] = {}
    by_gsis: dict[str, dict] = {}
    by_espn: dict[str, dict] = {}
    for r in df.to_dicts():
        by_name.setdefault(norm_name(r["display_name"]), []).append(r)
        by_gsis[r["gsis_id"]] = r
        if r["espn_id"]:
            by_espn[str(r["espn_id"])] = r
    return by_name, by_gsis, by_espn


def _entry(r: dict) -> dict:
    return {"player_id": r["gsis_id"], "name": r["display_name"], "position": r["position"], "team": r["latest_team"]}


def dst_entry(team: str | None) -> dict | None:
    t = team_abbr(team.upper()) if team else None
    return {"player_id": f"DST-{t}", "name": f"{t} D/ST", "position": "DST", "team": t} if t else None


def match_player(name: str | None, position: str | None, team: str | None,
                 espn_id: str | None = None, gsis_id: str | None = None) -> dict | None:
    """One of our roster entries for a player on another site, or None."""
    by_name, by_gsis, by_espn = _index()
    if gsis_id and gsis_id.strip() in by_gsis:
        return _entry(by_gsis[gsis_id.strip()])
    if espn_id and str(espn_id) in by_espn:
        return _entry(by_espn[str(espn_id)])
    cands = by_name.get(norm_name(name), [])
    if position:
        cands = [c for c in cands if c["position"] == position] or cands
    if len(cands) > 1 and team:
        t = team_abbr(team.upper())
        cands = [c for c in cands if c["latest_team"] == t] or cands
    if not cands:
        return None
    # Two players of one name, position and team is vanishingly rare; the
    # more recent one is the one on a fantasy roster.
    return _entry(max(cands, key=lambda c: c["last_season"] or 0))


class Roster:
    """Collects one team's players as they are matched."""

    def __init__(self) -> None:
        self.players: list[dict] = []
        self.starters: list[str] = []
        self.unmatched: list[str] = []

    def add(self, entry: dict | None, label: str, starting: bool = False) -> None:
        if entry is None:
            self.unmatched.append(label)
            return
        if any(p["player_id"] == entry["player_id"] for p in self.players):
            return
        self.players.append(entry)
        if starting:
            self.starters.append(entry["player_id"])

    def team(self, team_id, name: str, owner: str | None = None) -> dict:
        return {"team_id": str(team_id), "name": name, "owner": owner, "players": self.players,
                "starters": self.starters, "unmatched": self.unmatched}


def scoring_from_rec(rec: float | None) -> dict | None:
    """The site projects three formats; a league's points per reception picks
    the nearest. Anything else about a league's scoring (six-point passing
    touchdowns, bonuses) is not something this site's numbers follow."""
    if rec is None:
        return None
    rec = float(rec)
    fmt = "ppr" if rec >= 0.75 else "half" if rec >= 0.25 else "std"
    return {"format": fmt, "rec": rec}


def slots_from_counts(counts: dict[str, int]) -> dict | None:
    """Counts already named in the site's slot keys -> a full Slots object,
    or None when the league had none of them (nothing worth replacing)."""
    out = {k: int(counts.get(k, 0)) for k in SLOT_KEYS}
    return out if any(out.values()) else None
