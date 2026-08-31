import polars as pl
import pytest

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
