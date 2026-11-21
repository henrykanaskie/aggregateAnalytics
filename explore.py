#!/usr/bin/env python3
"""Launcher: ``python explore.py`` from the repo root.

The explorer lives in ``data_handling/explorer/`` and imports ``ingest`` as a
top-level module, so ``data_handling/`` has to be on ``sys.path`` before
anything else happens. Doing that here means the user never has to think about
packages, working directories or ``-m`` flags.

This file is the front door, so every failure it can foresee prints one
actionable line instead of a traceback: wrong interpreter, no data cache, no
manifest, port already in use.

Usage:
    venv/bin/python explore.py                 # serve and open a browser
    venv/bin/python explore.py --port 9000     # start the port scan elsewhere
    venv/bin/python explore.py --no-browser --warm
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
PKG_DIR = REPO_ROOT / "data_handling"

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(PKG_DIR) not in sys.path:
    sys.path.insert(0, str(PKG_DIR))

# One source of truth for where the cache is; see data_handling/explorer/paths.py.
from nfl.data import MANIFEST_PATH as MANIFEST  # noqa: E402
from nfl.data import RAW_DIR as DATA_DIR  # noqa: E402

INGEST = "venv/bin/python data_handling/ingest.py"


def fail(*lines: str) -> int:
    """One framed, actionable message. Callers return this, never raise."""
    print("", file=sys.stderr)
    for line in lines:
        print(f"  {line}", file=sys.stderr)
    print("", file=sys.stderr)
    return 2


def check_interpreter() -> int:
    """polars is the whole data layer. Running the system python is the single
    most likely mistake, and its ImportError is not self-explanatory."""
    try:
        import polars  # noqa: F401
    except ImportError:
        return fail(
            "polars is not installed in this interpreter.",
            f"You are running: {sys.executable}",
            "Use the project venv instead:",
            "",
            "    venv/bin/python explore.py",
        )
    return 0


def _shown(path: Path) -> str:
    """The cache path as the reader knows it: relative inside the repo, absolute
    when NFL_DATA_DIR points somewhere else."""
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def check_data() -> int:
    if not PKG_DIR.is_dir():
        return fail(
            "data_handling/ was not found next to explore.py.",
            "Run this from the repository root.",
        )
    if not DATA_DIR.is_dir():
        return fail(
            f"No data cache at {_shown(DATA_DIR)}.",
            "Build it first (this downloads from nflverse and takes a while):",
            "",
            f"    {INGEST}",
            "",
            f"Or start with one small dataset: {INGEST} --only schedules",
        )
    try:
        entries = list(DATA_DIR.iterdir())
    except OSError as exc:
        return fail(f"Cannot read {DATA_DIR}: {exc}")
    has_data = any(p.suffix == ".parquet" for p in entries) or any(
        p.is_dir() and any(p.glob("*.parquet")) for p in entries
    )
    if not has_data:
        return fail(
            f"The data cache at {_shown(DATA_DIR)} is empty.",
            "Build it first:",
            "",
            f"    {INGEST}",
        )
    return 0


def check_manifest() -> None:
    """A missing or stale manifest is a warning, not a failure: the catalog
    falls back to what is actually on disk."""
    if not MANIFEST.exists():
        print(f"[warn] no manifest at {_shown(MANIFEST)}; "
              f"the catalog will read row counts from disk only. "
              f"Run `{INGEST}` to rebuild it.", file=sys.stderr)
        return
    try:
        import json
        data = json.loads(MANIFEST.read_text())
        if not isinstance(data, dict) or not data:
            raise ValueError("empty or not an object")
    except (OSError, ValueError) as exc:
        print(f"[warn] manifest at {_shown(MANIFEST)} is unreadable "
              f"({exc}); falling back to disk. Run `{INGEST}` to rebuild it.",
              file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    for check in (check_interpreter, check_data):
        problem = check()
        if problem:
            return problem
    check_manifest()

    try:
        from explorer import server
    except ImportError as exc:
        return fail(
            f"Could not import the explorer package: {exc}",
            "Expected data_handling/explorer/server.py to exist.",
        )

    args = sys.argv[1:] if argv is None else argv
    try:
        return server.main(args)
    except SystemExit as exc:
        # server.bind reports an exhausted port range this way. Show the line,
        # not a traceback.
        if isinstance(exc.code, str):
            return fail(exc.code)
        return int(exc.code or 0)
    except PermissionError:
        return fail(
            "Permission denied binding the port.",
            "Ports below 1024 need root. Pick a higher one: "
            "explore.py --port 8777",
        )
    except OSError as exc:
        return fail(f"Could not start the server: {exc}")
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
