"""Saved views: tiny JSON-file persistence for the explorer UI.

There is no database and no dependency budget, so a single JSON list on disk is
the whole store. Two things matter here:

* writes must be atomic (temp file + ``os.replace``) because the server is
  threaded and a half-written file would lose every saved view at once;
* a corrupt file must never take the server down. We move it aside and start
  fresh, which is recoverable, instead of raising on every request.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from datetime import datetime
from typing import Any

from . import paths

# One process-wide lock: reads are cheap and writes are rare, so a single lock
# is simpler and safer than juggling per-operation locking.
_LOCK = threading.RLock()

VALID_KINDS = ("rows", "sql", "aggregate", "join", "chart", "schema")

_ID_RE = re.compile(r"^v_(\d+)$")


def _backup_corrupt(reason: str) -> None:
    """Move an unreadable views file aside so the next write starts clean."""
    src = paths.VIEWS_FILE
    if not src.exists():
        return
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = src.with_name(f"views.corrupt-{stamp}.json")
    try:
        os.replace(src, dest)
        print(f"[views] {reason}: moved {src.name} to {dest.name}, starting fresh")
    except OSError as exc:  # pragma: no cover - disk level failure
        print(f"[views] could not back up corrupt file: {exc}")


def _read() -> list[dict[str, Any]]:
    """Load the raw list, tolerating anything the file might have become."""
    f = paths.VIEWS_FILE
    if not f.exists():
        return []
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        _backup_corrupt(f"unreadable ({type(exc).__name__})")
        return []
    if not isinstance(data, list):
        _backup_corrupt("not a JSON list")
        return []
    return [v for v in data if isinstance(v, dict) and v.get("id")]


def _write(views: list[dict[str, Any]]) -> None:
    """Atomic replace so a crash mid-write cannot truncate the store."""
    paths.ensure_cache()
    fd, tmp = tempfile.mkstemp(dir=str(paths.CACHE_DIR), prefix=".views-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(views, fh, indent=2, allow_nan=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, paths.VIEWS_FILE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _next_id(views: list[dict[str, Any]]) -> str:
    """Monotonic v_<n>: never reuse an id, even after deletes."""
    high = 0
    for v in views:
        m = _ID_RE.match(str(v.get("id", "")))
        if m:
            high = max(high, int(m.group(1)))
    return f"v_{high + 1}"


def list_views() -> dict[str, Any]:
    with _LOCK:
        return {"views": _read()}


def save_view(name: str, kind: str, payload: Any, view_id: str | None = None) -> dict[str, Any]:
    """Create a view, or replace one in place when ``view_id`` already exists."""
    with _LOCK:
        views = _read()
        record = {
            "id": view_id or _next_id(views),
            "name": name,
            "kind": kind,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "payload": payload,
        }
        for i, v in enumerate(views):
            if v.get("id") == record["id"]:
                record["created_at"] = v.get("created_at", record["created_at"])
                record["updated_at"] = datetime.now().isoformat(timespec="seconds")
                views[i] = record
                break
        else:
            views.append(record)
        _write(views)
        return {"view": record, "views": views}


def delete_view(view_id: str) -> dict[str, Any]:
    with _LOCK:
        views = _read()
        kept = [v for v in views if v.get("id") != view_id]
        found = len(kept) != len(views)
        if found:
            _write(kept)
        return {"deleted": view_id if found else None, "found": found, "views": kept}
