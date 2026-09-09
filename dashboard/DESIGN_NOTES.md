# Design notes: how the dashboard was built, and why

Written for you to learn from, not just to document. Each section is a
decision, the alternatives that were on the table, and the principle behind
the choice. Read it top to bottom once; after that it is a reference.

---

## 0. The one-paragraph version

The dashboard is a **thin web UI over the parquet cache you already have**.
All heavy lifting is polars queries on the nflverse tables; the browser gets
JSON and draws charts. Sportsbook lines are fetched by explicit pulls into an
**append-only snapshot store**, never on page load. Everything that could be
"a list of things the app knows about" (stats, markets, split dimensions,
team metrics) is a **registry in one Python file**, and the UI builds its
pickers from that registry, so adding a metric is a one-line change with no
frontend edit. Nothing in `dashboard/` imports from `model/`, and nothing in
`model/` knows the dashboard exists.

---

## 1. Where it lives, and the dependency direction

**Decision.** A separate top-level package, `dashboard/`, with its own
optional dependency group in `pyproject.toml` (`pip install -e ".[dashboard]"`).

**Why.** You said this is not the model. Keeping it a sibling of `nfl/` and
`model/` rather than a child of either makes the rule enforceable: the
dashboard may import `nfl.data.scan` (path resolution and lazy parquet
access, no network) but never `model.*`. If the model needs to show up in
the UI, it does so by **writing a file** (`data/predictions.parquet`,
`data/derived/prop_predictions.parquet`) that the dashboard reads. A file is
the loosest coupling there is: either side can be rewritten without touching
the other, and the file is a contract you can inspect with one line of polars.

**Principle: dependencies point one way, and the arrow points at the stable
thing.** `nfl.data` is stable (it is how everything reads the cache). The
model is volatile (you will rewrite it repeatedly). The dashboard should
depend on the stable layer and communicate with the volatile one through
data, not imports.

**Alternative rejected.** Putting the API inside `nfl/`. It would have made
`nfl` depend on FastAPI, so `pip install -e .` for modelling would drag in a
web server. Optional dependency groups exist precisely for this.

---

## 2. Stack choice

**Decision.** FastAPI + polars on the backend; Vite + React + TypeScript +
Recharts on the frontend; the API serves the built frontend as static files
in production so there is one process to run.

**Why each piece.**
- *FastAPI*: pydantic is already in your venv; FastAPI is the smallest step
  from "a function that returns a dict" to "an HTTP endpoint", and it gives
  you `/docs` for free. A Django-style framework would be ceremony for a
  read-mostly API.
- *polars, lazy*: every endpoint is a `scan()` with a filter. Polars pushes
  the `player_id == x` predicate into the parquet reader, which is why a
  27-season play-by-play scan for one player takes well under a second. You
  do not need a database until you need concurrent writers, and you have
  none.
- *React + TypeScript*: the UI is state-heavy (filters, selected line,
  columns, chart windows all interact). A framework that re-renders from
  state is the right tool; TypeScript catches the "this field is sometimes
  null" bugs at build time instead of in the browser at 2am. Vite because
  its dev server proxies `/api` with one config line.
- *Recharts* over D3: you want many ordinary charts fast, not one bespoke
  visualization. Recharts gives bars, reference lines and tooltips declaratively.
  The cost is less control over pixel details, which is fine here.
- *No Tailwind, hand-written CSS with custom properties*: ~250 lines of CSS
  cover the whole app. A utility framework would add a build dependency to
  save typing we did not need to do. Custom properties (`--over`, `--under`)
  mean the over/under colours are defined once and used everywhere.

**Principle: pick the smallest tool that does the whole job, and keep the
number of moving parts you must understand low.** One Python process, one
static bundle.

---

## 3. The stat catalog: a registry, not a switch statement

**Decision.** `dashboard/stats/catalog.py` holds a list of `Stat` dataclasses:
key, label, group, number format, first season available, an optional polars
expression for derived stats, a note, and position hints. The game-log
builder evaluates the expressions; the API ships the catalog as JSON; every
picker in the UI is built from it.

**Why.** The alternative, which most first drafts do, is to hard-code stat
names in five places: the SQL/polars query, the API response, the TypeScript
types, the dropdown, and the formatter. Then adding "yards after contact per
carry" is a five-file change and one of the five is always forgotten. With a
registry the *definition* of a stat is data, and the rest of the system is
generic over it. Adding a stat is one line.

**Detail worth copying.** Derived stats are polars *expressions*, not
functions. `_ratio("rushing_yards", "carries")` returns an expression that is
only evaluated when the frame is built, inside the same query as everything
else. Expressions compose and are cheap to define; functions that take a
DataFrame would each be a separate pass.

**Detail worth copying.** `availability()` returns, per stat, the number of
games where the value is non-null *and non-zero*. The UI hides stats with
zero availability. This is why a kicker does not see receiving stats and a
2010 player does not see Next Gen Stats, without any position logic in the
frontend. Derive UI behaviour from data when you can; it is never stale.

**Principle: separate what varies (the list of stats) from what stays the
same (how a stat is charted).** This is the registry pattern, and it is the
single most reusable idea in this codebase.

---

## 4. The game log: one wide row per game, every source left-joined

**Decision.** `game_log(player_id)` returns one row per game with ~145
columns: context (opponent, home, score, spread, total) plus every catalog
stat, sourced from seven tables with different keys.

**Why one wide frame.** The UI does its own filtering (last N, home/away,
by season) and its own summaries (hit rates, averages, splits) in
TypeScript. That only works if the browser holds the whole log. A game log
is at most ~300 rows × 145 columns ≈ 150 KB of JSON, which is nothing. The
alternative, an endpoint per question ("hit rate for last 10 home games vs
this line"), would make every filter change a round trip and every new
question a new endpoint. **Ship the data once, let the client ask questions.**

**Why left joins with prefixes.** The secondary tables use different ids
(`pfr_player_id` for snap counts and PFR, `player_gsis_id` for NGS, `player_id`
for expected points) and different grains (NGS is per week, the rest per
game). Each join is optional: a missing table leaves its columns null instead
of failing, so the app works on a partial cache. Column names are prefixed
(`snap_`, `ngs_rec_`, `pfr_`, `xp_`, `long_`) because three of these tables
have a column literally called `receptions`; without prefixes a join would
silently overwrite the base value. **Name collisions are the most common
silent bug in wide joins. Prefix at the boundary.**

**Sign conventions, fixed once.** The schedule's `spread_line` is "home
margin". The game log converts it into `team_spread` from the *player's team's*
perspective (negative = favourite, the way a bettor reads it), `favorite`,
and `implied_team_total`. Every downstream consumer gets the converted
number; nobody re-derives it. This mirrors what `nfl/games.py` does for the
model, and for the same reason: a sign convention lives in exactly one place.

**Caching.** `@lru_cache(maxsize=512)` on `game_log`. Game logs do not change
during a session (the cache only changes when you re-ingest, which restarts
the server). A process-level LRU is the simplest possible cache and it made
the second load of a player instant. Do not reach for Redis when a
decorator will do.

---

## 5. Player identity: the search index and name matching

**Decision.** The search index is built from `player_stats_week` (who
actually recorded a stat line), decorated from `players.parquet` (headshot,
external ids, draft info). The team shown is `players.latest_team`, which
tracks off-season moves, falling back to the last team in the stat table.

**Why build from the stat table rather than the master.** The master has
25,000 rows including practice-squad players who never played. Indexing
"people with game logs" means every search result is guaranteed to have
something to show.

**Name matching for sportsbook feeds.** The Odds API returns players as
free text ("Ja'Marr Chase"). `normalize_name` strips accents, punctuation
and suffixes (Jr., III) and lowercases, then `match_name` looks for an
exact normalised match among recent players, using the event's two teams as
a tiebreak. This is where feeds go wrong in practice ("Josh Allen" the QB vs
the linebacker), so the tiebreak is not optional. ESPN, by contrast, carries
an `espn_id` that maps straight to `players.espn_id`, so that provider needs
no fuzzy matching at all. **When you have a choice of feeds, prefer the one
with ids over the one with names, even if it has less data.**

---

## 6. Sportsbook lines: canonical markets, append-only store, providers

### 6a. Canonical market keys
**Decision.** Markets use The Odds API's vocabulary (`player_reception_yds`)
as the canonical key. Each `Market` maps to a catalog stat, a kind
(`ou` for over/under with a line, `yesno` for price-only markets like anytime
TD), and an outlier threshold. Every provider translates into these keys at
ingestion.

**Why.** Two providers, two vocabularies (ESPN uses numeric type ids like
"13"). If the UI knew about both, every component would branch on the source.
Translating at the edge means the rest of the system has one vocabulary.
**Normalise at the boundary; keep the core single-schema.**

### 6b. Append-only snapshot store
**Decision.** Each pull writes one new parquet file
`data/odds/props/{timestamp}_{source}.parquet`. Nothing is ever rewritten.
`latest_props()` sorts by `pulled_at` and keeps the newest row per
(source, book, game, market, player, side).

**Why.** Line movement is the most valuable thing you cannot download later
(the roadmap's "clock 2"). An append-only log of snapshots is the simplest
structure that preserves it: you can always reconstruct "what did FanDuel
say on Tuesday morning". A table that is updated in place would lose that
the moment you updated it. Files are long-format (one row per side) so a
new market or a new book needs no schema change.

**Principle: when the history is the asset, never mutate. Append, and
derive "current" by reading the tail.**

### 6c. Two real providers plus a sample generator
- **ESPN** (free, no key): DraftKings lines *without prices*, with opening
  numbers, and exact player ids. Discovered by probing ESPN's public
  `core.api` endpoints. One gotcha found the hard way: it returns 403 to
  unfamiliar `User-Agent` strings, so the client sends none. That is recorded
  in `memory.md` so the next person does not spend twenty minutes on it.
- **The Odds API** (key required): many books, with prices. Player props
  cost one credit per market per event, so the provider estimates the cost
  first and refuses to exceed `max_credits`. A tool that can spend your money
  should tell you the price before it does.
- **Sample**: generated from last season's averages so the UI is not empty
  on day one. Every row is stamped `source="sample"`, the store drops sample
  rows the moment real ones exist for that week, and every page shows a
  banner when it is looking at sample data. **Fake data is fine for
  development as long as it cannot be mistaken for real data, by code or by
  eye.**

### 6d. Consensus and outliers
**Decision.** Consensus = *median* line across books. A book is flagged when
it sits at least `threshold` from the median, with a threshold per market
(6 yards for passing, 4.5 for receiving, 1 reception, 0.5 TD...). The UI
exposes a sensitivity multiplier.

**Why median, not mean.** The whole point is to spot the one book that is
off. With the mean, that book drags the reference toward itself and looks
less off than it is. The median ignores it.

**Why per-market thresholds.** Half a reception is noise; half a passing
touchdown is a different bet. A single universal threshold would either
spam flags on yardage props or never fire on counting props.

**No-vig probabilities.** With both sides' prices you can remove the
bookmaker's margin: `p_over = imp_over / (imp_over + imp_under)`. The board
shows it per book. It is only possible with the priced feed, which is
another reason the ESPN feed alone is not enough for pricing questions.

---

## 7. Play-by-play splits

**Decision.** `dashboard/stats/pbp.py` pulls every play a player rushed, was
targeted or threw on, joins FTN charting (2022+) and NFL participation data
(2016+), and groups by a *dimension* from a registry (`DIMS`): formation, red
zone, down, distance, play action, motion, box count, personnel, coverage,
route, and so on. Three *roles* (rush, rec, pass) because the same play is a
carry for one player and a target for another.

**Why a dimension registry.** Same argument as the stat catalog: a split is
a label plus a polars expression that produces a category. Adding "trailing
by 9+" is one line. The API and the UI are generic.

**Two data-quality lessons, recorded because they cost time.**
1. *Nulls are not "no".* The first draft mapped `is_play_action` with
   `when(col).then("PA").otherwise("No PA")`, which counted every 2016-2021
   play (where the column is null) as "no play action". The fix is a helper
   that keeps nulls null, so seasons without charting are excluded rather
   than mislabelled. **Any time you turn a nullable boolean into two
   categories, decide explicitly what null means.**
2. *Feeds change shape without warning.* The participation table's
   `play_id` became Float64 in 2023, personnel strings started listing the
   whole lineup ("1 C, 2 G, 1 QB, 1 RB..."), formations changed labels, and
   blanks replaced nulls. A regex that extracts the RB and TE counts works
   on both formats; a string equality on "1 RB, 1 TE, 3 WR" silently returned
   zero for 2023+. **Parse the meaning, not the exact string, and check a
   new season's distinct values before trusting it.**

---

## 8. Team tendencies: store sums and counts, compute rates on demand

**Decision.** `dashboard/stats/team.py` builds one row per team-game with
*numerators and denominators* (`off_pass`, `off_plays`, `off_rz_td`,
`off_rz_trips`...), cached to `data/derived/`. A `Metric` registry maps each
tendency to a (numerator, denominator) pair. `rates(df, keys)` groups by any
keys, sums, divides. `with_ranks` ranks within a season.

**Why sums, not per-game rates.** The average of per-game rates is wrong:
a game with 20 plays would count as much as one with 70. Summing numerators
and denominators and dividing once gives the correct weighted rate for *any*
grouping, which is exactly what makes coach profiles ("all games this coach
coached, across teams and seasons") a one-liner instead of a special case.
**Store the ingredients of a ratio, never the ratio, if you will ever
aggregate it again.**

**Why cache to parquet.** Building it is a full pass over 1.1 million plays
(~45 seconds). It changes once a week. A versioned cache file
(`_v3` in the name, bumped whenever the definitions change) means the app
never serves numbers computed by an old definition. **Put the version in the
filename; a stale cache that looks fresh is worse than no cache.**

**Two-sided rows.** Each play is grouped once by the offense; the defense's
line is the same aggregate relabelled from the opponent's point of view.
That guarantees `off_` and `def_` are computed from identical plays and can
never disagree.

**A pace metric that is honest.** "Seconds per play" is the game-clock gap
between consecutive snaps by the same team on the same drive, restricted to
neutral situations (win probability 20-80%, quarters 1-3, early downs).
Without the neutral filter a team trailing by 20 looks fast because it is
hurrying, which is game script, not identity.

---

## 9. Coaches

**Decision.** The schedule already names the head coach on every game since
1999. Joining that onto the team-game table gives a coach's games; `rates()`
over them gives his tendencies; the season's league rank comes from the
team's full-season number. The profile's "fingerprint" is, per metric, the
mean league percentile across seasons plus how many seasons ranked in the
top or bottom third.

**Why percentiles across seasons rather than raw values.** Pass rates drift
league-wide by era; a 58% pass rate was extreme in 2005 and average in 2020.
A percentile within each season compares a coach to his contemporaries,
which is what "tendency" means. Counting top-third seasons answers "is this
consistent or a one-year fluke", which a single average cannot.

**Honest limitation, stated in the UI.** nflverse has head coaches only.
An offensive coordinator's scheme is attributed to the head coach. There is
no free, structured source for coordinators; building one by hand is a
future task, and it should be a file the app reads, not code.

---

## 9b. Defense vs position, usage trees, injuries (second pass)

**Decision.** All three live in one module, `stats/context.py`, and all
three come from the weekly box-score table (`player_stats_week`) plus the
`injuries` table, not from play-by-play.

**Why the box score and not pbp.** "Yards allowed to running backs" is the
sum of every RB's box-score line against that defense. The box score already
has position, team and opponent on every row, so it is one `group_by` with
no joins and works back to 1999. Reaching for play-by-play would have meant
re-deriving positions from player ids for a number the box score gives
directly. **Use the table that already has the grain you need.**

**Rank direction is stated in the UI.** For defense vs position, rank 1 is
"most allowed", because that is the matchup a bettor is looking for. For
team tendencies, rank 1 is "highest value". Both are correct; both would be
confusing if unlabelled, so every table says which it is in its hint line.
**Whenever a rank can be read two ways, print the direction next to it.**

**Usage tree shares are of the team total, not the league.** Target share =
player targets / team targets in that season. That is the number that
transfers when a coach moves ("his RB1 had 18% of targets three years
running"), which is why the coach page shows the same rows per team-season.
Reusing `team_usage()` for both pages meant the coach table cost about ten
lines.

**Injuries are shown, not interpreted.** The panel lists status and practice
participation for the player and for both teams' current report, and says
plainly when the current week's report is not in the cache yet. It does not
guess at "probable to play" from practice patterns; that is a model's job,
and it would sit next to real numbers looking like one.

---

## 9c. Matchup angles: rules, not a model

**Decision.** `stats/matchups.py` turns two ranked tendency tables into a
short list of "angles": a pass-heavy offense (top 8 in pass rate) meeting a
defense that gives up the most pass EPA (top 8 allowed) produces one card,
with both numbers and both ranks printed in it and a lean (over / under /
check). About fifteen such rules exist, each a few lines.

**Why rules and not a score.** You have no labelled outcomes for "this
angle paid off", so a weighted score would be an invented number dressed as
a finding. A rule that says exactly which two facts it saw is honest about
what it is: a prompt to go look. When you do have outcomes (a season of
logged props), the rules become features and the model in `model/` decides
their weight. The UI already reserves the slot.

**Why both directions are shown separately.** A game is two matchups. TB's
offense against CIN's defense and CIN's offense against TB's defense share
nothing except the venue, so each gets its own panel with its own angles,
personnel and defense-vs-position table.

**Coverage stats without coverage assignments.** PFR's defensive table gives
targets, completions and yards allowed per defender when he was the nearest
man; it does not say who was assigned to whom. So the page shows the
receivers by target share on one side and the defenders by snap share with
their coverage numbers on the other, and states in the hint that shadow
assignments are not published. **Show what the data supports and say what
it does not; do not synthesise the missing link.**

---

## 10. API design

- **Read endpoints return complete objects, not fragments.** `/gamelog`
  returns every stat; `/lines` returns every market for the player;
  `/board` returns every book. The client filters. This keeps the endpoint
  count small and the UI free to add controls without backend changes.
- **One write endpoint** (`POST /api/odds/pull`) and it appends. Everything
  else is a pure function of the files on disk.
- **JSON safety in one place.** `records()` converts NaN and infinity to
  null and datetimes to ISO strings. Python's `json` will happily emit `NaN`,
  which is not JSON, and the browser will then fail to parse the whole
  response. Do that conversion at the boundary, once, not per endpoint.
- **Errors say what to do.** The team endpoints return 503 with "run
  `python -m dashboard.stats.team`" if the cache is missing; the Odds API
  provider says "set ODDS_API_KEY in .env". An error that names the fix is
  documentation that arrives exactly when it is needed.

---

## 11. Frontend architecture

- **URL is the source of truth for "what am I looking at"** (`?player=`,
  `?market=`, `?team=`, `?coach=`). That makes every view linkable and the
  back button work. Local component state holds ephemeral controls
  (filters, chosen columns); `localStorage` holds preferences (default N,
  preferred book, sample-data policy).
- **One `MetaProvider`** fetches `/api/meta` once (teams, catalog, markets,
  metrics, dimensions) and exposes lookup maps. Components never fetch the
  catalog themselves.
- **Computation lives in `lib/stats.ts`** as pure functions over rows
  (`applyFilters`, `summarize`, `splits`, `rolling`). Pure functions are
  testable without React and reusable across the chart, tiles, table and
  splits, which is why those four always agree with each other.
- **Charts colour by meaning.** Bars are green above the line, red below,
  amber on a push, via CSS variables, in every chart. Consistency of encoding
  is what makes a dashboard readable at a glance.
- **Colour lives in CSS variables, including for charts.** Recharts takes
  literal colour strings, so the first draft hard-coded hex values in five
  components. When the palette changed (the blue-tinted greys went, a light
  theme came in) that was five files to hunt through. Now `lib/theme.ts`
  reads the CSS variables at render time and every chart uses those, so a
  theme is one CSS block and a toggle sets `data-theme` on the root element.
  **If a value appears in two files, it belongs in one place both can read.**
- **Empty states explain themselves.** No lines? The UI says which pull is
  free. No team table? It names the command. A blank panel teaches nothing.

---

## 12. Things I deliberately did not do

- **No database.** Parquet plus polars covers reads; the only writes are
  append-only snapshot files. A database would add a service to run and
  migrations to maintain for zero benefit at this scale.
- **No scraping of sportsbooks directly.** DraftKings' own JSON returned 403
  on the first probe; scraping is fragile and against terms. ESPN's public
  API and a paid aggregator are stable and legitimate.
- **No news-derived "scheme" narratives.** You asked for coaching style as a
  metric with history behind it; I built that from play-by-play. I did not
  fabricate qualitative summaries from articles, because they could not be
  verified and would sit next to numbers that can be. If you want a notes
  layer, make it a file of your own observations that the UI displays,
  clearly labelled as opinion.
- **No yards per route run.** Routes run are not in any nflverse table. The
  README says so, so nobody wastes time looking for it.

---

## 13. Habits worth keeping from this build

1. **Probe before you build.** Twenty minutes of `curl` against ESPN found a
   free, id-keyed props feed that changed the design.
2. **Write the memory file.** `memory.md` holds the non-obvious facts (the
   403, the dtype drift, the id mappings). It is cheaper to read than to
   rediscover.
3. **Test the invariants, not the pixels.** The tests check that every
   market points at a real stat, that the personnel parser handles both feed
   formats, that the board flags the right book. Those are the things that
   break silently.
4. **Version your caches, prefix your joins, keep nulls null.** Three rules
   that each prevented a wrong number from reaching the screen.
