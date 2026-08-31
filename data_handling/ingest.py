from __future__ import annotations
 
import argparse
import gc
import json
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
 
import nflreadpy as nfl
import polars as pl

DATA_DIR = Path("data/raw")
MANIFEST = Path("data/manifest.json")

CURRENT_SEASON = 2026

@dataclass
class Dataset:
    """One nflverse table"""
    name: str
    loader: Callable[..., pl.DataFrame]
    first_season: int | None       # None = not season-partitioned
    kwargs: dict[str, Any] = field(default_factory=dict)
    seasonal: bool = True          # False for static tables (teams, players)
    note: str = ""
 
    def resolve_seasons(self, start: int, end: int) -> list[int]:
        lo = max(start, self.first_season or start)
        return list(range(lo, end + 1))

# ---------------------------------------------------------------------------
# Dataset registry
# ---------------------------------------------------------------------------
 
DATASETS: list[Dataset] = [
    # --- Core spine -------------------------------------------------------
    Dataset("pbp", nfl.load_pbp, 1999,
            note="Play-by-play w/ EPA, WP, CPOE, xpass. ~370 cols. The backbone."),
    Dataset("schedules", nfl.load_schedules, 1999,
            note="Games + spread_line, total_line, moneylines, rest, roof, "
                 "surface, temp, wind, starting QB ids, coaches, referee."),
 
    # --- Usage / role -----------------------------------------------------
    Dataset("snap_counts", nfl.load_snap_counts, 2013,
            note="Offense/defense/ST snap counts and pct. Foundation of role."),
    Dataset("depth_charts", nfl.load_depth_charts, 2001,
            note="Nominal role. Weaker than snap share -- use as fallback."),
    Dataset("rosters_weekly", nfl.load_rosters_weekly, 1999,
            note="Who was actually on the roster that week."),
    Dataset("player_stats_week", nfl.load_player_stats, 1999,
            kwargs={"summary_level": "week"},
            note="Weekly player box score + fantasy points."),
    Dataset("team_stats_week", nfl.load_team_stats, 1999,
            kwargs={"summary_level": "week"},
            note="Weekly team box score."),
 
    # --- Opportunity modeling --------------------------------------------
    Dataset("ff_opportunity", nfl.load_ff_opportunity, 2006,
            kwargs={"stat_type": "weekly"},
            note="EXPECTED fantasy points from opportunity. Directly implements "
                 "the 'opportunity beats efficiency' principle."),
 
    # --- Availability -----------------------------------------------------
    Dataset("injuries", nfl.load_injuries, 2009,
            note="Official practice participation (DNP/Limited/Full) + game "
                 "status. Structured, leakage-safe, historical."),
 
    # --- Advanced charting ------------------------------------------------
    Dataset("ngs_passing", nfl.load_nextgen_stats, 2016,
            kwargs={"stat_type": "passing"},
            note="Time to throw, aggressiveness, CPOE."),
    Dataset("ngs_receiving", nfl.load_nextgen_stats, 2016,
            kwargs={"stat_type": "receiving"},
            note="Separation, cushion, YAC over expected."),
    Dataset("ngs_rushing", nfl.load_nextgen_stats, 2016,
            kwargs={"stat_type": "rushing"},
            note="Rush yards over expected (RYOE), 8+ defenders in box."),
    Dataset("pfr_pass", nfl.load_pfr_advstats, 2018, kwargs={"stat_type": "pass"},
            note="PRESSURE RATE allowed/generated. Tier-1 feature."),
    Dataset("pfr_rush", nfl.load_pfr_advstats, 2018, kwargs={"stat_type": "rush"},
            note="Yards before/after contact, broken tackles."),
    Dataset("pfr_rec", nfl.load_pfr_advstats, 2018, kwargs={"stat_type": "rec"}),
    Dataset("pfr_def", nfl.load_pfr_advstats, 2018, kwargs={"stat_type": "def"},
            note="Pressures, blitzes, missed tackles."),
    Dataset("ftn_charting", nfl.load_ftn_charting, 2022,
            note="Manual charting: play action, screen, RPO, motion, blitz. "
                 "Short history -- 2022+ only."),
    Dataset("participation", nfl.load_participation, 2016,
            note="Personnel groupings + who was on the field. NFL stopped "
                 "supplying this after 2023; treat as a closed archive."),
 
    # --- Priors / static --------------------------------------------------
    Dataset("draft_picks", nfl.load_draft_picks, 1999,
            note="Draft capital -- strong prior for players with <2 seasons."),
    Dataset("combine", nfl.load_combine, 1999),
    Dataset("officials", nfl.load_officials, 1999,
            note="Referee assignment. Penalty rate varies by crew."),
    Dataset("players", nfl.load_players, None, seasonal=False,
            note="Player master incl. birthdate -> AGE, which you need."),
    Dataset("teams", nfl.load_teams, None, seasonal=False),
    Dataset("contracts", nfl.load_contracts, None, seasonal=False,
            note="For testing the contract-year hypothesis. Expect it to fail."),
    Dataset("trades", nfl.load_trades, None, seasonal=False),
]
 
REGISTRY = {d.name: d for d in DATASETS}


# fetching
def dataset_path(name: str) -> Path:
    d = DATA_DIR / name
    return d if d.is_dir() else DATA_DIR / f"{name}.parquet"

def scan(name:str) -> pl.LazyFrame:
    # lazily read a chached dataset
    p = dataset_path(name)
    if p.is_dir():
        # api adds columns over time so season files have drifting schemas
        # turns missing cols to null instead of errors
        return pl.scan_parquet(p / "*.parquet", extra_columns="ignore", missing_columns="insert")
    return pl.scan_parquet(p)

def ingest(names: list[str], start: int, end:int, refresh:bool) -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {}

    if MANIFEST.exists():
      manifest = json.loads(MANIFEST.read_text())

    for name in names:
        ds = REGISTRY[name]

        # static tables
        if not ds.seasonal:
            out = DATA_DIR/f"{name}.parquet"
            if out.exists() and not refresh:
                print(f"[skip] {name}")
                continue
            print(f"[pull] {name} ...", flush=True)
            try:
                df = ds.loader(**ds.kwargs)
                df.write_parquet(out, compression="zstd")
                manifest[name] = {
                    "status": "ok", "rows":df.height, "cols":df.width, "seasons": None, "mb": round(out.stat().st_size / 1e6, 1), "note":ds.note,
                }
                print(f"{df.height:,} rows x {df.width} cols")
            except Exception:
                print(f"[FAIL] {name}")
                traceback.print_exc(limit=2)
                manifest[name] = {"status": "failed"}
            continue

        # seasonal tables, per seasons
        outdir = DATA_DIR / name
        outdir.mkdir(parents=True, exist_ok=True)
        seasons = ds.resolve_seasons(start, end)

        rows = cols = 0
        got: list[int] = []
        t0 = time.time()
        print(f"[pull] {name} ({seasons[0]}-{seasons[-1]}) ...", flush=True)

        for yr in seasons:
            f = outdir/f"{name}_{yr}.parquet"
            if f.exists() and not refresh:
                got.append(yr)
                continue
            try:
                df = ds.loader(seasons=[yr], **ds.kwargs)
            except Exception as exc:
                print(f"       {yr}: skipped ({type(exc).__name__})")
                continue
            if df.height == 0:
                continue
            if "season" not in df.columns:
                df = df.with_columns(pl.lit(yr).alias("season"))
            df.write_parquet(f, compression="zstd")
            rows += df.height
            cols = max(cols, df.width)
            got.append(yr)
 
            # nflreadpy memoises every response in-process (~200 MB/season
            # for pbp), so a 27-season loop will OOM a small box. We have the
            # data on disk now, so drop both the frame and the library cache.
            del df
            nfl.clear_cache()
            gc.collect()

        if not got:
              print(f"[warn] {name} -- nothing retrieved")
              manifest[name] = {"status": "empty"}
              continue
  
        mb = sum(f.stat().st_size for f in outdir.glob("*.parquet")) / 1e6
        manifest[name] = {
            "status": "ok", "rows": rows or None, "cols": cols or None,
            "seasons": [min(got), max(got)], "files": len(got),
            "mb": round(mb, 1), "note": ds.note,
        }
        print(f"       {len(got)} seasons, {mb:.1f} MB ({time.time()-t0:.0f}s)")

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2))
    return manifest


PRED_PATH = Path("data/predictions.parquet")
 
PRED_SCHEMA = {
    "logged_at": pl.Datetime,      # when YOU made the call
    "game_id": pl.String,
    "season": pl.Int64,
    "week": pl.Int64,
    "model_version": pl.String,
    "pred_margin": pl.Float64,     # home - away, your number
    "pred_win_prob": pl.Float64,
    "market_spread": pl.Float64,   # spread at time of logging
    "market_total": pl.Float64,
    "notes": pl.String,
}

def log_predictions(rows: list[dict]) -> None:
    # Append-only
    new = pl.DataFrame(rows, schema=PRED_SCHEMA)
    if PRED_PATH.exists():
        new = pl.concat([pl.read_parquet(PRED_PATH), new], how="diagonal_relaxed")
    PRED_PATH.parent.mkdir(parents=True, exist_ok=True)
    new.write_parquet(PRED_PATH)
 
 
def init_predictions_log() -> None:
    if not PRED_PATH.exists():
        pl.DataFrame(schema=PRED_SCHEMA).write_parquet(PRED_PATH)
        print(f"[init] empty predictions log at {PRED_PATH}")

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=1999)
    ap.add_argument("--end", type=int, default=CURRENT_SEASON)
    ap.add_argument("--only", nargs="*", default=None,
                    choices=list(REGISTRY), metavar="DATASET")
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
 
    if args.list:
        for d in DATASETS:
            first = d.first_season if d.seasonal else "static"
            print(f"{d.name:20s} from {str(first):8s} {d.note}")
        return 0
 
    names = args.only or list(REGISTRY)
    manifest = ingest(names, args.start, args.end, args.refresh)
    init_predictions_log()
 
    ok = sum(1 for v in manifest.values() if v.get("status") == "ok")
    total_mb = sum(v.get("mb", 0) for v in manifest.values())
    print(f"\n{ok}/{len(manifest)} datasets cached, {total_mb:.0f} MB total")
    return 0
 
 
if __name__ == "__main__":
    sys.exit(main())