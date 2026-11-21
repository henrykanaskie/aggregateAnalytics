"""Path resolution for the explorer.

Every other module imports from here so nothing depends on the process CWD.
The cache itself is located by ``nfl.data``, which is the one place in the repo
that resolves it (and honours ``NFL_DATA_DIR``). The explorer must not keep its
own copy of that logic: it used to say ``data_handling/data/raw``, which is
where the cache lived before it moved to the repository root, and the whole
explorer silently found nothing.
"""

from __future__ import annotations

import contextlib
import os
import sys
from pathlib import Path

EXPLORER_DIR = Path(__file__).resolve().parent
PKG_DIR = EXPLORER_DIR.parent                 # data_handling/
REPO_ROOT = PKG_DIR.parent                    # nfl_predictor/

# `nfl.data` is imported for its paths, so the repo root has to be importable
# whatever the CWD was.
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from nfl.data import DATA_ROOT, MANIFEST_PATH, PRED_PATH, RAW_DIR  # noqa: E402

DATA_DIR = RAW_DIR
MANIFEST = MANIFEST_PATH
PREDICTIONS = PRED_PATH
DERIVED_DIR = DATA_ROOT / "derived"

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
    """Run a block from the repository root.

    ``ingest.py`` resolves the cache through ``nfl.data`` now, so nothing here
    depends on the CWD any more; this stays so that a relative path written by
    hand (an export, a subprocess) still lands beside ``data/``."""
    prev = Path.cwd()
    os.chdir(REPO_ROOT)
    try:
        yield REPO_ROOT
    finally:
        os.chdir(prev)


def dataset_path(name: str) -> Path:
    """Absolute path to a dataset: a directory of season files, or one file."""
    d = DATA_DIR / name
    return d if d.is_dir() else DATA_DIR / f"{name}.parquet"



def is_seasonal(name: str) -> bool:
    return (DATA_DIR / name).is_dir()
