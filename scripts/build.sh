#!/usr/bin/env bash
# Deploy build (Render runs this). Install the app, fetch the cache.
set -euo pipefail
cd "$(dirname "$0")/.."
pip install -e ".[web]"
python scripts/fetch_cache.py
