from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

from nfl.data import DATA_ROOT, REPO_ROOT

# Secrets live in a repo-root .env (gitignored): ODDS_API_KEY and SGO_API_KEY.
load_dotenv(REPO_ROOT / ".env")

DASHBOARD_DIR = Path(__file__).resolve().parent
WEB_DIST = DASHBOARD_DIR / "web" / "dist"

ODDS_DIR = DATA_ROOT / "odds"
PROPS_DIR = ODDS_DIR / "props"
GAMES_DIR = ODDS_DIR / "games"
USAGE_PATH = ODDS_DIR / "oddsapi_usage.json"
#: Sports Game Odds objects spent this month, counted locally (see odds/sgo.py).
SGO_USAGE_PATH = ODDS_DIR / "sgo_usage.json"
#: What each source did on its last scheduled attempt, for the status panel.
FEED_STATUS_PATH = ODDS_DIR / "feed_status.json"
ESPN_CACHE = ODDS_DIR / "espn_athletes.json"
#: This season's injury reports, refreshed with every lines pull. It lives
#: under data/odds because that directory is what a stateless host syncs
#: from git between deploys; the weekly cache only sees injuries on Tuesdays.
INJURIES_LIVE = ODDS_DIR / "injuries.parquet"
DERIVED_DIR = DATA_ROOT / "derived"
PROP_PRED_PATH = DERIVED_DIR / "prop_predictions.parquet"

CURRENT_SEASON = int(os.environ.get("NFL_SEASON", "2026"))
#: Earliest season the UI loads by default. Advanced tables start 2016-2018.
DEFAULT_SINCE = 2016

API_PORT = int(os.environ.get("DASHBOARD_PORT", "8017"))


def odds_api_key() -> str | None:
    return os.environ.get("ODDS_API_KEY") or None


def sgo_api_key() -> str | None:
    return os.environ.get("SGO_API_KEY") or None


#: Sports Game Odds' free plan allows 2,500 objects (one object = one game) a
#: month. The puller stops short of this so a busy week cannot tip it over.
SGO_MONTHLY_OBJECTS = int(os.environ.get("SGO_MONTHLY_OBJECTS", "2400"))
