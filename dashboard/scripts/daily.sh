#!/bin/bash
# Daily automation for the props dashboard. Safe to run any time; every step
# appends or is idempotent.
#
#   1. pull today's lines (ESPN and, with SGO_API_KEY, Sports Game Odds; The
#      Odds API when both come back empty, and a small daily pull if a key is set)
#   2. log the baseline projection for the current week
#   3. grade last week's lines and predictions
#   4. every run, refresh this season's box scores, play-by-play and
#      schedule, so a game's shares (red zone too) show up the morning after
#      it is played (nflverse posts them a few hours after each slate)
#   5. on Tuesdays, refresh snaps, injuries and the rest from nflverse and
#      rebuild the team table
#
# Install with:  dashboard/scripts/install_cron.sh
set -u
cd "$(dirname "$0")/../.." || exit 1
PY=venv/bin/python
LOG=data/odds/automation.log
mkdir -p data/odds
exec >>"$LOG" 2>&1
echo "=== $(date -u +%FT%TZ) daily start"

$PY -m dashboard.odds.pull --source auto || echo "! no lines feed answered; continuing"
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

$PY data_handling/ingest.py --only schedules player_stats_week pbp --start 2026 --end 2026 --refresh \
  || echo "[ingest] box score refresh failed; keeping the last files"

if [ "$(date +%u)" = "2" ]; then
  echo "[ingest] Tuesday refresh"
  $PY data_handling/ingest.py --only schedules player_stats_week snap_counts pbp injuries pfr_def pfr_rec pfr_rush pfr_pass ngs_passing ngs_receiving ngs_rushing ff_opportunity ftn_charting participation --start 2026 --end 2026 --refresh
  $PY -m dashboard.stats.team 2026
  $PY -m dashboard.stats.angle_grades || echo "[angles] grading failed; the matchup review keeps last week's"
fi
echo "=== $(date -u +%FT%TZ) daily done"
