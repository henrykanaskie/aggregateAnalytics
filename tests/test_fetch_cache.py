"""fetch_cache: extracts every .tar asset into the data dir, and a missing
release is a warning, not a failure, so the placeholder can deploy first."""

import importlib.util
import io
import sys
import tarfile
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "fetch_cache", Path(__file__).resolve().parent.parent / "scripts" / "fetch_cache.py"
)
fetch_cache = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fetch_cache)


def _tar_bytes(name: str, content: bytes) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as t:
        info = tarfile.TarInfo(name)
        info.size = len(content)
        t.addfile(info, io.BytesIO(content))
    return buf.getvalue()


def test_missing_release_warns_and_exits_zero(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("CACHE_REPO", "o/r")
    monkeypatch.setattr(fetch_cache, "release_assets", lambda repo, tag: None)
    monkeypatch.setattr(sys, "argv", ["fetch_cache", "--dest", str(tmp_path)])
    assert fetch_cache.main() == 0
    assert "no release" in capsys.readouterr().out


def test_assets_are_extracted_into_dest(monkeypatch, tmp_path):
    monkeypatch.setenv("CACHE_REPO", "o/r")
    payload = _tar_bytes("raw/schedules/schedules_2026.parquet", b"PAR1")
    assets = [{"name": "schedules.tar", "size": len(payload), "url": "u"},
              {"name": "notes.txt", "size": 1, "url": "v"}]        # ignored: not a tar
    monkeypatch.setattr(fetch_cache, "release_assets", lambda repo, tag: assets)

    def fake_download(asset, into: Path) -> Path:
        out = into / asset["name"]
        out.write_bytes(payload)
        return out
    monkeypatch.setattr(fetch_cache, "download", fake_download)
    monkeypatch.setattr(sys, "argv", ["fetch_cache", "--dest", str(tmp_path)])

    assert fetch_cache.main() == 0
    assert (tmp_path / "raw" / "schedules" / "schedules_2026.parquet").read_bytes() == b"PAR1"
    assert not (tmp_path / "_download").exists()


def test_repo_is_required(monkeypatch):
    monkeypatch.delenv("CACHE_REPO", raising=False)
    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
    with pytest.raises(SystemExit):
        fetch_cache._repo()
