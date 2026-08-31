"""Route handlers: parsed params in, plain dicts out.

Nothing in here knows about HTTP. ``server.py`` does the sockets, headers and
status codes; this module does validation and delegation to the data layer.
Keeping the split means every handler is directly unit-testable without a
socket, and the server has exactly one place to translate errors into statuses.

Every user-supplied value is coerced and range-checked here so the data layer
can assume clean input: a bad param must produce a readable 400, never a
traceback out of polars.
"""

from __future__ import annotations

import json
import re
import threading
from typing import Any, Callable

from . import catalog, profile, query, views

# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------


class BadRequest(Exception):
    """Invalid input from the client. Always surfaced as HTTP 400."""


# Exceptions the server should render as 400 rather than 500. Imported from the
# data layer so there is a single list to keep in sync.
CLIENT_ERRORS: tuple[type[BaseException], ...] = (
    BadRequest,
    catalog.DatasetError,
    query.QueryError,
)

# --------------------------------------------------------------------------
# Vocabulary fixed by the contract
# --------------------------------------------------------------------------

FILTER_OPS = {
    "=", "!=", ">", ">=", "<", "<=", "in", "not_in", "contains", "not_contains",
    "starts_with", "ends_with", "is_null", "not_null", "between",
}
# Ops that carry no value at all.
NULLARY_OPS = {"is_null", "not_null"}
# Ops whose value must be a list.
LIST_OPS = {"in", "not_in", "between"}

AGGS = {"count", "count_distinct", "sum", "mean", "median", "min", "max",
        "std", "var", "p25", "p75"}
JOIN_HOWS = {"inner", "left", "outer", "semi", "anti"}
EXPORT_SOURCES = {"rows", "sql", "aggregate", "join"}
EXPORT_FORMATS = {"csv", "parquet", "json"}
SORT_DIRS = {"asc", "desc"}

MAX_ROW_LIMIT = 1000
MAX_PROFILE_COLUMNS = 60
MAX_EXPORT_ROWS = 5_000_000

# Statement keywords that would mutate anything. Read-only console only.
_WRITE_KEYWORDS = ("insert", "update", "delete", "drop", "create", "alter",
                   "attach", "copy", "truncate")
_WRITE_RE = re.compile(r"\b(" + "|".join(_WRITE_KEYWORDS) + r")\b", re.IGNORECASE)
# Strip quoted literals before the keyword scan so a play description containing
# the word "drop" does not get the query rejected.
_LITERAL_RE = re.compile(r"'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"")

_FILENAME_BAD = re.compile(r"[^A-Za-z0-9._-]+")

# Derived dataset names become SQL table names and file names, so the charset
# is deliberately narrow.
DERIVED_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,48}$")

# Derived writes touch a shared registry sidecar, so they are serialised. Reads
# never take this lock: a slow save must not stall the grid or the catalog.
_DERIVE_WRITE_LOCK = threading.Lock()


# --------------------------------------------------------------------------
# Param coercion helpers
# --------------------------------------------------------------------------


def _get(params: dict, key: str) -> Any:
    v = params.get(key)
    if isinstance(v, str) and v.strip() == "":
        return None
    return v


def want_str(params: dict, key: str, *, required: bool = False,
             default: str | None = None) -> str | None:
    v = _get(params, key)
    if v is None:
        if required:
            raise BadRequest(f"missing required parameter: {key}")
        return default
    if not isinstance(v, str):
        v = str(v)
    return v.strip()


def want_int(params: dict, key: str, *, default: int | None = None,
             lo: int | None = None, hi: int | None = None,
             required: bool = False) -> int | None:
    v = _get(params, key)
    if v is None:
        if required:
            raise BadRequest(f"missing required parameter: {key}")
        return default
    if isinstance(v, bool):
        raise BadRequest(f"{key} must be an integer, got a boolean")
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise BadRequest(f"{key} must be an integer, got {v!r}") from None
    if lo is not None and n < lo:
        raise BadRequest(f"{key} must be >= {lo}, got {n}")
    if hi is not None and n > hi:
        raise BadRequest(f"{key} must be <= {hi}, got {n}")
    return n


def want_bool(params: dict, key: str, *, default: bool = False) -> bool:
    v = _get(params, key)
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off"):
        return False
    raise BadRequest(f"{key} must be true or false, got {v!r}")


def want_list(params: dict, key: str) -> list[str] | None:
    """Accept either a real JSON list or the csv form the query string uses."""
    v = _get(params, key)
    if v is None:
        return None
    if isinstance(v, list):
        return [str(x) for x in v]
    items = [s.strip() for s in str(v).split(",")]
    items = [s for s in items if s]
    return items or None


def want_filters(params: dict, key: str = "filters") -> list[dict] | None:
    """Filters arrive as a JSON string on GET and as a real list on POST."""
    raw = _get(params, key)
    if raw is None:
        return None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError as exc:
            raise BadRequest(f"filters is not valid JSON: {exc}") from None
    if raw in ([], {}, None):
        return None
    if not isinstance(raw, list):
        raise BadRequest("filters must be a JSON list of filter objects")
    return [_check_filter(i, f) for i, f in enumerate(raw)]


def _check_filter(i: int, f: Any) -> dict:
    where = f"filters[{i}]"
    if not isinstance(f, dict):
        raise BadRequest(f"{where} must be an object, got {type(f).__name__}")
    col = f.get("col")
    op = f.get("op")
    if not isinstance(col, str) or not col.strip():
        raise BadRequest(f"{where}.col must be a non-empty column name")
    if not isinstance(op, str) or op not in FILTER_OPS:
        raise BadRequest(
            f"{where}.op {op!r} is not supported. Valid ops: "
            + ", ".join(sorted(FILTER_OPS))
        )
    if op in NULLARY_OPS:
        return {"col": col.strip(), "op": op}
    if "value" not in f:
        raise BadRequest(f"{where} needs a value for op {op!r}")
    value = f["value"]
    if op in LIST_OPS:
        if not isinstance(value, (list, tuple)):
            raise BadRequest(f"{where}.value must be a list for op {op!r}")
        value = list(value)
        if op == "between" and len(value) != 2:
            raise BadRequest(f"{where}.value must be exactly two items for 'between'")
        if not value:
            raise BadRequest(f"{where}.value must not be empty for op {op!r}")
    return {"col": col.strip(), "op": op, "value": value}


def _require_dict(value: Any, label: str) -> dict:
    if not isinstance(value, dict):
        raise BadRequest(f"{label} must be an object")
    return value


def safe_filename(name: str | None, fallback: str) -> str:
    """Header-safe filename: no separators, no quotes, no CR/LF injection."""
    base = (name or "").strip() or fallback
    base = base.replace("\\", "/").split("/")[-1]
    base = _FILENAME_BAD.sub("_", base).strip("._-") or fallback
    return base[:120]


# --------------------------------------------------------------------------
# GET handlers
# --------------------------------------------------------------------------


def get_catalog(params: dict) -> dict:
    return catalog.catalog_payload()


def get_schema(params: dict) -> dict:
    dataset = want_str(params, "dataset", required=True)
    return catalog.get_schema(dataset)


def get_profile(params: dict) -> dict:
    dataset = want_str(params, "dataset", required=True)
    columns = want_list(params, "columns")
    if columns and len(columns) > MAX_PROFILE_COLUMNS:
        raise BadRequest(
            f"at most {MAX_PROFILE_COLUMNS} columns per profile request, got {len(columns)}"
        )
    season = want_int(params, "season", lo=1900, hi=2200)
    return profile.profile(dataset, columns, season)


def get_rows(params: dict) -> dict:
    dataset = want_str(params, "dataset", required=True)
    sort = want_str(params, "sort")
    direction = (want_str(params, "dir", default="asc") or "asc").lower()
    if direction not in SORT_DIRS:
        raise BadRequest(f"dir must be asc or desc, got {direction!r}")
    return query.rows(
        dataset,
        offset=want_int(params, "offset", default=0, lo=0),
        limit=want_int(params, "limit", default=100, lo=1, hi=MAX_ROW_LIMIT),
        sort=sort,
        dir=direction,
        columns=want_list(params, "columns"),
        filters=want_filters(params),
        distinct=want_bool(params, "distinct"),
    )


def get_distinct(params: dict) -> dict:
    dataset = want_str(params, "dataset", required=True)
    column = want_str(params, "column", required=True)
    return query.distinct_values(
        dataset,
        column,
        limit=want_int(params, "limit", default=200, lo=1, hi=5000),
        q=want_str(params, "q"),
        filters=want_filters(params),
    )


def get_coverage(params: dict) -> dict:
    return catalog.coverage_payload()


def get_search(params: dict) -> dict:
    q = want_str(params, "q", required=True)
    if len(q) < 2:
        raise BadRequest("q must be at least 2 characters")
    return catalog.search_entities(q, want_int(params, "limit", default=25, lo=1, hi=200))


def get_join_suggest(params: dict) -> dict:
    return query.join_suggest(
        want_str(params, "left", required=True),
        want_str(params, "right", required=True),
    )


# --------------------------------------------------------------------------
# POST handlers
# --------------------------------------------------------------------------


def build_aggregate_spec(body: dict) -> dict:
    """Validate an aggregate request into the spec query.aggregate expects.

    Kept separate from the handler so /api/export can reuse the exact same
    validation without going through the query layer twice.
    """
    body = _require_dict(body, "request body")
    dataset = want_str(body, "dataset", required=True)

    group_by = want_list(body, "group_by") or []
    raw_metrics = body.get("metrics")
    if not isinstance(raw_metrics, list) or not raw_metrics:
        raise BadRequest("metrics must be a non-empty list")

    metrics: list[dict] = []
    for i, m in enumerate(raw_metrics):
        m = _require_dict(m, f"metrics[{i}]")
        agg = str(m.get("agg", "")).strip().lower()
        if agg not in AGGS:
            raise BadRequest(
                f"metrics[{i}].agg {agg!r} is not supported. Valid aggs: "
                + ", ".join(sorted(AGGS))
            )
        col = m.get("col")
        if not isinstance(col, str) or not col.strip():
            raise BadRequest(f"metrics[{i}].col must be a column name (or '*' for count)")
        col = col.strip()
        if col == "*" and agg != "count":
            raise BadRequest(f"metrics[{i}]: '*' is only valid with agg 'count'")
        alias = m.get("alias") or (f"{agg}_rows" if col == "*" else f"{col}_{agg}")
        metrics.append({"col": col, "agg": agg, "alias": str(alias)})

    order_by = body.get("order_by")
    if order_by is not None:
        order_by = _require_dict(order_by, "order_by")
        oc = order_by.get("col")
        if not isinstance(oc, str) or not oc.strip():
            raise BadRequest("order_by.col must be a column or metric alias")
        od = str(order_by.get("dir", "desc")).lower()
        if od not in SORT_DIRS:
            raise BadRequest(f"order_by.dir must be asc or desc, got {od!r}")
        order_by = {"col": oc.strip(), "dir": od}

    return {
        "dataset": dataset,
        "filters": want_filters(body),
        "group_by": group_by,
        "metrics": metrics,
        "order_by": order_by,
        "limit": want_int(body, "limit", default=100, lo=1, hi=5000),
    }


def post_aggregate(body: dict) -> dict:
    return query.aggregate(build_aggregate_spec(body))


def check_sql(sql: str) -> str:
    """Reject anything that is not a read. Local tool, but a typo should not
    be able to rewrite the Parquet cache."""
    stripped = _LITERAL_RE.sub("''", sql)
    hit = _WRITE_RE.search(stripped)
    if hit:
        raise BadRequest(
            f"only read-only queries are allowed here ({hit.group(1).lower()} is blocked)"
        )
    return sql


def post_sql(body: dict) -> dict:
    body = _require_dict(body, "request body")
    sql = want_str(body, "sql", required=True)
    if not sql:
        raise BadRequest("sql must not be empty")
    check_sql(sql)
    return query.run_sql(sql, want_int(body, "limit", default=500, lo=1, hi=50000))


def _join_side(spec: Any, label: str) -> dict:
    spec = _require_dict(spec, label)
    return {
        "dataset": want_str(spec, "dataset", required=True),
        "columns": want_list(spec, "columns"),
        "filters": want_filters(spec),
    }


def _join_keys(raw: Any) -> list[list[str]]:
    if not isinstance(raw, list) or not raw:
        raise BadRequest("on must be a non-empty list of key pairs")
    pairs: list[list[str]] = []
    for i, item in enumerate(raw):
        # A bare string means the same column name on both sides.
        if isinstance(item, str):
            if not item.strip():
                raise BadRequest(f"on[{i}] must be a non-empty column name")
            pairs.append([item.strip(), item.strip()])
            continue
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise BadRequest(f"on[{i}] must be a [left_col, right_col] pair")
        lo, ro = item
        if not isinstance(lo, str) or not isinstance(ro, str) or not lo.strip() or not ro.strip():
            raise BadRequest(f"on[{i}] must be a pair of column names")
        pairs.append([lo.strip(), ro.strip()])
    return pairs


def post_join(body: dict) -> dict:
    body = _require_dict(body, "request body")
    how = str(body.get("how", "inner")).strip().lower()
    if how not in JOIN_HOWS:
        raise BadRequest(
            f"how {how!r} is not supported. Valid: " + ", ".join(sorted(JOIN_HOWS))
        )
    return query.join({
        "left": _join_side(body.get("left"), "left"),
        "right": _join_side(body.get("right"), "right"),
        "on": _join_keys(body.get("on")),
        "how": how,
        "limit": want_int(body, "limit", default=500, lo=1, hi=5000),
    })


def build_source_spec(body: dict) -> tuple[dict, str]:
    """Validate the source half of an export or derive request.

    /api/export and /api/derive take the same "where do the rows come from"
    block, so the validation lives once here and each route wraps it with its
    own output options.
    """
    body = _require_dict(body, "request body")
    source = str(body.get("source", "rows")).strip().lower()
    if source not in EXPORT_SOURCES:
        raise BadRequest(
            f"source {source!r} is not supported. Valid: " + ", ".join(sorted(EXPORT_SOURCES))
        )

    spec: dict[str, Any] = {"source": source}

    if source == "rows":
        spec["dataset"] = want_str(body, "dataset", required=True)
        spec["columns"] = want_list(body, "columns")
        spec["filters"] = want_filters(body)
        spec["sort"] = want_str(body, "sort")
        direction = (want_str(body, "dir", default="asc") or "asc").lower()
        if direction not in SORT_DIRS:
            raise BadRequest(f"dir must be asc or desc, got {direction!r}")
        spec["dir"] = direction
        spec["distinct"] = want_bool(body, "distinct")
        default_name = spec["dataset"]
    elif source == "sql":
        sql = want_str(body, "sql", required=True)
        check_sql(sql)
        spec["sql"] = sql
        default_name = "query"
    elif source == "aggregate":
        agg_body = dict(body)
        agg_body.pop("limit", None)        # the caller owns the output limit
        validated = build_aggregate_spec(agg_body)
        spec.update(validated)
        spec["source"] = "aggregate"
        default_name = f"{validated['dataset']}_agg"
    else:  # join
        how = str(body.get("how", "inner")).strip().lower()
        if how not in JOIN_HOWS:
            raise BadRequest(
                f"how {how!r} is not supported. Valid: " + ", ".join(sorted(JOIN_HOWS))
            )
        spec["left"] = _join_side(body.get("left"), "left")
        spec["right"] = _join_side(body.get("right"), "right")
        spec["on"] = _join_keys(body.get("on"))
        spec["how"] = how
        default_name = f"{spec['left']['dataset']}_x_{spec['right']['dataset']}"

    return spec, default_name


def want_row_cap(body: dict) -> int | None:
    """A nullable limit: null means the whole filtered result, capped hard."""
    limit = body.get("limit", None)
    if limit is None:
        return None
    return want_int({"limit": limit}, "limit", lo=1, hi=MAX_EXPORT_ROWS)


def post_export(body: dict) -> tuple[bytes, str, str, bool]:
    """The one endpoint that does not return a dict: raw file bytes."""
    body = _require_dict(body, "request body")
    fmt = str(body.get("format", "csv")).strip().lower()
    if fmt not in EXPORT_FORMATS:
        raise BadRequest(
            f"format {fmt!r} is not supported. Valid: " + ", ".join(sorted(EXPORT_FORMATS))
        )
    spec, default_name = build_source_spec(body)
    spec["format"] = fmt
    spec["limit"] = want_row_cap(body)

    # Only forward a filename the client actually asked for: with none, the
    # data layer picks a timestamped default, which is the nicer behaviour.
    if body.get("filename"):
        spec["filename"] = safe_filename(body.get("filename"), f"{default_name}.{fmt}")
    fallback = safe_filename(None, f"{default_name}.{fmt}")
    result = query.export_bytes(spec)
    if not (isinstance(result, tuple) and len(result) == 4):
        raise RuntimeError("query.export_bytes must return (bytes, filename, content_type, truncated)")
    payload, filename, content_type, truncated = result
    return payload, safe_filename(filename, fallback), content_type, bool(truncated)


# --------------------------------------------------------------------------
# Saved views
# --------------------------------------------------------------------------


def get_views(params: dict) -> dict:
    return views.list_views()


def post_views(body: dict) -> dict:
    body = _require_dict(body, "request body")
    name = want_str(body, "name", required=True)
    if not name:
        raise BadRequest("name must not be empty")
    kind = (want_str(body, "kind", default="rows") or "rows").lower()
    if kind not in views.VALID_KINDS:
        raise BadRequest(
            f"kind {kind!r} is not supported. Valid: " + ", ".join(views.VALID_KINDS)
        )
    payload = body.get("payload")
    if payload is None:
        raise BadRequest("payload is required (whatever state the tab needs to restore)")
    return views.save_view(name, kind, payload, want_str(body, "id"))


def delete_views(params: dict) -> dict:
    view_id = want_str(params, "id", required=True)
    result = views.delete_view(view_id)
    if not result["found"]:
        raise BadRequest(f"no saved view with id {view_id!r}")
    return result


# --------------------------------------------------------------------------
# Derived datasets
# --------------------------------------------------------------------------


def _raw_dataset_names() -> set[str]:
    """Names shipped by ingest.py. A derived dataset may not shadow one, or the
    sidebar and the SQL context would have two tables with the same name."""
    try:
        import ingest
        return set(ingest.REGISTRY)
    except Exception:
        return set()


def check_derived_name(name: str | None, *, overwrite: bool = False) -> str:
    if not name:
        raise BadRequest("name is required")
    name = name.strip()
    if not DERIVED_NAME_RE.match(name):
        raise BadRequest(
            f"name {name!r} is invalid. Use lowercase letters, digits and "
            "underscores, starting with a letter, 1 to 49 characters."
        )
    if name in _raw_dataset_names():
        raise BadRequest(
            f"{name!r} is the name of a raw nflverse dataset. Pick another name."
        )
    if not overwrite:
        existing = {d.get("name") for d in catalog.derived_registry()}
        if name in existing:
            raise BadRequest(
                f"a derived dataset named {name!r} already exists. "
                'Resend with "overwrite": true to replace it.'
            )
    return name


def get_derive(params: dict) -> dict:
    return {"datasets": catalog.derived_registry()}


def post_derive(body: dict) -> dict:
    body = _require_dict(body, "request body")
    overwrite = want_bool(body, "overwrite")
    name = check_derived_name(want_str(body, "name"), overwrite=overwrite)

    note = want_str(body, "note", default="") or ""
    if len(note) > 500:
        raise BadRequest("note must be 500 characters or fewer")

    spec, _default = build_source_spec(body)
    spec["name"] = name
    spec["note"] = note
    spec["overwrite"] = overwrite
    spec["limit"] = want_row_cap(body)

    # Serialised: two concurrent saves would race on _registry.json. The write
    # itself is atomic in the data layer, so a crash cannot leave a partial file.
    with _DERIVE_WRITE_LOCK:
        return query.save_derived(spec)


def delete_derive(params: dict) -> dict:
    name = want_str(params, "name", required=True)
    if not DERIVED_NAME_RE.match(name):
        raise BadRequest(f"name {name!r} is not a valid derived dataset name")
    if not catalog.is_derived(name):
        raise BadRequest(f"no derived dataset named {name!r}")
    with _DERIVE_WRITE_LOCK:
        return query.delete_derived(name)


# --------------------------------------------------------------------------
# Route table consumed by server.py
# --------------------------------------------------------------------------

# (method, path) -> (handler, is_download)
ROUTES: dict[tuple[str, str], tuple[Callable[[dict], Any], bool]] = {
    ("GET", "/api/catalog"): (get_catalog, False),
    ("GET", "/api/schema"): (get_schema, False),
    ("GET", "/api/profile"): (get_profile, False),
    ("GET", "/api/rows"): (get_rows, False),
    ("GET", "/api/distinct"): (get_distinct, False),
    ("GET", "/api/coverage"): (get_coverage, False),
    ("GET", "/api/search"): (get_search, False),
    ("GET", "/api/join/suggest"): (get_join_suggest, False),
    ("GET", "/api/views"): (get_views, False),
    ("GET", "/api/derive"): (get_derive, False),
    ("POST", "/api/aggregate"): (post_aggregate, False),
    ("POST", "/api/sql"): (post_sql, False),
    ("POST", "/api/join"): (post_join, False),
    ("POST", "/api/export"): (post_export, True),
    ("POST", "/api/views"): (post_views, False),
    ("POST", "/api/derive"): (post_derive, False),
    ("DELETE", "/api/views"): (delete_views, False),
    ("DELETE", "/api/derive"): (delete_derive, False),
}

API_PATHS = {path for _, path in ROUTES}
