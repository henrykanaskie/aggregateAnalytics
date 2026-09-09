#!/usr/bin/env bash
# Pull the current lines and append a snapshot under data/odds/.
# Run by .github/workflows/lines.yml four times a day.
#
# Needs the players, teams and schedules tables from the cache; lines.yml
# fetches just those (scripts/fetch_cache.py --only).
set -euo pipefail
cd "$(dirname "$0")/.."

# ESPN only (DraftKings lines, free, no key). The Odds API is deliberately
# NOT on the schedule: its free tier is 500 credits a month and one default
# pull is ~115, so four a day would exhaust it on day one. Spend those credits
# by hand from the Settings page, which shows the cost before pulling.
# To put it on the schedule anyway (paid tier), set ODDS_API_SCHEDULED=1.
if [ -n "${ODDS_API_KEY:-}" ] && [ "${ODDS_API_SCHEDULED:-0}" = "1" ]; then
  PULL_CMD="python -m dashboard.odds.pull --source all"
else
  PULL_CMD="python -m dashboard.odds.pull --source espn"
fi

mkdir -p data/odds
echo "+ $PULL_CMD"
$PULL_CMD
