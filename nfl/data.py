"""Path resolution and cached-dataset access.

Split out of ``data_handling/ingest.py`` so that modelling code can read the
parquet cache without importing ``nflreadpy``. Ingestion needs the network
library; everything downstream only needs polars.

Paths are anchored to the repository root rather than the process working
directory, so ``scan()`` returns the same thing from a script, a test, or a
notebook opened three directories down.
"""

from __future__ import annotations

import os
from pathlib import Path

import polars as pl

REPO_ROOT = Path(__file__).resolve().parent.parent

# NFL_DATA_DIR lets you point at an external disk or a test fixture tree.
DATA_ROOT = Path(os.environ.get("NFL_DATA_DIR", REPO_ROOT / "data"))
RAW_DIR = DATA_ROOT / "raw"
MANIFEST_PATH = DATA_ROOT / "manifest.json"
PRED_PATH = DATA_ROOT / "predictions.parquet"

# The human-readable, git-tracked copy of the prediction log. `data/` is
# ignored, so the parquet above is one disk failure from gone and, to anyone
# else, indistinguishable from a backfill. A CSV that is committed before
# kickoff is evidence a stranger can check.
TRACK_DIR = REPO_ROOT / "track_record"
TRACK_CSV = TRACK_DIR / "predictions.csv"


#: Columns whose dtype must be identical across a dataset's per-season files.
#: nflverse ships these as Float64, Int32 or even String depending on the table
#: and the year, and left alone that is two bugs rather than one. A dataset
#: whose files disagree fails loudly (``injuries`` raises SchemaError on the
#: 1999-2020 boundary); a dataset that is uniformly Float64 or String fails
#: silently, because ``pl.col("season") == 2009`` matches nothing at all
#: against ``2009.0`` or ``"2009"``. Normalising on the way out of :func:`scan`
#: means downstream code can compare against plain integers everywhere.
#:
#: Observed drift in the current cache: ``injuries`` (Float64 through 2020,
#: Int32 from 2021) and ``ff_opportunity`` (season String, week Float64).
KEY_DTYPES: dict[str, pl.DataType] = {"season": pl.Int32, "week": pl.Int32}

#: Season-partitioned datasets whose files do NOT share a schema, mapped to the
#: reader that reconciles them.
#:
#: This is the dangerous case. ``missing_columns="insert"`` exists so that a
#: table which *gains* a column stays readable, but it cannot tell that apart
#: from a table that was rewritten from scratch: the union succeeds and the
#: minority era comes back as an all-null block. nflverse replaced
#: ``depth_charts`` wholesale in 2025 (no ``week``, no ``position``, no
#: ``depth_team``), so a naive scan returns 2001-2024 intact and every 2025+
#: row nulled out, with no error anywhere. Refuse by name instead.
UNSAFE_UNION: dict[str, str] = {
    "depth_charts": "nfl.depth.load_depth_charts",
}


class SchemaBreak(ValueError):
    """Raised when a dataset's per-season files do not share a schema."""


def dataset_path(name: str) -> Path:
    """Season-partitioned datasets are directories; static ones are files."""
    d = RAW_DIR / name
    return d if d.is_dir() else RAW_DIR / f"{name}.parquet"


def is_cached(name: str) -> bool:
    return dataset_path(name).exists()


def dataset_files(name: str) -> list[Path]:
    """The parquet files backing a dataset, oldest season first.

    Readers that have to reconcile incompatible per-season schemas need the
    files one at a time; :func:`scan` can only hand back the union.
    """
    p = dataset_path(name)
    if not p.exists():
        raise FileNotFoundError(f"{name!r} is not cached at {p}")
    return sorted(p.glob("*.parquet")) if p.is_dir() else [p]


def normalize_keys(lf: pl.LazyFrame) -> pl.LazyFrame:
    """Cast ``season`` and ``week`` to :data:`KEY_DTYPES`. Pure."""
    schema = lf.collect_schema()
    casts = [
        pl.col(c).cast(dt, strict=False).alias(c)
        for c, dt in KEY_DTYPES.items()
        if c in schema.names() and schema[c] != dt
    ]
    return lf.with_columns(casts) if casts else lf


def scan(name: str, *, strict: bool = True) -> pl.LazyFrame:
    """Lazily read a cached dataset."""
    if strict and name in UNSAFE_UNION:
        raise SchemaBreak(
            f"{name!r} does not have one schema across its per-season files, so "
            f"unioning it would return a frame with a silently all-null era. "
            f"Use {UNSAFE_UNION[name]}() instead, or scan({name!r}, strict=False) "
            f"if you really want the raw union."
        )

    p = dataset_path(name)
    if not p.exists():
        raise FileNotFoundError(
            f"{name!r} is not cached at {p}. Run: python data_handling/ingest.py --only {name}"
        )
    if p.is_dir():
        lf = pl.scan_parquet(
            p / "*.parquet",
            extra_columns="ignore",
            missing_columns="insert",
            # Without this, a column shipped as Float64 in one season and Int32
            # in another aborts the whole scan. 
            cast_options=pl.ScanCastOptions(integer_cast="allow-float"),
        )
    else:
        lf = pl.scan_parquet(p)
    return normalize_keys(lf)


def cached_datasets() -> list[str]:
    if not RAW_DIR.is_dir():
        return []
    names = {p.name for p in RAW_DIR.iterdir() if p.is_dir()}
    names |= {p.stem for p in RAW_DIR.glob("*.parquet")}
    return sorted(names)
