#!/usr/bin/env bash
# Deploy build (Render runs this). Install the app, fetch the cache.
set -euo pipefail
cd "$(dirname "$0")/.."
pip install -e ".[dashboard]"
python scripts/fetch_cache.py
# The SPA. Render's Python runtime ships Node; NODE_VERSION in render.yaml pins it.
npm ci --prefix dashboard/web --no-audit --no-fund
npm run build --prefix dashboard/web
