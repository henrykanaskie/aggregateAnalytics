"""sync_odds against a fake GitHub: fetches what is missing, skips what
matches, is a no-op with no repo configured, and deletes local snapshots only
when ODDS_KEEP_DAYS asks it to."""

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


def test_never_deletes_local_files_without_a_window(tmp_path):
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


def _snapshots(*names: str) -> dict[str, bytes]:
    return {f"data/odds/{n}": n.encode() for n in names}


def test_the_window_spans_a_slate_not_a_pull(tmp_path):
    """ESPN drops a game's odds once it is final, so a played game's closing
    line only lives in snapshots from before kickoff. A window of days keeps
    them; keeping one pull per source would not."""
    thursday = "props/20260910T220000Z_espn.parquet"   # before the Thursday game
    sunday = "props/20260913T160000Z_espn.parquet"     # before the 1pm slate
    monday = "props/20260915T000000Z_espn.parquet"     # both games now final
    fetch, _ = _fake_github(_snapshots(thursday, sunday, monday))

    assert sync_odds.sync("o/r", "main", tmp_path, fetch=fetch, days=10) == 3
    assert len(list((tmp_path / "props").iterdir())) == 3


def test_snapshots_past_the_window_are_dropped_and_never_refetched(tmp_path):
    old = "props/20260820T085048Z_espn.parquet"
    new = "props/20260909T023340Z_espn.parquet"
    (tmp_path / "props").mkdir(parents=True)
    (tmp_path / old).write_bytes(f"data/odds/{old}".encode())
    fetch, calls = _fake_github(_snapshots(old, new))

    assert sync_odds.sync("o/r", "main", tmp_path, fetch=fetch, days=10) == 1
    assert [q.name for q in (tmp_path / "props").iterdir()] == ["20260909T023340Z_espn.parquet"]
    assert sync_odds.STATE["removed"] == 1
    assert sum(old in c for c in calls) == 0        # the stale one is not downloaded

    # A second pass must not re-fetch what the first pass deleted.
    fetch, calls = _fake_github(_snapshots(old, new))
    assert sync_odds.sync("o/r", "main", tmp_path, fetch=fetch, days=10) == 0
    assert sync_odds.STATE["removed"] == 0


def test_every_source_keeps_its_newest_however_old(tmp_path):
    """The sources pull on different clocks; a run of ESPN snapshots must not
    evict the last Odds API one."""
    fetch, _ = _fake_github(_snapshots(
        "props/20260701T120000Z_oddsapi.parquet",
        "props/20260908T085048Z_espn.parquet",
        "props/20260909T023340Z_espn.parquet",
    ))
    assert sync_odds.sync("o/r", "main", tmp_path, fetch=fetch, days=0) == 2
    assert sorted(q.name for q in (tmp_path / "props").iterdir()) == [
        "20260701T120000Z_oddsapi.parquet", "20260909T023340Z_espn.parquet"]


def test_the_window_is_measured_from_the_newest_pull_not_from_now(tmp_path):
    """Pulls stop in the offseason. The archive should keep its last days of
    lines rather than ageing out to a single file."""
    fetch, _ = _fake_github(_snapshots(
        "props/20260208T120000Z_espn.parquet",
        "props/20260210T120000Z_espn.parquet",
    ))
    assert sync_odds.sync("o/r", "main", tmp_path, fetch=fetch, days=10) == 2


def test_window_leaves_non_snapshot_files_alone(tmp_path):
    fetch, _ = _fake_github(_snapshots("props/20260909T023340Z_espn.parquet"))
    (tmp_path / "espn_athletes.json").write_bytes(b"{}")
    (tmp_path / "graded").mkdir()
    (tmp_path / "graded" / "week1.parquet").write_bytes(b"g")

    sync_odds.sync("o/r", "main", tmp_path, fetch=fetch, days=0)

    assert (tmp_path / "espn_athletes.json").exists()
    assert (tmp_path / "graded" / "week1.parquet").exists()


def test_an_unreadable_snapshot_name_is_never_deleted(tmp_path):
    fetch, _ = _fake_github(_snapshots("props/20260909T023340Z_espn.parquet"))
    (tmp_path / "props").mkdir(parents=True)
    (tmp_path / "props" / "handwritten.parquet").write_bytes(b"mine")

    sync_odds.sync("o/r", "main", tmp_path, fetch=fetch, days=0)

    assert (tmp_path / "props" / "handwritten.parquet").exists()


def test_an_empty_listing_deletes_nothing(tmp_path):
    fetch, _ = _fake_github({})
    (tmp_path / "props").mkdir(parents=True)
    (tmp_path / "props" / "20260908T085048Z_espn.parquet").write_bytes(b"keep")

    sync_odds.sync("o/r", "main", tmp_path, fetch=fetch, days=0)

    assert (tmp_path / "props" / "20260908T085048Z_espn.parquet").exists()


def test_window_reads_odds_keep_days_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("ODDS_KEEP_DAYS", "1")
    fetch, _ = _fake_github(_snapshots(
        "props/20260907T085048Z_espn.parquet",
        "props/20260908T085048Z_espn.parquet",
        "props/20260909T023340Z_espn.parquet",
    ))
    assert sync_odds.sync("o/r", "main", tmp_path, fetch=fetch) == 2
    assert sorted(q.name for q in (tmp_path / "props").iterdir()) == [
        "20260908T085048Z_espn.parquet", "20260909T023340Z_espn.parquet"]
