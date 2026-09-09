#!/usr/bin/env bash
# Weekly: refresh the current season in the parquet cache, then rebuild the
# derived tables under data/derived/. Run by .github/workflows/stats.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

SEASON="${SEASON:-2026}"

echo "+ refresh ${SEASON} in the cache"
python data_handling/ingest.py --start "$SEASON" --end "$SEASON" --refresh

# Coordinators are not in nflverse; they are scraped per team-season and only
# change with the staff, so a failure here must not take the weekly stats
# refresh down with it.
echo "+ refresh ${SEASON} coordinators"
python -m data_handling.fetch_coordinators "$SEASON" || echo "! coordinator refresh failed; keeping the cached table"

mkdir -p data/derived

# The derived tables, in dependency order. The team-game table is what the
# league ranks are computed from, and the angle table is built against those
# ranks, so it has to come second.
echo "+ team tendency table"
python -m dashboard.stats.team

# Player angles are the API's most expensive read: eight skill players a side,
# each one a scan of the play-by-play store, which was 2.5 of the 3.3 seconds
# a matchup took to serve. Nothing about them depends on the request, so they
# are built here against the table above and served as a filter on a 73 KB
# parquet. Every pair of teams, not just this week's games, so the file stays
# right as the schedule moves.
echo "+ player angle table"
python -m dashboard.stats.angles "$SEASON"
