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


def dataset_path(name: str) -> Path:
    """Season-partitioned datasets are directories; static ones are files."""
    d = RAW_DIR / name
    return d if d.is_dir() else RAW_DIR / f"{name}.parquet"


def is_cached(name: str) -> bool:
    return dataset_path(name).exists()


def scan(name: str) -> pl.LazyFrame:
    """Lazily read a cached dataset.

    nflverse adds columns over time, so the per-season files have drifting
    schemas. Missing columns are inserted as null and unexpected ones ignored
    rather than raising.
    """
    p = dataset_path(name)
    if not p.exists():
        raise FileNotFoundError(
            f"{name!r} is not cached at {p}. Run: python data_handling/ingest.py --only {name}"
        )
    if p.is_dir():
        return pl.scan_parquet(
            p / "*.parquet", extra_columns="ignore", missing_columns="insert"
        )
    return pl.scan_parquet(p)


def cached_datasets() -> list[str]:
    if not RAW_DIR.is_dir():
        return []
    names = {p.name for p in RAW_DIR.iterdir() if p.is_dir()}
    names |= {p.stem for p in RAW_DIR.glob("*.parquet")}
    return sorted(names)
