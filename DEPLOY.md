# Deploying for free

The site runs as one FastAPI process on Render's free web service. It keeps
nothing on disk that it cannot recreate, so the host can sleep, rebuild, or
move it and nothing is lost. Everything that accumulates lives in git or on a
GitHub Release, where the commit history is the audit trail.

## The moving parts

| piece | where it runs | when | what it does |
|---|---|---|---|
| `lines.yml` | GitHub Actions | 4x/day (~6am, noon, 6pm, 11pm ET) | fetches the three tables the puller needs, runs `dashboard.odds.pull`, commits `data/odds/` |
| `stats.yml` | GitHub Actions | Tuesday 6am ET | refreshes the current season in the parquet cache, rebuilds `data/derived/`, uploads the cache to the `data-cache` Release, commits `data/derived/` |
| `scripts/build.sh` | Render, on deploy | code or derived-table pushes | `pip install`, `scripts/fetch_cache.py` pulls the cache from the Release, `npm run build` for the SPA |
| `data_handling/sync_odds.py` | inside the app | on wake, every 30 min | pulls new `data/odds/` files from GitHub, so lines commits never need a rebuild |
| `webauth/` | inside the app | every request | the password |

Snapshots commit four times a day but do not redeploy: `render.yaml` ignores
`data/odds/**`, and the app syncs them itself. Builds happen only for code
and for the weekly derived tables, which keeps well inside the free tier's
build minutes.

## First-time setup, in order

1. **Seed the cache.** Actions tab, `stats`, Run workflow, tick `full`. It
   ingests 1999 to now (expect 20 to 40 minutes), uploads one tar per dataset
   to a Release tagged `data-cache`, and commits `data/derived/`.
2. **The Odds API key is optional and not for the schedule.** The free tier
   is 500 credits a month and one default pull is about 115, so the scheduled
   job pulls ESPN only. Set `ODDS_API_KEY` in Render's environment to enable
   the Settings page button, which shows the credit cost before spending.
   Only if you pay for a bigger tier: add `ODDS_API_KEY` and
   `ODDS_API_SCHEDULED=1` as GitHub secrets/variables too.
3. **Render**: New, Blueprint, pick the repo. It reads `render.yaml`. When
   prompted, set `SITE_PASSWORD`. Set `GH_TOKEN` (a fine-grained token with
   read access to contents and releases) only if the repo is private;
   `fetch_cache.py` and `sync_odds.py` both read it.
4. **Frontend build**: `scripts/build.sh` runs `npm ci` and `npm run build`
   in `dashboard/web/` on every deploy, so `dist/` never needs committing.
   `render.yaml` pins `NODE_VERSION`.

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

    pip install -e ".[dev,dashboard]"
    python scripts/fetch_cache.py            # or run ingest.py yourself
    (cd dashboard/web && npm ci && npm run build)
    SITE_PASSWORD=x ODDS_REPO=henrykanaskie/nfl_predictor \
      uvicorn dashboard.api.app:app --port 8017
