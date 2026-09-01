"""NFL prediction model.

Layering, from the bottom up:

    nfl.data      path resolution + lazy parquet access (no network deps)
    nfl.teams     franchise identity; the relocation fix
    nfl.games     the game spine, one tidy row per game
    nfl.evaluate  metrics, baselines, walk-forward splits

    data_handling.ingest   network ingestion; imports nfl.data, not vice versa
"""

from .data import DATA_ROOT, REPO_ROOT, cached_datasets, scan
from .games import build_game_spine, load_games, team_games, upcoming
from .teams import FRANCHISES, canonical_team, canonical_team_expr, canonicalize, franchise_ids

__all__ = [
    "DATA_ROOT", "REPO_ROOT", "scan", "cached_datasets",
    "canonical_team", "canonical_team_expr", "canonicalize", "franchise_ids", "FRANCHISES",
    "load_games", "build_game_spine", "team_games", "upcoming",
]
