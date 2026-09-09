"""Head-coach tendency profiles.

nflverse's schedule carries ``home_coach`` / ``away_coach`` for every game
since 1999, so a coach's history is just the team-game tendency table with a
coach column attached. Aggregating those games per coach-season gives a real,
countable answer to "does this coach feed his running backs": a per-season
RB target share, its league rank, and how often the rank landed in the top
third across the career.

Mid-season firings are handled at the game level, because the coach name is
on each game rather than on each season.
"""

from __future__ import annotations

from functools import lru_cache
from statistics import mean

import polars as pl

from nfl.data import scan

from ..config import CURRENT_SEASON
from .team import METRICS, rates, team_games, with_ranks


@lru_cache(maxsize=1)
def game_coaches() -> pl.DataFrame:
    """One row per (game_id, team) with the head coach and the result."""
    s = scan("schedules").select("game_id", "season", "week", "game_type", "home_team", "away_team",
                                 "home_coach", "away_coach", "home_score", "away_score").collect()
    home = s.select("game_id", "season", "week", "game_type", pl.col("home_team").alias("team"), pl.col("away_team").alias("opponent"),
                    pl.col("home_coach").alias("coach"), pl.col("home_score").alias("pts"), pl.col("away_score").alias("opp_pts"))
    away = s.select("game_id", "season", "week", "game_type", pl.col("away_team").alias("team"), pl.col("home_team").alias("opponent"),
                    pl.col("away_coach").alias("coach"), pl.col("away_score").alias("pts"), pl.col("home_score").alias("opp_pts"))
    return pl.concat([home, away]).filter(pl.col("coach").is_not_null()).with_columns(
        win=(pl.col("pts") > pl.col("opp_pts")).cast(pl.Int32),
        loss=(pl.col("pts") < pl.col("opp_pts")).cast(pl.Int32),
        tie=((pl.col("pts") == pl.col("opp_pts")) & pl.col("pts").is_not_null()).cast(pl.Int32),
    )


@lru_cache(maxsize=1)
def coach_games() -> pl.DataFrame:
    tg = team_games()
    gc = game_coaches().select("game_id", "team", "coach", "pts", "opp_pts", "win", "loss", "tie")
    return tg.join(gc, on=["game_id", "team"], how="left")


@lru_cache(maxsize=1)
def season_ranks() -> pl.DataFrame:
    """Team-season rates with league ranks (regular season only, so ranks
    compare like with like)."""
    tg = team_games().filter(pl.col("season_type") == "REG")
    return with_ranks(rates(tg, ["season", "team"]))


@lru_cache(maxsize=1)
def coach_seasons() -> pl.DataFrame:
    """Coach x season x team: tendencies over the games that coach coached,
    plus the league rank of the *team's* full-season number."""
    cg = coach_games().filter(pl.col("season_type") == "REG").filter(pl.col("coach").is_not_null())
    r = rates(cg, ["coach", "season", "team"])
    wins = cg.group_by(["coach", "season", "team"]).agg(pl.col("win").sum(), pl.col("loss").sum(), pl.col("tie").sum(),
                                                         pl.col("pts").mean().alias("ppg"), pl.col("opp_pts").mean().alias("opp_ppg"))
    r = r.join(wins, on=["coach", "season", "team"], how="left")
    rank_cols = [f"{m.key}_rank" for m in METRICS if f"{m.key}_rank" in season_ranks().columns]
    return r.join(season_ranks().select(["season", "team", "n_teams"] + rank_cols), on=["season", "team"], how="left").sort(["coach", "season"])


def current_coaches(season: int = CURRENT_SEASON) -> dict[str, str]:
    s = scan("schedules").filter(pl.col("season") == season).select("home_team", "home_coach", "away_team", "away_coach").collect()
    out: dict[str, str] = {}
    for r in s.to_dicts():
        if r["home_coach"]:
            out.setdefault(r["home_team"], r["home_coach"])
        if r["away_coach"]:
            out.setdefault(r["away_team"], r["away_coach"])
    return out


def coach_list() -> list[dict]:
    cs = coach_seasons()
    cur = {v: k for k, v in current_coaches().items()}
    summary = (
        cs.group_by("coach").agg(
            pl.col("season").min().alias("first_season"), pl.col("season").max().alias("last_season"),
            pl.col("season").n_unique().alias("seasons"), pl.col("games").sum().alias("games"),
            pl.col("win").sum().alias("wins"), pl.col("loss").sum().alias("losses"),
            pl.col("team").unique().sort().alias("teams"),
        )
        .sort(["last_season", "games"], descending=[True, True])
    )
    rows = summary.to_dicts()
    for r in rows:
        r["current_team"] = cur.get(r["coach"])
    return rows


def coach_profile(name: str) -> dict | None:
    cs = coach_seasons().filter(pl.col("coach") == name)
    if cs.is_empty():
        return None
    seasons = cs.to_dicts()
    career = rates(coach_games().filter((pl.col("coach") == name) & (pl.col("season_type") == "REG")), ["coach"]).to_dicts()[0]
    # Tendency fingerprint: mean percentile per metric across seasons (1.0 = most of the league, every year).
    fingerprint = []
    for m in METRICS:
        pcts = [1 - (s[f"{m.key}_rank"] - 1) / (s["n_teams"] - 1) for s in seasons
                if s.get(f"{m.key}_rank") is not None and s.get("n_teams") and s["n_teams"] > 1 and s["season"] >= m.since]
        if not pcts:
            continue
        top = sum(1 for p in pcts if p >= 2 / 3)
        bottom = sum(1 for p in pcts if p <= 1 / 3)
        fingerprint.append({"key": m.key, "label": m.label, "side": m.side, "fmt": m.fmt, "good": m.good,
                            "mean_pct": round(mean(pcts), 3), "seasons": len(pcts), "top_third": top, "bottom_third": bottom,
                            "career": career.get(m.key)})
    fingerprint.sort(key=lambda f: abs(f["mean_pct"] - 0.5), reverse=True)
    cur = {v: k for k, v in current_coaches().items()}
    return {
        "coach": name, "current_team": cur.get(name), "seasons": seasons, "career": career, "fingerprint": fingerprint,
    }


def team_history(team: str) -> list[dict]:
    """Coach per season for a team, for the team page header."""
    gc = game_coaches().filter(pl.col("team") == team)
    return (
        gc.group_by(["season", "coach"]).agg(pl.len().alias("games"), pl.col("win").sum().alias("wins"), pl.col("loss").sum().alias("losses"))
        .sort(["season", "games"], descending=[True, True]).to_dicts()
    )
