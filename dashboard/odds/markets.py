"""Canonical prop markets and how each maps onto a catalog stat.

Keys follow The Odds API naming because it is the most complete public
vocabulary; every other provider is translated into these. ``stat`` is the
catalog key whose game-log values the line is compared against.

``threshold`` is the line gap from the cross-book consensus at which a single
book is highlighted as an outlier. It is deliberately market-specific: half a
reception is nothing, half a passing touchdown is a different bet.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Market:
    key: str
    label: str
    stat: str | None
    kind: str            # "ou" (over/under with a line) or "yesno" (price only)
    group: str
    espn_type: str | None = None
    threshold: float = 1.0
    positions: tuple[str, ...] = ()


PASS, RUSH, REC = ("QB",), ("RB", "QB", "WR"), ("WR", "TE", "RB")
DEF = ("LB", "DE", "DT", "CB", "S", "SS", "FS", "OLB", "ILB", "MLB", "NT", "DB")

MARKETS: list[Market] = [
    Market("player_pass_yds", "Passing yards", "passing_yards", "ou", "Passing", "8", 6.0, PASS),
    Market("player_pass_tds", "Passing TDs", "passing_tds", "ou", "Passing", "10", 0.5, PASS),
    Market("player_pass_completions", "Completions", "completions", "ou", "Passing", "9", 1.5, PASS),
    Market("player_pass_attempts", "Pass attempts", "attempts", "ou", "Passing", "16", 2.0, PASS),
    Market("player_pass_interceptions", "Interceptions thrown", "passing_interceptions", "ou", "Passing", "15", 0.5, PASS),
    Market("player_pass_longest_completion", "Longest completion", "long_completion", "ou", "Passing", "17", 3.0, PASS),
    Market("player_pass_rush_yds", "Pass + rush yards", "pass_rush_yards", "ou", "Passing", "18", 6.0, PASS),
    Market("player_rush_yds", "Rushing yards", "rushing_yards", "ou", "Rushing", "12", 4.5, RUSH),
    Market("player_rush_attempts", "Carries", "carries", "ou", "Rushing", "11", 1.5, RUSH),
    Market("player_rush_longest", "Longest rush", "long_rush", "ou", "Rushing", "21", 2.5, RUSH),
    Market("player_rush_tds", "Rushing TDs", "rushing_tds", "ou", "Rushing", None, 0.5, RUSH),
    Market("player_reception_yds", "Receiving yards", "receiving_yards", "ou", "Receiving", "13", 4.5, REC),
    Market("player_receptions", "Receptions", "receptions", "ou", "Receiving", "14", 1.0, REC),
    Market("player_reception_longest", "Longest reception", "long_reception", "ou", "Receiving", "19", 2.5, REC),
    Market("player_reception_tds", "Receiving TDs", "receiving_tds", "ou", "Receiving", None, 0.5, REC),
    Market("player_rush_reception_yds", "Rush + rec yards", "rush_rec_yards", "ou", "Combined", "20", 4.5, RUSH + REC),
    Market("player_rush_reception_tds", "Rush + rec TDs", "rush_rec_tds", "ou", "Combined", None, 0.5, RUSH + REC),
    Market("player_pass_rush_reception_yds", "Pass + rush + rec yards", "pass_rush_rec_yards", "ou", "Combined", None, 6.0),
    Market("player_pass_rush_reception_tds", "Pass + rush + rec TDs", "pass_rush_rec_tds", "ou", "Combined", None, 0.5),
    Market("player_anytime_td", "Anytime TD", "total_tds", "yesno", "Touchdowns", "31", 0.0, RUSH + REC),
    Market("player_1st_td", "First TD scorer", "total_tds", "yesno", "Touchdowns", "29", 0.0, RUSH + REC),
    Market("player_last_td", "Last TD scorer", "total_tds", "yesno", "Touchdowns", "30", 0.0, RUSH + REC),
    Market("player_kicking_points", "Kicking points", "kicking_points", "ou", "Kicking", "22", 1.5, ("K",)),
    Market("player_field_goals", "Field goals made", "fg_made", "ou", "Kicking", "24", 0.5, ("K",)),
    Market("player_pats", "PATs made", "pat_made", "ou", "Kicking", "23", 0.5, ("K",)),
    Market("player_tackles_assists", "Tackles + assists", "tackles_combined", "ou", "Defense", "27", 1.0, DEF),
    Market("player_solo_tackles", "Solo tackles", "def_tackles_solo", "ou", "Defense", "26", 1.0, DEF),
    Market("player_assists", "Assisted tackles", "def_tackle_assists", "ou", "Defense", "25", 1.0, DEF),
    Market("player_sacks", "Sacks", "def_sacks", "ou", "Defense", "28", 0.5, DEF),
    Market("player_defensive_interceptions", "Defensive INTs", "def_interceptions", "ou", "Defense", None, 0.5, DEF),
]

BY_KEY: dict[str, Market] = {m.key: m for m in MARKETS}
ESPN_TYPES: dict[str, Market] = {m.espn_type: m for m in MARKETS if m.espn_type}

#: What a full Odds API pull requests by default. Each market costs one credit
#: per event per region, so 11 markets x 16 games = 176 credits a pull.
DEFAULT_ODDSAPI_MARKETS: list[str] = [
    "player_pass_yds", "player_pass_tds", "player_pass_completions", "player_pass_attempts",
    "player_pass_interceptions", "player_rush_yds", "player_rush_attempts",
    "player_reception_yds", "player_receptions", "player_rush_reception_yds", "player_anytime_td",
]

#: Sportsbook keys we display, in the order the board lists them. Anything
#: else that shows up in a feed is still stored and shown after these.
BOOKS: dict[str, str] = {
    "draftkings": "DraftKings", "fanduel": "FanDuel", "betmgm": "BetMGM", "caesars": "Caesars",
    "betrivers": "BetRivers", "espnbet": "ESPN BET", "fanatics": "Fanatics", "bovada": "Bovada",
    "betonlineag": "BetOnline", "pointsbetus": "PointsBet", "williamhill_us": "Caesars (WH)",
    "hardrockbet": "Hard Rock", "ballybet": "Bally Bet", "betparx": "betPARX", "unibet_us": "Unibet",
    "lowvig": "LowVig", "mybookieag": "MyBookie", "superbook": "SuperBook", "wynnbet": "WynnBET",
    "pinnacle": "Pinnacle", "novig": "Novig", "prophetx": "ProphetX", "fliff": "Fliff",
}


def market_json() -> list[dict]:
    return [
        {"key": m.key, "label": m.label, "stat": m.stat, "kind": m.kind, "group": m.group,
         "threshold": m.threshold, "positions": list(m.positions), "espn": m.espn_type is not None}
        for m in MARKETS
    ]
