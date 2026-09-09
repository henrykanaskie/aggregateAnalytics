#!/usr/bin/env bash
# Weekly: refresh the current season in the parquet cache, then rebuild the
# derived tables under data/derived/. Run by .github/workflows/stats.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

SEASON="${SEASON:-2026}"
DERIVE_CMD="python -m dashboard.stats.team"     # <- the dashboard's derived-table build

echo "+ refresh ${SEASON} in the cache"
python data_handling/ingest.py --start "$SEASON" --end "$SEASON" --refresh

# Coordinators are not in nflverse; they are scraped per team-season and only
# change with the staff, so a failure here must not take the weekly stats
# refresh down with it.
echo "+ refresh ${SEASON} coordinators"
python -m data_handling.fetch_coordinators "$SEASON" || echo "! coordinator refresh failed; keeping the cached table"

mkdir -p data/derived
echo "+ $DERIVE_CMD"
$DERIVE_CMD
