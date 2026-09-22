"""Pull sportsbook lines and append them to the snapshot store.

    python -m dashboard.odds.pull --source espn              # free, DraftKings via ESPN
    python -m dashboard.odds.pull --source oddsapi           # needs ODDS_API_KEY
    python -m dashboard.odds.pull --source oddsapi --markets player_reception_yds player_receptions
    python -m dashboard.odds.pull --source sgo               # needs SGO_API_KEY (free plan)
    python -m dashboard.odds.pull --source sample            # generated, flagged in the UI
    python -m dashboard.odds.pull --source all --season 2026 --week 1
    python -m dashboard.odds.pull --source auto              # what the schedule runs

``auto`` is the one that survives losing a feed. It tries ESPN (free, one
book) and Sports Game Odds (free plan, nine books) independently, so either
can go down without taking the other with it, and only when neither produced
a single prop does it spend Odds API credits, on a short market list that
fits what is left of the month. Every attempt is written to
``data/odds/feed_status.json``, which the Settings page and the board's
banner read, so a dead feed says so instead of the site quietly going stale.

Run it on a cron (or from the Settings page) twice a day during the season;
every pull is a new file, so line movement accumulates.
"""

from __future__ import annotations

import argparse
import json
import sys

from ..config import CURRENT_SEASON, FEED_STATUS_PATH, odds_api_key, sgo_api_key
from .common import current_week
from .markets import DEFAULT_ODDSAPI_MARKETS
from .store import now_utc, write_games, write_props

#: The Odds API fallback's markets: the ones every page leans on, seven credits
#: a game, so a 16-game week is about 115 and the free 500 still stretch.
FALLBACK_ODDSAPI_MARKETS = ["player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions",
                            "player_rush_attempts", "player_pass_tds", "player_anytime_td"]


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
    elif source == "sgo":
        from . import sgo
        props, glines, usage = sgo.pull(season, week, with_games=with_games, log=log)
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


def feed_status() -> dict:
    """{source: {ok, at, props, games, error, last_ok}} from the last attempts."""
    if FEED_STATUS_PATH.exists():
        try:
            return json.loads(FEED_STATUS_PATH.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def _record(source: str, result: dict | None, error: str | None) -> None:
    status = feed_status()
    prev = status.get(source, {})
    now = now_utc().isoformat()
    ok = error is None and bool(result and result["props"] + result["games"])
    status[source] = {
        "ok": ok, "at": now, "props": result["props"] if result else 0, "games": result["games"] if result else 0,
        "error": error if error else (None if ok else "returned nothing"),
        "last_ok": now if ok else prev.get("last_ok"),
    }
    FEED_STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    FEED_STATUS_PATH.write_text(json.dumps(status, indent=2))


def _attempt(source: str, a, log=print, **kw) -> dict | None:
    try:
        r = run_pull(source, a.season, a.week, markets=kw.get("markets", a.markets), bookmakers=a.bookmakers,
                     max_credits=kw.get("max_credits", a.max_credits), games=a.games,
                     with_games=kw.get("with_games", not a.no_games), dry_run=a.dry_run, log=log)
        print(f"[{source}] props={r['props']} (ids matched {r['matched']}) games={r['games']}")
        if not a.dry_run:
            _record(source, r, None)
        return r
    except Exception as exc:  # one feed failing must never stop the next
        print(f"[{source}] FAILED: {exc}", file=sys.stderr)
        if not a.dry_run:
            _record(source, None, str(exc)[:300])
        return None


def auto(a) -> int:
    """ESPN and Sports Game Odds each on their own, then The Odds API only if
    both came back empty. Exit 1 only when no feed produced a line."""
    got: list[dict] = []
    r = _attempt("espn", a)
    if r:
        got.append(r)
    if sgo_api_key():
        r = _attempt("sgo", a)
        if r:
            got.append(r)
    else:
        print("[sgo] skipped: no SGO_API_KEY (free at sportsgameodds.com)")
    if not any(r["props"] for r in got) and odds_api_key():
        from .theoddsapi import usage as oa_usage
        left = (oa_usage() or {}).get("remaining")
        # Keep a reserve for pulls made by hand from Settings.
        budget = 250 if left is None else max(0, int(left) - 50)
        print(f"[oddsapi] fallback: no props from the free feeds; budget {budget} credits")
        if budget >= 30:
            # Game lines only if nothing else brought them: they cost 3 more.
            r = _attempt("oddsapi", a, markets=FALLBACK_ODDSAPI_MARKETS, max_credits=budget,
                         with_games=not a.no_games and not any(x["games"] for x in got))
            if r:
                got.append(r)
    if not any(r["props"] + r["games"] for r in got):
        print("! no feed produced any lines; the site keeps showing the last good pull", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", choices=["auto", "espn", "sgo", "oddsapi", "sample", "all"], default="auto")
    ap.add_argument("--season", type=int, default=None)
    ap.add_argument("--week", type=int, default=None)
    ap.add_argument("--markets", nargs="*", default=None, help="Odds API market keys")
    ap.add_argument("--bookmakers", nargs="*", default=None, help="Odds API bookmaker keys")
    ap.add_argument("--games", nargs="*", default=None, help="restrict to these nflverse game_ids")
    ap.add_argument("--max-credits", type=int, default=250)
    ap.add_argument("--no-games", action="store_true", help="skip spreads/totals/moneylines")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if a.source == "auto":
        return auto(a)
    sources = ["espn", "sgo", "oddsapi"] if a.source == "all" else [a.source]
    rc = 0
    for s in sources:
        if _attempt(s, a) is None:
            rc = 1
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
