"""The searchable player index.

Built from ``player_stats_week`` (who actually recorded a stat line) and
decorated from the ``players`` master table (headshots, external ids, draft
info). Cached in memory for the life of the process; it takes about a second
to build.
"""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

import polars as pl

from nfl.data import RAW_DIR, scan

from .gamelog import players_master

_SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b\.?")


def normalize_name(name: str | None) -> str:
    """'Ja'Marr Chase Jr.' -> 'jamarr chase'. Used for search and for matching
    sportsbook player descriptions, which carry no ids."""
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = s.lower().replace(".", " ").replace("'", "").replace("-", " ")
    s = _SUFFIX.sub(" ", s)
    return re.sub(r"[^a-z0-9 ]", "", re.sub(r"\s+", " ", s)).strip()


@lru_cache(maxsize=1)
def player_index() -> pl.DataFrame:
    stats = (
        scan("player_stats_week")
        .select("player_id", "player_display_name", "position", "team", "season", "week",
                "headshot_url", "fantasy_points_ppr")
        .sort(["season", "week"])
        .group_by("player_id", maintain_order=True)
        .agg(
            pl.col("player_display_name").last().alias("name"),
            pl.col("position").last().alias("position"),
            pl.col("team").last().alias("last_team"),
            pl.col("season").min().alias("first_season"),
            pl.col("season").max().alias("last_season"),
            pl.len().alias("games"),
            pl.col("headshot_url").drop_nulls().last().alias("headshot_stats"),
            pl.col("fantasy_points_ppr").filter(pl.col("season") == pl.col("season").max()).sum()
            .alias("last_season_ppr"),
        )
        .collect()
    )
    master = players_master().select(
        pl.col("gsis_id").alias("player_id"),
        pl.col("display_name").alias("master_name"),
        pl.col("headshot").alias("headshot_master"),
        pl.col("latest_team"), pl.col("status"), pl.col("espn_id"), pl.col("pfr_id"),
        pl.col("jersey_number"), pl.col("birth_date").cast(pl.String).alias("birth_date"),
        pl.col("height"), pl.col("weight"), pl.col("college_name"),
        pl.col("draft_year"), pl.col("draft_round"), pl.col("draft_pick"), pl.col("draft_team"),
        pl.col("rookie_season"), pl.col("years_of_experience"),
        pl.col("position").alias("master_position"),
    )
    df = stats.join(master, on="player_id", how="left").with_columns(
        name=pl.coalesce(pl.col("master_name"), pl.col("name")),
        headshot=pl.coalesce(pl.col("headshot_master"), pl.col("headshot_stats")),
        # players.latest_team tracks offseason moves that the stat table cannot.
        team=pl.coalesce(pl.col("latest_team"), pl.col("last_team")),
        position=pl.coalesce(pl.col("position"), pl.col("master_position")),
    ).drop("master_name", "headshot_master", "headshot_stats", "master_position")
    names = [normalize_name(n) for n in df["name"].to_list()]
    return df.with_columns(pl.Series("name_norm", names)).sort(
        ["last_season", "last_season_ppr"], descending=[True, True]
    )


#: Roster statuses that mean "on a team right now" in the players master.
ACTIVE_STATUS = {"ACT", "RES", "DEV", "PUP", "RSR", "RSN", "NWT", "SUS", "INA", "EXE"}


def is_current() -> pl.Expr:
    """A player you could bet on this season: recent stat line and still on a roster."""
    from ..config import CURRENT_SEASON
    return (pl.col("last_season") >= CURRENT_SEASON - 1) & pl.col("status").is_in(list(ACTIVE_STATUS)) & pl.col("team").is_not_null()


def search(q: str, limit: int = 25, position: str | None = None, team: str | None = None, active: bool = True) -> pl.DataFrame:
    idx = player_index()
    if active:
        idx = idx.filter(is_current())
    qn = normalize_name(q)
    if position:
        idx = idx.filter(pl.col("position") == position.upper())
    if team:
        idx = idx.filter(pl.col("team") == team.upper())
    if not qn:
        return idx.head(limit)
    parts = qn.split()
    cond = pl.lit(True)
    for p in parts:
        cond = cond & pl.col("name_norm").str.contains(p, literal=True)
    hits = idx.filter(cond)
    starts = hits.filter(pl.col("name_norm").str.starts_with(qn))
    rest = hits.filter(~pl.col("name_norm").str.starts_with(qn))
    return pl.concat([starts, rest]).head(limit)


def profile(player_id: str) -> dict | None:
    row = player_index().filter(pl.col("player_id") == player_id)
    if not row.is_empty():
        return row.row(0, named=True)
    return roster_profile(player_id)


def roster_profile(player_id: str) -> dict | None:
    """A profile for someone on a roster who has never logged a stat line.

    The index is built from the stat table, so a rookie is not in it until
    his first box score lands, and the sportsbooks post his props weeks
    before that. Clicking one of those rows used to open a research page
    that said "unknown player". The roster table knows him, so this builds
    the same shape the index would, with zero games: every page that reads
    a profile then renders, with an empty game log rather than an error.
    Search still goes through the index, so he is reachable from a line,
    not by name.
    """
    m = players_master().filter(pl.col("gsis_id") == player_id)
    if m.is_empty():
        return None
    r = m.row(0, named=True)
    season = r.get("rookie_season") or r.get("last_season")
    name = r.get("display_name") or ""
    return {
        "player_id": player_id, "name": name, "position": r.get("position"),
        "last_team": r.get("latest_team"), "team": r.get("latest_team"),
        "first_season": season, "last_season": season, "games": 0, "last_season_ppr": 0.0,
        "headshot": r.get("headshot"), "latest_team": r.get("latest_team"), "status": r.get("status"),
        "espn_id": r.get("espn_id"), "pfr_id": r.get("pfr_id"), "jersey_number": r.get("jersey_number"),
        "birth_date": str(r["birth_date"]) if r.get("birth_date") is not None else None,
        "height": r.get("height"), "weight": r.get("weight"), "college_name": r.get("college_name"),
        "draft_year": r.get("draft_year"), "draft_round": r.get("draft_round"), "draft_pick": r.get("draft_pick"),
        "draft_team": r.get("draft_team"), "rookie_season": r.get("rookie_season"),
        "years_of_experience": r.get("years_of_experience"), "name_norm": normalize_name(name),
    }


def team_players(team: str, season: int) -> pl.DataFrame:
    """Everyone who logged a stat line for ``team`` in ``season``, by PPR points."""
    return (
        scan("player_stats_week")
        .filter((pl.col("season") == season) & (pl.col("team") == team.upper()))
        .group_by("player_id")
        .agg(
            pl.col("player_display_name").last().alias("name"),
            pl.col("position").last().alias("position"),
            pl.len().alias("games"),
            pl.col("fantasy_points_ppr").sum().alias("ppr"),
            pl.col("headshot_url").drop_nulls().last().alias("headshot"),
        )
        .sort("ppr", descending=True)
        .collect()
    )


@lru_cache(maxsize=1)
def teams() -> list[dict]:
    t = pl.read_parquet(RAW_DIR / "teams.parquet")
    return t.select("team_abbr", "team_name", "team_nick", "team_conf", "team_division",
                    "team_color", "team_color2", "team_logo_espn").to_dicts()


def match_name(name: str, teams_hint: tuple[str, ...] = (), min_season: int = 2023) -> str | None:
    """Sportsbook player description -> gsis id. Prefers a player on one of the
    teams in the event; otherwise the most recent player by that name."""
    idx = player_index()
    n = normalize_name(name)
    cands = idx.filter((pl.col("name_norm") == n) & (pl.col("last_season") >= min_season))
    if cands.is_empty():
        # Try loose: books sometimes drop suffixes or use initials.
        last = n.split()[-1] if n else ""
        first = n.split()[0][:1] if n else ""
        cands = idx.filter(
            (pl.col("last_season") >= min_season)
            & pl.col("name_norm").str.ends_with(" " + last)
            & pl.col("name_norm").str.starts_with(first)
        )
        if cands.height != 1:
            return None
    if teams_hint:
        on_team = cands.filter(pl.col("team").is_in(list(teams_hint)))
        if not on_team.is_empty():
            return on_team["player_id"][0]
    return cands["player_id"][0]
