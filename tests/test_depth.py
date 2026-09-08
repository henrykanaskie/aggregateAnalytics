"""The 2025 depth chart schema break.

nflverse replaced this table rather than extending it. The failure mode being
guarded here is not an exception, it is a union that succeeds and returns an
all-null era, so most of these tests assert that values are *present*.
"""

import polars as pl
import pytest

from nfl.depth import DEPTH_COLUMNS, is_modern, normalize_depth_chart, starters


def test_era_is_detected_from_columns(raw_depth_legacy, raw_depth_modern):
    assert is_modern(raw_depth_modern.columns)
    assert not is_modern(raw_depth_legacy.columns)


def test_legacy_normalises(raw_depth_legacy):
    out = normalize_depth_chart(raw_depth_legacy).collect()
    assert out.columns == DEPTH_COLUMNS
    assert out["team"].to_list() == ["LA", "LA", "SEA"]       # STL -> LA
    assert out["rank"].to_list() == [1, 2, 1]                 # "1" -> 1
    assert out["week"].to_list() == [1, 1, 3]
    assert out["asof"].null_count() == 3                      # no timestamp exists


def test_modern_normalises(raw_depth_modern):
    out = normalize_depth_chart(raw_depth_modern).collect()
    assert out.columns == DEPTH_COLUMNS
    assert out["position"].to_list() == ["QB", "QB", "QB"]    # from pos_abb
    assert out["rank"].to_list() == [1, 2, 1]                 # from pos_rank
    assert out["week"].null_count() == 3                      # no week exists
    assert out["asof"].null_count() == 0                      # parsed from a string
    assert out["asof"].dtype == pl.Datetime("us")
    assert out["asof"][0].year == 2026


def test_the_bug_itself_both_eras_stack_with_nothing_nulled(
    raw_depth_legacy, raw_depth_modern
):
    """The regression. A naive union of the raw files nulls out every 2025+
    row's week, position and depth_team; nothing errors. After normalising,
    both eras must carry a team, a position and a rank."""
    stacked = pl.concat(
        [
            normalize_depth_chart(raw_depth_legacy),
            normalize_depth_chart(raw_depth_modern),
        ],
        how="vertical",
    ).collect()

    assert stacked.height == 6
    for col in ("team", "position", "rank", "gsis_id", "season"):
        assert stacked[col].null_count() == 0, f"{col} went null across the break"
    # And every era contributes a real starter.
    assert set(starters(stacked)["season"].to_list()) == {2005, 2024, 2026}


def test_unknown_format_raises_rather_than_guessing():
    with pytest.raises(ValueError, match="neither known format"):
        normalize_depth_chart(pl.DataFrame({"season": [2030], "something_new": [1]}))


def test_starters_takes_rank_one_only(raw_depth_modern):
    out = starters(normalize_depth_chart(raw_depth_modern).collect())
    assert out["player_name"].to_list() == ["Sam Darnold", "Matthew Stafford"]
