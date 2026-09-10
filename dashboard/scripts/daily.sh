#!/bin/bash
# Daily automation for the props dashboard. Safe to run any time; every step
# appends or is idempotent.
#
#   1. pull today's lines (ESPN, free; The Odds API too if a key is set)
#   2. log the baseline projection for the current week
#   3. grade last week's lines and predictions
#   4. on Tuesdays, refresh last week's box scores, snaps, play-by-play,
#      schedules and injuries from nflverse and rebuild the team table
#
# Install with:  dashboard/scripts/install_cron.sh
set -u
cd "$(dirname "$0")/../.." || exit 1
PY=venv/bin/python
LOG=data/odds/automation.log
mkdir -p data/odds
exec >>"$LOG" 2>&1
echo "=== $(date -u +%FT%TZ) daily start"

$PY -m dashboard.odds.pull --source espn
$PY -m dashboard.odds.injuries || echo "[injuries] refresh failed; keeping the last file"
if grep -q '^ODDS_API_KEY=.\+' .env 2>/dev/null; then
  $PY -m dashboard.odds.pull --source oddsapi --max-credits 60 \
    --markets player_pass_yds player_rush_yds player_reception_yds player_receptions player_anytime_td
fi

$PY - <<'PYEOF'
from dashboard.config import CURRENT_SEASON
from dashboard.odds.common import current_week
from dashboard.odds import store, grading
from dashboard.odds.analysis import build_board
from dashboard.stats import projection
season = CURRENT_SEASON
week = current_week(season)
rows = build_board(store.latest_props(season, week))
projection.project_rows(rows, season, week)
print(f"[baseline] week {week}: logged {projection.log_baseline(rows, season, week)} projections")
if week > 1:
    g = grading.grade_week(season, week - 1)
    print(f"[grade] week {week - 1}: {g.height} lines graded")
PYEOF

if [ "$(date +%u)" = "2" ]; then
  echo "[ingest] Tuesday refresh"
  $PY data_handling/ingest.py --only schedules player_stats_week snap_counts pbp injuries pfr_def pfr_rec pfr_rush pfr_pass ngs_passing ngs_receiving ngs_rushing ff_opportunity ftn_charting participation --start 2026 --end 2026 --refresh
  $PY -m dashboard.stats.team 2026
fi
echo "=== $(date -u +%FT%TZ) daily done"
