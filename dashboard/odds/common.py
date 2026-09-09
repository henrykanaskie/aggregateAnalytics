"""Shared helpers for the providers: team-name resolution, schedule matching
and odds arithmetic."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from functools import lru_cache

import polars as pl

from nfl.data import RAW_DIR, scan

from ..config import CURRENT_SEASON

#: Provider abbreviations that differ from nflverse.
ABBR_ALIASES: dict[str, str] = {"WSH": "WAS", "LAR": "LA", "JAC": "JAX", "OAK": "LV", "SD": "LAC", "STL": "LA"}


@lru_cache(maxsize=1)
def team_name_map() -> dict[str, str]:
    """Full team name (lowercase) -> nflverse abbreviation."""
    t = pl.read_parquet(RAW_DIR / "teams.parquet")
    out: dict[str, str] = {}
    for r in t.select("team_abbr", "team_name", "team_nick").to_dicts():
        abbr = ABBR_ALIASES.get(r["team_abbr"], r["team_abbr"])
        out.setdefault(r["team_name"].lower(), abbr)
        out.setdefault(r["team_nick"].lower(), abbr)
    # Modern names must win over historical ones sharing a nickname.
    out.update({
        "los angeles rams": "LA", "rams": "LA", "los angeles chargers": "LAC", "chargers": "LAC",
        "las vegas raiders": "LV", "raiders": "LV", "washington commanders": "WAS", "commanders": "WAS",
        "washington": "WAS", "washington football team": "WAS",
    })
    return out


def team_abbr(name: str | None) -> str | None:
    if not name:
        return None
    n = name.strip()
    if n.upper() in ABBR_ALIASES:
        return ABBR_ALIASES[n.upper()]
    if len(n) <= 3 and n.upper() == n:
        return n
    m = team_name_map()
    return m.get(n.lower()) or m.get(n.lower().split()[-1])


@lru_cache(maxsize=8)
def schedule(season: int) -> pl.DataFrame:
    return (
        scan("schedules")
        .filter(pl.col("season") == season)
        .select("game_id", "season", "week", "game_type", "gameday", "gametime", "home_team",
                "away_team", "home_score", "away_score", "spread_line", "total_line",
                "home_moneyline", "away_moneyline")
        .with_columns(pl.col("gameday").cast(pl.String))
        .sort(["week", "gameday", "gametime"])
        .collect()
    )


def current_week(season: int = CURRENT_SEASON) -> int:
    """The first week of ``season`` with an unplayed game, else the last week."""
    s = schedule(season)
    if s.is_empty():
        return 1
    today = date.today().isoformat()
    open_ = s.filter(pl.col("home_score").is_null() & (pl.col("gameday") >= today))
    if open_.is_empty():
        open_ = s.filter(pl.col("home_score").is_null())
    if open_.is_empty():
        return int(s["week"].max())
    return int(open_["week"].min())


def match_game(season: int, home: str | None, away: str | None,
               commence: str | None = None, week: int | None = None) -> dict | None:
    """Find the nflverse schedule row for a matchup. Team abbreviations are
    canonicalised; when ``week`` is unknown the closest gameday to the
    provider's commence time wins."""
    if not home or not away:
        return None
    s = schedule(season).filter((pl.col("home_team") == home) & (pl.col("away_team") == away))
    if week is not None:
        s = s.filter(pl.col("week") == week)
    if s.is_empty():
        return None
    if s.height > 1 and commence:
        try:
            d = datetime.fromisoformat(commence.replace("Z", "+00:00")).date()
        except ValueError:
            d = None
        if d is not None:
            s = s.with_columns(
                (pl.col("gameday").str.to_date() - pl.lit(d)).dt.total_days().abs().alias("_gap")
            ).sort("_gap").drop("_gap")
    return s.row(0, named=True)


def week_window(season: int, week: int) -> tuple[str, str]:
    """ISO datetimes bracketing the week's games, for the Odds API's
    commenceTimeFrom/To filters."""
    s = schedule(season).filter(pl.col("week") == week)
    days = sorted(s["gameday"].drop_nulls().to_list())
    if not days:
        today = date.today()
        return today.isoformat() + "T00:00:00Z", (today + timedelta(days=7)).isoformat() + "T00:00:00Z"
    lo = date.fromisoformat(days[0]) - timedelta(days=1)
    hi = date.fromisoformat(days[-1]) + timedelta(days=2)
    return lo.isoformat() + "T00:00:00Z", hi.isoformat() + "T00:00:00Z"


# --- odds arithmetic -------------------------------------------------------

def american_to_decimal(a: float | int | None) -> float | None:
    if a is None:
        return None
    a = float(a)
    return 1 + (a / 100 if a > 0 else 100 / -a)


def decimal_to_american(d: float | None) -> int | None:
    if d is None or d <= 1:
        return None
    return int(round((d - 1) * 100)) if d >= 2 else int(round(-100 / (d - 1)))


def implied_prob(american: float | int | None) -> float | None:
    d = american_to_decimal(american)
    return None if d is None else 1 / d


def parse_american(s) -> int | None:
    """'-110', '+142', 'EVEN', -110.0 -> int."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return int(round(s))
    t = str(s).strip().upper()
    if t in ("EVEN", "EV", "PK"):
        return 100
    try:
        return int(round(float(t.replace("+", ""))))
    except ValueError:
        return None
