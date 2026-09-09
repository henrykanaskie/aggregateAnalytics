from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

from nfl.data import DATA_ROOT, REPO_ROOT

# Secrets live in a repo-root .env (gitignored). ODDS_API_KEY is the only one.
load_dotenv(REPO_ROOT / ".env")

DASHBOARD_DIR = Path(__file__).resolve().parent
WEB_DIST = DASHBOARD_DIR / "web" / "dist"

ODDS_DIR = DATA_ROOT / "odds"
PROPS_DIR = ODDS_DIR / "props"
GAMES_DIR = ODDS_DIR / "games"
USAGE_PATH = ODDS_DIR / "oddsapi_usage.json"
ESPN_CACHE = ODDS_DIR / "espn_athletes.json"
DERIVED_DIR = DATA_ROOT / "derived"
PROP_PRED_PATH = DERIVED_DIR / "prop_predictions.parquet"

CURRENT_SEASON = int(os.environ.get("NFL_SEASON", "2026"))
#: Earliest season the UI loads by default. Advanced tables start 2016-2018.
DEFAULT_SINCE = 2016

API_PORT = int(os.environ.get("DASHBOARD_PORT", "8017"))


def odds_api_key() -> str | None:
    return os.environ.get("ODDS_API_KEY") or None
