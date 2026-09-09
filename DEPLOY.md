# Deploying for free

The site runs as one FastAPI process on Render's free web service. It keeps
nothing on disk that it cannot recreate, so the host can sleep, rebuild, or
move it and nothing is lost. Everything that accumulates lives in git or on a
GitHub Release, where the commit history is the audit trail.

## The moving parts

| piece | where it runs | when | what it does |
|---|---|---|---|
| `lines.yml` | GitHub Actions | 4x/day (~6am, noon, 6pm, 11pm ET) | `scripts/pull_lines.sh`, commits `data/odds/` |
| `stats.yml` | GitHub Actions | Tuesday 6am ET | refreshes the current season in the parquet cache, rebuilds `data/derived/`, uploads the cache to the `data-cache` Release, commits `data/derived/` |
| `scripts/build.sh` | Render, on deploy | code or derived-table pushes | `pip install`, `scripts/fetch_cache.py` pulls the cache from the Release |
| `data_handling/sync_odds.py` | inside the app | on wake, every 30 min | pulls new `data/odds/` files from GitHub, so lines commits never need a rebuild |
| `webauth/` | inside the app | every request | the password |

Snapshots commit four times a day but do not redeploy: `render.yaml` ignores
`data/odds/**`, and the app syncs them itself. Builds happen only for code
and for the weekly derived tables, which keeps well inside the free tier's
build minutes.

## First-time setup, in order

1. **Push the dashboard**, then point the two seams at it: `PULL_CMD` in
   `scripts/pull_lines.sh` and `DERIVE_CMD` in `scripts/refresh_stats.sh`.
   Until then both scripts exit cleanly doing nothing, so the workflows stay
   green on the placeholder.
2. **Seed the cache.** Actions tab, `stats`, Run workflow, tick `full`. It
   ingests 1999 to now (expect 20 to 40 minutes), uploads one tar per dataset
   to a Release tagged `data-cache`, and commits `data/derived/`.
3. **Secrets in GitHub**: `ODDS_API_KEY` if the dashboard's Odds API provider
   is used. The ESPN provider needs none.
4. **Render**: New, Blueprint, pick the repo. It reads `render.yaml`. When
   prompted, set `SITE_PASSWORD`. Set `GH_TOKEN` (a fine-grained token with
   read access to contents and releases) only if the repo is private;
   `fetch_cache.py` and `sync_odds.py` both read it.
5. **Start command**: once the dashboard is in, change `startCommand` in
   `render.yaml` from the placeholder to `uvicorn dashboard.api.app:app
   --host 0.0.0.0 --port $PORT`, and add `sync_odds.install(app)` next to the
   password lines in `dashboard/api/app.py`. That is the whole migration.

## What free costs you

- **Sleep.** After about fifteen idle minutes Render stops the process. The
  next visitor waits roughly thirty seconds while it starts and syncs odds.
- **Memory.** 512 MB. Fine for polars scans with a column select; not fine
  for `pl.read_parquet` on the whole play-by-play table. The 45-second team
  tendency rebuild runs in Actions, never on Render.
- **Schedule jitter.** Actions cron runs a few minutes late routinely and can
  skip a slot under load. The pull times are approximate.
- **Cache size.** The Release holds one tar per dataset, each under GitHub's
  2 GB per-asset limit. Every deploy downloads the lot, which is a minute or
  two of build time.

## Running it locally

    pip install -e ".[dev,web]"
    python scripts/fetch_cache.py            # or run ingest.py yourself
    SITE_PASSWORD=x ODDS_REPO=henrykanaskie/nfl_predictor \
      uvicorn webauth.mock_app:app --port 8017
