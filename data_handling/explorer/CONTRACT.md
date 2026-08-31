# NFL Data Explorer, build contract

A **local, zero-new-dependency** web tool for browsing / filtering / joining /
charting / exporting the Parquet cache in `data_handling/data/`.
**No prediction model. No ML. Data access only.**

## Hard constraints

- Runtime: the existing venv only. Installed: `polars`, `nflreadpy`, `requests`,
  `pydantic`, `tqdm`. **Do NOT add any dependency** (no fastapi, flask, pandas,
  duckdb, plotly, jinja2). Backend = Python stdlib `http.server` + `polars`.
  Frontend = vanilla HTML/CSS/JS, no CDN, no npm, no build step.
- Python 3.12. `from __future__ import annotations` at the top of each module.
- Everything reads Parquet **lazily** (`pl.scan_parquet`) and pushes
  filters/projections down. Never `read_parquet` a whole dataset (`pbp` is 1.28M
  rows x 372 cols / 320 MB, a full materialize must be impossible by design).
- Reuse existing code: `data_handling/ingest.py` exports `DATA_DIR`, `MANIFEST`,
  `REGISTRY`, `DATASETS`, `scan(name) -> pl.LazyFrame`. Import them; do not
  reimplement or edit `ingest.py`.
- Multi-file datasets need `extra_columns="ignore", missing_columns="insert"`
  (schemas drift across seasons), `scan()` already does this.
- Paths must resolve relative to the repo, not the CWD.

## Layout / file ownership (do not touch files you do not own)

```
data_handling/explorer/
  __init__.py
  paths.py        # (pre-written, shared) repo/data/cache path resolution
  catalog.py      # AGENT A
  query.py        # AGENT A
  profile.py      # AGENT A
  api.py          # AGENT B, route handlers, pure dict/bytes returns
  server.py       # AGENT B, stdlib http.server, static serving, CLI
  views.py        # AGENT B, saved views persistence
  static/
    index.html    # AGENT C
    css/app.css   # AGENT C  (owns ALL css; D adds none)
    js/api.js     # (pre-written, shared) fetch helpers, read only
    js/app.js     # AGENT C  shell, tab router, catalog sidebar, toasts
    js/grid.js    # AGENT C  data grid, filter builder, paging, export UI
    js/schema.js  # AGENT D  column profiler / schema browser tab
    js/sql.js     # AGENT D  SQL console tab
    js/chart.js   # AGENT D  zero-dep SVG charts + chart builder tab
    js/coverage.js# AGENT D  season coverage heatmap tab
explore.py        # AGENT B, repo-root launcher: `python explore.py`
```

## Backend API (all JSON unless noted; prefix `/api`)

Errors: any handler may return `{"error": "<message>"}` with HTTP 400/500.

### `GET /api/catalog`
```json
{"datasets":[{"name":"pbp","kind":"seasonal","status":"ok","rows":1279628,
  "cols":372,"seasons":[1999,2025],"files":27,"mb":320.0,"note":"..."}],
 "totals":{"datasets":25,"rows":0,"mb":0.0},"data_dir":"..."}
```
Merges `manifest.json` with what is actually on disk (disk wins if they disagree;
mark `"stale": true` when they differ).

### `GET /api/schema?dataset=pbp`
```json
{"dataset":"pbp","kind":"seasonal","rows":1279628,"note":"...",
 "seasons":[1999,2025],
 "columns":[{"name":"epa","dtype":"Float64","kind":"numeric"}]}
```
`kind` ∈ `numeric | string | bool | temporal | other`. Schema-only, must be fast
(read one file's metadata for a seasonal dataset). Cache in memory.

### `GET /api/profile?dataset=pbp&columns=epa,wp&season=2024`
Per-column stats. `columns` optional (default: all, capped at 60 per request).
```json
{"dataset":"pbp","n_rows":49492,"elapsed_ms":812,
 "columns":[{"name":"epa","dtype":"Float64","kind":"numeric","null_pct":2.4,
   "n_unique":40122,"min":-13.0,"max":9.2,"mean":0.001,"std":1.55,
   "p25":-0.6,"p50":-0.03,"p75":0.68,
   "histogram":{"edges":[...41 floats...],"counts":[...40 ints...]},
   "top_values":null},
  {"name":"posteam","kind":"string","null_pct":4.1,"n_unique":32,
   "top_values":[{"value":"KC","count":3312}],"histogram":null}]}
```
Disk-cache results under the cache dir keyed by (dataset, column set, season,
source-file mtimes). Cache invalidation on mtime change is required.

### `GET /api/rows`
Query params: `dataset` (required), `offset` (default 0), `limit` (default 100,
max 1000), `sort` (column), `dir` (`asc|desc`), `columns` (csv, optional),
`filters` (URL-encoded JSON, see below), `distinct` (`true|false`).
```json
{"columns":["game_id","epa"],"dtypes":["String","Float64"],
 "rows":[["2024_01_KC_BAL",0.42]],
 "total":49492,"offset":0,"limit":100,"elapsed_ms":140,"truncated":false}
```
`total` = row count **after** filters. Values are JSON-safe: dates/datetimes →
ISO strings, NaN/±Inf → `null`, Decimal → float, lists/structs → JSON string.

### Filter JSON (shared by `/api/rows`, `/api/aggregate`, `/api/export`)
```json
[{"col":"season","op":"=","value":2024},
 {"col":"posteam","op":"in","value":["KC","BUF"]},
 {"col":"epa","op":">","value":0.5},
 {"col":"desc","op":"contains","value":"touchdown"},
 {"col":"wind","op":"is_null"},
 {"col":"week","op":"between","value":[1,9]}]
```
Ops: `= != > >= < <= in not_in contains not_contains starts_with ends_with
is_null not_null between`. Combined with AND. `contains`/`starts_with`/
`ends_with` are case-insensitive. Unknown column or op → 400 with a clear
message. Values are coerced to the column's dtype; a bad coercion → 400, never
a stack trace.

**Season pushdown:** for seasonal datasets, an `=`/`in`/`between` filter on
`season` MUST narrow the globbed file list before scanning (a 2024-only pbp
query should touch 1 file, not 27).

### `GET /api/distinct?dataset=&column=&limit=200&q=&filters=`
```json
{"column":"posteam","values":[{"value":"KC","count":3312}],"truncated":false}
```
Powers filter-value autocomplete. `q` = case-insensitive substring prefilter.

### `POST /api/aggregate`
```json
{"dataset":"pbp","filters":[...],"group_by":["posteam"],
 "metrics":[{"col":"epa","agg":"mean","alias":"epa_mean"},
            {"col":"*","agg":"count","alias":"n"}],
 "order_by":{"col":"epa_mean","dir":"desc"},"limit":50}
```
Aggs: `count count_distinct sum mean median min max std var p25 p75`.
Returns the same row payload shape as `/api/rows`. Powers the chart builder.

### `POST /api/sql`
```json
{"sql":"select posteam, avg(epa) from pbp where season=2024 group by 1",
 "limit":500}
```
Register every dataset as a lazy table under its own name via `pl.SQLContext`.
Return the row payload shape, plus `"elapsed_ms"`. Reject non-read statements
(`insert|update|delete|drop|create|alter|attach|copy|truncate`) with a 400.
Always wrap with a limit. On polars error return `{"error": "<polars message>"}`
with 400, the message is the useful part, pass it through verbatim.

### `POST /api/join`
```json
{"left":{"dataset":"player_stats_week","filters":[...],"columns":[...]},
 "right":{"dataset":"snap_counts","filters":[...],"columns":[...]},
 "on":[["player_id","pfr_player_id"],["season","season"]],
 "how":"inner","limit":500}
```
`how` ∈ `inner left outer semi anti`. Returns the row payload shape. Also expose
`GET /api/join/suggest?left=&right=` returning shared/likely key columns:
```json
{"exact":["season","week"],"likely":[["player_id","gsis_id"]]}
```
(Likely-key heuristic: known nflverse id aliases, `player_id`/`gsis_id`/
`pfr_player_id`/`player_gsis_id`, `team`/`posteam`/`recent_team`/`team_abbr`,
`game_id`, `season`, `week`.)

### `GET /api/coverage`
```json
{"seasons":[1999,...,2026],
 "datasets":[{"name":"pbp","counts":{"1999":42000},"total":1279628,
              "peak":49492}]}
```
Row counts per season from Parquet metadata (cheap). Disk-cached with mtimes.

### `GET /api/search?q=mahomes&limit=25`
Entity lookup across `players` / `teams` (and `draft_picks` for names).
```json
{"players":[{"gsis_id":"00-0033873","display_name":"Patrick Mahomes",
  "position":"QB","team":"KC","status":"ACT"}],
 "teams":[{"team_abbr":"KC","team_name":"Kansas City Chiefs"}]}
```

### `POST /api/export`
Body: `{"source":"rows"|"sql"|"aggregate"|"join", "format":"csv"|"parquet"|
"json", "filename":"...", ...source-specific fields..., "limit":<int|null>}`
Streams the file with `Content-Disposition: attachment`. `limit: null` means
the full filtered result (this is the one place a large materialize is allowed;
cap at 5,000,000 rows and set `X-Export-Truncated: true` if hit).

### Saved views, `GET/POST /api/views`, `DELETE /api/views?id=`
Persist to `data_handling/explorer/cache/views.json`.
```json
{"id":"v_1","name":"KC 2024 pass plays","kind":"rows|sql|aggregate|join",
 "created_at":"2026-08-31T12:00:00","payload":{...whatever the tab needs...}}
```

## Row payload contract (every tabular endpoint)
```json
{"columns":[...],"dtypes":[...],"rows":[[...]],"total":<int|null>,
 "offset":<int>,"limit":<int>,"elapsed_ms":<int>,"truncated":<bool>}
```

## Frontend contract

- Single page, tab bar: **Browse · Schema · SQL · Chart · Coverage**.
  Left sidebar = dataset catalog (search box, row/size/season badges, notes),
  shared across tabs; clicking a dataset sets the global active dataset.
- `js/api.js` is pre-written and shared. Use `API.get/post/postDownload` and
  `Store` (global state + subscribe) from it. Do not redefine them.
- Each tab module registers itself: `window.Tabs.register({id, label, mount(el),
  onDatasetChange(name)})`. `app.js` owns the tab bar and calls these.
- Design: dense, analytical, light/dark via `prefers-color-scheme`. Tabular
  numerals for all numbers. Null renders as a muted `·`, never blank or "None".
  Match the restrained editorial style already in `data_handling/profile.py`
  (paper/ink palette, thin rules, no gradients, no emoji, no chart junk).
- Charts are hand-rolled inline SVG: bar, line, scatter, histogram. Axes with
  real ticks, hover tooltip, respects the theme. No chart libraries.
- Keyboard: `/` focuses dataset search, `g`/`s`/`q`/`c`/`v` jump to tabs,
  `Esc` closes overlays. Show a `?` shortcut overlay.
- Every long request shows a loading state and elapsed ms; every error surfaces
  the backend message in a toast, never a silent failure.
- Grid: sticky header, click-to-sort, column show/hide, resizable-ish widths,
  a filter chip row with autocomplete from `/api/distinct`, page controls, and
  Copy / Export CSV / Export Parquet buttons.

## Python interface between Agent A (data layer) and Agent B (server)

`api.py` calls **only** these. Signatures are fixed; both agents build to them.

```python
# explorer/catalog.py
class DatasetError(Exception): ...          # -> HTTP 400
def catalog_payload() -> dict: ...                       # GET /api/catalog
def get_schema(dataset: str) -> dict: ...                # GET /api/schema
def coverage_payload() -> dict: ...                      # GET /api/coverage
def search_entities(q: str, limit: int = 25) -> dict: ...# GET /api/search
def dataset_names() -> list[str]: ...
def lazy(dataset: str, seasons: list[int] | None = None) -> "pl.LazyFrame": ...
    # season-pruned lazy scan; the single entry point to Parquet for query.py

# explorer/query.py
class QueryError(Exception): ...            # -> HTTP 400
def rows(dataset: str, *, offset: int = 0, limit: int = 100,
         sort: str | None = None, dir: str = "asc",
         columns: list[str] | None = None,
         filters: list[dict] | None = None,
         distinct: bool = False) -> dict: ...
def distinct_values(dataset: str, column: str, *, limit: int = 200,
                    q: str | None = None,
                    filters: list[dict] | None = None) -> dict: ...
def aggregate(spec: dict) -> dict: ...
def run_sql(sql: str, limit: int = 500) -> dict: ...
def join(spec: dict) -> dict: ...
def join_suggest(left: str, right: str) -> dict: ...
def export_bytes(spec: dict) -> tuple[bytes, str, str, bool]:
    """-> (payload, filename, content_type, truncated)"""

# explorer/profile.py
def profile(dataset: str, columns: list[str] | None = None,
            season: int | None = None) -> dict: ...      # GET /api/profile
```

`DatasetError` / `QueryError` → HTTP 400 with `{"error": str(exc)}`.
Anything else → HTTP 500 with the exception message plus a server-side
traceback on stderr.

## index.html script order (Agent C writes this; Agent D relies on it)

```html
<script src="/static/js/api.js"></script>
<script src="/static/js/chart.js"></script>
<script src="/static/js/grid.js"></script>
<script src="/static/js/schema.js"></script>
<script src="/static/js/sql.js"></script>
<script src="/static/js/coverage.js"></script>
<script src="/static/js/app.js"></script>   <!-- boots last -->
```

`chart.js` must expose `window.Chart = {bar, line, scatter, histogram}` (each
returns an `<svg>` element) **before** other tabs load. `grid.js` must expose
`window.Grid = { create(opts) -> {el, load(), setDataset(name), destroy()} }`
so `sql.js` / `chart.js` can render result tables with the same component.

---

# ADDENDUM 1, derived datasets (added after dispatch; user-approved scope)

Any result the user builds (rows / sql / aggregate / join) can be **saved back to
disk as a first-class dataset**, so it appears in the sidebar, is queryable in
the SQL console, is joinable, and can itself be the source of another derived
dataset. This is what makes the tool an organizing tool rather than a viewer.

Storage:
- Parquet at `data_handling/data/derived/<name>.parquet` (zstd, matching
  `ingest.py`).
- Registry sidecar at `data_handling/data/derived/_registry.json`, a list of:
```json
{"name":"kc_2024_pass","created_at":"2026-08-31T23:10:00","note":"...",
 "source":"rows","spec":{...the exact request that produced it...},
 "rows":1284,"cols":12,"mb":0.4,"columns":["..."]}
```
  The `spec` is kept so a derived dataset is reproducible and self-documenting:
  the UI must show "how this was built".

Rules:
- Name must match `^[a-z][a-z0-9_]{0,48}$` and must not collide with a raw
  dataset name in `REGISTRY` (400 with a clear message if it does). Colliding
  with an existing derived name requires `"overwrite": true`.
- Row cap 5,000,000, same as export; set `"truncated": true` in the response if
  hit.
- Writes are atomic: write to a temp file in the same directory, then
  `os.replace`. A failed write must never leave a half-written Parquet or a
  registry entry pointing at a missing file. On load, drop registry entries
  whose file is gone.
- Derived datasets are ignored by git (`**/data/*`), which is intended: they are
  regenerable from their spec.

## Agent A additions (`catalog.py`, `query.py`)
```python
# catalog.py
DERIVED_DIR = paths.PKG_DIR / "data" / "derived"
def derived_registry() -> list[dict]: ...
def is_derived(name: str) -> bool: ...
```
- `lazy(dataset)` resolves derived names too (single file, no season pruning).
- `catalog_payload()` lists them with `"kind": "derived"` plus `note`, `source`,
  `spec`, `created_at`.
- `get_schema()` works on them unchanged.
- `dataset_names()` includes them, so `run_sql()` registers them as SQL tables
  automatically and `join`/`join_suggest` accept them.

```python
# query.py
def save_derived(spec: dict) -> dict: ...
    """spec: {name, note, source: rows|sql|aggregate|join, overwrite: bool,
    limit: int|null, ...source-specific fields...}
    -> {name, rows, cols, mb, columns, path, truncated}"""
def delete_derived(name: str) -> dict: ...
```
`save_derived` reuses the exact same source-dispatch as `export_bytes`; factor
that dispatch into one shared helper rather than duplicating it.

## Agent B additions (`api.py`, `server.py`)
- `POST /api/derive` -> `query.save_derived(body)`
- `DELETE /api/derive?name=` -> `query.delete_derived(name)`
- `GET /api/derive` -> `{"datasets": catalog.derived_registry()}`
Validation errors -> 400 with a readable message.

## Agent C additions (`grid.js`, `app.js`)
- A "Save as dataset" action in the grid toolbar, next to Export. Opens a small
  prompt for name + note, shows whether it will save the current page or the
  full filtered result, posts to `/api/derive`, then refreshes the catalog so
  the new dataset appears in the sidebar immediately.
- Sidebar gets a third group, "Derived", above Seasonal and Static, with a
  delete affordance (confirm first) and the `note` shown as the subtitle.
- Selecting a derived dataset shows its provenance somewhere visible: the source
  kind and a readable rendering of its `spec`, plus a "load this back into the
  builder" action that restores the originating filters / SQL / aggregate.

## Agent D additions (`sql.js`, `chart.js`)
- The same "Save as dataset" action on SQL results (`source: "sql"`) and on
  chart/aggregate results (`source: "aggregate"`), sharing Agent C's flow if it
  is exposed as `window.SaveDataset(spec)`; otherwise implement a minimal local
  version posting the same payload.
- The SQL table-reference panel must list derived tables in their own section,
  since they are queryable by name like any other table.
