"""Franchise identity.

A franchise is a continuous entity; its abbreviation is not. Three franchises
relocated inside the 1999-2026 window and nflverse spells them differently
depending on the table:

    Rams      STL -> LA   (2016)   also seen as LAR
    Chargers  SD  -> LAC  (2017)   also seen as SDG
    Raiders   OAK -> LV   (2020)   also seen as LVR

Crucially, the nflverse tables do NOT agree with each other about history.
Verified against the live data:

    schedules        2005 Rams -> "STL"   (historical abbreviation preserved)
    team_stats_week  2005 Rams -> "LA"    (back-filled to the modern one)
    teams            carries BOTH "LA" and "LAR" rows for the Rams

So joining ``schedules`` to ``team_stats_week`` on a raw team string silently
drops every Rams game before 2016, every Chargers game before 2017 and every
Raiders game before 2020 -- roughly 900 team-games. Nothing errors; ratings
just quietly go wrong. Canonicalise on the way in, always.

Canonicalising creates a second, opposite hazard. ``teams`` holds 36 rows for
32 franchises -- separate rows for LA/LAR/STL, LAC/SD and LV/OAK. Map those to
franchise ids and the table now has duplicate keys, so joining it onto the game
spine multiplies rows instead of dropping them: every Rams game x3, every
Chargers and Raiders game x2. Use :func:`team_info`, which collapses to exactly
one row per franchise, rather than joining ``teams`` directly.

The canonical id is the *modern* abbreviation ("LA", "LAC", "LV"), because that
is what the majority of nflverse tables already use.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import polars as pl


@dataclass(frozen=True)
class Franchise:
    id: str
    name: str
    first_season: int
    aliases: frozenset[str] = field(default_factory=frozenset)


# Houston is the only entry inside the window: the Texans began play in 2002,
# which is why 1999-2001 have 31 franchises and 2002+ have 32.
_F = [
    Franchise("ARI", "Arizona Cardinals", 1999, frozenset({"ARZ"})),
    Franchise("ATL", "Atlanta Falcons", 1999),
    Franchise("BAL", "Baltimore Ravens", 1999, frozenset({"BLT"})),
    Franchise("BUF", "Buffalo Bills", 1999),
    Franchise("CAR", "Carolina Panthers", 1999),
    Franchise("CHI", "Chicago Bears", 1999),
    Franchise("CIN", "Cincinnati Bengals", 1999),
    Franchise("CLE", "Cleveland Browns", 1999, frozenset({"CLV"})),
    Franchise("DAL", "Dallas Cowboys", 1999),
    Franchise("DEN", "Denver Broncos", 1999),
    Franchise("DET", "Detroit Lions", 1999),
    Franchise("GB", "Green Bay Packers", 1999, frozenset({"GNB"})),
    Franchise("HOU", "Houston Texans", 2002, frozenset({"HST"})),
    Franchise("IND", "Indianapolis Colts", 1999),
    Franchise("JAX", "Jacksonville Jaguars", 1999, frozenset({"JAC"})),
    Franchise("KC", "Kansas City Chiefs", 1999, frozenset({"KAN"})),
    Franchise("LA", "Los Angeles Rams", 1999, frozenset({"STL", "SL", "LAR"})),
    Franchise("LAC", "Los Angeles Chargers", 1999, frozenset({"SD", "SDG"})),
    Franchise("LV", "Las Vegas Raiders", 1999, frozenset({"OAK", "LVR", "RAI"})),
    Franchise("MIA", "Miami Dolphins", 1999),
    Franchise("MIN", "Minnesota Vikings", 1999),
    Franchise("NE", "New England Patriots", 1999, frozenset({"NWE"})),
    Franchise("NO", "New Orleans Saints", 1999, frozenset({"NOR"})),
    Franchise("NYG", "New York Giants", 1999),
    Franchise("NYJ", "New York Jets", 1999),
    Franchise("PHI", "Philadelphia Eagles", 1999),
    Franchise("PIT", "Pittsburgh Steelers", 1999),
    Franchise("SEA", "Seattle Seahawks", 1999),
    Franchise("SF", "San Francisco 49ers", 1999, frozenset({"SFO"})),
    Franchise("TB", "Tampa Bay Buccaneers", 1999, frozenset({"TAM"})),
    Franchise("TEN", "Tennessee Titans", 1999, frozenset({"OTI"})),
    Franchise("WAS", "Washington Commanders", 1999, frozenset({"WSH", "WFT"})),
]

FRANCHISES: dict[str, Franchise] = {f.id: f for f in _F}

#: Every accepted spelling -> canonical franchise id.
ALIASES: dict[str, str] = {}
for _f in _F:
    ALIASES[_f.id] = _f.id
    for _a in _f.aliases:
        if _a in ALIASES:
            raise AssertionError(f"duplicate alias {_a!r}")
        ALIASES[_a] = _f.id

#: Season a franchise's abbreviation changed, for spot-checking rating continuity.
RELOCATIONS = {"LA": ("STL", 2016), "LAC": ("SD", 2017), "LV": ("OAK", 2020)}

#: Elo seed for an expansion team -- well below the 1500 league mean. The 2002
#: Texans went 4-12; starting them at average would hand their opponents free
#: rating for a season.
EXPANSION_ELO = 1325.0


class UnknownTeam(KeyError):
    """Raised for an abbreviation with no franchise mapping."""


def canonical_team(abbr: str | None, *, strict: bool = True) -> str | None:
    """Map any historical nflverse abbreviation to a stable franchise id.

    Strict by default: an unrecognised abbreviation raises rather than passing
    through. A team string you did not anticipate is a bug, and the failure
    mode of letting it through is a silently split rating.

    >>> canonical_team("STL"), canonical_team("SD"), canonical_team("OAK")
    ('LA', 'LAC', 'LV')
    """
    if abbr is None:
        if strict:
            raise UnknownTeam("team abbreviation is None")
        return None
    key = abbr.strip().upper()
    try:
        return ALIASES[key]
    except KeyError:
        if strict:
            raise UnknownTeam(
                f"unknown team abbreviation {abbr!r}; add it to nfl.teams.ALIASES"
            ) from None
        return None


def canonical_team_expr(col: str | pl.Expr, *, strict: bool = True) -> pl.Expr:
    """Vectorised :func:`canonical_team` for use inside polars."""
    e = pl.col(col) if isinstance(col, str) else col
    e = e.str.strip_chars().str.to_uppercase()
    if strict:
        return e.replace_strict(ALIASES, return_dtype=pl.String)
    return e.replace_strict(ALIASES, default=None, return_dtype=pl.String)


def canonicalize(df: pl.DataFrame | pl.LazyFrame, *columns: str, strict: bool = True):
    """Rewrite the named team columns in place. Missing columns are skipped."""
    have = df.collect_schema().names()
    return df.with_columns(
        [canonical_team_expr(c, strict=strict).alias(c) for c in columns if c in have]
    )


def franchise_ids(season: int | None = None) -> frozenset[str]:
    """Franchise ids active in ``season`` (all 32 when season is None)."""
    if season is None:
        return frozenset(FRANCHISES)
    return frozenset(f.id for f in _F if f.first_season <= season)


def is_active(team: str, season: int) -> bool:
    return FRANCHISES[canonical_team(team)].first_season <= season


def initial_elo(team: str, season: int, *, base: float = 1500.0) -> float:
    """Starting rating: league average, unless the franchise is new that year."""
    f = FRANCHISES[canonical_team(team)]
    return EXPANSION_ELO if f.first_season == season and season > 1999 else base


# --------------------------------------------------------------------------
# Team metadata
# --------------------------------------------------------------------------

def dedupe_team_table(teams: pl.DataFrame | pl.LazyFrame) -> pl.DataFrame:
    """Collapse the nflverse ``teams`` table to one row per franchise.

    Pure transform. Keeps the row carrying the modern abbreviation, so the
    Rams come back as "Los Angeles Rams" rather than "St. Louis Rams", and
    falls back to whatever row exists if a franchise somehow lacks one.
    """
    lf = teams.lazy().with_columns(franchise=canonical_team_expr("team_abbr"))
    out = (
        lf.sort(pl.col("team_abbr") != pl.col("franchise"))  # modern spelling first
        .group_by("franchise", maintain_order=True)
        .first()
        .sort("franchise")
        .collect()
    )
    dupes = out.height - out["franchise"].n_unique()
    if dupes:
        raise AssertionError(f"team table still has {dupes} duplicate franchises")
    return out


def team_info(source: pl.DataFrame | pl.LazyFrame | None = None) -> pl.DataFrame:
    """Franchise metadata, exactly one row per franchise, keyed on ``franchise``.

    Safe to join onto the game spine; joining raw ``teams`` is not.
    """
    if source is None:
        from .data import scan

        source = scan("teams")
    out = dedupe_team_table(source)
    if out.height != len(FRANCHISES):
        raise AssertionError(
            f"expected {len(FRANCHISES)} franchises, got {out.height}"
        )
    return out
