"""Where and when a game is played, from each team's point of view.

The schedules table says the venue, the surface and the kickoff time in
Eastern time. What a model wants is the game relative to each team: how many
hours the away side's body clock is off the kickoff, whether they flew east
or west, and whether they are on a surface they do not play on at home. None
of that is in nflverse, so it is derived here from three small tables and the
schedule itself.

    from nfl.context import game_context
    ctx = game_context()            # one row per game, keyed on game_id

Columns, all from the visitor's or the venue's point of view:

    venue_tz            IANA zone the game is played in
    home_tz, away_tz    each team's home zone (the franchise's city)
    kickoff_venue_hour  local kickoff, hours (20.25 = 8:15 pm)
    home_body_hour,
    away_body_hour      kickoff on each team's home clock
    home_tz_shift,
    away_tz_shift       venue offset minus the team's home offset, in hours;
                        negative = the team travelled west, positive = east
    away_travel_east    the away team lost hours (an early-window east-coast
                        kickoff for a west-coast team is the classic case)
    venue_surface       "grass" or "turf"
    home_usual_surface,
    away_usual_surface  what each team plays on at home that season
    away_surface_change the away team is on the other kind of surface
    home_surface_change same for the home team (neutral sites only, in practice)

Time-zone offsets are taken on the game date, so daylight saving and Arizona's
refusal of it are handled by the zone database rather than by a constant.
"""

from __future__ import annotations

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

import polars as pl

from .data import scan

#: The zone each franchise's home city sits in. Relocated franchises appear
#: under every abbreviation nflverse has used for them, since the schedule
#: keeps the abbreviation of the day.
HOME_TZ: dict[str, str] = {
    "ARI": "America/Phoenix", "ATL": "America/New_York", "BAL": "America/New_York", "BUF": "America/New_York",
    "CAR": "America/New_York", "CHI": "America/Chicago", "CIN": "America/New_York", "CLE": "America/New_York",
    "DAL": "America/Chicago", "DEN": "America/Denver", "DET": "America/Detroit", "GB": "America/Chicago",
    "HOU": "America/Chicago", "IND": "America/Indiana/Indianapolis", "JAX": "America/New_York", "KC": "America/Chicago",
    "LA": "America/Los_Angeles", "LAR": "America/Los_Angeles", "STL": "America/Chicago",
    "LAC": "America/Los_Angeles", "SD": "America/Los_Angeles",
    "LV": "America/Los_Angeles", "OAK": "America/Los_Angeles",
    "MIA": "America/New_York", "MIN": "America/Chicago", "NE": "America/New_York", "NO": "America/Chicago",
    "NYG": "America/New_York", "NYJ": "America/New_York", "PHI": "America/New_York", "PIT": "America/New_York",
    "SEA": "America/Los_Angeles", "SF": "America/Los_Angeles", "TB": "America/New_York", "TEN": "America/Chicago",
    "WAS": "America/New_York",
}

#: Venues outside the United States, matched on a fragment of the stadium
#: name. A US neutral site (a Super Bowl, a relocated game) is resolved from
#: the schedule instead: whichever team plays its home games there.
ABROAD_TZ: list[tuple[str, str]] = [
    ("Wembley", "Europe/London"), ("Tottenham", "Europe/London"), ("Twickenham", "Europe/London"),
    ("Azteca", "America/Mexico_City"), ("Allianz", "Europe/Berlin"), ("Munich", "Europe/Berlin"),
    ("Deutsche Bank", "Europe/Berlin"), ("Frankfurt", "Europe/Berlin"), ("Corinthians", "America/Sao_Paulo"),
    ("Neo Qu", "America/Sao_Paulo"), ("Croke", "Europe/Dublin"), ("Bernab", "Europe/Madrid"),
    ("Rogers Centre", "America/Toronto"), ("Tokyo", "Asia/Tokyo"), ("Melbourne", "Australia/Melbourne"),
]

#: nflverse kickoff times are Eastern, whatever the venue.
SCHEDULE_TZ = "America/New_York"

#: The two kinds of surface a model can tell apart. Every artificial product
#: nflverse names (fieldturf, sportturf, matrixturf, astroturf, a_turf,
#: astroplay) is "turf"; dessograss is a grass hybrid and counts as grass.
GRASS = {"grass", "dessograss"}


def surface_kind(surface: str | None) -> str | None:
    if surface is None:
        return None
    s = surface.strip().lower()
    if not s:
        return None
    return "grass" if s in GRASS else "turf"


def _offset_hours(zone: str, on: date) -> float:
    """UTC offset of ``zone`` at noon on ``on``, in hours."""
    at = datetime.combine(on, time(12), tzinfo=ZoneInfo(zone))
    off = at.utcoffset()
    return off.total_seconds() / 3600 if off is not None else 0.0


def _venue_zones(sched: pl.DataFrame) -> dict[str, str]:
    """stadium name -> zone, from the team that plays its home games there."""
    home_games = sched.filter(pl.col("location") != "Neutral")
    counts = home_games.group_by(["stadium", "home_team"]).len().sort("len", descending=True)
    out: dict[str, str] = {}
    for r in counts.to_dicts():
        st = r["stadium"]
        if st and st not in out and r["home_team"] in HOME_TZ:
            out[st] = HOME_TZ[r["home_team"]]
    return out


def venue_tz(stadium: str | None, home_team: str, by_stadium: dict[str, str]) -> str:
    """The zone a game is played in: abroad by name, a US site by its tenant,
    otherwise the home team's own city."""
    if stadium:
        for frag, zone in ABROAD_TZ:
            if frag.lower() in stadium.lower():
                return zone
        if stadium in by_stadium:
            return by_stadium[stadium]
    return HOME_TZ.get(home_team, SCHEDULE_TZ)


def _usual_surfaces(sched: pl.DataFrame) -> dict[tuple[int, str], str]:
    """(season, team) -> the surface kind of most of that team's home games."""
    home = (
        sched.filter(pl.col("location") != "Neutral")
        .with_columns(pl.col("surface").map_elements(surface_kind, return_dtype=pl.String).alias("kind"))
        .drop_nulls("kind")
        .group_by(["season", "home_team", "kind"]).len()
        .sort(["season", "home_team", "len"], descending=[False, False, True])
    )
    out: dict[tuple[int, str], str] = {}
    for r in home.to_dicts():
        out.setdefault((r["season"], r["home_team"]), r["kind"])
    return out


def _hour(gametime: str | None) -> float | None:
    if not gametime or ":" not in gametime:
        return None
    h, m = gametime.split(":")[:2]
    return int(h) + int(m) / 60


def game_context(sched: pl.DataFrame | None = None) -> pl.DataFrame:
    """One row per game with the time-zone and surface columns above."""
    if sched is None:
        sched = scan("schedules").collect()
    cols = ["game_id", "season", "gameday", "gametime", "home_team", "away_team", "location", "stadium", "surface"]
    sched = sched.select(cols)
    by_stadium = _venue_zones(sched)
    usual = _usual_surfaces(sched)
    rows: list[dict] = []
    for r in sched.to_dicts():
        home, away = r["home_team"], r["away_team"]
        on = date.fromisoformat(str(r["gameday"])[:10]) if r["gameday"] else date(int(r["season"]), 10, 1)
        vz = venue_tz(r["stadium"], home, by_stadium)
        hz, az = HOME_TZ.get(home, SCHEDULE_TZ), HOME_TZ.get(away, SCHEDULE_TZ)
        v_off, h_off, a_off, s_off = (_offset_hours(z, on) for z in (vz, hz, az, SCHEDULE_TZ))
        et = _hour(r["gametime"])
        venue_hour = None if et is None else et + (v_off - s_off)
        kind = surface_kind(r["surface"])
        home_usual = usual.get((r["season"], home))
        away_usual = usual.get((r["season"], away))
        rows.append({
            "game_id": r["game_id"],
            "venue_tz": vz, "home_tz": hz, "away_tz": az,
            "kickoff_venue_hour": venue_hour,
            "home_body_hour": None if et is None else et + (h_off - s_off),
            "away_body_hour": None if et is None else et + (a_off - s_off),
            "home_tz_shift": v_off - h_off,
            "away_tz_shift": v_off - a_off,
            "away_travel_east": (v_off - a_off) > 0,
            "venue_surface": kind,
            "home_usual_surface": home_usual, "away_usual_surface": away_usual,
            "away_surface_change": None if kind is None or away_usual is None else kind != away_usual,
            "home_surface_change": None if kind is None or home_usual is None else kind != home_usual,
        })
    # An explicit schema: early seasons have no kickoff time, and a frame
    # inferred from those rows would refuse the first one that does.
    return pl.DataFrame(rows, schema={
        "game_id": pl.String, "venue_tz": pl.String, "home_tz": pl.String, "away_tz": pl.String,
        "kickoff_venue_hour": pl.Float64, "home_body_hour": pl.Float64, "away_body_hour": pl.Float64,
        "home_tz_shift": pl.Float64, "away_tz_shift": pl.Float64, "away_travel_east": pl.Boolean,
        "venue_surface": pl.String, "home_usual_surface": pl.String, "away_usual_surface": pl.String,
        "away_surface_change": pl.Boolean, "home_surface_change": pl.Boolean,
    })
