from nfl.games import load_games as lg
from nfl.teams import franchise_ids as fids
from nfl.evaluate import compare, constant_baseline, market_baseline
from nfl.teams import FRANCHISES
import polars as pl
import math

games = lg()
EXPANSION_ELO = 1350.0
TEAMS = sorted(fids())
IDX = {t: i for i, t in enumerate(TEAMS)}
mov_mult = .45
k = 16.0
hfa = 45.0 #elo points
points_per_elo = 20.0
games = games.with_columns(
    home_idx=pl.col("home").replace_strict(IDX, return_dtype=pl.Int32),
    away_idx=pl.col("away").replace_strict(IDX, return_dtype=pl.Int32),
)

ratings = [1500.0] * len(TEAMS)
prev_season = None
preds, actuals = [], []
for block in games.partition_by(["season", "week"], maintain_order=True):
  season, week = block["season"][0], block["week"][0]
  if season != prev_season:
    for i, team in enumerate(TEAMS):
      if FRANCHISES[team].first_season == season and season > 1999:
        ratings[i] = EXPANSION_ELO
      else:
        ratings[i] = 1500 + mov_mult * (ratings[i] - 1500)
    prev_season = season

  # gather all reads first
  h = block["home_idx"].to_list()
  a = block["away_idx"].to_list()
  m = block["margin"].to_list()

  pre_h = [ratings[i] for i in h]
  pre_a = [ratings[i] for i in a]
  nt = block["neutral"].to_list()
  diff  = [ph - pa + (0.0 if n else hfa) for ph, pa, n in zip(pre_h, pre_a, nt)]
  preds.extend([d/points_per_elo for d in diff])
  actuals.extend(m)
  for i, j, margin, d in zip(h, a, m, diff):
    if margin is None:
      continue
    winner_diff = d if margin > 0 else -d
    mov = 1.0 if margin == 0 else math.log(abs(margin) + 1) * (2.2 / (0.001 * winner_diff + 2.2))

    expected = 1 / (10 ** (-d/400) + 1)
    actual = 1.0 if margin > 0 else (0.0 if margin < 0 else 0.5)
    shift = k * mov * (actual - expected)

    ratings[i] += shift 
    ratings[j] -= shift 

  

print(compare({"elo": preds}, actuals))





  