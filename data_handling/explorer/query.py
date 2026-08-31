"""Filtering, aggregation, SQL, joins and export over the Parquet cache.

Everything here stays lazy until the last possible moment. The two rules that
keep it fast are: push the season filter into the file glob (see
``_split_seasons``) and never collect a frame we are about to slice.
"""

from __future__ import annotations

import datetime as dt
import difflib
import io
import json
import math
import os
import re
import time
from decimal import Decimal
from typing import Any

import polars as pl

from . import catalog
from .catalog import DatasetError

MAX_ROWS_LIMIT = 1000       # contract: /api/rows caps at 1000
MAX_RESULT_LIMIT = 5000     # aggregate / join
MAX_SQL_LIMIT = 50_000      # the SQL console is allowed a bigger result set
EXPORT_CAP = 5_000_000
DERIVED_CAP = 5_000_000
# Row caps alone do not bound memory: pbp is 372 columns wide, so 1.3M rows
# is ~476M values and several GB collected before a byte reaches the client.
# Bound the result by values as well, and say how to narrow it.
CELL_CAP = 50_000_000
DISTINCT_CARDINALITY_LIMIT = 10_000

# Derived dataset names become SQL table names and file names, so keep them tame.
_DERIVED_NAME = re.compile(r"^[a-z][a-z0-9_]{0,48}$")

_OPS = (
    "=", "!=", ">", ">=", "<", "<=", "in", "not_in", "contains", "not_contains",
    "starts_with", "ends_with", "is_null", "not_null", "between",
)
_NO_VALUE_OPS = ("is_null", "not_null")
_STRING_OPS = ("contains", "not_contains", "starts_with", "ends_with")

_AGGS = (
    "count", "count_distinct", "sum", "mean", "median", "min", "max",
    "std", "var", "p25", "p75",
)

_JOIN_HOWS = {"inner": "inner", "left": "left", "outer": "full", "full": "full",
              "semi": "semi", "anti": "anti"}

# Any of these anywhere in a statement means it is not a read.
_WRITE_SQL = re.compile(
    r"\b(insert|update|delete|drop|create|alter|attach|copy|truncate|replace|"
    r"grant|revoke|merge|vacuum|unload|pragma)\b",
    re.IGNORECASE,
)

# nflverse spells the same identifier differently in every table.
_ID_ALIASES: list[set[str]] = [
    {"player_id", "gsis_id", "pfr_player_id", "player_gsis_id", "gsis_it_id",
     "esb_id", "nfl_id", "pfr_id", "smart_id"},
    {"team", "posteam", "defteam", "recent_team", "team_abbr", "club_code",
     "latest_team", "team_code"},
    {"game_id", "old_game_id", "pfr_game_id", "nfl_detail_id"},
    {"player_name", "player_display_name", "display_name", "full_name", "player"},
    {"position", "position_group"},
]
_JOINABLE_EXACT = ("season", "week", "game_id", "team", "player_id", "gsis_id",
                   "season_type", "position")


class QueryError(Exception):
    """Bad query input; the server maps this to HTTP 400."""


# ---------------------------------------------------------------------------
# JSON-safe serialization (one place, used by every tabular return)
# ---------------------------------------------------------------------------


def _json_default(v: Any) -> Any:
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, dt.timedelta):
        return str(v)
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (bytes, bytearray)):
        return v.hex()
    return str(v)


def to_jsonable(v: Any) -> Any:
    """Make one polars cell safe for json.dumps.

    JSON has no NaN, no Infinity and no date type, so those become null or ISO
    strings. Nested values (list/struct) collapse to a compact JSON string
    because the grid renders one cell per value.
    """
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, int) or isinstance(v, str):
        return v
    if isinstance(v, Decimal):
        f = float(v)
        return f if math.isfinite(f) else None
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, dt.timedelta):
        return str(v)
    if isinstance(v, (bytes, bytearray)):
        return v.hex()
    if isinstance(v, (list, tuple, dict)):
        try:
            return json.dumps(v, default=_json_default, separators=(",", ":"))
        except (TypeError, ValueError):
            return repr(v)
    return str(v)


def _rows_json(df: pl.DataFrame) -> list[list]:
    return [[to_jsonable(v) for v in row] for row in df.iter_rows()]


def _payload(df: pl.DataFrame, *, t0: float, offset: int = 0,
             limit: int | None = None, total: int | None = None,
             truncated: bool = False) -> dict:
    return {
        "columns": list(df.columns),
        "dtypes": [str(t) for t in df.dtypes],
        "rows": _rows_json(df),
        "total": total,
        "offset": offset,
        "limit": limit,
        "elapsed_ms": int((time.perf_counter() - t0) * 1000),
        "truncated": truncated,
    }


# ---------------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------------


def _schema(dataset: str) -> dict[str, pl.DataType]:
    return catalog.column_dtypes(dataset)


def _require_column(dataset: str, col: str, schema: dict[str, pl.DataType]) -> pl.DataType:
    if col in schema:
        return schema[col]
    near = difflib.get_close_matches(col, list(schema), n=5, cutoff=0.0)
    hint = f" Closest columns: {', '.join(near)}." if near else ""
    raise QueryError(f'Unknown column "{col}" on {dataset}.{hint}')


def _require_columns(dataset: str, cols: list[str] | None,
                     schema: dict[str, pl.DataType]) -> list[str] | None:
    if not cols:
        return None
    for c in cols:
        _require_column(dataset, c, schema)
    return list(dict.fromkeys(cols))


# ---------------------------------------------------------------------------
# Filter compilation
# ---------------------------------------------------------------------------


def _bad_value(col: str, op: str, value: Any, expected: str) -> QueryError:
    try:
        shown = json.dumps(value, default=str)
    except (TypeError, ValueError):
        shown = repr(value)
    return QueryError(f"Cannot filter {col} {op} {shown}: expected {expected}")


def _coerce(value: Any, dtype: pl.DataType, col: str, op: str) -> Any:
    """Coerce a JSON value to something comparable with ``dtype``."""
    if value is None:
        return None
    if dtype.is_numeric():
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, (int, float)):
            return value
        try:
            text = str(value).strip()
            return int(text) if re.fullmatch(r"[+-]?\d+", text) else float(text)
        except (TypeError, ValueError):
            raise _bad_value(col, op, value, "a number") from None
    if dtype == pl.Boolean:
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in ("true", "1", "yes", "t"):
            return True
        if text in ("false", "0", "no", "f"):
            return False
        raise _bad_value(col, op, value, "true or false")
    if dtype.is_temporal():
        text = str(value).strip().replace("Z", "+00:00")
        for parse in (dt.date.fromisoformat, dt.datetime.fromisoformat, dt.time.fromisoformat):
            try:
                parsed = parse(text)
            except ValueError:
                continue
            if dtype == pl.Date and isinstance(parsed, dt.datetime):
                return parsed.date()
            if isinstance(dtype, pl.Datetime) and isinstance(parsed, dt.date) and not isinstance(parsed, dt.datetime):
                return dt.datetime.combine(parsed, dt.time())
            return parsed
        raise _bad_value(col, op, value, "an ISO date or timestamp")
    return str(value)


def _lit(value: Any, dtype: pl.DataType) -> pl.Expr:
    lit = pl.lit(value)
    return lit.cast(dtype, strict=False) if dtype.is_numeric() else lit


def _filter_expr(f: dict, dataset: str, schema: dict[str, pl.DataType]) -> pl.Expr:
    if not isinstance(f, dict):
        raise QueryError(f"Each filter must be an object, got {type(f).__name__}")
    col = f.get("col") or f.get("column")
    op = (f.get("op") or "=").strip()
    if not col:
        raise QueryError('Filter is missing "col"')
    if op not in _OPS:
        raise QueryError(f'Unknown filter op "{op}". Valid ops: {", ".join(_OPS)}')
    dtype = _require_column(dataset, col, schema)
    c = pl.col(col)

    if op == "is_null":
        return c.is_null()
    if op == "not_null":
        return c.is_not_null()

    if "value" not in f:
        raise QueryError(f'Filter {col} {op} is missing "value"')
    value = f["value"]

    if op in _STRING_OPS:
        text = str(value)
        s = c.cast(pl.String)
        if op in ("contains", "not_contains"):
            # (?i) is polars' inline case-insensitive regex flag; escape so the
            # user's text is never read as a pattern.
            hit = s.str.contains("(?i)" + re.escape(text))
        elif op == "starts_with":
            hit = s.str.to_lowercase().str.starts_with(text.lower())
        else:
            hit = s.str.to_lowercase().str.ends_with(text.lower())
        if op == "not_contains":
            return hit.not_() | c.is_null()
        return hit

    if op in ("in", "not_in"):
        values = value if isinstance(value, (list, tuple)) else [value]
        if not values:
            raise _bad_value(col, op, value, "a non-empty list")
        coerced = [_coerce(v, dtype, col, op) for v in values]
        hit = c.is_in(pl.lit(pl.Series(coerced), dtype=pl.List(dtype)))
        return hit if op == "in" else hit.not_() | c.is_null()

    if op == "between":
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            raise _bad_value(col, op, value, "a two element list [low, high]")
        lo = _coerce(value[0], dtype, col, op)
        hi = _coerce(value[1], dtype, col, op)
        return c.is_between(_lit(lo, dtype), _lit(hi, dtype), closed="both")

    v = _lit(_coerce(value, dtype, col, op), dtype)
    if op == "=":
        return c == v
    if op == "!=":
        return (c != v) | c.is_null()
    if op == ">":
        return c > v
    if op == ">=":
        return c >= v
    if op == "<":
        return c < v
    return c <= v


def _split_seasons(filters: list[dict] | None, dataset: str,
                   schema: dict[str, pl.DataType]) -> list[int] | None:
    """Seasons implied by =/in/between filters on ``season``.

    This is the whole point of the filter pass: the result narrows the file
    glob before any data is read.
    """
    if not filters or not catalog.is_seasonal(dataset) or "season" not in schema:
        return None
    known = set(catalog.file_seasons(dataset))
    if not known:
        return None
    wanted: set[int] | None = None
    for f in filters:
        if not isinstance(f, dict) or (f.get("col") or f.get("column")) != "season":
            continue
        op, value = (f.get("op") or "=").strip(), f.get("value")
        picked: set[int] | None = None
        try:
            if op == "=":
                picked = {int(value)}
            elif op == "in" and isinstance(value, (list, tuple)) and value:
                picked = {int(v) for v in value}
            elif op == "between" and isinstance(value, (list, tuple)) and len(value) == 2:
                lo, hi = int(value[0]), int(value[1])
                picked = {s for s in known if lo <= s <= hi}
        except (TypeError, ValueError):
            picked = None  # let _filter_expr raise the readable error
        if picked is None:
            continue
        wanted = picked if wanted is None else (wanted & picked)
    if wanted is None:
        return None
    return sorted(wanted & known)


def _filtered(dataset: str, filters: list[dict] | None) -> tuple[pl.LazyFrame, dict[str, pl.DataType]]:
    schema = _schema(dataset)
    seasons = _split_seasons(filters, dataset, schema)
    lf = catalog.lazy(dataset, seasons)
    for f in filters or []:
        lf = lf.filter(_filter_expr(f, dataset, schema))
    return lf, schema


def _collect(lf: pl.LazyFrame) -> pl.DataFrame:
    """Collect, translating polars' errors into readable QueryErrors."""
    try:
        return lf.collect()
    except pl.exceptions.PolarsError as exc:
        raise QueryError(str(exc)) from None


# ---------------------------------------------------------------------------
# rows / distinct
# ---------------------------------------------------------------------------


def _rows_lf(dataset: str, *, sort: str | None = None, dir: str = "asc",
             columns: list[str] | None = None, filters: list[dict] | None = None,
             distinct: bool = False) -> pl.LazyFrame:
    lf, schema = _filtered(dataset, filters)
    cols = _require_columns(dataset, columns, schema)
    if cols:
        lf = lf.select(cols)          # projection pushdown
    if distinct:
        lf = lf.unique(maintain_order=False)
    if sort:
        _require_column(dataset, sort, schema)
        if cols and sort not in cols:
            raise QueryError(f'Cannot sort by "{sort}": it is not in the selected columns')
        lf = lf.sort(sort, descending=(str(dir).lower() == "desc"), nulls_last=True)
    return lf


def rows(dataset: str, *, offset: int = 0, limit: int = 100,
         sort: str | None = None, dir: str = "asc",
         columns: list[str] | None = None,
         filters: list[dict] | None = None,
         distinct: bool = False) -> dict:
    """One page of a filtered dataset, plus the post-filter total."""
    t0 = time.perf_counter()
    offset = max(0, int(offset))
    requested = int(limit)
    limit = max(1, min(requested, MAX_ROWS_LIMIT))
    lf = _rows_lf(dataset, sort=sort, dir=dir, columns=columns,
                  filters=filters, distinct=distinct)
    total = int(_collect(lf.select(pl.len())).item())
    df = _collect(lf.slice(offset, limit))
    return _payload(df, t0=t0, offset=offset, limit=limit, total=total,
                    truncated=requested > MAX_ROWS_LIMIT)


def distinct_values(dataset: str, column: str, *, limit: int = 200,
                    q: str | None = None,
                    filters: list[dict] | None = None) -> dict:
    """Value counts for one column: the filter-builder autocomplete."""
    lf, schema = _filtered(dataset, filters)
    _require_column(dataset, column, schema)
    limit = max(1, min(int(limit), DISTINCT_CARDINALITY_LIMIT))
    if q:
        lf = lf.filter(
            pl.col(column).cast(pl.String).str.contains("(?i)" + re.escape(str(q)))
        )
    df = _collect(
        lf.group_by(column)
        .agg(pl.len().alias("count"))
        .sort(["count", column], descending=[True, False], nulls_last=True)
        .head(limit + 1)
    )
    truncated = df.height > limit
    values = [
        {"value": to_jsonable(v), "count": int(n)}
        for v, n in df.head(limit).iter_rows()
    ]
    return {"column": column, "values": values, "truncated": truncated}


# ---------------------------------------------------------------------------
# aggregate
# ---------------------------------------------------------------------------


def _agg_expr(col: str, agg: str, alias: str, dataset: str,
              schema: dict[str, pl.DataType]) -> pl.Expr:
    if agg not in _AGGS:
        raise QueryError(f'Unknown agg "{agg}". Valid aggs: {", ".join(_AGGS)}')
    if col == "*":
        if agg != "count":
            raise QueryError(f'col "*" is only valid with count, not {agg}')
        return pl.len().alias(alias)
    dtype = _require_column(dataset, col, schema)
    c = pl.col(col)
    if agg in ("sum", "mean", "median", "std", "var", "p25", "p75") and not dtype.is_numeric():
        raise QueryError(f'Cannot compute {agg} on "{col}": it is {dtype}, not a number')
    if dtype == pl.Float64 or dtype == pl.Float32:
        c = c.fill_nan(None)  # NaN would poison mean/std and sort weirdly
    table = {
        "count": c.count(),
        "count_distinct": c.n_unique(),
        "sum": c.sum(),
        "mean": c.mean(),
        "median": c.median(),
        "min": c.min(),
        "max": c.max(),
        "std": c.std(),
        "var": c.var(),
        "p25": c.quantile(0.25),
        "p75": c.quantile(0.75),
    }
    return table[agg].alias(alias)


def _aggregate_lf(spec: dict) -> tuple[pl.LazyFrame, str]:
    dataset = spec.get("dataset")
    if not dataset:
        raise QueryError('aggregate needs a "dataset"')
    lf, schema = _filtered(dataset, spec.get("filters"))
    group_by = list(spec.get("group_by") or [])
    for g in group_by:
        _require_column(dataset, g, schema)
    metrics = list(spec.get("metrics") or [])
    if not metrics:
        raise QueryError('aggregate needs at least one entry in "metrics"')

    exprs, aliases = [], []
    for m in metrics:
        if not isinstance(m, dict):
            raise QueryError("Each metric must be an object with col/agg/alias")
        col = str(m.get("col") or "*")
        agg = str(m.get("agg") or "count")
        alias = str(m.get("alias") or ("n" if col == "*" else f"{col}_{agg}"))
        if alias in aliases or alias in group_by:
            raise QueryError(f'Duplicate metric alias "{alias}"')
        exprs.append(_agg_expr(col, agg, alias, dataset, schema))
        aliases.append(alias)

    out = lf.group_by(group_by).agg(exprs) if group_by else lf.select(exprs)

    order = spec.get("order_by") or {}
    if order.get("col"):
        by = str(order["col"])
        if by not in aliases and by not in group_by:
            raise QueryError(f'Cannot order by "{by}": not a group key or metric alias')
        out = out.sort(by, descending=str(order.get("dir", "desc")).lower() == "desc",
                       nulls_last=True)
    elif group_by:
        out = out.sort(group_by, nulls_last=True)
    return out, dataset


def aggregate(spec: dict) -> dict:
    """Group-by with the metric list the chart builder sends."""
    t0 = time.perf_counter()
    lf, _ = _aggregate_lf(spec)
    limit = max(1, min(int(spec.get("limit") or 500), MAX_RESULT_LIMIT))
    df = _collect(lf.head(limit + 1))
    truncated = df.height > limit
    df = df.head(limit)
    return _payload(df, t0=t0, offset=0, limit=limit, total=df.height,
                    truncated=truncated)


# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------


def _sql_context(sql: str) -> pl.SQLContext:
    """Register only the datasets the statement mentions: scanning all 25 to
    answer a one-table query costs more than the query itself."""
    names = catalog.dataset_names()
    lowered = sql.lower()
    mentioned = [n for n in names if re.search(rf"\b{re.escape(n)}\b", lowered)]
    frames = {n: catalog.lazy(n) for n in (mentioned or names)}
    return pl.SQLContext(frames=frames)


def _sql_lf(sql: str) -> pl.LazyFrame:
    text = (sql or "").strip().rstrip(";").strip()
    if not text:
        raise QueryError("Empty SQL statement")
    if ";" in text:
        raise QueryError("Only one statement per request")
    if _WRITE_SQL.search(text):
        raise QueryError("Only read-only statements are allowed (no insert/update/"
                         "delete/drop/create/alter/attach/copy/truncate)")
    ctx = _sql_context(text)
    try:
        return ctx.execute(text, eager=False)
    except Exception as exc:
        # polars' parser message is the useful part; pass it through verbatim.
        raise QueryError(str(exc)) from None


def run_sql(sql: str, limit: int = 500) -> dict:
    """Read-only SQL over every dataset, always bounded by a limit."""
    t0 = time.perf_counter()
    limit = max(1, min(int(limit or 500), MAX_SQL_LIMIT))
    lf = _sql_lf(sql)
    df = _collect(lf.head(limit + 1))
    truncated = df.height > limit
    df = df.head(limit)
    return _payload(df, t0=t0, offset=0, limit=limit, total=df.height,
                    truncated=truncated)


# ---------------------------------------------------------------------------
# join
# ---------------------------------------------------------------------------


def _side(spec: dict, label: str) -> tuple[pl.LazyFrame, str, dict[str, pl.DataType], list[str] | None]:
    if not isinstance(spec, dict) or not spec.get("dataset"):
        raise QueryError(f'join needs "{label}.dataset"')
    dataset = spec["dataset"]
    lf, schema = _filtered(dataset, spec.get("filters"))
    cols = _require_columns(dataset, spec.get("columns"), schema)
    return lf, dataset, schema, cols


def _join_lf(spec: dict) -> pl.LazyFrame:
    left_lf, left_name, left_schema, left_cols = _side(spec.get("left") or {}, "left")
    right_lf, right_name, right_schema, right_cols = _side(spec.get("right") or {}, "right")

    pairs = spec.get("on") or []
    if not pairs:
        raise QueryError('join needs "on": a list of [left_column, right_column] pairs')
    left_on, right_on = [], []
    for pair in pairs:
        if isinstance(pair, str):
            pair = [pair, pair]
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise QueryError('Each "on" entry must be [left_column, right_column]')
        _require_column(left_name, pair[0], left_schema)
        _require_column(right_name, pair[1], right_schema)
        left_on.append(pair[0])
        right_on.append(pair[1])

    how = str(spec.get("how") or "inner").lower()
    if how not in _JOIN_HOWS:
        raise QueryError(f'Unknown join type "{how}". Valid: inner, left, outer, semi, anti')

    # Projection must keep the keys or the join cannot run.
    if left_cols:
        left_lf = left_lf.select(list(dict.fromkeys(left_cols + left_on)))
    if right_cols:
        right_lf = right_lf.select(list(dict.fromkeys(right_cols + right_on)))

    return left_lf.join(right_lf, left_on=left_on, right_on=right_on,
                        how=_JOIN_HOWS[how], suffix=f"_{right_name}")


def join(spec: dict) -> dict:
    """Join two datasets on explicit column pairs."""
    t0 = time.perf_counter()
    limit = max(1, min(int(spec.get("limit") or 500), MAX_RESULT_LIMIT))
    lf = _join_lf(spec)
    df = _collect(lf.head(limit + 1))
    truncated = df.height > limit
    df = df.head(limit)
    return _payload(df, t0=t0, offset=0, limit=limit, total=df.height,
                    truncated=truncated)


def join_suggest(left: str, right: str) -> dict:
    """Shared column names, plus cross-named nflverse ids that mean the same."""
    left_cols = catalog.column_names(left)
    right_cols = catalog.column_names(right)
    lset, rset = set(left_cols), set(right_cols)

    shared = lset & rset
    exact = [c for c in _JOINABLE_EXACT if c in shared]
    exact += sorted(c for c in shared if c not in exact and (
        c.endswith("_id") or c in ("season", "week")))

    likely: list[list[str]] = []
    for group in _ID_ALIASES:
        for a in sorted(group & lset):
            for b in sorted(group & rset):
                if a != b and [a, b] not in likely:
                    likely.append([a, b])
    return {"exact": exact, "likely": likely}


# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------


_CONTENT_TYPES = {
    "csv": "text/csv; charset=utf-8",
    "parquet": "application/vnd.apache.parquet",
    "json": "application/json",
}


def _source_lf(spec: dict) -> tuple[pl.LazyFrame, str]:
    """The one place a request dict becomes a LazyFrame.

    Shared by export_bytes and save_derived so the two can never drift apart.
    """
    source = str(spec.get("source") or "rows").lower()
    if source == "rows":
        dataset = spec.get("dataset")
        if not dataset:
            raise QueryError('source "rows" needs a "dataset"')
        lf = _rows_lf(dataset, sort=spec.get("sort"), dir=spec.get("dir", "asc"),
                      columns=spec.get("columns"), filters=spec.get("filters"),
                      distinct=bool(spec.get("distinct")))
        return lf, str(dataset)
    if source == "aggregate":
        lf, dataset = _aggregate_lf(spec)
        return lf, f"{dataset}_agg"
    if source == "sql":
        return _sql_lf(str(spec.get("sql") or "")), "sql"
    if source == "join":
        left = (spec.get("left") or {}).get("dataset", "left")
        right = (spec.get("right") or {}).get("dataset", "right")
        return _join_lf(spec), f"{left}_{right}"
    raise QueryError(f'Unknown source "{source}". Valid: rows, sql, aggregate, join')


def _materialize(spec: dict, cap: int = EXPORT_CAP) -> tuple[pl.DataFrame, bool, str]:
    """Collect a source spec. ``limit: null`` means the whole filtered result.

    One extra row is requested so we can tell "exactly at the cap" from
    "truncated at the cap".
    """
    lf, default_name = _source_lf(spec)
    raw_limit = spec.get("limit", None)
    cap = cap if raw_limit is None else max(1, min(int(raw_limit), cap))

    ncols = len(lf.collect_schema().names())
    if ncols * cap > CELL_CAP:
        # Only worth counting rows when the width alone makes an overrun possible.
        nrows = min(cap, int(_collect(lf.select(pl.len())).item()))
        if ncols * nrows > CELL_CAP:
            raise QueryError(
                f"That result is {nrows:,} rows x {ncols:,} columns "
                f"({ncols * nrows / 1e6:.0f}M values), over the "
                f"{CELL_CAP // 1_000_000}M limit. Narrow it with a season filter, "
                f"or choose fewer columns: at this width the ceiling is "
                f"{CELL_CAP // ncols:,} rows."
            )
    df = _collect(lf.head(cap + 1))
    return df.head(cap), df.height > cap, default_name


def _safe_name(name: str, ext: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._") or "export"
    if not name.endswith(f".{ext}"):
        name = f"{name.rsplit('.', 1)[0] if '.' in name else name}.{ext}"
    return name


def export_bytes(spec: dict) -> tuple[bytes, str, str, bool]:
    """Materialize a result to bytes. The one place a big collect is allowed.

    ``limit: null`` means the full filtered result, capped at EXPORT_CAP rows.
    """
    fmt = str(spec.get("format") or "csv").lower()
    if fmt not in _CONTENT_TYPES:
        raise QueryError(f'Unknown export format "{fmt}". Valid: csv, parquet, json')
    df, truncated, default_name = _materialize(spec)

    stamp = time.strftime("%Y%m%d_%H%M%S")
    filename = _safe_name(str(spec.get("filename") or f"{default_name}_{stamp}"), fmt)

    buf = io.BytesIO()
    if fmt == "csv":
        # Nested columns have no CSV form; render them the way the grid does.
        nested = [c for c, t in zip(df.columns, df.dtypes)
                  if catalog.dtype_kind(t) == "other"]
        if nested:
            # polars cannot cast List(Struct) to String, so reuse the same JSON
            # rendering the grid sees.
            df = df.with_columns([
                pl.Series(c, [to_jsonable(v) for v in df[c].to_list()], dtype=pl.String)
                for c in nested
            ])
        df.write_csv(buf)
    elif fmt == "parquet":
        df.write_parquet(buf, compression="zstd")
    else:
        records = [dict(zip(df.columns, row)) for row in _rows_json(df)]
        buf.write(json.dumps(records, separators=(",", ":")).encode("utf-8"))
    return buf.getvalue(), filename, _CONTENT_TYPES[fmt], truncated


# ---------------------------------------------------------------------------
# Derived datasets
# ---------------------------------------------------------------------------


def _check_derived_name(name: str) -> str:
    name = str(name or "").strip()
    if not _DERIVED_NAME.match(name):
        raise QueryError(
            f'Invalid dataset name "{name}": use lowercase letters, digits and '
            "underscores, starting with a letter, up to 49 characters"
        )
    return name


def save_derived(spec: dict) -> dict:
    """Persist a rows/sql/aggregate/join result as a first-class dataset."""
    name = _check_derived_name(spec.get("name"))
    if name in catalog.REGISTRY or (name in catalog.dataset_names()
                                    and not catalog.is_derived(name)):
        raise QueryError(f'"{name}" is a raw nflverse dataset; choose another name')
    if catalog.is_derived(name) and not spec.get("overwrite"):
        raise QueryError(f'Derived dataset "{name}" already exists; pass '
                         '"overwrite": true to replace it')

    stored = {k: v for k, v in spec.items() if k not in ("name", "note", "overwrite")}
    try:
        json.dumps(stored)
    except (TypeError, ValueError) as exc:
        raise QueryError(f"Spec is not JSON serializable: {exc}") from None

    df, truncated, _ = _materialize(spec, DERIVED_CAP)

    catalog.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    path = catalog.derived_path(name)
    tmp = path.with_name(f".{name}.{os.getpid()}.tmp")
    try:
        df.write_parquet(tmp, compression="zstd")
        os.replace(tmp, path)  # atomic: no half-written dataset is ever visible
    except Exception:
        tmp.unlink(missing_ok=True)
        raise

    entry = {
        "name": name,
        "created_at": dt.datetime.now().isoformat(timespec="seconds"),
        "note": str(spec.get("note") or ""),
        "source": str(spec.get("source") or "rows").lower(),
        "spec": stored,
        "rows": df.height,
        "cols": df.width,
        "mb": round(path.stat().st_size / 1e6, 3),
        "columns": list(df.columns),
    }
    entries = [e for e in catalog.derived_registry() if e.get("name") != name]
    entries.append(entry)
    catalog.write_derived_registry(entries)

    return {"name": name, "rows": entry["rows"], "cols": entry["cols"],
            "mb": entry["mb"], "columns": entry["columns"], "path": str(path),
            "truncated": truncated}


def delete_derived(name: str) -> dict:
    """Remove a derived dataset and its registry entry."""
    name = _check_derived_name(name)
    path = catalog.derived_path(name)
    known = any(e.get("name") == name for e in catalog.derived_registry())
    if not path.is_file() and not known:
        raise QueryError(f'Unknown derived dataset "{name}"')
    path.unlink(missing_ok=True)
    catalog.write_derived_registry(
        [e for e in catalog.derived_registry() if e.get("name") != name]
    )
    return {"name": name, "deleted": True}
