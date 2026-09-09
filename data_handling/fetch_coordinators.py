"""Offensive and defensive coordinators, per team-season.

nflverse carries the head coach on every game (``schedules.home_coach``) and
nothing else. There is no coordinator column anywhere in the cache, and no
nflreadpy loader for one, so the coaches page can only ever say "Kansas City
throws a lot" and not "Andy Reid's offense throws a lot when Eric Bieniemy is
calling it". This module fills that gap from Wikipedia's team-season articles,
whose ``Staff`` section is a structured coaching-staff template:

    | offensive =
    * Offensive coordinator - [[Alex Van Pelt]]
    * Quarterbacks - [[T. C. McCartney]]

Coverage is good back to 1999, which is exactly the window the rest of the
project models.

Two things about the shape of the answer:

*   **It is a season, not a game.** The template is the *final* staff of that
    season, so a coordinator fired in November is invisible here, unlike a head
    coach, whose replacement shows up on the very next game row. Coordinator
    tenures are therefore attributed to whole team-seasons, and a mid-season
    change is silently credited to whoever finished the year.
*   **A missing coordinator is data.** Belichick's 2010 Patriots genuinely had
    neither an OC nor a DC; he called the defense himself. That is a real fact
    about the offense, not a scrape failure, so a team-season whose staff
    section *was* parsed emits a row with a null name rather than no row. No
    row at all means the page could not be read -- the two must not be
    confused when averaging.

Run it after ingest, or whenever a season's staff changes:

    python -m data_handling.fetch_coordinators              # every season
    python -m data_handling.fetch_coordinators 2025 2026    # just these
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

import polars as pl
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nfl.data import RAW_DIR  # noqa: E402
from nfl.teams import FRANCHISES  # noqa: E402

API = "https://en.wikipedia.org/w/api.php"
# Wikimedia asks that automated clients identify themselves; an anonymous
# scraper gets 429s far sooner. See the rate-limit page linked in their 429 body.
USER_AGENT = "aggregate-analytics/0.1 (team-season coaching staff; polite batch reader)"
BATCH = 20          # titles per query; the API caps anonymous callers at 50
PAUSE = 1.5         # seconds between batches
TIMEOUT = 45
FIRST_SEASON = 1999
CACHE = RAW_DIR / "coordinators.parquet"

#: Franchises whose Wikipedia article name changed inside the window. Each
#: entry is (last season under that name, name), oldest first; a season past
#: the final cutoff uses the current name in :data:`nfl.teams.FRANCHISES`.
ERA_NAMES: dict[str, list[tuple[int, str]]] = {
    "LA": [(2015, "St. Louis Rams")],
    "LAC": [(2016, "San Diego Chargers")],
    "LV": [(2019, "Oakland Raiders")],
    "WAS": [(2019, "Washington Redskins"), (2021, "Washington Football Team")],
}

#: A staff line is "<title> - <name>". Wikipedia uses an en dash almost
#: everywhere and an em dash or a spaced hyphen in the older articles.
DASH = re.compile(r"\s+[–—]\s+|\s+-\s+")

#: One "/"-separated segment of a job title that means this person *is* the
#: coordinator. Splitting first is what makes the distinction workable:
#: "Assistant head coach/Defensive coordinator" (Bob Slowik, 2004 Packers) and
#: "Interim offensive coordinator/quarterbacks" (Greg Olson, 2025 Raiders) both
#: count, while "Assistant defensive coordinator", "Run game coordinator" and
#: "Defensive quality control coordinator" do not -- they are different jobs,
#: and folding them in would credit an offense's identity to its RB coach.
ROLE_SEGMENT = {
    "OC": re.compile(r"^(?:co-|interim\s+|acting\s+)?offensive coordinator\b", re.I),
    "DC": re.compile(r"^(?:co-|interim\s+|acting\s+)?defensive coordinator\b", re.I),
}

#: Section markers that mean we found a real staff listing, so an absent
#: coordinator is a vacancy rather than a page we failed to read.
STAFF_MARKERS = re.compile(r"NFL (?:final )?staff|==\s*Staff|===\s*Staff|Coaching staff", re.I)

#: A season still being played does not inline its staff -- it transcludes the
#: league's living one, ``{{Detroit Lions staff}}``, and only gets rewritten as
#: a "final staff" once the year is over. Without following that, the current
#: season comes back with every team's coordinators blank, which reads as 32
#: vacancies rather than "not written down yet". The template is undated and
#: means *now*, so it may only ever stand in for a season the page itself
#: pointed at it from.
STAFF_TRANSCLUSION = re.compile(r"\{\{([A-Z][^{}|=]{3,40}? staff)\}\}")


def team_name(team: str, season: int) -> str:
    for last, name in ERA_NAMES.get(team, []):
        if season <= last:
            return name
    return FRANCHISES[team].name


def page_title(team: str, season: int) -> str:
    return f"{season} {team_name(team, season)} season"


def delink(raw: str) -> str:
    """Drop wiki markup, keeping the display text: ``[[Scott Turner (American
    football coach)|Scott Turner]]`` -> ``Scott Turner``.

    Job titles need this as much as names do. Several teams link the role
    itself -- Washington's staff template writes ``[[Offensive coordinator]] -
    [[David Blough]]`` -- and a matcher anchored on the raw text sees ``[[``
    where it expects a job title.
    """
    s = re.sub(r"<ref[^>]*/>|<ref.*?</ref>", "", raw, flags=re.S | re.I)
    s = re.sub(r"\[\[[^|\]]+\|([^\]]+)\]\]", r"\1", s)
    s = re.sub(r"\[\[([^\]]+)\]\]", r"\1", s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = s.replace("'''", "").replace("''", "")
    return s


def clean_name(raw: str) -> str:
    """The display name alone: markup off, then the asides Wikipedia hangs on a
    person -- "(interim)", "(de facto)"."""
    s = re.sub(r"\([^)]*\)", "", delink(raw))
    s = re.sub(r"\s+", " ", s)
    return s.strip(" *·,;.–—-")


def parse_staff(wikitext: str) -> tuple[dict[str, list[tuple[str, str]]], bool]:
    """Return ``({"OC": [(name, title), ...], "DC": [...]}, staff_found)``.

    Co-coordinators are kept in listed order; the first is treated as the
    primary one downstream. The raw job title comes along so that "interim"
    stays visible rather than being flattened away.
    """
    found = bool(STAFF_MARKERS.search(wikitext))
    out: dict[str, list[tuple[str, str]]] = {"OC": [], "DC": []}
    for line in wikitext.splitlines():
        line = line.strip()
        if not line.startswith("*"):
            continue
        parts = DASH.split(line.lstrip("* ").strip(), 1)
        if len(parts) != 2:
            continue
        title, raw = parts
        title = re.sub(r"\s+", " ", delink(title)).strip()
        for role, pat in ROLE_SEGMENT.items():
            if any(pat.match(seg.strip()) for seg in title.split("/")):
                name = clean_name(raw)
                if name and name not in [n for n, _ in out[role]]:
                    out[role].append((name, title))
    return out, found


def _fetch(session: requests.Session, titles: list[str], retries: int = 5) -> dict[str, str]:
    """Wikitext for up to :data:`BATCH` titles, keyed by the title we asked
    for (not the redirect target, so the caller can match rows back)."""
    params = {"action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main",
              "titles": "|".join(titles), "format": "json", "formatversion": 2, "redirects": 1}
    delay = PAUSE
    for attempt in range(retries):
        r = session.get(API, params=params, timeout=TIMEOUT)
        if r.status_code == 429:
            time.sleep(float(r.headers.get("Retry-After", delay * 4)))
            delay *= 2
            continue
        r.raise_for_status()
        j = r.json()
        q = j.get("query", {})
        # `redirects` and `normalized` rewrite the titles we asked for, so walk
        # them back to recover the original key.
        back: dict[str, str] = {}
        for kind in ("normalized", "redirects"):
            for m in q.get(kind, []):
                back[m["to"]] = back.get(m["from"], m["from"])
        out: dict[str, str] = {}
        for p in q.get("pages", []):
            if p.get("missing") or not p.get("revisions"):
                continue
            asked = back.get(p["title"], p["title"])
            out[asked] = p["revisions"][0]["slots"]["main"]["content"]
        return out
    raise RuntimeError(f"gave up after {retries} attempts on {titles[0]!r} +{len(titles) - 1}")


def build(seasons: list[int], log=print) -> pl.DataFrame:
    wanted: list[tuple[int, str]] = [
        (s, t) for s in seasons for t in sorted(FRANCHISES)
        if s >= FRANCHISES[t].first_season
    ]
    titles = {page_title(t, s): (s, t) for s, t in wanted}
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    rows: list[dict] = []
    missing: list[str] = []
    deferred: list[tuple[int, str, str, str]] = []   # (season, team, page, template)
    keys = list(titles)
    for i in range(0, len(keys), BATCH):
        chunk = keys[i:i + BATCH]
        texts = _fetch(session, chunk)
        for title in chunk:
            season, team = titles[title]
            text = texts.get(title)
            if text is None:
                missing.append(title)
                continue
            staff, found = parse_staff(text)
            if not found:
                missing.append(title)
                continue
            if not staff["OC"] and not staff["DC"]:
                m = STAFF_TRANSCLUSION.search(text)
                if m:
                    deferred.append((season, team, title, f"Template:{m.group(1)}"))
                    continue
            for role in ("OC", "DC"):
                # An empty list is a *verified* vacancy (Belichick 2010), and is
                # written as a null-named row so it can be told apart from a page
                # we never managed to read.
                listed = staff[role] or [(None, None)]
                for n, (name, job) in enumerate(listed):
                    rows.append({"season": season, "team": team, "role": role, "coach": name,
                                 "title": job, "slot": n, "page": title})
        log(f"  {min(i + BATCH, len(keys))}/{len(keys)} pages")
        time.sleep(PAUSE)

    # Second pass: the living staff templates the in-progress season points at.
    if deferred:
        log(f"  following {len(deferred)} live staff template(s)")
        tmpl_names = sorted({t for *_, t in deferred})
        fetched: dict[str, str] = {}
        for i in range(0, len(tmpl_names), BATCH):
            fetched.update(_fetch(session, tmpl_names[i:i + BATCH]))
            time.sleep(PAUSE)
        for season, team, page, tmpl in deferred:
            text = fetched.get(tmpl)
            if text is None:
                missing.append(page)
                continue
            staff, _ = parse_staff(text)
            for role in ("OC", "DC"):
                listed = staff[role] or [(None, None)]
                for n, (name, job) in enumerate(listed):
                    rows.append({"season": season, "team": team, "role": role, "coach": name,
                                 "title": job, "slot": n, "page": tmpl})

    if missing:
        log(f"  no staff section on {len(missing)} page(s): {', '.join(missing[:8])}"
            + (" ..." if len(missing) > 8 else ""))
    return pl.DataFrame(rows, schema={"season": pl.Int32, "team": pl.Utf8, "role": pl.Utf8,
                                      "coach": pl.Utf8, "title": pl.Utf8, "slot": pl.Int32,
                                      "page": pl.Utf8})


def report_changes(df: pl.DataFrame, log=print) -> list[str]:
    """Name the coordinators who changed into the newest season.

    Worth a look every time, because the newest season is the one read off the
    living ``Template:X staff`` rather than a finished article. That template
    is undated -- it means *now*, whenever now is -- so it is the row most
    likely to be either ahead of the season pages or quietly behind them.
    Turnover is normal and most of these lines will be real hires; the point is
    that the handful worth eyeballing are named rather than buried.
    """
    seasons = sorted(df["season"].unique().to_list())
    if len(seasons) < 2:
        return []
    latest, prior = seasons[-1], seasons[-2]
    def held(season: int) -> dict[tuple[str, str], str]:
        rows = df.filter((pl.col("season") == season) & (pl.col("slot") == 0)).to_dicts()
        return {(r["team"], r["role"]): r["coach"] for r in rows}
    now, before = held(latest), held(prior)
    lines = [f"{team} {role}: {before.get((team, role)) or '(none)'} -> {who or '(none)'}"
             for (team, role), who in sorted(now.items()) if before.get((team, role)) != who]
    if lines:
        log(f"  {len(lines)} coordinator change(s) into {latest}, from the live staff templates:")
        for line in lines:
            log(f"    {line}")
    return lines


def save(df: pl.DataFrame, log=print) -> Path:
    """Merge into the cache, replacing only the seasons just fetched, so a
    single-season refresh cannot drop the archive."""
    if CACHE.exists():
        old = pl.read_parquet(CACHE)
        fetched = set(df["season"].unique().to_list())
        df = pl.concat([old.filter(~pl.col("season").is_in(fetched)), df]).sort(["season", "team", "role", "slot"])
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(CACHE)
    log(f"wrote {CACHE} ({df.height} rows, {df['season'].min()}-{df['season'].max()})")
    report_changes(df, log)
    return CACHE


def cached_seasons() -> set[int]:
    """Seasons already in the archive on disk. Empty if there is none."""
    if not CACHE.exists():
        return set()
    try:
        return set(pl.read_parquet(CACHE, columns=["season"])["season"].unique().to_list())
    except Exception:  # noqa: BLE001 - an unreadable archive is a missing one
        return set()


def seasons_to_fetch(asked: list[int], end: int, have: set[int]) -> list[int]:
    """Which seasons a run should actually cover: the ones asked for, plus any
    the archive is missing.

    A named season is a *refresh*: :func:`save` merges it in and leaves the
    rest alone, which is only meaningful if the rest is there. The weekly job
    asks for the current season on a CI runner whose cache came from the
    release, so on the first run there is nothing to merge into and the result
    would be a single season published as the whole history: no fingerprints,
    since those need two seasons, and every coordinator a first-year hire.

    Keying on "is a file there" is not enough, and this is the part that bit.
    Once such a run has uploaded its one season, a file *does* exist, so a
    naive check refreshes 2026 into a 2026-only archive and the damage is
    permanent. Comparing against the seasons actually present heals it on the
    next run instead.
    """
    full = range(FIRST_SEASON, end + 1)
    if not asked:
        return list(full)
    return sorted(set(asked) | {s for s in full if s not in have})


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("seasons", nargs="*", type=int, help="seasons to fetch (default: all since 1999)")
    ap.add_argument("--end", type=int, default=None, help="last season when none are listed")
    a = ap.parse_args()
    from dashboard.config import CURRENT_SEASON
    end = a.end or CURRENT_SEASON
    have = cached_seasons()
    seasons = seasons_to_fetch(a.seasons, end, have)
    if a.seasons and seasons != sorted(set(a.seasons)):
        gap = sorted(set(seasons) - set(a.seasons))
        print(f"archive at {CACHE} is missing {len(gap)} season(s) ({gap[0]}-{gap[-1]}): "
              f"backfilling those alongside {sorted(set(a.seasons))}")
    print(f"fetching coordinators for {len(seasons)} season(s)")
    save(build(seasons))


if __name__ == "__main__":
    main()
