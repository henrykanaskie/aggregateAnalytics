"""Keep ``data/odds/`` on a stateless host in step with the repo.

The lines workflow commits a snapshot four times a day. Rebuilding the site
for each one would burn the free host's build minutes, so instead the running
app pulls new files straight from GitHub: on startup, and every
``interval`` seconds while awake. Files are matched by path and size; nothing
is ever deleted locally.

Standard library only. Reads:

    ODDS_REPO   owner/name            (required to sync; absent means no-op)
    ODDS_REF    branch or sha         (default main)
    GH_TOKEN    for a private repo

Wire into a FastAPI app with :func:`install`.
"""

from __future__ import annotations

import asyncio
import json
import os
import urllib.request
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from nfl.data import DATA_ROOT

SUBDIR = "data/odds"
STATE: dict = {"last_sync": None, "files": 0, "last_error": None}


def _headers(accept: str) -> dict[str, str]:
    h = {"Accept": accept, "User-Agent": "nfl_predictor-sync-odds"}
    tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


def _get(url: str, accept: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=_headers(accept))) as r:
        return r.read()


def remote_files(repo: str, ref: str, *, fetch: Callable[[str, str], bytes] = _get) -> list[dict]:
    """``[{path, size, sha}]`` for everything under :data:`SUBDIR` at ``ref``."""
    tree = json.loads(fetch(
        f"https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1",
        "application/vnd.github+json",
    ))["tree"]
    prefix = SUBDIR + "/"
    return [t for t in tree if t["type"] == "blob" and t["path"].startswith(prefix)]


def sync(
    repo: str | None = None,
    ref: str | None = None,
    dest: Path = DATA_ROOT / "odds",
    *,
    fetch: Callable[[str, str], bytes] = _get,
) -> int:
    """Download files that are missing locally or differ in size. Returns the
    number fetched. No repo configured: returns 0 and does nothing."""
    repo = repo or os.environ.get("ODDS_REPO")
    ref = ref or os.environ.get("ODDS_REF", "main")
    if not repo:
        return 0

    got = 0
    for f in remote_files(repo, ref, fetch=fetch):
        rel = f["path"][len(SUBDIR) + 1:]
        local = dest / rel
        if local.exists() and local.stat().st_size == f["size"]:
            continue
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(fetch(
            f"https://raw.githubusercontent.com/{repo}/{ref}/{f['path']}",
            "application/octet-stream",
        ))
        got += 1

    STATE.update(last_sync=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                 files=sum(1 for _ in dest.rglob("*") if _.is_file()) if dest.exists() else 0,
                 last_error=None)
    return got


def install(app, *, interval: int = 1800) -> None:
    """Sync at startup, then every ``interval`` seconds, in the event loop."""

    async def _loop() -> None:
        while True:
            try:
                n = await asyncio.to_thread(sync)
                if n:
                    print(f"[sync_odds] fetched {n} new file(s)")
            except Exception as e:  # noqa: BLE001 -- keep the app up, report on /healthz
                STATE["last_error"] = f"{type(e).__name__}: {e}"
                print(f"[sync_odds] {STATE['last_error']}")
            await asyncio.sleep(interval)

    @app.on_event("startup")
    async def _start() -> None:
        app.state.sync_odds_task = asyncio.create_task(_loop())
