"""Did the angles call it? Every matchup angle, graded against the game.

The matchup page raises angles such as "Heavy boxes vs the run" or "Jahmyr
Gibbs vs stacked boxes". Each one is a claim about the game: the offense
should run worse than it usually does, the back should average fewer yards a
carry than he usually does. Once the game is played the claim is checkable,
and a claim nobody checks is an opinion. This module checks them.

For each finished game it rebuilds the angles **as they stood before
kickoff**: team numbers blended through the week before
(:func:`blend.blended` with ``before_week``) and player splits cut off at the
game (``before=`` on :func:`pbp.splits`). Then each angle is scored on the
number it is about:

    team angle    the team's rate in that game (from the team-game table)
                  against its own pre-game number, or the league's where the
                  angle is about being unusual for the league (pace).
    player angle  the player's game against his average over his previous
                  games (yards per carry for box angles, EPA per dropback for
                  quarterbacks, yards otherwise), and against the closing
                  prop line when one was graded that week.

A hit is the number moving the way the angle said. That is a low bar on
purpose: an angle is a research prompt, not a pick, and the useful question
is whether a family of them points the right way more often than a coin.
The track record (:func:`track_record`) answers it per family.

What is not rebuilt as of kickoff: which eight players count as "key" (read
from season usage, as the page does) and the rosters. Both only decide who
gets an angle, not what it says.

Results go to ``data/odds/graded/angles_<season>_<week>.parquet`` next to the
line grades, and the Tuesday job writes them with the rest::

    python -m dashboard.stats.angle_grades                  # this season's finished weeks
    python -m dashboard.stats.angle_grades --season 2025 --all
"""

from __future__ import annotations

import argparse
import re
import sys
from functools import lru_cache

import polars as pl

from nfl.data import scan

from ..config import CURRENT_SEASON, ODDS_DIR
from . import matchups as mu
from .blend import blended, dvp_blended, matchup_view
from .coaches import season_used
from .team import METRIC_BY_KEY, rates, team_games

GRADED_DIR = ODDS_DIR / "graded"
POSITIONS = ("QB", "RB", "WR", "TE")

SCHEMA: dict[str, pl.DataType] = {
    "season": pl.Int32, "week": pl.Int32, "game_id": pl.String, "offense": pl.String, "defense": pl.String,
    "kind": pl.String, "family": pl.String, "title": pl.String, "detail": pl.String, "lean": pl.String,
    "strength": pl.Int32, "tags": pl.List(pl.String), "player_id": pl.String, "player": pl.String,
    "position": pl.String, "team": pl.String, "measure": pl.String, "direction": pl.String,
    "baseline": pl.Float64, "baseline_label": pl.String, "actual": pl.Float64, "fmt": pl.String,
    "verdict": pl.String, "line": pl.Float64, "line_result": pl.String, "market": pl.String,
}


# --- what each team angle is about ------------------------------------------
#
# (title pattern, whose number: "off" or "def", metric, direction, compared to)
# The title is the stable part of an angle; the teams in it change. A new
# angle in matchups.py without a row here is shown but never graded, and
# tests/test_angle_grades.py says so.

TEAM_CHECKS: list[tuple[str, str, str, str, str]] = [
    (r"^Pass-heavy offense vs a pass defense that leaks", "off", "pass_epa", "up", "team"),
    (r"^Run-heavy offense vs a run defense that leaks", "off", "rush_epa", "up", "team"),
    (r"^Pass-heavy offense into a stingy pass defense", "off", "pass_epa", "down", "team"),
    (r"^Run-first offense into a stout run defense", "off", "rush_epa", "down", "team"),
    (r"^Running backs in the passing game", "off", "rb_target_share", "up", "team"),
    (r"^Tight end targets line up", "off", "te_target_share", "up", "team"),
    (r"^TE-heavy offense vs a defense that takes tight ends away", "off", "te_target_share", "down", "team"),
    (r"^Slow offense", "off", "plays_pg", "down", "league"),
    (r"^Fast offense", "off", "plays_pg", "up", "league"),
    (r"^Heavy boxes vs the run", "off", "rush_epa", "down", "team"),
    (r"^Light boxes", "off", "rush_epa", "up", "team"),
    (r"^Red zone favours touchdowns", "off", "rz_td_rate", "up", "team"),
    (r"^Red zone favours field goals", "off", "rz_td_rate", "down", "team"),
    (r"^Big favourite", "off", "pass_rate", "down", "team"),
    (r"^Big underdog", "off", "pass_rate", "up", "team"),
    (r"^Sacks: a line that gives them up", "off", "sack_rate_taken", "up", "team"),
    (r"^Clean pockets", "off", "sack_rate_taken", "down", "team"),
    (r"^Interception risk", "off", "int_rate", "up", "team"),
    (r"^Interceptions unlikely", "off", "int_rate", "down", "team"),
    (r"^Drives should sustain", "off", "third_down_conv", "up", "team"),
    (r"^Three-and-outs likely", "off", "third_down_conv", "down", "team"),
    (r"^Kicker volume", "off", "fga_pg", "up", "team"),
    (r"^Running back in the red zone passing game", "off", "rb_target_share", "up", "team"),
    (r"^Shots downfield vs a defense that gives up explosives", "off", "explosive_rate", "up", "team"),
    (r"^Screens vs a blitzing defense", "off", "rb_target_share", "up", "team"),
    (r"^Mobile QB vs a run defense that leaks", "off", "qb_rush_rate", "up", "team"),
]

#: Angles that only say where to look ("check the QB's pressured split").
#: Listed so the test can tell a context note from a forgotten check.
CONTEXT_ONLY = (r"^Man-coverage defense", r"^Pressure defense", r"^Play-action offense",
                r"^Deep offense vs a defense that takes", r"^Two-high defense", r"^Single-high man defense")

_DVP = re.compile(r" has been generous to (QB|RB|WR|TE)s$| has clamped (QB|RB|WR|TE)s$")
_DVP_STAT = {"QB": "passing_yards", "RB": "rushing_yards", "WR": "receiving_yards", "TE": "receiving_yards"}
_STAT_LABEL = {"passing_yards": "passing yards", "rushing_yards": "rushing yards", "receiving_yards": "receiving yards"}
_MARKET = {"passing_yards": "player_pass_yds", "rushing_yards": "player_rush_yds", "receiving_yards": "player_reception_yds"}


def _h2h_check(title: str, off_t: str, def_t: str) -> tuple[str, str, str] | None:
    """The head-to-head angles say a number will move off its usual; which
    number, and which way, is in their template."""
    for key, (up, down) in mu._H2H_TEXT.items():
        side = "def" if key.startswith("def_") else "off"
        for (tmpl, _, _), d in ((up, "up"), (down, "down")):
            if tmpl.format(d=def_t, o=off_t) == title:
                return side, key, d
    return None


def team_check(title: str, off_t: str, def_t: str) -> dict | None:
    for pat, side, key, d, vs in TEAM_CHECKS:
        if re.search(pat, title):
            return {"kind": "metric", "side": side, "metric": key, "dir": d, "vs": vs}
    h = _h2h_check(title, off_t, def_t)
    if h:
        return {"kind": "metric", "side": h[0], "metric": h[1], "dir": h[2], "vs": "team"}
    m = _DVP.search(title)
    if m:
        pos = m.group(1) or m.group(2)
        return {"kind": "pos", "pos": pos, "stat": _DVP_STAT[pos], "dir": "up" if m.group(1) else "down"}
    if title in ("Wind", "Cold"):
        return {"kind": "total", "dir": "down"}
    if title == "Tight end in the red zone":
        return {"kind": "pos_td", "pos": "TE", "dir": "up"}
    return None


def family(title: str, off_t: str, def_t: str, player: str | None = None) -> str:
    """The angle with its names taken out, so the same kind of call groups
    across games: "{player} vs stacked boxes", "{def} has clamped RBs"."""
    t = title
    if player:
        t = t.replace(player, "{player}")
    t = re.sub(rf"\b{re.escape(def_t)}\b", "{def}", t)
    return re.sub(rf"\b{re.escape(off_t)}\b", "{off}", t)


# --- the game as it happened -------------------------------------------------

@lru_cache(maxsize=8)
def _week_box(season: int, week: int) -> pl.DataFrame:
    return (scan("player_stats_week").filter((pl.col("season") == season) & (pl.col("week") == week))
            .select("player_id", "game_id", "team", "position", "attempts", "sacks_suffered", "passing_epa",
                    "passing_yards", "carries", "rushing_yards", "receiving_yards", "receiving_tds", "rushing_tds")
            .collect())


def _team_actual(game_id: str, team: str) -> dict:
    g = team_games().filter((pl.col("game_id") == game_id) & (pl.col("team") == team))
    return rates(g, ["team"]).to_dicts()[0] if not g.is_empty() else {}


@lru_cache(maxsize=4096)
def _player_history(player_id: str, season: int, week: int) -> pl.DataFrame:
    """The player's last sixteen games before this one, last season and this."""
    return (scan("player_stats_week")
            .filter((pl.col("player_id") == player_id) & (pl.col("season") >= season - 1)
                    & ((pl.col("season") < season) | (pl.col("week") < week)))
            .sort(["season", "week"]).tail(16)
            .select("attempts", "sacks_suffered", "passing_epa", "passing_yards", "carries", "rushing_yards", "receiving_yards")
            .collect())


def _player_measure(title: str, pos: str) -> tuple[str, str, str]:
    """(measure key, label, fmt) the player angle is about."""
    if "history" in title:
        k = _DVP_STAT[pos]
        return k, _STAT_LABEL[k], "dec1"
    if pos == "QB":
        return "epa_db", "EPA / dropback", "dec2"
    if pos == "RB":
        return "ypc", "yards / carry", "dec1"
    return "receiving_yards", "receiving yards", "dec1"


def _measure(df: pl.DataFrame, key: str) -> float | None:
    """Ratio of sums for rates, mean per game for counts."""
    if df.is_empty():
        return None
    if key == "epa_db":
        db = float((df["attempts"].fill_null(0) + df["sacks_suffered"].fill_null(0)).sum())
        return float(df["passing_epa"].fill_null(0).sum()) / db if db >= 10 else None
    if key == "ypc":
        c = float(df["carries"].fill_null(0).sum())
        return float(df["rushing_yards"].fill_null(0).sum()) / c if c >= 5 else None
    return float(df[key].fill_null(0).mean())


#: A move smaller than this is a push, not a call: a sack rate of 7.1%
#: against a usual 7.0% says nothing about the angle. The margin is 5% of the
#: usual number, with a floor per format so numbers that sit near zero (EPA)
#: still need a real move.
MARGIN_REL = 0.05
MARGIN_FLOOR = {"pct": 0.005, "dec2": 0.02, "dec1": 0.5}
#: Baselines that are thresholds rather than a usual level: under the closing
#: total by half a point is under, and one touchdown is at least one.
EXACT = ("closing total", "at least one")


def margin(base: float, fmt: str | None, baseline_label: str | None) -> float:
    if baseline_label in EXACT:
        return 0.0
    return max(MARGIN_REL * abs(base), MARGIN_FLOOR.get(fmt or "", 0.0))


def _verdict(actual: float | None, base: float | None, d: str, fmt: str | None = None,
             baseline_label: str | None = None) -> str | None:
    if actual is None or base is None:
        return None
    m = margin(base, fmt, baseline_label)
    if abs(actual - base) < max(m, 1e-9):
        return "push"
    return "hit" if (actual > base) == (d == "up") else "miss"


def _with_margin(df: pl.DataFrame) -> pl.DataFrame:
    """Re-derive every verdict from the stored numbers, so the margin applies
    to weeks graded before it existed and changing it needs no regrade."""
    if df.is_empty():
        return df
    return df.with_columns(pl.struct("actual", "baseline", "direction", "fmt", "baseline_label").map_elements(
        lambda r: _verdict(r["actual"], r["baseline"], r["direction"], r["fmt"], r["baseline_label"]),
        return_dtype=pl.String).alias("verdict"))


def _lines(season: int, week: int) -> pl.DataFrame:
    f = GRADED_DIR / f"lines_{season}_{week:02d}.parquet"
    if not f.exists():
        return pl.DataFrame()
    df = pl.read_parquet(f).filter(pl.col("kind") == "ou")
    return df.group_by(["player_id", "market"]).agg(pl.col("line").median(), pl.col("actual").first())


# --- grading -----------------------------------------------------------------

def pregame_angles(game_id: str) -> tuple[dict, list[dict]]:
    """Both sides' team and player angles as they stood before kickoff."""
    season = int(game_id.split("_")[0])
    game = scan("schedules").filter(pl.col("game_id") == game_id).collect().to_dicts()[0]
    week, home, away = game["week"], game["home_team"], game["away_team"]
    table = blended(season, before_week=week)
    rows = {r["team"]: r for r in table.to_dicts()}
    dvp = {pos: dvp_blended(season, pos, before_week=week) for pos in POSITIONS}
    venue_info = mu.venue(game)
    use = season_used(home, season)
    since = max(season - 3, 2016)
    out = []
    for off_t, def_t in ((away, home), (home, away)):
        off_row, def_row, _ = matchup_view(rows.get(off_t), rows.get(def_t), table)
        sl = game.get("spread_line")
        off_spread = None if sl is None else (-sl if off_t == home else sl)
        dvp_rows = {}
        for pos, t in dvp.items():
            r = t.filter(pl.col("defense") == def_t)
            dvp_rows[pos] = r.to_dicts()[0] if not r.is_empty() else None
        for a in mu.side_team_angles(off_row, def_row, off_t, def_t, dvp_rows, off_spread, venue_info):
            out.append(a | {"kind": "team", "offense": off_t, "defense": def_t})
        pers = mu.offense_personnel(off_t, use, roster_season=season)
        key_players = [p for p in pers if p["position"] in POSITIONS][:8]
        for a in mu.player_angles(key_players, def_row, def_t, since=since, before=(season, week)):
            out.append(a | {"kind": "player", "offense": off_t, "defense": def_t})
    return game, out


def grade_game(game_id: str) -> list[dict]:
    game, angles_ = pregame_angles(game_id)
    if game.get("home_score") is None:
        return []
    season, week = int(game["season"]), int(game["week"])
    table = blended(season, before_week=week)
    usual = {r["team"]: r for r in table.to_dicts()}
    box = _week_box(season, week).filter(pl.col("game_id") == game_id)
    lines = _lines(season, week)
    actual_rows = {t: _team_actual(game_id, t) for t in (game["home_team"], game["away_team"])}
    out = []
    for a in angles_:
        off_t, def_t = a["offense"], a["defense"]
        row = {k: None for k in SCHEMA} | {
            "season": season, "week": week, "game_id": game_id, "offense": off_t, "defense": def_t,
            "kind": a["kind"], "title": a["title"], "detail": a["detail"], "lean": a["lean"],
            "strength": a["strength"], "tags": list(a.get("tags") or []), "player_id": a.get("player_id"),
            "player": a.get("player"), "position": a.get("position"),
            "family": family(a["title"], off_t, def_t, a.get("player")),
        }
        if a["kind"] == "team":
            c = team_check(a["title"], off_t, def_t)
            if not c:
                continue
            row["direction"] = c["dir"]
            if c["kind"] == "metric":
                team = off_t if c["side"] == "off" else def_t
                m = METRIC_BY_KEY[c["metric"]]
                base = (float(table[c["metric"]].drop_nulls().mean()) if c["vs"] == "league"
                        else (usual.get(team) or {}).get(c["metric"]))
                row |= {"team": team, "measure": m.label, "fmt": m.fmt, "actual": actual_rows[team].get(c["metric"]),
                        "baseline": base, "baseline_label": "league average" if c["vs"] == "league" else f"{team}'s usual"}
            elif c["kind"] == "pos":
                league = dvp_blended(season, c["pos"], before_week=week)[c["stat"]].drop_nulls().mean()
                grp = box.filter((pl.col("team") == off_t) & (pl.col("position") == c["pos"]))
                row |= {"team": off_t, "measure": f"{c['pos']} {_STAT_LABEL[c['stat']]}", "fmt": "dec1",
                        "actual": float(grp[c["stat"]].fill_null(0).sum()) if not grp.is_empty() else None,
                        "baseline": float(league), "baseline_label": f"league average to {c['pos']}s"}
            elif c["kind"] == "total":
                if game.get("total_line") is None:
                    continue
                row |= {"measure": "Total points", "fmt": "dec1", "actual": float(game["home_score"] + game["away_score"]),
                        "baseline": float(game["total_line"]), "baseline_label": "closing total"}
            elif c["kind"] == "pos_td":
                grp = box.filter((pl.col("team") == off_t) & (pl.col("position") == c["pos"]))
                tds = float((grp["receiving_tds"].fill_null(0) + grp["rushing_tds"].fill_null(0)).sum())
                row |= {"team": off_t, "measure": f"{c['pos']} touchdowns", "fmt": "int", "actual": tds,
                        "baseline": 0.5, "baseline_label": "at least one"}
        else:
            if a["lean"] not in ("over", "under"):
                continue
            pid, pos = a["player_id"], a["position"]
            key, label, fmt = _player_measure(a["title"], pos)
            mine = box.filter(pl.col("player_id") == pid)
            if mine.is_empty():
                continue        # did not play; the angle had nothing to be right about
            row |= {"team": off_t, "measure": label, "fmt": fmt, "direction": "up" if a["lean"] == "over" else "down",
                    "actual": _measure(mine, key), "baseline": _measure(_player_history(pid, season, week), key),
                    "baseline_label": "his previous 16 games"}
            stat = _DVP_STAT[pos] if key in ("epa_db", "ypc") else key
            mk = _MARKET.get(stat)
            if mk and not lines.is_empty():
                hit = lines.filter((pl.col("player_id") == pid) & (pl.col("market") == mk))
                if not hit.is_empty() and hit["actual"][0] is not None:
                    ln, act = float(hit["line"][0]), float(hit["actual"][0])
                    row |= {"line": ln, "market": mk, "line_result": "over" if act > ln else "under" if act < ln else "push"}
        row["verdict"] = _verdict(row["actual"], row["baseline"], row["direction"], row["fmt"], row["baseline_label"])
        if row["verdict"] is None:
            continue
        out.append(row)
    return out


def grade_week(season: int, week: int, write: bool = True, log=print) -> pl.DataFrame:
    games = (scan("schedules").filter((pl.col("season") == season) & (pl.col("week") == week)
                                      & pl.col("home_score").is_not_null()).select("game_id").collect()["game_id"].to_list())
    have = set(team_games().filter((pl.col("season") == season) & (pl.col("week") == week))["game_id"].unique().to_list())
    rows = []
    for gid in sorted(set(games) & have):
        try:
            rows += grade_game(gid)
        except Exception as exc:    # one bad game must not cost the week
            log(f"[angles] {gid} FAILED: {type(exc).__name__}: {exc}")
    df = pl.DataFrame(rows, schema=SCHEMA) if rows else pl.DataFrame(schema=SCHEMA)
    if write and rows:
        GRADED_DIR.mkdir(parents=True, exist_ok=True)
        df.write_parquet(GRADED_DIR / f"angles_{season}_{week:02d}.parquet", compression="zstd")
        graded.cache_clear()
    return df


# --- reading -----------------------------------------------------------------

@lru_cache(maxsize=1)
def graded() -> pl.DataFrame:
    files = sorted(GRADED_DIR.glob("angles_*.parquet")) if GRADED_DIR.is_dir() else []
    if not files:
        return pl.DataFrame(schema=SCHEMA)
    return _with_margin(pl.concat([pl.read_parquet(f) for f in files], how="diagonal_relaxed").sort(["season", "week", "game_id"]))


def _stamp() -> tuple:
    files = sorted(GRADED_DIR.glob("angles_*.parquet")) if GRADED_DIR.is_dir() else []
    return tuple((f.name, f.stat().st_mtime_ns) for f in files)


_last_stamp: tuple | None = None


def _fresh() -> pl.DataFrame:
    """The graded table, reread when a file under graded/ changed."""
    global _last_stamp
    s = _stamp()
    if s != _last_stamp:
        graded.cache_clear()
        _last_stamp = s
    return graded()


def _json(v):
    """NaN and inf are not JSON; a rate over an empty sample is neither."""
    if isinstance(v, float) and v != v or v in (float("inf"), float("-inf")):
        return None
    if isinstance(v, dict):
        return {k: _json(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_json(x) for x in v]
    return v


def for_game(game_id: str) -> list[dict]:
    return _json(_fresh().filter(pl.col("game_id") == game_id).to_dicts())


def recent_weeks(n: int) -> list[tuple[int, int]]:
    g = _fresh()
    if g.is_empty():
        return []
    wk = g.select("season", "week").unique().sort(["season", "week"]).tail(n)
    return [(r["season"], r["week"]) for r in wk.to_dicts()]


def track_record(weeks: int = 8, min_n: int = 1) -> dict:
    """Hit rate per family over the last ``weeks`` graded weeks, plus the
    calls that landed hardest. What the matchup page puts next to an angle
    for an upcoming game."""
    wk = recent_weeks(weeks)
    out: dict = {"weeks": wk, "n": 0, "hits": 0, "pushes": 0, "families": [], "by_kind": [], "best": []}
    if not wk:
        return out
    g = _fresh().filter((pl.col("season").cast(pl.Int64) * 100 + pl.col("week")).is_in([s * 100 + w for s, w in wk]))
    dec = g.filter(pl.col("verdict") != "push")
    out["n"], out["hits"] = dec.height, int((dec["verdict"] == "hit").sum())
    out["pushes"] = g.height - dec.height
    # Keyed by lean too: "vs man coverage" leaning over and leaning under are
    # opposite calls that share a title.
    fam = (dec.group_by("family", "kind", "lean").agg(pl.len().alias("n"), (pl.col("verdict") == "hit").sum().alias("hits"))
           .filter(pl.col("n") >= min_n).with_columns((pl.col("hits") / pl.col("n")).alias("rate"))
           .sort(["n", "rate"], descending=True))
    out["families"] = fam.to_dicts()
    out["by_kind"] = (dec.group_by("kind").agg(pl.len().alias("n"), (pl.col("verdict") == "hit").sum().alias("hits"))
                      .with_columns((pl.col("hits") / pl.col("n")).alias("rate")).sort("kind").to_dicts())
    # The clearest wins: hits where the number moved furthest, relative to
    # where it started, on the strongest angles.
    hits = dec.filter((pl.col("verdict") == "hit") & pl.col("baseline").is_not_null() & (pl.col("baseline").abs() > 1e-6))
    if not hits.is_empty():
        hits = hits.with_columns(((pl.col("actual") - pl.col("baseline")).abs() / pl.col("baseline").abs()).alias("_move"))
        out["best"] = hits.sort(["strength", "_move"], descending=True).head(12).drop("_move").to_dicts()
    return _json(out)


# --- CLI ---------------------------------------------------------------------

def finished_weeks(season: int) -> list[int]:
    df = scan("schedules").filter((pl.col("season") == season) & pl.col("home_score").is_not_null()).select("week").unique().collect()
    have = set(team_games().filter(pl.col("season") == season)["week"].unique().to_list())
    return sorted({int(w) for w in df["week"]} & have)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--season", type=int, default=CURRENT_SEASON)
    ap.add_argument("--week", type=int, default=None)
    ap.add_argument("--all", action="store_true", help="regrade every finished week of the season")
    a = ap.parse_args(argv)
    # A week touches ~250 players and a season the same few hundred again and
    # again. The server keeps sixteen players' plays (pbp.PLAYS_CACHE); a
    # batch that did the same would rescan play-by-play for nearly every one.
    from . import pbp
    pbp.player_plays = lru_cache(maxsize=1024)(pbp.player_plays.__wrapped__)
    weeks = [a.week] if a.week else finished_weeks(a.season)
    if not a.all and not a.week:
        done = {int(f.stem.split("_")[2]) for f in GRADED_DIR.glob(f"angles_{a.season}_*.parquet")} if GRADED_DIR.is_dir() else set()
        # The newest week is regraded, as with the lines: box scores get revised.
        weeks = sorted((set(weeks) - done) | ({max(weeks)} if weeks else set()))
    if not weeks:
        print(f"[angles] {a.season}: nothing finished to grade yet")
        return 0
    for w in weeks:
        df = grade_week(a.season, w)
        dec = df.filter(pl.col("verdict") != "push")
        rate = f"{(dec['verdict'] == 'hit').mean():.0%}" if dec.height else "–"
        print(f"[angles] {a.season} wk{w:02d}: {df.height} calls graded, {rate} hit", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
