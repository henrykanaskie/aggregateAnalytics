"""The season blend and the head-to-head view, on a league small enough to
check by hand."""

import polars as pl
import pytest

from dashboard.stats import blend, matchups
from dashboard.stats.team import METRICS

TEAMS = ["AAA", "BBB", "CCC", "DDD"]
_COLS = sorted({m.num for m in METRICS} | {m.den for m in METRICS} - {"games"})


def _game(season, week, team, opp, **vals):
    row = {c: 0.0 for c in _COLS}
    row.update(season=season, week=week, season_type="REG", game_id=f"{season}_{week:02d}_{team}_{opp}",
               team=team, opponent=opp, home=True, games=1)
    row.update(vals)
    return row


def _league(prior_pass: dict[str, int], cur_games: list[tuple[int, str, str, dict]], box: dict | None = None) -> pl.DataFrame:
    """Last season: every team 10 games of 100 plays, ``prior_pass[team]``
    passes a game. ``box`` sets (defense -> box count per rush) for last
    season. This season: whatever ``cur_games`` lists."""
    rows = []
    for t in TEAMS:
        opps = [o for o in TEAMS if o != t]
        for w in range(1, 11):
            o = opps[w % len(opps)]
            b = (box or {}).get(t, 7.0)
            rows.append(_game(2025, w, t, o, off_plays=100, off_pass=prior_pass[t], def_box_sum=20 * b, def_box_n=20))
    for w, t, o, vals in cur_games:
        rows.append(_game(2026, w, t, o, **vals))
    return pl.DataFrame(rows)


@pytest.fixture
def league(monkeypatch):
    def install(df, staff=None):
        monkeypatch.setattr(blend, "team_games", lambda: df)
        monkeypatch.setattr(blend, "_staff_changed", lambda season: staff or {})
        blend.clear()
        return df
    yield install
    blend.clear()


PRIOR = {"AAA": 70, "BBB": 50, "CCC": 50, "DDD": 50}          # league average 55%


def test_no_games_yet_is_last_season_pulled_to_league_average(league):
    league(_league(PRIOR, []))
    p = blend.PRIORS["tendency"]
    row = blend.blended(2026).filter(pl.col("team") == "AAA").row(0, named=True)
    assert row["pass_rate"] == pytest.approx((1 - p.regress) * 0.70 + p.regress * 0.55)
    assert row["games"] == 0 and row["through_week"] == 0


def test_this_season_takes_weight_game_by_game(league):
    cur = [(w, "AAA", "BBB", dict(off_plays=100, off_pass=40)) for w in (1, 2)]
    league(_league(PRIOR, cur))
    p = blend.PRIORS["tendency"]
    prior = (1 - p.regress) * 0.70 + p.regress * 0.55
    w = 2 / (2 + p.k)
    row = blend.blended(2026).filter(pl.col("team") == "AAA").row(0, named=True)
    assert row["pass_rate"] == pytest.approx(w * 0.40 + (1 - w) * prior)
    # As of week 2 only the first game counts.
    early = blend.blended(2026, before_week=2).filter(pl.col("team") == "AAA").row(0, named=True)
    assert early["through_week"] == 1
    w1 = 1 / (1 + p.k)
    assert early["pass_rate"] == pytest.approx(w1 * 0.40 + (1 - w1) * prior)


def test_scheme_numbers_move_faster_than_efficiency(league):
    assert blend.PRIORS["scheme"].k < blend.PRIORS["tendency"].k < blend.PRIORS["efficiency"].k
    assert blend.group_of("def_box_avg") == "scheme"
    assert blend.group_of("pass_rate") == "tendency"
    assert blend.group_of("def_epa_play") == "efficiency"


def test_new_play_caller_pulls_last_season_harder_to_average(league):
    df = _league(PRIOR, [])
    league(df, staff={"AAA": (True, False)})
    changed = blend.blended(2026).filter(pl.col("team") == "AAA")["pass_rate"][0]
    league(df, staff={})
    same = blend.blended(2026).filter(pl.col("team") == "AAA")["pass_rate"][0]
    assert abs(changed - 0.55) < abs(same - 0.55)


def test_defense_reads_differently_against_an_offense_that_draws_light_boxes(league):
    # AAA's defense stacks the box; the other three play light. So AAA's
    # offense is the only one that never sees a stacked box, and DDD's
    # defense should read lighter against it than against the league.
    league(_league(PRIOR, [], box={"AAA": 8.0, "BBB": 6.5, "CCC": 6.5, "DDD": 6.5}))
    table = blend.blended(2026)
    rows = {r["team"]: r for r in table.to_dicts()}
    off, deff, shifts = blend.matchup_view(rows["AAA"], rows["DDD"], table)
    box = next(s for s in shifts if s["key"] == "def_box_avg")
    faced_all = table["faced_def_box_avg"].to_list()
    lg = sum(faced_all) / len(faced_all)
    assert box["expected"] == pytest.approx(rows["DDD"]["def_box_avg"] + blend.H2H_BETA["def_box_avg"] * (rows["AAA"]["faced_def_box_avg"] - lg))
    assert box["expected"] < box["usual"]           # lighter than DDD's usual
    assert deff["def_box_avg"] == box["expected"]   # the row itself carries the projection
    assert deff["_h2h"] and not any(s["side"] == "def" for s in off["_h2h"])


def test_h2h_angle_fires_only_on_a_real_move():
    base = {"key": "def_box_avg", "label": "Defenders in box", "fmt": "dec2", "side": "def", "usual": 7.4, "drawn": 6.3,
            "drawn_rank": 31, "expected": 6.7, "n_teams": 32, "by": "BUF"}
    big = dict(base, usual_rank=2, expected_rank=20, moved=-18)
    small = dict(base, usual_rank=10, expected_rank=12, moved=-2)
    out = matchups.h2h_angles({"_h2h": []}, {"_h2h": [big, small]}, "BUF", "MIA")
    assert len(out) == 1
    a = out[0]
    assert "lighten the box" in a["title"] and a["lean"] == "over" and "rushing" in a["tags"]
    assert a["strength"] == 2


def test_existing_angle_says_when_its_number_was_projected():
    deff = {"_h2h": [{"key": "def_box_avg", "label": "Defenders in box", "usual": 7.4, "usual_rank": 2,
                      "expected": 6.9, "expected_rank": 12, "moved": -10}]}
    angles = [{"title": "Heavy boxes vs the run", "detail": "MIA averages 6.90 in the box."},
              {"title": "Tight end targets line up", "detail": "x."}]
    out = matchups.note_adjusted(angles, deff, "BUF")
    assert "projected for BUF" in out[0]["detail"]
    assert out[1]["detail"] == "x."


def test_angle_table_from_before_the_blend_is_not_trusted(monkeypatch):
    from dashboard.stats import angles
    old = pl.DataFrame({"season": [2026], "season_used": [2025], "offense": ["AAA"], "defense": ["BBB"]})
    monkeypatch.setattr(angles, "exists", lambda: True)
    monkeypatch.setattr(angles, "table", lambda: old)
    angles._covered.cache_clear()
    try:
        assert angles._covered() == set()
    finally:
        angles._covered.cache_clear()
