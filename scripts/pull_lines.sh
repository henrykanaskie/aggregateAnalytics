#!/usr/bin/env bash
# Pull the current lines and append a snapshot under data/odds/.
# Run by .github/workflows/lines.yml four times a day.
#
# The dashboard owns the puller. Until it is pushed this script does nothing,
# on purpose, so the workflow stays green. When it lands, replace PULL_CMD.
set -euo pipefail
cd "$(dirname "$0")/.."

PULL_CMD="python -m dashboard.odds.pull"        # <- the dashboard's pull entry point

if [ ! -d dashboard ]; then
  echo "dashboard/ is not in the repo yet; nothing to pull."
  exit 0
fi
mkdir -p data/odds
echo "+ $PULL_CMD"
$PULL_CMD
