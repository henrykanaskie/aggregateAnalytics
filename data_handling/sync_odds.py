"""Keep ``data/odds/`` on a stateless host in step with the repo.

The lines workflow commits a snapshot four times a day. Rebuilding the site
for each one would burn the free host's build minutes, so instead the running
app pulls new files straight from GitHub: on startup, and every
``interval`` seconds while awake. Files are matched by path and size.

The snapshot archive only grows, and a 512 MB host should not hold a season of
it, so ``ODDS_KEEP_DAYS`` bounds this copy: snapshots within that many days of
a source's newest pull are fetched, anything older is deleted right after.
Unset means keep everything, which is what a laptop with the git history wants.

The window has to span a slate, not a pull. ESPN drops an event's odds as soon
as it is final, so a played game's closing line only exists in snapshots taken
before kickoff, and grading a week reads exactly those. Keeping one snapshot
per source would leave the graders nothing to grade.

Standard library only. Reads:

    ODDS_REPO       owner/name        (required to sync; absent means no-op)
    ODDS_REF        branch or sha     (default main)
    ODDS_KEEP_DAYS  days of snapshots (unset keeps every one; 0 keeps the newest)
    GH_TOKEN        for a private repo

Wire into a FastAPI app with :func:`install`.
"""

from __future__ import annotations

import asyncio
import json
import os
import urllib.request
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path

from nfl.data import DATA_ROOT

SUBDIR = "data/odds"
#: Subdirectories of ``data/odds`` holding ``<timestamp>_<source>.parquet``
#: snapshots. Everything else under ``data/odds`` is a single live file and is
#: never pruned.
SNAPSHOT_DIRS = ("props", "games")
STATE: dict = {"last_sync": None, "files": 0, "removed": 0, "last_error": None}


def _headers(accept: str) -> dict[str, str]:
    h = {"Accept": accept, "User-Agent": "aggregate-analytics-sync-odds"}
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


def _snapshot(rel: str) -> tuple[str, str, datetime] | None:
    """``(subdir, source, pulled_at)`` for ``props/20260908T085048Z_espn.parquet``,
    or ``None`` for anything that is not a timestamped snapshot. Names we cannot
    read are never candidates for deletion."""
    sub, _, name = rel.partition("/")
    if sub not in SNAPSHOT_DIRS or "/" in name or not name.endswith(".parquet"):
        return None
    stamp, sep, source = name[: -len(".parquet")].partition("_")
    if not sep:
        return None
    try:
        pulled_at = datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return sub, source, pulled_at


def keep_set(rels: list[str], days: float) -> set[str] | None:
    """Snapshots within ``days`` of the newest pull, per (subdir, source), as
    relative paths. ``None`` when there is nothing to thin, meaning: keep
    everything local.

    The window is measured from each source's own newest snapshot rather than
    from now, so an archive that stops moving in the offseason keeps its last
    days of lines instead of ageing out to nothing. Grouping by source matters
    because the sources pull on different clocks: a run of ESPN snapshots must
    not evict the last Odds API one, which is why the newest of every source is
    kept whatever ``days`` says."""
    groups: dict[tuple[str, str], list[tuple[datetime, str]]] = {}
    for rel in rels:
        snap = _snapshot(rel)
        if snap:
            sub, source, pulled_at = snap
            groups.setdefault((sub, source), []).append((pulled_at, rel))
    if not groups:
        return None  # an empty or unexpected listing is not a mandate to delete
    wanted = set()
    for pulls in groups.values():
        newest = max(p for p, _ in pulls)
        cutoff = newest - timedelta(days=days)
        wanted.update(rel for p, rel in pulls if p >= cutoff)
    return wanted


def prune(dest: Path, wanted: set[str]) -> int:
    """Delete local snapshots outside ``wanted``. Returns the number removed."""
    removed = 0
    for sub in SNAPSHOT_DIRS:
        for local in sorted((dest / sub).glob("*.parquet")) if (dest / sub).is_dir() else []:
            rel = f"{sub}/{local.name}"
            if _snapshot(rel) and rel not in wanted:
                local.unlink()
                removed += 1
    return removed


def sync(
    repo: str | None = None,
    ref: str | None = None,
    dest: Path = DATA_ROOT / "odds",
    *,
    fetch: Callable[[str, str], bytes] = _get,
    days: float | None = None,
) -> int:
    """Download files that are missing locally or differ in size. Returns the
    number fetched. No repo configured: returns 0 and does nothing.

    With ``days`` (or ``ODDS_KEEP_DAYS``) set, only snapshots inside that
    window are downloaded and older local copies are deleted, so the host holds
    a fixed span of lines however long the archive gets."""
    repo = repo or os.environ.get("ODDS_REPO")
    ref = ref or os.environ.get("ODDS_REF", "main")
    if not repo:
        return 0
    if days is None:
        env = os.environ.get("ODDS_KEEP_DAYS")
        days = float(env) if env not in (None, "") else None

    remote = [(f, f["path"][len(SUBDIR) + 1:]) for f in remote_files(repo, ref, fetch=fetch)]
    wanted = keep_set([rel for _, rel in remote], days) if days is not None else None

    got = 0
    for f, rel in remote:
        if wanted is not None and _snapshot(rel) and rel not in wanted:
            continue  # outside the window: never worth the bandwidth
        local = dest / rel
        if local.exists() and local.stat().st_size == f["size"]:
            continue
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(fetch(
            f"https://raw.githubusercontent.com/{repo}/{ref}/{f['path']}",
            "application/octet-stream",
        ))
        got += 1

    removed = prune(dest, wanted) if wanted is not None else 0
    if removed:
        print(f"[sync_odds] pruned {removed} snapshot(s) older than {days}d")

    STATE.update(last_sync=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                 files=sum(1 for _ in dest.rglob("*") if _.is_file()) if dest.exists() else 0,
                 removed=removed,
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
