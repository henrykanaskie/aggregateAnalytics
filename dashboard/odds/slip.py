"""Grade a bettor's own picks: the line they took, against the box score.

The weekly grader (grading.py) scores every posted line at its close. A pick
someone saved is different in one way that matters: it is graded at the line
they took when they saved it, which may not be where the market closed. So
this reuses the same box-score lookup but takes the line from the request.

Nothing is stored here. The browser keeps the picks and sends them; this only
answers what happened, which is why it is safe on a host with no disk.

Per leg, ``status`` is one of:

    hit / miss / push   the game is in the box scores and the leg is decided
    void                the game is in the box scores and the player is not
                        (inactive, or never recorded a stat); books void these
    pending             the game has not been played, or its box score has not
                        landed in the cache yet (stats.yml runs Mon/Tue/Fri)
    unknown             a market with no stat behind it, or a malformed leg
"""

from __future__ import annotations

from collections import defaultdict

import polars as pl

from .grading import _actuals
from .markets import BY_KEY

OVER_SIDES = {"over", "yes"}


def _decide(side: str, kind: str, line: float, actual: float) -> str:
    if kind == "yesno":
        scored = actual >= 1
        return "hit" if scored == (side == "yes") else "miss"
    if actual == line:
        return "push"
    return "hit" if (actual > line) == (side in OVER_SIDES) else "miss"


def grade_legs(legs: list[dict]) -> list[dict]:
    """``legs`` carry id, season, week, game_id, player_id, market, side and
    line. Returns one result per leg, in the same order."""
    out: dict[str, dict] = {}
    by_week: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for leg in legs:
        m = BY_KEY.get(leg.get("market", ""))
        if not m or not m.stat or not leg.get("player_id") or not leg.get("game_id"):
            out[leg["id"]] = {"id": leg["id"], "status": "unknown", "actual": None}
            continue
        by_week[(int(leg["season"]), int(leg["week"]))].append(leg)

    for (season, week), group in by_week.items():
        stats = sorted({BY_KEY[g["market"]].stat for g in group})
        actual = _actuals(season, week, stats)
        # A game with any box-score row is in the cache; a player missing from
        # it did not play. A game with none has not been loaded yet.
        loaded = set(actual["game_id"].unique().to_list()) if not actual.is_empty() else set()
        rows = {(r["player_id"], r["game_id"]): r for r in actual.to_dicts()} if loaded else {}
        for leg in group:
            m = BY_KEY[leg["market"]]
            res = {"id": leg["id"], "status": "pending", "actual": None}
            if leg["game_id"] in loaded:
                r = rows.get((leg["player_id"], leg["game_id"]))
                val = None if r is None else r.get(m.stat)
                if val is None:
                    res["status"] = "void"
                else:
                    res["actual"] = float(val)
                    line = 0.5 if m.kind == "yesno" else leg.get("line")
                    res["status"] = "unknown" if line is None else _decide(leg["side"], m.kind, float(line), float(val))
            out[leg["id"]] = res
    return [out[leg["id"]] for leg in legs]
