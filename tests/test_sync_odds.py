"""sync_odds against a fake GitHub: fetches what is missing, skips what
matches, never deletes, and is a no-op with no repo configured."""

import json

from data_handling import sync_odds


def _fake_github(files: dict[str, bytes]):
    """(fetch, calls). Serves a tree for the repo and raw bytes per path."""
    calls: list[str] = []

    def fetch(url: str, accept: str) -> bytes:
        calls.append(url)
        if "/git/trees/" in url:
            tree = [{"path": p, "type": "blob", "size": len(b), "sha": "x"} for p, b in files.items()]
            tree.append({"path": "README.md", "type": "blob", "size": 3, "sha": "y"})
            return json.dumps({"tree": tree}).encode()
        path = url.split("/main/", 1)[1]
        return files[path]

    return fetch, calls


def test_fetches_missing_and_skips_matching(tmp_path):
    files = {"data/odds/2026-09-09T10.parquet": b"aaaa", "data/odds/2026-09-09T16.parquet": b"bbbbbb"}
    fetch, calls = _fake_github(files)
    (tmp_path / "2026-09-09T10.parquet").write_bytes(b"aaaa")       # already here, same size

    n = sync_odds.sync("o/r", "main", tmp_path, fetch=fetch)

    assert n == 1
    assert (tmp_path / "2026-09-09T16.parquet").read_bytes() == b"bbbbbb"
    assert sum("raw.githubusercontent.com" in c for c in calls) == 1
    assert sync_odds.STATE["files"] == 2 and sync_odds.STATE["last_error"] is None


def test_size_mismatch_refetches(tmp_path):
    files = {"data/odds/x.parquet": b"new-longer"}
    fetch, _ = _fake_github(files)
    (tmp_path / "x.parquet").write_bytes(b"old")
    assert sync_odds.sync("o/r", "main", tmp_path, fetch=fetch) == 1
    assert (tmp_path / "x.parquet").read_bytes() == b"new-longer"


def test_never_deletes_local_files(tmp_path):
    fetch, _ = _fake_github({})
    (tmp_path / "local-only.parquet").write_bytes(b"keep")
    sync_odds.sync("o/r", "main", tmp_path, fetch=fetch)
    assert (tmp_path / "local-only.parquet").exists()


def test_files_outside_the_subdir_are_ignored(tmp_path):
    fetch, calls = _fake_github({})
    assert sync_odds.sync("o/r", "main", tmp_path, fetch=fetch) == 0
    assert not (tmp_path / "README.md").exists()


def test_no_repo_configured_is_a_noop(tmp_path, monkeypatch):
    monkeypatch.delenv("ODDS_REPO", raising=False)
    fetch, calls = _fake_github({"data/odds/x": b"1"})
    assert sync_odds.sync(None, None, tmp_path, fetch=fetch) == 0
    assert calls == []
