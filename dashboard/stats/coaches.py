"""Head-coach tendency profiles.

nflverse's schedule carries ``home_coach`` / ``away_coach`` for every game
since 1999, so a coach's history is just the team-game tendency table with a
coach column attached. Aggregating those games per coach-season gives a real,
countable answer to "does this coach feed his running backs": a per-season
RB target share, its league rank, and how often the rank landed in the top
third across the career.

Mid-season firings are handled at the game level, because the coach name is
on each game rather than on each season.

Coordinators are the other half of the answer, and they come from a different
place. nflverse has no coordinator column at all, so OCs and DCs are read from
Wikipedia's team-season staff sections by
:mod:`data_handling.fetch_coordinators`. Two consequences run through
everything below:

*   **Coordinator tenure is a season, not a game.** The source is the final
    staff of each season, so a coordinator hired in October owns the whole year
    and the man he replaced owns none of it. Head-coach rows do not have this
    problem. Where the distinction matters it is reported as ``attribution``.
*   **A coordinator is judged on his own side of the ball.** An OC's
    fingerprint is built from offensive metrics only. Crediting Kansas City's
    defensive rank to its offensive coordinator would be a category error, and
    an average over both sides quietly is one.
"""

from __future__ import annotations

from functools import lru_cache
from statistics import mean

import polars as pl

from nfl.data import is_cached, scan

from ..config import CURRENT_SEASON
from .team import METRICS, rates, team_games, with_ranks


#: Which sides of the ball each role is accountable for, and how its tenure is
#: dated. The head coach owns both sides and is known per game; a coordinator
#: owns one side and is only known per season.
ROLES: tuple[str, ...] = ("HC", "OC", "DC")
ROLE_SIDES: dict[str, tuple[str, ...]] = {"HC": ("off", "def"), "OC": ("off",), "DC": ("def",)}
ROLE_LABEL: dict[str, str] = {"HC": "Head coach", "OC": "Offensive coordinator", "DC": "Defensive coordinator"}
ROLE_ATTRIBUTION: dict[str, str] = {"HC": "game", "OC": "season", "DC": "season"}


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


# ---------------------------------------------------------------------------
# Coordinators
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def coordinators() -> pl.DataFrame:
    """Named OCs and DCs per team-season, or an empty frame if the cache has
    not been fetched yet.

    Missing is not an error: the rest of the dashboard predates this table and
    has to keep working without it. :func:`have_coordinators` is the check the
    API surfaces so the page can say *why* the OC and DC tabs are empty rather
    than showing a coachless league.

    Rows whose ``coach`` is null are verified vacancies -- a season the team
    listed no coordinator because the head coach did the job -- and they are
    dropped here, since a vacancy has no profile. They still matter upstream:
    it is how :func:`data_handling.fetch_coordinators.build` distinguishes
    "nobody held the title" from "we could not read the page".
    """
    if not is_cached("coordinators"):
        return pl.DataFrame(schema={"season": pl.Int32, "team": pl.Utf8, "role": pl.Utf8,
                                    "coach": pl.Utf8, "title": pl.Utf8, "slot": pl.Int32})
    return (
        scan("coordinators").collect()
        .filter(pl.col("coach").is_not_null())
        .select("season", "team", "role", "coach", "title", "slot")
    )


def have_coordinators() -> bool:
    return not coordinators().is_empty()


@lru_cache(maxsize=1)
def team_season_records() -> pl.DataFrame:
    """Regular-season W-L and points per team-season, for roles that are dated
    by season rather than by game."""
    return (
        game_coaches().filter(pl.col("game_type") == "REG")
        .group_by(["season", "team"]).agg(
            pl.col("win").sum(), pl.col("loss").sum(), pl.col("tie").sum(),
            pl.col("pts").mean().alias("ppg"), pl.col("opp_pts").mean().alias("opp_ppg"),
        )
    )


@lru_cache(maxsize=1)
def coordinator_seasons() -> pl.DataFrame:
    """Coordinator x season x team, with the team's full-season tendencies.

    Unlike :func:`coach_seasons`, the numbers here are the *team's* season, not
    a subset of its games: the source dates a coordinator to a season and no
    finer. Co-coordinators both appear, and both carry the same season.
    """
    co = coordinators()
    if co.is_empty():
        return co
    return (
        co.join(season_ranks(), on=["season", "team"], how="inner")
        .join(team_season_records(), on=["season", "team"], how="left")
        .sort(["coach", "season"])
    )


def role_seasons(role: str) -> pl.DataFrame:
    """The season table for one role, in a single shape the profile code can
    consume regardless of how tenure was dated."""
    if role not in ROLE_SIDES:
        raise ValueError(f"unknown role {role!r}; expected one of {ROLES}")
    if role == "HC":
        return coach_seasons()
    return coordinator_seasons().filter(pl.col("role") == role) if have_coordinators() else coordinators()


def current_staff(season: int = CURRENT_SEASON) -> dict[str, dict[str, str]]:
    """``{team: {"HC": name, "OC": name, "DC": name}}`` for one season, with
    absent roles simply left out."""
    out: dict[str, dict[str, str]] = {t: {"HC": c} for t, c in current_coaches(season).items()}
    co = coordinators()
    if not co.is_empty():
        for r in co.filter((pl.col("season") == season) & (pl.col("slot") == 0)).to_dicts():
            out.setdefault(r["team"], {})[r["role"]] = r["coach"]
    return out


def _current_teams(role: str, season: int = CURRENT_SEASON) -> dict[str, str]:
    """Name -> team for whoever holds ``role`` this season."""
    return {v[role]: t for t, v in current_staff(season).items() if role in v}


# ---------------------------------------------------------------------------
# Profiles, shared across roles
# ---------------------------------------------------------------------------


def staff_list(role: str = "HC") -> list[dict]:
    """One row per person who has held ``role``, most recent first.

    Someone hired for a season the tendency table has not reached yet has no
    numbers, but he does have the job: leaving him out makes the "this season"
    filter quietly wrong every spring, and worst for coordinators, who turn
    over hardest. Those rows carry ``has_history: False`` and zeroed counters
    so the page can say what they are instead of fetching an empty profile.
    """
    cs = role_seasons(role)
    cur = _current_teams(role)
    if cs.is_empty():
        return [_no_history_row(role, person, team) for person, team in sorted(cur.items())]
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
        r["role"] = role
        r["current_team"] = cur.get(r["coach"])
        r["has_history"] = True
    known = {r["coach"] for r in rows}
    newcomers = [_no_history_row(role, person, team) for person, team in sorted(cur.items()) if person not in known]
    return newcomers + rows


def _no_history_row(role: str, person: str, team: str) -> dict:
    return {"coach": person, "role": role, "current_team": team, "teams": [team],
            "first_season": CURRENT_SEASON, "last_season": CURRENT_SEASON,
            "seasons": 0, "games": 0, "wins": 0, "losses": 0, "has_history": False}


def coach_list() -> list[dict]:
    return staff_list("HC")


def roles_held(name: str) -> list[dict]:
    """Every role this person has a record in, so a profile can link to his
    other lives -- Josh McDaniels has been a head coach twice and an offensive
    coordinator for a decade, and they are different questions."""
    out = []
    for role in ROLES:
        rs = role_seasons(role)
        if rs.is_empty():
            continue
        mine = rs.filter(pl.col("coach") == name)
        if mine.is_empty():
            continue
        out.append({"role": role, "label": ROLE_LABEL[role], "seasons": mine.height,
                    "first_season": int(mine["season"].min()), "last_season": int(mine["season"].max())})
    return out


def staff_profile(name: str, role: str = "HC") -> dict | None:
    """Tendency fingerprint for one person in one role.

    The fingerprint is the mean league percentile of each metric across his
    seasons (1.0 = top of the league every year), restricted to the sides of
    the ball the role is answerable for.
    """
    cs = role_seasons(role).filter(pl.col("coach") == name)
    if cs.is_empty():
        return None
    seasons = cs.to_dicts()
    sides = ROLE_SIDES[role]
    if role == "HC":
        career = rates(coach_games().filter((pl.col("coach") == name) & (pl.col("season_type") == "REG")), ["coach"]).to_dicts()[0]
    else:
        # A coordinator's career number is the weighted total of the team-seasons
        # he ran, so a 17-game year outweighs a half one he inherited.
        pairs = cs.select("season", "team").unique()
        tg = team_games().filter(pl.col("season_type") == "REG").join(pairs, on=["season", "team"], how="semi")
        career = rates(tg.with_columns(pl.lit(name).alias("coach")), ["coach"]).to_dicts()[0]
    fingerprint = []
    for m in METRICS:
        if m.side not in sides:
            continue
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
    return {
        "coach": name, "role": role, "role_label": ROLE_LABEL[role], "sides": list(sides),
        "attribution": ROLE_ATTRIBUTION[role], "current_team": _current_teams(role).get(name),
        "seasons": seasons, "career": career, "fingerprint": fingerprint, "also": roles_held(name),
    }


def coach_profile(name: str) -> dict | None:
    return staff_profile(name, "HC")


def team_history(team: str) -> list[dict]:
    """Coach per season for a team, for the team page header."""
    gc = game_coaches().filter(pl.col("team") == team)
    return (
        gc.group_by(["season", "coach"]).agg(pl.len().alias("games"), pl.col("win").sum().alias("wins"), pl.col("loss").sum().alias("losses"))
        .sort(["season", "games"], descending=[True, True]).to_dicts()
    )


def team_staff_history(team: str) -> list[dict]:
    """Season -> the team's coordinators, to sit alongside :func:`team_history`
    on the team page. Co-coordinators are joined with ``&``."""
    co = coordinators()
    if co.is_empty():
        return []
    mine = co.filter(pl.col("team") == team)
    if mine.is_empty():
        return []
    wide = (
        mine.sort("slot").group_by(["season", "role"]).agg(pl.col("coach").str.join(" & ").alias("name"))
        .pivot(on="role", index="season", values="name")
    )
    for role in ("OC", "DC"):
        if role not in wide.columns:
            wide = wide.with_columns(pl.lit(None, dtype=pl.Utf8).alias(role))
    return wide.select("season", "OC", "DC").sort("season", descending=True).to_dicts()
