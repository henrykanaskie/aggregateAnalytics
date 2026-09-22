"""A week of fantasy projections: every skill player on a team that plays,
ranked by what the baseline expects them to score.

The same baseline the prop board uses (:mod:`projection`): a recency-weighted
mean of the player's last dozen games, scaled by how generous this week's
opponent has been to the position. Here the stat is fantasy points, projected
once per scoring format so the page can switch between PPR, half and standard
without asking again.

Who counts as playing comes from the matchup page's "who gets the ball"
(:func:`matchups.offense_personnel`): this season's depth chart for the names,
last season or this one for the numbers. So a receiver who changed teams in
March is listed with his new team, and flagged, rather than missed.
"""

from __future__ import annotations

import polars as pl

from nfl.data import scan

from ..odds.common import schedule
from . import availability as avail_mod
from . import context as ctx_mod
from . import matchups as mu_mod
from .projection import N_GAMES, _wstats, dvp_factor

POSITIONS = ("QB", "RB", "WR", "TE")
SCORINGS = {"ppr": "fantasy_points_ppr", "half": "fantasy_points_half", "std": "fantasy_points"}
#: Fewer games than this and a mean is a guess; the player is listed without one.
MIN_GAMES = 2


def _series(pids: list[str], season: int, week: int) -> dict[str, list[dict]]:
    """Every game each player has before this week, last season onward,
    oldest first. Playoffs count, as they do on the prop board."""
    if not pids:
        return {}
    df = (
        scan("player_stats_week")
        .filter(pl.col("player_id").is_in(pids)
                & ((pl.col("season") == season - 1) | ((pl.col("season") == season) & (pl.col("week") < week))))
        .select("player_id", "season", "week", "fantasy_points", "fantasy_points_ppr", "targets", "carries", "attempts")
        .sort(["season", "week"])
        .collect()
        .with_columns(fantasy_points_half=(pl.col("fantasy_points") + pl.col("fantasy_points_ppr")) / 2)
    )
    out: dict[str, list[dict]] = {}
    for r in df.to_dicts():
        out.setdefault(r["player_id"], []).append(r)
    return out


def _proj(games: list[dict], key: str, factor: float) -> dict | None:
    vals = [float(g[key]) for g in games if g.get(key) is not None][-N_GAMES:]
    if len(vals) < MIN_GAMES:
        return None
    m, _, sd = _wstats(vals)
    v = m * factor
    # The same 50% band the prop board draws: a quiet week and a good one.
    return {"value": round(v, 1), "low": round(max(v - 0.67 * sd, 0), 1), "high": round(v + 0.67 * sd, 1),
            "base": round(m, 1), "last3": round(sum(vals[-3:]) / len(vals[-3:]), 1)}


def _role(games: list[dict], position: str) -> dict | None:
    """Chances a game, the last three next to the dozen before: targets plus
    carries, or for a quarterback dropbacks he threw from plus carries."""
    first = "attempts" if position == "QB" else "targets"
    opp = [(g.get(first) or 0) + (g.get("carries") or 0) for g in games][-N_GAMES:]
    if len(opp) < 4:
        return None
    recent, before = opp[-3:], opp[:-3]
    return {"last3": round(sum(recent) / 3, 1), "before": round(sum(before) / len(before), 1)}


def week_rankings(season: int, week: int) -> dict:
    sched = schedule(season).filter(pl.col("week") == week)
    games: list[dict] = []
    opp_of: dict[str, dict] = {}
    for g in sched.to_dicts():
        home, away, spread, total = g["home_team"], g["away_team"], g.get("spread_line"), g.get("total_line")
        # spread_line is the home side's margin; the implied totals split the
        # total around it, as the matchup page does.
        hi = None if spread is None or total is None else round((total + spread) / 2, 1)
        ai = None if hi is None else round(total - hi, 1)
        games.append({"game_id": g["game_id"], "home_team": home, "away_team": away, "gameday": g.get("gameday"),
                      "gametime": g.get("gametime"), "total": total, "home_implied": hi, "away_implied": ai})
        for team, opp, home_flag, implied in ((home, away, True, hi), (away, home, False, ai)):
            opp_of[team] = {"opponent": opp, "home": home_flag, "game_id": g["game_id"], "gameday": g.get("gameday"),
                            "implied": implied}

    roster: list[dict] = []
    for team, o in opp_of.items():
        # This season's games as soon as there are any, last season's before.
        use = season if not ctx_mod.team_usage(team, season, before_week=week).is_empty() else season - 1
        pers = mu_mod.offense_personnel(team, use, roster_season=season, before_week=week if use == season else None)
        listed = avail_mod.listings(ctx_mod.team_injuries(team, season, week).to_dicts())
        for p in pers:
            if p["position"] not in POSITIONS or not p.get("player_id"):
                continue
            inj = listed.get(p["player_id"])
            roster.append({
                "player_id": p["player_id"], "name": p["player_display_name"], "position": p["position"],
                "team": team, "depth_rank": p.get("depth_rank"), "headshot": p.get("headshot"),
                "new_to_team": bool(p.get("new_to_team")), "stats_team": p.get("stats_team"),
                "target_share": p.get("target_share"), "carry_share": p.get("carry_share"),
                "status": inj["status"] if inj else None, "injury": inj["injury"] if inj else None,
                **o,
            })

    series = _series([r["player_id"] for r in roster], season, week)
    for r in roster:
        gl = series.get(r["player_id"], [])
        factor, ctx = dvp_factor(r["position"], "fantasy_points_ppr", r["opponent"], season, week)
        r["games"] = len(gl)
        r["factor"] = round(factor, 3)
        r["matchup_rank"] = ctx.get("rank") if ctx else None     # 1 = gives up the most to this position
        r["matchup_n"] = ctx.get("n_teams") if ctx else None
        r["proj"] = {s: _proj(gl, k, factor) for s, k in SCORINGS.items()}
        r["role"] = _role(gl, r["position"])

    playing = set(opp_of)
    byes = sorted({t for t in schedule(season)["home_team"].unique().to_list() + schedule(season)["away_team"].unique().to_list()} - playing)
    # Reports are filed Wednesday to Friday, so early in a week an empty list
    # means "not filed yet", not "everyone is healthy". The page says which.
    return {"season": season, "week": week, "games": games, "byes": byes, "players": roster,
            "injury_week": ctx_mod.latest_injury_week(season),
            "method": {"n_games": N_GAMES, "min_games": MIN_GAMES}}
