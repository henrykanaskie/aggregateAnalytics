"""Generated sample lines, for driving the UI before any real feed is pulled.

Lines are built from each player's previous-season per-game averages with a
different random nudge per book, so the board has something to show for
consensus and outliers. Every row is stamped ``source="sample"`` and the store
drops sample rows the moment a real snapshot exists for the same week. The UI
shows a banner whenever it is looking at sample data.
"""

from __future__ import annotations

import random

import polars as pl

from nfl.data import scan

from ..stats.players import player_index
from .common import schedule
from .markets import BY_KEY
from .store import now_utc

SOURCE = "sample"
SAMPLE_BOOKS = ["draftkings", "fanduel", "betmgm", "caesars", "betrivers"]
TITLES = {"draftkings": "DraftKings", "fanduel": "FanDuel", "betmgm": "BetMGM",
          "caesars": "Caesars", "betrivers": "BetRivers"}

# position -> (market, stat column, rounding step)
MENU = {
    "QB": [("player_pass_yds", "passing_yards", 0.5), ("player_pass_tds", "passing_tds", 0.5),
           ("player_pass_completions", "completions", 0.5), ("player_pass_attempts", "attempts", 0.5),
           ("player_pass_interceptions", "passing_interceptions", 0.5), ("player_rush_yds", "rushing_yards", 0.5)],
    "RB": [("player_rush_yds", "rushing_yards", 0.5), ("player_rush_attempts", "carries", 0.5),
           ("player_reception_yds", "receiving_yards", 0.5), ("player_receptions", "receptions", 0.5),
           ("player_rush_reception_yds", "rush_rec_yards", 0.5), ("player_anytime_td", "total_tds", None)],
    "WR": [("player_reception_yds", "receiving_yards", 0.5), ("player_receptions", "receptions", 0.5),
           ("player_anytime_td", "total_tds", None)],
    "TE": [("player_reception_yds", "receiving_yards", 0.5), ("player_receptions", "receptions", 0.5),
           ("player_anytime_td", "total_tds", None)],
    "K": [("player_kicking_points", "kicking_points", 0.5), ("player_field_goals", "fg_made", 0.5)],
}
PER_TEAM = {"QB": 1, "RB": 2, "WR": 3, "TE": 1, "K": 1}


def _half(x: float) -> float:
    return round(x * 2) / 2 + (0.5 if round(x * 2) / 2 == round(x) else 0.0)


def generate(season: int, week: int, seed: int = 7) -> tuple[list[dict], list[dict]]:
    rng = random.Random(seed * 1000 + season * 100 + week)
    pulled_at = now_utc()
    games = schedule(season).filter(pl.col("week") == week)
    prev = season - 1
    idx = player_index()
    stats = (
        scan("player_stats_week")
        .filter(pl.col("season") == prev)
        .group_by("player_id")
        .agg(
            pl.len().alias("g"),
            pl.col("passing_yards").mean(), pl.col("passing_tds").mean(), pl.col("completions").mean(),
            pl.col("attempts").mean(), pl.col("passing_interceptions").mean(),
            pl.col("rushing_yards").mean(), pl.col("carries").mean(), pl.col("receiving_yards").mean(),
            pl.col("receptions").mean(),
            (pl.col("rushing_yards") + pl.col("receiving_yards")).mean().alias("rush_rec_yards"),
            ((pl.col("rushing_tds") + pl.col("receiving_tds")) >= 1).mean().alias("total_tds"),
            (pl.col("fg_made") * 3 + pl.col("pat_made")).mean().alias("kicking_points"),
            pl.col("fg_made").mean(), pl.col("fantasy_points_ppr").sum().alias("ppr"),
        )
        .filter(pl.col("g") >= 6)
        .collect()
        .join(idx.select("player_id", "name", "position", "team"), on="player_id")
    )
    prop_rows: list[dict] = []
    game_rows: list[dict] = []
    for g in games.to_dicts():
        base = {
            "pulled_at": pulled_at, "source": SOURCE, "season": season, "week": week,
            "game_id": g["game_id"], "event_id": g["game_id"], "commence_time": f"{g['gameday']}T{g['gametime']}:00",
            "home_team": g["home_team"], "away_team": g["away_team"], "last_update": pulled_at.isoformat(),
        }
        # game lines from the schedule's closing-ish numbers, nudged per book
        for book in SAMPLE_BOOKS:
            sp = g["spread_line"] or 0.0
            tot = g["total_line"] or 44.5
            nudge = rng.choice([-1, -0.5, 0, 0, 0, 0.5, 1]) * 0.5
            for side, line in ((g["home_team"], -(sp + nudge)), (g["away_team"], sp + nudge)):
                game_rows.append({**base, "book": book, "book_title": TITLES[book], "market": "spreads",
                                  "side": side, "line": line, "price": rng.choice([-105, -108, -110, -112, -115]),
                                  "open_line": line + rng.choice([-1, 0, 0, 0.5]), "open_price": -110})
            for side in ("Over", "Under"):
                game_rows.append({**base, "book": book, "book_title": TITLES[book], "market": "totals",
                                  "side": side, "line": tot + nudge, "price": rng.choice([-105, -110, -115]),
                                  "open_line": tot, "open_price": -110})
        for team in (g["home_team"], g["away_team"]):
            roster = stats.filter(pl.col("team") == team).sort("ppr", descending=True)
            for pos, n in PER_TEAM.items():
                for p in roster.filter(pl.col("position") == pos).head(n).to_dicts():
                    for market, col, step in MENU[pos]:
                        m = BY_KEY[market]
                        mu = p.get(col)
                        if mu is None:
                            continue
                        if m.kind == "yesno":
                            prob = max(0.05, min(0.85, float(mu)))
                            for book in SAMPLE_BOOKS:
                                pr = prob * rng.uniform(0.9, 1.12)
                                price = int(round(-100 * pr / (1 - pr))) if pr >= 0.5 else int(round(100 * (1 - pr) / pr))
                                prop_rows.append({**base, "book": book, "book_title": TITLES[book], "team": team,
                                                  "market": market, "player_name": p["name"],
                                                  "player_id": p["player_id"], "side": "Yes", "line": None,
                                                  "price": price, "open_line": None, "open_price": None})
                            continue
                        if mu < 0.4:
                            continue
                        centre = _half(float(mu))
                        for book in SAMPLE_BOOKS:
                            unit = max(step, m.threshold / 3)
                            k = rng.choice([-1, 0, 0, 0, 0, 1])
                            if rng.random() < 0.06:
                                k = rng.choice([-3, 3])      # the occasional true outlier
                            line = max(0.5, centre + k * unit)
                            over = rng.choice([-125, -120, -115, -110, -110, -105, 100, 105])
                            under = -230 - over if over < 0 else -220 + over
                            for side, price in (("Over", over), ("Under", under)):
                                prop_rows.append({**base, "book": book, "book_title": TITLES[book], "team": team,
                                                  "market": market, "player_name": p["name"],
                                                  "player_id": p["player_id"], "side": side, "line": line,
                                                  "price": price, "open_line": centre, "open_price": -110})
    return prop_rows, game_rows
