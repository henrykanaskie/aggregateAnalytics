#!/bin/bash
# macOS alternative to cron (cron needs Full Disk Access on recent macOS).
# Installs a per-user launchd agent that runs daily.sh at 08:00 and 20:00.
# Remove with: launchctl bootout gui/$(id -u)/com.aggregate-analytics.dashboard; rm ~/Library/LaunchAgents/com.aggregate-analytics.dashboard.plist
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="com.aggregate-analytics.dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# The agent used to be installed under the project's old name. launchd keys on
# the label, so a rename does not replace the old agent, it adds a second one
# beside it, and both would run daily.sh on the same schedule against the same
# log. Unload and delete the old one first. Harmless when it was never there.
LEGACY="com.nfl-predictor.dashboard"
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LEGACY.plist"
if launchctl print "gui/$(id -u)/$LEGACY" >/dev/null 2>&1 || [ -f "$LEGACY_PLIST" ]; then
  echo "removing the old agent: $LEGACY"
  launchctl bootout "gui/$(id -u)/$LEGACY" 2>/dev/null
  rm -f "$LEGACY_PLIST"
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$ROOT/dashboard/scripts/daily.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$ROOT/data/odds/automation.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/odds/automation.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "installed: $PLIST" && launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|program" | head -3
