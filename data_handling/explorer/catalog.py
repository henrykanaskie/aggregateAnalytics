"""Dataset discovery, schemas, season coverage and the derived-dataset registry.

Every read of the Parquet cache goes through :func:`lazy`. Keeping the glob in
one place is what makes season pushdown possible: a query restricted to 2024
opens one file instead of twenty-seven, which is the difference between a
20 ms request and a multi-second one on ``pbp``.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from pathlib import Path
from typing import Any

import polars as pl

from . import paths  # also puts data_handling/ on sys.path

import ingest  # noqa: E402  (import order matters: paths sets sys.path)

REGISTRY = ingest.REGISTRY

DERIVED_DIR = paths.DERIVED_DIR
DERIVED_REGISTRY = DERIVED_DIR / "_registry.json"

MAX_SEARCH_LIMIT = 200

# nflverse widens columns between seasons (Int32 -> Float64 and worse), so a
# multi-file scan needs permission to unify them.
CAST_OPTIONS = pl.ScanCastOptions(
    integer_cast=["upcast", "allow-float"],
    float_cast=["upcast", "downcast"],
    datetime_cast=["nanosecond-downcast", "microsecond-downcast",
                   "microsecond-upcast", "millisecond-upcast", "convert-timezone"],
    missing_struct_fields="insert",
    extra_struct_fields="ignore",
    categorical_to_string="allow",
)

# ``pbp/pbp_2024.parquet`` -> 2024
_SEASON_FILE = re.compile(r"_(\d{4})\.parquet$")

_LOCK = threading.Lock()
_SCHEMA_CACHE: dict[str, tuple[str, dict]] = {}
_COLTYPE_CACHE: dict[str, tuple[str, dict]] = {}
_DTYPE_CACHE: dict[str, tuple[str, dict[str, dict[str, str]]]] = {}
_MANIFEST_CACHE: tuple[float, dict] = (0.0, {})
_DERIVED_CACHE: tuple[float, list[dict]] = (-1.0, [])

# Small ring buffer so callers (and the test harness) can see how many files a
# query actually touched. Season pushdown is invisible otherwise.
_SCAN_LOG: list[dict] = []
_SCAN_LOG_MAX = 64


class DatasetError(Exception):
    """Unknown dataset or unreadable cache; the server maps this to HTTP 400."""


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def _manifest() -> dict:
    """Parsed manifest.json, re-read only when its mtime changes."""
    global _MANIFEST_CACHE
    if not paths.MANIFEST.exists():
        return {}
    mtime = paths.MANIFEST.stat().st_mtime
    if _MANIFEST_CACHE[0] == mtime:
        return _MANIFEST_CACHE[1]
    try:
        data = json.loads(paths.MANIFEST.read_text())
    except (OSError, json.JSONDecodeError):
        data = {}
    _MANIFEST_CACHE = (mtime, data)
    return data


def _disk_names() -> list[str]:
    """Datasets actually present in data/raw, regardless of the manifest."""
    if not paths.DATA_DIR.is_dir():
        return []
    found = []
    for p in sorted(paths.DATA_DIR.iterdir()):
        if p.is_dir() and any(p.glob("*.parquet")):
            found.append(p.name)
        elif p.suffix == ".parquet":
            found.append(p.stem)
    return found


def dataset_names() -> list[str]:
    """Registry order first (it is curated), then derived, then anything else."""
    names = [n for n in REGISTRY if _raw_exists(n)]
    for n in [d["name"] for d in derived_registry()] + _disk_names() + list(_manifest()):
        if n not in names:
            names.append(n)
    return names


def _raw_exists(name: str) -> bool:
    d = paths.DATA_DIR / name
    return d.is_dir() or (paths.DATA_DIR / f"{name}.parquet").is_file()


def _exists(name: str) -> bool:
    return _raw_exists(name) or derived_path(name).is_file()


def is_seasonal(name: str) -> bool:
    if (paths.DATA_DIR / name).is_dir():
        return True
    if (paths.DATA_DIR / f"{name}.parquet").is_file() or is_derived(name):
        return False
    ds = REGISTRY.get(name)
    return bool(ds and ds.seasonal)


def kind_of(name: str) -> str:
    if is_derived(name):
        return "derived"
    return "seasonal" if is_seasonal(name) else "static"


def note_for(name: str) -> str:
    if is_derived(name):
        return str(_derived_entry(name).get("note") or "")
    ds = REGISTRY.get(name)
    if ds and ds.note:
        return ds.note
    return str(_manifest().get(name, {}).get("note") or "")


def _unknown(name: str) -> DatasetError:
    valid = ", ".join(dataset_names())
    return DatasetError(f'Unknown dataset "{name}". Valid datasets: {valid}')


def dataset_files(name: str, seasons: list[int] | None = None) -> list[Path]:
    """Files backing a dataset, pruned to ``seasons`` when it is partitioned."""
    if not _raw_exists(name):
        p = derived_path(name)
        if p.is_file():
            return [p]
        raise _unknown(name)
    d = paths.DATA_DIR / name
    if not d.is_dir():
        return [paths.DATA_DIR / f"{name}.parquet"]
    files = sorted(d.glob("*.parquet"))
    if seasons is None:
        return files
    want = {int(s) for s in seasons}
    return [f for f in files if _file_season(f) in want]


def _file_season(f: Path) -> int | None:
    m = _SEASON_FILE.search(f.name)
    return int(m.group(1)) if m else None


def file_seasons(name: str) -> list[int]:
    return sorted({s for f in dataset_files(name) if (s := _file_season(f)) is not None})


def scan_log() -> list[dict]:
    return list(_SCAN_LOG)


def reset_scan_log() -> None:
    _SCAN_LOG.clear()


def lazy(dataset: str, seasons: list[int] | None = None) -> pl.LazyFrame:
    """The single entry point to Parquet. Season-pruned, always lazy.

    ``missing_columns="insert"`` / ``extra_columns="ignore"`` are mandatory:
    nflverse adds and drops columns between seasons, so a multi-file scan would
    otherwise raise on schema drift.
    """
    all_files = dataset_files(dataset)
    files = dataset_files(dataset, seasons) if seasons is not None else all_files
    empty = False
    if not files:
        # The requested seasons are not cached. Keep the schema, drop every row,
        # so callers get an empty result instead of an exception.
        files = all_files[-1:]
        empty = True
    if not files:
        raise DatasetError(f'Dataset "{dataset}" has no Parquet files on disk')

    _log_scan(dataset, len(files), seasons)

    if len(files) == 1:
        lf = pl.scan_parquet(files[0])
    elif _has_drift(dataset, files):
        # scan_parquet resolves dtypes against the FIRST file, so it can only
        # widen (Int32 -> Float64), never the reverse. A diagonal concat picks a
        # real supertype per column, which is the only order-independent answer.
        lf = pl.concat([pl.scan_parquet(f) for f in files], how="diagonal_relaxed")
    else:
        lf = pl.scan_parquet(
            files, extra_columns="ignore", missing_columns="insert",
            cast_options=CAST_OPTIONS,
        )
    return lf.filter(pl.lit(False)) if empty else lf


def _log_scan(dataset: str, n_files: int, seasons: list[int] | None) -> None:
    _SCAN_LOG.append(
        {"dataset": dataset, "files": n_files, "seasons": list(seasons) if seasons else None}
    )
    if len(_SCAN_LOG) > _SCAN_LOG_MAX:
        del _SCAN_LOG[:-_SCAN_LOG_MAX]


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


def dtype_kind(dtype: pl.DataType) -> str:
    """Coarse bucket the UI switches on: numeric | string | bool | temporal | other."""
    if dtype == pl.Boolean:
        return "bool"
    if dtype.is_numeric():
        return "numeric"
    if dtype.is_temporal():
        return "temporal"
    if dtype == pl.String or isinstance(dtype, (pl.Categorical, pl.Enum)):
        return "string"
    return "other"


def _sig(files: list[Path]) -> str:
    """Cheap content key: names plus mtimes plus sizes."""
    h = hashlib.sha1()
    for f in files:
        try:
            st = f.stat()
        except OSError:
            continue
        h.update(f"{f.name}:{st.st_mtime_ns}:{st.st_size}|".encode())
    return h.hexdigest()


def _file_dtypes(dataset: str) -> dict[str, dict[str, str]]:
    """Per-file column dtypes, read from Parquet footers and memoized."""
    files = dataset_files(dataset)
    sig = _sig(files)
    with _LOCK:
        hit = _DTYPE_CACHE.get(dataset)
        if hit and hit[0] == sig:
            return hit[1]
    per = {
        f.name: {k: str(v) for k, v in pl.scan_parquet(f).collect_schema().items()}
        for f in files
    }
    with _LOCK:
        _DTYPE_CACHE[dataset] = (sig, per)
    return per


def _has_drift(dataset: str, files: list[Path]) -> bool:
    """True when the selected files disagree about any column's dtype."""
    per = _file_dtypes(dataset)
    seen: dict[str, str] = {}
    for f in files:
        for col, dtype in per.get(f.name, {}).items():
            if seen.setdefault(col, dtype) != dtype:
                return True
    return False


def _schema_file(dataset: str) -> Path:
    """Most recent season file: it carries the widest, most current schema."""
    files = dataset_files(dataset)
    if not files:
        raise DatasetError(f'Dataset "{dataset}" has no Parquet files on disk')
    return files[-1]


def get_schema(dataset: str) -> dict:
    """Column list for a dataset, read from a single file's Parquet metadata."""
    f = _schema_file(dataset)
    sig = _sig([f])
    with _LOCK:
        hit = _SCHEMA_CACHE.get(dataset)
        if hit and hit[0] == sig:
            return hit[1]

    schema = pl.scan_parquet(f).collect_schema()
    columns = [
        {"name": n, "dtype": str(dt), "kind": dtype_kind(dt)} for n, dt in schema.items()
    ]
    man = _manifest().get(dataset, {})
    seasons = file_seasons(dataset) if is_seasonal(dataset) else []
    note = note_for(dataset)
    man_cols = man.get("cols")
    if isinstance(man_cols, int) and man_cols != len(columns):
        # The union across seasons is wider than any single file. Say so rather
        # than pretending the fast path saw every column.
        note = (f"{note} Schema read from {f.name}; the manifest reports "
                f"{man_cols} columns across all seasons.").strip()
    payload = {
        "dataset": dataset,
        "kind": kind_of(dataset),
        "rows": _derived_entry(dataset).get("rows") if is_derived(dataset) else man.get("rows"),
        "cols": len(columns),
        "cols_manifest": man_cols,
        "note": note,
        "seasons": [seasons[0], seasons[-1]] if seasons else None,
        "schema_source": f.name,
        "columns": columns,
    }
    with _LOCK:
        _SCHEMA_CACHE[dataset] = (sig, payload)
    return payload


def column_dtypes(dataset: str) -> dict[str, pl.DataType]:
    """Name -> dtype for the schema file. Used by query.py and profile.py.

    Memoized because every filtered query needs it: re-reading the footer per
    request would double the file opens of a one-season query.
    """
    f = _schema_file(dataset)
    sig = _sig([f])
    with _LOCK:
        hit = _COLTYPE_CACHE.get(dataset)
        if hit and hit[0] == sig:
            return hit[1]
    dtypes = dict(pl.scan_parquet(f).collect_schema())
    with _LOCK:
        _COLTYPE_CACHE[dataset] = (sig, dtypes)
    return dtypes


def column_names(dataset: str) -> list[str]:
    return [c["name"] for c in get_schema(dataset)["columns"]]


# ---------------------------------------------------------------------------
# Derived datasets
# ---------------------------------------------------------------------------


def derived_path(name: str) -> Path:
    return DERIVED_DIR / f"{name}.parquet"


def derived_registry() -> list[dict]:
    """Saved-result registry, with dead entries dropped.

    A derived dataset is only real if its Parquet file is there, so a stale
    entry (file deleted by hand, or a crashed write) is pruned on read.
    """
    global _DERIVED_CACHE
    if not DERIVED_REGISTRY.is_file():
        return []
    mtime = DERIVED_REGISTRY.stat().st_mtime
    if _DERIVED_CACHE[0] == mtime:
        return _DERIVED_CACHE[1]
    try:
        entries = json.loads(DERIVED_REGISTRY.read_text())
    except (OSError, json.JSONDecodeError):
        entries = []
    if not isinstance(entries, list):
        entries = []
    live = [e for e in entries if isinstance(e, dict) and derived_path(str(e.get("name"))).is_file()]
    if len(live) != len(entries):
        write_derived_registry(live)
        mtime = DERIVED_REGISTRY.stat().st_mtime
    _DERIVED_CACHE = (mtime, live)
    return live


def write_derived_registry(entries: list[dict]) -> None:
    """Replace the registry atomically (query.save_derived owns the content)."""
    DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DERIVED_REGISTRY.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(entries, indent=2))
    tmp.replace(DERIVED_REGISTRY)
    global _DERIVED_CACHE
    _DERIVED_CACHE = (DERIVED_REGISTRY.stat().st_mtime, entries)


def _derived_entry(name: str) -> dict:
    for e in derived_registry():
        if e.get("name") == name:
            return e
    return {}


def is_derived(name: str) -> bool:
    return derived_path(name).is_file() and not _raw_exists(name)


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------


def catalog_payload() -> dict:
    """Manifest merged with what is on disk. Disk wins; differences are flagged."""
    man = _manifest()
    cov = _read_coverage_cache()
    names = dataset_names()
    for n in man:
        if n not in names:
            names.append(n)

    out: list[dict] = []
    for name in names:
        if is_derived(name):
            out.append(_derived_row(name))
            continue
        entry = dict(man.get(name) or {})
        row: dict[str, Any] = {
            "name": name,
            "kind": kind_of(name),
            "status": entry.get("status", "ok"),
            "rows": entry.get("rows"),
            "cols": entry.get("cols"),
            "seasons": entry.get("seasons"),
            "files": entry.get("files"),
            "mb": entry.get("mb"),
            "note": note_for(name),
            "stale": False,
        }
        if not _exists(name):
            row["status"] = "missing"
            row["stale"] = True
            out.append(row)
            continue

        files = dataset_files(name)
        disk: dict[str, Any] = {
            "files": len(files),
            "mb": round(sum(f.stat().st_size for f in files) / 1e6, 1),
        }
        seasons = file_seasons(name) if row["kind"] == "seasonal" else []
        disk["seasons"] = [seasons[0], seasons[-1]] if seasons else None
        if cov and name in cov:
            disk["rows"] = cov[name]

        for key, value in disk.items():
            if value is None:
                continue
            # A key the manifest never recorded is not a disagreement.
            if entry.get(key) is not None and entry[key] != value:
                row["stale"] = True
            row[key] = value
        if name not in man:
            row["stale"] = True
        row["status"] = row["status"] or "ok"
        out.append(row)

    totals = {
        "datasets": len(out),
        "rows": sum(r["rows"] or 0 for r in out),
        "mb": round(sum(r["mb"] or 0 for r in out), 1),
    }
    return {"datasets": out, "totals": totals, "data_dir": str(paths.DATA_DIR),
            "derived_dir": str(DERIVED_DIR)}


def _derived_row(name: str) -> dict:
    entry = _derived_entry(name)
    path = derived_path(name)
    mb = round(path.stat().st_size / 1e6, 3)
    return {
        "name": name,
        "kind": "derived",
        "status": "ok",
        "rows": entry.get("rows"),
        "cols": entry.get("cols"),
        "seasons": None,
        "files": 1,
        "mb": mb,
        "note": entry.get("note") or "",
        "source": entry.get("source"),
        "spec": entry.get("spec"),
        "created_at": entry.get("created_at"),
        "stale": not entry,  # on disk but unregistered
    }


# ---------------------------------------------------------------------------
# Coverage
# ---------------------------------------------------------------------------


def _coverage_key() -> str:
    files: list[Path] = []
    for name in dataset_names():
        try:
            files.extend(dataset_files(name))
        except DatasetError:
            continue
    return _sig(sorted(files))


def _cache_file() -> Path:
    return paths.CACHE_DIR / "coverage.json"


def _read_coverage_cache() -> dict[str, int] | None:
    """Row totals from a previously computed coverage payload, if any."""
    f = _cache_file()
    if not f.is_file():
        return None
    try:
        blob = json.loads(f.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return {d["name"]: d["total"] for d in blob.get("payload", {}).get("datasets", [])}


def coverage_payload() -> dict:
    """Rows per season, taken from Parquet footers rather than by reading data."""
    key = _coverage_key()
    f = _cache_file()
    if f.is_file():
        try:
            blob = json.loads(f.read_text())
            if blob.get("key") == key:
                return blob["payload"]
        except (OSError, json.JSONDecodeError, KeyError):
            pass

    datasets = []
    all_seasons: set[int] = set()
    for name in dataset_names():
        try:
            files = dataset_files(name)
        except DatasetError:
            continue
        counts: dict[str, int] = {}
        total = 0
        for path in files:
            try:
                # select(len) on a scan is answered from Parquet metadata.
                n = int(pl.scan_parquet(path).select(pl.len()).collect().item())
            except Exception:
                continue
            total += n
            season = _file_season(path)
            if season is not None:
                counts[str(season)] = counts.get(str(season), 0) + n
                all_seasons.add(season)
        datasets.append(
            {
                "name": name,
                "kind": kind_of(name),
                "counts": counts,
                "total": total,
                "peak": max(counts.values()) if counts else total,
            }
        )

    payload = {"seasons": sorted(all_seasons), "datasets": datasets}
    paths.ensure_cache()
    try:
        f.write_text(json.dumps({"key": key, "payload": payload}))
    except OSError:
        pass  # a read-only cache dir must not break the endpoint
    return payload


# ---------------------------------------------------------------------------
# Entity search
# ---------------------------------------------------------------------------


def _ci_contains(col: str, q: str) -> pl.Expr:
    return pl.col(col).cast(pl.String).str.to_lowercase().str.contains(q, literal=True)


def search_entities(q: str, limit: int = 25) -> dict:
    """Substring lookup over players and teams for the omnibox."""
    q = (q or "").strip().lower()
    limit = max(1, min(int(limit), MAX_SEARCH_LIMIT))
    out: dict[str, list] = {"players": [], "teams": []}
    if not q:
        return out

    # players: display_name / gsis_id / latest_team (there is no "team" column).
    try:
        cols = column_dtypes("players")
        wanted = {"gsis_id": "gsis_id", "display_name": "display_name",
                  "position": "position", "latest_team": "team", "status": "status"}
        present = {src: dst for src, dst in wanted.items() if src in cols}
        searchable = [c for c in ("display_name", "gsis_id", "latest_team") if c in cols]
        if present and searchable:
            pred = _ci_contains(searchable[0], q)
            for c in searchable[1:]:
                pred = pred | _ci_contains(c, q)
            df = (
                lazy("players")
                .filter(pred)
                .select([pl.col(src).cast(pl.String).alias(dst) for src, dst in present.items()])
                .head(limit)
                .collect()
            )
            out["players"] = df.to_dicts()
    except (DatasetError, pl.exceptions.PolarsError):
        pass  # the dataset may simply not be cached yet

    try:
        cols = column_dtypes("teams")
        searchable = [c for c in ("team_abbr", "team_name", "team_nick", "team_id") if c in cols]
        keep = [c for c in ("team_abbr", "team_name", "team_conf", "team_division") if c in cols]
        if searchable and keep:
            pred = _ci_contains(searchable[0], q)
            for c in searchable[1:]:
                pred = pred | _ci_contains(c, q)
            df = lazy("teams").filter(pred).select(keep).head(limit).collect()
            out["teams"] = df.to_dicts()
    except (DatasetError, pl.exceptions.PolarsError):
        pass
    return out
