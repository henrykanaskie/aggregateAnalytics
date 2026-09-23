"""ESPN's weekly fantasy projections, the centre of every fantasy number here.

ESPN's public fantasy API serves each player's projection for a scoring
period on its "league defaults" leagues. League 3 is full PPR, and its totals
match nflverse's PPR points to the hundredth on actual weeks, so the PPR
projection is ESPN's own number and the other formats follow by taking half or
all of the projected receptions (stat 53) back out. Kickers and team defenses
are projected in ESPN's default scoring for those positions.

The site's own recency baseline stays as the fallback for anyone ESPN does not
project, and the floor and ceiling around either come from the player's own
games (see stats/fantasy.py).

    python -m dashboard.odds.espn_proj            # current week
    python -m dashboard.odds.espn_proj 2026 4     # a season and week

Writes data/odds/projections/espn_<season>_<week>.parquet, replaced on each
pull: projections move through the week, and only the latest matters.
"""

from __future__ import annotations

import json
import sys

import polars as pl
import requests

from ..config import CURRENT_SEASON, PROJ_DIR
from .common import current_week, team_abbr
from .espn import _espn_to_gsis
from .store import now_utc

URL = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leaguedefaults/3"
TIMEOUT = 30
#: ESPN lineup slots for the positions projected here: QB, RB, WR, TE, D/ST, K.
SLOTS = [0, 2, 4, 6, 16, 17]
POSITION = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST"}
#: ESPN proTeamId -> ESPN abbreviation; team_abbr() turns those into nflverse's.
ESPN_TEAMS = {1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN",
              11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
              21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX",
              33: "BAL", 34: "HOU"}
RECEPTIONS = "53"


def fetch(season: int, week: int) -> list[dict]:
    flt = {"players": {"filterSlotIds": {"value": SLOTS}, "limit": 2000,
                       "sortPercOwned": {"sortPriority": 1, "sortAsc": False}}}
    r = requests.get(URL.format(season=season), params={"view": "kona_player_info", "scoringPeriodId": week},
                     headers={"X-Fantasy-Filter": json.dumps(flt)}, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json().get("players", [])


def parse(players: list[dict], season: int, week: int) -> list[dict]:
    """ESPN's player entries -> one row per projected player, keyed by our ids."""
    ids = _espn_to_gsis()
    pulled = now_utc()
    out = []
    for entry in players:
        p = entry.get("player") or {}
        pos = POSITION.get(p.get("defaultPositionId"))
        proj = next((s for s in p.get("stats", []) if s.get("statSourceId") == 1 and s.get("statSplitTypeId") == 1
                     and s.get("scoringPeriodId") == week and s.get("seasonId") == season), None)
        if not pos or not proj:
            continue
        team = team_abbr(ESPN_TEAMS.get(p.get("proTeamId")))
        if pos == "DST":
            pid = f"DST-{team}" if team else None
        else:
            pid = (ids.get(str(p.get("id"))) or {}).get("player_id")
        if not pid:
            continue
        out.append({"season": season, "week": week, "player_id": pid, "espn_id": str(p.get("id")), "name": p.get("fullName"),
                    "position": pos, "team": team, "proj_ppr": round(float(proj.get("appliedTotal") or 0), 2),
                    "proj_rec": round(float((proj.get("stats") or {}).get(RECEPTIONS) or 0), 2), "pulled_at": pulled})
    return out


def pull(season: int | None = None, week: int | None = None, log=print) -> int:
    season = season or CURRENT_SEASON
    week = week or current_week(season)
    rows = parse(fetch(season, week), season, week)
    if not rows:
        log(f"[espn_proj] no projections for {season} week {week}")
        return 0
    PROJ_DIR.mkdir(parents=True, exist_ok=True)
    path = PROJ_DIR / f"espn_{season}_{week:02d}.parquet"
    pl.DataFrame(rows).write_parquet(path)
    by_pos = pl.DataFrame(rows).group_by("position").len().sort("position").rows()
    log(f"[espn_proj] {len(rows)} projections for {season} week {week} ({', '.join(f'{p} {n}' for p, n in by_pos)}) -> {path.name}")
    return len(rows)


def load(season: int, week: int) -> dict[str, dict]:
    """player_id -> {ppr, rec} for a week, or {} when nothing was pulled."""
    path = PROJ_DIR / f"espn_{season}_{week:02d}.parquet"
    if not path.exists():
        return {}
    return {r["player_id"]: {"ppr": r["proj_ppr"], "rec": r["proj_rec"]}
            for r in pl.read_parquet(path).select("player_id", "proj_ppr", "proj_rec").to_dicts()}


if __name__ == "__main__":
    a = [int(x) for x in sys.argv[1:3]]
    raise SystemExit(0 if pull(*a) else 1)
