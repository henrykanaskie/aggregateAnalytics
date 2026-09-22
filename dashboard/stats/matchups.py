"""One game, both sides, everything the cache knows about it.

    scheme        each offense's tendencies against the other defense's, with ranks
    angles        rule-based observations where two ranked tendencies collide
                  ("pass-heavy offense vs a defense leaking pass EPA"), each with
                  the numbers that produced it
    personnel     offensive usage (who gets targets/carries) and defensive
                  snap leaders with PFR coverage and pass-rush stats
    history       every prior meeting since 1999 with score, spread and total
                  results, and the top performers in each
    venue         roof, surface, stadium, weather if published

Coverage assignments (which corner shadows which receiver) are not in any
nflverse table; the personnel block shows who plays and how they have fared
in coverage, and says so.
"""

from __future__ import annotations

from functools import lru_cache

import polars as pl

from nfl.data import scan
from nfl.depth import load_depth_charts

from ..config import CURRENT_SEASON
from .context import DVP_BY_POS, DVP_LABELS, POS_GROUPS, USAGE_COLS, dvp_recent, dvp_table, league_usage, team_usage
from .gamelog import players_master
from .players import player_index
from .team import METRIC_BY_KEY

# --- history -----------------------------------------------------------------

def head_to_head(a: str, b: str, since: int = 1999) -> list[dict]:
    s = (
        scan("schedules")
        .filter((pl.col("season") >= since) & pl.col("home_score").is_not_null())
        .filter(((pl.col("home_team") == a) & (pl.col("away_team") == b)) | ((pl.col("home_team") == b) & (pl.col("away_team") == a)))
        .select("game_id", "season", "week", "game_type", "gameday", "home_team", "away_team", "home_score", "away_score",
                "spread_line", "total_line", "home_coach", "away_coach", "home_qb_name", "away_qb_name", "roof")
        .sort(["season", "week"], descending=[True, True])
        .collect()
    )
    if s.is_empty():
        return []
    ids = s["game_id"].to_list()
    top = (
        scan("player_stats_week")
        .filter(pl.col("game_id").is_in(ids))
        .select("game_id", "team", "player_id", "player_display_name", "position", "passing_yards", "passing_tds",
                "rushing_yards", "rushing_tds", "receptions", "receiving_yards", "receiving_tds", "fantasy_points_ppr")
        .collect()
    )
    out = []
    for g in s.to_dicts():
        a_home = g["home_team"] == a
        a_pts, b_pts = (g["home_score"], g["away_score"]) if a_home else (g["away_score"], g["home_score"])
        exp = g["spread_line"] if a_home else (-g["spread_line"] if g["spread_line"] is not None else None)
        margin = a_pts - b_pts
        total = a_pts + b_pts
        perf = top.filter(pl.col("game_id") == g["game_id"]).sort("fantasy_points_ppr", descending=True)
        stars = []
        for r in perf.head(6).to_dicts():
            stars.append({"team": r["team"], "player_id": r["player_id"], "name": r["player_display_name"], "position": r["position"],
                          "line": _stat_line(r), "ppr": r["fantasy_points_ppr"]})
        out.append({
            **{k: g[k] for k in ("game_id", "season", "week", "game_type", "gameday", "home_team", "away_team", "roof")},
            "a": a, "b": b, "a_home": a_home, "a_pts": a_pts, "b_pts": b_pts, "margin": margin, "total": total,
            "a_spread": None if exp is None else -exp, "total_line": g["total_line"],
            "a_cover": None if exp is None else (margin > exp if margin != exp else None),
            "over": None if g["total_line"] is None else (total > g["total_line"] if total != g["total_line"] else None),
            "a_coach": g["home_coach"] if a_home else g["away_coach"], "b_coach": g["away_coach"] if a_home else g["home_coach"],
            "a_qb": g["home_qb_name"] if a_home else g["away_qb_name"], "b_qb": g["away_qb_name"] if a_home else g["home_qb_name"],
            "stars": stars,
        })
    return out


def _stat_line(r: dict) -> str:
    parts = []
    if (r.get("passing_yards") or 0) > 0:
        parts.append(f"{r['passing_yards']} pass yds" + (f", {r['passing_tds']} TD" if r.get("passing_tds") else ""))
    if (r.get("rushing_yards") or 0) != 0 and (r.get("position") != "QB" or abs(r["rushing_yards"]) >= 20):
        parts.append(f"{r['rushing_yards']} rush yds" + (f", {r['rushing_tds']} TD" if r.get("rushing_tds") else ""))
    if (r.get("receptions") or 0) > 0:
        parts.append(f"{r['receptions']} rec {r['receiving_yards']} yds" + (f", {r['receiving_tds']} TD" if r.get("receiving_tds") else ""))
    return " · ".join(parts)


# --- the game as it happened -------------------------------------------------

_BOX = ("player_id", "player_display_name", "position", "team", "week", "carries", "targets", "rushing_yards",
        "receiving_yards", "receptions", "rushing_tds", "receiving_tds")


def game_shares(game_id: str, usage_seasons: dict[str, int] | None = None) -> dict[str, dict]:
    """Who got the ball in a played game, per team: each back's carries and
    each receiver's and tight end's targets, with shares of the team's totals
    (QB scrambles and back targets count in the totals, as they do in the
    season usage table). Empty until the box score is in.

    ``zones`` adds the red zone, inside the 10 and the goal line from the
    play-by-play, every position, with each player's usual share there from
    ``usage_seasons`` (team -> season, the one the usage table reads).

    ``season`` is the same again over the team's season through this game's
    week, this game included and nothing after it, so an old game reads the
    season as it stood then."""
    season, week = (int(x) for x in game_id.split("_")[:2])
    game = (scan("player_stats_week").filter(pl.col("game_id") == game_id).select(_BOX).collect())
    if game.is_empty():
        return {}
    teams = game["team"].unique().to_list()
    to_date = (scan("player_stats_week")
               .filter((pl.col("season") == season) & (pl.col("week") <= week) & pl.col("team").is_in(teams))
               .select(_BOX).collect())
    plays_game = _zone_plays(scan("pbp").filter(pl.col("game_id") == game_id))
    plays_season = _zone_plays(scan("pbp").filter((pl.col("season") == season) & (pl.col("week") <= week)
                                                  & pl.col("posteam").is_in(teams)))
    usage_seasons = usage_seasons or {}
    out: dict[str, dict] = {}
    for team in teams:
        g = game.filter(pl.col("team") == team)
        sd = to_date.filter(pl.col("team") == team)
        use = usage_seasons.get(team, season)
        usual = _usual_zone_cached(use, week if use == season else None)
        block = _box_block(g)
        if not plays_game.is_empty():
            block["zones"] = _zone_block(plays_game.filter(pl.col("posteam") == team), team, _who(g), usual)
        sb = _box_block(sd)
        sb["weeks"] = sorted(int(w) for w in sd["week"].unique())
        if not plays_season.is_empty():
            sb["zones"] = _zone_block(plays_season.filter(pl.col("posteam") == team), team, _who(sd), None)
        block["season"] = sb
        out[team] = block
    return out


def _who(box: pl.DataFrame) -> dict[str, tuple[str, str]]:
    return {r["player_id"]: (r["player_display_name"], r["position"]) for r in box.to_dicts()}


def _box_block(box: pl.DataFrame) -> dict:
    """Carries among the backs and targets among the receivers and tight
    ends, from box-score rows (one game or several)."""
    box = box.with_columns(pl.col("carries", "targets", "rushing_yards", "receiving_yards", "receptions",
                                  "rushing_tds", "receiving_tds").fill_null(0))
    per = (box.group_by("player_id")
           .agg(pl.col("player_display_name").last(), pl.col("position").last(), pl.col("week").n_unique().alias("games"),
                pl.col("carries", "targets", "rushing_yards", "receiving_yards", "receptions", "rushing_tds", "receiving_tds").sum()))
    tc, tt = int(box["carries"].sum()), int(box["targets"].sum())

    def rows(pos: tuple[str, ...], col: str, total: int) -> list[dict]:
        sel = per.filter(pl.col("position").is_in(pos) & (pl.col(col) > 0)).sort(col, descending=True)
        car = col == "carries"
        return [{"player_id": r["player_id"], "name": r["player_display_name"], "position": r["position"],
                 "n": int(r[col]), "share": r[col] / total if total else None, "games": int(r["games"]),
                 "yards": int(r["rushing_yards" if car else "receiving_yards"]),
                 "td": int(r["rushing_tds" if car else "receiving_tds"]),
                 "receptions": None if car else int(r["receptions"])} for r in sel.to_dicts()]
    return {"team_carries": tc, "team_targets": tt, "games": int(box["week"].n_unique()),
            "carries": rows(("RB", "FB"), "carries", tc), "targets": rows(("WR", "TE"), "targets", tt)}


# Scoring territory, by yards to the goal line. Every position counts here:
# the quarterback's sneak and the back's target inside the five are the point.
ZONES = (("rz", "Red zone", 20), ("i10", "Inside the 10", 10), ("gl", "Goal line", 5))


def _zone_plays(lf: pl.LazyFrame) -> pl.DataFrame:
    """Carries and targets inside the 20, one row per play, kneels, sacks and
    two-point tries left out."""
    return (
        lf.filter((pl.col("yardline_100") <= 20) & (pl.col("two_point_attempt").fill_null(0) == 0))
        .with_columns(
            carrier=pl.when((pl.col("rush_attempt") == 1) & (pl.col("qb_kneel").fill_null(0) == 0)).then(pl.col("rusher_player_id")),
            target=pl.when((pl.col("pass_attempt") == 1) & (pl.col("sack").fill_null(0) == 0)).then(pl.col("receiver_player_id")),
        )
        .filter(pl.col("carrier").is_not_null() | pl.col("target").is_not_null())
        .select("game_id", "week", "posteam", "yardline_100", "carrier", "target", "rusher_player_name", "receiver_player_name",
                "rush_touchdown", "pass_touchdown", "air_yards")
        .collect()
    )


def _usual_zone(season: int, before_week: int | None) -> pl.DataFrame:
    """Every player's carries and targets in each zone over a season (up to a
    week), next to his team's, for the "usual" column."""
    lf = scan("pbp").filter(pl.col("season") == season)
    if before_week is not None:
        lf = lf.filter(pl.col("week") < before_week)
    plays = _zone_plays(lf)
    parts = []
    for key, _, yds in ZONES:
        z = plays.filter(pl.col("yardline_100") <= yds)
        for kind, col in (("carries", "carrier"), ("targets", "target")):
            t = z.filter(pl.col(col).is_not_null())
            tot = t.group_by("posteam").len("team_n")
            parts.append(t.group_by(col, "posteam").len("n").rename({col: "player_id"}).join(tot, on="posteam")
                         .with_columns(zone=pl.lit(key), kind=pl.lit(kind)))
    return pl.concat(parts) if parts else pl.DataFrame()


_usual_zone_cached = lru_cache(maxsize=8)(_usual_zone)


def _zone_block(tp: pl.DataFrame, team: str, who: dict[str, tuple[str, str]], usual: pl.DataFrame | None) -> dict:
    """One team's zone plays (one game or several) as shares, each player
    with his usual share there when ``usual`` is given."""
    zones = {}
    for key, label, yds in ZONES:
        z = tp.filter(pl.col("yardline_100") <= yds)
        block = {"label": label, "yards": yds}
        for kind, col, name, td in (("carries", "carrier", "rusher_player_name", "rush_touchdown"),
                                    ("targets", "target", "receiver_player_name", "pass_touchdown")):
            t = z.filter(pl.col(col).is_not_null())
            total = t.height
            agg = (t.group_by(col).agg(pl.len().alias("n"), pl.col(name).first().alias("name"),
                                       pl.col("game_id").n_unique().alias("games"),
                                       pl.col(td).fill_null(0).sum().alias("td"),
                                       (pl.col("air_yards") >= pl.col("yardline_100")).fill_null(False).sum().alias("ez"))
                   .sort(["n", "td"], descending=True))
            u = usual.filter((pl.col("zone") == key) & (pl.col("kind") == kind)) if usual is not None and not usual.is_empty() else None
            rows = []
            for r in agg.to_dicts():
                pid = r[col]
                pick = None
                if u is not None:
                    mine = u.filter(pl.col("player_id") == pid)
                    # The share with this team if he had one, else with the
                    # team he played for most, as the season usage table does.
                    here = mine.filter(pl.col("posteam") == team)
                    pick = here if not here.is_empty() else mine.sort("n", descending=True).head(1)
                    pick = None if pick.is_empty() else pick
                name, position = who.get(pid, (r["name"], ""))
                rows.append({"player_id": pid, "name": name, "position": position, "n": int(r["n"]), "games": int(r["games"]),
                             "share": r["n"] / total, "td": int(r["td"]), "ez": int(r["ez"]) if kind == "targets" else None,
                             "usual": (pick["n"][0] / pick["team_n"][0]) if pick is not None else None,
                             "usual_n": int(pick["n"][0]) if pick is not None else None})
            block[kind] = {"total": total, "rows": rows}
        zones[key] = block
    return zones


# --- personnel ---------------------------------------------------------------

DEF_GROUP = {"CB": "CB", "DB": "CB", "S": "S", "FS": "S", "SS": "S", "LB": "LB", "ILB": "LB", "OLB": "LB", "MLB": "LB",
             "DE": "DL", "DT": "DL", "NT": "DL", "DL": "DL", "EDGE": "DL"}
_PFR_SUM = ["def_targets", "def_completions_allowed", "def_yards_allowed", "def_receiving_td_allowed", "def_ints",
            "def_air_yards_completed", "def_yards_after_catch", "def_pressures", "def_sacks", "def_times_blitzed",
            "def_tackles_combined", "def_missed_tackles"]


@lru_cache(maxsize=8)
def _defense_season(season: int) -> pl.DataFrame:
    """Every defender's snaps and coverage totals for a season, league-wide.

    League-wide rather than per team so a defender who moved in the off-season
    still brings last season's numbers with him, the way the offensive table
    does. Where he earned them is kept in ``stats_team``.
    """
    try:
        snaps = (
            scan("snap_counts")
            .filter((pl.col("season") == season) & (pl.col("game_type") == "REG") & (pl.col("defense_snaps") > 0))
            .group_by(["pfr_player_id", "player", "position", "team"])
            .agg(pl.len().alias("games"), pl.col("defense_pct").mean().alias("snap_pct"), pl.col("defense_snaps").sum().alias("snaps"))
            .collect()
        )
    except FileNotFoundError:
        return pl.DataFrame()
    if snaps.is_empty():
        return snaps
    try:
        pfr = (
            scan("pfr_def").filter(pl.col("season") == season)
            .group_by(["pfr_player_id", "team"]).agg([pl.col(c).sum() for c in _PFR_SUM] + [pl.len().alias("pfr_games")])
            .collect()
        )
        snaps = snaps.join(pfr, on=["pfr_player_id", "team"], how="left")
    except FileNotFoundError:
        pass
    ids = players_master().select(pl.col("pfr_id").alias("pfr_player_id"), pl.col("gsis_id").alias("player_id"), pl.col("headshot"))
    return snaps.join(ids, on="pfr_player_id", how="left").rename({"team": "stats_team"})


@lru_cache(maxsize=64)
def defense_personnel(team: str, season: int, roster_season: int | None = None) -> list[dict]:
    """Defenders by snap share with season coverage / pass-rush totals.

    Restricted to whoever is on this year's depth chart, for the same reason
    the offensive table is: last season's snap counts still list players who
    have since left. See :func:`offense_personnel`.
    """
    snaps = _defense_season(season)
    if snaps.is_empty():
        return []
    chart = depth_chart(roster_season) if roster_season else pl.DataFrame()
    mine = chart.filter(pl.col("team") == team) if not chart.is_empty() else chart
    if mine.is_empty():
        snaps = snaps.filter(pl.col("stats_team") == team)      # no chart: the team as it played
    else:
        roster = mine.filter(pl.col("gsis_id").is_not_null())["gsis_id"].unique().to_list()
        snaps = snaps.filter(pl.col("player_id").is_in(roster))
    out, seen = [], set()
    for r in snaps.sort("snaps", descending=True).to_dicts():
        # A defender traded mid-season has a row per team. The longer stint is
        # the one that describes him; the other would read as a second player.
        pid = r.get("player_id")
        if pid is not None:
            if pid in seen:
                continue
            seen.add(pid)
        grp = DEF_GROUP.get(r["position"])
        if grp is None:
            continue
        tg = r.get("def_targets") or 0
        cmp_ = r.get("def_completions_allowed") or 0
        yds = r.get("def_yards_allowed") or 0
        out.append({
            "player_id": r.get("player_id"), "name": r["player"], "position": r["position"], "group": grp,
            "games": r["games"], "snap_pct": r["snap_pct"], "headshot": r.get("headshot"),
            "stats_team": r.get("stats_team"), "new_to_team": r.get("stats_team") != team,
            "targets": tg, "targets_pg": tg / r["games"] if r["games"] else None,
            "catch_rate": cmp_ / tg if tg else None, "yards_allowed": yds, "yards_per_target": yds / tg if tg else None,
            "td_allowed": r.get("def_receiving_td_allowed"), "ints": r.get("def_ints"),
            "adot_faced": (r.get("def_air_yards_completed") or 0) / cmp_ if cmp_ else None,
            "pressures": r.get("def_pressures"), "sacks": r.get("def_sacks"),
            "tackles": r.get("def_tackles_combined"), "missed_tackle_pct": (r.get("def_missed_tackles") or 0) / ((r.get("def_tackles_combined") or 0) + (r.get("def_missed_tackles") or 0)) if (r.get("def_tackles_combined") or 0) + (r.get("def_missed_tackles") or 0) else None,
        })
    out.sort(key=lambda x: -(x["snap_pct"] or 0))
    return out


#: How many of each position the personnel table carries.
_OFF_SLOTS = (("QB", 1), ("RB", 3), ("WR", 4), ("TE", 2))


@lru_cache(maxsize=8)
def depth_chart(season: int) -> pl.DataFrame:
    """Each team's most recently published chart for a season.

    nflverse publishes a snapshot at a time rather than a week at a time, so
    "the roster now" is the newest ``asof`` per team, not the newest overall:
    a team that has not filed since August must not be emptied out by one that
    filed yesterday.
    """
    try:
        d = load_depth_charts(seasons=[season])
    except (FileNotFoundError, ValueError):
        return pl.DataFrame()
    if d.is_empty():
        return d
    return d.filter(pl.col("asof") == pl.col("asof").max().over("team"))


def _usage_by_player(season: int) -> dict[str, dict]:
    """Last season's line for each player, wherever he played it.

    A player traded mid-season has a row per team; the one he played most of
    is the one that describes him.
    """
    u = league_usage(season)
    if u.is_empty():
        return {}
    out: dict[str, dict] = {}
    for r in u.sort("games", descending=True).to_dicts():
        out.setdefault(r["player_id"], r)
    return out


def offense_personnel(team: str, season: int, roster_season: int | None = None) -> list[dict]:
    """Who is on the team now, next to what they did in ``season``.

    The roster and the production deliberately come from different years. In
    September the only stats worth reading are last season's, but last season's
    team sheet is full of players who have since left, and the ones who arrived
    are missing from it entirely. So the names come from this year's depth
    chart and the numbers are whatever that player did last year, wherever he
    did it: ``stats_team`` says where, and the shares are against that team's
    totals, which is the only way a share means anything.

    Falls back to last season's team sheet when no chart is published, which is
    the older behaviour and still right for a season already under way.
    """
    chart = depth_chart(roster_season) if roster_season else pl.DataFrame()
    mine = chart.filter(pl.col("team") == team) if not chart.is_empty() else chart
    if mine.is_empty():
        return _personnel_by_volume(team, season)

    usage = _usage_by_player(season)
    heads = {r["player_id"]: r["headshot"] for r in player_index().select("player_id", "headshot").to_dicts()}
    blank = {c: 0 for c in USAGE_COLS + ["receiving_air_yards", "games", "team_games"]}
    keep = []
    for pos, n in _OFF_SLOTS:
        sub = mine.filter(pl.col("position") == pos).sort("rank").head(n)
        for d in sub.to_dicts():
            pid = d["gsis_id"]
            u = usage.get(pid)
            row = dict(u) if u else dict(blank, target_share=None, carry_share=None, air_share=None,
                                         targets_pg=0.0, carries_pg=0.0, ppr_pg=0.0, touches_pg=0.0)
            row.update({
                "player_id": pid,
                "player_display_name": (u or {}).get("player_display_name") or d["player_name"],
                "position": pos,                       # the chart's slot, not last year's
                "depth_rank": d["rank"],
                "stats_team": (u or {}).get("team"),
                "new_to_team": bool(u) and u.get("team") != team,
                "headshot": heads.get(pid),
            })
            row.pop("team", None)
            keep.append(row)
    return keep


def _personnel_by_volume(team: str, season: int) -> list[dict]:
    """The team sheet as it actually played, for when no chart is published."""
    u = team_usage(team, season)
    if u.is_empty():
        return []
    idx = player_index().select("player_id", "headshot")
    u = u.join(idx, on="player_id", how="left")
    keep = []
    for pos, n in _OFF_SLOTS:
        sub = u.filter(pl.col("position") == pos)
        sub = sub.sort("attempts" if pos == "QB" else "carries" if pos == "RB" else "targets", descending=True).head(n)
        for r in sub.to_dicts():
            r.update({"depth_rank": None, "stats_team": r.get("team"), "new_to_team": False})
            r.pop("team", None)
            keep.append(r)
    return keep


# --- scheme and angles -------------------------------------------------------

def _pct(rank, n) -> float | None:
    if rank is None or not n or n < 2:
        return None
    return 1 - (rank - 1) / (n - 1)


def _fmt(v, key) -> str:
    m = METRIC_BY_KEY.get(key)
    if v is None:
        return "–"
    f = m.fmt if m else "dec1"
    if f == "pct":
        # Sack and interception rates live under 10%, where whole percents
        # make a real move read as no move at all.
        return f"{v * 100:.1f}%" if abs(v) < 0.1 else f"{v * 100:.0f}%"
    return f"{v:.2f}" if f == "dec2" else f"{v:.1f}" if f == "dec1" else f"{v:.0f}"


def angles(off: dict | None, deff: dict | None, off_team: str, def_team: str, dvp: dict[str, dict | None]) -> list[dict]:
    """Where a ranked offensive tendency meets a ranked defensive one.
    Every angle carries the two numbers and ranks that fired it. These are
    prompts for research, not picks."""
    out: list[dict] = []
    if not off or not deff:
        return out
    n = off.get("n_teams") or 32

    def o(k): return off.get(k), off.get(f"{k}_rank")
    def d(k): return deff.get(k), deff.get(f"{k}_rank")
    def hi(rank, cut=8): return rank is not None and rank <= cut
    def lo(rank, cut=8): return rank is not None and rank >= n - cut + 1
    def add(title, detail, lean, tags, strength=1):
        out.append({"title": title, "detail": detail, "lean": lean, "tags": tags, "strength": strength,
                    "offense": off_team, "defense": def_team})

    pr, prr = o("pass_rate"); proe, proer = o("proe")
    dpe, dper = d("def_pass_epa"); dre, drer = d("def_rush_epa")
    if hi(prr) and hi(dper):       # def_pass_epa rank 1 = most EPA allowed (bad defense)
        add("Pass-heavy offense vs a pass defense that leaks efficiency",
            f"{off_team} pass rate {_fmt(pr,'pass_rate')} (#{prr}); {def_team} allows {_fmt(dpe,'def_pass_epa')} EPA per dropback (#{dper} most).",
            "over", ["passing", "receiving"], 2)
    if lo(prr) and hi(drer):
        add("Run-heavy offense vs a run defense that leaks efficiency",
            f"{off_team} pass rate {_fmt(pr,'pass_rate')} (#{prr}, run-leaning); {def_team} allows {_fmt(dre,'def_rush_epa')} EPA per carry (#{drer} most).",
            "over", ["rushing"], 2)
    if hi(prr) and lo(dper):
        add("Pass-heavy offense into a stingy pass defense",
            f"{off_team} throws {_fmt(pr,'pass_rate')} (#{prr}); {def_team} allows only {_fmt(dpe,'def_pass_epa')} EPA per dropback (#{dper}). Volume may hold, efficiency may not.",
            "under", ["passing", "receiving"], 1)
    if lo(prr) and lo(drer):
        add("Run-first offense into a stout run defense",
            f"{off_team} pass rate {_fmt(pr,'pass_rate')} (#{prr}); {def_team} allows {_fmt(dre,'def_rush_epa')} EPA per carry (#{drer}). Watch yards-per-carry props.",
            "under", ["rushing"], 1)

    rbt, rbtr = o("rb_target_share"); drbt, drbtr = d("def_rb_target_share")
    if hi(rbtr, 10) and hi(drbtr, 10):
        add("Running backs in the passing game, both ways",
            f"{off_team} sends {_fmt(rbt,'rb_target_share')} of targets to RBs (#{rbtr}); {def_team} lets RBs see {_fmt(drbt,'def_rb_target_share')} of targets (#{drbtr} most).",
            "over", ["receptions", "RB"], 2)
    tet, tetr = o("te_target_share"); dtet, dtetr = d("def_te_target_share")
    if hi(tetr, 10) and hi(dtetr, 10):
        add("Tight end targets line up",
            f"{off_team} TE target share {_fmt(tet,'te_target_share')} (#{tetr}); {def_team} concedes {_fmt(dtet,'def_te_target_share')} to TEs (#{dtetr} most).",
            "over", ["receptions", "TE"], 2)
    if hi(tetr, 10) and lo(dtetr, 8):
        add("TE-heavy offense vs a defense that takes tight ends away",
            f"{off_team} TE target share {_fmt(tet,'te_target_share')} (#{tetr}); {def_team} allows only {_fmt(dtet,'def_te_target_share')} to TEs (#{dtetr}).",
            "under", ["receptions", "TE"], 1)

    pace, pacer = o("sec_per_play"); plays, playsr = o("plays_pg")
    if hi(pacer, 6):     # rank 1 = slowest
        add("Slow offense: fewer plays to go around",
            f"{off_team} takes {_fmt(pace,'sec_per_play')} s per neutral play (#{pacer} slowest), {_fmt(plays,'plays_pg')} plays a game (#{playsr}). Volume props start behind.",
            "under", ["volume"], 1)
    if lo(pacer, 6) and hi(playsr, 8):
        add("Fast offense: extra plays for everyone",
            f"{off_team} snaps every {_fmt(pace,'sec_per_play')} s (#{pacer}), {_fmt(plays,'plays_pg')} plays a game (#{playsr}).",
            "over", ["volume"], 1)

    man, manr = d("def_man_rate")
    if hi(manr, 6):
        add("Man-coverage defense: separation and the CB matchup matter",
            f"{def_team} plays man on {_fmt(man,'def_man_rate')} of dropbacks (#{manr}). Check receivers' NGS separation and the coverage personnel below.",
            "neutral", ["receiving", "coverage"], 1)
    blitz, blitzr = d("def_blitz_rate"); press, pressr = d("def_pressure_rate")
    if hi(blitzr, 6) or hi(pressr, 6):
        add("Pressure defense: check the QB's pressured vs clean splits",
            f"{def_team} blitz rate {_fmt(blitz,'def_blitz_rate')} (#{blitzr}), pressure rate {_fmt(press,'def_pressure_rate')} (#{pressr}). Sack-rate and completion props hinge on it.",
            "neutral", ["passing", "pressure"], 1)
    box, boxr = d("def_box_avg")
    if hi(boxr, 6):
        add("Heavy boxes vs the run",
            f"{def_team} averages {_fmt(box,'def_box_avg')} in the box against rushes (#{boxr} heaviest). Look at the RB's stacked-box split.",
            "under", ["rushing"], 1)
    if lo(boxr, 6):
        add("Light boxes: room to run",
            f"{def_team} averages {_fmt(box,'def_box_avg')} in the box against rushes (#{boxr}, lightest end).",
            "over", ["rushing"], 1)

    rz, rzr = o("rz_td_rate"); drz, drzr = d("def_rz_td_rate")
    if hi(rzr, 8) and hi(drzr, 8):
        add("Red zone favours touchdowns",
            f"{off_team} scores TDs on {_fmt(rz,'rz_td_rate')} of red-zone trips (#{rzr}); {def_team} allows {_fmt(drz,'def_rz_td_rate')} (#{drzr} most).",
            "over", ["touchdowns"], 2)
    if lo(rzr, 8) and lo(drzr, 8):
        add("Red zone favours field goals",
            f"{off_team} converts {_fmt(rz,'rz_td_rate')} of trips (#{rzr}); {def_team} allows {_fmt(drz,'def_rz_td_rate')} (#{drzr}). Kicker points over anytime-TD.",
            "under", ["touchdowns", "kicking"], 1)
    pa, par = o("pa_rate")
    if hi(par, 6):
        add("Play-action offense",
            f"{off_team} uses play action on {_fmt(pa,'pa_rate')} of dropbacks (#{par}). Receivers' play-action split is worth a look.",
            "neutral", ["passing", "receiving"], 1)

    for pos, row in dvp.items():
        if not row:
            continue
        key = {"QB": "passing_yards", "RB": "rushing_yards", "WR": "receiving_yards", "TE": "receiving_yards"}[pos]
        rank = row.get(f"{key}_rank"); v = row.get(key)
        if rank is not None and rank <= 5:
            add(f"{def_team} has been generous to {pos}s",
                f"{v:.1f} {DVP_LABELS[key].lower()} per game allowed to {pos}s, #{rank} most in the league.",
                "over", [pos], 1)
        elif rank is not None and rank >= 28:
            add(f"{def_team} has clamped {pos}s",
                f"{v:.1f} {DVP_LABELS[key].lower()} per game allowed to {pos}s, #{rank} of {row.get('n_teams', 32)}.",
                "under", [pos], 1)
    out.sort(key=lambda x: -x["strength"])
    return out


def venue(game: dict) -> dict:
    return {k: game.get(k) for k in ("stadium", "roof", "surface", "temp", "wind", "gameday", "gametime", "div_game")}



def side_team_angles(off: dict | None, deff: dict | None, off_team: str, def_team: str,
                     dvp: dict[str, dict | None], off_spread: float | None, venue_info: dict | None) -> list[dict]:
    """Every team angle for one side of one game, strongest first. The
    matchup page and the post-game grader both call this, so what gets graded
    is what the page showed."""
    out = angles(off, deff, off_team, def_team, dvp)
    out += team_angles_extra(off, deff, off_team, def_team, off_spread, venue_info)
    out = note_adjusted(out, deff, off_team) + h2h_angles(off, deff, off_team, def_team)
    out.sort(key=lambda x: -x["strength"])
    return out

# --- more team angles: game script, ball security, downs, kicking, coverage ---

def team_angles_extra(off: dict | None, deff: dict | None, off_team: str, def_team: str,
                      off_spread: float | None, venue_info: dict | None) -> list[dict]:
    """Second batch of collisions. ``off_spread`` is the betting spread from
    the offense's side (negative = favoured)."""
    out: list[dict] = []
    if not off or not deff:
        return out
    n = off.get("n_teams") or 32

    def o(k): return off.get(k), off.get(f"{k}_rank")
    def d(k): return deff.get(k), deff.get(f"{k}_rank")
    def hi(rank, cut=8): return rank is not None and rank <= cut
    def lo(rank, cut=8): return rank is not None and rank >= n - cut + 1
    def add(title, detail, lean, tags, strength=1):
        out.append({"title": title, "detail": detail, "lean": lean, "tags": tags, "strength": strength,
                    "offense": off_team, "defense": def_team})

    # Game script from the spread.
    if off_spread is not None:
        if off_spread <= -7:
            add("Big favourite: leading script",
                f"{off_team} is favoured by {abs(off_spread):g}. Favourites of a touchdown or more run more in the second half; the opponent throws more while trailing.",
                "over", ["rushing", "carries"], 1)
        elif off_spread >= 7:
            add("Big underdog: trailing script",
                f"{off_team} is a {off_spread:g}-point underdog. Trailing teams throw more and run less; pass attempts and receptions lean up, carries lean down.",
                "over", ["pass attempts", "receptions"], 1)

    # Weather, when the schedule has it.
    if venue_info and venue_info.get("wind") is not None and venue_info["wind"] >= 15 and venue_info.get("roof") in ("outdoors", "open"):
        add("Wind", f"{venue_info['wind']} mph forecast at an outdoor venue. Deep passing, field goals and totals all suffer in wind of 15+.", "under", ["passing", "kicking", "total"], 2)
    if venue_info and venue_info.get("temp") is not None and venue_info["temp"] <= 25:
        add("Cold", f"{venue_info['temp']}°F. Cold games trend toward fewer points and more runs.", "under", ["passing", "total"], 1)

    # Sacks and pressure.
    sr, srr = o("sack_rate_taken"); dsr, dsrr = d("def_sack_rate")
    if hi(srr) and hi(dsrr):       # sack_rate_taken good=low -> rank 1 = most sacks taken
        add("Sacks: a line that gives them up vs a rush that gets them",
            f"{off_team} is sacked on {_fmt(sr,'sack_rate_taken')} of dropbacks (#{srr} most); {def_team} sacks on {_fmt(dsr,'def_sack_rate')} (#{dsrr}). QB sack props and passing-yard unders.",
            "over", ["sacks", "defense"], 2)
    if lo(srr) and lo(dsrr):
        add("Clean pockets on both counts",
            f"{off_team} sacked on only {_fmt(sr,'sack_rate_taken')} (#{srr}); {def_team} sack rate {_fmt(dsr,'def_sack_rate')} (#{dsrr}).",
            "under", ["sacks"], 1)

    # Interceptions.
    ir, irr = o("int_rate"); dir_, dirr = d("def_int_rate")
    if hi(irr) and hi(dirr):
        add("Interception risk",
            f"{off_team} throws a pick on {_fmt(ir,'int_rate')} of dropbacks (#{irr} most); {def_team} intercepts {_fmt(dir_,'def_int_rate')} (#{dirr}). Interception props lean over, defensive INT props too.",
            "over", ["interceptions"], 2)
    if lo(irr) and lo(dirr):
        add("Interceptions unlikely",
            f"{off_team} INT rate {_fmt(ir,'int_rate')} (#{irr}); {def_team} INT rate {_fmt(dir_,'def_int_rate')} (#{dirr}).",
            "under", ["interceptions"], 1)

    # Third downs sustain drives.
    tc, tcr = o("third_down_conv"); dtc, dtcr = d("def_third_down_conv")
    if hi(tcr) and hi(dtcr):       # def_third_down_conv good=low -> rank 1 = most conversions allowed
        add("Drives should sustain",
            f"{off_team} converts {_fmt(tc,'third_down_conv')} of third downs (#{tcr}); {def_team} allows {_fmt(dtc,'def_third_down_conv')} (#{dtcr} most). More plays, more volume.",
            "over", ["volume"], 1)
    if lo(tcr) and lo(dtcr):
        add("Three-and-outs likely",
            f"{off_team} converts {_fmt(tc,'third_down_conv')} (#{tcr}); {def_team} allows {_fmt(dtc,'def_third_down_conv')} (#{dtcr}).",
            "under", ["volume"], 1)

    # Field goals.
    fg, fgr = o("fga_pg"); dfg, dfgr = d("def_fga_pg")
    if hi(fgr, 6) and hi(dfgr, 6):
        add("Kicker volume",
            f"{off_team} attempts {_fmt(fg,'fga_pg')} field goals a game (#{fgr}); {def_team} forces {_fmt(dfg,'def_fga_pg')} (#{dfgr}). Kicking points and FG-made props.",
            "over", ["kicking"], 2)

    # Red-zone distribution vs what the defense allows.
    rzte, rzter = o("rz_te_target_share"); dte, dter = d("def_te_target_share")
    if hi(rzter, 8) and hi(dter, 10):
        add("Tight end in the red zone",
            f"{off_team} sends {_fmt(rzte,'rz_te_target_share')} of red-zone targets to TEs (#{rzter}); {def_team} concedes {_fmt(dte,'def_te_target_share')} of targets to TEs (#{dter} most). TE anytime-TD.",
            "over", ["touchdowns", "TE"], 2)
    rzrb, rzrbr = o("rz_rb_target_share"); drb, drbr = d("def_rb_target_share")
    if hi(rzrbr, 8) and hi(drbr, 10):
        add("Running back in the red zone passing game",
            f"{off_team} red-zone RB target share {_fmt(rzrb,'rz_rb_target_share')} (#{rzrbr}); {def_team} RB target share allowed {_fmt(drb,'def_rb_target_share')} (#{drbr}).",
            "over", ["touchdowns", "RB"], 1)

    # Deep passing vs explosive allowed.
    deep, deepr = o("deep_rate"); dex, dexr = d("def_explosive_rate")
    if hi(deepr, 8) and hi(dexr, 8):
        add("Shots downfield vs a defense that gives up explosives",
            f"{off_team} throws 20+ air yards on {_fmt(deep,'deep_rate')} of targets (#{deepr}); {def_team} allows explosive plays at {_fmt(dex,'def_explosive_rate')} (#{dexr} most). Longest-reception and longest-completion props.",
            "over", ["longest", "receiving"], 2)
    ddeep, ddeepr = d("def_deep_rate_faced")
    if hi(deepr, 8) and lo(ddeepr, 8):
        add("Deep offense vs a defense that takes the deep ball away",
            f"{off_team} deep rate {_fmt(deep,'deep_rate')} (#{deepr}); opponents only go deep {_fmt(ddeep,'def_deep_rate_faced')} of the time against {def_team} (#{ddeepr}). Two-high looks likely; check the QB's split vs two-high.",
            "neutral", ["passing", "coverage"], 1)

    # Coverage mix cues.
    c2h, c2hr = d("def_two_high_rate"); c1, c1r = d("def_cover1_rate"); c0, c0r = d("def_cover0_rate")
    if hi(c2hr, 6):
        add("Two-high defense: underneath and the run are what is offered",
            f"{def_team} plays two-high (cover 2/4/6, 2-man) on {_fmt(c2h,'def_two_high_rate')} of dropbacks (#{c2hr}). Favors RB and TE receptions and the run; WR deep props lean under.",
            "neutral", ["coverage", "RB", "TE"], 1)
    if hi(c1r, 6) or hi(c0r, 6):
        add("Single-high man defense: WR1 matchup and deep shots",
            f"{def_team} cover 1 {_fmt(c1,'def_cover1_rate')} (#{c1r}), cover 0 {_fmt(c0,'def_cover0_rate')} (#{c0r}). One-on-one outside; check receivers' man-coverage splits and the CB's yards per target.",
            "neutral", ["coverage", "WR"], 1)

    # Screens beat blitzes.
    scr, scrr = o("screen_rate"); bl, blr = d("def_blitz_rate")
    if hi(scrr, 8) and hi(blr, 8):
        add("Screens vs a blitzing defense",
            f"{off_team} screens on {_fmt(scr,'screen_rate')} of dropbacks (#{scrr}); {def_team} blitzes {_fmt(bl,'def_blitz_rate')} (#{blr}). RB and WR receptions lean up, yards after catch too.",
            "over", ["receptions", "RB"], 1)

    # QB rushing.
    qbr, qbrr = o("qb_rush_rate"); dre, drer = d("def_rush_epa")
    if hi(qbrr, 6) and hi(drer, 10):
        add("Mobile QB vs a run defense that leaks",
            f"{off_team} QB rush rate {_fmt(qbr,'qb_rush_rate')} (#{qbrr}); {def_team} allows {_fmt(dre,'def_rush_epa')} EPA per carry (#{drer} most). QB rushing yards.",
            "over", ["rushing", "QB"], 1)
    return out


# --- player angles: a key player's own splits vs the opponent's tendency ----

def _lvl(dim_levels: list[dict], name: str) -> dict | None:
    return next((l for l in dim_levels if l["level"] == name), None)


def player_angles(side_players: list[dict], deff: dict | None, def_team: str, since: int,
                  before: tuple[int, int] | None = None) -> list[dict]:
    """For the QB, top RBs, WRs and TEs on the offense: pull their play-level
    splits and compare against what this defense does most. Also each
    player's history against this opponent. ``before=(season, week)`` reads
    only games before that one (see :mod:`dashboard.stats.angle_grades`)."""
    from .gamelog import game_log
    from .pbp import splits

    out: list[dict] = []
    if not deff:
        return out
    n = deff.get("n_teams") or 32

    def d(k): return deff.get(k), deff.get(f"{k}_rank")
    def hi(rank, cut=8): return rank is not None and rank <= cut
    def lo(rank, cut=8): return rank is not None and rank >= n - cut + 1
    def add(p, title, detail, lean, tags, strength=1):
        out.append({"title": title, "detail": detail, "lean": lean, "tags": tags, "strength": strength,
                    "player_id": p["player_id"], "player": p["player_display_name"], "position": p["position"], "defense": def_team})

    press, pressr = d("def_pressure_rate"); blitz, blitzr = d("def_blitz_rate")
    man, manr = d("def_man_rate"); box, boxr = d("def_box_avg"); c2h, c2hr = d("def_two_high_rate")
    pa_note = None
    for p in side_players:
        pos = p["position"]
        pid = p["player_id"]
        try:
            if pos == "QB":
                sp = splits(pid, "pass", ["pressure", "blitz", "man_zone", "play_action", "coverage"], since=since, before=before)
                dims = {x["key"]: x["levels"] for x in sp["dims"]}
                if "pressure" in dims and (hi(pressr) or hi(blitzr)):
                    pr, cl = _lvl(dims["pressure"], "Pressured"), _lvl(dims["pressure"], "Clean pocket")
                    if pr and cl and pr["plays"] >= 40:
                        gap = (cl["epa"] or 0) - (pr["epa"] or 0)
                        add(p, f"{p['player_display_name']} under pressure vs a pressure defense",
                            f"EPA per dropback {pr['epa']:+.2f} when pressured vs {cl['epa']:+.2f} clean ({pr['plays']} pressured dropbacks since {since}). {def_team} pressure rate {_fmt(press,'def_pressure_rate')} (#{pressr}), blitz {_fmt(blitz,'def_blitz_rate')} (#{blitzr}).",
                            "under" if gap > 0.45 else "neutral", ["passing", "QB"], 2 if gap > 0.45 else 1)
                if "blitz" in dims and hi(blitzr):
                    b, nb = _lvl(dims["blitz"], "Blitz"), _lvl(dims["blitz"], "No blitz")
                    if b and nb and b["plays"] >= 30:
                        add(p, f"{p['player_display_name']} vs the blitz",
                            f"EPA per dropback {b['epa']:+.2f} blitzed vs {nb['epa']:+.2f} not ({b['plays']} blitzed dropbacks). {def_team} blitzes {_fmt(blitz,'def_blitz_rate')} (#{blitzr}).",
                            "over" if (b["epa"] or 0) > (nb["epa"] or 0) + 0.1 else "under" if (b["epa"] or 0) < (nb["epa"] or 0) - 0.15 else "neutral", ["passing", "QB"], 1)
                if "man_zone" in dims and (hi(manr, 8) or lo(manr, 8)):
                    m, z = _lvl(dims["man_zone"], "Man Coverage"), _lvl(dims["man_zone"], "Zone Coverage")
                    if m and z and m["plays"] >= 40:
                        face = "man" if hi(manr, 8) else "zone"
                        better = "man" if (m["epa"] or 0) > (z["epa"] or 0) else "zone"
                        add(p, f"{p['player_display_name']} vs {face} coverage",
                            f"EPA per dropback {m['epa']:+.2f} vs man, {z['epa']:+.2f} vs zone. {def_team} man rate {_fmt(man,'def_man_rate')} (#{manr}).",
                            "over" if better == face else "under", ["passing", "QB"], 1)
                if "coverage" in dims and hi(c2hr, 8):
                    two = [l for l in dims["coverage"] if l["level"] in ("Cover 2", "Cover 4", "Cover 6", "2 Man")]
                    one = [l for l in dims["coverage"] if l["level"] in ("Cover 1", "Cover 3", "Cover 0")]
                    if two and one:
                        e2 = sum((l["epa"] or 0) * l["plays"] for l in two) / max(1, sum(l["plays"] for l in two))
                        e1 = sum((l["epa"] or 0) * l["plays"] for l in one) / max(1, sum(l["plays"] for l in one))
                        add(p, f"{p['player_display_name']} vs two-high shells",
                            f"EPA per dropback {e2:+.2f} vs two-high, {e1:+.2f} vs single-high. {def_team} two-high rate {_fmt(c2h,'def_two_high_rate')} (#{c2hr}).",
                            "over" if e2 > e1 + 0.05 else "under" if e2 < e1 - 0.1 else "neutral", ["passing", "QB"], 1)
            elif pos == "RB":
                sp = splits(pid, "rush", ["box", "ngs_box"], since=since, before=before)
                dims = {x["key"]: x["levels"] for x in sp["dims"]}
                lv = dims.get("box") or dims.get("ngs_box")
                if lv and (hi(boxr, 8) or lo(boxr, 8)):
                    st, li = _lvl(lv, "Stacked (8+)"), _lvl(lv, "Light box (≤6)")
                    if st and li and st["plays"] >= 20:
                        heavy = hi(boxr, 8)
                        add(p, f"{p['player_display_name']} vs {'stacked' if heavy else 'light'} boxes",
                            f"{st['ypc']:.1f} yds/carry vs 8+ in the box ({st['plays']} carries), {li['ypc']:.1f} vs light boxes. {def_team} averages {_fmt(box,'def_box_avg')} in the box (#{boxr}).",
                            ("under" if st["ypc"] < li["ypc"] - 0.7 else "neutral") if heavy else ("over" if li["ypc"] > st["ypc"] + 0.7 else "neutral"), ["rushing", "RB"], 1)
            elif pos in ("WR", "TE"):
                sp = splits(pid, "rec", ["man_zone"], since=since, before=before)
                dims = {x["key"]: x["levels"] for x in sp["dims"]}
                if "man_zone" in dims and (hi(manr, 8) or lo(manr, 8)):
                    m, z = _lvl(dims["man_zone"], "Man Coverage"), _lvl(dims["man_zone"], "Zone Coverage")
                    if m and z and m["plays"] >= 25 and z["plays"] >= 25:
                        face = "man" if hi(manr, 8) else "zone"
                        mv, zv = m["ypt"] or 0, z["ypt"] or 0
                        better = "man" if mv > zv else "zone"
                        gap = abs(mv - zv)
                        add(p, f"{p['player_display_name']} vs {face} coverage",
                            f"{mv:.1f} yds/target vs man ({m['plays']} targets), {zv:.1f} vs zone ({z['plays']}). {def_team} man rate {_fmt(man,'def_man_rate')} (#{manr}).",
                            ("over" if better == face else "under") if gap >= 1.5 else "neutral", ["receiving", pos], 2 if gap >= 2.5 else 1)
            # history vs this opponent
            gl = game_log(pid)
            key = {"QB": "passing_yards", "RB": "rushing_yards", "WR": "receiving_yards", "TE": "receiving_yards"}[pos]
            recent = gl.filter(pl.col("season") >= since)
            if before is not None:
                recent = recent.filter((pl.col("season") < before[0]) | ((pl.col("season") == before[0]) & (pl.col("week") < before[1])))
            vs = recent.filter(pl.col("opponent") == def_team)
            if vs.height >= 2 and recent.height >= 8:
                a, b = float(vs[key].mean()), float(recent[key].mean())
                # Only players with a real role: a 9-yard-a-game back "averaging 0" is noise.
                if b >= 15 and abs(a - b) / b >= 0.2:
                    label = {"passing_yards": "passing yards", "rushing_yards": "rushing yards", "receiving_yards": "receiving yards"}[key]
                    add(p, f"{p['player_display_name']} vs {def_team}, history",
                        f"{a:.1f} {label} per game in {vs.height} meetings since {since}, vs {b:.1f} overall. " + ", ".join(f"{r['season']} W{r['week']}: {r[key]}" for r in vs.sort(['season','week'], descending=[True, True]).head(4).to_dicts()) + ".",
                        "over" if a > b else "under", ["history", pos], 1)
        except Exception:      # a player without plays in the window; skip quietly
            continue
    return out


# --- head to head: what this offense does to this defense, and back ----------

#: For each metric the matchup view can move: the angle to raise when the
#: projection rises well above the team's usual rank, and when it falls well
#: below. ``(title, lean, tags)``; ``{d}``/``{o}`` are the defense/offense.
_H2H_TEXT: dict[str, tuple[tuple[str, str, list[str]], tuple[str, str, list[str]]]] = {
    "def_box_avg": (("{d} likely to load the box more than usual against {o}", "under", ["rushing", "RB"]),
                    ("{d} likely to lighten the box against {o}: room for the run", "over", ["rushing", "RB"])),
    "def_man_rate": (("{d} likely to play more man than usual against {o}", "neutral", ["receiving", "coverage"]),
                     ("{d} likely to sit in zone more than usual against {o}", "neutral", ["receiving", "coverage"])),
    "def_two_high_rate": (("{d} likely to play more two-high shells against {o}: underneath and the run open up", "neutral", ["coverage", "RB", "TE"]),
                          ("{d} likely to play more single-high against {o}: one-on-ones outside", "neutral", ["coverage", "WR"])),
    "def_blitz_rate": (("{d} likely to blitz more than usual against {o}", "neutral", ["passing", "pressure"]),
                       ("{d} likely to blitz less than usual against {o}", "neutral", ["passing", "pressure"])),
    "def_pressure_rate": (("{o}'s line gives up pressure: {d} should get home more than usual", "under", ["passing", "QB"]),
                          ("{o} keeps the pocket clean: {d}'s pass rush should get home less than usual", "over", ["passing", "QB"])),
    "def_sack_rate": (("{d} should sack {o} more than it sacks most teams", "over", ["sacks", "defense"]),
                      ("{o} rarely goes down: {d}'s sack rate should dip", "under", ["sacks", "defense"])),
    "def_pass_epa": (("{o}'s passing game beats most defenses: {d} should give up more than usual through the air", "over", ["passing", "receiving"]),
                     ("{o}'s passing game has been easy to defend: {d} should allow less than usual", "under", ["passing", "receiving"])),
    "def_rush_epa": (("{o}'s run game beats most defenses: {d} should give up more than usual on the ground", "over", ["rushing"]),
                     ("{o}'s run game has been easy to stop: {d} should allow less than usual", "under", ["rushing"])),
    "pass_rate": (("{d} is thrown on: {o} likely to pass more than usual", "over", ["pass attempts", "receiving"]),
                  ("{d} is run on: {o} likely to lean on the ground more than usual", "over", ["carries", "rushing"])),
    "rb_target_share": (("{d} funnels targets to backs: {o}'s RBs should see more of them", "over", ["receptions", "RB"]),
                        ("{d} takes backs away in the passing game", "under", ["receptions", "RB"])),
    "te_target_share": (("{d} funnels targets to tight ends: {o}'s TEs should see more of them", "over", ["receptions", "TE"]),
                        ("{d} takes tight ends away", "under", ["receptions", "TE"])),
}

#: A projected rank has to move this far from the usual one to be an angle.
H2H_MIN_MOVE = 6


def h2h_angles(off: dict | None, deff: dict | None, off_team: str, def_team: str) -> list[dict]:
    """Angles from the matchup view: where who this defense is facing should
    change what it does, or who this offense is facing should change what it
    does. A defense that stacks the box against everyone and a quarterback
    whose offense draws light boxes from everyone do not meet at the
    defense's number."""
    out: list[dict] = []
    for row in (deff, off):
        for s in (row or {}).get("_h2h") or []:
            text = _H2H_TEXT.get(s["key"])
            if not text or s.get("usual_rank") is None or abs(s.get("moved") or 0) < H2H_MIN_MOVE:
                continue
            # Rank 1 is the highest value, so a smaller projected rank means
            # the number went up.
            (title, lean, tags) = text[0] if s["expected_rank"] < s["usual_rank"] else text[1]
            k = s["key"]
            n = s["n_teams"]
            if s["side"] == "def":
                detail = (f"{s['label']}: {def_team}'s usual is {_fmt(s['usual'], k)} (#{s['usual_rank']} of {n}). "
                          f"Defenses facing {off_team} have shown {_fmt(s['drawn'], k)} (#{s['drawn_rank']}). "
                          f"Projected for this game: {_fmt(s['expected'], k)}, which would rank #{s['expected_rank']}.")
            else:
                mirror = _OFF_MIRROR.get(k, k)
                detail = (f"{s['label']}: {off_team}'s usual is {_fmt(s['usual'], k)} (#{s['usual_rank']} of {n}). "
                          f"{def_team}'s opponents have come in at {_fmt(s['drawn'], mirror)} (#{s['drawn_rank']}). "
                          f"Projected for this game: {_fmt(s['expected'], k)}, which would rank #{s['expected_rank']}.")
            out.append({"title": title.format(d=def_team, o=off_team), "detail": detail, "lean": lean,
                        "tags": tags + ["matchup"], "strength": 2 if abs(s["moved"]) >= 12 else 1,
                        "offense": off_team, "defense": def_team})
    return out


_OFF_MIRROR = {"pass_rate": "def_pass_rate_faced", "rb_target_share": "def_rb_target_share", "te_target_share": "def_te_target_share"}

#: Which adjusted numbers each existing angle quotes, found by its title.
_ANGLE_KEYS: list[tuple[str, tuple[str, ...]]] = [
    ("pass defense", ("def_pass_epa",)), ("run defense", ("def_rush_epa",)),
    ("Man-coverage defense", ("def_man_rate",)), ("Pressure defense", ("def_pressure_rate", "def_blitz_rate")),
    ("boxes", ("def_box_avg",)), ("Sacks", ("def_sack_rate",)), ("Clean pockets", ("def_sack_rate",)),
    ("Two-high defense", ("def_two_high_rate",)), ("two-high shells", ("def_two_high_rate",)),
    ("blitzing defense", ("def_blitz_rate",)), ("vs the blitz", ("def_blitz_rate",)),
    ("under pressure vs", ("def_pressure_rate", "def_blitz_rate")),
    ("vs man coverage", ("def_man_rate",)), ("vs zone coverage", ("def_man_rate",)),
]


def note_adjusted(angles_: list[dict], deff: dict | None, off_team: str) -> list[dict]:
    """Say so when an angle's defensive number is the matchup projection
    rather than the defense's usual one. The number is what fired the angle,
    so the reader should know where it came from."""
    moved = {s["key"]: s for s in (deff or {}).get("_h2h") or [] if abs(s.get("moved") or 0) >= 3}
    if not moved:
        return angles_
    for a in angles_:
        keys = next((ks for frag, ks in _ANGLE_KEYS if frag in a["title"]), ())
        notes = [f"{moved[k]['label']} projected for {off_team}: {_fmt(moved[k]['expected'], k)} (#{moved[k]['expected_rank']}) "
                 f"against a usual {_fmt(moved[k]['usual'], k)} (#{moved[k]['usual_rank']})" for k in keys if k in moved]
        if notes:
            a["detail"] += " " + "; ".join(notes) + "."
    return angles_
