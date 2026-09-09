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

gh release upload "$TAG" /tmp/cache-upload/*.tar --clobber
rm -rf /tmp/cache-upload
echo "[ok] cache uploaded to release $TAG"
