# Roadmap

Written 2026-09-06. Revised **2026-09-08 (Tuesday night)** against commit
`e05db9c`. Season opener is **2026-09-09** (Wednesday), full Week 1 slate
2026-09-13.

The original document is kept below, with each item marked. The two new
sections are **Status** (what changed in 48 hours, and what I would challenge)
and **Wednesday** (the plan for tomorrow, expanded to the level of "what
function, what test, what trap").

---

## 0. Status, measured 2026-09-08

### Done since 2026-09-06

| roadmap item | evidence | verdict |
|---|---|---|
| 0.1 installable | `pyproject.toml` finds `model*`, dev extra, pytest config | done |
| 0.2 `run_elo` as a pure function | `model/elo.py`: `EloParams` frozen dataclass, dict rows keyed on `game_id`, unplayed games predicted but never learned from | done, and the loop is still correct |
| 0.2 delete `qb_elo_predict` | gone | done |
| 0.3 carry into 2026, predict Week 1 | `model/predict.py::predict_week`, sigma fitted from 2020+ residuals rather than inherited | done |
| 0.4 log before kickoff | `log_week` with sanity bounds, duplicate warning, read-back verification; commit says Week 1 was logged | done on your laptop, **not in git** |
| 0.5 publish | nothing | not started |
| Clock 2: odds snapshots | nothing | not started |
| 1.3 bias guard, 1.4 model tests | zero tests import `model` | not started |

Test suite: 111 pass, 1 fails on a fresh clone because
`test_unsafe_union_can_be_opted_out_of` reads the parquet cache without the
`needs_data` marker. Two-line fix.

### Things I would challenge

These are not bugs. They are places where the code makes a claim the repo
cannot back up.

**1. The track record exists only on one disk.** `data/` is gitignored, so
`predictions.parquet` is not in the repository. A pre-kickoff prediction that
lives on your laptop is indistinguishable, to anyone but you, from one you
backfilled. Git is the cheapest independent timestamp you have: commit the log
before kickoff and the hash in a public repo is evidence a stranger can check.
This is the single most important gap and it is fifteen minutes of work.

**2. Three parameters changed without a written reason.** The 2026-09-06
measurement used `k=16, hfa=45, mov_mult=0.45`. The code now ships
`k=15, hfa=32.5, carryover=0.45`, the FiveThirtyEight margin multiplier is
hard-coded with its `2.2` constants, and `mov_mult` no longer exists. Two
questions:

- Where did `hfa=32.5` come from? At 20 points per Elo that is 1.6 points of
  home field, against a 2023-25 mean margin of +2.41. It may well be right for
  2026, but the roadmap's rule was "every number you quote from here is
  walk-forward or it does not get quoted", and the repo contains no
  walk-forward run.
- `carryover=0.45` is the exact value the old `mov_mult` had. Carrying 45% of
  last season's rating means regressing 55% to the mean, which is far heavier
  than the usual one-third. Either you measured that and it is a genuine
  finding worth writing down, or the number survived a rename. The Wednesday
  plan includes the grid run that settles it.

The `notes` column in the log records the parameters, so whatever they are,
Week 1 is attributable. That is good. But the next `model_version` needs to be
chosen by the harness, not by hand.

**3. The scoring rule is a print statement.** `log_week` says "score on the
earliest `logged_at` per game" and nothing implements it. There is no
`score_week`. Monday is five days away and this is the function you will need.

**4. Kickoff time is not in the spine.** `build_game_spine` keeps `gameday`
but drops `gametime`, so nothing can assert `logged_at < kickoff`. A track
record needs that assertion, and you cannot add it after the fact for the
games you have already logged unless the raw schedules keep the time, which
they do.

**5. The frontend.** You built one for other stats, it is not committed, and
the `.gitignore` has `package.json` exceptions and an
`explorer/cache` entry pointing at something that is not in the repo.
Uncommitted work is not work anyone can see, including you in six months.
The original rule stands: no web app for the predictor in Week 1. The
amendment: since a frontend now exists, the cheapest publish surface (0.5) may
be a static JSON export it renders, *if and only if* that is faster than a
README table. It probably is not, tomorrow. Do the README first and wire the
frontend on the weekend. And commit it tonight, in its own top-level
directory, so it stops being invisible.

---

## Wednesday 2026-09-09: the plan, expanded

Ordered by "what is lost if it slips", not by interest. Roughly nine hours
of work; the first three tiers are the day, tier D is if you are still going.

### Tier A: before the opener kicks off. Nothing else matters until these are done.

**A1. Put the track record in git.** (15 min) *Plumbing done 2026-09-08:
`log_week` re-exports `track_record/predictions.csv`; run
`python -m model.predict --export` once for the Week 1 rows, then commit.*

Un-ignore the log or move it. Two defensible layouts:

- Add `!/data/predictions.parquet` under `/data` in `.gitignore`. Simplest,
  keeps `PRED_PATH` unchanged.
- Add a tracked `track_record/` directory and have `log_week` also write a
  CSV there. A CSV diffs in a pull request; a parquet does not. This matters
  because a reviewable diff *is* the audit trail.

Take the second. Then commit with the message "Week 1 predictions, logged
<timestamp>" and push. Definition of done: the commit is visible on GitHub
before the first kickoff.

*Trap:* do not regenerate and re-log Week 1 to "clean it up". A second row
per game is exactly what the earliest-`logged_at` rule exists to handle, and
re-logging after the line has moved is how you accidentally launder a better
number into the record.

**A2. Carry `gametime` through the spine and assert on it.** (30 min)
*Done 2026-09-08: `kickoff` is UTC in the spine, `check_slate` refuses started
or unknown kickoffs, `logged_at` is UTC.*

Add `gametime` to `_PASSTHROUGH` in `nfl/games.py` and derive
`kickoff = gameday + gametime` as a datetime in `build_game_spine`. nflverse
stores `gametime` as `"HH:MM"` in Eastern time; decide how you store the log's
`logged_at` (it is currently naive local time from `datetime.now()`) and make
the two comparable. The honest fix is to log in UTC from now on and note the
Week 1 rows were local time in the commit.

Then `check_slate` gains one more rule: every game's kickoff must be in the
future. This turns "I logged before kickoff" from a claim into an invariant.

**A3. Odds snapshots.** (90 min, the roadmap's Clock 2, unchanged in
priority) *2026-09-09: the schedule and the commit step exist in
`lines.yml`; what remains is game spreads in the dashboard's puller.*

Write `data_handling/odds.py`. What it does:

1. One GET against a free odds API for the NFL spreads, totals and moneyline
   markets across US books.
2. Map the API's full team names to franchise ids. `team_info()` has
   `team_name`; the API uses names like "Kansas City Chiefs". Build the
   mapping once, assert it covers all 32, fail loudly on a miss.
3. Match each event to a `game_id` on `(home, away, kickoff date)`. Never on
   name strings alone.
4. Append `(pulled_at, game_id, book, spread_home, total, ml_home, ml_away)`
   to `data/odds_snapshots.parquet`, and keep the raw JSON response next to
   it. Disk is free; a field you did not think to parse today is recoverable
   from raw JSON and gone otherwise.
5. Cron it twice a day. Tuesday morning and Saturday night are the two
   snapshots that matter.

*Trap, and it is a real one:* the API reports the spread from the named
team's perspective, so a home team at `-3.5` is favoured by 3.5. Your
convention is `spread_line = expected home margin = +3.5`. That is a sign
flip on the way in. Write the test that pins it: build a fake response for a
game whose nflverse `spread_line` you know, run it through the parser, assert
equality with the right sign.

The roadmap deliberately left this client to you. That has not changed. The
above is the shape, not the code.

**A4. Fix the failing test and merge the sigma commit.** (20 min) *Done
2026-09-08, plus a GitHub Actions workflow running pytest on every push.*

- Mark `test_unsafe_union_can_be_opted_out_of` with `needs_data`, or give it
  an in-memory frame. A fresh clone must go green.
- `origin/groundwork` carries one unmerged commit, `7373cdc`: sigma becomes
  a required argument to `margin_to_win_prob`, `fit_sigma()` is added, and
  `brier_decomposition` reports the binning residual so `decomposed` equals
  `brier` exactly. It cherry-picks onto `main` cleanly (checked). `predict.py`
  already passes `sigma=` explicitly, so nothing breaks. Then replace the
  `margin_summary(...)["residual_sd"]` call in `predict_week` with
  `fit_sigma`, which is the function that was written for that purpose.

### Tier B: makes the record scoreable. Do before Monday, ideally tomorrow.

**B1. `score_week` and the running table.** (2 hr)

The function that does not exist yet and that every Monday needs. In
`model/score.py`:

    score_week(season, week, model_version) -> DataFrame

1. Read the log, filter to `(season, week, model_version)`.
2. Keep the **earliest** `logged_at` per `game_id`. This is the rule the warning
   in `log_week` promises. Implement it once, here, and the warning becomes a
   pointer to a real thing.
3. Join to the spine on `game_id`. Require `logged_at < kickoff` (from A2)
   and drop, with a loud print, anything that fails.
4. Compute MAE, bias, Brier, log loss and ATS against `market_spread` **as
   logged**, not against nflverse's current `spread_line`, which will have
   become the closing line by Monday. This is the point of logging the line:
   your Week 1 spread is the only copy of the Tuesday number you will ever
   have.
5. Append one row per `(season, week, model_version)` to
   `track_record/weekly.csv`, and regenerate the cumulative reliability table.

Tests, on a synthetic log: earliest row wins; a row logged after kickoff is
excluded; a game with no result yet is excluded, not scored as zero.

**B2. Model tests.** (1 hr, roadmap 1.4 expanded)

`run_elo` currently returns only pre-game ratings per game, so rating
conservation cannot be tested from its output. The roadmap asked you to
decide whether it also returns rating history. Decide yes: return a second
frame, one row per `(season, week, team, elo)` after the week's updates.
Phase 1 (HFA per season) and Phase 2 (QB validation) both need it and so do
these tests. Build the synthetic spine in `conftest.py` with the nine columns
`run_elo` reads: `game_id, season, week, home, away, margin, neutral,
spread_line, total_line`.

- *Conservation.* Within a season the sum of all ratings is constant across
  weeks. Across a season boundary it changes only by the regression, which
  is computable.
- *Dominance.* A team that wins every game by 20 finishes the season with the
  top rating, and its rating rises monotonically.
- *Symmetry.* Swap `home` and `away` on a neutral game and `pred_margin`
  negates exactly.
- *No leak from the future.* Predictions for week W are identical whether the
  games of weeks W and later have null margins or are absent entirely. This
  one guards the property that makes Tuesday predictions honest.
- *Expansion seeding.* A franchise with `first_season == season` starts at
  `EXPANSION_ELO`, not at the regressed mean.

**B3. The bias guard.** (15 min, roadmap 1.3)

`needs_data` test: `|bias| < 0.3` on the 2020+ backtest. Cheap, and it is the
test that catches a wrong HFA before it reaches the log.

### Tier C: turns the parameter question into a number. Tomorrow afternoon if A and B are done.

**C1. Walk-forward grid, done the efficient way.** (2 hr including runtime,
roadmap 1.1 expanded)

The field notes below explain why Elo cannot be cross-validated by discarding
seasons: the ratings are state. The consequence is a cheaper design than the
naive one:

1. Grid `k` in {8, 12, 16, 20, 24, 32}, `hfa` in {25, 30, 35, 40, 45, 50},
   `carryover` in {0.45, 0.55, 0.67, 0.75}. That is 144 vectors.
2. Run `run_elo` **once** per vector over all seasons and record MAE per
   season. 144 runs at about two seconds each is five minutes. Cache the
   result table to parquet; you will re-read it many times.
3. Walk-forward selection is then a table operation, not a loop: for each
   test season S from 2010 to 2025, pick the vector with the lowest mean MAE
   over seasons before S, and record that vector's MAE on S. The mean of
   those held-out MAEs is your honest number.
4. Report it next to the in-sample optimum on 2020-2025. The roadmap predicted
   the out-of-sample number will be slightly worse. Write both down.

This run answers the `carryover` question. If 0.45 wins walk-forward, keep it
and say so in the docstring. If 0.67 wins, the number survived a rename and
you have found it before it cost you a season.

*Trap:* the selection in step 3 must not use season S or anything after it.
Assert it in code, not in your head.

**C2. Per-season HFA.** (1 hr, roadmap 1.2)

One group-by on non-neutral regular-season games gives mean margin per
season. Multiply by `points_per_elo` to get Elo units. Plot it. Then feed a
trailing three-season mean, shifted by one, into the loop instead of the
constant. `EloParams.hfa` becomes an optional per-season mapping with the
constant as fallback. Ship it as `elo-v2` when it beats `elo-v1` walk-forward,
and not before.

### Tier D: only if you are still going.

**D1. Publish (0.5).** A `track_record/README.md` generated by a script: the
Week 1 table from `slate_view`, the honest header paragraph with the 0.408
gap, and, from Monday, the weekly scores table. A script that regenerates a
markdown file is a frontend you can maintain in ten minutes a week.

**D2. Commit the frontend.** Own directory, own README stating what it reads
and how to run it. If it can render a JSON file, have D1's script also write
`track_record/predictions.json`, and the frontend gets the predictor for the
cost of one fetch.

### What "better than planned" means, concretely

The original Wednesday target was: 16 logged rows, an odds cron, a URL. You
have the rows. Better than planned by tomorrow night is: the rows in git
(A1), kickoff enforced (A2), the odds cron (A3), a green test suite with the
model under test (A4, B2), and a `score_week` that exists before there is
anything to score (B1). The grid (C1) is the stretch. If you get to C1, the
parameter question stops being a question.

Do not touch Phase 2 tomorrow. The QB layer is the most interesting thing on
this page and it is worth nothing without B1.

---

## 1. Where you actually are (original, 2026-09-06)

Measured, not assumed. Full pass of `model/elo.py` over 1999-2025, hand-set
`k=16, hfa=45, mov_mult=0.45, points_per_elo=20`:

| era | n | elo MAE | market MAE | gap | ATS |
|---|---|---|---|---|---|
| 1999-2006 | 2112 | 10.586 | 10.422 | +0.164 | 52.2% |
| 2007-2013 | 1869 | 10.924 | 10.704 | +0.220 | 51.3% |
| 2014-2019 | 1602 | 10.360 | 10.096 | +0.264 | 51.5% |
| 2020-2025 | 1693 | 10.175 | 9.767  | **+0.408** | **50.1%** |

> **2026-09-08:** these numbers were produced by the parameters above, not
> the ones now in `EloParams`. Until C1 runs, the table describes a model
> that no longer exists in the code. Re-run `python -m model.elo` and paste
> the new table here before quoting either.

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
13.09, so a sigma near 13 is nearly exact for this model, and `predict_week`
now fits it rather than assuming it. The wins are elsewhere.

### What is solid

`nfl/teams.py` is genuinely good work. The relocation and duplicate-franchise
handling is the exact class of bug that silently corrupts a rating system, and
you found it before it bit you. `nfl/evaluate.py` already has walk-forward
splits, a reliability table and a Brier decomposition. `nfl/games.py` fixes the
sign conventions in one place. `nfl/depth.py` reads across the 2025 schema
break with the era detected from content. 25 nflverse tables are cached
locally.

Added 2026-09-08: `model/elo.py` is now a module with a pure `run_elo`, and
`model/predict.py` refuses to write a slate that fails its own sanity checks
and verifies what it wrote by reading it back. That second habit is rarer than
it should be.

The data and evaluation layers are ahead of the model layer. That is the right
way round and it is why the next four weeks can move fast.

### What is broken or missing (revised)

- ~~`model/elo.py` is a script, not a module.~~ Fixed.
- Hyperparameters are still hand-set and unevaluated (C1).
- ~~`qb_elo_predict()` is dead code with a leaking join.~~ Deleted. The leak
  rule is restated in Phase 2 and must be the first line of the file that
  brings it back.
- `data/predictions.parquet` has 16 rows and is not in git (A1).
- No `score_week` (B1). No kickoff time in the spine (A2).
- Zero tests cover the model (B2, B3).
- No odds snapshots (A3).

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
*Status: Week 1 logged locally. Not yet in git. See A1.*

**Clock 2: live odds snapshots.** `spread_line` in nflverse is the *closing*
line, backfilled. That is the toughest possible benchmark and it is also not the
number you could ever have bet. Beating the **opening** line, or the line
available Tuesday morning, is a genuinely achievable target and a more honest
one. But nflverse does not archive line movement, so you can only get this by
snapshotting it yourself, starting now.
*Status 2026-09-09: the dashboard's ESPN puller captures DraftKings props
per pull, and `.github/workflows/lines.yml` now runs it four times a day and
commits each snapshot to `data/odds/`. Game spreads still need the Odds API
provider (a key) or an ESPN game-lines pull; A3 is that one addition, not a
new script. See DEPLOY.md for the pipeline.*

Total cost: about 90 minutes. Do both before Wednesday.

---

## Phase 0: ship by Wed 2026-09-09

Target: a `predict.py` that produces Week 1 numbers and logs them before the
opener.

- **0.1 Make the repo importable.** Done.
- **0.2 Turn `elo.py` into a function with no side effects at import.** Done.
  The loop reads all pre-game ratings for a week before updating any of them,
  which is the bug most people ship and you did not.
- **0.3 Carry ratings into 2026 and predict Week 1.** Done. `check_slate`
  enforces win probabilities in [0.05, 0.95] and ratings in [1200, 1800].
  Those bounds are looser than the 1350-1700 the roadmap suggested; fine for a
  guard, but print the actual min and max on every run so you see drift
  before the guard does.
- **0.4 Log it, before kickoff.** Done locally. **A1 makes it real.**
- **0.5 Publish it.** Not done. D1.

**Definition of done (revised):** by Wednesday's kickoff, the Week 1 rows are
in a pushed commit, `check_slate` rejects any game whose kickoff has passed,
and the odds cron has made its first pull.

> **Learning objective:** accuracy and calibration are different skills. Run
> `brier_decomposition` on your 2020-2025 backtest before you ship. Watch
> `resolution` and `reliability` move independently. A model can have a
> respectable MAE and produce probabilities that are systematically overconfident.

---

## Phase 1: make the evaluation honest (Weeks 1-2, in-season)

The model does not change here. Only your ability to trust it does. This is the
single highest-value phase for learning and the one most people skip.
Expanded above as B1, B2, B3, C1, C2. The original text follows for the
reasoning.

**1.1 Tune with walk-forward, not by eye.** See C1 for the efficient design.

Expect an uncomfortable result: your walk-forward optimum will likely be close
to what you already hand-picked, and out-of-sample MAE will be slightly *worse*
than the in-sample number. That discomfort is the lesson. Write down both
numbers side by side.

**1.2 Make HFA time-varying.** League-wide home field advantage has fallen
substantially since 2019 (COVID empty stadiums, and it never fully came back).
A single HFA fitted across 1999-2025 is wrong for 2026 in one direction or the
other. Fit HFA per season, plot it, and use a trailing 3-season estimate going
forward. See C2.

**1.3 Add a `bias` guard to the test suite.** See B3.

**1.4 Add model tests.** See B2.

**1.5 (new) `score_week` and the Monday cadence.** See B1. Without it Phase 1
has no output.

**1.6 (new) The logistic check: is the probit calibrated?** (20 min)

There is no fitted model in the repo yet. Win probability comes from a normal
CDF of `pred_margin / sigma`, a probit link with a hand-set slope. This is the
smallest possible regression and it exists to test that link, not to replace
it.

1. Fit a logistic regression of home win on Elo diff (with the HFA term
   already inside the diff, as `run_elo` computes it), walk-forward on 2020+.
   One feature, one coefficient, one intercept.
2. Score both the logistic and the probit on the held-out seasons with Brier
   and the reliability table. Report them side by side.
3. Read the coefficient. Your probit implies a slope of
   `1 / (sigma * points_per_elo)` in Elo units. If the fitted logistic slope
   is far from the equivalent, the hand-set conversion is miscalibrated and
   the reliability table will show it as a consistent lean in the middle
   buckets. If the intercept is far from zero, HFA is wrong, which the bias
   guard (1.3) should already have caught.

Expect near-agreement. The point is that "near" becomes a number, and that
you have fitted one coefficient and compared it to a constant before you fit
ten of them in Phase 3.2.

Also note that the update loop uses a *different* win function: the chess
logistic with the 400 scale, for expected score only. At a 100-point edge it
says about 64%; the probit says about 65%. They agree by coincidence of the
current parameters, not by design. Only the probit reaches the log, so only
the probit is what this check is about.

> **Learning objectives:** in-sample versus out-of-sample fit, felt rather than
> read about; non-stationarity, a parameter fitted on 2005 football is wrong for
> 2026; regression tests as a guard on statistical properties, not just outputs.
> Also: what a fitted coefficient is next to a hand-set constant, and why a
> rating system is not a regression.

---

## Phase 2: the QB layer (Weeks 2-4)

The largest known upgrade to a vanilla NFL Elo. Team ratings implicitly assume
continuity of personnel; the starting QB is the one position where that
assumption breaks hard enough to move a line by a touchdown.

**2.1 Fix the leak first, in writing.** The deleted draft joined the QB's
stats for the game being predicted. Before writing any code, write the rule at
the top of the file: *every feature for game G must be computable from data
available before G kicks off.* Then build a rolling value: EWMA of the QB's
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
injury, any 2020 Broncos game. The rating history frame from B2 is what makes
this validation possible.

**2.4 Handle the announcement problem.** Starters are confirmed late in the
week. `schedules.home_qb_id` is backfilled after the fact, so using it is a
mild leak for live prediction. For real Tuesday predictions you need
`depth_charts` plus `injuries` (both cached), or a manual override file.
`nfl/depth.py` already gives you the modern era as timestamped snapshots with
an `asof` column; the `join_asof` in the field notes is the consumer. Note
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
- **Target the opening line.** With the A3 snapshots accumulating, ask whether
  your Tuesday number beats the Tuesday line. Genuinely more achievable, and
  now you have the data.
- **Look for subsets, not a universal edge.** Extreme weather, large
  underdogs, short-week road games, backup QB starts. Be extremely careful:
  hunting subsets across a 285-game season is how you find noise. Pre-register
  the hypothesis before you look, and require it to hold out of sample.
- **Calibration as the product.** A model that says 62% and hits 62% is useful
  for analysis and content even when it never beats a line.

> **Learning objectives:** efficient markets in practice; multiple-comparison
> discipline; distinguishing an edge from a story.

---

## Phase 5: player props (Weeks 8+, a second project that reuses the first)

A prop is not a feature of the game model. It is a distribution over one
player's stat line, and it needs three sub-models stacked, of which the game
model supplies only the third:

    prop = opportunity(player, game) x efficiency(player, matchup) | game script

    opportunity   targets, carries, dropbacks. Driven by role and by who is
                  active. The stable part.
    efficiency    yards per target, yards per carry, catch rate. Noisy; shrink
                  hard toward position priors.
    game script   a team trailing by ten throws more. Your margin and total
                  feed this, which is the only thing Phases 0-4 contribute
                  directly.

You planned for this on day one without saying so: `ff_opportunity` is
annotated "opportunity beats efficiency", `snap_counts` is "the foundation of
role", and the NGS and PFR tables are player-level charting. The data layer
was built for props. The model layer has not started, and this phase is where
it does.

**Why not sooner.** Every prerequisite is something an earlier phase builds:

- The as-of joins from Phase 2. Inactives are announced ninety minutes before
  kickoff. Without `join_asof` against the depth chart and injury snapshots,
  every prop backtest leaks the final roster and looks better than it is.
- The rolling-form pattern from Phase 2. Target share over the prior N games,
  shifted, is the same sort-shift-over code as QB form, keyed on player.
- The feature-table discipline and the leak test from Phase 3.1.
- A scored game-model track record, so the game-script input is a number you
  trust rather than a number you hope.

**5.0 Decide why, before what.** Two honest reasons lead to different first
props. If it is edge: prop markets are softer than the spread (lower limits,
more books, slower lines), but the edge is mostly line shopping and speed,
and books limit winners fast. If it is product: props are what people
actually read every week, which is the better reason and the one this phase
assumes. Write the answer at the top of the module.

**5.1 The line problem, and a clock that starts when you decide.** Historical
prop lines are not free anywhere. If you ever want to claim a prop track
record against a line, the snapshots must start before the predictions, same
as Clock 2. The free odds tier cannot afford per-event prop pulls on top of
the game odds. This is a cost decision: either pay for a tier that covers
props from the week you start, or accept that the props record is scored
against outcomes only, never against a line. Either is defensible. Not
deciding is the one wrong answer, because it is the same as deciding "no
line" while believing otherwise.

**5.2 First prop: receptions.** Then passing attempts. Both are driven by
opportunity, which is stable week to week, and both are roughly Poisson, so
the whole distribution is tractable from one rate. Definition of done for the
first version: a mean and a distribution per active receiver, backtested
walk-forward on 2020+, scored by log-likelihood of the observed count and by
hit rate over a fixed set of thresholds (3.5, 4.5, 5.5 ...), with the
reliability table reused from `nfl/evaluate.py` on "over 4.5" as a binary
forecast.

- *Opportunity:* target share over the prior N games, shifted, shrunk toward
  a position-and-depth-rank prior. Multiply by the team's expected pass
  attempts, which is where game script enters: expected attempts as a
  function of your predicted margin and total, fit on 2020+.
- *Efficiency:* catch rate, shrunk hard. Forty targets tell you almost nothing.
- *The active gate:* a player only gets a prediction if the latest depth
  snapshot before kickoff lists them and `injuries` does not rule them out.
  Log the snapshot timestamp with the prediction.

**5.3 What not to model first.** Touchdowns: rare, almost pure noise at the
player level, and the prop everyone wants. Rushing yards: one sixty-yard run
breaks a normal and a Poisson alike; needs a heavy-tailed distribution and
more data than you have. Both come after receptions works, if at all.

**5.4 Its own log, its own namespace.** `data/props.parquet` with its own
schema (`logged_at, game_id, gsis_id, market, line_or_none, pred_mean,
pred_dist_params, model_version, snapshot_asof, notes`) and `model_version`
strings prefixed `props-`. Do not put prop rows in the game log. The scoring
rules differ and the two records should be readable separately.

**5.5 Couple, do not merge.** The game model stays an input to the props
model, never the reverse. Re-run props whenever the game prediction changes;
never adjust a margin because a prop looked wrong.

> **Learning objectives:** count models and overdispersion, a Poisson whose
> variance exceeds its mean is telling you the rate is not constant; hierarchical
> shrinkage, how much to trust a player versus their position; distribution
> forecasts scored as distributions rather than as point estimates; the gap
> between a stat line you can model and a market you can access.

---

## Weekly cadence, from Week 1 onwards

Non-negotiable, about 45 minutes:

- **Tuesday:** refresh ingest, `python -m model.predict --log`, commit and
  push the log, regenerate the README.
- **Wednesday:** odds snapshot cron confirmed running (check the parquet grew).
- **Monday:** `score_week` for last week. Commit the appended row in
  `track_record/weekly.csv`. Update the reliability table. Do not touch model
  parameters mid-season based on one week; a 16-game sample tells you nothing
  and reacting to it is the fastest way to overfit your own season.

Model changes ship as new `model_version` strings so the track record stays
attributable. `elo-v1` is now frozen: the parameters it logged Week 1 with are
the parameters it keeps.

---

## What not to do

- **Do not chase ATS.** The 2020-2025 evidence says no. Revisit only after
  Phase 4 and only against opening lines.
- **Do not add datasets.** You have 25 tables and use two. `pbp` is 305 MB
  and you have not touched it. Breadth is not the constraint.
- **Do not build a web app for the predictor in week 1.** Amended: the stats
  frontend exists, so commit it and feed it a JSON export when D1 is done.
  It must never be on the critical path of Tuesday logging.
- **Do not tune on the full sample again.** Every number you quote from here
  is walk-forward or it does not get quoted. This now includes the three
  parameters in `EloParams`.
- **Do not skip Phase 1 to get to Phase 2.** Phase 2 without honest evaluation
  is a model you cannot tell is working.
- **Do not re-log a week.** (New.) The earliest row is the record. A second
  row is allowed only when the model version changes.

---

## Sequenced summary (revised)

| when | ship | you learn |
|---|---|---|
| Tue 9/8 night | ~~failing test fixed, sigma commit merged~~ done; CI added; frontend still to commit | a clean clone is the only clone that counts |
| Wed 9/9, before kickoff | log in git, kickoff enforced, odds cron | unbackfillable evidence |
| Wed 9/9 | model tests, bias guard, `score_week` | statistical invariants as tests |
| Wed 9/9 stretch | walk-forward grid, the `carryover` answer | in-sample vs out-of-sample |
| Mon 9/14 | first scored week, README | calibration vs accuracy, on your own numbers |
| weeks 1-2 | per-season HFA as `elo-v2`, logistic calibration check | non-stationarity, fitted vs hand-set |
| weeks 2-4 | QB adjustment, leaky version scored first | temporal leakage, shrinkage |
| weeks 4-7 | feature table, ridge, then GBM | feature engineering, regularisation, small-data reality |
| weeks 7+ | market residual model, subset hypotheses | market efficiency, multiple comparisons |
| weeks 8+ | props track: receptions first, own log, own namespace | count models, shrinkage, distribution scoring |

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

## Two bugs that were sitting in your data layer (both now handled)

**Loud: `scan("injuries")` used to raise.** `season` and `week` are `Float64`
in the 2009-2020 files and `Int32` in 2021+. `nfl/data.py` now passes
`integer_cast="allow-float"` and `normalize_keys` casts both back to `Int32`
on the way out, so an integer filter matches. Keep `KEY_DTYPES` in mind when
you add a third key column.

**Silent: `depth_charts` changed schema entirely in 2025.** Row counts are
37,327 (2023), 37,312 (2024), **554,215 (2025)**, 485,277 (2026).

    2001-2024   season, club_code, week, game_type, depth_team,
                position, depth_position, gsis_id, ...
    2025+       season, dt, team, player_name, espn_id, gsis_id,
                pos_grp, pos_abb, pos_slot, pos_rank

`scan("depth_charts")` now raises `SchemaBreak` by name, and
`nfl.depth.load_depth_charts` reads file by file and projects both eras onto
one schema with separate `week` and `asof` keys. The starter is
`position == "QB"` and `rank == 1`. On the modern era that is one row per
snapshot, and narrowing to "as of Tuesday" is the `join_asof` below.

## Phase 0

**Do not vectorize the rating loop.** ~7,300 games, about two seconds. Elo is
inherently sequential: each update depends on the state the previous game left.
This is the one place a loop is correct, and knowing when *not* to reach for
numpy is worth as much as knowing how.

`partition_by(["season","week"], maintain_order=True)` is right. Keep it.

Getting Python-computed values back into a frame: parallel lists and positional
alignment work until they don't. The contract that cannot drift is to
accumulate dicts carrying `game_id`, build a frame, and join back on that key.
(Done: `run_elo` does exactly this.)

Decide now, not twice: does `run_elo` also return per-week rating history?
Phase 1's HFA work and Phase 2's validation both want it. **Decided above, B2:
yes.**

Params object: `@dataclass(frozen=True, slots=True)`. Done.

**On the log's schema.** `log_predictions` builds the frame with
`pl.DataFrame(rows, schema=PRED_SCHEMA)`, and the rows carry extra keys
(`home`, `pre_home_elo`, ...) that the schema does not name. Polars drops
them silently. That is convenient today and a trap tomorrow: a typo in a
rename produces an all-null column, which is exactly what the read-back check
in `log_week` exists to catch. Keep that check.

**On time.** `datetime.now()` is naive local time. Kickoffs are Eastern.
Your cron will run wherever the machine is. Pick UTC for everything you write,
today, and convert only for display.

## Phase 1

**The subtlety that makes Elo different from ordinary cross-validation.** You
cannot "train on 1999-2010, test 2011" by discarding earlier games, because
ratings are cumulative state, not fitted coefficients. You must run the ratings
*through* the training seasons to reach the state 2011 starts from. So "fit on
train only" means something narrower here: the only thing being fitted is the
hyperparameter vector, and it may only be chosen using scores from held-out
seasons. The rating pass always runs forward over everything. Write that down
before coding it. (C1 turns this into a per-season MAE table computed once per
vector, then a selection rule over that table.)

Grid: `itertools.product`.

Per-season HFA *is* vectorizable; the naive estimator is a one-line group-by on
non-neutral regular season games. Your decision: is mean margin the right
estimator, or should you regress out team strength first? Both defensible. Pick
one and write down why, because it feeds every future prediction.

Two parameter names renamed in polars 1.0 that will cost you an afternoon: it is
`min_samples`, not `min_periods`. And the `.shift(1)` stops season S using its
own HFA:

    pl.col("hfa_raw").rolling_mean(window_size=3, min_samples=1).shift(1)

For 1.6, `LogisticRegression` from sklearn with `penalty=None` (one feature
does not need regularising) is enough; add scikit-learn to `dependencies` in
`pyproject.toml` at that point, since Phase 3 needs it anyway. The
equivalent-slope comparison: a probit slope `b` corresponds roughly to a
logistic slope `1.6 * b`, so compare the fitted logistic coefficient to
`1.6 / (sigma * points_per_elo)`. The 1.6 is the usual logistic-to-probit
scale factor, not something to tune.

**Scoring against the logged line, not the current one.** By Monday nflverse's
`spread_line` for Week 1 is the closing number. Your `market_spread` column is
the Tuesday number. `score_week` must use the column from the log. If you find
yourself joining the spine's `spread_line` back in for scoring, stop.

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
        left_on="kickoff", right_on="asof",  # both frames must be sorted on these
        by="team",                           # match within team, take the latest
        strategy="backward",                 # never look forward. the leakage guard.
    )

The single most useful function in polars for leakage-safe features, and how
you will consume both the 2025+ depth chart feed and your own odds snapshots.
Learn it in Phase 2 and Phase 3 gets much shorter. `kickoff` is the column A2
adds to the spine; this is the second reason it needs to exist.

For ridge, use sklearn's `Ridge` inside a `Pipeline` with `StandardScaler`. Not
stylistic: ridge penalises raw coefficient magnitude and your features span
wildly different scales (Elo diff ~±200, rest diff ~±10, EPA/play ~±0.3).
Without scaling the penalty lands almost entirely on the small-scale features
and you will conclude EPA doesn't matter.

## Phase 5

`player_stats_week` has `targets`, `receptions`, `receiving_yards`,
`carries`, `attempts` per `(player_id, season, week)`, and the key is unique,
so the rolling window is the Phase 2 pattern with `player_id` in place of the
QB. `ff_opportunity` carries expected values per opportunity already; check
whether its `targets` agrees with `player_stats_week` before trusting either.

Team pass attempts as a function of game script: regress `attempts` (team,
from `team_stats_week`) on `spread_line` and `total_line` over 2020+. The
coefficients are the game-script coupling. Expect the spread coefficient to be
small and the total coefficient to carry most of it.

**Poisson first, then check the variance.** If observed variance of receptions
around your predicted mean is well above the mean, that is overdispersion and
the honest fix is a negative binomial, not a wider Poisson. Measure before
switching; the measurement is one group-by.

The roster gate is a `join_asof` on `asof` from `nfl.depth.load_depth_charts`,
`by="team"`, `strategy="backward"`, then a filter on `rank`. It is the same
call as the Phase 2 starter lookup with a different position filter. Log the
`asof` you used with every prop row; when a player is scratched at 11:30 on
Sunday and your snapshot was Tuesday, that timestamp is the difference between
"model was wrong" and "model was right about a different game".

`snap_counts` is the one table keyed on PFR ids. Route it through
`players.pfr_id`, per the ID table above, before it touches anything GSIS.

## What is deliberately not here

- Every blanked expression body and the parameters that go in them.
- Rolling vs EWMA and the half-life. A modelling judgement, not a lookup.
- The structure of the walk-forward grid loop beyond the design in C1.
- Which features earn their place in Phase 3, and the rookie-prior shrinkage.
- What a null starting QB should mean. You hit it on 13.8% of games; there is
  no correct answer, only a decision you can defend.
- The odds API client. Thirty lines, and writing them is how you notice what
  the response actually contains. The sign flip in A3 is the one thing worth
  knowing before you start.
- The shrinkage weights in Phase 5, and whether to pay for prop lines. The
  first is a modelling judgement; the second is a budget.
