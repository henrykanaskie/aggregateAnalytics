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
#: Numbers whose level says nothing about how far they move, so 5% of it is
#: the wrong yardstick. Every defense puts six and a half men in the box
#: (teams' season averages sit 0.16 apart), so 5% was a third of a defender,
#: more than a typical game moves: 20 of the first 24 box calls of 2026 were
#: pushes. A tenth of a defender leaves about one call in five a push, like
#: the rest.
MARGIN_ABS = {"Defenders in box (vs rushes)": 0.1}
#: Baselines that are thresholds rather than a usual level: under the closing
#: total by half a point is under, and one touchdown is at least one.
EXACT = ("closing total", "at least one")


def margin(base: float, fmt: str | None, baseline_label: str | None, measure: str | None = None) -> float:
    if baseline_label in EXACT:
        return 0.0
    if measure in MARGIN_ABS:
        return MARGIN_ABS[measure]
    return max(MARGIN_REL * abs(base), MARGIN_FLOOR.get(fmt or "", 0.0))


def _verdict(actual: float | None, base: float | None, d: str, fmt: str | None = None,
             baseline_label: str | None = None, measure: str | None = None) -> str | None:
    if actual is None or base is None:
        return None
    m = margin(base, fmt, baseline_label, measure)
    if abs(actual - base) < max(m, 1e-9):
        return "push"
    return "hit" if (actual > base) == (d == "up") else "miss"


def _with_margin(df: pl.DataFrame) -> pl.DataFrame:
    """Re-derive every verdict from the stored numbers, so the margin applies
    to weeks graded before it existed and changing it needs no regrade."""
    if df.is_empty():
        return df
    return df.with_columns(pl.struct("actual", "baseline", "direction", "fmt", "baseline_label", "measure").map_elements(
        lambda r: _verdict(r["actual"], r["baseline"], r["direction"], r["fmt"], r["baseline_label"], r["measure"]),
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
        # Angles with nothing to check -- a context note, a player who did
        # not play -- are still stored, with no verdict. They are what the
        # matchup page showed before kickoff, and serving a played game's
        # angles from here is what keeps an old week off the slow path
        # (:func:`pregame`).
        if a["kind"] == "team":
            c = team_check(a["title"], off_t, def_t)
            if c:
                row["direction"] = c["dir"]
            if c and c["kind"] == "metric":
                team = off_t if c["side"] == "off" else def_t
                m = METRIC_BY_KEY[c["metric"]]
                base = (float(table[c["metric"]].drop_nulls().mean()) if c["vs"] == "league"
                        else (usual.get(team) or {}).get(c["metric"]))
                row |= {"team": team, "measure": m.label, "fmt": m.fmt, "actual": actual_rows[team].get(c["metric"]),
                        "baseline": base, "baseline_label": "league average" if c["vs"] == "league" else f"{team}'s usual"}
            elif c and c["kind"] == "pos":
                league = dvp_blended(season, c["pos"], before_week=week)[c["stat"]].drop_nulls().mean()
                grp = box.filter((pl.col("team") == off_t) & (pl.col("position") == c["pos"]))
                row |= {"team": off_t, "measure": f"{c['pos']} {_STAT_LABEL[c['stat']]}", "fmt": "dec1",
                        "actual": float(grp[c["stat"]].fill_null(0).sum()) if not grp.is_empty() else None,
                        "baseline": float(league), "baseline_label": f"league average to {c['pos']}s"}
            elif c and c["kind"] == "total" and game.get("total_line") is not None:
                row |= {"measure": "Total points", "fmt": "dec1", "actual": float(game["home_score"] + game["away_score"]),
                        "baseline": float(game["total_line"]), "baseline_label": "closing total"}
            elif c and c["kind"] == "pos_td":
                grp = box.filter((pl.col("team") == off_t) & (pl.col("position") == c["pos"]))
                tds = float((grp["receiving_tds"].fill_null(0) + grp["rushing_tds"].fill_null(0)).sum())
                row |= {"team": off_t, "measure": f"{c['pos']} touchdowns", "fmt": "int", "actual": tds,
                        "baseline": 0.5, "baseline_label": "at least one"}
        elif a["lean"] in ("over", "under"):
            pid, pos = a["player_id"], a["position"]
            key, label, fmt = _player_measure(a["title"], pos)
            mine = box.filter(pl.col("player_id") == pid)
            if mine.is_empty():
                out.append(row)
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
        row["verdict"] = _verdict(row["actual"], row["baseline"], row["direction"], row["fmt"], row["baseline_label"], row.get("measure"))
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


# --- saying it in words -------------------------------------------------------
#
# A graded row is numbers: a measure, a direction, a usual value and an
# actual one. On its own that reads as "Pass rate: 69% vs 61% LAC's usual
# (said below)", which does not say what the angle predicted or why 69%
# makes it wrong. explain() turns each row into what the angle said would
# happen, what did, and the box score behind it.

#: For each team metric, what "up" and "down" mean in words, completing
#: "Said {team} would ...".
_SAID: dict[str, tuple[str, str]] = {
    "pass_epa": ("pass better than it usually does", "pass worse than it usually does"),
    "rush_epa": ("run the ball better than it usually does", "run the ball worse than it usually does"),
    "def_pass_epa": ("give up more than usual through the air", "give up less than usual through the air"),
    "def_rush_epa": ("give up more than usual on the ground", "give up less than usual on the ground"),
    "rb_target_share": ("throw to its running backs more than usual", "throw to its running backs less than usual"),
    "te_target_share": ("throw to its tight ends more than usual", "throw to its tight ends less than usual"),
    "plays_pg": ("run more plays than an average offense", "run fewer plays than an average offense"),
    "rz_td_rate": ("turn more of its red-zone trips into touchdowns than usual", "settle for field goals in the red zone more than usual"),
    "pass_rate": ("throw more than it usually does", "run more than it usually does"),
    "sack_rate_taken": ("give up more sacks than usual", "give up fewer sacks than usual"),
    "def_sack_rate": ("sack the quarterback more than usual", "sack the quarterback less than usual"),
    "int_rate": ("throw more interceptions than usual", "throw fewer interceptions than usual"),
    "def_int_rate": ("intercept more passes than usual", "intercept fewer passes than usual"),
    "third_down_conv": ("convert more third downs than usual", "convert fewer third downs than usual"),
    "fga_pg": ("kick more field goals than usual", "kick fewer field goals than usual"),
    "explosive_rate": ("hit more big plays than usual", "hit fewer big plays than usual"),
    "qb_rush_rate": ("have its quarterback run more than usual", "have its quarterback run less than usual"),
    "def_box_avg": ("put more defenders in the box than usual", "put fewer defenders in the box than usual"),
    "def_man_rate": ("play more man coverage than usual", "play more zone than usual"),
    "def_two_high_rate": ("play more two-high shells than usual", "play more single-high than usual"),
    "def_blitz_rate": ("blitz more than usual", "blitz less than usual"),
    "def_pressure_rate": ("get pressure more often than usual", "get pressure less often than usual"),
    "def_rb_target_share": ("let running backs catch more of the targets than usual", "take running backs out of the passing game"),
    "def_te_target_share": ("let tight ends catch more of the targets than usual", "take tight ends out of the passing game"),
}

#: Which part of the box score backs up each metric: the offense's run game,
#: its passing game, or who it threw to.
_EVIDENCE = {
    "rush_epa": "run", "def_rush_epa": "run", "def_box_avg": "run", "qb_rush_rate": "run",
    "pass_epa": "pass", "def_pass_epa": "pass", "sack_rate_taken": "pass", "def_sack_rate": "pass",
    "int_rate": "pass", "def_int_rate": "pass", "def_blitz_rate": "pass", "def_pressure_rate": "pass",
    "def_man_rate": "pass", "def_two_high_rate": "pass", "explosive_rate": "pass",
    "pass_rate": "mix", "plays_pg": "mix", "third_down_conv": "mix",
    "rb_target_share": "targets", "te_target_share": "targets", "def_rb_target_share": "targets", "def_te_target_share": "targets",
}

#: The metric as a noun in a sentence: "PIT's {noun} was 6.7".
_NOUN: dict[str, str] = {
    "pass_epa": "EPA per dropback", "rush_epa": "EPA per carry",
    "def_pass_epa": "passing EPA allowed per dropback", "def_rush_epa": "rushing EPA allowed per carry",
    "rb_target_share": "share of targets to running backs", "te_target_share": "share of targets to tight ends",
    "def_rb_target_share": "share of targets allowed to running backs", "def_te_target_share": "share of targets allowed to tight ends",
    "plays_pg": "play count", "rz_td_rate": "red-zone touchdown rate", "pass_rate": "pass rate",
    "sack_rate_taken": "sack rate (sacks per dropback)", "def_sack_rate": "sack rate (sacks per dropback)",
    "int_rate": "interception rate", "def_int_rate": "interception rate", "third_down_conv": "third-down conversion rate",
    "fga_pg": "field-goal attempts", "explosive_rate": "big-play rate", "qb_rush_rate": "quarterback run rate",
    "def_box_avg": "average defenders in the box on runs", "def_man_rate": "man-coverage rate",
    "def_two_high_rate": "two-high rate", "def_blitz_rate": "blitz rate", "def_pressure_rate": "pressure rate",
}

#: Per-game counts read better as counts than as a rate.
_COUNTS = {"plays_pg": ("ran", "plays"), "fga_pg": ("tried", "field goals")}

#: Player angles about one kind of snap (blitzes, man coverage, stacked
#: boxes) are graded on the whole game: the box score does not split by
#: coverage. Said so, because two angles on one player then share a number.
_SPLIT_ANGLE = ("vs the blitz", "man coverage", "zone coverage", "two-high", "under pressure", "stacked boxes", "light boxes")

_VERDICT_WORDS = {"hit": "So the call was right.", "miss": "So the call was wrong.",
                  "push": "Too close to call: the move was inside the margin, so it counts neither way."}


def _num(v: float | None, fmt: str | None, signed: bool = False) -> str:
    """``signed`` for EPA, where the sign is the point: +0.19 is good."""
    if v is None:
        return "–"
    if fmt == "pct":
        return f"{v * 100:.1f}%" if abs(v) < 0.1 else f"{v * 100:.0f}%"
    if fmt == "dec2":
        t = f"{v:.2f}" if round(v, 2) != 0 else "0.00"
        return ("+" if signed and round(v, 2) > 0 else "") + t
    if fmt == "int":
        return f"{v:.0f}"
    return f"{v:.1f}"


def _box(game_ids: list[str]) -> pl.DataFrame:
    return (scan("player_stats_week").filter(pl.col("game_id").is_in(game_ids))
            .select("game_id", "team", "player_id", "player_display_name", "position", "completions", "attempts",
                    "passing_yards", "passing_tds", "passing_interceptions", "sacks_suffered", "carries",
                    "rushing_yards", "rushing_tds", "targets", "receptions", "receiving_yards", "receiving_tds")
            .collect())


def _times(verb: str, n: int) -> str:
    return f"never {verb}" if n == 0 else f"{verb} once" if n == 1 else f"{verb} {n} times"


def _sum(df: pl.DataFrame, col: str) -> int:
    return int(df[col].fill_null(0).sum()) if not df.is_empty() else 0


def _team_evidence(kind: str, off: pl.DataFrame, team: str) -> str | None:
    if off.is_empty():
        return None
    qb = off.filter(pl.col("position") == "QB")
    if kind == "run":
        c, y = _sum(off, "carries"), _sum(off, "rushing_yards")
        return f"{team} ran {c} times for {y} yards, {y / c:.1f} a carry" if c else None
    if kind == "pass":
        a = _sum(qb, "attempts")
        if not a:
            return None
        return (f"{team}'s quarterbacks went {_sum(qb, 'completions')} of {a} for {_sum(qb, 'passing_yards')} yards, "
                f"{_sum(qb, 'passing_tds')} TD, {_sum(qb, 'passing_interceptions')} INT, {_times('sacked', _sum(qb, 'sacks_suffered'))}")
    if kind == "mix":
        return f"{team} threw {_sum(qb, 'attempts') + _sum(qb, 'sacks_suffered')} times and ran {_sum(off, 'carries')}"
    if kind == "targets":
        t = _sum(off, "targets")
        if not t:
            return None
        by = {p: _sum(off.filter(pl.col("position") == p), "targets") for p in ("RB", "WR", "TE")}
        return f"of {team}'s {t} targets, running backs saw {by['RB']}, wide receivers {by['WR']}, tight ends {by['TE']}"
    return None


def _player_evidence(me: pl.DataFrame, pos: str | None) -> str | None:
    if me.is_empty():
        return None
    r = me.to_dicts()[0]
    n = r["player_display_name"]
    g = lambda k: int(r[k] or 0)
    if pos == "QB":
        return (f"{n} went {g('completions')} of {g('attempts')} for {g('passing_yards')} yards, "
                f"{g('passing_tds')} TD, {g('passing_interceptions')} INT, {_times('sacked', g('sacks_suffered'))}")
    if pos == "RB":
        return f"{n} ran {g('carries')} times for {g('rushing_yards')} yards" + (
            f" and caught {g('receptions')} for {g('receiving_yards')}" if g("receptions") else "")
    return f"{n} caught {g('receptions')} of {g('targets')} targets for {g('receiving_yards')} yards" + (
        f" and {g('receiving_tds')} TD" if g("receiving_tds") else "")


def _said(r: dict) -> str:
    up = r["direction"] == "up"
    who = r["team"] or r["offense"]
    if r["kind"] == "player":
        name = r["player"] or "he"
        m = r["measure"]
        if m == "EPA / dropback":
            return f"Said {name} would {'play better' if up else 'struggle more'} than usual throwing the ball."
        if m == "yards / carry":
            return f"Said {name} would average {'more' if up else 'fewer'} yards a carry than usual."
        return f"Said {name} would have {'more' if up else 'fewer'} {m} than usual."
    label = r["baseline_label"] or ""
    if label.startswith("league average to "):
        pos = label.removeprefix("league average to ")
        stat = (r["measure"] or " yards").split(" ", 1)[1]
        return (f"Said {r['defense']} would give up {'more' if up else 'fewer'} {stat} to {pos} than a typical "
                f"defense does ({_num(r['baseline'], 'int')} a game).")
    if label == "closing total":
        return "Said the game would go under the total."
    if label == "at least one":
        return f"Said a {r['offense']} tight end would score."
    key = _metric_key(r["measure"])
    words = _SAID.get(key)
    if words:
        return f"Said {who} would {words[0] if up else words[1]}."
    return f"Said {who}'s {(r['measure'] or 'number').lower()} would be {'higher' if up else 'lower'} than usual."


_LABEL_KEY = {m.label: k for k, m in METRIC_BY_KEY.items()}


def _metric_key(label: str | None) -> str | None:
    return _LABEL_KEY.get(label or "")


def _happened(r: dict) -> str:
    f = r["fmt"]
    a, b = _num(r["actual"], f), _num(r["baseline"], f)
    label = r["baseline_label"] or ""
    if label == "at least one":
        n = int(r["actual"] or 0)
        return f"{r['offense']}'s tight ends scored {n} touchdown{'s' if n != 1 else ''}."
    if label == "closing total":
        return f"The teams scored {a} points against a total of {b}."
    if label.startswith("league average to "):
        pos = label.removeprefix("league average to ")
        return f"{r['offense']}'s {pos} had {_num(r['actual'], 'int')} {(r['measure'] or ' yards').split(' ', 1)[1]} against {r['defense']}."
    signed = "EPA" in (r["measure"] or "")
    a, b = _num(r["actual"], f, signed), _num(r["baseline"], f, signed)
    if r["kind"] == "player":
        m = r["measure"]
        if m in ("passing yards", "rushing yards", "receiving yards"):
            return f"{r['player']} had {_num(r['actual'], 'int')} {m}, against {_num(r['baseline'], 'dec1')} a game over his previous 16."
        if m == "yards / carry":
            return f"{r['player']} averaged {a} yards a carry, against {b} over his previous 16 games."
        return f"{r['player']} had {a} EPA per dropback, against {b} over his previous 16 games."
    key = _metric_key(r["measure"])
    if key in _COUNTS:
        verb, what = _COUNTS[key]
        base = "the league average of" if label == "league average" else "its usual"
        return f"{r['team']} {verb} {_num(r['actual'], 'int')} {what}, against {base} {_num(r['baseline'], 'dec1')} a game."
    noun = _NOUN.get(key or "", (r["measure"] or "").lower())
    usual = "the league average of" if label == "league average" else "its usual"
    return f"{r['team']}'s {noun} was {a}, against {usual} {b}."


def explain(rows: list[dict]) -> list[dict]:
    """Add ``said``, ``happened``, ``evidence`` and ``verdict_words`` to graded
    rows, in plain sentences, with the box score that backs them up."""
    if not rows:
        return rows
    box = _box(sorted({r["game_id"] for r in rows}))
    for r in rows:
        gb = box.filter(pl.col("game_id") == r["game_id"])
        ev = None
        if r["kind"] == "player":
            ev = _player_evidence(gb.filter(pl.col("player_id") == r["player_id"]), r["position"])
        else:
            kind = _EVIDENCE.get(_metric_key(r["measure"]) or "")
            if kind:
                ev = _team_evidence(kind, gb.filter(pl.col("team") == r["offense"]), r["offense"])
            elif (r["baseline_label"] or "").startswith("league average to "):
                pos = (r["measure"] or "").split(" ", 1)[0]
                stat = _DVP_STAT.get(pos)
                who = gb.filter((pl.col("team") == r["offense"]) & (pl.col("position") == pos)).sort(stat, descending=True)
                top = [f"{p['player_display_name']} {int(p[stat] or 0)}" for p in who.head(3).to_dicts() if (p[stat] or 0) > 0]
                ev = ", ".join(top) or None
        note = ("Graded on his whole game: the box score does not split out those snaps."
                if r["kind"] == "player" and any(k in r["title"] for k in _SPLIT_ANGLE) else None)
        r |= {"said": _said(r), "happened": _happened(r), "evidence": ev, "note": note,
              "verdict_words": _VERDICT_WORDS.get(r["verdict"] or "", "")}
    return rows


def for_game(game_id: str) -> list[dict]:
    """The game's graded calls, for the review panel."""
    g = _fresh().filter((pl.col("game_id") == game_id) & pl.col("verdict").is_not_null())
    return _json(explain(g.to_dicts()))


_ANGLE_COLS = ["title", "detail", "lean", "tags", "strength", "player_id", "player", "position", "defense"]


def pregame(game_id: str, kind: str = "player") -> dict[str, list[dict]] | None:
    """What this game's angles were before kickoff, keyed by offense, as the
    matchup page wants them; ``None`` if the game has not been graded.

    Recomputing a player angle reads that player's whole play-by-play
    history: 2-3 seconds a game, and the reason an old week used to crawl.
    Once the game is played that work is done and stored.
    """
    g = _fresh().filter((pl.col("game_id") == game_id) & (pl.col("kind") == kind))
    if g.is_empty():
        return None
    return {o: [{k: r[k] for k in _ANGLE_COLS} | {"tags": list(r["tags"] or [])}
                for r in g.filter(pl.col("offense") == o).to_dicts()]
            for o in g["offense"].unique().to_list()}


def record_season(season: int = CURRENT_SEASON) -> int | None:
    """The season the track record reads: this one once any of its games are
    graded, last season's until then. Never both: a record that mixes last
    December into this September says how the angles did against rosters
    and schemes that are gone."""
    seasons = set(_fresh()["season"].unique().to_list())
    if season in seasons:
        return season
    earlier = [s for s in seasons if s < season]
    return max(earlier) if earlier else None


def recent_weeks(n: int, season: int | None = None) -> list[tuple[int, int]]:
    s = record_season() if season is None else season
    if s is None:
        return []
    wk = _fresh().filter(pl.col("season") == s).select("season", "week").unique().sort("week").tail(n)
    return [(r["season"], r["week"]) for r in wk.to_dicts()]


def track_record(weeks: int = 22, min_n: int = 1) -> dict:
    """Hit rate per family over the last ``weeks`` graded weeks of the record
    season (:func:`record_season`), plus the calls that landed hardest. What
    the matchup page puts next to an angle for an upcoming game."""
    season = record_season()
    wk = recent_weeks(weeks, season) if season is not None else []
    out: dict = {"season": season, "current": season == CURRENT_SEASON, "weeks": wk, "n": 0, "hits": 0,
                 "pushes": 0, "families": [], "by_kind": [], "best": []}
    if not wk:
        return out
    g = _fresh().filter((pl.col("season").cast(pl.Int64) * 100 + pl.col("week")).is_in([s * 100 + w for s, w in wk]))
    g = g.filter(pl.col("verdict").is_not_null())
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
        out["best"] = explain(hits.sort(["strength", "_move"], descending=True).head(12).drop("_move").to_dicts())
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
        dec = df.filter(pl.col("verdict").is_not_null() & (pl.col("verdict") != "push"))
        rate = f"{(dec['verdict'] == 'hit').mean():.0%}" if dec.height else "–"
        print(f"[angles] {a.season} wk{w:02d}: {df.height} angles, {dec.height} graded, {rate} hit", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
