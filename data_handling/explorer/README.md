# NFL Data Explorer

A local web tool for browsing, filtering, joining, charting and exporting the
nflverse Parquet cache in `data_handling/data/`. No model, no predictions: this
exists to make 410 MB across 25 datasets and 356 files actually reachable.

## Run it

```bash
venv/bin/python explore.py
```

Opens `http://127.0.0.1:8777`. Flags: `--port`, `--host`, `--no-browser`,
`--warm` (pre-build schema and coverage caches at boot). If the port is taken it
scans the next 20 and prints the one it actually used.

Binds to `127.0.0.1` only. Nothing is exposed off the machine.

## Dependencies

None beyond what `ingest.py` already needs. The backend is Python stdlib
`http.server` plus `polars`; the frontend is vanilla JS with no build step, no
npm, and no CDN. If `ingest.py` runs, this runs.

## Tabs

- **Browse** - paged grid over any dataset. Click-to-sort, a filter chip builder
  with value autocomplete, and a column picker. Wide tables open on a curated
  subset (pbp shows 25 of 372 columns) and say so.
- **Schema** - every column with dtype, null rate, cardinality, quartiles,
  histograms and top values. Leads with the columns that are too null to trust.
- **SQL** - polars SQL over every dataset, registered under its own name.
  History, worked examples, click-to-insert table and column names.
- **Chart** - group-by/metric builder rendering hand-rolled SVG. Six presets.
- **Coverage** - season heatmap. The point is the ragged left edges: where each
  dataset's usable history actually starts. Click a cell to jump into that
  season's rows.

## Derived datasets

Any result (rows, SQL, aggregate, join) can be saved to
`data_handling/data/derived/<name>.parquet` via "Save as dataset". It then
appears in the sidebar, is queryable by name in the SQL console, is joinable,
and can itself be the source of another derived dataset.

Each one stores the spec that produced it, so the UI can show how it was built
and load it back into the builder. Derived data is gitignored because it is
regenerable from that spec.

## Performance notes

Everything scans lazily and pushes filters down. The load-bearing property is
**season pruning**: a `season = 2024` filter on pbp opens 1 Parquet file out of
27, so it returns in about 15 ms rather than scanning 320 MB. Filtering on
`season` first is the difference between instant and sluggish.

Schema reads touch one season file's metadata. Coverage and column profiles are
disk-cached in `explorer/cache/`, keyed on source file mtimes, so they rebuild
only when the data changes.

## Limits

- Grid pages cap at 1000 rows; SQL at 50,000.
- Exports and derived datasets cap at 5M rows **and** 50M values. A full-width
  pbp export (1.28M rows x 372 columns, 476M values) is refused with a message
  telling you the row ceiling at that width, because it would otherwise
  materialize several GB in memory before sending a byte.
- `get_schema` reads only the newest season file, so a column that existed only
  in older seasons is not filterable. The note says so when the manifest column
  count disagrees.
- `!=`, `not_in` and `not_contains` keep nulls, unlike SQL. In a filter UI
  "not KC" should include unattributed rows, so `in` and `not_in` partition a
  dataset exactly.

## Layout

```
explorer/
  paths.py      path resolution, independent of CWD
  catalog.py    dataset discovery, schemas, coverage, entity search
  query.py      filters, rows, aggregate, SQL, joins, export, derived datasets
  profile.py    per-column statistics with disk caching
  api.py        route handlers
  server.py     stdlib HTTP server, static serving, CLI
  views.py      saved views
  static/       index.html, css/app.css, js/*.js
  CONTRACT.md   the API and interface spec the implementation was built against
```
