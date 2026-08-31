"""Per-column statistics for the schema browser.

The expensive part of profiling is touching the data, so we touch it at most
twice: one pass for the scalar statistics, one pass for histograms and top
values (which need the min/max and cardinality the first pass produced).
Results are cached on disk keyed by the source files' mtimes and sizes.
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any

import polars as pl

from . import catalog, paths
from .catalog import DatasetError
from .query import QueryError, to_jsonable

MAX_COLUMNS = 60          # contract: capped at 60 per request
HIST_BINS = 40
TOP_VALUES = 15
HUGE_UNIQUE = 50_000      # above this, sample instead of a full value_counts
SAMPLE_ROWS = 200_000

_SCALAR_KINDS = ("numeric", "string", "bool", "temporal")


def _cache_dir():
    d = paths.CACHE_DIR / "profile"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cache_key(dataset: str, cols: list[str], season: int | None,
               files: list) -> str:
    h = hashlib.sha1()
    h.update(f"{dataset}|{season}|{','.join(sorted(cols))}|".encode())
    for f in files:
        try:
            st = f.stat()
        except OSError:
            continue
        h.update(f"{f.name}:{st.st_mtime_ns}:{st.st_size}|".encode())
    return h.hexdigest()[:24]


def _edges(lo: float, hi: float) -> list[float]:
    width = (hi - lo) / HIST_BINS
    edges = [lo + i * width for i in range(HIST_BINS + 1)]
    edges[-1] = hi  # float accumulation must not push the last edge past max
    return edges


def profile(dataset: str, columns: list[str] | None = None,
            season: int | None = None) -> dict:
    """Null rates, cardinality, distributions and top values for a dataset."""
    t0 = time.perf_counter()
    schema = catalog.column_dtypes(dataset)
    if columns:
        missing = [c for c in columns if c not in schema]
        if missing:
            raise QueryError(
                f'Unknown column(s) on {dataset}: {", ".join(missing)}'
            )
        cols = list(dict.fromkeys(columns))
    else:
        cols = list(schema)
    truncated = len(cols) > MAX_COLUMNS
    cols = cols[:MAX_COLUMNS]
    if not cols:
        raise QueryError(f"No columns to profile on {dataset}")

    season = int(season) if season is not None else None
    seasons = [season] if (season is not None and catalog.is_seasonal(dataset)) else None
    files = catalog.dataset_files(dataset, seasons) or catalog.dataset_files(dataset)
    key = _cache_key(dataset, cols, season, files)
    cache_file = _cache_dir() / f"{dataset}_{key}.json"
    if cache_file.is_file():
        try:
            payload = json.loads(cache_file.read_text())
            payload["cached"] = True
            payload["elapsed_ms"] = int((time.perf_counter() - t0) * 1000)
            return payload
        except (OSError, json.JSONDecodeError):
            pass

    lf = catalog.lazy(dataset, seasons)
    if season is not None and "season" in schema:
        lf = lf.filter(pl.col("season") == season)
    lf = lf.select(cols)

    kinds = {c: catalog.dtype_kind(schema[c]) for c in cols}
    stats = _pass_one(lf, cols, kinds, schema)
    n_rows = int(stats["__n"])

    out: list[dict] = []
    hist_plan: dict[str, list[float]] = {}
    top_plan: list[str] = []
    sampled_plan: list[str] = []

    for i, c in enumerate(cols):
        kind = kinds[c]
        nulls = int(stats.get(f"c{i}_null") or 0)
        col: dict[str, Any] = {
            "name": c,
            "dtype": str(schema[c]),
            "kind": kind,
            "null_pct": round(100.0 * nulls / n_rows, 2) if n_rows else None,
            "n_unique": _int_or_none(stats.get(f"c{i}_uniq")),
            "histogram": None,
            "top_values": None,
        }
        if kind == "numeric":
            for stat in ("min", "max", "mean", "std", "p25", "p50", "p75"):
                col[stat] = _float_or_none(stats.get(f"c{i}_{stat}"))
            lo, hi = col["min"], col["max"]
            if lo is not None and hi is not None and hi > lo and nulls < n_rows:
                hist_plan[c] = _edges(float(lo), float(hi))
        elif kind == "temporal":
            col["min"] = to_jsonable(stats.get(f"c{i}_min"))
            col["max"] = to_jsonable(stats.get(f"c{i}_max"))
        if kind in ("string", "bool", "temporal") and nulls < n_rows:
            uniq = col["n_unique"] or 0
            if uniq > HUGE_UNIQUE:
                sampled_plan.append(c)
                col["top_values_sampled"] = True
                col["note"] = (
                    f"{uniq:,} distinct values: top values are from the first "
                    f"{SAMPLE_ROWS:,} rows, not the whole column."
                )
            else:
                top_plan.append(c)
        out.append(col)

    by_name = {c["name"]: c for c in out}
    if n_rows:
        for name, values in _pass_two(lf, hist_plan, top_plan).items():
            by_name[name].update(values)
        if sampled_plan:
            sample = lf.head(SAMPLE_ROWS)
            for name, values in _pass_two(sample, {}, sampled_plan).items():
                by_name[name].update(values)

    payload = {
        "dataset": dataset,
        "season": season,
        "n_rows": n_rows,
        "columns": out,
        "truncated": truncated,
        "cached": False,
        "elapsed_ms": int((time.perf_counter() - t0) * 1000),
    }
    try:
        cache_file.write_text(json.dumps(payload))
    except OSError:
        pass  # an unwritable cache must not fail the request
    return payload


def _pass_one(lf: pl.LazyFrame, cols: list[str], kinds: dict[str, str],
              schema: dict[str, pl.DataType]) -> dict:
    """Every scalar statistic for every column in a single collect."""
    exprs: list[pl.Expr] = [pl.len().alias("__n")]
    for i, c in enumerate(cols):
        kind = kinds[c]
        exprs.append(pl.col(c).null_count().alias(f"c{i}_null"))
        if kind in _SCALAR_KINDS:
            exprs.append(pl.col(c).n_unique().alias(f"c{i}_uniq"))
        if kind == "numeric":
            # NaN is not null but poisons mean/std, so drop it for the stats.
            x = pl.col(c).fill_nan(None) if schema[c].is_float() else pl.col(c)
            exprs += [
                x.min().alias(f"c{i}_min"), x.max().alias(f"c{i}_max"),
                x.mean().alias(f"c{i}_mean"), x.std().alias(f"c{i}_std"),
                x.quantile(0.25).alias(f"c{i}_p25"),
                x.quantile(0.50).alias(f"c{i}_p50"),
                x.quantile(0.75).alias(f"c{i}_p75"),
            ]
        elif kind == "temporal":
            exprs += [pl.col(c).min().alias(f"c{i}_min"),
                      pl.col(c).max().alias(f"c{i}_max")]
    try:
        return lf.select(exprs).collect().to_dicts()[0]
    except pl.exceptions.PolarsError as exc:
        raise QueryError(str(exc)) from None


def _pass_two(lf: pl.LazyFrame, hist_plan: dict[str, list[float]],
              top_plan: list[str]) -> dict[str, dict]:
    """Histograms and top values in a single collect.

    Both results are imploded to one row each so columns of different lengths
    can share the same select.
    """
    if not hist_plan and not top_plan:
        return {}
    exprs: list[pl.Expr] = []
    for c, edges in hist_plan.items():
        exprs.append(
            pl.col(c).cast(pl.Float64).fill_nan(None)
            .hist(bins=edges).implode().alias(f"h_{c}")
        )
    for c in top_plan:
        exprs.append(
            pl.col(c).value_counts(sort=True, name="__count__")
            .slice(0, TOP_VALUES).implode().alias(f"t_{c}")
        )
    try:
        row = lf.select(exprs).collect().to_dicts()[0]
    except pl.exceptions.PolarsError as exc:
        raise QueryError(str(exc)) from None

    out: dict[str, dict] = {}
    for c, edges in hist_plan.items():
        counts = [int(n) for n in (row.get(f"h_{c}") or [])]
        out.setdefault(c, {})["histogram"] = {
            "edges": [float(e) for e in edges], "counts": counts,
        }
    for c in top_plan:
        items = row.get(f"t_{c}") or []
        out.setdefault(c, {})["top_values"] = [
            {"value": to_jsonable(d.get(c)), "count": int(d.get("__count__") or 0)}
            for d in items
        ]
    return out


def _int_or_none(v: Any) -> int | None:
    return int(v) if v is not None else None


def _float_or_none(v: Any) -> float | None:
    v = to_jsonable(v)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)
