"""A baseline projection for every prop: recency-weighted recent form,
adjusted for the opponent's generosity to the position.

This is deliberately simple and fully transparent. It exists so the board can
show "line minus projection", so the grading loop has a reference to score,
and so the real model has something to beat. It logs itself to
``data/derived/prop_predictions.parquet`` as ``baseline-v1`` through the same
contract the model will use.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from statistics import mean

import polars as pl

from ..config import PROP_PRED_PATH
from ..odds.markets import BY_KEY
from .context import DVP_STATS, dvp_table
from .gamelog import recent_longest, recent_values

MODEL_VERSION = "baseline-v1"
HALF_LIFE = 4          # games; the 5th most recent game counts half as much as the latest
N_GAMES = 12
FACTOR_CLIP = (0.8, 1.25)

# Catalog stat -> the box-score stat the defense-vs-position table tracks.
_DVP_KEY = {s: s for s in DVP_STATS}
_DVP_KEY.update({"completions": "passing_yards", "attempts": "passing_yards", "rush_rec_yards": "receiving_yards",
                 "total_tds": "receiving_tds", "rush_rec_tds": "receiving_tds", "pass_rush_yards": "passing_yards"})


def _weights(n: int) -> list[float]:
    return [0.5 ** ((n - 1 - i) / HALF_LIFE) for i in range(n)]


def _wstats(vals: list[float]) -> tuple[float, float, float]:
    """Weighted mean, weighted median, weighted sd (floored)."""
    w = _weights(len(vals))
    tot = sum(w)
    m = sum(v * x for v, x in zip(vals, w)) / tot
    var = sum(x * (v - m) ** 2 for v, x in zip(vals, w)) / tot
    order = sorted(zip(vals, w))
    acc, med = 0.0, order[-1][0]
    for v, x in order:
        acc += x
        if acc >= tot / 2:
            med = v
            break
    sd = max(math.sqrt(var), 0.25 * max(abs(m), 1.0), 0.5)
    return m, med, sd


def _phi(z: float) -> float:
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def dvp_factor(position: str | None, stat: str, defense: str | None, season: int) -> tuple[float, dict | None]:
    """How generous the defense has been to the position for this stat,
    relative to league average. 1.0 = neutral, clipped to FACTOR_CLIP."""
    key = _DVP_KEY.get(stat)
    pos = {"FB": "RB", "HB": "RB"}.get(position or "", position)
    if not key or not defense or pos not in ("QB", "RB", "WR", "TE"):
        return 1.0, None
    t = dvp_table(season, pos)
    if t.is_empty() or t.filter(pl.col("defense") == defense).is_empty():
        return 1.0, None
    league = float(t[key].mean())
    row = t.filter(pl.col("defense") == defense).row(0, named=True)
    allowed = row[key]
    if not league or allowed is None:
        return 1.0, None
    f = min(FACTOR_CLIP[1], max(FACTOR_CLIP[0], allowed / league))
    return f, {"allowed": allowed, "league": league, "rank": row.get(f"{key}_rank"), "games": row.get("games"), "season": season}


def project_rows(rows: list[dict], season: int, week: int, dvp_season: int | None = None) -> None:
    """Mutates board rows: adds ``proj`` = {value, base, median, sd, factor,
    n, low, high, p_over, edge}. One batch scan for all players."""
    by_player: dict[str, set[str]] = {}
    for r in rows:
        if r.get("player_id") and r.get("stat"):
            by_player.setdefault(r["player_id"], set()).add(r["stat"])
    if not by_player:
        return
    stats = sorted({s for ss in by_player.values() for s in ss})
    seasons = [season - 1, season]
    vals = recent_values(list(by_player), stats, seasons)
    long_players = [p for p, ss in by_player.items() if any(s.startswith("long_") for s in ss)]
    for pid, d in recent_longest(long_players, seasons).items():
        vals.setdefault(pid, {}).update(d)
    use = dvp_season or (season - 1)
    for r in rows:
        r["proj"] = None
        pv = vals.get(r.get("player_id") or "")
        if not pv or r["stat"] not in pv:
            continue
        # Only games before this one count.
        series = [v for v in pv[r["stat"]] if v is not None][-N_GAMES:]
        if len(series) < 3:
            continue
        m, med, sd = _wstats([float(v) for v in series])
        defense = r["home_team"] if r.get("team") == r.get("away_team") else r["away_team"] if r.get("team") else None
        factor, ctx = dvp_factor(r.get("position"), r["stat"], defense, use)
        value = m * factor
        line = r.get("consensus")
        p_over = None
        if r.get("kind") == "ou" and line is not None:
            p_over = 1 - _phi((line - value) / sd)
        elif r.get("kind") == "yesno":
            # Probability of at least one: Poisson on the adjusted mean.
            p_over = 1 - math.exp(-max(value, 0.01))
        r["proj"] = {
            "value": round(value, 2), "base": round(m, 2), "median": med, "sd": round(sd, 2), "factor": round(factor, 3),
            "factor_ctx": ctx, "n": len(series), "low": round(value - 0.67 * sd, 1), "high": round(value + 0.67 * sd, 1),
            "p_over": None if p_over is None else round(p_over, 3),
            "edge": None if (line is None or r.get("kind") != "ou") else round(value - line, 2),
            "model_version": MODEL_VERSION,
        }


def log_baseline(rows: list[dict], season: int, week: int) -> int:
    """Append the baseline projections to the shared prediction log, one row
    per player-market, so the grader scores them alongside the model. Skips
    rows already logged for this season/week/version."""
    new = [
        {"logged_at": datetime.now(timezone.utc).replace(tzinfo=None), "model_version": MODEL_VERSION,
         "season": season, "week": week, "game_id": r["game_id"], "player_id": r["player_id"], "market": r["market"],
         "pred": r["proj"]["value"], "p_over": r["proj"]["p_over"], "line": r.get("consensus") if r.get("kind") == "ou" else None,
         "book": "consensus", "notes": f"n={r['proj']['n']} factor={r['proj']['factor']} sd={r['proj']['sd']}"}
        for r in rows if r.get("proj") and r.get("player_id") and r.get("game_id")
    ]
    if not new:
        return 0
    df = pl.DataFrame(new).with_columns(pl.col("logged_at").cast(pl.Datetime("us")))
    if PROP_PRED_PATH.exists():
        old = pl.read_parquet(PROP_PRED_PATH)
        done = old.filter((pl.col("model_version") == MODEL_VERSION) & (pl.col("season") == season) & (pl.col("week") == week))
        if not done.is_empty():
            have = set(zip(done["player_id"].to_list(), done["market"].to_list()))
            df = df.filter(~pl.struct(["player_id", "market"]).map_elements(lambda s: (s["player_id"], s["market"]) in have, return_dtype=pl.Boolean))
        if df.is_empty():
            return 0
        added = df.height
        df = pl.concat([old, df], how="diagonal_relaxed")
    else:
        added = df.height
    PROP_PRED_PATH.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(PROP_PRED_PATH)
    return added
