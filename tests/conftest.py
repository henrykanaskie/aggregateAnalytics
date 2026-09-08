import polars as pl
import pytest

from nfl.data import RAW_DIR


def pytest_runtest_setup(item):
    """`needs_data` tests read the parquet cache. A fresh clone and CI do not
    have one, so they skip rather than fail."""
    if item.get_closest_marker("needs_data") and not RAW_DIR.is_dir():
        pytest.skip(f"parquet cache not present at {RAW_DIR}")

# Every abbreviation that actually appears in nflverse `schedules`, 1999-2026,
# captured from the live table. If nflverse ever adds one, test_teams will fail
# loudly rather than letting an unmapped team through.
SCHEDULE_ABBREVIATIONS = [
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN",
    "DET", "GB", "HOU", "IND", "JAX", "KC", "LA", "LAC", "LV", "MIA",
    "MIN", "NE", "NO", "NYG", "NYJ", "OAK", "PHI", "PIT", "SD", "SEA",
    "SF", "STL", "TB", "TEN", "WAS",
]


@pytest.fixture
def raw_schedules() -> pl.DataFrame:
    """A hand-built stand-in for `schedules`, small enough to reason about.

    Deliberately includes a pre-relocation Rams game, a neutral-site game and
    an unplayed future game with a line but no score.
    """
    return pl.DataFrame(
        {
            "game_id": ["2005_01_SEA_STL", "2005_01_NE_OAK", "2026_01_NE_SEA"],
            "season": [2005, 2005, 2026],
            "week": [1, 1, 1],
            "game_type": ["REG", "REG", "REG"],
            "gameday": ["2005-09-11", "2005-09-11", "2026-09-09"],
            # Eastern wall-clock, as nflverse ships it. The 2005 Rams game is a
            # late-afternoon window; the 2026 game is a primetime kickoff.
            "gametime": ["16:05", "13:00", "20:20"],
            "home_team": ["STL", "OAK", "SEA"],
            "away_team": ["SEA", "NE", "NE"],
            "home_score": [10, 20, None],
            "away_score": [24, 13, None],
            "result": [-14, 7, None],
            "location": ["Home", "Neutral", "Home"],
            "spread_line": [3.0, -1.5, 3.5],
            "total_line": [45.0, 41.0, 44.5],
            "home_rest": [7, 7, 7],
            "away_rest": [7, 10, 7],
            "div_game": [0, 0, 0],
            "overtime": [0, 0, None],
            "roof": ["dome", "outdoors", "outdoors"],
            "surface": ["astroturf", "grass", "grass"],
            "temp": [None, 70, None],
            "wind": [None, 8, None],
            "home_qb_id": ["a", "b", None],
            "away_qb_id": ["c", "d", None],
        },
        schema_overrides={"home_score": pl.Int64, "away_score": pl.Int64,
                          "result": pl.Int64, "overtime": pl.Int64},
    )


@pytest.fixture
def raw_teams() -> pl.DataFrame:
    """`teams` in miniature, reproducing its duplicate-franchise rows.

    Real table: 36 rows, 32 franchises -- LA/LAR/STL, LAC/SD, LV/OAK.
    """
    return pl.DataFrame({
        "team_abbr": ["LA", "LAR", "STL", "LAC", "SD", "LV", "OAK", "SEA"],
        "team_name": ["Los Angeles Rams", "Los Angeles Rams", "St. Louis Rams",
                      "Los Angeles Chargers", "San Diego Chargers",
                      "Las Vegas Raiders", "Oakland Raiders", "Seattle Seahawks"],
        "team_conf": ["NFC"] * 3 + ["AFC"] * 4 + ["NFC"],
    })


@pytest.fixture
def raw_depth_legacy() -> pl.DataFrame:
    """`depth_charts` in the 2001-2024 shape.

    Includes a pre-relocation Rams row so canonicalisation is exercised, and
    the string `depth_team` ranks the old format used.
    """
    return pl.DataFrame(
        {
            "season": [2005, 2005, 2024],
            "week": [1, 1, 3],
            "game_type": ["REG", "REG", "REG"],
            "club_code": ["STL", "STL", "SEA"],
            "depth_team": ["1", "2", "1"],
            "position": ["QB", "QB", "QB"],
            "depth_position": ["QB", "QB", "QB"],
            "gsis_id": ["00-0000001", "00-0000002", "00-0000003"],
            "full_name": ["Marc Bulger", "Jamie Martin", "Geno Smith"],
        },
        schema_overrides={"season": pl.Int32, "week": pl.Int32},
    )


@pytest.fixture
def raw_depth_modern() -> pl.DataFrame:
    """`depth_charts` in the 2025+ shape: timestamped snapshots, no week.

    `dt` is a string in the real table, which is the detail that makes a naive
    cast fail.
    """
    return pl.DataFrame(
        {
            "season": [2026, 2026, 2026],
            "dt": [
                "2026-08-30T12:30:54Z",
                "2026-08-30T12:30:54Z",
                "2026-09-02T09:00:00Z",
            ],
            "team": ["SEA", "SEA", "LA"],
            "player_name": ["Sam Darnold", "Drew Lock", "Matthew Stafford"],
            "espn_id": ["1", "2", "3"],
            "gsis_id": ["00-0000004", "00-0000005", "00-0000006"],
            "pos_grp": ["OFF", "OFF", "OFF"],
            "pos_abb": ["QB", "QB", "QB"],
            "pos_slot": [9, 9, 9],
            "pos_rank": [1, 2, 1],
        },
        schema_overrides={"season": pl.Int32, "pos_slot": pl.Int32, "pos_rank": pl.Int32},
    )
