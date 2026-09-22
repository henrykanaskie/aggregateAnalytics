#!/usr/bin/env bash
# Pull the current lines and append a snapshot under data/odds/.
# Run by .github/workflows/lines.yml four times a day.
#
# Needs the players, teams and schedules tables from the cache; lines.yml
# fetches just those (scripts/fetch_cache.py --only).
set -euo pipefail
cd "$(dirname "$0")/.."

# "auto" tries ESPN (free, DraftKings only) and, when SGO_API_KEY is set,
# Sports Game Odds (free plan, nine books) independently, so losing either
# feed does not lose the snapshot. The Odds API is spent only when both come
# back empty, on a short market list that fits what is left of its month.
# Its free tier is 500 credits and one full pull is ~176, so it is deliberately
# not on the schedule for every run. To pull it every time anyway (paid tier),
# set ODDS_API_SCHEDULED=1.
if [ -n "${ODDS_API_KEY:-}" ] && [ "${ODDS_API_SCHEDULED:-0}" = "1" ]; then
  PULL_CMD="python -m dashboard.odds.pull --source all"
else
  PULL_CMD="python -m dashboard.odds.pull --source auto"
fi

mkdir -p data/odds
echo "+ $PULL_CMD"
$PULL_CMD
