from __future__ import annotations

import math
from dataclasses import dataclass

import polars as pl

from nfl.evaluate import compare
from nfl.teams import EXPANSION_ELO, FRANCHISES, franchise_ids


TEAMS = sorted(franchise_ids())
IDX = {t: i for i, t in enumerate(TEAMS)}

#: Break-even win rate for a -110 bet, i.e. 11 / 21.
BREAK_EVEN = 0.5238


@dataclass(frozen=True, slots=True)
class EloParams:
    k: float = 16.0

    hfa: float = 45.0

    carryover: float = 0.75

    points_per_elo: float = 20.0

    base: float = 1500.0


#: One row per game, in the order :func:`run_elo` builds them.
RATED_COLUMNS = [
    "game_id", "season", "week", "home", "away",
    "pre_home_elo", "pre_away_elo", "pred_margin", "margin", "spread_line",
]


def run_elo(games: pl.DataFrame, params: EloParams = EloParams()) -> pl.DataFrame:
    games = games.with_columns(
        home_idx=pl.col("home").replace_strict(IDX, return_dtype=pl.Int32),
        away_idx=pl.col("away").replace_strict(IDX, return_dtype=pl.Int32),
    )

    ratings = [params.base] * len(TEAMS)
    prev_season = None
    rows: list[dict] = []

    for block in games.partition_by(["season", "week"], maintain_order=True):
        season = block["season"][0]

        if season != prev_season:
            for i, team in enumerate(TEAMS):
                if FRANCHISES[team].first_season == season and season > 1999:
                    # A first-year franchise has no history to carry. Seeding it
                    # at the league mean would hand its opponents free rating.
                    ratings[i] = EXPANSION_ELO
                else:
                    ratings[i] = params.base + params.carryover * (ratings[i] - params.base)
            prev_season = season

        # Every read for the week happens here, before any write below.
        h = block["home_idx"].to_list()
        a = block["away_idx"].to_list()
        m = block["margin"].to_list()
        nt = block["neutral"].to_list()
        ln = block["spread_line"].to_list()
        gid = block["game_id"].to_list()
        wk = block["week"].to_list()
        home, away = block["home"].to_list(), block["away"].to_list()

        pre_h = [ratings[i] for i in h]
        pre_a = [ratings[i] for i in a]
        diff = [ph - pa + (0.0 if n else params.hfa) for ph, pa, n in zip(pre_h, pre_a, nt)]

        # One dict per game, each carrying its own key. Three parallel lists
        # would stay aligned only by convention; a row cannot come apart.
        rows.extend(
            {
                "game_id": g, "season": season, "week": w,
                "home": ht, "away": at,
                "pre_home_elo": ph, "pre_away_elo": pa,
                "pred_margin": d / params.points_per_elo,
                "margin": mg, "spread_line": line,
            }
            for g, w, ht, at, ph, pa, d, mg, line
            in zip(gid, wk, home, away, pre_h, pre_a, diff, m, ln)
        )

        for i, j, margin, d in zip(h, a, m, diff):
            if margin is None:
                continue                      # unplayed: predicted, never learned from
            winner_diff = d if margin > 0 else -d
            # Margin-of-victory multiplier, damped by how expected the win was,
            # so running up the score on a weak opponent earns little.
            mov = (
                1.0 if margin == 0
                else math.log(abs(margin) + 1) * (2.2 / (0.001 * winner_diff + 2.2))
            )
            expected = 1 / (10 ** (-d / 400) + 1)
            actual = 1.0 if margin > 0 else (0.0 if margin < 0 else 0.5)
            shift = params.k * mov * (actual - expected)

            ratings[i] += shift
            ratings[j] -= shift               # zero sum: rating is only ever moved

    return pl.DataFrame(rows).select(RATED_COLUMNS)


def score_elo(rated: pl.DataFrame) -> pl.DataFrame:
    return compare(
        {"elo": rated["pred_margin"], "market": rated["spread_line"]},
        rated["margin"],
        market=rated["spread_line"],
    )


def ats_record(rated: pl.DataFrame) -> dict[str, float]:
    scored = rated.drop_nulls(["margin", "spread_line"]).with_columns(
        edge=pl.col("pred_margin") - pl.col("spread_line"),
        cover=pl.col("margin") - pl.col("spread_line"),
    )
    pushes = int((scored["cover"] == 0).sum())
    live = scored.filter(pl.col("cover") != 0)
    wins = int(((live["edge"] > 0) == (live["cover"] > 0)).sum())
    losses = live.height - wins
    n = wins + losses
    return {
        "wins": wins, "losses": losses, "pushes": pushes, "n": n,
        "win_rate": wins / n if n else float("nan"),
        "break_even": BREAK_EVEN,
        "units": wins - losses * 1.1,
    }


def format_ats(rec: dict[str, float]) -> str:
    return (
        f"ATS  {rec['wins']}-{rec['losses']}-{rec['pushes']}  =  {rec['win_rate']:.2%}"
        f"   (break-even at -110 is {rec['break_even']:.2%})\n"
        f"units at -110: {rec['units']:+.1f} over {rec['n']} bets"
    )


if __name__ == "__main__":
    from nfl.games import load_games

    rated = run_elo(load_games())
    print(score_elo(rated))
    print()
    print(format_ats(ats_record(rated)))
