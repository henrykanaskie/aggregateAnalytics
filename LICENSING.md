# Where the data comes from, and what each source permits

Every external source this project reads, what it gives us, what its terms
actually say, and what that obliges. Checked **2026-09-11** against commit
`5567c05`, by reading each provider's current terms rather than by assuming.

**This is a record, not legal advice.** It exists so the decision is
reconstructable: what was read, what it said, and what was done about it. One
question in here needs a lawyer and is marked as such. The rest do not, because
the terms answer them in plain words.

---

## The trigger: three states, and they have different obligations

Nothing below is a single yes or no. Every obligation attaches to a *state* the
project is in, and it is currently in the first one.

| state | what it means | what is permitted |
|---|---|---|
| **private** | one password, holders are you and people you know, no money, nothing published | everything below, including ESPN |
| **public** | any page, image or number is visible to strangers, or posted anywhere, **even for free** | nflverse and Wikipedia derived work only. No ESPN. No logos, no headshots |
| **paid** | anyone who is not you has an account, or money has changed hands | as **public**, plus The Odds API on a subscription |

The mistake this table exists to prevent: assuming the trigger is money. It is
not. **A free public page carrying ESPN-derived lines, or one screenshot with
team logos in it, is already outside what those terms grant.** Publishing comes
before billing in the plan, so it is the deadline that arrives first.

---

## The sources

| source | what we take | terms | verdict |
|---|---|---|---|
| **nflverse** | 25 tables, 1999 to now: the backbone | [CC BY 4.0](https://github.com/nflverse/nflverse-data) | **commercial OK**, credit required |
| **The Odds API** | lines and prices across books | [terms](https://the-odds-api.com/terms-and-conditions.html) | **commercial OK on any plan**, display only |
| **ESPN** | DraftKings props and game lines, exact athlete ids | [Disney ToU](https://disneytermsofuse.com/english/) | **private use only.** Retire before publishing |
| **Wikipedia** | coordinator names per team-season | CC BY-SA 4.0 | OK, credit required |
| **NFL / ESPN CDNs** | team logos, player headshots | none granted | **remove.** Trademark, not data |

### nflverse: the backbone, and it is clear

`nflreadpy` reads the [nflverse-data](https://github.com/nflverse/nflverse-data)
releases, which are **CC BY 4.0**. Commercial use is permitted and attribution
is required. This covers everything the product is actually built on: the
player-week panel, play-by-play, schedules, depth charts, injuries, Next Gen
Stats, PFR advanced.

**Obliges:** a visible credit. "Data via nflverse (CC BY 4.0)" in the footer.

**The open question, and the only one here for a lawyer.** CC BY 4.0 is the
licence nflverse grants over its own compilation. It does not resolve rights in
the underlying NFL-sourced data, which nflverse does not own either. The
practical comfort is that US law treats raw sport statistics as facts rather
than copyrightable expression, which is why the entire public sports-analytics
ecosystem is built this way. That is a reason this is a normal risk rather than
an unusual one. It is not a reason to believe the question is closed.

### The Odds API: permitted, and better than assumed

Quoted from [their terms](https://the-odds-api.com/terms-and-conditions.html):

- "Displaying our data in a UI, website, or mobile app, **including for
  commercial use**" is a permitted use.
- "Storing our data and retaining it indefinitely" is a permitted use. The
  append-only snapshot store in `data/odds/` is fine.
- "Attribution to The Odds API is not required, but is always appreciated."
- **There is no free-versus-paid distinction in the terms.** Commercial use is
  not gated behind a paid plan. The paid plan is a quota, not a licence.

Prohibited: "Do not resell, repackage, or redistribute our data as a standalone
data product," including "your own API, data feed, downloadable files, or any
other format intended to serve as a source of raw data for others."

**Two things must never be built**, and they are both things a reasonable person
would add without thinking:

1. **A CSV or JSON export of the lines board.** "Downloadable files" is named.
2. **A public API.** "Your own API" is named.

Analysis *derived* from the lines is ours and is not affected. The line itself
leaving the product as data is the thing.

**One judgment call, and it is worth converting into a record.** The permission
is conditioned on their data not being the primary product sold. The Research
page is unambiguously our own analysis. The **Board page is closer to the line**:
every posted prop across books, consensus, per-book deviation, best price. Email
hello@the-odds-api.com, describe the product in three sentences, keep the reply
next to this file. Fifteen minutes turns a judgment call into evidence.

**Quota.** One default pull is ~115 credits (`DEPLOY.md`). Four a day is ~13,800
a month, inside the $30 / 20K plan. Player props across several books will push
past that; expect the $59 / 100K plan eventually. Free tier is 500 credits,
which is enough to validate a parser and not enough to run a week.

### ESPN: private use only, and it is currently load-bearing

`dashboard/odds/espn.py` reads two undocumented endpoints. ESPN is Disney, and
the [Disney Terms of Use](https://disneytermsofuse.com/english/) grant a licence
"for your personal, **noncommercial** use only," prohibit "access, monitor, copy
or extract the Disney Products using a robot, spider, script, or other automated
means... data mining or web scraping," and grant "no right to reproduce,
distribute, communicate to the public."

Three clauses, and each one independently covers what the cron does the moment
this project stops being private.

**Why this is the finding that mattered.** `scripts/pull_lines.sh` puts ESPN on
the schedule and deliberately keeps The Odds API off it, because the free tier
would be spent in a day. So **every scheduled pull, four times a day, is ESPN**,
and the replacement has never run unattended. This does not announce itself: it
works perfectly right up to the moment it is the wrong thing to be doing.

**What retiring it costs**, from the module's own docstring: exact ESPN athlete
ids, free opening lines, and DraftKings props. The ids are the real loss. Player
resolution falls back to name matching, which is where prop tools quietly get
players wrong. **Validate the replacement against a week where ESPN is still
running, so the two can be diffed.** That is the only cheap moment to find out.

### Wikipedia: fine, credit it

`data_handling/fetch_coordinators.py` extracts coordinator names from team-season
articles. Names and dates are facts, and no prose is stored. Wikipedia is
CC BY-SA 4.0, so a credit line is free insurance against the argument that the
extraction is substantial enough to matter.

### Logos and headshots: remove them, they are not a data question

What the cached tables actually contain:

```
headshot        https://static.www.nfl.com/image/private/f_auto,q_auto/league/...
team_logo_espn  https://a.espncdn.com/i/teamlogos/nfl/500/ari.png
```

Team marks and player likenesses, hotlinked from the NFL's and ESPN's own CDNs.
Two separate problems: the product makes unauthorised requests to those CDNs on
behalf of every visitor, and the images are trademarks and likenesses regardless
of who serves them. **Switching to `team_logo_wikipedia` or nflverse's own
`team_wordmark` fixes the hotlinking and not the trademark.** A logo is a logo.

Replace with the abbreviation plus `team_color` / `team_color2`, both already in
the `Team` payload. Drop headshots, or use initials.

Touches: `dashboard/stats/players.py:172`, `dashboard/odds/analysis.py:40`,
`dashboard/stats/extras.py:255`, `dashboard/stats/matchups.py`, and the
components `PlayerHeader`, `PlayerSearch`, `PlayerScatter`, `TeamScatter`,
`ScatterPlot`.

**Player and team names stay.** Naming the subject of a factual analysis is not
infringement, and it is what every comparable product does.

---

## Payments

Stripe's [restricted businesses list](https://stripe.com/legal/restricted-businesses)
prohibits "sports forecasting or odds-making **with a monetary or material
prize**." This product has no prize, no entry fee, no wagering, and takes no
action. Analytics subscriptions are not on the list.

Two rules follow from the exact wording, and they are cheap to keep:

- **No contest, pool or leaderboard with a prize**, ever. That single feature is
  what would move this business onto the prohibited list.
- **No revenue share on anyone's betting.**

Describe the business at signup as a sports data analytics subscription. Not
picks, not tips.

---

## Remediation

Ordered by the state that triggers each one, not by effort.

| # | work | triggered by | est. |
|---|---|---|---|
| 1 | Strip logos and headshots | **public**, including a screenshot | 2-3 h |
| 2 | Credit lines: nflverse CC BY 4.0, Wikipedia CC BY-SA 4.0 | **public** | 1 h |
| 3 | The Odds API on the schedule, ESPN deleted | **public** for odds, **paid** for all of it | 4-6 h |
| 4 | Email The Odds API, keep the reply | **paid** | 15 min |
| 5 | Admin-gate `POST /api/odds/pull` | **paid**, it spends money | 2-3 h |

Item 5 is not a licensing matter and is here because it shares the same
deadline: any session holder can currently spend the Odds API credits.

Item 3 splits. The *migration work* is free and can be validated now against the
500-credit tier while ESPN still runs alongside it. The *subscription* is only
needed the week odds go public or paid. Do the work early and buy the plan late.

---

## What was checked, so a re-check knows what changed

| source | document read | date |
|---|---|---|
| nflverse | repository licence: CC BY 4.0 | 2026-09-11 |
| The Odds API | `the-odds-api.com/terms-and-conditions.html` | 2026-09-11 |
| The Odds API | pricing: $0 / 500, $30 / 20K, $59 / 100K | 2026-09-11 |
| ESPN | `disneytermsofuse.com/english/` | 2026-09-11 |
| Stripe | `stripe.com/legal/restricted-businesses` | 2026-09-11 |

Terms change without notice and without a changelog. Re-read all five before
launch, and again each September.
