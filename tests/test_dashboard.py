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


def test_fantasy_projection_needs_games_and_scales_by_matchup():
    from dashboard.stats.fantasy import MIN_GAMES, _proj, _role
    games = [{"fantasy_points_ppr": v} for v in (10.0, 12.0, 14.0, 16.0)]
    assert _proj(games[:MIN_GAMES - 1], "fantasy_points_ppr", 1.0) is None
    neutral, easy = _proj(games, "fantasy_points_ppr", 1.0), _proj(games, "fantasy_points_ppr", 1.2)
    # Recency-weighted: the latest games pull the mean above the plain average of 13.
    assert neutral["base"] > 13 and neutral["last3"] == 14.0
    assert easy["value"] == pytest.approx(neutral["value"] * 1.2, abs=0.1)
    assert 0 <= neutral["low"] < neutral["value"] < neutral["high"]
    # Role: targets plus carries for a receiver, attempts plus carries for a quarterback.
    g = [{"targets": 4, "carries": 0, "attempts": 30}] * 5 + [{"targets": 9, "carries": 1, "attempts": 40}] * 3
    assert _role(g, "WR") == {"last3": 10.0, "before": 4.0}
    assert _role(g, "QB")["last3"] == 41.0
    assert _role(g[:3], "WR") is None


def test_half_ppr_is_the_midpoint_of_standard_and_ppr():
    df = pl.DataFrame({"fantasy_points": [10.0, 3.5], "fantasy_points_ppr": [16.0, 5.5]})
    half = df.select(catalog.BY_KEY["fantasy_points_half"].expr.alias("h"))["h"].to_list()
    assert half == [13.0, 4.5]


def test_kicker_scoring_by_distance_with_misses():
    row = pl.DataFrame({"fg_made_0_19": [0], "fg_made_20_29": [1], "fg_made_30_39": [1], "fg_made_40_49": [1],
                        "fg_made_50_59": [1], "fg_made_60_": [0], "fg_missed": [1], "pat_made": [3], "pat_missed": [1]})
    # 3 + 3 + 4 + 5 for the field goals, 3 PATs, minus a missed field goal and a missed PAT.
    assert row.select(catalog.kicker_points_expr().alias("k"))["k"].item() == 3 + 3 + 4 + 5 + 3 - 1 - 1


def test_dst_points_allowed_tiers_and_their_expectation():
    from dashboard.stats.fantasy import expected_pa_points, pa_points
    assert [pa_points(x) for x in (0, 3, 10, 17, 24, 31, 40)] == [10, 7, 4, 1, 0, -1, -4]
    # Facing a weaker offense is worth more, and the expectation stays inside the tiers.
    low, mid, high = expected_pa_points(14), expected_pa_points(22), expected_pa_points(32)
    assert 10 > low > mid > high > -4


def test_floor_and_ceiling_come_from_the_players_own_games_around_the_projection():
    from dashboard.stats.fantasy import finish, simulate
    steady = [14.0, 15.0, 13.0, 14.0, 16.0, 14.0, 15.0, 13.0]
    boomy = [4.0, 5.0, 30.0, 6.0, 28.0, 5.0, 4.0, 31.0]
    s_lo, s_hi = simulate(steady, 14.0, 2.0)
    b_lo, b_hi = simulate(boomy, 14.0, 2.0)
    assert s_lo < 14.0 < s_hi and b_lo < 14.0 < b_hi
    assert (b_hi - b_lo) > 2 * (s_hi - s_lo)       # a boom-or-bust player gets the wider range
    assert simulate([], 10.0, 2.0)[0] >= 0          # too few games: a normal range, never below zero
    # ESPN's number is the centre when it has one, in every format.
    espn = {"p1": {"ppr": 18.0, "rec": 6.0}}
    out = finish("p1", espn, {"ppr": steady, "half": steady, "std": steady}, {"ppr": 12.0, "half": 11.0, "std": 10.0}, 2.0)
    assert [out[k]["value"] for k in ("ppr", "half", "std")] == [18.0, 15.0, 12.0]
    assert out["ppr"]["source"] == "espn" and out["ppr"]["base"] == 12.0
    fallback = finish("p2", espn, {"ppr": steady}, {"ppr": 12.0, "half": None, "std": None}, 2.0)
    assert fallback["ppr"]["source"] == "baseline" and fallback["ppr"]["value"] == 12.0 and fallback["half"] is None


def test_espn_file_decides_who_plays_this_week(monkeypatch):
    from dashboard.stats import fantasy
    monkeypatch.setattr(fantasy, "_players_info", lambda pids: {"bk": {"display_name": "Backup QB", "headshot": None}})
    game = {"opponent": "DAL", "home": True, "game_id": "g1", "gameday": "2026-09-27", "implied": 24.0}
    opp_of = {"WAS": game, "DAL": {**game, "opponent": "WAS", "home": False}}
    row = lambda pid, pos, rank, status=None: {"player_id": pid, "name": pid, "position": pos, "team": "WAS", "depth_rank": rank,
                                                "headshot": None, "new_to_team": False, "stats_team": "WAS", "target_share": None,
                                                "carry_share": None, "status": status, "injury": None, **game}
    roster = [row("qb1", "QB", 1), row("wr1", "WR", 1, "DNP"), row("cut", "WR", 2), row("traded", "WR", 3)]
    e = lambda ppr, team="WAS", pos="QB", status=None: {"ppr": ppr, "rec": 0.0, "team": team, "position": pos, "name": "", "status": status}
    espn = {"qb1": e(0.0), "bk": e(15.3), "wr1": e(12.0, pos="WR", status="Questionable"), "cut": e(3.0, team=None, pos="WR"),
            "traded": e(8.0, team="DAL", pos="WR"), "deep": e(0.5, pos="WR")}
    out = {r["player_id"]: r for r in fantasy.reconcile(roster, espn, opp_of, 2026)}
    # The starter ESPN zeroes is marked, and the backup it projects takes his place.
    assert out["qb1"]["status"] == fantasy.NOT_PLAYING and out["qb1"]["depth_rank"] == 2
    assert out["bk"]["depth_rank"] == 1 and out["bk"]["name"] == "Backup QB" and out["bk"]["team"] == "WAS"
    # A game status beats practice participation; a released player leaves; a traded one moves.
    assert out["wr1"]["status"] == "Questionable"
    assert "cut" not in out and "deep" not in out
    assert out["traded"]["team"] == "DAL" and out["traded"]["opponent"] == "WAS" and out["traded"]["new_to_team"]
    # Without a file, only the practice wording changes.
    plain = fantasy.reconcile([row("wr1", "WR", 1, "DNP")], {}, opp_of, 2026)
    assert plain[0]["status"] == "Missed practice" and plain[0]["depth_rank"] == 1


def test_espn_projection_parse_keeps_injury_status(monkeypatch):
    from dashboard.odds import espn_proj
    monkeypatch.setattr(espn_proj, "_espn_to_gsis", lambda: {"101": {"player_id": "00-1"}})
    stat = {"statSourceId": 1, "statSplitTypeId": 1, "scoringPeriodId": 3, "seasonId": 2026, "appliedTotal": 0.0, "stats": {}}
    players = [{"player": {"id": 101, "fullName": "Hurt Starter", "defaultPositionId": 1, "proTeamId": 28, "injuryStatus": "OUT",
                           "ownership": {"percentOwned": 97.4}, "stats": [stat]}},
               {"player": {"id": 999, "fullName": "No Id Yet", "defaultPositionId": 3, "proTeamId": 28, "stats": [stat]}}]
    rows = espn_proj.parse(players, 2026, 3)
    assert len(rows) == 1 and rows[0]["injury_status"] == "Out" and rows[0]["pct_owned"] == 97.4 and rows[0]["team"] == "WAS"


def test_recent_games_ride_along_in_every_format():
    from dashboard.stats.fantasy import RECENT_N, SCORINGS, _recent
    games = [{"season": 2026, "week": w, "opponent_team": "DAL", "fantasy_points": 10.0 + w, "fantasy_points_ppr": 14.0 + w,
              "fantasy_points_half": 12.0 + w} for w in range(1, 12)]
    out = _recent(games, SCORINGS)
    assert len(out) == RECENT_N and out[-1]["week"] == 11 and out[0]["week"] == 11 - RECENT_N + 1   # the latest, oldest first
    assert out[-1]["pts"] == {"ppr": 25.0, "half": 23.0, "std": 21.0} and out[-1]["opp"] == "DAL"
    # A kicker or defense scores every format alike.
    k = _recent([{"season": 2026, "week": 2, "opponent_team": "IND", "kick_pts": 16}], same="kick_pts")
    assert k[0]["pts"] == {"ppr": 16.0, "half": 16.0, "std": 16.0}
