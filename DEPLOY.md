# Deploying for free

The site runs as one FastAPI process on Render's free web service. It keeps
nothing on disk that it cannot recreate, so the host can sleep, rebuild, or
move it and nothing is lost. Everything that accumulates lives in git or on a
GitHub Release, where the commit history is the audit trail.

## The moving parts

| piece | where it runs | when | what it does |
|---|---|---|---|
| `lines.yml` | GitHub Actions | 4x/day (~6am, noon, 6pm, 11pm ET) | fetches the three tables the puller needs, runs `dashboard.odds.pull`, commits `data/odds/` |
| `stats.yml` | GitHub Actions | Tuesday 6am ET | refreshes the current season in the parquet cache, rebuilds `data/derived/`, grades the weeks that have finished, uploads the cache to the `data-cache` Release, commits `data/derived/` and `data/odds/graded/` |
| `keepalive.yml` | GitHub Actions | every 10 min | `GET /api/health`, so the host does not idle out and wake up in front of a visitor. Needs the `SITE_URL` repo variable; without it the job exits doing nothing |
| `scripts/build.sh` | Render, on deploy | code or derived-table pushes | `pip install`, `scripts/fetch_cache.py` pulls the cache from the Release, `npm run build` for the SPA |
| `data_handling/sync_odds.py` | inside the app | on wake, every 30 min | pulls new `data/odds/` files from GitHub, so lines commits never need a rebuild; deletes the snapshots the new ones replace |
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

- **Sleep.** After about fifteen idle minutes Render stops the process, and
  the next visitor waits roughly thirty seconds while it starts and syncs
  odds. `keepalive.yml` pings every ten minutes to stop that happening, which
  costs two things worth knowing. Never sleeping is about 730 instance-hours a
  month against the free plan's 750, so it holds only while this is the one
  free web service on the account. And GitHub's scheduler runs late and skips
  slots, so ten minutes against a fifteen-minute timeout leaves room for one
  late run and no more: cold starts get rarer, not impossible. Delete the
  workflow or unset `SITE_URL` to go back to sleeping.
- **Memory.** 512 MB. Fine for polars scans with a column select; not fine
  for `pl.read_parquet` on the whole play-by-play table. The 45-second team
  tendency rebuild runs in Actions, never on Render.
- **Snapshot retention.** The odds archive grows by four snapshots a day
  forever. `ODDS_KEEP_DAYS` (10 in `render.yaml`) bounds what the host holds:
  each sync fetches only snapshots inside that window and deletes the ones
  that fall out of it, so Render sits at roughly 80 files instead of a season's
  worth. The full archive stays in git, untouched; only Render's copy is
  thinned. The window cannot be shrunk to a single pull, because ESPN 404s an
  event's odds the moment it is final: a played game's closing line exists only
  in snapshots taken before kickoff, and that is exactly what `grade_week`
  reads. So the grading runs in `stats.yml` instead, on Tuesday mornings once
  the cache refresh has landed Monday night's box scores, against a checkout
  that has the whole archive. It commits `data/odds/graded/`, which the app
  syncs like any other odds file and never prunes, so the dashboard reads a
  result rather than recomputing one it no longer holds the lines for.
  Opening lines are unaffected either way, ESPN stamps `open_line` on every row.

  Grades for a week are recomputable from a checkout at any time:

      python -m dashboard.odds.grading --season 2026 --week 3
      python -m dashboard.odds.grading --all     # regrade the season
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
