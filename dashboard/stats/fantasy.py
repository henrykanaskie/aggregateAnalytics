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
March is listed with his new team, and flagged, rather than missed. Once
ESPN's projections for the week are pulled, :func:`reconcile` corrects that
list against them: who is on which team, who starts, who is not playing.
"""

from __future__ import annotations

import math

import polars as pl

from nfl.data import RAW_DIR, scan

from ..odds.common import schedule
from . import availability as avail_mod
from . import context as ctx_mod
from . import matchups as mu_mod
from ..odds import espn_proj
from .catalog import kicker_points_expr
from .projection import FACTOR_CLIP, N_GAMES, _weights, _wstats, dvp_factor

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
        .select("player_id", "season", "week", "opponent_team", "fantasy_points", "fantasy_points_ppr", "targets", "carries", "attempts")
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


# --- one centre, one spread --------------------------------------------------------
#
# Every fantasy number on the site comes out of these two: the centre is ESPN's
# weekly projection when ESPN has one (the site's own baseline otherwise), and
# the floor and ceiling come from simulating the week out of the player's own
# recent games, each shifted to sit on that centre and weighted toward the
# latest. The floor is a bad week (20th percentile) and the ceiling a good one
# (80th), so a boom-or-bust receiver gets a wide, lopsided range and a steady
# one a narrow range, which a symmetric band could not tell apart. Start/sit
# simulates from the same range.

Q_LO, Q_HI = 0.2, 0.8
#: Per point of the format, how many projected receptions come back out.
REC_WEIGHT = {"ppr": 0.0, "half": 0.5, "std": 1.0}


def _wquantile(vals: list[float], weights: list[float], q: float) -> float:
    pairs = sorted(zip(vals, weights))
    total, acc = sum(weights), 0.0
    for v, w in pairs:
        acc += w
        if acc >= q * total:
            return v
    return pairs[-1][0]


def simulate(series: list[float], center: float, min_sd: float, floor_zero: bool = True) -> tuple[float, float]:
    """Floor and ceiling for a week centred on ``center``: the weighted 20th and
    80th percentiles of the player's recent games shifted onto it. With too few
    games to say, a normal range as wide as the position usually swings."""
    xs = series[-N_GAMES:]
    if len(xs) >= 5:
        w = _weights(len(xs))
        m = sum(a * b for a, b in zip(xs, w)) / sum(w)
        shifted = [x - m + center for x in xs]
        # A dozen games make a jumpy percentile, so each end is averaged with
        # what a normal curve of the same spread would say: the skew survives,
        # one odd week no longer sets the ceiling on its own.
        sd = max(_wstats(xs)[2], min_sd)
        lo = 0.5 * _wquantile(shifted, w, Q_LO) + 0.5 * (center - 0.8416 * sd)
        hi = 0.5 * _wquantile(shifted, w, Q_HI) + 0.5 * (center + 0.8416 * sd)
    else:
        sd = max(min_sd, 0.45 * abs(center))
        lo, hi = center - 0.8416 * sd, center + 0.8416 * sd
    # Never a range that excludes the centre, nor one narrower than the
    # position's smallest honest swing.
    lo, hi = min(lo, center - 0.4 * min_sd), max(hi, center + 0.4 * min_sd)
    return (max(lo, 0.0) if floor_zero else lo), hi


def finish(player_id: str, espn: dict[str, dict], series: dict[str, list[float]], baseline: dict[str, float | None],
           min_sd: float, floor_zero: bool = True) -> dict[str, dict | None]:
    """The proj block for one player in every format."""
    e = espn.get(player_id)
    out: dict[str, dict | None] = {}
    for sc in SCORINGS:
        ser = series.get(sc, [])
        center = (e["ppr"] - REC_WEIGHT[sc] * e["rec"]) if e else baseline.get(sc)
        if center is None:
            out[sc] = None
            continue
        lo, hi = simulate(ser, center, min_sd, floor_zero)
        last = ser[-3:]
        out[sc] = {"value": round(center, 1), "low": round(lo, 1), "high": round(hi, 1),
                   "base": None if baseline.get(sc) is None else round(baseline[sc], 1),
                   "last3": round(sum(last) / len(last), 1) if last else None,
                   "source": "espn" if e else "baseline"}
    return out


def _recent(games: list[dict], season: int, pts: dict[str, str] | None = None, same: str | None = None) -> list[dict]:
    """This season's games so far as {season, week, opp, pts: {ppr, half, std}},
    for the range bar's dots. Last season's games still feed the floor and
    ceiling, where the sample size matters; the dots are what he has done
    this year, so a week 2 player shows one dot, not eight from a different
    team or role. ``pts`` maps each format to a column; ``same`` is one column
    that scores every format alike (kickers, defenses)."""
    out = []
    for g in games:
        if g["season"] != season:
            continue
        vals = {sc: g.get(same if same else pts[sc]) for sc in SCORINGS}
        out.append({"season": g["season"], "week": g["week"], "opp": g.get("opponent_team"),
                    "pts": {sc: None if v is None else round(float(v), 1) for sc, v in vals.items()}})
    return out


def _role(games: list[dict], position: str) -> dict | None:
    """Chances a game, the last three next to the dozen before: targets plus
    carries, or for a quarterback dropbacks he threw from plus carries."""
    first = "attempts" if position == "QB" else "targets"
    opp = [(g.get(first) or 0) + (g.get("carries") or 0) for g in games][-N_GAMES:]
    if len(opp) < 4:
        return None
    recent, before = opp[-3:], opp[:-3]
    return {"last3": round(sum(recent) / 3, 1), "before": round(sum(before) / len(before), 1)}


# --- kickers and team defenses ---------------------------------------------------
#
# Neither has a usable fantasy line in nflverse, so both are scored here from
# team-week totals: the players on each side summed, which is current for this
# season where the team table is not. Both are projected at the team level:
# a kicker's points come mostly from how often his offense stalls in range and
# scores, and a defense is a unit, so a team's own history outlasts any one
# player's, and a newly signed kicker inherits a sensible number.

#: Points allowed -> D/ST points, the common tiers.
PA_TIERS = ((0, 0, 10), (1, 6, 7), (7, 13, 4), (14, 20, 1), (21, 27, 0), (28, 34, -1), (35, 999, -4))
#: Spread of a team's score around its betting-implied total, in points.
SCORE_SD = 10.0
_DEF_COLS = ["def_sacks", "def_interceptions", "fumble_recovery_opp", "def_tds", "special_teams_tds",
             "def_safeties", "def_fg_blocks", "def_punt_blocks"]
_GIVE_COLS = ["sacks_suffered", "passing_interceptions", "sack_fumbles_lost", "rushing_fumbles_lost", "receiving_fumbles_lost"]
_KICK_COLS = ["fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49", "fg_made_50_59", "fg_made_60_",
              "fg_missed", "pat_made", "pat_missed"]


def pa_points(pa: float) -> int:
    for lo, hi, pts in PA_TIERS:
        if lo <= pa <= hi:
            return pts
    return PA_TIERS[-1][2]


def expected_pa_points(mu: float, sd: float = SCORE_SD) -> float:
    """What the points-allowed tiers are worth on average when the opponent's
    score is roughly normal around ``mu``: each whole score's chance, times
    its tier. A shutout is everything below half a point."""
    phi = lambda z: 0.5 * (1 + math.erf(z / math.sqrt(2)))
    total, prev = 0.0, 0.0
    for k in range(0, 70):
        cdf = phi((k + 0.5 - mu) / sd)
        total += (cdf - prev) * pa_points(k)
        prev = cdf
    return total + (1 - prev) * pa_points(70)


def _team_weeks(season: int, week: int) -> pl.DataFrame:
    """One row per team-game before this week, last season on: the defense's
    events, the offense's giveaways, the kicking, and the points each side
    scored (from the schedule)."""
    lf = (scan("player_stats_week")
          .filter((pl.col("season") == season - 1) | ((pl.col("season") == season) & (pl.col("week") < week)))
          .group_by("season", "week", "team", "opponent_team")
          .agg([pl.col(c).fill_null(0).sum() for c in _DEF_COLS + _GIVE_COLS + _KICK_COLS]))
    df = lf.collect()
    if df.is_empty():
        return df
    sched = (scan("schedules").filter(pl.col("season").is_in([season - 1, season]))
             .select("season", "week", "home_team", "away_team", "home_score", "away_score").collect())
    scores = pl.concat([
        sched.select("season", "week", pl.col("home_team").alias("team"), pl.col("home_score").alias("pf"), pl.col("away_score").alias("pa")),
        sched.select("season", "week", pl.col("away_team").alias("team"), pl.col("away_score").alias("pf"), pl.col("home_score").alias("pa")),
    ])
    return (df.join(scores, on=["season", "week", "team"], how="inner").drop_nulls("pa")
            .with_columns(
                events=(pl.col("def_sacks") + 2 * (pl.col("def_interceptions") + pl.col("fumble_recovery_opp") + pl.col("def_safeties")
                        + pl.col("def_fg_blocks") + pl.col("def_punt_blocks")) + 6 * (pl.col("def_tds") + pl.col("special_teams_tds"))),
                giveaways=pl.sum_horizontal(_GIVE_COLS),
                kick_pts=kicker_points_expr(),
            )
            .with_columns(dst_pts=pl.col("events") + pl.col("pa").map_elements(pa_points, return_dtype=pl.Int64))
            .sort("season", "week"))


def _wmean(vals: list[float]) -> float | None:
    vals = vals[-N_GAMES:]
    return _wstats(vals)[0] if len(vals) >= MIN_GAMES else None


def _kickers(season: int) -> dict[str, dict]:
    """Each team's kicker now: the depth chart's first PK, else whoever
    kicked for them most recently."""
    out: dict[str, dict] = {}
    chart = mu_mod.depth_chart(season)
    if not chart.is_empty():
        for r in chart.filter(pl.col("position").is_in(["PK", "K"])).sort("rank").to_dicts():
            out.setdefault(r["team"], {"player_id": r["gsis_id"], "name": r["player_name"]})
    recent = (scan("player_stats_week").filter(pl.col("season").is_in([season - 1, season]) & (pl.col("fg_att") + pl.col("pat_att") > 0))
              .sort("season", "week").select("team", "player_id", "player_display_name").collect())
    for r in recent.to_dicts():
        if r["team"] not in out or out[r["team"]].get("fallback"):
            out[r["team"]] = {"player_id": r["player_id"], "name": r["player_display_name"], "fallback": True}
    return out


def special_teams(season: int, week: int, opp_of: dict[str, dict], listed: dict[str, dict[str, dict]],
                  espn: dict[str, dict] | None = None) -> list[dict]:
    """Kicker and D/ST rows for every team that plays, in the fantasy week's shape."""
    tw = _team_weeks(season, week)
    if tw.is_empty():
        return []
    by_team = {t: g for (t,), g in tw.partition_by("team", as_dict=True).items()}
    giveaways = {t: _wmean(g["giveaways"].cast(pl.Float64).to_list()) for t, g in by_team.items()}
    league_give = sum(v for v in giveaways.values() if v) / max(1, sum(1 for v in giveaways.values() if v))
    give_rank = {t: i + 1 for i, (t, _) in enumerate(sorted(((t, v) for t, v in giveaways.items() if v is not None), key=lambda x: -x[1]))}
    implied_rank = {t: i + 1 for i, (t, _) in enumerate(sorted(((t, o["implied"]) for t, o in opp_of.items() if o["implied"] is not None), key=lambda x: -x[1]))}
    teams = {r["team_abbr"]: r["team_nick"] for r in pl.read_parquet(RAW_DIR / "teams.parquet").select("team_abbr", "team_nick").to_dicts()}
    kickers = _kickers(season)
    out: list[dict] = []
    for team, o in opp_of.items():
        g = by_team.get(team)
        if g is None:
            continue
        opp = o["opponent"]
        base = {"team": team, "headshot": None, "new_to_team": False, "stats_team": team, "target_share": None,
                "carry_share": None, "role": None, "depth_rank": 1, "factor": 1.0, **o}

        # Kicker: the team's kicking, scaled by how many points it is expected to score.
        kicks = g["kick_pts"].cast(pl.Float64).to_list()
        weeks = g.select("season", "week", "opponent_team", "kick_pts", "dst_pts").to_dicts()
        pf = g["pf"].cast(pl.Float64).to_list()
        k = kickers.get(team)
        if k and len(kicks) >= MIN_GAMES:
            usual = _wstats(pf[-N_GAMES:])[0]
            f = 1.0 if not o["implied"] or not usual else min(FACTOR_CLIP[1], max(FACTOR_CLIP[0], o["implied"] / usual))
            kbase = _wstats(kicks[-N_GAMES:])[0] * f
            proj = finish(k["player_id"], espn or {}, {sc: kicks for sc in SCORINGS}, {sc: kbase for sc in SCORINGS}, 2.5)
            inj = listed.get(team, {}).get(k["player_id"])
            out.append({**base, "player_id": k["player_id"], "name": k["name"], "position": "K", "games": len(kicks),
                        "factor": round(f, 3), "matchup_rank": implied_rank.get(team), "matchup_n": len(implied_rank) or None,
                        "matchup_text": (f"{teams.get(team, team)} are expected to score {o['implied']:.1f}, the {_ord(implied_rank[team])} most this week"
                                         if o["implied"] and team in implied_rank else None),
                        "status": inj["status"] if inj else None, "injury": inj["injury"] if inj else None,
                        "proj": proj, "recent": _recent(weeks, season, same="kick_pts")})

        # D/ST: its own sacks and takeaways, scaled by how much this opponent
        # gives away, plus the points-allowed tiers at the opponent's implied total.
        ev = g["events"].cast(pl.Float64).to_list()
        dst = g["dst_pts"].cast(pl.Float64).to_list()
        if len(ev) >= MIN_GAMES:
            og = giveaways.get(opp)
            f = 1.0 if not og or not league_give else min(FACTOR_CLIP[1], max(FACTOR_CLIP[0], og / league_give))
            opp_pts = opp_of.get(opp, {}).get("implied")
            if opp_pts is None:
                og_pf = by_team.get(opp)
                opp_pts = _wstats(og_pf["pf"].cast(pl.Float64).to_list()[-N_GAMES:])[0] if og_pf is not None and og_pf.height >= MIN_GAMES else 22.0
            value = _wstats(ev[-N_GAMES:])[0] * f + expected_pa_points(opp_pts)
            proj = finish(f"DST-{team}", espn or {}, {sc: dst for sc in SCORINGS}, {sc: value for sc in SCORINGS}, 3.0, floor_zero=False)
            out.append({**base, "player_id": f"DST-{team}", "name": f"{teams.get(team, team)} D/ST", "position": "DST",
                        "opp_implied": round(opp_pts, 1),
                        "games": len(ev), "factor": round(f, 3), "status": None, "injury": None,
                        "matchup_rank": give_rank.get(opp), "matchup_n": len(give_rank) or None,
                        "matchup_text": (f"{teams.get(opp, opp)} give up {og:.1f} sacks and turnovers a game, the {_ord(give_rank[opp])} most, "
                                         f"and are expected to score {opp_pts:.1f}") if og is not None and opp in give_rank else None,
                        "proj": proj, "recent": _recent(weeks, season, same="dst_pts")})
    return out


# --- who is playing ---------------------------------------------------------------
#
# The depth chart and the injury report both run behind the week: the chart is
# refreshed weekly, and the report says nothing until Wednesday and never
# names the backup who starts in a hurt player's place. ESPN's projection file
# is current to the last pull, so where it exists it settles who plays:
# a player it moved to another team moves, one it has on no team (released)
# or on a team not playing leaves the list, a player it projects who is not on
# the chart joins it, and the order within a position is ESPN's, so the backup
# projected as this week's starter is the one ranked first.

#: A projection this small is a depth player ESPN lists for completeness.
ESPN_MIN_ADD = 1.0
#: ESPN projects a zero for a player it does not expect to play at all.
NOT_PLAYING = "Not playing"
#: Practice participation is not a game status; said plainly so "DNP" (did
#: not practice) is not read as "did not play".
PRACTICE = {"DNP": "Missed practice", "Limited": "Limited practice"}


def _players_info(pids: list[str]) -> dict[str, dict]:
    if not pids:
        return {}
    df = (pl.read_parquet(RAW_DIR / "players.parquet", columns=["gsis_id", "display_name", "headshot"])
          .filter(pl.col("gsis_id").is_in(pids)))
    return {r["gsis_id"]: r for r in df.to_dicts()}


def reconcile(roster: list[dict], espn: dict[str, dict], opp_of: dict[str, dict], season: int) -> list[dict]:
    """The skill-position list, brought in line with ESPN's file for the week.
    Without a file the list is returned as it came, statuses relabelled."""
    for r in roster:
        r["status"] = PRACTICE.get(r["status"], r["status"])
    if not espn:
        return roster
    out: list[dict] = []
    seen: set[str] = set()
    for r in roster:
        e = espn.get(r["player_id"])
        if e and e["team"] != r["team"]:
            if e["team"] not in opp_of:
                continue                      # released, or his new team is on bye
            r = {**r, **opp_of[e["team"]], "team": e["team"], "new_to_team": True, "stats_team": r["stats_team"] or r["team"]}
        seen.add(r["player_id"])
        out.append(r)
    extra = [(pid, e) for pid, e in espn.items()
             if pid not in seen and e["position"] in POSITIONS and e["team"] in opp_of and e["ppr"] >= ESPN_MIN_ADD]
    info = _players_info([pid for pid, _ in extra])
    for pid, e in extra:
        i = info.get(pid, {})
        out.append({"player_id": pid, "name": i.get("display_name") or e["name"], "position": e["position"], "team": e["team"],
                    "depth_rank": None, "headshot": i.get("headshot"), "new_to_team": False, "stats_team": None,
                    "target_share": None, "carry_share": None, "status": None, "injury": None, **opp_of[e["team"]]})
    for r in out:
        e = espn.get(r["player_id"])
        if not e:
            continue
        # The injury report names the injury, so it wins where it has a
        # game status; ESPN's status fills in the rest.
        if e["status"] and (not r["status"] or r["status"] in PRACTICE.values()):
            r["status"] = e["status"]
        if e["ppr"] <= 0 and not r["status"]:
            r["status"], r["injury"] = NOT_PLAYING, "ESPN projects him for zero points this week"
    # Re-rank each team's position by ESPN's projection; anyone ESPN does not
    # project goes after those it does, in the chart's order.
    groups: dict[tuple[str, str], list[dict]] = {}
    for r in out:
        r["chart_rank"] = r.get("depth_rank")
        groups.setdefault((r["team"], r["position"]), []).append(r)
    for g in groups.values():
        g.sort(key=lambda r: (-(espn[r["player_id"]]["ppr"]) if r["player_id"] in espn else 1.0, r["chart_rank"] or 99))
        for i, r in enumerate(g):
            r["depth_rank"] = i + 1
    return out


def _ord(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


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
    listed_by_team: dict[str, dict[str, dict]] = {}
    for team, o in opp_of.items():
        # This season's games as soon as there are any, last season's before.
        use = season if not ctx_mod.team_usage(team, season, before_week=week).is_empty() else season - 1
        pers = mu_mod.offense_personnel(team, use, roster_season=season, before_week=week if use == season else None)
        listed = avail_mod.listings(ctx_mod.team_injuries(team, season, week).to_dicts())
        listed_by_team[team] = listed
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

    espn = espn_proj.load(season, week)
    roster = reconcile(roster, espn, opp_of, season)
    series = _series([r["player_id"] for r in roster], season, week)
    for r in roster:
        gl = series.get(r["player_id"], [])
        factor, ctx = dvp_factor(r["position"], "fantasy_points_ppr", r["opponent"], season, week)
        r["games"] = len(gl)
        r["factor"] = round(factor, 3)
        r["matchup_rank"] = ctx.get("rank") if ctx else None     # 1 = gives up the most to this position
        r["matchup_n"] = ctx.get("n_teams") if ctx else None
        base = {s: (_proj(gl, k, factor) or {}).get("value") for s, k in SCORINGS.items()}
        r["proj"] = finish(r["player_id"], espn, {s: [float(g[k]) for g in gl if g.get(k) is not None] for s, k in SCORINGS.items()}, base, 2.0)
        r["role"] = _role(gl, r["position"])
        r["recent"] = _recent(gl, season, SCORINGS)

    roster.extend(special_teams(season, week, opp_of, listed_by_team, espn))

    playing = set(opp_of)
    byes = sorted({t for t in schedule(season)["home_team"].unique().to_list() + schedule(season)["away_team"].unique().to_list()} - playing)
    # Reports are filed Wednesday to Friday, so early in a week an empty list
    # means "not filed yet", not "everyone is healthy". The page says which.
    return {"season": season, "week": week, "games": games, "byes": byes, "players": roster,
            "injury_week": ctx_mod.latest_injury_week(season),
            "method": {"n_games": N_GAMES, "min_games": MIN_GAMES, "espn": len(espn), "floor_q": Q_LO, "ceiling_q": Q_HI}}
