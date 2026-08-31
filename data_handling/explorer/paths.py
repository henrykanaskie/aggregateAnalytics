"""Path resolution for the explorer.

Every other module imports from here so nothing depends on the process CWD.
`ingest.py` uses relative paths (``data/raw``), so we also expose the absolute
equivalents and a context manager that makes ``ingest.scan()`` work from
anywhere.
"""

from __future__ import annotations

import contextlib
import os
import sys
from pathlib import Path

EXPLORER_DIR = Path(__file__).resolve().parent
PKG_DIR = EXPLORER_DIR.parent                 # data_handling/
REPO_ROOT = PKG_DIR.parent                    # nfl_predictor/

DATA_DIR = PKG_DIR / "data" / "raw"
MANIFEST = PKG_DIR / "data" / "manifest.json"
PREDICTIONS = PKG_DIR / "data" / "predictions.parquet"

STATIC_DIR = EXPLORER_DIR / "static"
CACHE_DIR = EXPLORER_DIR / "cache"
VIEWS_FILE = CACHE_DIR / "views.json"

# `ingest.py` lives in data_handling/ and is imported as a top-level module.
if str(PKG_DIR) not in sys.path:
    sys.path.insert(0, str(PKG_DIR))


def ensure_cache() -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR


@contextlib.contextmanager
def in_data_root():
    """Run a block with the CWD set to ``data_handling/`` so that the relative
    paths baked into ``ingest.py`` resolve correctly."""
    prev = Path.cwd()
    os.chdir(PKG_DIR)
    try:
        yield PKG_DIR
    finally:
        os.chdir(prev)


def dataset_path(name: str) -> Path:
    """Absolute path to a dataset: a directory of season files, or one file."""
    d = DATA_DIR / name
    return d if d.is_dir() else DATA_DIR / f"{name}.parquet"


def is_seasonal(name: str) -> bool:
    return (DATA_DIR / name).is_dir()
