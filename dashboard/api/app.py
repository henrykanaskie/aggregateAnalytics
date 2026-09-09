"""HTTP API for the dashboard, plus static hosting of the built frontend.

    uvicorn dashboard.api.app:app --port 8017 --reload

Every endpoint is read-only against the parquet cache except ``POST
/api/odds/pull``, which appends a snapshot to ``data/odds/``.
"""

from __future__ import annotations

import gzip
import json
import math
import threading
from datetime import date, datetime
from typing import Any

import polars as pl
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from data_handling import sync_odds
from nfl.data import cached_datasets, scan
from webauth import auth_router, require_session

from .. import predictions
from ..config import CURRENT_SEASON, DEFAULT_SINCE, WEB_DIST, odds_api_key
from ..odds import store
from ..odds.analysis import attach_form, build_board
from ..odds.common import current_week, schedule
from ..odds.markets import BOOKS, market_json
from ..odds.pull import run_pull
from ..stats import players as players_mod
from ..stats.catalog import GROUPS, catalog_json
from ..stats import coaches as coaches_mod
from ..stats import context as ctx_mod
from ..stats import angles as ang_mod
from ..stats import matchups as mu_mod
from ..stats import extras as ex_mod
from ..stats import projection as proj_mod
from ..odds import grading
from ..stats import pbp as pbp_mod
from ..stats import team as team_mod
from ..stats.gamelog import availability, game_log

# One password in front of everything (webauth/README.md). The dependency
# gates every route below, including the SPA catch-all; the auth router must
# be included before that catch-all is defined so /password is reachable.
app = FastAPI(title="Aggregate Analytics", version="0.1.0",
              dependencies=[Depends(require_session)])
app.include_router(auth_router)
# These responses are lists of dicts with the same keys repeated a few thousand
# times, which is the case gzip is best at: measured 5x on a team's tendencies
# (1016 KB -> 188 KB), 8x on a position's scatter, 9x on a game log. The host
# is one small container on a free plan, so the seconds saved on the wire are
# worth more than the milliseconds spent compressing. 500 bytes is the floor
# because below it the gzip header is most of what you sent.
app.add_middleware(GZipMiddleware, minimum_size=500)
# On a stateless host, new odds snapshots arrive from git, not from disk.
sync_odds.install(app)


def _warm() -> None:
    """Build the process-lifetime caches right after boot, off the event loop.

    On a small host the first request after a wake otherwise pays for the
    player index (a scan of every season of player_stats_week), the team
    metric catalogue and the coach lookup, one after another. Warming them
    here moves that cost to the seconds after startup, where nobody is
    waiting on it. Each step is independent; a failure (no cache on disk,
    say) is logged and the app serves anyway.
    """
    import time
    steps = (
        ("player index", players_mod.player_index),
        ("teams", players_mod.teams),
        ("team metrics", team_mod.metric_json),
        ("current coaches", coaches_mod.current_coaches),
        ("coordinators", coaches_mod.coordinators),
        ("odds status", store.status),
        # The landing route is the board, so this is the request the first
        # visitor after a wake is actually waiting on. Warming it also fills
        # the DvP tables and the recent-form scan every other page reads.
        # Both sample settings: these land in the response cache and the
        # browser asks with sample lines on by default, so warming only the
        # other one would leave the first visitor building it anyway.
        ("odds board", lambda: _board_bytes(CURRENT_SEASON, None, None, None, True, 1.0, True)),
        ("odds board (real only)", lambda: _board_bytes(CURRENT_SEASON, None, None, None, False, 1.0, True)),
        # Last, and after the board: the browser warms every game on the slate
        # in the background as soon as it loads, which was sixteen full builds
        # per visitor. Built here they are handed out from memory instead. This
        # is the slowest step and nobody is waiting on it.
        ("this week's matchups", _warm_matchups),
    )
    for name, fn in steps:
        t0 = time.perf_counter()
        try:
            fn()
            print(f"[warm] {name}: {time.perf_counter() - t0:.2f}s")
        except Exception as exc:  # noqa: BLE001
            print(f"[warm] {name} skipped: {type(exc).__name__}: {exc}")


def _warm_matchups() -> None:
    # Only the browser's default setting. With a real feed pulled the store
    # drops sample rows anyway, so warming the other one would build the same
    # sixteen responses twice.
    week = current_week(CURRENT_SEASON)
    for gid in schedule(CURRENT_SEASON).filter(pl.col("week") == week)["game_id"].to_list():
        _MATCHUP_CACHE.get((store.version(), gid, True), lambda g=gid: game_matchup(g, True))


@app.on_event("startup")
async def _warm_on_startup() -> None:
    import asyncio
    asyncio.get_running_loop().run_in_executor(None, _warm)


# --- helpers ---------------------------------------------------------------

def _clean(v: Any) -> Any:
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return v


# --- cached JSON responses --------------------------------------------------
# Two reads on this site cost real CPU and produce a megabyte of JSON, and
# neither moves until a new snapshot lands. What is kept is the finished bytes
# rather than the dict, because encoding and compressing them was costing more
# than the query itself: the board is 1.1 MB of JSON that gzips to 91 KB, and
# doing that per request on a container with a fraction of a CPU is most of
# what a first-time visitor waits through.
#
# Every key starts with store.version(), so a pull or a sync retires the whole
# cache without anything having to remember to clear it.

class _ByteCache:
    """Built-once (json, gzipped json) pairs, newest snapshot only."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.entries: dict[tuple, tuple[bytes, bytes]] = {}
        self.lock = threading.Lock()

    def get(self, key: tuple, build) -> tuple[bytes, bytes]:
        hit = self.entries.get(key)
        if hit is not None:
            return hit
        # One builder at a time. Two visitors landing together on a cold cache
        # would otherwise run the same scan side by side on one small CPU,
        # which is slower for both than one of them waiting for the other.
        with self.lock:
            hit = self.entries.get(key)
            if hit is not None:
                return hit
            # The same encoder and separators FastAPI would have used, so what
            # goes over the wire is what it was before the cache existed.
            raw = json.dumps(jsonable_encoder(build()), ensure_ascii=False,
                             allow_nan=False, separators=(",", ":")).encode()
            # Level 6 rather than gzip's 9: within a few percent of the size,
            # a third of the time, and this host has CPU to spare for neither.
            entry = (raw, gzip.compress(raw, 6))
            for k in [k for k in self.entries if k[0] != key[0]]:
                del self.entries[k]
            while len(self.entries) >= self.limit:
                del self.entries[next(iter(self.entries))]
            self.entries[key] = entry
            return entry


def _cached_json(request: Request, entry: tuple[bytes, bytes]) -> Response:
    """Serve a cached pair, pre-encoded when the client takes gzip. The gzip
    middleware sees content-encoding already set and leaves it alone."""
    raw, gz = entry
    headers = {"vary": "Accept-Encoding"}
    if "gzip" in request.headers.get("accept-encoding", ""):
        return Response(gz, media_type="application/json",
                        headers={**headers, "content-encoding": "gzip"})
    return Response(raw, media_type="application/json", headers=headers)


def records(df: pl.DataFrame) -> list[dict]:
    """DataFrame -> JSON-safe list of dicts (NaN -> null, datetimes -> ISO)."""
    return [{k: _clean(v) for k, v in row.items()} for row in df.to_dicts()]


def _week_default(season: int, week: int | None) -> int:
    return week if week is not None else current_week(season)


# --- meta ------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/meta")
def meta():
    season = CURRENT_SEASON
    week = current_week(season)
    return {
        "season": season,
        "week": week,
        "default_since": DEFAULT_SINCE,
        "teams": players_mod.teams(),
        "stats": catalog_json(),
        "stat_groups": GROUPS,
        "markets": market_json(),
        "books": BOOKS,
        "odds": {
            "has_odds_api_key": bool(odds_api_key()),
            "status": store.status(),
            "oddsapi_usage": _usage(),
        },
        "datasets": cached_datasets(),
        "split_dims": [{"key": d.key, "label": d.label, "roles": list(d.roles), "since": d.since, "note": d.note} for d in pbp_mod.DIMS],
        "team_metrics": team_mod.metric_json(),
        "team_table_ready": team_mod.CACHE.exists(),
        "current_coaches": coaches_mod.current_coaches(),
        "have_coordinators": coaches_mod.have_coordinators(),
        "coach_roles": [{"key": r, "label": coaches_mod.ROLE_LABEL[r], "sides": list(coaches_mod.ROLE_SIDES[r]),
                         "attribution": coaches_mod.ROLE_ATTRIBUTION[r]} for r in coaches_mod.ROLES],
    }


def _usage():
    from ..odds.theoddsapi import usage
    return usage()


# --- players ---------------------------------------------------------------

_PLAYER_COLS = ["player_id", "name", "position", "team", "first_season", "last_season", "games",
                "headshot", "jersey_number", "status"]


@app.get("/api/players")
def players(q: str = "", limit: int = Query(25, le=200), position: str | None = None,
            team: str | None = None, active: bool = True):
    """Current players by default (recent stat line, on a roster). ``active=false`` searches everyone since 1999."""
    df = players_mod.search(q, limit=limit, position=position, team=team, active=active)
    return records(df.select(_PLAYER_COLS))


@app.get("/api/players/{player_id}")
def player(player_id: str):
    p = players_mod.profile(player_id)
    if p is None:
        raise HTTPException(404, "unknown player")
    p = {k: _clean(v) for k, v in p.items()}
    p.pop("name_norm", None)
    return p


@app.get("/api/players/{player_id}/gamelog")
def gamelog(player_id: str, since: int = Query(1999, ge=1999)):
    if players_mod.profile(player_id) is None:
        raise HTTPException(404, "unknown player")
    df = game_log(player_id)
    df = df.filter(pl.col("season") >= since)
    return {"player_id": player_id, "rows": records(df), "available": availability(df)}


@app.get("/api/players/{player_id}/lines")
def player_lines(player_id: str, season: int = CURRENT_SEASON, week: int | None = None,
                 include_sample: bool = False):
    """Every current line for the player's game this week, all books and
    markets, plus the snapshot history for line-movement charts."""
    week = _week_default(season, week)
    prof = players_mod.profile(player_id)
    if prof is None:
        raise HTTPException(404, "unknown player")
    latest = store.latest_props(season, week, include_sample)
    mine = latest.filter(pl.col("player_id") == player_id) if not latest.is_empty() else latest
    rows = build_board(mine)
    attach_form(rows, [season - 1, season])
    proj_mod.project_rows(rows, season, week, dvp_season=coaches_mod.season_used(prof.get("team") or "", season) if prof.get("team") else None)
    hist = store.prop_history(player_id, season=season, week=week)
    team = prof.get("team")
    game = None
    if team:
        s = schedule(season).filter((pl.col("week") == week) &
                                    ((pl.col("home_team") == team) | (pl.col("away_team") == team)))
        if not s.is_empty():
            game = records(s)[0]
    return {
        "player_id": player_id, "season": season, "week": week, "game": game,
        "sources": sorted(set(mine["source"].to_list())) if not mine.is_empty() else [],
        "markets": rows,
        "history": records(hist.select("pulled_at", "source", "book", "market", "side", "line", "price", "open_line")),
    }


@app.get("/api/players/{player_id}/splits")
def player_splits(player_id: str, role: str | None = None, dim: list[str] | None = Query(None),
                  since: int = Query(1999, ge=1999), season_type: str | None = None, stat: str | None = None):
    """Play-level splits (shotgun vs under center, red zone, play action...)."""
    prof = players_mod.profile(player_id)
    if prof is None:
        raise HTTPException(404, "unknown player")
    roles = pbp_mod.available_roles(player_id)
    role = role or pbp_mod.default_role(prof.get("position"), stat)
    if roles.get(role, 0) == 0:
        role = max(roles, key=roles.get) if any(roles.values()) else role
    out = pbp_mod.splits(player_id, role, dim, since=since, season_type=season_type)
    out["roles"] = roles
    return out


@app.get("/api/players/{player_id}/splits/games")
def player_splits_games(player_id: str, role: str, dim: str, since: int = Query(1999, ge=1999)):
    if dim not in pbp_mod.DIM_BY_KEY:
        raise HTTPException(400, "unknown dim")
    return pbp_mod.splits_by_game(player_id, role, dim, since=since)


@app.get("/api/players/{player_id}/teammates")
def teammates(player_id: str, since: int | None = None):
    return ex_mod.teammate_presence(player_id, since)


@app.get("/api/players/{player_id}/correlations")
def player_correlations(player_id: str, stat: str, since: int | None = None):
    return {"stat": stat, "rows": ex_mod.correlations(player_id, stat, since)}


@app.get("/api/scatter/players")
def scatter_players(season: int = CURRENT_SEASON - 1, position: str = "WR", min_games: int = 4):
    """League-wide per-game numbers for one position and season, for peer scatter charts."""
    return {"season": season, "position": position.upper(), "rows": ex_mod.player_scatter(season, position.upper(), min_games)}


@app.get("/api/dvp/factors")
def dvp_factors_api(position: str, stat: str, since: int = 2016):
    return ex_mod.dvp_factors(position.upper(), stat, since)


@app.get("/api/grading/summary")
def grading_summary(season: int | None = None):
    return grading.summary(season)


class GradeRequest(BaseModel):
    season: int
    week: int
    include_sample: bool = False


@app.post("/api/grading/run")
def grading_run(req: GradeRequest):
    g = grading.grade_week(req.season, req.week, include_sample=req.include_sample)
    return {"season": req.season, "week": req.week, "graded": g.height}


class LogBaselineRequest(BaseModel):
    season: int | None = None
    week: int | None = None
    include_sample: bool = False


@app.post("/api/projections/log")
def log_baseline(req: LogBaselineRequest):
    season = req.season or CURRENT_SEASON
    week = _week_default(season, req.week)
    latest = store.latest_props(season, week, req.include_sample)
    rows = build_board(latest)
    proj_mod.project_rows(rows, season, week, dvp_season=coaches_mod.season_used(rows[0]["home_team"], season) if rows else None)
    n = proj_mod.log_baseline(rows, season, week)
    return {"season": season, "week": week, "logged": n}


@app.get("/api/teams/{team}/players")
def team_players(team: str, season: int = CURRENT_SEASON - 1):
    return records(players_mod.team_players(team, season))


# --- teams & coaches ---------------------------------------------------------

def _need_team_table():
    if not team_mod.CACHE.exists():
        raise HTTPException(503, "team tendency table not built yet: run `python -m dashboard.stats.team`")


@app.get("/api/teams/{team}/tendencies")
def team_tendencies(team: str, since: int = Query(2010, ge=1999), season_type: str = "REG"):
    """Per-season rates with league ranks, plus every game since ``since``."""
    _need_team_table()
    team = team.upper()
    tg = team_mod.team_games()
    if season_type in ("REG", "POST"):
        tg = tg.filter(pl.col("season_type") == season_type)
    ranks = coaches_mod.season_ranks() if season_type == "REG" else team_mod.with_ranks(team_mod.rates(tg, ["season", "team"]))
    seasons = ranks.filter((pl.col("team") == team) & (pl.col("season") >= since)).sort("season", descending=True)
    games = team_mod.rates(tg.filter((pl.col("team") == team) & (pl.col("season") >= since)),
                           ["season", "week", "season_type", "game_id", "opponent", "home"]).sort(["season", "week"])
    return {
        "team": team, "since": since, "seasons": records(seasons), "games": records(games),
        "coaches": coaches_mod.team_history(team), "current_coach": coaches_mod.current_coaches().get(team),
        "coordinators": coaches_mod.team_staff_history(team),
        "metrics": team_mod.metric_json(),
    }


def _team_block(t: str, use: int, season: int) -> dict:
    ranks = coaches_mod.season_ranks()
    tg = team_mod.team_games().filter(pl.col("season_type") == "REG")
    row = ranks.filter((pl.col("team") == t) & (pl.col("season") == use))
    recent = tg.filter(pl.col("team") == t).sort(["season", "week"]).tail(4)
    last4 = team_mod.rates(recent, ["team"]) if not recent.is_empty() else None
    return {"team": t, "season": records(row)[0] if not row.is_empty() else None,
            "last4": records(last4)[0] if last4 is not None and not last4.is_empty() else None,
            "coach": coaches_mod.current_coaches(season).get(t)}


@app.get("/api/matchup")
def matchup(team: str, opponent: str, season: int = CURRENT_SEASON, position: str | None = None):
    """Team offense vs opponent defense, for the research page: the latest
    season with games (this one once it has started, else last), with league
    ranks, plus each side's last four regular-season games."""
    _need_team_table()
    team, opponent = team.upper(), opponent.upper()
    use = coaches_mod.season_used(team, season)
    out = {"season_used": int(use), "team": _team_block(team, use, season), "opponent": _team_block(opponent, use, season), "metrics": team_mod.metric_json()}
    pos = position.upper() if position else None
    if pos in ctx_mod.POS_GROUPS:
        dvp_season = use
        table = ctx_mod.dvp_table(dvp_season, pos)
        row = table.filter(pl.col("defense") == opponent)
        out["dvp"] = {
            "position": pos, "season": dvp_season, "stats": ctx_mod.DVP_BY_POS[pos], "labels": ctx_mod.DVP_LABELS,
            "season_row": records(row)[0] if not row.is_empty() else None,
            "last4": ctx_mod.dvp_recent(opponent, pos, 4),
            "log": records(ctx_mod.dvp_log(opponent, pos, dvp_season).head(40)),
        }
    return out


# One game is 176 KB of JSON, and the browser warms every game on the slate in
# the background, so this is the other read worth keeping built.
_MATCHUP_CACHE = _ByteCache(limit=20)   # a week is sixteen games, plus a few


@app.get("/api/matchups/{game_id}")
def game_matchup_route(request: Request, game_id: str, include_sample: bool = False):
    entry = _MATCHUP_CACHE.get((store.version(), game_id, include_sample),
                               lambda: game_matchup(game_id, include_sample))
    return _cached_json(request, entry)


def game_matchup(game_id: str, include_sample: bool = False):
    """Everything about one game: scheme both ways, angles, personnel,
    history, venue, injuries, props and the model's call."""
    _need_team_table()
    try:
        season = int(game_id.split("_")[0])
    except ValueError:
        raise HTTPException(400, "bad game id")
    g = schedule(season).filter(pl.col("game_id") == game_id)
    if g.is_empty():
        raise HTTPException(404, "unknown game")
    full = scan("schedules").filter(pl.col("game_id") == game_id).collect()
    game = records(full)[0]
    home, away = game["home_team"], game["away_team"]
    use = coaches_mod.season_used(home, season)
    blocks = {t: _team_block(t, use, season) for t in (home, away)}
    dvp_tables = {pos: ctx_mod.dvp_table(use, pos) for pos in ctx_mod.POS_GROUPS}

    def dvp_for(defense: str) -> dict:
        out = {}
        for pos, table in dvp_tables.items():
            row = table.filter(pl.col("defense") == defense)
            out[pos] = {"season_row": records(row)[0] if not row.is_empty() else None,
                        "last4": ctx_mod.dvp_recent(defense, pos, 4), "stats": ctx_mod.DVP_BY_POS[pos]}
        return out

    sides = []
    venue_info = mu_mod.venue(game)
    for off_t, def_t in ((away, home), (home, away)):
        dvp = dvp_for(def_t)
        # `use` is the season the numbers come from; `season` is the roster they
        # are read against. In September those are different years.
        off_pers = mu_mod.offense_personnel(off_t, use, roster_season=season)
        # betting spread from the offense's side: negative = favoured
        sl = game.get("spread_line")
        off_spread = None if sl is None else (-sl if off_t == home else sl)
        team_angles = mu_mod.angles(blocks[off_t]["season"], blocks[def_t]["season"], off_t, def_t,
                                    {p: v["season_row"] for p, v in dvp.items()})
        team_angles += mu_mod.team_angles_extra(blocks[off_t]["season"], blocks[def_t]["season"], off_t, def_t, off_spread, venue_info)
        team_angles.sort(key=lambda x: -x["strength"])
        key_players = [p for p in off_pers if p["position"] in ("QB", "RB", "WR", "TE")][:8]
        sides.append({
            "offense": off_t, "defense": def_t,
            "offense_block": blocks[off_t], "defense_block": blocks[def_t],
            "dvp": dvp,
            "angles": team_angles,
            "player_angles": ang_mod.for_matchup(off_t, def_t, season, use, key_players, blocks[def_t]["season"]),
            "offense_personnel": records(pl.DataFrame(off_pers)) if off_pers else [],
            "defense_personnel": mu_mod.defense_personnel(def_t, use, roster_season=season),
        })
    latest = store.latest_props(season, game["week"], include_sample)
    props = build_board(latest.filter(pl.col("game_id") == game_id)) if not latest.is_empty() else []
    attach_form(props, [season - 1, season])
    lines = store.latest_games(season, game["week"], include_sample)
    lines = records(lines.filter(pl.col("game_id") == game_id)) if not lines.is_empty() else []
    preds = predictions.game_predictions(season, game["week"])
    preds = records(preds.filter(pl.col("game_id") == game_id)) if not preds.is_empty() else []
    inj = {t: records(ctx_mod.team_injuries(t, season, game["week"])) for t in (home, away)}
    return {
        "game": game, "season_used": use, "sides": sides, "metrics": team_mod.metric_json(),
        "dvp_labels": ctx_mod.DVP_LABELS, "history": mu_mod.head_to_head(away, home),
        "venue": mu_mod.venue(game), "props": props, "lines": lines, "predictions": preds, "injuries": inj,
        "sources": sorted(set(latest["source"].to_list())) if not latest.is_empty() else [],
    }


@app.get("/api/teams/{team}/dvp")
def team_dvp(team: str, position: str = "RB", season: int = CURRENT_SEASON - 1):
    pos = position.upper()
    if pos not in ctx_mod.POS_GROUPS:
        raise HTTPException(400, "position must be QB, RB, WR or TE")
    table = ctx_mod.dvp_table(season, pos)
    return {"season": season, "position": pos, "stats": ctx_mod.DVP_BY_POS[pos], "labels": ctx_mod.DVP_LABELS,
            "league": records(table), "team": team.upper(),
            "log": records(ctx_mod.dvp_log(team.upper(), pos, season)) if team.upper() != "ALL" else []}


@app.get("/api/teams/{team}/usage")
def team_usage_api(team: str, season: int = CURRENT_SEASON - 1, season_type: str = "REG"):
    return {"team": team.upper(), "season": season, "rows": records(ctx_mod.team_usage(team.upper(), season, season_type))}


@app.get("/api/coaches/{name}/usage")
def coach_usage_api(name: str, role: str = "HC"):
    _need_team_table()
    # Every season he was coaching this side of the ball, not just the ones
    # under his current title: who got the ball in Miami is exactly the
    # question a reader has about Mike McDaniel, and it is his head-coaching
    # years that answer it.
    # Who got the ball is an offensive question, so a head coach's defensive
    # coordinator years have no business in it even though they are his.
    acc = coaches_mod.accountable_seasons(name, _role(role))
    if not acc.is_empty():
        acc = acc.filter(pl.col("held").map_elements(
            lambda h: coaches_mod.accountable_for(h, "off"), return_dtype=pl.Boolean))
    cs = acc.select("team", "season").unique().sort("season") if not acc.is_empty() else acc
    if cs.is_empty():
        raise HTTPException(404, "unknown coach")
    return {"coach": name, "rows": [{k: _clean(v) if not isinstance(v, dict) else {kk: _clean(vv) for kk, vv in v.items()} for k, v in r.items()}
                                    for r in ctx_mod.coach_usage([(r["team"], r["season"]) for r in cs.to_dicts()])]}


@app.get("/api/players/{player_id}/injuries")
def player_injuries_api(player_id: str):
    df = ctx_mod.player_injuries(player_id)
    return {"player_id": player_id, "rows": records(df) if not df.is_empty() else []}


@app.get("/api/teams/{team}/injuries")
def team_injuries_api(team: str, season: int = CURRENT_SEASON, week: int | None = None):
    week = _week_default(season, week)
    df = ctx_mod.team_injuries(team.upper(), season, week)
    latest = ctx_mod.latest_injury_week(season)
    return {"team": team.upper(), "season": season, "week": week, "latest_week_available": latest,
            "rows": records(df) if not df.is_empty() else []}


@app.get("/api/tendencies/league")
def league_tendencies(season: int = CURRENT_SEASON - 1):
    _need_team_table()
    r = coaches_mod.season_ranks().filter(pl.col("season") == season).sort("team")
    return {"season": season, "teams": records(r), "metrics": team_mod.metric_json(),
            "coaches": {k: v for k, v in coaches_mod.current_coaches(season).items()}}


def _role(role: str) -> str:
    r = role.upper()
    if r not in coaches_mod.ROLE_SIDES:
        raise HTTPException(422, f"unknown role {role!r}; expected one of {', '.join(coaches_mod.ROLES)}")
    if r != "HC" and not coaches_mod.have_coordinators():
        raise HTTPException(503, "coordinator table not fetched yet: run `python -m data_handling.fetch_coordinators`")
    return r


@app.get("/api/coaches")
def coaches_api(role: str = "HC"):
    _need_team_table()
    return coaches_mod.staff_list(_role(role))


@app.get("/api/coaches/{name}")
def coach_api(name: str, role: str = "HC"):
    _need_team_table()
    p = coaches_mod.staff_profile(name, _role(role))
    if p is None:
        raise HTTPException(404, "unknown coach")
    return {**p, "seasons": [{k: _clean(v) for k, v in s.items()} for s in p["seasons"]],
            "career": {k: _clean(v) for k, v in p["career"].items()}, "metrics": team_mod.metric_json()}


# --- odds ------------------------------------------------------------------

# The board is the landing page and by far the most expensive read on the
# host: eight hundred rows, each one projected off two seasons of game logs.
# Nothing in it moves until a new snapshot lands, so the built response is kept
# and handed straight back until the store's fingerprint changes. Without this
# every visitor paid the full build, and on a small container that is seconds
# of staring at an empty board.
_BOARD_CACHE = _ByteCache(limit=6)      # a handful of filter combinations


def _board_bytes(season: int, week: int | None, market: list[str] | None, book: str | None,
                 include_sample: bool, scale: float, form: bool) -> tuple[bytes, bytes]:
    week = _week_default(season, week)
    # Keyed on the resolved week, so a request that left the week to the server
    # and one that named it share an entry rather than building the same board
    # twice.
    key = (store.version(), season, week, tuple(market or ()), book, include_sample, scale, form)
    return _BOARD_CACHE.get(key, lambda: _build_board_response(
        season, week, market, book, include_sample, scale, form))


@app.get("/api/odds/board")
def odds_board(request: Request, season: int = CURRENT_SEASON, week: int | None = None,
               market: list[str] | None = Query(None), book: str | None = None,
               include_sample: bool = False, scale: float = Query(1.0, gt=0), form: bool = True):
    return _cached_json(request, _board_bytes(season, week, market, book, include_sample, scale, form))


def _build_board_response(season: int, week: int, market: list[str] | None, book: str | None,
                          include_sample: bool, scale: float, form: bool) -> dict:
    latest = store.latest_props(season, week, include_sample)
    rows = build_board(latest, markets=market, threshold_scale=scale)
    if book:
        rows = [r for r in rows if any(b["book"] == book for b in r["books"])]
    if form:
        attach_form(rows, [season - 1, season])
    proj_mod.project_rows(rows, season, week, dvp_season=coaches_mod.season_used(rows[0]["home_team"], season) if rows else None)
    sources = sorted(set(latest["source"].to_list())) if not latest.is_empty() else []
    pulled = latest["pulled_at"].max() if not latest.is_empty() else None
    return {"season": season, "week": week, "sources": sources, "pulled_at": _clean(pulled),
            "n": len(rows), "rows": rows, "alerts": ex_mod.alerts(rows, season, week, scale)}


@app.get("/api/odds/games")
def odds_games(season: int = CURRENT_SEASON, week: int | None = None, include_sample: bool = False):
    week = _week_default(season, week)
    sched = schedule(season).filter(pl.col("week") == week)
    latest = store.latest_games(season, week, include_sample)
    preds = predictions.game_predictions(season, week)
    by_game: dict[str, dict] = {}
    for r in records(latest):
        g = by_game.setdefault(r["game_id"], {})
        b = g.setdefault(r["book"], {"book": r["book"], "title": r["book_title"], "source": r["source"]})
        key = f"{r['market']}:{r['side']}"
        b[key] = {"line": r["line"], "price": r["price"], "open_line": r["open_line"], "open_price": r["open_price"]}
    pred_by_game: dict[str, list] = {}
    for r in records(preds) if not preds.is_empty() else []:
        pred_by_game.setdefault(r["game_id"], []).append(r)
    games = []
    for g in records(sched):
        games.append({**g, "books": list(by_game.get(g["game_id"], {}).values()),
                      "predictions": pred_by_game.get(g["game_id"], [])})
    return {"season": season, "week": week,
            "sources": sorted(set(latest["source"].to_list())) if not latest.is_empty() else [],
            "games": games}


@app.get("/api/odds/status")
def odds_status():
    return {"has_odds_api_key": bool(odds_api_key()), "status": store.status(), "oddsapi_usage": _usage()}


class PullRequest(BaseModel):
    source: str = "espn"
    season: int | None = None
    week: int | None = None
    markets: list[str] | None = None
    bookmakers: list[str] | None = None
    games: list[str] | None = None
    max_credits: int = 250
    with_games: bool = True
    dry_run: bool = False


@app.post("/api/odds/pull")
def odds_pull(req: PullRequest):
    log: list[str] = []
    try:
        result = run_pull(req.source, req.season, req.week, markets=req.markets, bookmakers=req.bookmakers,
                          max_credits=req.max_credits, games=req.games, with_games=req.with_games,
                          dry_run=req.dry_run, log=log.append)
    except Exception as exc:
        raise HTTPException(400, f"{type(exc).__name__}: {exc}") from exc
    result["log"] = log
    return result


# --- schedule & predictions -----------------------------------------------

@app.get("/api/schedule")
def schedule_api(season: int = CURRENT_SEASON, week: int | None = None):
    s = schedule(season)
    if week is not None:
        s = s.filter(pl.col("week") == week)
    return records(s)


@app.get("/api/predictions")
def predictions_api(season: int = CURRENT_SEASON, week: int | None = None):
    week = _week_default(season, week)
    games = predictions.game_predictions(season, week)
    props = predictions.prop_predictions(season, week)
    return {
        "season": season, "week": week,
        "games": records(games) if not games.is_empty() else [],
        "props": records(props) if not props.is_empty() else [],
        "prop_contract": {k: str(v) for k, v in predictions.PROP_PRED_SCHEMA.items()},
        "prop_file": str(predictions.PROP_PRED_PATH),
        "prop_file_exists": predictions.PROP_PRED_PATH.exists(),
    }


# --- static frontend --------------------------------------------------------

if WEB_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        target = WEB_DIST / path
        if path and target.is_file():
            return FileResponse(target)
        return FileResponse(WEB_DIST / "index.html")
