# Roadmap

Written 2026-09-06. Season opener is **2026-09-09** (Wednesday), full Week 1 slate 2026-09-13.

---

## 1. Where you actually are

Measured, not assumed. Full pass of `model/elo.py` over 1999-2025, hand-set
`k=16, hfa=45, mov_mult=0.45, points_per_elo=20`:

| era | n | elo MAE | market MAE | gap | ATS |
|---|---|---|---|---|---|
| 1999-2006 | 2112 | 10.586 | 10.422 | +0.164 | 52.2% |
| 2007-2013 | 1869 | 10.924 | 10.704 | +0.220 | 51.3% |
| 2014-2019 | 1602 | 10.360 | 10.096 | +0.264 | 51.5% |
| 2020-2025 | 1693 | 10.175 | 9.767  | **+0.408** | **50.1%** |

Three things follow, and the whole roadmap hangs off them.

**a. The headline number is flattered by old football.** Full-sample MAE is
10.53 vs market 10.27, a gap of 0.26. That is not your number. Your number is
**0.408**, on 2020-2025, and the gap widens monotonically every era because the
market got sharper, not because your model got worse. Report 2020+ separately
from now on, always.

**b. You are not beating the spread and should stop aiming at it.** ATS on
2020-2025 is 50.06%. Break-even at -110 is 52.38%. Filtering to your
highest-conviction games (2014+, `|edge| >= 3`, n=1036) gives 51.16%, still
losing. The closing line is the hardest forecasting benchmark in public
sports data and a 4-parameter Elo will not clear it. Anything you build that
is justified by "and then we bet it" is built on a premise the data already
rejected.

**c. Two of your constants are already right, so do not spend time there.**
Regressing margin on pre-game Elo diff gives an optimal `points_per_elo` of
19.5 on 2020+; you have 20.0, and the MAE difference is 0.003. Residual sd is
13.09, so the `sigma=13.0` default in `nfl/evaluate.py` is nearly exact for
this model. Phase 0 is unblocked. The wins are elsewhere.

### What is solid

`nfl/teams.py` is genuinely good work. The relocation and duplicate-franchise
handling is the exact class of bug that silently corrupts a rating system, and
you found it before it bit you. `nfl/evaluate.py` already has walk-forward
splits, a reliability table and a Brier decomposition. `nfl/games.py` fixes the
sign conventions in one place. 25 nflverse tables are cached locally.

The data and evaluation layers are ahead of the model layer. That is the right
way round and it is why the next four weeks can move fast.

### What is broken or missing

- `model/elo.py` is a script, not a module. No `pip install -e .`, so it needs
  `PYTHONPATH=.` to import, and running it prints nothing because nothing calls
  `elo_predict`.
- Hyperparameters are module globals, hand-tuned, and evaluated in-sample. The
  walk-forward harness you wrote is not used by the model you wrote.
- `qb_elo_predict()` is dead code that ends mid-thought, and **its join is a
  leak**: it pulls `passing_epa` for `(qb_id, season, week)`, which is the QB's
  performance *in the game being predicted*. Do not let that reach a feature.
- `data/predictions.parquet` has a schema and zero rows. No track record exists.
- Zero tests cover the model.

---

## 2. The reframe: what "something of value" means

You cannot beat the closing line by Wednesday. You can ship three things that
are valuable and honest, and that most public models never do:

1. **Calibrated win probabilities**, where a stated 65% actually wins 65% of
   the time. Reported with the reliability table you already wrote.
2. **A timestamped, append-only, pre-kickoff track record.**
3. **An explicit accounting of the gap to the market**, published rather than
   hidden.

Number 2 is the one that matters most and the one people always skip. Point (3)
below explains why.

---

## 3. The two clocks already running

These are the only tasks in this document with a hard, unrecoverable deadline.
Everything else can be built in October and is just as good. These two cannot.

**Clock 1: the track record.** Every week you do not log predictions before
kickoff is a week of evidence that is permanently gone. Backfilled predictions
are worthless as evidence and everyone knows it. Eighteen honest logged weeks
by January is a real asset; eighteen weeks reconstructed in January is nothing.
`log_predictions()` in `data_handling/ingest.py` already exists. Use it Tuesday.

**Clock 2: live odds snapshots.** `spread_line` in nflverse is the *closing*
line, backfilled. That is the toughest possible benchmark and it is also not the
number you could ever have bet. Beating the **opening** line, or the line
available Tuesday morning, is a genuinely achievable target and a more honest
one. But nflverse does not archive line movement, so you can only get this by
snapshotting it yourself, starting now.

Write a 30-line script that hits a free odds API (The Odds API's free tier is
enough for one pull a day) and appends `(pulled_at, game_id, book, spread,
total, moneyline)` to a parquet. Run it on a cron twice a day. It is the least
interesting code in this project and in three months it will be the most
valuable data you own, because nobody else bothered.

Total cost: about 90 minutes. Do both before Wednesday.

---

## Phase 0: ship by Wed 2026-09-09

Target: a `predict.py` that produces Week 1 numbers and logs them before the
opener. Roughly one focused day.

**0.1 Make the repo importable** (10 min)
`pip install -e .` into the venv, add `pytest` to a dev extra. `model/` is not
in the `packages.find` include list in `pyproject.toml`; either add it or move
the model under `nfl/`. Confirm `pytest` runs green.

**0.2 Turn `elo.py` into a function with no side effects at import** (1-2 hr)
Extract a `run_elo(games, params) -> DataFrame` returning one row per game with
`game_id, season, week, pre_home_elo, pre_away_elo, pred_margin`. Put
`k, hfa, mov_mult, points_per_elo, regress, expansion_elo` in a frozen
dataclass with your current values as defaults. Keep the loop exactly as it is,
it is correct: it reads all pre-game ratings for a week before updating any of
them, which is the bug most people ship.

Delete `qb_elo_predict()` for now. It is coming back in Phase 2, properly.

**0.3 Carry ratings into 2026 and predict Week 1** (30 min)
Run through the end of 2025, apply the season regression, then predict the 16
Week 1 games. Convert to win probability with `margin_to_win_prob(m, sigma=13.1)`.
Sanity check: no team should sit outside roughly 1350-1700 after regression, and
the 16 win probabilities should mostly land in 0.35-0.75. If something is at
0.95, you have a bug.

**0.4 Log it, before kickoff** (30 min)
Write all 16 rows through `log_predictions()` with the real `logged_at`,
`model_version="elo-v1"`, and the market spread as of that moment. This is the
deliverable. Everything above it is scaffolding for this.

**0.5 Publish it** (1-2 hr)
Markdown table to a GitHub README or a static page: game, your margin, your win
probability, the market line, and the delta. Include a one-paragraph honest
header saying it does not beat the closing line, with the 2020-2025 gap of
0.408 stated plainly. That paragraph is the most credible thing on the page.

**Definition of done:** by Tuesday night, 16 rows in `predictions.parquet` with
a `logged_at` earlier than the first kickoff, and a URL a stranger can read.

> **Learning objective:** accuracy and calibration are different skills. Run
> `brier_decomposition` on your 2020-2025 backtest before you ship. Watch
> `resolution` and `reliability` move independently. A model can have a
> respectable MAE and produce probabilities that are systematically overconfident.

---

## Phase 1: make the evaluation honest (Weeks 1-2, in-season)

The model does not change here. Only your ability to trust it does. This is the
single highest-value phase for learning and the one most people skip.

**1.1 Tune with walk-forward, not by eye.**
Grid over `k` (8-32), `hfa` (30-60), `mov_mult` (0.25-0.75). Use
`walk_forward_splits` with `min_train=5`. For each split, fit on train seasons
only, score on the held-out season, average.

Expect an uncomfortable result: your walk-forward optimum will likely be close
to what you already hand-picked, and out-of-sample MAE will be slightly *worse*
than the in-sample 10.175. That discomfort is the lesson. Write down both
numbers side by side.

**1.2 Make HFA time-varying.** League-wide home field advantage has fallen
substantially since 2019 (COVID empty stadiums, and it never fully came back).
A single `hfa=45` fitted across 1999-2025 is too high for 2026. Fit HFA per
season, plot it, and use a trailing 3-season estimate going forward. This is
plausibly your largest single MAE win for the least code.

**1.3 Add a `bias` guard to the test suite.** A persistent non-zero `bias()`
means a mis-set HFA. Assert `|bias| < 0.3` on the 2020+ backtest so a future
refactor cannot silently reintroduce a lean.

**1.4 Add model tests.** Two synthetic-data tests: (a) ratings are conserved,
total rating change across a game sums to zero; (b) a team that wins every game
by 20 ends the season with the top rating. Cheap, and they catch sign flips.

> **Learning objectives:** in-sample versus out-of-sample fit, felt rather than
> read about; non-stationarity, a parameter fitted on 2005 football is wrong for
> 2026; regression tests as a guard on statistical properties, not just outputs.

---

## Phase 2: the QB layer (Weeks 2-4)

The largest known upgrade to a vanilla NFL Elo. Team ratings implicitly assume
continuity of personnel; the starting QB is the one position where that
assumption breaks hard enough to move a line by a touchdown.

**2.1 Fix the leak first, in writing.** Your current draft joins the QB's stats
for the game being predicted. Before writing any code, write the rule at the top
of the file: *every feature for game G must be computable from data available
before G kicks off.* Then build a rolling value: EWMA of the QB's
`(passing_epa + rushing_epa) / dropbacks` over their prior games, **shifted by
one game**, with a draft-capital-based prior for rookies (`draft_picks` is
already cached for this).

**2.2 Prove the leak matters.** Build the leaky version too, once, and score it.
It will look spectacular, something like a 30-40% MAE improvement. Then score
the shifted version and watch most of that vanish. This is the most valuable
hour in the whole roadmap. You will recognise the signature of leakage instantly
for the rest of your career, and the "too good to be true" reflex is the single
most useful instinct in applied ML.

**2.3 Integrate as an adjustment.** Pre-game rating becomes
`team_elo + qb_adjustment(starter) - qb_adjustment(season_baseline_starter)`,
so a team with its normal starter gets roughly zero adjustment and a backup
gets a penalty. Validate against known cases: 2023 Jets after the Rodgers
injury, any 2020 Broncos game.

**2.4 Handle the announcement problem.** Starters are confirmed late in the
week. `schedules.home_qb_id` is backfilled after the fact, so using it is a
mild leak for live prediction. For real Tuesday predictions you need
`depth_charts` plus `injuries` (both cached), or a manual override file. Note
this honestly in the published output.

> **Learning objectives:** temporal leakage and as-of-time joins, which is the
> failure mode that kills real production models; shrinkage and priors, how much
> do you believe 40 dropbacks; the gap between backtest conditions and live
> conditions.

---

## Phase 3: Elo to a fitted model (Weeks 4-7)

Elo is a hand-tuned update rule that compresses a team into one number. Replace
it with something that learns weights.

**3.1 Build a feature table** with one row per game and strict as-of-time
discipline. Start with: Elo diff, QB adjustment diff, rest diff, travel
distance, roof/surface, temp/wind (outdoor only), divisional flag, and rolling
prior-N-game EPA per play for each side split offense/defense. All of this is
in the cached tables. Write a single test that asserts no feature column
references a `week >= ` the game's own week.

**3.2 Fit ridge regression on margin first**, before anything fancier. It is
interpretable, the coefficients tell you what actually matters, and it gives
you a real baseline. Compare to Elo alone on walk-forward 2020+.

**3.3 Then a gradient-boosted model** (LightGBM/XGBoost) on the same features
and the same splits. Expect a modest gain over ridge, possibly none. NFL has
roughly 285 games a season and enormous outcome variance; this is a small-data,
high-noise problem, which is precisely why sophisticated models underperform
here relative to intuition. Learning that firsthand is worth more than the
model.

**3.4 Separate offensive and defensive ratings.** Two numbers per team instead
of one. Improves matchup-specific prediction in a way a single rating
structurally cannot.

> **Learning objectives:** feature engineering under time constraints;
> regularisation and why ridge beats OLS when features are collinear (Elo diff
> and EPA diff will be heavily correlated); the bias-variance tradeoff in a
> genuinely small-data regime; interpretability as a debugging tool.

---

## Phase 4: the market as information (Weeks 7+)

Only after Phase 3. The frame shift: the closing line is not a competitor, it is
the single most informative feature available, an aggregate of every sharp
opinion in the world.

- **Model the residual.** Predict `margin - spread_line` instead of `margin`.
  If you cannot beat zero, that is the honest and expected answer, and it is
  itself a publishable finding.
- **Target the opening line.** With the Phase 0 odds snapshots accumulating,
  ask whether your Tuesday number beats the Tuesday line. Genuinely more
  achievable, and now you have the data.
- **Look for subsets, not a universal edge.** Extreme weather, large
  underdogs, short-week road games, backup QB starts. Be extremely careful:
  hunting subsets across a 285-game season is how you find noise. Pre-register
  the hypothesis before you look, and require it to hold out of sample.
- **Calibration as the product.** A model that says 62% and hits 62% is useful
  for analysis and content even when it never beats a line.

> **Learning objectives:** efficient markets in practice; multiple-comparison
> discipline; distinguishing an edge from a story.

---

## Weekly cadence, from Week 1 onwards

Non-negotiable, about 45 minutes:

- **Tuesday:** refresh ingest, regenerate predictions, log them, publish.
- **Wednesday:** odds snapshot cron confirmed running.
- **Monday:** score last week. Append to a running MAE / Brier / ATS table.
  Update the reliability table. Do not touch model parameters mid-season based
  on one week; a 16-game sample tells you nothing and reacting to it is the
  fastest way to overfit your own season.

Model changes ship as new `model_version` strings so the track record stays
attributable.

---

## What not to do

- **Do not chase ATS.** The 2020-2025 evidence says no. Revisit only after
  Phase 4 and only against opening lines.
- **Do not add datasets.** You have 25 tables and use two. `pbp` is 305 MB
  and you have not touched it. Breadth is not the constraint.
- **Do not build a web app in week 1.** A markdown table in a README is a
  perfectly good product. Build the app in November, if the track record
  earns it.
- **Do not tune on the full sample again.** Every number you quote from here
  is walk-forward or it does not get quoted.
- **Do not skip Phase 1 to get to Phase 2.** Phase 2 without honest evaluation
  is a model you cannot tell is working.

---

## Sequenced summary

| when | ship | you learn |
|---|---|---|
| by Wed 9/9 | logged Week 1 predictions, published | calibration vs accuracy |
| by Wed 9/9 | odds snapshot cron | unbackfillable data |
| weeks 1-2 | walk-forward tuning, time-varying HFA | in-sample vs out-of-sample, non-stationarity |
| weeks 2-4 | QB adjustment, leaky version scored first | temporal leakage, shrinkage |
| weeks 4-7 | feature table, ridge, then GBM | feature engineering, regularisation, small-data reality |
| weeks 7+ | market residual model, subset hypotheses | market efficiency, multiple comparisons |

---

# Field notes: what you can't derive from the code

Measured against the local parquet cache on 2026-09-06. Expression bodies are
deliberately left blank.

## The move that makes you stop needing this section

    scan(name).collect_schema().names()                       # what columns
    scan(name).head(5).collect()                              # what values
    scan(name).group_by("season").len().collect().sort("season")   # coverage + breaks

The third is the important one. A row count that jumps an order of magnitude
between seasons means the schema changed underneath you. That is how the
`depth_charts` bug below was found.

## Three ID systems, and which tables speak which

| table | player key | namespace | note |
|---|---|---|---|
| player_stats_week | `player_id` | GSIS | 17,713 QB-games, key is unique |
| schedules | `home_qb_id` / `away_qb_id` | GSIS | 13.8% null on 2020+ |
| depth_charts | `gsis_id` | GSIS | see the break below |
| injuries | `gsis_id` | GSIS | 2009-2025 only |
| draft_picks | `gsis_id`, `pfr_player_id` | both | gsis 1.3% null on 2010+ |
| **snap_counts** | `pfr_player_id` | **PFR only** | no GSIS at all |
| players | `gsis_id`, `pfr_id`, `espn_id`, `pff_id`, `otc_id` | all | the bridge |

`players` carries every namespace, so it is the only legal bridge.
`snap_counts` is the one table with no GSIS column: route it through
`players.pfr_id`, which resolves 99.6% of the 7,095 PFR ids in your cache.
Every other player join is GSIS to GSIS.

All 118 distinct `home_qb_id` values from 2020+ resolve in
`player_stats_week`. The starter join works; the 13.8% null rate is the part
to plan for.

## Two bugs already sitting in your data layer

**Loud: `scan("injuries")` raises today.** `season` and `week` are `Float64`
in the 2009-2020 files and `Int32` in 2021+. `scan()` handles missing and
extra columns but not dtype drift, so the union throws `SchemaError`. Fix it
with `cast_options=pl.ScanCastOptions(integer_cast="allow-float")` in
`nfl/data.py`, or normalise dtypes at ingest. Your call, but the first option
silently leaves `season` as a float, so `2009.0` will not match an int filter
and joins come back empty for no visible reason.

**Silent: `depth_charts` changed schema entirely in 2025.** Row counts are
37,327 (2023), 37,312 (2024), **554,215 (2025)**, 485,277 (2026).

    2001-2024   season, club_code, week, game_type, depth_team,
                position, depth_position, gsis_id, ...
    2025+       season, dt, team, player_name, espn_id, gsis_id,
                pos_grp, pos_abb, pos_slot, pos_rank

There is no `week` column in the new format at all. Because `scan()` sets
`missing_columns="insert"`, the union *succeeds* and every 2025/2026 row comes
back with null week, null position and null depth_team. Nothing errors. Phase 2
code filtering `depth_team == "1"` will simply see no modern rows.

The new feed is 221 timestamped snapshots per season. `dt` is an ISO **string**,
not a datetime. The starter is `pos_abb == "QB"` and `pos_rank == 1`. Better for
your purpose (you can take the snapshot as of Tuesday rather than trusting a
week label) but it needs its own reader and its own test.

## Phase 0

**Do not vectorize the rating loop.** ~7,300 games, about two seconds. Elo is
inherently sequential: each update depends on the state the previous game left.
This is the one place a loop is correct, and knowing when *not* to reach for
numpy is worth as much as knowing how.

`partition_by(["season","week"], maintain_order=True)` is right. Keep it.

Getting Python-computed values back into a frame: parallel lists and positional
alignment work until they don't. The contract that cannot drift is to
accumulate dicts carrying `game_id`, build a frame, and join back on that key.

Decide now, not twice: does `run_elo` also return per-week rating history?
Phase 1's HFA work and Phase 2's validation both want it.

Params object: `@dataclass(frozen=True, slots=True)`.

## Phase 1

**The subtlety that makes Elo different from ordinary cross-validation.** You
cannot "train on 1999-2010, test 2011" by discarding earlier games, because
ratings are cumulative state, not fitted coefficients. You must run the ratings
*through* the training seasons to reach the state 2011 starts from. So "fit on
train only" means something narrower here: the only thing being fitted is the
hyperparameter vector, and it may only be chosen using scores from held-out
seasons. The rating pass always runs forward over everything. Write that down
before coding it.

Grid: `itertools.product`.

Per-season HFA *is* vectorizable; the naive estimator is a one-line group-by on
non-neutral regular season games. Your decision: is mean margin the right
estimator, or should you regress out team strength first? Both defensible. Pick
one and write down why, because it feeds every future prediction.

Two parameter names renamed in polars 1.0 that will cost you an afternoon: it is
`min_samples`, not `min_periods`. And the `.shift(1)` stops season S using its
own HFA:

    pl.col("hfa_raw").rolling_mean(window_size=3, min_samples=1).shift(1)

## Phase 2

From `player_stats_week`: `player_id, season, week, attempts, sacks_suffered,
passing_epa, rushing_epa, passing_cpoe`. Checked: `sacks_suffered` is 0% null in
every era, so dropbacks is safe back to 1999. `(player_id, season, week)` is
unique across all 17,713 QB-games, so a left join cannot fan out.

The leakage guard:

    qb_form = (
        per_game_qb_value                # one row per (player_id, season, week)
          .sort("player_id", "season", "week")   # polars will NOT sort in the window
          .with_columns(
              form = pl.col("epa_per_dropback")
                       .???               # rolling_mean or ewm_mean. Pick, justify.
                       .shift(1)          # the guard. Inside the window, before .over.
                       .over("player_id") # easiest line in the file to forget
          )
    )

`.over()` wraps the whole chain, not just the aggregation. Polars does not sort
within a window, so the explicit `.sort()` is load-bearing. `ewm_mean` takes
exactly one of `half_life`, `span` or `alpha`, plus `ignore_nulls`. The choice
between rolling and EWMA is yours: decide from how fast you believe QB play
actually changes, and defend the number.

Rookie prior: `draft_picks` has `gsis_id`, `round`, `pick`; `players` also
carries `draft_round` and `draft_pick` directly. Check which is more complete
for your seasons before committing. Shrinkage weight is your call.

The leaky version is a one-line difference: join on the same week instead of the
shifted one. Score both, keep both numbers, put them in the commit message.

## Phase 3

`pbp` has 372 columns and 305 MB. **Always `.select()` before `.collect()`.**
Worth having: `game_id, posteam, defteam, season, week, epa, success, pass,
rush, qb_dropback, play_type, special, penalty`.

No `canonicalize()` needed on pbp: your own sweep established all 16 team
columns carry modern ids. `schedules` is the outlier and `games.py` handles it.

Rolling team form is the same sort-shift-over pattern keyed on team. Write once,
use twice.

**The one function you would not have found on your own: `join_asof`.** For "the
most recent depth chart snapshot before this kickoff" or "the latest line I had
on Tuesday", an equality join cannot express the question and a filter-per-row
is unusably slow.

    games.join_asof(
        snapshots,
        left_on="kickoff", right_on="dt",   # both frames must be sorted on these
        by="team",                          # match within team, take the latest dt
        strategy="backward",                # never look forward. the leakage guard.
    )

The single most useful function in polars for leakage-safe features, and how
you will consume both the 2025+ depth chart feed and your own odds snapshots.
Learn it in Phase 2 and Phase 3 gets much shorter.

For ridge, use sklearn's `Ridge` inside a `Pipeline` with `StandardScaler`. Not
stylistic: ridge penalises raw coefficient magnitude and your features span
wildly different scales (Elo diff ~±200, rest diff ~±10, EPA/play ~±0.3).
Without scaling the penalty lands almost entirely on the small-scale features
and you will conclude EPA doesn't matter.

## What is deliberately not here

- Every blanked expression body and the parameters that go in them.
- Rolling vs EWMA and the half-life. A modelling judgement, not a lookup.
- The structure of the walk-forward grid loop.
- Which features earn their place in Phase 3, and the rookie-prior shrinkage.
- What a null starting QB should mean. You hit it on 13.8% of games; there is
  no correct answer, only a decision you can defend.
- The odds API client. Thirty lines, and writing them is how you notice what
  the response actually contains.
