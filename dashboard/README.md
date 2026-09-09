# Props research dashboard

A local web app for researching NFL player props by hand: any player's game
log against any stat, with the sportsbook line drawn over it, plus
cross-book line comparison, play-by-play situational splits, team tendencies
and head-coach profiles. It is deliberately separate from the prediction
model in `model/`; the only coupling is a slot that displays whatever the
model logs.

## Run it

```bash
# one-time
venv/bin/pip install -e ".[dashboard]"
(cd dashboard/web && npm install && npm run build)
venv/bin/python -m dashboard.stats.team          # team tendency table, ~1 min

# every time
venv/bin/uvicorn dashboard.api.app:app --port 8017
# open http://localhost:8017
```

For frontend development run `npm run dev` inside `dashboard/web` (port 5173,
proxies `/api` to 8017) instead of building. `.claude/launch.json` has both.

## Pulling lines

Lines are never fetched on page load. Every pull appends a parquet snapshot to
`data/odds/{props,games}/` so line movement accumulates; nothing is overwritten.

| source | what you get | cost |
|---|---|---|
| `espn` | DraftKings player-prop **lines** (no prices) with opening numbers, plus DK spread/total/moneyline. Exact player ids. | free, no key |
| `oddsapi` | DraftKings, FanDuel, BetMGM, Caesars, BetRivers and more, **with prices**. | [The Odds API](https://the-odds-api.com) key in `.env`; 1 credit per market per game (free tier 500/month) |
| `sample` | Generated multi-book lines from last season's averages, for exploring the UI. Flagged everywhere and hidden once real lines exist for the week. | free |

```bash
venv/bin/python -m dashboard.odds.pull --source espn
venv/bin/python -m dashboard.odds.pull --source oddsapi --markets player_reception_yds player_receptions --max-credits 60
venv/bin/python -m dashboard.odds.pull --source all --week 3
```

The Settings page does the same with buttons and shows the credit estimate
before spending. A cron entry twice a day during the season is the intended
use; the store is what makes "opening line vs. now" possible later.

## What is in it

- **Research**: search (current players by default; retired on request), then a bar-per-game chart for any of ~125
  stats (box score, usage shares, Next Gen Stats, PFR advanced, expected
  fantasy/yards, longest plays) with the line, rolling average, hit-rate
  tiles (filtered / L5 / L10 / season), a distribution, splits (home/away,
  favorite/dog, division, playoffs, by total, by season), a configurable game
  log table, weather and starting-QB filters and splits (cold, wind, dome;
  "with Jake Browning" vs "with Joe Burrow"), small-multiple comparisons, and **play-level situational
  splits**: shotgun vs under center, red zone, down and distance, play action,
  motion, RPO, box count, personnel, formation, coverage, pressure, route.
  A **Focus** toggle highlights the handful of stats that matter for the
  selected player and prop (game-log columns, matchup rows, the stat picker)
  and dims the rest. A matchup panel shows the player's offense and the opponent's defense with
  league ranks, what the opponent allows to the player's position (defense vs
  position, per game, with rank and last four), and both teams' injury report.
- **Lines board**: every posted prop for the week across books, consensus
  (median) line, per-book deviation with outliers highlighted, best price,
  line movement since open, and L5/L10/season hit rates against the consensus.
- **Games**: spreads, totals, moneylines per book with openers, next to the
  model's logged margin and win probability.
- **Teams**: usage tree (who gets the targets and carries), defense vs
  position league table, and ~50 tendency metrics per team-season with league ranks
  (pass rate, PROE, pace, red zone, RB/WR/TE target shares, lead-back share,
  personnel, play action, motion; defense EPA, pressure, blitz, man rate,
  box counts...), season trends and game-by-game.
- **Coaches**: head-coach history across teams, per-season ranks, a
  "fingerprint" of average league percentile per tendency, and who got the
  ball each season (lead RB carry share, RB2 share, WR1/TE1 target share).
- **Predictions**: reads `data/predictions.parquet` (games) and
  `data/derived/prop_predictions.parquet` (players, schema on the page).

## Known limits

- **Routes run are not in nflverse**, so yards per route run cannot be
  computed. Target share, WOPR, aDOT and snap share are the closest proxies.
- ESPN's feed carries lines but not prices; hit rates work, no-vig math needs
  The Odds API.
- **Coverage assignments** (which corner shadows which receiver) are not in
  any nflverse table. The matchup page shows who plays and how they fare when
  targeted (PFR nearest-defender stats), and says so.
- Coaches are **head coaches** from the schedule; nflverse has no coordinator
  data, so an offensive coordinator's scheme shows up under the head coach.
- Charting coverage: FTN (play action, motion, RPO, box, blitz) is 2022+;
  participation (formation, personnel, coverage, pressure, routes) is 2016+
  and changed format in 2023.
- The team tendency table is a cache (`data/derived/dashboard_team_games_v*.parquet`).
  Rebuild after ingesting a new week of play-by-play.

## Layout

```
dashboard/
  config.py          paths, .env, current season
  stats/catalog.py   the stat registry (add a stat here, it appears everywhere)
  stats/gamelog.py   one row per game per player, all sources joined
  stats/players.py   search index, name matching for sportsbook feeds
  stats/pbp.py       play-level situational splits
  stats/team.py      team-game tendency table (sums + counts, rates on demand)
  stats/coaches.py   coach profiles from schedules x team table
  stats/context.py   defense vs position, usage trees, injury reports
  stats/matchups.py  head-to-head history, personnel, rule-based angles
  odds/markets.py    canonical market keys -> stat keys, outlier thresholds
  odds/store.py      append-only parquet snapshot store
  odds/espn.py       free DraftKings-via-ESPN provider
  odds/theoddsapi.py multi-book provider, credit-aware
  odds/sample.py     generated lines for the empty state
  odds/analysis.py   consensus, deviations, best price, recent form
  odds/pull.py       CLI / entry point used by the Settings page
  api/app.py         FastAPI; serves web/dist in production
  web/               Vite + React + TypeScript + Recharts
  DESIGN_NOTES.md    why each decision was made
  memory.md          working notes from the build
```
