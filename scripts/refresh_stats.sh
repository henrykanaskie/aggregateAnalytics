#!/usr/bin/env bash
# Weekly: refresh the current season in the parquet cache, then rebuild the
# derived tables under data/derived/. Run by .github/workflows/stats.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

SEASON="${SEASON:-2026}"
DERIVE_CMD="python -m dashboard.stats.team"     # <- the dashboard's derived-table build

echo "+ refresh ${SEASON} in the cache"
python data_handling/ingest.py --start "$SEASON" --end "$SEASON" --refresh

if [ -d dashboard ]; then
  mkdir -p data/derived
  echo "+ $DERIVE_CMD"
  $DERIVE_CMD
else
  echo "dashboard/ is not in the repo yet; skipping derived tables."
fi
