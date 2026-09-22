"""Sports Game Odds (sportsgameodds.com): the multi-book feed that does not
depend on ESPN.

Why this one. ESPN's feed is an undocumented public endpoint: free and exact,
but nothing promises it tomorrow, and it carries one book. The Odds API is
documented but bills per market per game, so its free 500 credits cover about
three pulls a month. Sports Game Odds bills per *game* instead, whatever
markets and books come back, and its free plan is 2,500 games a month with
nine books (DraftKings, FanDuel, BetMGM, Caesars, ESPN BET, Bovada, Unibet,
PointsBet, William Hill) and player props. A 16-game week pulled four times a
day for a month is about 1,900.

    GET https://api.sportsgameodds.com/v2/events?leagueID=NFL&oddsAvailable=true
        header x-api-key: <SGO_API_KEY>

Each event carries ``odds`` keyed by an ``oddID`` of the form
``{statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}``, for example
``receiving_yards-JAMES_COOK_1_NFL-game-ou-over``, with per-book numbers under
``byBookmaker.<bookmakerID>``, and a ``players`` map naming each playerID.
Players are matched to gsis ids by name with the game's two teams as the
tiebreak, as The Odds API's are.

The monthly budget is counted here, one object per event returned, in
``data/odds/sgo_usage.json``; a pull that would cross ``SGO_MONTHLY_OBJECTS``
is refused before it is made.
"""

from __future__ import annotations

import json
from datetime import datetime

import requests

from ..config import SGO_MONTHLY_OBJECTS, SGO_USAGE_PATH, sgo_api_key
from ..stats.players import match_name
from .common import match_game, parse_american, team_abbr, week_window
from .markets import BOOKS, BY_KEY
from .store import now_utc

BASE = "https://api.sportsgameodds.com/v2"
SOURCE = "sgo"
TIMEOUT = 30
PAGE = 25

#: Sports Game Odds statID -> our canonical market key (markets.py). The
#: statIDs are from their published NFL stat list. Anything not here is
#: skipped and counted, so a new market shows up in the pull log.
STAT_TO_MARKET: dict[str, str] = {
    "passing_yards": "player_pass_yds",
    "passing_touchdowns": "player_pass_tds",
    "passing_completions": "player_pass_completions",
    "passing_attempts": "player_pass_attempts",
    "passing_interceptions": "player_pass_interceptions",
    "passing_longestCompletion": "player_pass_longest_completion",
    "passing+rushing_yards": "player_pass_rush_yds",
    "rushing_yards": "player_rush_yds",
    "rushing_attempts": "player_rush_attempts",
    "rushing_longestRush": "player_rush_longest",
    "rushing_touchdowns": "player_rush_tds",
    "receiving_yards": "player_reception_yds",
    "receiving_receptions": "player_receptions",
    "receiving_longestReception": "player_reception_longest",
    "receiving_touchdowns": "player_reception_tds",
    "rushing+receiving_yards": "player_rush_reception_yds",
    "touchdowns": "player_anytime_td",
    "firstTouchdown": "player_1st_td",
    "lastTouchdown": "player_last_td",
    "kicking_totalPoints": "player_kicking_points",
    "fieldGoals_made": "player_field_goals",
    "extraPoints_kicksMade": "player_pats",
    "defense_combinedTackles": "player_tackles_assists",
    "defense_soloTackles": "player_solo_tackles",
    "defense_assistedTackles": "player_assists",
    "defense_sacks": "player_sacks",
    "defense_interceptions": "player_defensive_interceptions",
}
#: Their bookmakerIDs that differ from ours.
BOOK_ALIAS = {"williamhill": "williamhill_us", "pointsbet": "pointsbetus", "unibet": "unibet_us", "espnbet": "espnbet"}


class SgoError(RuntimeError):
    pass


# --- budget ------------------------------------------------------------------

def _month() -> str:
    return now_utc().strftime("%Y-%m")


def usage() -> dict:
    """{"month": "2026-09", "objects": 312, "limit": 2400} for this month."""
    data: dict = {}
    if SGO_USAGE_PATH.exists():
        try:
            data = json.loads(SGO_USAGE_PATH.read_text())
        except json.JSONDecodeError:
            data = {}
    if data.get("month") != _month():
        data = {"month": _month(), "objects": 0}
    data["limit"] = SGO_MONTHLY_OBJECTS
    return data


def _spend(n: int) -> dict:
    u = usage()
    u["objects"] = int(u.get("objects", 0)) + n
    u["at"] = now_utc().isoformat()
    SGO_USAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
    SGO_USAGE_PATH.write_text(json.dumps(u, indent=2))
    return u


# --- fetching ----------------------------------------------------------------

def _get(params: dict) -> dict:
    key = sgo_api_key()
    if not key:
        raise SgoError("SGO_API_KEY is not set. Put it in the repo-root .env file (free at sportsgameodds.com).")
    r = requests.get(f"{BASE}/events", params=params, headers={"x-api-key": key}, timeout=TIMEOUT)
    if r.status_code in (401, 403):
        raise SgoError(f"Sports Game Odds rejected the key ({r.status_code}).")
    if r.status_code == 429:
        raise SgoError("Sports Game Odds rate limit or monthly quota reached (429).")
    r.raise_for_status()
    body = r.json()
    if body.get("success") is False:
        raise SgoError(f"Sports Game Odds: {body.get('error') or 'request failed'}")
    return body


def fetch_events(season: int, week: int, expected: int, log=print) -> list[dict]:
    """The week's NFL events with odds, page by page. ``expected`` is the
    number of games left in the week, checked against the budget first."""
    u = usage()
    if u["objects"] + expected > SGO_MONTHLY_OBJECTS:
        raise SgoError(f"monthly budget: {u['objects']} of {SGO_MONTHLY_OBJECTS} objects used, "
                       f"this pull needs about {expected}. Raise SGO_MONTHLY_OBJECTS on a paid plan.")
    lo, hi = week_window(season, week)
    params = {"leagueID": "NFL", "oddsAvailable": "true", "startsAfter": lo, "startsBefore": hi, "limit": PAGE}
    out: list[dict] = []
    while True:
        body = _get(params)
        page = body.get("data") or []
        out.extend(page)
        _spend(len(page))
        cursor = body.get("nextCursor")
        if not cursor or not page:
            break
        params = {**params, "cursor": cursor}
    log(f"[sgo] {len(out)} events; {usage()['objects']} of {SGO_MONTHLY_OBJECTS} objects used this month")
    return out


# --- parsing -----------------------------------------------------------------

def _team(ev: dict, side: str) -> str | None:
    """Their team as our abbreviation: the short name ("BUF") when given,
    else the full name, else the teamID ("BUFFALO_BILLS_NFL")."""
    t = (ev.get("teams") or {}).get(side) or {}
    names = t.get("names") or {}
    tid = t.get("teamID") or ""
    from_id = " ".join(w.title() for w in tid.split("_") if w and w != "NFL") if tid else None
    for cand in (names.get("short"), names.get("long"), names.get("medium"), from_id):
        abbr = team_abbr(cand)
        if abbr:
            return abbr
    return None


def _num(x) -> float | None:
    try:
        return None if x is None or x == "" else float(x)
    except (TypeError, ValueError):
        return None


def _book(book_id: str) -> str:
    return BOOK_ALIAS.get(book_id, book_id)


def parse_event(ev: dict, season: int, week: int, pulled_at: datetime) -> tuple[list[dict], list[dict], dict[str, int]]:
    """One event -> (prop rows, game rows, {unmapped statID: count})."""
    home, away = _team(ev, "home"), _team(ev, "away")
    starts = (ev.get("status") or {}).get("startsAt")
    game = match_game(season, home, away, starts, week=week)
    base = {
        "pulled_at": pulled_at, "source": SOURCE, "season": season, "week": week,
        "game_id": game["game_id"] if game else None, "event_id": ev.get("eventID"),
        "commence_time": starts, "home_team": home, "away_team": away,
    }
    teams = tuple(t for t in (home, away) if t)
    players = ev.get("players") or {}
    names: dict[str, tuple[str | None, str | None]] = {}
    props: list[dict] = []
    games: list[dict] = []
    skipped: dict[str, int] = {}

    for odd_id, odd in (ev.get("odds") or {}).items():
        stat = odd.get("statID")
        entity = odd.get("statEntityID")
        period = odd.get("periodID")
        bet = odd.get("betTypeID")
        side_id = odd.get("sideID")
        if not stat and odd_id.count("-") >= 4:
            stat, entity, period, bet, side_id = odd_id.split("-")[:5]
        if period not in (None, "game"):
            continue
        by_book = odd.get("byBookmaker") or {}

        # Game lines: the whole game's points, both sides.
        if stat == "points" and odd.get("playerID") is None and entity in ("home", "away", "all"):
            market = {"ml": "h2h", "sp": "spreads", "ou": "totals"}.get(bet)
            if not market:
                continue
            side = {"over": "Over", "under": "Under"}.get(side_id) or (home if side_id == "home" else away if side_id == "away" else None)
            if market == "totals" and entity != "all":
                continue      # team totals are not a game line
            for bid, bk in by_book.items():
                if bk.get("available") is False:
                    continue
                line = _num(bk.get("spread")) if market == "spreads" else _num(bk.get("overUnder")) if market == "totals" else None
                games.append({**base, "book": _book(bid), "book_title": BOOKS.get(_book(bid), bid), "market": market,
                              "side": side, "line": line, "price": parse_american(bk.get("odds")),
                              "open_line": None, "open_price": None, "last_update": bk.get("lastUpdatedAt")})
            continue

        pid_sgo = odd.get("playerID") or (entity if entity not in ("home", "away", "all") else None)
        if not pid_sgo:
            continue
        market_key = STAT_TO_MARKET.get(stat or "")
        if not market_key or market_key not in BY_KEY:
            skipped[stat or "?"] = skipped.get(stat or "?", 0) + 1
            continue
        m = BY_KEY[market_key]
        if pid_sgo not in names:
            nm = (players.get(pid_sgo) or {}).get("name")
            if not nm:
                # PLAYER_ID_1_NFL -> "Player Id"
                nm = " ".join(w.title() for w in pid_sgo.split("_") if w and not w.isdigit() and w != "NFL")
            names[pid_sgo] = (nm, match_name(nm, teams) if nm else None)
        name, gsis = names[pid_sgo]
        if m.kind == "yesno":
            # Offered either as yes/no or as over/under 0.5; both mean the same bet.
            side = "Yes" if side_id in ("yes", "over") else "No" if side_id in ("no", "under") else None
        else:
            if bet != "ou":
                continue
            side = "Over" if side_id == "over" else "Under" if side_id == "under" else None
        if side is None:
            continue
        team = None
        pteam = (players.get(pid_sgo) or {}).get("teamID")
        if pteam:
            team = home if pteam == ((ev.get("teams") or {}).get("home") or {}).get("teamID") else away
        for bid, bk in by_book.items():
            if bk.get("available") is False:
                continue
            props.append({**base, "book": _book(bid), "book_title": BOOKS.get(_book(bid), bid), "team": team,
                          "market": m.key, "player_name": name, "player_id": gsis, "side": side,
                          "line": None if m.kind == "yesno" else _num(bk.get("overUnder")),
                          "price": parse_american(bk.get("odds")), "open_line": None, "open_price": None,
                          "last_update": bk.get("lastUpdatedAt")})
    return props, games, skipped


def pull(season: int, week: int, with_games: bool = True, log=print) -> tuple[list[dict], list[dict], dict]:
    """Fetch and parse a week. Returns (prop rows, game rows, usage)."""
    from .common import schedule
    import polars as pl
    sched = schedule(season).filter(pl.col("week") == week)
    remaining = sched.filter(pl.col("home_score").is_null()).height or sched.height
    pulled_at = now_utc()
    props: list[dict] = []
    games: list[dict] = []
    skipped: dict[str, int] = {}
    for ev in fetch_events(season, week, remaining, log=log):
        p, g, s = parse_event(ev, season, week, pulled_at)
        props.extend(p)
        if with_games:
            games.extend(g)
        for k, v in s.items():
            skipped[k] = skipped.get(k, 0) + v
    matched = sum(1 for r in props if r["player_id"])
    log(f"[sgo] {len(props)} prop rows ({matched} matched to players), {len(games)} game-line rows")
    if skipped:
        top = ", ".join(f"{k} ({v})" for k, v in sorted(skipped.items(), key=lambda kv: -kv[1])[:8])
        log(f"[sgo] markets not mapped, skipped: {top}")
    return props, games, usage()
