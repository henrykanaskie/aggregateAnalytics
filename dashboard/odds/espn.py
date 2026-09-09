"""ESPN's public (unauthenticated) odds feed.

Two endpoints, no key, no quota that we have hit:

    site.api.espn.com  .../scoreboard?dates=2026&seasontype=2&week=1
        event ids, kickoff times, and a DraftKings game line

    sports.core.api.espn.com  .../events/{id}/competitions/{id}/odds/100/propBets
        DraftKings player props: *lines only*, current and open, no prices.
        Provider 100 is DraftKings; it is the only one ESPN publishes props for.

Because it carries ESPN athlete ids, players resolve through the ``players``
master table (``espn_id``) rather than by name. That is the main reason this
provider is worth having alongside The Odds API even though it is one book:
the ids are exact, it is free, and it gives an opening line.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache

import polars as pl
import requests

from nfl.data import RAW_DIR

from ..config import CURRENT_SEASON, ESPN_CACHE
from .common import match_game, parse_american, team_abbr
from .markets import ESPN_TYPES
from .store import now_utc

SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
DK_PROVIDER = "100"
SOURCE = "espn"
BOOK = "draftkings"
BOOK_TITLE = "DraftKings (via ESPN)"
TIMEOUT = 25
# ESPN returns 403 to unfamiliar User-Agent strings; the requests default is fine.
HEADERS: dict[str, str] = {}


def _get(url: str, **params) -> dict:
    r = requests.get(url, params=params, timeout=TIMEOUT, headers=HEADERS)
    r.raise_for_status()
    return r.json()


@lru_cache(maxsize=1)
def _espn_to_gsis() -> dict[str, dict]:
    p = pl.read_parquet(RAW_DIR / "players.parquet").filter(pl.col("espn_id").is_not_null())
    return {
        r["espn_id"]: {"player_id": r["gsis_id"], "name": r["display_name"], "team": r["latest_team"]}
        for r in p.select("espn_id", "gsis_id", "display_name", "latest_team").to_dicts()
    }


def _athlete_cache() -> dict[str, dict]:
    if ESPN_CACHE.exists():
        try:
            return json.loads(ESPN_CACHE.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def _save_athlete_cache(cache: dict) -> None:
    ESPN_CACHE.parent.mkdir(parents=True, exist_ok=True)
    ESPN_CACHE.write_text(json.dumps(cache, indent=0, sort_keys=True))


def resolve_athlete(espn_id: str, cache: dict) -> dict:
    """ESPN athlete id -> {player_id, name, team}. Falls back to one network
    call per unknown athlete, memoised on disk."""
    hit = _espn_to_gsis().get(espn_id)
    if hit:
        return hit
    if espn_id in cache:
        return cache[espn_id]
    try:
        a = _get(f"{CORE}/seasons/{CURRENT_SEASON}/athletes/{espn_id}")
        info = {"player_id": None, "name": a.get("displayName") or a.get("fullName"), "team": None}
    except requests.RequestException:
        info = {"player_id": None, "name": None, "team": None}
    cache[espn_id] = info
    return info


_ID_RE = re.compile(r"/athletes/(\d+)")
_TEAM_RE = re.compile(r"/teams/(\d+)")


def scoreboard(season: int, week: int, seasontype: int = 2) -> list[dict]:
    """Events for a week with nflverse game ids attached."""
    data = _get(SCOREBOARD, dates=str(season), seasontype=str(seasontype), week=str(week))
    out = []
    for ev in data.get("events", []):
        comp = ev["competitions"][0]
        home = away = None
        for c in comp.get("competitors", []):
            ab = team_abbr(c["team"].get("abbreviation"))
            if c.get("homeAway") == "home":
                home = ab
            else:
                away = ab
        game = match_game(season, home, away, ev.get("date"), week=week)
        out.append({
            "event_id": ev["id"], "name": ev.get("shortName"), "commence_time": ev.get("date"),
            "home_team": home, "away_team": away, "game_id": game["game_id"] if game else None,
            "season": season, "week": week,
        })
    return out


def game_lines(event: dict, pulled_at) -> list[dict]:
    """DraftKings spread / total / moneyline with opening numbers, from the
    core odds endpoint."""
    eid = event["event_id"]
    try:
        data = _get(f"{CORE}/events/{eid}/competitions/{eid}/odds")
    except requests.RequestException:
        return []
    rows = []
    base = {
        "pulled_at": pulled_at, "source": SOURCE, "book": BOOK, "book_title": BOOK_TITLE,
        "season": event["season"], "week": event["week"], "game_id": event["game_id"],
        "event_id": eid, "commence_time": event["commence_time"],
        "home_team": event["home_team"], "away_team": event["away_team"],
    }
    for item in data.get("items", []):
        if str(item.get("provider", {}).get("id")) != DK_PROVIDER:
            continue
        upd = item.get("lastUpdated") or item.get("details")
        for side_key, abbr in (("homeTeamOdds", event["home_team"]), ("awayTeamOdds", event["away_team"])):
            o = item.get(side_key) or {}
            cur, opn = o.get("current") or {}, o.get("open") or {}
            spread_line = parse_american((cur.get("pointSpread") or {}).get("american"))
            spread_price = parse_american((cur.get("spread") or {}).get("american"))
            if spread_line is None and item.get("spread") is not None:
                spread_line = item["spread"] if side_key == "homeTeamOdds" else -item["spread"]
            rows.append({**base, "market": "spreads", "side": abbr,
                         "line": float(spread_line) if spread_line is not None else None,
                         "price": spread_price if spread_price is not None else parse_american(o.get("spreadOdds")),
                         "open_line": _f(parse_american((opn.get("pointSpread") or {}).get("american"))),
                         "open_price": parse_american((opn.get("spread") or {}).get("american")),
                         "last_update": upd})
            ml = parse_american((cur.get("moneyLine") or {}).get("american"))
            rows.append({**base, "market": "h2h", "side": abbr, "line": None,
                         "price": ml if ml is not None else parse_american(o.get("moneyLine")),
                         "open_line": None,
                         "open_price": parse_american((opn.get("moneyLine") or {}).get("american")),
                         "last_update": upd})
        total = item.get("overUnder")
        if total is not None:
            for side, price_key in (("Over", "overOdds"), ("Under", "underOdds")):
                rows.append({**base, "market": "totals", "side": side, "line": float(total),
                             "price": parse_american(item.get(price_key)),
                             "open_line": None, "open_price": None, "last_update": upd})
    return rows


def _f(x) -> float | None:
    return None if x is None else float(x)


def props(event: dict, pulled_at, cache: dict) -> list[dict]:
    eid = event["event_id"]
    try:
        data = _get(f"{CORE}/events/{eid}/competitions/{eid}/odds/{DK_PROVIDER}/propBets", limit="1000")
    except requests.RequestException as exc:
        if getattr(exc, "response", None) is not None and exc.response.status_code == 404:
            return []
        raise
    base = {
        "pulled_at": pulled_at, "source": SOURCE, "book": BOOK, "book_title": BOOK_TITLE,
        "season": event["season"], "week": event["week"], "game_id": event["game_id"],
        "event_id": eid, "commence_time": event["commence_time"],
        "home_team": event["home_team"], "away_team": event["away_team"],
    }
    rows: list[dict] = []
    seen: set[tuple] = set()
    for item in data.get("items", []):
        m = ESPN_TYPES.get(str(item.get("type", {}).get("id")))
        if m is None or "athlete" not in item:
            continue
        line = ((item.get("current") or {}).get("target") or {}).get("value")
        if line is None:
            continue    # TD-scorer rows carry no number in this feed
        mid = _ID_RE.search(item["athlete"]["$ref"])
        if not mid:
            continue
        who = resolve_athlete(mid.group(1), cache)
        key = (who["name"], m.key)
        if key in seen:
            continue     # the feed duplicates each prop once per side
        seen.add(key)
        open_line = ((item.get("open") or {}).get("target") or {}).get("value")
        team = who.get("team")
        if team not in (event["home_team"], event["away_team"]):
            team = None
        for side in ("Over", "Under"):
            rows.append({**base, "team": team, "market": m.key, "player_name": who["name"],
                         "player_id": who["player_id"], "side": side, "line": float(line),
                         "price": None, "open_line": _f(open_line), "open_price": None,
                         "last_update": item.get("lastUpdated")})
    return rows


def pull(season: int, week: int, with_games: bool = True, with_props: bool = True,
         log=print) -> tuple[list[dict], list[dict]]:
    """Fetch the whole week. Returns (prop_rows, game_rows); nothing is written."""
    pulled_at = now_utc()
    events = scoreboard(season, week)
    log(f"[espn] {len(events)} events for {season} week {week}")
    cache = _athlete_cache()
    prop_rows: list[dict] = []
    game_rows: list[dict] = []
    for ev in events:
        if with_games:
            game_rows.extend(game_lines(ev, pulled_at))
        if with_props:
            got = props(ev, pulled_at, cache)
            prop_rows.extend(got)
            log(f"[espn]   {ev['name']:<12} {len(got) // 2:>3} props")
    _save_athlete_cache(cache)
    return prop_rows, game_rows
