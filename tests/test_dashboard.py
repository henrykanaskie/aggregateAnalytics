"""Dashboard unit tests. Pure logic only, no parquet cache needed, except the
two marked ``needs_data``."""

from __future__ import annotations

from datetime import datetime, timezone

import polars as pl
import pytest

from dashboard.odds import markets
from dashboard.odds.analysis import build_board
from dashboard.odds.common import american_to_decimal, decimal_to_american, implied_prob, parse_american, team_abbr
from dashboard.stats import catalog


def test_catalog_keys_unique_and_markets_point_at_real_stats():
    keys = [s.key for s in catalog.STATS]
    assert len(keys) == len(set(keys))
    for m in markets.MARKETS:
        assert m.stat is None or m.stat in catalog.BY_KEY, m.key
    espn = [m.espn_type for m in markets.MARKETS if m.espn_type]
    assert len(espn) == len(set(espn))


def test_odds_arithmetic_round_trips():
    for a in (-110, +150, -250, +100):
        assert decimal_to_american(american_to_decimal(a)) == a
    assert abs(implied_prob(-110) - 0.5238) < 1e-3
    assert parse_american("EVEN") == 100 and parse_american("+142") == 142 and parse_american(-110.0) == -110


def test_team_abbr_aliases():
    assert team_abbr("WSH") == "WAS" and team_abbr("LAR") == "LA"


def _row(book: str, side: str, line: float, price: int, player="A. Player", market="player_reception_yds"):
    return {
        "pulled_at": datetime(2026, 9, 8, tzinfo=timezone.utc), "source": "test", "book": book, "book_title": book,
        "season": 2026, "week": 1, "game_id": "2026_01_A_B", "event_id": "e1", "commence_time": None,
        "home_team": "B", "away_team": "A", "team": "A", "market": market, "player_name": player, "player_id": None,
        "side": side, "line": line, "price": price, "open_line": line - 1, "open_price": None, "last_update": None,
    }


@pytest.mark.needs_data
def test_board_consensus_and_outlier_flag():
    rows = []
    for book, line in (("draftkings", 60.5), ("fanduel", 61.5), ("betmgm", 60.5), ("caesars", 68.5)):
        rows += [_row(book, "Over", line, -110), _row(book, "Under", line, -110)]
    board = build_board(pl.DataFrame(rows))
    assert len(board) == 1
    r = board[0]
    assert r["consensus"] == 61.0                       # median of 60.5, 61.5, 60.5, 68.5
    assert r["outliers"] == ["caesars"]                 # 7.5 above the median, threshold 4.5
    flags = {b["book"]: b["flag"] for b in r["books"]}
    assert flags["caesars"] == "high" and flags["draftkings"] is None
    assert r["best_over"]["book"] in ("draftkings", "betmgm") and r["best_over"]["line"] == 60.5
    assert r["best_under"]["book"] == "caesars"
    assert all(b["moved"] == 1.0 for b in r["books"])


def test_personnel_parser_handles_both_feed_formats():
    from dashboard.stats.pbp import _personnel
    df = pl.DataFrame({"p": ["1 RB, 1 TE, 3 WR", "1 C, 2 G, 1 QB, 2 RB, 2 T, 1 TE, 2 WR", "1 FB, 1 RB, 1 TE, 2 WR", "", None]})
    out = df.with_columns(_personnel("p").alias("g"))["g"].to_list()
    assert out == ["11 personnel", "21 personnel", "21 personnel", None, None]


@pytest.mark.needs_data
def test_game_log_has_every_catalog_key():
    from dashboard.stats.gamelog import game_log
    df = game_log("00-0036900")     # Ja'Marr Chase
    assert not df.is_empty()
    for s in catalog.STATS:
        assert s.key in df.columns
    assert df["home"].null_count() == 0


@pytest.mark.needs_data
def test_dvp_ranks_count_down_from_most_allowed():
    from dashboard.stats.context import dvp_table
    t = dvp_table(2025, "RB")
    assert t.height == 32
    top = t.sort("rushing_yards", descending=True).row(0, named=True)
    assert top["rushing_yards_rank"] == 1


@pytest.mark.needs_data
def test_team_usage_shares_sum_to_one():
    from dashboard.stats.context import team_usage
    u = team_usage("MIA", 2025)
    assert abs(u["target_share"].sum() - 1.0) < 1e-6
    assert abs(u["carry_share"].sum() - 1.0) < 1e-6
