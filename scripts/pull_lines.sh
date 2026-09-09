#!/usr/bin/env bash
# Pull the current lines and append a snapshot under data/odds/.
# Run by .github/workflows/lines.yml four times a day.
#
# Needs the players, teams and schedules tables from the cache; lines.yml
# fetches just those (scripts/fetch_cache.py --only).
set -euo pipefail
cd "$(dirname "$0")/.."

# ESPN (DraftKings lines, free) always; The Odds API too when a key is set.
# `--source all` reports a failure for either provider as a non-zero exit, so
# choose explicitly rather than let a missing key fail the run.
if [ -n "${ODDS_API_KEY:-}" ]; then
  PULL_CMD="python -m dashboard.odds.pull --source all"
else
  PULL_CMD="python -m dashboard.odds.pull --source espn"
fi

mkdir -p data/odds
echo "+ $PULL_CMD"
$PULL_CMD
