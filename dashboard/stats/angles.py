"""Precomputed player angles, one row per observation.

:func:`dashboard.stats.matchups.player_angles` is the most expensive thing the
API does. It pulls the play-level splits of eight skill players a side and
compares them against what the defense does most, and each of those splits is
a scan of the 305 MB play-by-play store. Profiled on one game it is 2.5 of the
3.3 seconds ``GET /api/matchups/{game_id}`` takes, and every game on the slate
pays it again for its own sixteen players.

None of that work depends on the request. The angles fall out of two tables
that are themselves rebuilt weekly -- the play-by-play cache and the team
tendency table -- so they can be built weekly too, by
``.github/workflows/stats.yml``, alongside everything else under
``data/derived``. What is left at request time is a filter on a small parquet.

The table is keyed by the defense rather than by the game, because that is
what an angle actually depends on: a receiver's man-coverage split against
Seattle is the same observation whoever else is on the field. So the build
covers every ordered pair of teams, not the seventeen games of one week, and
the table stays right when the schedule moves on.

Both seasons are part of the key. ``season`` is the one asked for, which sets
the roster; ``season_used`` is the one the numbers come from, which in
September is the year before (see
:func:`dashboard.stats.coaches.season_used`). They come apart, and a row built
against one pair must never be served for another.

Build it with::

    python -m dashboard.stats.angles

Without the file the API computes angles live, which is what local checkouts
and a fresh clone do.
"""

from __future__ import annotations

import math
from functools import lru_cache

import polars as pl

from ..config import CURRENT_SEASON, DERIVED_DIR
from .coaches import season_ranks, season_used
from .matchups import offense_personnel, player_angles as compute_angles

CACHE = DERIVED_DIR / "player_angles.parquet"

#: Positions that get player angles, and how many of a team's depth chart to
#: take. Mirrors the API: the chart is already in depth order, so this is the
#: starters plus the first man off the bench at each spot.
POSITIONS: tuple[str, ...] = ("QB", "RB", "WR", "TE")
KEY_PLAYERS = 8

SCHEMA: dict[str, pl.DataType] = {
    "season": pl.Int32,
    "season_used": pl.Int32,
    "offense": pl.String,
    "defense": pl.String,
    "player_id": pl.String,
    "player": pl.String,
    "position": pl.String,
    "title": pl.String,
    "detail": pl.String,
    "lean": pl.String,
    "tags": pl.List(pl.String),
    "strength": pl.Int32,
}


def since_for(use: int) -> int:
    """The window the splits are read over. Two seasons back, floored at 2016
    because the participation data that says man vs zone starts there."""
    return max(use - 2, 2016)


def _clean(v):
    return None if isinstance(v, float) and (math.isnan(v) or math.isinf(v)) else v


def _row(r: dict) -> dict:
    return {k: _clean(v) for k, v in r.items()}


# --- build -------------------------------------------------------------------

def build(season: int = CURRENT_SEASON, log=print) -> pl.DataFrame:
    """Every angle for every ordered pair of teams, at each season the API
    could read for them."""
    ranks = season_ranks()
    teams = sorted(t for t in ranks["team"].unique().to_list() if t)
    # Normally one season for the whole league; two only while the earliest
    # teams have four games and the rest do not.
    uses = sorted({season_used(t, season) for t in teams})
    log(f"[angles] {len(teams)} teams, season(s) used {uses}")

    frames: list[pl.DataFrame] = []
    for use in uses:
        since = since_for(use)
        blocks, players = {}, {}
        for t in teams:
            row = ranks.filter((pl.col("team") == t) & (pl.col("season") == use))
            blocks[t] = _row(row.to_dicts()[0]) if not row.is_empty() else None
            pers = offense_personnel(t, use, roster_season=season)
            players[t] = [p for p in pers if p["position"] in POSITIONS][:KEY_PLAYERS]

        rows: list[dict] = []
        for off_t in teams:
            # The splits behind these are memoised per player, so the first
            # defense pays for the offense's eight players and the other
            # thirty use what it built.
            for def_t in teams:
                if def_t == off_t:
                    continue
                for a in compute_angles(players[off_t], blocks[def_t], def_t, since=since):
                    rows.append({"season": season, "season_used": use, "offense": off_t, "defense": def_t,
                                 "player_id": a["player_id"], "player": a["player"], "position": a["position"],
                                 "title": a["title"], "detail": a["detail"], "lean": a["lean"],
                                 "tags": a["tags"], "strength": a["strength"]})
            log(f"[angles] {use} {off_t}: {len(rows)} rows so far")
        frames.append(pl.DataFrame(rows, schema=SCHEMA))

    out = (pl.concat(frames) if frames else pl.DataFrame(schema=SCHEMA)).sort(
        ["season", "season_used", "offense", "defense", "player_id"])
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    out.write_parquet(CACHE, compression="zstd")
    log(f"[angles] wrote {out.height} rows -> {CACHE}")
    table.cache_clear()
    _covered.cache_clear()
    return out


# --- read --------------------------------------------------------------------

@lru_cache(maxsize=1)
def table() -> pl.DataFrame:
    return pl.read_parquet(CACHE)


def exists() -> bool:
    return CACHE.exists()


_OUT = ["title", "detail", "lean", "tags", "strength", "player_id", "player", "position"]


@lru_cache(maxsize=1)
def _covered() -> set[tuple[int, int]]:
    """The ``(season, season_used)`` pairs the table was built for."""
    if not exists():
        return set()
    t = table().select("season", "season_used").unique()
    return {(r["season"], r["season_used"]) for r in t.to_dicts()}


def for_matchup(offense: str, defense: str, season: int, use: int, key_players: list[dict],
                def_block: dict | None) -> list[dict]:
    """The angles for one side of one game.

    Two different misses, handled differently. A season the build never covered
    -- an old game_id, a local checkout with no table at all -- computes live,
    because the alternative is telling the user there are no angles when there
    are. A pairing missing *within* a covered season returns empty: the build
    does every ordered pair of teams, so a miss there means a team code the
    table predates, and spending three seconds of a shared core to cover that
    is how the page got slow in the first place.
    """
    if (season, use) not in _covered():
        return compute_angles(key_players, def_block, defense, since=since_for(use))
    hit = table().filter((pl.col("season") == season) & (pl.col("season_used") == use)
                         & (pl.col("offense") == offense) & (pl.col("defense") == defense))
    return [{k: r[k] for k in _OUT} | {"defense": defense, "tags": list(r["tags"] or [])}
            for r in hit.to_dicts()]


if __name__ == "__main__":
    import sys
    build(int(sys.argv[1]) if len(sys.argv) > 1 else CURRENT_SEASON)
