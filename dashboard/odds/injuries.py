"""This season's injury reports, kept current between the weekly ingests.

The injuries table in the parquet cache is rebuilt by the Tuesday stats job,
which is fine for history and useless for the week in hand: the NFL files
practice reports Wednesday to Friday and game statuses on Saturday, and the
board's injury alerts and every research page's report were empty until the
following Tuesday. nflverse republishes the season's reports through the
week, so this pulls them with each lines snapshot and writes one live file,
``data/odds/injuries.parquet``. The readers in :mod:`dashboard.stats.context`
lay it over the cached table for its season, and a host that syncs
``data/odds`` from git picks it up with the next snapshot.

    python -m dashboard.odds.injuries            # current season
    python -m dashboard.odds.injuries 2025       # another
"""

from __future__ import annotations

import sys

import polars as pl

from ..config import CURRENT_SEASON, INJURIES_LIVE

#: The columns the readers use, in the cached table's dtypes. The live feed
#: for a new season can lack some (2026 has no date_modified), so they are
#: added as null rather than left to break a select.
SCHEMA: dict[str, pl.DataType] = {
    "season": pl.Int32, "week": pl.Int32, "game_type": pl.String, "team": pl.String, "gsis_id": pl.String,
    "full_name": pl.String, "position": pl.String, "report_primary_injury": pl.String,
    "report_secondary_injury": pl.String, "report_status": pl.String, "practice_primary_injury": pl.String,
    "practice_status": pl.String, "date_modified": pl.String,
}


def conform(df: pl.DataFrame) -> pl.DataFrame:
    """The feed's frame in the readers' shape: every column present, cast."""
    cols = []
    for name, dtype in SCHEMA.items():
        cols.append(pl.col(name).cast(dtype) if name in df.columns else pl.lit(None, dtype=dtype).alias(name))
    return df.select(cols)


def refresh(season: int = CURRENT_SEASON, log=print) -> int:
    """Fetch the season's reports and write the live file if they changed.

    Unchanged reports are not rewritten, so a pull that found nothing new
    leaves nothing for the snapshot commit to pick up."""
    import nflreadpy as nfl
    raw = nfl.load_injuries([season])
    df = conform(raw.to_polars() if hasattr(raw, "to_polars") else raw).sort(["week", "team", "full_name"])
    if INJURIES_LIVE.exists():
        try:
            if pl.read_parquet(INJURIES_LIVE).equals(df):
                log(f"injuries: {df.height} rows for {season}, unchanged")
                return df.height
        except Exception:  # noqa: BLE001 - an unreadable file is simply rewritten
            pass
    INJURIES_LIVE.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(INJURIES_LIVE)
    weeks = df["week"].unique().sort().to_list()
    log(f"injuries: wrote {INJURIES_LIVE} ({df.height} rows for {season}, weeks {weeks[0] if weeks else '-'}-{weeks[-1] if weeks else '-'})")
    return df.height


if __name__ == "__main__":
    refresh(int(sys.argv[1]) if len(sys.argv) > 1 else CURRENT_SEASON)
