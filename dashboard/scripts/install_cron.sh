#!/bin/bash
# Adds two daily runs of daily.sh (08:00 and 20:00 local) to the user's
# crontab, replacing any earlier dashboard entry. Remove with:
#   crontab -l | grep -v props-dashboard | crontab -
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LINE="0 8,20 * * * $ROOT/dashboard/scripts/daily.sh # props-dashboard"
( crontab -l 2>/dev/null | grep -v 'props-dashboard' ; echo "$LINE" ) | crontab -
echo "installed:"; crontab -l | grep props-dashboard
