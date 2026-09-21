"""The quarterback layer.  [PHASE 2 -- SCAFFOLD, NOT IMPLEMENTED]

THE RULE, WHICH GOVERNS EVERY FUNCTION BELOW
--------------------------------------------
    Every feature for game G must be computable from data available before
    G kicks off.

Team ratings implicitly assume continuity of personnel. The starting
quarterback is the one position where that assumption breaks hard enough to
move a line by a touchdown, which is why this is the largest known upgrade to a
vanilla NFL Elo. It is also the easiest place in the project to build something
that backtests brilliantly and is worthless, because the obvious join leaks.

WHAT YOU CANNOT GUESS FROM THE CODE
-----------------------------------
``player_stats_week`` carries what you need:

    player_id, season, week      GSIS ids, matching schedules.home_qb_id
    attempts, sacks_suffered     dropbacks = attempts + sacks_suffered
    passing_epa, rushing_epa     the two EPA components a QB generates

Verified against the cache: ``sacks_suffered`` is 0% null in every era back to
1999, and ``(player_id, season, week)`` is unique across all 17,713 QB-games,
so a left join onto the game spine cannot fan out.

``schedules.home_qb_id`` / ``away_qb_id`` are GSIS and every one of the 118
distinct starters from 2020 onward resolves in ``player_stats_week``. But 13.8%
of them are null on 2020+, and they are backfilled after the fact, so they are
fine for a backtest and wrong for live prediction. See :func:`starting_qbs`.

``draft_picks`` has ``gsis_id`` (1.3% null on 2010+), ``round`` and ``pick``.
``players`` carries ``draft_round`` and ``draft_pick`` directly. Check which is
more complete for your seasons before committing to one.

ORDER OF WORK
-------------
Do :func:`qb_form` with ``leaky=True`` first and score it. It will look
spectacular. Then set ``leaky=False`` and watch most of the gain evaporate.
That comparison is the point of this phase; ``tests/test_qb.py`` asserts it.
"""

from __future__ import annotations

import polars as pl
from nfl.data import scan

#: Minimum dropbacks for a game to say anything about a quarterback. Below this
#: the per-dropback rate is mostly noise from garbage time or an injury exit.
MIN_DROPBACKS = 10


def qb_game_value(seasons: range | list[int] | None = None) -> pl.DataFrame:
    """Per-game quarterback value: EPA per dropback.
    `epa_per_dropback` is null where ``dropbacks < MIN_DROPBACKS`` rather than
    a noisy number, so downstream can decide what to do with an unknown instead
    of averaging in garbage.
    """
    

    player_weekly = scan("player_stats_week") # 1999 - 2025
    qb = (player_weekly.filter(pl.col("attempts") > 2)
          .select("player_id", "season", "week", "season_type", "team","attempts", "sacks_suffered", "carries", "passing_epa", "rushing_epa",))
    qb = (
        qb.with_columns(
            dropbacks=pl.col("attempts") + pl.col("sacks_suffered"),total_plays=pl.col("attempts") + pl.col("sacks_suffered") + pl.col("carries").fill_null(0), 
            total_epa=pl.col("passing_epa").fill_null(0.0) + pl.col("rushing_epa").fill_null(0.0)
          )
        .with_columns(
            epa_per_dropback=pl.when(pl.col("dropbacks") >= MIN_DROPBACKS)
            .then(pl.col("total_epa").fill_null(0.0) / pl.col ("dropbacks")), 
            epa_per_play= pl.col("total_epa") / pl.col("total_plays"),
          )
        )
    
    if seasons is not None:
      qb = qb.filter(pl.col("season").is_in(list(seasons)))

    return qb.collect()


def qb_form(
    values: pl.DataFrame, *, half_life: float = 8.0, leaky: bool = False,
    value_col: str = "epa_per_dropback",
) -> pl.DataFrame:
    """Rolling estimate of a quarterback's form ENTERING each game.
    """
    qb = values.sort("player_id", "season", "week", descending=False, nulls_last=True)
    form = pl.col(value_col).ewm_mean(half_life=half_life, ignore_nulls=True)
    if not leaky:
        form = form.shift(1)
    qb = qb.with_columns(form=form.over("player_id"))
    return qb

def rookie_prior(player_ids: pl.Series) -> pl.DataFrame:
    """Prior expectation for a quarterback with no NFL games yet.

    TASK 2b (part 3). Return ``player_id | prior``, where a higher pick implies
    a better prior. Draft capital is the market's own estimate of a player
    before anyone has seen them play, which makes it the natural prior and one
    of the few genuinely leakage-free features available in week one.

    Shape it however you like -- the shrinkage weight and the functional form
    are yours. What the test pins down is only that it is monotone: pick 1 must
    not get a worse prior than pick 200.

    DONE WHEN: ``test_rookie_prior_is_monotone_in_draft_capital`` passes.
    """
    raise NotImplementedError("Phase 2, task 2b")


def qb_adjustment(
    games: pl.DataFrame, form: pl.DataFrame, *, points_per_epa: float = 1.0
) -> pl.DataFrame:
    """Rating adjustment for who is actually starting, per game.

    TASK 2d. Return ``games`` with:

        home_qb_adj | away_qb_adj | qb_adj_diff

    The adjustment is DIFFERENTIAL, measured against the team's own baseline
    starter, not against zero:

        adj(team, game) = value(starter) - value(team's baseline starter)

    so a team fielding its normal quarterback gets an adjustment near zero and
    only a change of starter moves the rating. An absolute adjustment would
    double-count: the team rating already contains its usual quarterback's
    contribution, earned game by game.

    What "baseline starter" means is your call -- most snaps this season, the
    week-1 starter, a rolling notion -- and it matters most in exactly the cases
    you care about, so decide it deliberately.

    DONE WHEN: ``test_normal_starter_gets_a_near_zero_adjustment`` passes.
    """
    raise NotImplementedError("Phase 2, task 2d")


def starting_qbs(season: int, week: int, asof: str | None = None) -> pl.DataFrame:
    """Who is actually starting, using only information available before kickoff.

    TASK 2f. Return ``team | player_id``.

    ``schedules.home_qb_id`` is backfilled after the game, so using it live is a
    mild leak and a real one on the exact games that matter: the ones where the
    starter changed. Build this from ``nfl.depth.load_depth_charts`` instead,
    which is already reconciled across the 2025 schema break, plus ``injuries``
    to drop anyone ruled out.

    The modern feed is timestamped rather than week-labelled, which is better
    for you: ``asof`` lets you ask what the depth chart said on Tuesday morning
    rather than trusting a label applied later. Reach for ``join_asof`` with
    ``strategy="backward"`` -- an equality join cannot express "the most recent
    snapshot before this kickoff".

    Note that ``injuries`` is only cached through 2025, and its
    ``practice_status`` column contains a junk ``'\\n    '`` value alongside the
    real ones.

    DONE WHEN: ``test_starting_qbs_returns_one_per_team`` passes.
    """
    raise NotImplementedError("Phase 2, task 2f")
