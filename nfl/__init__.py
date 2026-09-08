"""NFL prediction model.

Layering, from the bottom up:

    nfl.data      path resolution + lazy parquet access (no network deps)
    nfl.teams     franchise identity; the relocation fix
    nfl.games     the game spine, one tidy row per game
    nfl.depth     depth charts, reconciled across the 2025 schema break
    nfl.evaluate  metrics, baselines, walk-forward splits

    data_handling.ingest   network ingestion; imports nfl.data, not vice versa
"""

from .data import DATA_ROOT, REPO_ROOT, SchemaBreak, cached_datasets, dataset_files, scan
from .depth import load_depth_charts, starters
from .games import build_game_spine, load_games, team_games, upcoming
from .teams import FRANCHISES, canonical_team, canonical_team_expr, canonicalize, franchise_ids

__all__ = [
    "DATA_ROOT", "REPO_ROOT", "scan", "cached_datasets", "dataset_files", "SchemaBreak",
    "load_depth_charts", "starters",
    "canonical_team", "canonical_team_expr", "canonicalize", "franchise_ids", "FRANCHISES",
    "load_games", "build_game_spine", "team_games", "upcoming",
]
