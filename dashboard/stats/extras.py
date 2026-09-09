"""Research extras that sit on top of the game log: teammate presence
(with / without splits), same-game correlations, opponent-adjustment
factors, and the alert feed."""

from __future__ import annotations

from functools import lru_cache

import polars as pl

from nfl.data import scan

from ..config import CURRENT_SEASON
from ..odds.markets import BY_KEY
from .context import DVP_STATS, dvp_table, team_injuries
from .gamelog import game_log, players_master
from .players import player_index

SKILL = ["QB", "RB", "FB", "HB", "WR", "TE"]


# --- teammates ------------------------------------------------------------------

def teammate_presence(player_id: str, since: int | None = None, top: int = 8) -> dict:
    """Which skill-position teammates were on the field (offensive snaps > 0)
    in each of the player's games. The frontend turns this into "with X" and
    "without X" splits for any stat.

    Only games from team-seasons the teammate actually appeared in count as
    "without", so a 2023 game is not scored as "without" a 2025 arrival."""
    since = since or CURRENT_SEASON - 3
    gl = game_log(player_id).filter(pl.col("season") >= since).select("game_id", "season", "team")
    if gl.is_empty():
        return {"teammates": [], "presence": {}}
    pairs = gl.select("season", "team").unique()
    try:
        snaps = (
            scan("snap_counts")
            .filter((pl.col("season") >= since) & (pl.col("offense_snaps") > 0) & pl.col("position").is_in(SKILL))
            .select("game_id", "season", "team", "pfr_player_id", "player", "position", "offense_snaps")
            .collect()
            .join(pairs, on=["season", "team"], how="semi")
        )
    except FileNotFoundError:
        return {"teammates": [], "presence": {}}
    ids = players_master().select(pl.col("pfr_id").alias("pfr_player_id"), pl.col("gsis_id").alias("player_id"))
    snaps = snaps.join(ids, on="pfr_player_id", how="left").filter(pl.col("player_id").is_not_null() & (pl.col("player_id") != player_id))
    my_games = set(gl["game_id"].to_list())
    snaps = snaps.filter(pl.col("game_id").is_in(list(my_games)))
    if snaps.is_empty():
        return {"teammates": [], "presence": {}}
    ranked = (
        snaps.group_by(["player_id", "player", "position"])
        .agg(pl.col("offense_snaps").sum().alias("snaps"), pl.len().alias("games_with"),
             pl.col("season").unique().alias("seasons"))
        .sort("snaps", descending=True).head(top)
    )
    teammates = []
    presence: dict[str, list[str]] = {}
    for r in ranked.to_dicts():
        with_games = snaps.filter(pl.col("player_id") == r["player_id"])["game_id"].to_list()
        # eligible = my games in seasons the teammate was on this team
        seasons = set(r["seasons"])
        eligible = gl.filter(pl.col("season").is_in(list(seasons)))["game_id"].to_list()
        presence[r["player_id"]] = with_games
        teammates.append({"player_id": r["player_id"], "name": r["player"], "position": r["position"],
                          "games_with": len(with_games), "games_without": len(set(eligible) - set(with_games)),
                          "eligible": eligible})
    return {"teammates": teammates, "presence": presence, "since": since}


# --- correlations ----------------------------------------------------------------

CORR_STATS = ["attempts", "passing_yards", "passing_tds", "carries", "rushing_yards", "rushing_tds",
              "targets", "receptions", "receiving_yards", "receiving_tds", "fantasy_points_ppr"]
CORR_LABELS = {"attempts": "pass att", "passing_yards": "pass yds", "passing_tds": "pass TD", "carries": "carries",
               "rushing_yards": "rush yds", "rushing_tds": "rush TD", "targets": "targets", "receptions": "rec",
               "receiving_yards": "rec yds", "receiving_tds": "rec TD", "fantasy_points_ppr": "PPR"}


def correlations(player_id: str, stat: str, since: int | None = None, min_n: int = 8) -> list[dict]:
    """Pearson correlation between the player's stat and each teammate's stats
    over the games they shared, plus team score and total. For same-game parlays."""
    since = since or CURRENT_SEASON - 3
    gl = game_log(player_id).filter(pl.col("season") >= since)
    if gl.is_empty() or stat not in gl.columns:
        return []
    mine = gl.select("game_id", "season", "team", "team_score", "opp_score", pl.col(stat).cast(pl.Float64).alias("_x")).filter(pl.col("_x").is_not_null())
    if mine.height < min_n:
        return []
    pairs = mine.select("season", "team").unique()
    mates = (
        scan("player_stats_week")
        .filter((pl.col("season") >= since) & pl.col("position").is_in(SKILL) & (pl.col("player_id") != player_id))
        .select(["game_id", "season", "team", "player_id", "player_display_name", "position"] + CORR_STATS)
        .collect()
        .join(pairs, on=["season", "team"], how="semi")
        .filter(pl.col("game_id").is_in(mine["game_id"].to_list()))
    )
    out = []
    xs = mine
    # team-level first
    for col, label in (("team_score", "team points"), ("opp_score", "opponent points")):
        r, n = _pearson(xs["_x"], xs[col].cast(pl.Float64))
        if r is not None:
            out.append({"with": label, "player_id": None, "stat": col, "r": r, "n": n})
    tot = (xs["team_score"] + xs["opp_score"]).cast(pl.Float64)
    r, n = _pearson(xs["_x"], tot)
    if r is not None:
        out.append({"with": "game total points", "player_id": None, "stat": "total", "r": r, "n": n})
    if not mates.is_empty():
        top = mates.group_by(["player_id", "player_display_name", "position"]).agg(pl.col("fantasy_points_ppr").sum().alias("ppr"), pl.len().alias("g")).filter(pl.col("g") >= min_n).sort("ppr", descending=True).head(8)
        for t in top.to_dicts():
            sub = mates.filter(pl.col("player_id") == t["player_id"]).join(xs.select("game_id", "_x"), on="game_id")
            for c in CORR_STATS:
                if c == "fantasy_points_ppr":
                    continue
                # A stat the teammate barely records (a TE's carries) correlates by accident.
                mu = sub[c].cast(pl.Float64).mean()
                if mu is None or mu < (0.25 if c.endswith("_tds") else 1.5):
                    continue
                if t["position"] == "QB" and c in ("targets", "receptions", "receiving_yards", "receiving_tds"):
                    continue
                if t["position"] != "QB" and c in ("attempts", "passing_yards", "passing_tds"):
                    continue
                r, n = _pearson(sub["_x"], sub[c].cast(pl.Float64))
                if r is not None and abs(r) >= 0.15:
                    out.append({"with": f"{t['player_display_name']} {CORR_LABELS[c]}", "player_id": t["player_id"], "name": t["player_display_name"], "position": t["position"], "stat": c, "r": r, "n": n})
    out.sort(key=lambda d: -abs(d["r"]))
    return out


def _pearson(a: pl.Series, b: pl.Series) -> tuple[float | None, int]:
    df = pl.DataFrame({"a": a, "b": b}).drop_nulls()
    n = df.height
    if n < 8 or df["a"].std() == 0 or df["b"].std() == 0:
        return None, n
    return round(float(pl.Series(df["a"]).cast(pl.Float64).to_frame().hstack([df["b"]]).select(pl.corr("a", "b")).item()), 3), n


# --- opponent adjustment ---------------------------------------------------------

_DVP_KEY = {s: s for s in DVP_STATS}
_DVP_KEY.update({"completions": "passing_yards", "attempts": "passing_yards", "rush_rec_yards": "receiving_yards",
                 "total_tds": "receiving_tds", "rush_rec_tds": "receiving_tds", "pass_rush_yards": "passing_yards",
                 "yards_per_carry": "rushing_yards", "yards_per_target": "receiving_yards"})


@lru_cache(maxsize=256)
def dvp_factors(position: str, stat: str, since: int) -> dict:
    """{season: {defense: factor}} where factor = league average allowed /
    this defense allowed, per season. Multiply a game's value by it to ask
    'what would this have been against an average defense'. Clipped 0.7-1.4."""
    key = _DVP_KEY.get(stat)
    pos = {"FB": "RB", "HB": "RB"}.get(position, position)
    if not key or pos not in ("QB", "RB", "WR", "TE"):
        return {"stat": stat, "dvp_stat": None, "factors": {}}
    out: dict[int, dict[str, float]] = {}
    for season in range(since, CURRENT_SEASON + 1):
        t = dvp_table(season, pos)
        if t.is_empty() or t["games"].max() < 4:
            continue
        league = float(t[key].mean())
        if not league:
            continue
        out[season] = {r["defense"]: round(min(1.4, max(0.7, league / r[key])), 3) for r in t.to_dicts() if r[key]}
    return {"stat": stat, "dvp_stat": key, "factors": out}


# --- alerts ----------------------------------------------------------------------

def alerts(rows: list[dict], season: int, week: int, scale: float = 1.0) -> list[dict]:
    """From board rows: big line moves, outlier books, and injury designations
    for players with posted props."""
    out: list[dict] = []
    teams = {r["team"] for r in rows if r.get("team")}
    inj: dict[str, dict] = {}
    for t in teams:
        try:
            for r in team_injuries(t, season, week).to_dicts():
                if r.get("gsis_id") and r.get("report_status"):
                    inj[r["gsis_id"]] = r
        except Exception:
            continue
    seen_inj = set()
    for r in rows:
        m = BY_KEY.get(r["market"])
        thr = (m.threshold if m else 1.0) * scale
        for b in r["books"]:
            mv = b.get("moved")
            if mv is not None and thr > 0 and abs(mv) >= thr:
                out.append({"kind": "move", "severity": 2 if abs(mv) >= 2 * thr else 1, "player_id": r["player_id"], "player": r["player_name"],
                            "team": r["team"], "market": r["market"], "market_label": r["market_label"], "game_id": r["game_id"],
                            "title": f"{r['player_name']} {r['market_label']} moved {'+' if mv > 0 else ''}{mv} at {b['title']}",
                            "detail": f"opened {b['open_line']}, now {b['line']}"})
        if r.get("outliers"):
            for bk in r["outliers"]:
                b = next((x for x in r["books"] if x["book"] == bk), None)
                if b:
                    out.append({"kind": "outlier", "severity": 1, "player_id": r["player_id"], "player": r["player_name"], "team": r["team"],
                                "market": r["market"], "market_label": r["market_label"], "game_id": r["game_id"],
                                "title": f"{b['title']} is {'+' if (b['delta'] or 0) > 0 else ''}{b['delta']} off consensus on {r['player_name']} {r['market_label']}",
                                "detail": f"{b['line']} vs consensus {r['consensus']} across {r['n_books']} books"})
        i = inj.get(r["player_id"] or "")
        if i and r["player_id"] not in seen_inj:
            seen_inj.add(r["player_id"])
            status = i["report_status"]
            out.append({"kind": "injury", "severity": 2 if status in ("Out", "Doubtful") else 1, "player_id": r["player_id"], "player": r["player_name"],
                        "team": r["team"], "market": None, "market_label": None, "game_id": r["game_id"],
                        "title": f"{r['player_name']} is {status}", "detail": f"{i.get('report_primary_injury') or ''} · {i.get('practice_status') or ''}".strip(" ·")})
    out.sort(key=lambda a: (-a["severity"], a["kind"], a["player"] or ""))
    return out
