"""Pull sportsbook lines and append them to the snapshot store.

    python -m dashboard.odds.pull --source espn              # free, DraftKings via ESPN
    python -m dashboard.odds.pull --source oddsapi           # needs ODDS_API_KEY
    python -m dashboard.odds.pull --source oddsapi --markets player_reception_yds player_receptions
    python -m dashboard.odds.pull --source sample            # generated, flagged in the UI
    python -m dashboard.odds.pull --source all --season 2026 --week 1

Run it on a cron (or from the Settings page) twice a day during the season;
every pull is a new file, so line movement accumulates.
"""

from __future__ import annotations

import argparse
import sys

from ..config import CURRENT_SEASON
from .common import current_week
from .markets import DEFAULT_ODDSAPI_MARKETS
from .store import write_games, write_props


def run_pull(source: str, season: int | None = None, week: int | None = None, *,
             markets: list[str] | None = None, bookmakers: list[str] | None = None,
             max_credits: int = 250, games: list[str] | None = None, with_games: bool = True,
             dry_run: bool = False, log=print) -> dict:
    season = season or CURRENT_SEASON
    week = week or current_week(season)
    result: dict = {"source": source, "season": season, "week": week, "props": 0, "games": 0,
                    "files": [], "usage": None}

    if source == "espn":
        from . import espn
        props, glines = espn.pull(season, week, with_games=with_games, log=log)
    elif source == "oddsapi":
        from . import theoddsapi
        props, glines, usage = theoddsapi.pull(
            season, week, markets=markets or DEFAULT_ODDSAPI_MARKETS, bookmakers=bookmakers,
            max_credits=max_credits, with_games=with_games, game_ids=games, log=log,
        )
        result["usage"] = usage
    elif source == "sample":
        from . import sample
        props, glines = sample.generate(season, week)
    else:
        raise ValueError(f"unknown source {source!r}")

    result["props"] = len(props)
    result["games"] = len(glines)
    result["matched"] = sum(1 for r in props if r.get("player_id"))
    if dry_run:
        log(f"[{source}] dry run: {len(props)} prop rows, {len(glines)} game rows, not written")
        return result
    for rows, writer in ((props, write_props), (glines, write_games)):
        p = writer(rows, source)
        if p:
            result["files"].append(str(p))
            log(f"[{source}] wrote {len(rows)} rows -> {p.name}")
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", choices=["espn", "oddsapi", "sample", "all"], default="espn")
    ap.add_argument("--season", type=int, default=None)
    ap.add_argument("--week", type=int, default=None)
    ap.add_argument("--markets", nargs="*", default=None, help="Odds API market keys")
    ap.add_argument("--bookmakers", nargs="*", default=None, help="Odds API bookmaker keys")
    ap.add_argument("--games", nargs="*", default=None, help="restrict to these nflverse game_ids")
    ap.add_argument("--max-credits", type=int, default=250)
    ap.add_argument("--no-games", action="store_true", help="skip spreads/totals/moneylines")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    sources = ["espn", "oddsapi"] if a.source == "all" else [a.source]
    rc = 0
    for s in sources:
        try:
            r = run_pull(s, a.season, a.week, markets=a.markets, bookmakers=a.bookmakers,
                         max_credits=a.max_credits, games=a.games, with_games=not a.no_games,
                         dry_run=a.dry_run)
            print(f"[{s}] props={r['props']} (ids matched {r['matched']}) games={r['games']}")
        except Exception as exc:  # keep going so ESPN still lands if the API key is missing
            print(f"[{s}] FAILED: {exc}", file=sys.stderr)
            rc = 1
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
