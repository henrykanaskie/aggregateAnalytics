"""Grade posted lines and logged predictions against what actually happened.

For each week: take the last snapshot of every over/under line (the closing
line as far as the store knows), look up the player's actual stat in the box
score, and record over / under / push per book. Do the same for every row in
the prediction log (baseline and model alike). Results are written per week
to ``data/odds/graded/`` and summarised by book, market, signal and model.

This is the feedback loop. Without it, every angle and every hit rate on the
dashboard is an opinion; with it, you can see which books post soft lines,
whether "L10 at 70%" means anything, and whether the projection beats the
market.
"""

from __future__ import annotations

from statistics import mean

import polars as pl

from nfl.data import scan

from ..config import ODDS_DIR
from ..stats.catalog import RAW_STAT_COLUMNS, STATS
from ..stats.gamelog import recent_longest, recent_values
from .markets import BY_KEY
from .store import latest_props

GRADED_DIR = ODDS_DIR / "graded"


def _actuals(season: int, week: int, stats: list[str]) -> pl.DataFrame:
    """player_id -> actual value per stat for one week (regular or playoffs)."""
    base = {s.key for s in STATS if s.expr is None and s.key in RAW_STAT_COLUMNS}
    derived = {s.key: s.expr for s in STATS if s.expr is not None}
    wanted = [k for k in stats if k in base or k in derived]
    lf = (
        scan("player_stats_week")
        .filter((pl.col("season") == season) & (pl.col("week") == week))
        .select(["player_id", "game_id"] + RAW_STAT_COLUMNS)
        .with_columns([derived[k].alias(k) for k in wanted if k in derived])
        .select(["player_id", "game_id"] + wanted)
    )
    df = lf.collect()
    longs = [k for k in stats if k.startswith("long_")]
    if longs and not df.is_empty():
        lg = recent_longest(df["player_id"].to_list(), [season])
        # recent_longest is per season; pick the value for this game via a per-game scan instead
        pbp = (scan("pbp").filter((pl.col("season") == season) & (pl.col("week") == week))
               .select("game_id", "receiver_player_id", "rusher_player_id", "passer_player_id", "receiving_yards", "rushing_yards", "passing_yards", "complete_pass"))
        rec = pbp.filter(pl.col("complete_pass") == 1).group_by(["receiver_player_id", "game_id"]).agg(pl.col("receiving_yards").max().alias("long_reception")).rename({"receiver_player_id": "player_id"})
        rush = pbp.group_by(["rusher_player_id", "game_id"]).agg(pl.col("rushing_yards").max().alias("long_rush")).rename({"rusher_player_id": "player_id"})
        pas = pbp.filter(pl.col("complete_pass") == 1).group_by(["passer_player_id", "game_id"]).agg(pl.col("passing_yards").max().alias("long_completion")).rename({"passer_player_id": "player_id"})
        for part in (rec, rush, pas):
            df = df.join(part.collect(), on=["player_id", "game_id"], how="left")
        del lg
    return df


def _form_before(player_ids: list[str], stats: list[str], season: int, week: int) -> dict[str, dict[str, list]]:
    """Values strictly before (season, week), so the signal is what a bettor
    could have seen on Tuesday."""
    vals = recent_values(player_ids, stats, [season - 1, season])
    out: dict[str, dict[str, list]] = {}
    for pid, d in vals.items():
        keep = [i for i, (s, w) in enumerate(zip(d["_season"], d["_week"])) if (s < season) or (s == season and w < week)]
        out[pid] = {k: [v[i] for i in keep if v[i] is not None] for k, v in d.items() if not k.startswith("_")}
    return out


def grade_week(season: int, week: int, write: bool = True, include_sample: bool = False) -> pl.DataFrame:
    latest = latest_props(season, week, include_sample)
    if latest.is_empty():
        return pl.DataFrame()
    latest = latest.filter(pl.col("player_id").is_not_null() & pl.col("game_id").is_not_null())
    played = scan("schedules").filter((pl.col("season") == season) & (pl.col("week") == week) & pl.col("home_score").is_not_null()).select("game_id").collect()["game_id"].to_list()
    latest = latest.filter(pl.col("game_id").is_in(played))
    if latest.is_empty():
        return pl.DataFrame()
    markets = latest["market"].unique().to_list()
    stats = sorted({BY_KEY[m].stat for m in markets if m in BY_KEY and BY_KEY[m].stat})
    actual = _actuals(season, week, stats)
    pids = latest["player_id"].unique().to_list()
    form = _form_before(pids, [s for s in stats if not s.startswith("long_")], season, week)

    rows = []
    over_rows = latest.filter(pl.col("side").is_in(["Over", "Yes"]))
    under = {(r["book"], r["market"], r["player_id"]): r for r in latest.filter(pl.col("side") == "Under").to_dicts()}
    # consensus per market/player for the signal grading
    cons: dict[tuple, float] = {}
    for (mk, pid), grp in over_rows.filter(pl.col("line").is_not_null()).group_by(["market", "player_id"]):
        cons[(mk, pid)] = float(grp["line"].median())
    for r in over_rows.to_dicts():
        m = BY_KEY.get(r["market"])
        if not m or not m.stat:
            continue
        a = actual.filter((pl.col("player_id") == r["player_id"]) & (pl.col("game_id") == r["game_id"]))
        if a.is_empty() or m.stat not in a.columns:
            continue
        val = a[m.stat][0]
        if val is None:
            continue
        val = float(val)
        line = r["line"]
        if m.kind == "ou":
            if line is None:
                continue
            result = "over" if val > line else "under" if val < line else "push"
        else:
            result = "yes" if val >= 1 else "no"
            line = 0.5
        u = under.get((r["book"], r["market"], r["player_id"]))
        f = form.get(r["player_id"], {}).get(m.stat, [])
        c = cons.get((r["market"], r["player_id"]))
        def rate(k):
            recent = f[-k:]
            return (sum(1 for v in recent if v > c) / len(recent)) if (recent and c is not None) else None
        rows.append({
            "season": season, "week": week, "game_id": r["game_id"], "source": r["source"], "book": r["book"],
            "market": r["market"], "stat": m.stat, "kind": m.kind, "player_id": r["player_id"], "player_name": r["player_name"],
            "team": r["team"], "line": line, "open_line": r["open_line"], "over_price": r["price"],
            "under_price": u["price"] if u else None, "actual": val, "result": result,
            "error": val - line, "abs_error": abs(val - line),
            "moved": None if (r["open_line"] is None or r["line"] is None) else r["line"] - r["open_line"],
            "consensus": c, "l5_rate": rate(5), "l10_rate": rate(10), "form_n": len(f),
            "pulled_at": r["pulled_at"],
        })
    graded = pl.DataFrame(rows) if rows else pl.DataFrame()
    preds = _grade_predictions(season, week, actual)
    if write:
        GRADED_DIR.mkdir(parents=True, exist_ok=True)
        if not graded.is_empty():
            graded.write_parquet(GRADED_DIR / f"lines_{season}_{week:02d}.parquet")
        if not preds.is_empty():
            preds.write_parquet(GRADED_DIR / f"preds_{season}_{week:02d}.parquet")
    return graded


def _grade_predictions(season: int, week: int, actual: pl.DataFrame) -> pl.DataFrame:
    from ..predictions import prop_predictions
    p = prop_predictions(season, week)
    if p.is_empty() or actual.is_empty():
        return pl.DataFrame()
    rows = []
    for r in p.to_dicts():
        m = BY_KEY.get(r["market"])
        if not m or not m.stat or m.stat not in actual.columns:
            continue
        a = actual.filter((pl.col("player_id") == r["player_id"]) & (pl.col("game_id") == r["game_id"]))
        if a.is_empty() or a[m.stat][0] is None:
            continue
        val = float(a[m.stat][0]); line = r.get("line"); pred = r.get("pred")
        side = None if (line is None or pred is None) else ("over" if pred > line else "under" if pred < line else None)
        hit = None if side is None else (val > line if side == "over" else val < line) if val != line else None
        rows.append({"season": season, "week": week, "game_id": r["game_id"], "model_version": r["model_version"],
                     "market": r["market"], "player_id": r["player_id"], "pred": pred, "p_over": r.get("p_over"),
                     "line": line, "actual": val, "pred_abs_error": None if pred is None else abs(val - pred),
                     "line_abs_error": None if line is None else abs(val - line), "side": side, "hit": hit,
                     "edge": None if (line is None or pred is None) else pred - line})
    return pl.DataFrame(rows) if rows else pl.DataFrame()


def graded_lines(season: int | None = None) -> pl.DataFrame:
    files = sorted(GRADED_DIR.glob("lines_*.parquet")) if GRADED_DIR.is_dir() else []
    if season is not None:
        files = [f for f in files if f.stem.split("_")[1] == str(season)]
    return pl.concat([pl.read_parquet(f) for f in files], how="diagonal_relaxed") if files else pl.DataFrame()


def graded_preds(season: int | None = None) -> pl.DataFrame:
    files = sorted(GRADED_DIR.glob("preds_*.parquet")) if GRADED_DIR.is_dir() else []
    if season is not None:
        files = [f for f in files if f.stem.split("_")[1] == str(season)]
    return pl.concat([pl.read_parquet(f) for f in files], how="diagonal_relaxed") if files else pl.DataFrame()


def summary(season: int | None = None) -> dict:
    g = graded_lines(season)
    out: dict = {"n": 0, "weeks": [], "by_book": [], "by_market": [], "signals": [], "movement": [], "models": []}
    if g.is_empty():
        return out
    ou = g.filter(pl.col("kind") == "ou")
    out["n"] = g.height
    out["weeks"] = sorted({(r["season"], r["week"]) for r in g.select("season", "week").unique().to_dicts()})
    def agg(df: pl.DataFrame, key: str) -> list[dict]:
        return (
            df.group_by(key).agg(
                pl.len().alias("n"), (pl.col("result") == "over").mean().alias("over_rate"), (pl.col("result") == "push").mean().alias("push_rate"),
                pl.col("abs_error").mean().alias("mae"), pl.col("error").mean().alias("bias"),
            ).sort("n", descending=True).to_dicts()
        )
    out["by_book"] = agg(ou, "book")
    out["by_market"] = agg(ou, "market")
    # Signals: recent form vs consensus, was it predictive?
    for col, label in (("l10_rate", "L10 hit rate"), ("l5_rate", "L5 hit rate")):
        for lo, hi, lean in ((0.7, 1.01, "over"), (0.0, 0.3, "under")):
            sub = ou.filter((pl.col(col) >= lo) & (pl.col(col) < hi) & (pl.col("result") != "push") & (pl.col("form_n") >= 5))
            if sub.is_empty():
                continue
            hits = (sub["result"] == lean).mean()
            out["signals"].append({"signal": f"{label} {'≥ 70%' if lean == 'over' else '≤ 30%'} → {lean}", "n": sub.height, "hit_rate": float(hits)})
    # Line movement: when a book moved its line from open, did the actual land on the side it moved toward?
    mv = ou.filter(pl.col("moved").is_not_null() & (pl.col("moved") != 0) & (pl.col("result") != "push"))
    if not mv.is_empty():
        toward = ((mv["moved"] > 0) & (mv["result"] == "over")) | ((mv["moved"] < 0) & (mv["result"] == "under"))
        out["movement"].append({"signal": "actual landed on the side the line moved toward", "n": mv.height, "hit_rate": float(toward.mean())})
        # And the contrarian read: closing line vs opening line, which was closer?
        closer_open = (mv["actual"] - mv["open_line"]).abs() < (mv["actual"] - mv["line"]).abs()
        out["movement"].append({"signal": "opening line was closer to the actual than the close", "n": mv.height, "hit_rate": float(closer_open.mean())})
    p = graded_preds(season)
    if not p.is_empty():
        for mv_, grp in p.group_by("model_version"):
            dec = grp.filter(pl.col("hit").is_not_null())
            strong = dec.filter(pl.col("edge").abs() >= 5)
            out["models"].append({
                "model_version": mv_[0], "n": grp.height, "hit_rate": float(dec["hit"].mean()) if not dec.is_empty() else None,
                "n_strong": strong.height, "hit_rate_strong": float(strong["hit"].mean()) if not strong.is_empty() else None,
                "pred_mae": float(grp["pred_abs_error"].mean()), "line_mae": float(grp["line_abs_error"].drop_nulls().mean()) if grp["line_abs_error"].drop_nulls().len() else None,
            })
    return out
