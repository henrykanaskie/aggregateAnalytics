"""The Odds API (the-odds-api.com): the multi-sportsbook source.

Needs ``ODDS_API_KEY`` in the repo-root ``.env``. The free tier is 500 credits
a month and player props are priced per market per event, so a full 11-market
pull of a 16-game week costs about 176 credits. Choose markets and games
deliberately; the CLI prints the estimated cost before spending anything and
refuses to exceed ``max_credits``.

    /v4/sports/americanfootball_nfl/events                     free
    /v4/sports/americanfootball_nfl/odds  (h2h,spreads,totals) 3 credits
    /v4/sports/americanfootball_nfl/events/{id}/odds           1 credit per market

Players come back as free-text ``description`` fields, so they are matched to
gsis ids by normalised name with the event's two teams as a tiebreak.
"""

from __future__ import annotations

import json
from datetime import datetime

import requests

from ..config import USAGE_PATH, odds_api_key
from ..stats.players import match_name
from .common import decimal_to_american, match_game, team_abbr, week_window
from .markets import BOOKS, BY_KEY, DEFAULT_ODDSAPI_MARKETS
from .store import now_utc

BASE = "https://api.the-odds-api.com/v4"
SPORT = "americanfootball_nfl"
SOURCE = "oddsapi"
TIMEOUT = 30


class OddsApiError(RuntimeError):
    pass


def _key() -> str:
    k = odds_api_key()
    if not k:
        raise OddsApiError("ODDS_API_KEY is not set. Put it in the repo-root .env file.")
    return k


def _record_usage(headers, note: str) -> dict:
    usage = {
        "at": now_utc().isoformat(),
        "remaining": _int(headers.get("x-requests-remaining")),
        "used": _int(headers.get("x-requests-used")),
        "last_cost": _int(headers.get("x-requests-last")),
        "note": note,
    }
    USAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
    USAGE_PATH.write_text(json.dumps(usage, indent=2))
    return usage


def _int(x) -> int | None:
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return None


def usage() -> dict | None:
    if USAGE_PATH.exists():
        try:
            return json.loads(USAGE_PATH.read_text())
        except json.JSONDecodeError:
            return None
    return None


def _get(path: str, **params) -> tuple[list | dict, requests.structures.CaseInsensitiveDict]:
    params["apiKey"] = _key()
    r = requests.get(f"{BASE}/{path}", params=params, timeout=TIMEOUT)
    if r.status_code == 401:
        raise OddsApiError("The Odds API rejected the key (401).")
    if r.status_code == 429:
        raise OddsApiError("The Odds API quota is exhausted (429).")
    r.raise_for_status()
    return r.json(), r.headers


def events(season: int, week: int) -> list[dict]:
    """Upcoming events inside the week's window, with nflverse ids. Free."""
    lo, hi = week_window(season, week)
    data, headers = _get(f"sports/{SPORT}/events", commenceTimeFrom=lo, commenceTimeTo=hi, dateFormat="iso")
    _record_usage(headers, "events")
    out = []
    for ev in data:
        home, away = team_abbr(ev["home_team"]), team_abbr(ev["away_team"])
        game = match_game(season, home, away, ev.get("commence_time"), week=week)
        out.append({
            "event_id": ev["id"], "commence_time": ev.get("commence_time"),
            "home_team": home, "away_team": away, "home_name": ev["home_team"],
            "away_name": ev["away_team"], "game_id": game["game_id"] if game else None,
            "season": season, "week": week,
        })
    return out


def estimate_cost(n_events: int, markets: list[str], regions: str = "us") -> int:
    return n_events * len(markets) * len(regions.split(",")) + 3


def event_props(event: dict, markets: list[str], pulled_at: datetime, regions: str = "us",
                bookmakers: list[str] | None = None) -> tuple[list[dict], dict]:
    params = {"regions": regions, "markets": ",".join(markets), "oddsFormat": "american", "dateFormat": "iso"}
    if bookmakers:
        params["bookmakers"] = ",".join(bookmakers)
        params.pop("regions")
    data, headers = _get(f"sports/{SPORT}/events/{event['event_id']}/odds", **params)
    used = _record_usage(headers, f"props {event['away_team']}@{event['home_team']}")
    base = {
        "pulled_at": pulled_at, "source": SOURCE, "season": event["season"], "week": event["week"],
        "game_id": event["game_id"], "event_id": event["event_id"],
        "commence_time": event["commence_time"], "home_team": event["home_team"],
        "away_team": event["away_team"],
    }
    teams = tuple(t for t in (event["home_team"], event["away_team"]) if t)
    rows: list[dict] = []
    name_cache: dict[str, str | None] = {}
    for bk in data.get("bookmakers", []):
        for mk in bk.get("markets", []):
            m = BY_KEY.get(mk["key"])
            if m is None:
                continue
            for oc in mk.get("outcomes", []):
                name = oc.get("description") or oc.get("name")
                if name not in name_cache:
                    name_cache[name] = match_name(name, teams)
                pid = name_cache[name]
                side = oc.get("name")
                if m.kind == "yesno" and side not in ("Yes", "No"):
                    side = "Yes"
                rows.append({
                    **base, "book": bk["key"], "book_title": bk.get("title") or BOOKS.get(bk["key"], bk["key"]),
                    "team": _player_team(pid, teams), "market": m.key, "player_name": name,
                    "player_id": pid, "side": side, "line": oc.get("point"),
                    "price": _price(oc.get("price")), "open_line": None, "open_price": None,
                    "last_update": mk.get("last_update"),
                })
    return rows, used


def _price(p) -> int | None:
    if p is None:
        return None
    p = float(p)
    # oddsFormat=american is requested, but be defensive about decimals.
    return int(round(p)) if abs(p) >= 100 else decimal_to_american(p)


def _player_team(pid: str | None, teams: tuple[str, ...]) -> str | None:
    if not pid:
        return None
    from ..stats.players import profile
    p = profile(pid)
    t = p.get("team") if p else None
    return t if t in teams else None


def game_lines(season: int, week: int, pulled_at: datetime, regions: str = "us") -> tuple[list[dict], dict]:
    lo, hi = week_window(season, week)
    data, headers = _get(f"sports/{SPORT}/odds", regions=regions, markets="h2h,spreads,totals",
                         oddsFormat="american", dateFormat="iso", commenceTimeFrom=lo, commenceTimeTo=hi)
    used = _record_usage(headers, "game lines")
    rows: list[dict] = []
    for ev in data:
        home, away = team_abbr(ev["home_team"]), team_abbr(ev["away_team"])
        game = match_game(season, home, away, ev.get("commence_time"), week=week)
        base = {
            "pulled_at": pulled_at, "source": SOURCE, "season": season, "week": week,
            "game_id": game["game_id"] if game else None, "event_id": ev["id"],
            "commence_time": ev.get("commence_time"), "home_team": home, "away_team": away,
        }
        for bk in ev.get("bookmakers", []):
            for mk in bk.get("markets", []):
                for oc in mk.get("outcomes", []):
                    side = oc["name"]
                    if mk["key"] in ("h2h", "spreads"):
                        side = team_abbr(side) or side
                    rows.append({**base, "book": bk["key"], "book_title": bk.get("title"),
                                 "market": mk["key"], "side": side, "line": oc.get("point"),
                                 "price": _price(oc.get("price")), "open_line": None,
                                 "open_price": None, "last_update": mk.get("last_update")})
    return rows, used


def pull(season: int, week: int, markets: list[str] | None = None, bookmakers: list[str] | None = None,
         regions: str = "us", max_credits: int = 250, with_games: bool = True, game_ids: list[str] | None = None,
         log=print) -> tuple[list[dict], list[dict], dict]:
    """Fetch props (and game lines) for a week, respecting a credit ceiling.
    Returns (prop_rows, game_rows, usage). Nothing is written here."""
    markets = markets or DEFAULT_ODDSAPI_MARKETS
    bad = [m for m in markets if m not in BY_KEY]
    if bad:
        raise OddsApiError(f"unknown markets: {bad}")
    pulled_at = now_utc()
    evs = events(season, week)
    if game_ids:
        evs = [e for e in evs if e["game_id"] in game_ids]
    cost = estimate_cost(len(evs), markets, regions) - (0 if with_games else 3)
    log(f"[oddsapi] {len(evs)} events, {len(markets)} markets -> ~{cost} credits (ceiling {max_credits})")
    if cost > max_credits:
        raise OddsApiError(
            f"estimated cost {cost} exceeds max_credits={max_credits}; "
            f"narrow --markets or --games, or raise --max-credits"
        )
    prop_rows: list[dict] = []
    game_rows: list[dict] = []
    used: dict = usage() or {}
    if with_games:
        game_rows, used = game_lines(season, week, pulled_at, regions)
        log(f"[oddsapi] game lines: {len(game_rows)} rows, remaining {used.get('remaining')}")
    for ev in evs:
        rows, used = event_props(ev, markets, pulled_at, regions, bookmakers)
        prop_rows.extend(rows)
        matched = sum(1 for r in rows if r["player_id"]) 
        log(f"[oddsapi]   {ev['away_team']}@{ev['home_team']}: {len(rows)} rows, "
            f"{matched} with player ids, remaining {used.get('remaining')}")
    return prop_rows, game_rows, used
