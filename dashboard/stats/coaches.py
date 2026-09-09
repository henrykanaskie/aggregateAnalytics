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

from nfl.data import dataset_path, scan

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


def season_used(team: str, season: int) -> int:
    """Which season's numbers to read for ``team``: this one once it has four
    games in it, else last.

    A three-game sample is not a tendency, and in September ``season`` has no
    games at all, so every ranked number on the research and matchup pages is
    last year's until the new one has enough behind it. Lives here rather than
    in the API because the precomputed angle table has to key on exactly the
    same answer the request would have reached.
    """
    ranks = season_ranks()
    mine = ranks.filter(pl.col("team") == team)
    have = mine["season"].max() if not mine.is_empty() else None
    cur = mine.filter(pl.col("season") == season)
    if have is not None and have >= season and not cur.is_empty() and cur["games"][0] >= 4:
        return season
    return int(min(have or season - 1, season - 1))


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


#: The shape :func:`coordinators` promises when the scrape has not run.
_NO_COORDINATORS = pl.DataFrame(schema={"season": pl.Int32, "team": pl.Utf8, "role": pl.Utf8,
                                        "coach": pl.Utf8, "title": pl.Utf8, "slot": pl.Int32})


@lru_cache(maxsize=1)
def _read_coordinators(stamp: float) -> pl.DataFrame:
    """Load the table, memoised on the file's mtime rather than on nothing.

    ``stamp`` is unused inside, and that is the entire point: it is the cache
    key, so a refreshed file is a different call and the stale frame is
    dropped.
    """
    return (
        scan("coordinators").collect()
        .filter(pl.col("coach").is_not_null())
        # The same rule as fetch_coordinators.clean_name, applied again here so
        # a table scraped before that rule existed is healed on load. It has to
        # be: the weekly job only refetches seasons the archive is missing, so
        # a published archive that is merely *wrong* would never be rewritten,
        # and "Matt Canada; fired after Week 11" would stay a separate person
        # from Matt Canada for good.
        .with_columns(pl.col("coach").str.replace(r"\s*[;(].*$", "").str.strip_chars(" *·,;.†‡–—-"))
        .filter(pl.col("coach").str.len_chars() > 0)
        .select("season", "team", "role", "coach", "title", "slot")
        .unique(subset=["season", "team", "role", "coach"], keep="first")
        .sort(["season", "team", "role", "slot"])
    )


def coordinators() -> pl.DataFrame:
    """Named OCs and DCs per team-season, or an empty frame if the scrape has
    not run.

    Missing is not an error: the rest of the dashboard predates this table and
    has to keep working without it. :func:`have_coordinators` is the check the
    API surfaces so the page can say *why* the OC and DC tabs are empty rather
    than showing a coachless league.

    The absence is deliberately *not* memoised, and the file is keyed on its
    mtime. Caching "there is no table" pins it for the life of the process: a
    server that boots while the scrape is still running, or before it has ever
    run, would go on telling every visitor to run a command they had already
    run, until someone thought to restart it. Both orders happen -- the weekly
    refresh writes this file long after the API is up.

    Rows whose ``coach`` is null are verified vacancies -- a season the team
    listed no coordinator because the head coach did the job -- and they are
    dropped here, since a vacancy has no profile. They still matter upstream:
    it is how :func:`data_handling.fetch_coordinators.build` distinguishes
    "nobody held the title" from "we could not read the page".
    """
    path = dataset_path("coordinators")
    if not path.exists():
        return _NO_COORDINATORS
    return _read_coordinators(path.stat().st_mtime)


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
def _build_coordinator_seasons(stamp: float) -> pl.DataFrame:
    co = coordinators()
    if co.is_empty():
        return co
    return (
        co.join(season_ranks(), on=["season", "team"], how="inner")
        .join(team_season_records(), on=["season", "team"], how="left")
        .sort(["coach", "season"])
    )


def coordinator_seasons() -> pl.DataFrame:
    """Coordinator x season x team, with the team's full-season tendencies.

    Unlike :func:`coach_seasons`, the numbers here are the *team's* season, not
    a subset of its games: the source dates a coordinator to a season and no
    finer. Co-coordinators both appear, and both carry the same season.

    Memoised on the same mtime as :func:`coordinators`, so a table that arrives
    after boot is picked up here too rather than leaving the derived frame
    behind the one it was built from.
    """
    path = dataset_path("coordinators")
    return _build_coordinator_seasons(path.stat().st_mtime if path.exists() else 0.0)


def role_seasons(role: str) -> pl.DataFrame:
    """The season table for one role, in a single shape the profile code can
    consume regardless of how tenure was dated."""
    if role not in ROLE_SIDES:
        raise ValueError(f"unknown role {role!r}; expected one of {ROLES}")
    if role == "HC":
        return coach_seasons()
    return coordinator_seasons().filter(pl.col("role") == role) if have_coordinators() else coordinators()


def accountable_for(held: str, side: str) -> bool:
    """Did a season spent in job ``held`` answer for ``side`` of the ball?

    This is the whole rule, and it is per metric rather than per page. A head
    coach owns both sides of his team. A coordinator owns one. So an offensive
    coordinator's year belongs in a head coach's offensive numbers and nowhere
    near his defensive ones, and the same season can count toward half a
    profile and not the other half.
    """
    return side in ROLE_SIDES.get(held, ())


def accountable_all(role: str) -> pl.DataFrame:
    """Every season relevant to ``role``, for everyone who holds it, in one
    pass, tagged in ``held`` with the job that season was spent in.

    A man's record is not just the seasons under his current title. A head
    coach who used to coordinate brings those years; a coordinator who used to
    be a head coach brings his. Which of them counts toward a given number is
    :func:`accountable_for`'s business, not this function's -- here we gather
    everything that could bear on the role and let the metric decide.

    The list and the profile have to agree: a sidebar that says two years next
    to a page that shows six is worse than either number alone.

    Where a season appears under two jobs -- a coordinator promoted to interim
    head coach in November -- the role being viewed wins, so his head-coach
    page counts the games he actually ran and his coordinator page counts the
    whole season he coordinated.
    """
    if role not in ROLE_SIDES:
        raise ValueError(f"unknown role {role!r}; expected one of {ROLES}")
    hc = coach_seasons().with_columns(pl.lit("HC").alias("held"))
    co = coordinator_seasons() if have_coordinators() else coordinators()
    if not co.is_empty():
        co = co.with_columns(pl.col("role").alias("held"))

    own, others = (hc, co) if role == "HC" else (
        (co.filter(pl.col("held") == role) if not co.is_empty() else co), hc)
    if own.is_empty():
        return own
    names = set(own["coach"].to_list()) | set(_current_teams(role))
    if others.is_empty():
        return own
    extra = (others.filter(pl.col("coach").is_in(list(names)))
             .join(own.select("coach", "season", "team"), on=["coach", "season", "team"], how="anti"))
    return own if extra.is_empty() else pl.concat([own, extra], how="diagonal")


def accountable_seasons(name: str, role: str) -> pl.DataFrame:
    """Every season in which this person answered for ``role``'s side of the
    ball, tagged in ``held`` with the job he held that year.

    A coordinator's record is not only his coordinator seasons. A head coach
    owns both sides of his team, so the offenses an ex-head-coach ran are part
    of what he is as an offensive coordinator, and a page that shows only the
    new title calls a twenty-year man a first-year hire. 118 of the
    coordinators in the table have head-coaching history behind them.

    Head-coach profiles are deliberately *not* the mirror image. A season
    spent running someone else's offense is evidence about that offense, but
    it is not a season of his team, which is what the head-coach page is for.

    A season can appear under both jobs -- a coordinator promoted to interim
    head coach in November is in the head-coach table for the games he took
    over and in the coordinator table for the whole year. That is one season
    of evidence, not two, so the coordinator row wins: it covers the full
    season rather than the tail of it.

    Holding the role is still what gets you a page. Head-coaching seasons are
    supporting evidence for a coordinator, not a way for every head coach in
    the league to turn up under OC.
    """
    everyone = accountable_all(role)
    if everyone.is_empty():
        return everyone
    return everyone.filter(pl.col("coach") == name).sort("season")


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

    Counted over :func:`accountable_all`, so the years and record here are the
    ones his profile will show -- head-coaching seasons included for a
    coordinator who used to be one.

    Someone hired for a season the tendency table has not reached yet has no
    numbers, but he does have the job: leaving him out makes the "this season"
    filter quietly wrong every spring, and worst for coordinators, who turn
    over hardest. Those rows carry ``has_history: False`` and zeroed counters
    so the page can say what they are instead of fetching an empty profile.
    A first-time coordinator who used to be a head coach is *not* one of them:
    he has years of evidence, and :func:`accountable_all` already carries it.
    """
    cs = accountable_all(role)
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


def _career_rates(name: str, seasons: pl.DataFrame) -> dict:
    """Weighted career totals across the seasons on a profile, each counted the
    way its job was dated.

    A head-coaching season is the games he actually coached, so a man fired in
    October carries ten games and not seventeen. A coordinator season is the
    team's whole year, because that is the only resolution the staff source
    has. Summing numerators and denominators rather than averaging the seasons
    means a full year outweighs a half one either way.
    """
    reg = team_games().filter(pl.col("season_type") == "REG")
    parts: list[pl.DataFrame] = []
    co = seasons.filter(pl.col("held") != "HC").select("season", "team").unique()
    if not co.is_empty():
        parts.append(reg.join(co, on=["season", "team"], how="semi"))
    hc = seasons.filter(pl.col("held") == "HC").select("season", "team").unique()
    if not hc.is_empty():
        cg = coach_games().filter((pl.col("coach") == name) & (pl.col("season_type") == "REG"))
        parts.append(cg.join(hc, on=["season", "team"], how="semi").select(reg.columns))
    if not parts:
        return {}
    combined = parts[0] if len(parts) == 1 else pl.concat(parts, how="vertical")
    return rates(combined.with_columns(pl.lit(name).alias("coach")), ["coach"]).to_dicts()[0]


def staff_profile(name: str, role: str = "HC") -> dict | None:
    """Tendency fingerprint for one person in one role.

    The fingerprint is the mean league percentile of each metric across his
    seasons (1.0 = top of the league every year), restricted to the sides of
    the ball the role is answerable for. "His seasons" is
    :func:`accountable_seasons`, so a coordinator who used to be a head coach
    brings those years with him; ``held`` on each season says which job it was,
    and ``season_roles`` counts them.
    """
    cs = accountable_seasons(name, role)
    if cs.is_empty():
        return None
    seasons = cs.to_dicts()
    sides = ROLE_SIDES[role]
    # One career per side, over the seasons that answer for it: a head coach's
    # offensive totals take in the years he coordinated an offense, and his
    # defensive totals do not.
    career_by_side = {sd: _career_rates(name, cs.filter(
        pl.col("held").map_elements(lambda h, s=sd: accountable_for(h, s), return_dtype=pl.Boolean)))
        for sd in sides}
    career = {k: v for sd in sides for k, v in career_by_side[sd].items()}
    fingerprint = []
    for m in METRICS:
        if m.side not in sides:
            continue
        pcts = [1 - (s[f"{m.key}_rank"] - 1) / (s["n_teams"] - 1) for s in seasons
                if accountable_for(s["held"], m.side)
                and s.get(f"{m.key}_rank") is not None and s.get("n_teams") and s["n_teams"] > 1 and s["season"] >= m.since]
        if not pcts:
            continue
        top = sum(1 for p in pcts if p >= 2 / 3)
        bottom = sum(1 for p in pcts if p <= 1 / 3)
        fingerprint.append({"key": m.key, "label": m.label, "side": m.side, "fmt": m.fmt, "good": m.good,
                            "mean_pct": round(mean(pcts), 3), "seasons": len(pcts), "top_third": top, "bottom_third": bottom,
                            "career": career_by_side[m.side].get(m.key)})
    fingerprint.sort(key=lambda f: abs(f["mean_pct"] - 0.5), reverse=True)
    return {
        "coach": name, "role": role, "role_label": ROLE_LABEL[role], "sides": list(sides),
        "attribution": ROLE_ATTRIBUTION[role], "current_team": _current_teams(role).get(name),
        "seasons": seasons, "career": career, "fingerprint": fingerprint, "also": roles_held(name),
        "season_roles": {r: sum(1 for s in seasons if s["held"] == r) for r in ROLES
                         if any(s["held"] == r for s in seasons)},
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
