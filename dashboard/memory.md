# Working memory (Claude's scratch state for the overnight build)

Read this first in any new session. Terse by design. Update, don't append forever.

## Status
- [x] Backend stats layer: dashboard/stats/{catalog,gamelog,players}.py  (tested, ~0.1s per game log)
- [x] Odds layer: markets, store (append-only parquet under data/odds/), providers espn + theoddsapi + sample, analysis (board), pull CLI
- [x] FastAPI app dashboard/api/app.py on port 8017 (running via uvicorn in background during build)
- [x] Real ESPN/DraftKings week-1 2026 props pulled (785 props, all id-matched) + sample week-2 multi-book
- [ ] Frontend (dashboard/web, Vite+React+TS+Recharts): scaffold+styles+api+state+lib written; components/pages pending
- [ ] pbp-based player splits (shotgun/under center, red zone, play action, down, etc.)
- [ ] team tendencies (pass rate, PROE, pace, red zone, RB usage, personnel) per team-season and team-game, cached to data/derived
- [ ] coach profiles from schedules home_coach/away_coach x team tendencies, with league ranks
- [ ] README, DESIGN_NOTES.md (teaching doc), .claude/launch.json, pyproject extra
- [ ] browser test end to end, polish

## Facts learned (do not re-derive)
- ESPN site/core APIs return 403 for custom User-Agent; requests default UA works. No key needed.
- ESPN propBets provider 100 = DraftKings. Lines only (no prices), current + open. TD-scorer rows have no number. Items are duplicated per side.
- ESPN athlete id == players.parquet espn_id (String). WSH->WAS, LAR->LA.
- The Odds API: event props cost = markets x regions per event; free tier 500/mo. Key not present yet (.env ODDS_API_KEY).
- player_stats_week team abbrs match schedules (home detection 0 nulls). NGS week 0 = season totals (filter week>0).
- NGS percent_share_of_intended_air_yards is 0-100; pfr *_pct are fractions; passing_cpoe is percentage points.
- Rams are "LA" in nflverse. players.latest_team reflects offseason moves; stat table last team does not.
- yards per route run is NOT available (no routes-run data in nflverse). Say so in the UI/README.
- pbp per-player filter with predicate pushdown is fast (<0.1s for one player across 27 seasons).

- participation table: play_id Int32 through 2022, Float64 2023+; personnel strings list the whole lineup 2023+ ("1 C, 2 G, 1 QB, 1 RB..."); formation labels 2023+ are SHOTGUN / UNDER CENTER / PISTOL; blanks "" instead of nulls. Parsers in pbp.py/team.py handle both.
- Coaches: head coaches only (schedules). McDaniel is not a 2026 HC in the data (LAC HC = Jim Harbaugh), so he has no current team.
- Team table build: ~45s for 1999-2025. Bump VERSION in team.py when metric definitions change.

## Conventions
- Canonical market keys = The Odds API names. Stat keys = catalog keys (dashboard/stats/catalog.py).
- Joined columns prefixed: snap_, ngs_rec_/ngs_rush_/ngs_pass_, pfr_, xp_, long_.
- source="sample" rows are dropped whenever real rows exist for that week (store._latest).
- Never commit; user did not ask. data/ is gitignored (odds snapshots live there).
