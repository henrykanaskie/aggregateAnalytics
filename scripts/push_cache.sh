#!/usr/bin/env bash
# Upload the parquet cache to the `data-cache` Release, one tar per dataset,
# so no asset approaches GitHub's 2 GB per-file limit. Needs `gh` (present on
# GitHub runners) and a token with contents:write.
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="${NFL_DATA_DIR:-data}"
TAG="data-cache"

gh release view "$TAG" >/dev/null 2>&1 || \
  gh release create "$TAG" --title "Parquet cache" \
     --notes "nflverse tables as cached by data_handling/ingest.py. Refreshed weekly by stats.yml." --latest=false

mkdir -p /tmp/cache-upload
for d in "$DATA"/raw/*/; do
  name="$(basename "$d")"
  tar -cf "/tmp/cache-upload/${name}.tar" -C "$DATA" "raw/${name}"
done
# static tables are single files; bundle them together
tar -cf /tmp/cache-upload/_static.tar -C "$DATA" $(cd "$DATA" && ls raw/*.parquet manifest.json 2>/dev/null)
# The tables refresh_stats.sh builds, named by the modules that write them so
# a VERSION bump uploads the new file and not the one it replaced. Not the
# whole of derived/: prop_predictions.parquet is a local log, not a build.
DERIVED="$(python -c 'from dashboard.stats import angles, team; print(team.CACHE.name, angles.CACHE.name)')"
tar -cf /tmp/cache-upload/_derived.tar -C "$DATA" $(for f in $DERIVED; do echo "derived/$f"; done)

gh release upload "$TAG" /tmp/cache-upload/*.tar --clobber
rm -rf /tmp/cache-upload
echo "[ok] cache uploaded to release $TAG"
