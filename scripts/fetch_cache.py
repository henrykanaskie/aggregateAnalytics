"""Download the parquet cache from the repo's `data-cache` GitHub Release.

The cache is a gigabyte or so and does not belong in git. It lives as one
tarball per dataset on a Release, uploaded weekly by stats.yml, and pulled
down by every deploy build so the running app has nothing on disk it cannot
recreate. Standard library only, so it runs before `pip install`.

    python scripts/fetch_cache.py            # into $NFL_DATA_DIR or ./data
    python scripts/fetch_cache.py --dest /tmp/cache

Reads GH_TOKEN (or GITHUB_TOKEN) if set; needed for a private repo. Missing
release: warn and exit 0, so a first deploy of the placeholder still works.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

TAG = "data-cache"


def _repo() -> str:
    repo = os.environ.get("CACHE_REPO") or os.environ.get("GITHUB_REPOSITORY")
    if not repo:
        sys.exit("set CACHE_REPO=owner/name (or run inside GitHub Actions)")
    return repo


def _headers(accept: str) -> dict[str, str]:
    h = {"Accept": accept, "User-Agent": "aggregate-analytics-fetch-cache"}
    tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


def release_assets(repo: str, tag: str = TAG) -> list[dict] | None:
    url = f"https://api.github.com/repos/{repo}/releases/tags/{tag}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=_headers("application/vnd.github+json"))) as r:
            return json.load(r)["assets"]
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def download(asset: dict, into: Path) -> Path:
    out = into / asset["name"]
    req = urllib.request.Request(asset["url"], headers=_headers("application/octet-stream"))
    with urllib.request.urlopen(req) as r, out.open("wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", type=Path,
                    default=Path(os.environ.get("NFL_DATA_DIR", "data")))
    ap.add_argument("--tag", default=TAG)
    ap.add_argument("--only", nargs="*", default=None,
                    help="asset names without .tar, e.g. schedules _static")
    args = ap.parse_args()

    repo = _repo()
    assets = release_assets(repo, args.tag)
    if assets is None:
        print(f"[warn] no release tagged {args.tag!r} on {repo}; cache not fetched")
        return 0

    raw = args.dest / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    tmp = args.dest / "_download"
    tmp.mkdir(exist_ok=True)
    total = 0
    for a in assets:
        if not a["name"].endswith(".tar"):
            continue
        if args.only is not None and a["name"][:-4] not in args.only:
            continue
        print(f"[get] {a['name']} ({a['size'] / 1e6:.0f} MB)")
        path = download(a, tmp)
        with tarfile.open(path) as t:
            t.extractall(args.dest, filter="data")
        path.unlink()
        total += a["size"]
    tmp.rmdir()
    print(f"[ok] {total / 1e6:.0f} MB into {args.dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
