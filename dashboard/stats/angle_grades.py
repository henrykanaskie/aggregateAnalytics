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
                  angle is about being unusual for the league (pace). A
                  "{def} has been generous to RBs" angle is the offense's RB
                  yards against what that offense usually gets from its RBs:
                  a strong run game beating the league average says nothing
                  about the matchup.
    player angle  the player's game against his average over his previous
                  games (yards per carry for box angles, EPA per dropback for
                  quarterbacks, yards otherwise), and against the closing
                  prop line when one was graded that week.

Where closing prop lines exist the angle is also graded against them
(``line_verdict``): a player angle on his line, a position angle on the sum
of the lines of that offense's players at the position. That is the question
a bettor asks -- was the line too high or too low, the way the angle said --
and it is kept apart from ``verdict`` because the line already prices in part
of what the angle knows.

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

from nfl.data import RAW_DIR, scan

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
    "verdict": pl.String, "line": pl.Float64, "line_result": pl.String, "market": pl.String, "line_actual": pl.Float64,
    "premise_snaps": pl.Int32, "premise_of": pl.Int32, "snap_pct": pl.Float64, "usual_snap_pct": pl.Float64,
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

#: Metrics with no in-season number, and what to grade their angles on until
#: there is one. The stand-in keeps its own measure label, so a graded row
#: says what it was checked on and the review can say why.
STAND_IN = {"def_pressure_rate": "def_sack_rate"}
STAND_IN_LABEL = {("def_pressure_rate", "def_sack_rate"): "Sack rate (for pressure)"}

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


#: A position angle's measure, "RB rushing yards": what grading and the page
#: both use to tell one from a team-metric angle.
POS_MEASURE = re.compile(r"^(QB|RB|WR|TE) (passing|rushing|receiving) yards$")


def angle_market(title: str, pos: str) -> str:
    """The prop market a player angle speaks to: box and EPA angles are
    about yards per carry or per dropback, which no book prices, so their
    line is the yards line of the same player."""
    key, _, _ = _player_measure(title, pos)
    return _MARKET[_DVP_STAT[pos] if key in ("epa_db", "ypc") else key]


@lru_cache(maxsize=512)
def team_pos_usual(team: str, pos: str, season: int, week: int, n: int = 16) -> float | None:
    """What ``team`` usually gets from its players at ``pos`` in the stat a
    position angle is about: the per-game total over its last ``n`` games
    before (season, week), last season's included. A game where the position
    did nothing counts as a zero, not a missing game."""
    stat = _DVP_STAT[pos]
    df = (scan("player_stats_week")
          .filter((pl.col("team") == team) & (pl.col("season") >= season - 1)
                  & ((pl.col("season") < season) | (pl.col("week") < week)))
          .group_by("season", "week")
          .agg(pl.when(pl.col("position") == pos).then(pl.col(stat)).otherwise(0).fill_null(0).sum().alias("v"))
          .sort("season", "week").tail(n).collect())
    return float(df["v"].mean()) if df.height >= 2 else None


@lru_cache(maxsize=4096)
def player_usual(player_id: str, stat: str, season: int, week: int) -> float | None:
    """A player's per-game ``stat`` over his previous 16 games."""
    h = _player_history(player_id, season, week)
    return float(h[stat].fill_null(0).mean()) if h.height >= 2 and stat in h.columns else None


_MARKET_STAT = {m: s for s, m in _MARKET.items()}


def line_context(angle: dict, offense: str, props: list[dict], season: int, week: int) -> dict | None:
    """The prop line an upcoming angle can be read against, and the usual
    number beside it, so the page can say whether the line already expects
    what the angle does. ``props`` is the game's board (analysis.build_board).

    A player angle gets his consensus line in the market it speaks to and his
    per-game average over his previous 16. A position angle ("{def} has been
    generous to RBs") gets the sum of the lines of the offense's players at
    the position and what the offense usually gets from it. None when no book
    has a line."""
    ou = [p for p in props if p.get("kind") == "ou" and p.get("consensus") is not None]
    if angle.get("player_id") and angle.get("position") in _DVP_STAT:
        mk = angle_market(angle["title"], angle["position"])
        row = next((p for p in ou if p.get("player_id") == angle["player_id"] and p.get("market") == mk), None)
        if row is None:
            return None
        return {"market": mk, "what": _STAT_LABEL[_MARKET_STAT[mk]], "line": float(row["consensus"]), "books": row.get("n_books"),
                "usual": player_usual(angle["player_id"], _MARKET_STAT[mk], season, week), "usual_label": "his previous 16 games"}
    m = _DVP.search(angle.get("title") or "")
    if m:
        pos = m.group(1) or m.group(2)
        stat = _DVP_STAT[pos]
        mk = _MARKET[stat]
        rows = [p for p in ou if p.get("market") == mk and p.get("team") == offense and p.get("position") == pos]
        if not rows:
            return None
        # Line and usual over the same players: those with a line. The
        # position's whole usual output would set a 35-yard line for one
        # tight end against 55 yards from all of them.
        usuals = [player_usual(r["player_id"], stat, season, week) for r in rows if r.get("player_id")]
        usual = round(sum(u for u in usuals if u is not None), 1) if usuals and all(u is not None for u in usuals) else None
        return {"market": mk, "what": _STAT_LABEL[stat], "line": round(sum(float(r["consensus"]) for r in rows), 1),
                "books": None, "players": [r["player_name"] for r in rows],
                "usual": usual, "usual_label": "their previous 16 games" if len(rows) > 1 else "his previous 16 games"}
    return None


@lru_cache(maxsize=4)
def _snaps(season: int) -> pl.DataFrame:
    """Offensive snap share per player-game, this season and last, keyed by
    gsis id (snap counts come keyed on PFR ids; the player table maps them)."""
    ids = (pl.read_parquet(RAW_DIR / "players.parquet", columns=["gsis_id", "pfr_id"])
           .drop_nulls().rename({"pfr_id": "pfr_player_id", "gsis_id": "player_id"}).unique("pfr_player_id"))
    try:
        s = (scan("snap_counts").filter(pl.col("season").is_in([season - 1, season]))
             .select("game_id", "season", "week", "pfr_player_id", "offense_pct").collect())
    except FileNotFoundError:
        return pl.DataFrame(schema={"game_id": pl.String, "season": pl.Int32, "week": pl.Int32, "player_id": pl.String, "offense_pct": pl.Float64})
    return s.join(ids, on="pfr_player_id", how="inner").drop("pfr_player_id")


def snap_info(player_id: str, game_id: str, season: int, week: int) -> tuple[float | None, float | None]:
    """(his offensive snap share in this game, his usual over his previous
    eight games with snaps). None where the snap counts do not have him."""
    mine = _snaps(season).filter(pl.col("player_id") == player_id)
    if mine.is_empty():
        return None, None
    game = mine.filter(pl.col("game_id") == game_id)
    before = (mine.filter((pl.col("season") < season) | ((pl.col("season") == season) & (pl.col("week") < week)))
              .filter(pl.col("offense_pct") > 0).sort("season", "week").tail(8))
    usual = float(before["offense_pct"].mean()) if before.height >= 2 else None
    return (float(game["offense_pct"][0]) if not game.is_empty() else None), usual


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


#: Every call is a hit or a miss. There used to be a margin (5% of the usual
#: number) inside which a move was a push and counted neither way; it kept a
#: 7.1% sack rate against a usual 7.0% from counting as a call, but it also
#: let a call that went slightly the wrong way drop out of the record instead
#: of counting against it, and a bet has no margin. An exact tie is a miss:
#: the angle said the number would move one way, and it did not.


def _verdict(actual: float | None, base: float | None, d: str, fmt: str | None = None,
             baseline_label: str | None = None, measure: str | None = None) -> str | None:
    if actual is None or base is None:
        return None
    return "hit" if (actual > base if d == "up" else actual < base) else "miss"


#: A box angle is about the carries that came into that kind of box. In a
#: game with none of them, the whole-game number it would be graded on says
#: nothing about the angle: 0 of 13 carries into a stacked box and a slow
#: day is a slow day, not a stacked-box call coming true. Those games get
#: this verdict and count neither way.
ABSENT = "absent"
#: The graded outcomes that count toward a record.
DECIDED = ("hit", "miss")
#: A player call where he got hurt in the game: under half his usual snap
#: share, and on the next week's injury report with an injury. It counts
#: neither way, as a book voids a prop on a player who leaves hurt. Worked out
#: when the grades are read, because next week's report comes days after the
#: game is graded; low snaps alone could be a benching or a blowout.
INJURED = "injured"
INJURED_SNAP_SHARE = 0.5


def _with_margin(df: pl.DataFrame) -> pl.DataFrame:
    """Re-derive every verdict from the stored numbers, so a change to how a
    call is judged applies to every graded week without a regrade (the stored
    verdict column is from whenever the week was graded). A box angle whose
    premise never happened in the game is :data:`ABSENT`."""
    if df.is_empty():
        return df
    if "premise_snaps" not in df.columns:
        df = df.with_columns(pl.lit(None, pl.Int32).alias("premise_snaps"), pl.lit(None, pl.Int32).alias("premise_of"))
    v = pl.struct("actual", "baseline", "direction", "fmt", "baseline_label", "measure").map_elements(
        lambda r: _verdict(r["actual"], r["baseline"], r["direction"], r["fmt"], r["baseline_label"], r["measure"]),
        return_dtype=pl.String)
    for c in ("line_actual", "snap_pct", "usual_snap_pct"):
        if c not in df.columns:
            df = df.with_columns(pl.lit(None, pl.Float64).alias(c))
    hurt = _left_hurt(df)
    return df.with_columns(pl.when(v.is_not_null() & hurt).then(pl.lit(INJURED))
                           .when(v.is_not_null() & (pl.col("premise_snaps") == 0)).then(pl.lit(ABSENT))
                           .otherwise(v).alias("verdict"),
                           pl.when(hurt).then(None).otherwise(line_verdict_expr()).alias("line_verdict"))


def _hurt_next_week(seasons: tuple[int, ...]) -> pl.DataFrame:
    """(season, week, player_id) of every player listed with an injury on a
    week's report, keyed on the week *before* it: the game he was hurt in."""
    from .context import _inj
    lf = _inj()
    if lf is None or not seasons:
        return pl.DataFrame(schema={"season": pl.Int32, "week": pl.Int32, "player_id": pl.String})
    return (lf.filter(pl.col("season").is_in(list(seasons))
                      & (pl.col("report_primary_injury").is_not_null() | pl.col("practice_primary_injury").is_not_null()
                         | pl.col("report_status").is_in(["Out", "Doubtful", "IR", "Injured Reserve"])))
            .select(pl.col("season").cast(pl.Int32), (pl.col("week") - 1).cast(pl.Int32).alias("week"),
                    pl.col("gsis_id").alias("player_id"))
            .unique().collect())


def _left_hurt(df: pl.DataFrame) -> pl.Expr:
    """Per row: a player call on someone who got hurt in the game (INJURED)."""
    low = ((pl.col("kind") == "player") & pl.col("snap_pct").is_not_null() & pl.col("usual_snap_pct").is_not_null()
           & (pl.col("snap_pct") < INJURED_SNAP_SHARE * pl.col("usual_snap_pct")))
    cand = df.filter(low)
    if cand.is_empty():
        return pl.lit(False)
    hurt = _hurt_next_week(tuple(sorted(set(cand["season"].to_list()))))
    keys = set(zip(hurt["season"].to_list(), hurt["week"].to_list(), hurt["player_id"].to_list()))
    flags = [bool(l) and (s, w, p) in keys for l, s, w, p in
             zip(df.select(low.fill_null(False)).to_series().to_list(), df["season"].to_list(), df["week"].to_list(), df["player_id"].to_list())]
    return pl.lit(pl.Series(flags, dtype=pl.Boolean))


def line_verdict(line_result: str | None, direction: str | None) -> str | None:
    """Did the line go the way the angle leaned: over for an angle saying
    up, under for one saying down."""
    if not line_result or direction not in ("up", "down"):
        return None
    # Landing exactly on a whole-number line is a refund at a book, but the
    # angle said which side, and neither side came in: a miss.
    return "hit" if line_result == ("over" if direction == "up" else "under") else "miss"


def line_verdict_expr() -> pl.Expr:
    return (pl.when(pl.col("line_result").is_null() | ~pl.col("direction").is_in(["up", "down"])).then(None)
            .when(pl.col("line_result") == pl.when(pl.col("direction") == "up").then(pl.lit("over")).otherwise(pl.lit("under")))
            .then(pl.lit("hit"))
            .otherwise(pl.lit("miss")))


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
                key = c["metric"]
                # Pressure comes from the NFL's participation feed, which is
                # only published after the season. Until a game has it, the
                # pressure calls are graded on sack rate, the part of getting
                # home that the play-by-play does record, against the same
                # defense's usual sack rate.
                if key in STAND_IN and actual_rows[team].get(key) is None:
                    key = STAND_IN[key]
                m = METRIC_BY_KEY[key]
                base = (float(table[key].drop_nulls().mean()) if c["vs"] == "league"
                        else (usual.get(team) or {}).get(key))
                row |= {"team": team, "measure": STAND_IN_LABEL.get((c["metric"], key), m.label), "fmt": m.fmt,
                        "actual": actual_rows[team].get(key),
                        "baseline": base, "baseline_label": "league average" if c["vs"] == "league" else f"{team}'s usual"}
            elif c and c["kind"] == "pos":
                # Against what this offense usually gets from the position,
                # not the league: the angle is about this defense, so the
                # question is whether the offense did better or worse than
                # its own normal against it.
                grp = box.filter((pl.col("team") == off_t) & (pl.col("position") == c["pos"]))
                row |= {"team": off_t, "measure": f"{c['pos']} {_STAT_LABEL[c['stat']]}", "fmt": "dec1",
                        "actual": float(grp[c["stat"]].fill_null(0).sum()) if not grp.is_empty() else None,
                        "baseline": team_pos_usual(off_t, c["pos"], season, week), "baseline_label": f"{off_t}'s usual"}
                mk = _MARKET[c["stat"]]
                if not lines.is_empty() and not grp.is_empty():
                    # The position's line is the sum of its players' lines,
                    # set against what those same players did: a back with
                    # no line is not in either number.
                    lined = lines.filter(pl.col("player_id").is_in(grp["player_id"].to_list()) & (pl.col("market") == mk)
                                         & pl.col("actual").is_not_null())
                    if not lined.is_empty():
                        ln, act = float(lined["line"].sum()), float(lined["actual"].sum())
                        row |= {"line": ln, "line_actual": act, "market": mk,
                                "line_result": "over" if act > ln else "under" if act < ln else "push"}
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
            row["snap_pct"], row["usual_snap_pct"] = snap_info(pid, game_id, season, week)
            row |= {"team": off_t, "measure": label, "fmt": fmt, "direction": "up" if a["lean"] == "over" else "down",
                    "actual": _measure(mine, key), "baseline": _measure(_player_history(pid, season, week), key),
                    "baseline_label": "his previous 16 games"}
            stat = _DVP_STAT[pos] if key in ("epa_db", "ypc") else key
            mk = _MARKET.get(stat)
            if mk and not lines.is_empty():
                hit = lines.filter((pl.col("player_id") == pid) & (pl.col("market") == mk))
                if not hit.is_empty() and hit["actual"][0] is not None:
                    ln, act = float(hit["line"][0]), float(hit["actual"][0])
                    row |= {"line": ln, "line_actual": act, "market": mk,
                            "line_result": "over" if act > ln else "under" if act < ln else "push"}
        row["verdict"] = _verdict(row["actual"], row["baseline"], row["direction"], row["fmt"], row["baseline_label"], row.get("measure"))
        if row["verdict"] is not None:
            row |= _premise_cols(row)
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
                  INJURED: "He got hurt in the game (under half his usual snaps, then on the injury report), so it counts neither way.",
                  ABSENT: "The box it was about never showed up in this game, so it counts neither way."}


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


_BOX_TEXT = ("game_id", "team", "player_id", "player_display_name", "position")
_BOX_NUM = ("completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions", "sacks_suffered",
            "carries", "rushing_yards", "rushing_tds", "targets", "receptions", "receiving_yards", "receiving_tds")


def _box(game_ids: list[str]) -> pl.DataFrame:
    """The box score behind a set of graded games.

    Only the "evidence" line of an explanation reads it, so a cache without
    the table (the test runner, a partial local checkout) gets an empty one
    and explanations without that line, rather than no explanations at all."""
    try:
        return (scan("player_stats_week").filter(pl.col("game_id").is_in(game_ids))
                .select(*_BOX_TEXT, *_BOX_NUM).collect())
    except FileNotFoundError:
        return pl.DataFrame(schema={**{c: pl.String for c in _BOX_TEXT}, **{c: pl.Int32 for c in _BOX_NUM}})


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
    pm = POS_MEASURE.match(r["measure"] or "") if r["kind"] == "team" else None
    if pm:
        pos, stat = pm.group(1), f"{pm.group(2)} yards"
        return (f"Said {r['offense']}'s {pos}s would get {'more' if up else 'fewer'} {stat} against {r['defense']} "
                f"than they usually do ({_num(r['baseline'], 'int')} a game).")
    if label == "closing total":
        return "Said the game would go under the total."
    if label == "at least one":
        return f"Said a {r['offense']} tight end would score."
    key = _metric_key(r["measure"])
    words = _SAID.get(key)
    if words:
        return f"Said {who} would {words[0] if up else words[1]}."
    return f"Said {who}'s {(r['measure'] or 'number').lower()} would be {'higher' if up else 'lower'} than usual."


_LABEL_KEY = {m.label: k for k, m in METRIC_BY_KEY.items()} | {label: k for (_, k), label in STAND_IN_LABEL.items()}


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
    pm = POS_MEASURE.match(r["measure"] or "") if r["kind"] == "team" else None
    if pm:
        return (f"{r['offense']}'s {pm.group(1)}s had {_num(r['actual'], 'int')} {pm.group(2)} yards against {r['defense']}, "
                f"against their usual {_num(r['baseline'], 'dec1')}.")
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


_MARKET_WORDS = {"player_pass_yds": "passing yards", "player_rush_yds": "rushing yards", "player_reception_yds": "receiving yards"}


def _line_words(r: dict) -> str | None:
    """Against the closing line, in words: what the book set, what came in,
    and whether that was the way the angle leaned."""
    if r.get("line") is None or not r.get("line_result"):
        return None
    what = _MARKET_WORDS.get(r.get("market") or "", "yards")
    if r["kind"] == "player":
        set_, who = f"{_num(r['line'], 'dec1')} {what}", "he"
    else:
        pos = (r["measure"] or "").split(" ", 1)[0]
        set_, who = f"{_num(r['line'], 'dec1')} {what} for {r['offense']}'s {pos}s together (those with a line)", "they"
    got = f"; {who} had {_num(r['line_actual'], 'int')}" if r.get("line_actual") is not None else ""
    lv = line_verdict(r["line_result"], r["direction"])
    tail = {"hit": f"over, the way the angle leaned" if r["line_result"] == "over" else "under, the way the angle leaned",
            "miss": "exactly on the line, which counts as a miss" if r["line_result"] == "push" else f"{r['line_result']}, against the angle"}.get(lv or "", r["line_result"])
    return f"Closing line {set_}{got}: {tail}."


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
            elif POS_MEASURE.match(r["measure"] or ""):
                pos = (r["measure"] or "").split(" ", 1)[0]
                stat = _DVP_STAT.get(pos)
                who = gb.filter((pl.col("team") == r["offense"]) & (pl.col("position") == pos)).sort(stat, descending=True)
                top = [f"{p['player_display_name']} {int(p[stat] or 0)}" for p in who.head(3).to_dicts() if (p[stat] or 0) > 0]
                ev = ", ".join(top) or None
        note = ("Graded on his whole game: the box score does not split out those snaps."
                if r["kind"] == "player" and any(k in r["title"] for k in _SPLIT_ANGLE)
                else "Graded on sack rate: pressure is only published after the season, and sacks are the part of it the play-by-play records."
                if r["measure"] in STAND_IN_LABEL.values() else None)
        r |= {"said": _said(r), "happened": _happened(r), "evidence": ev, "note": note, "line_words": _line_words(r),
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


def _window(wk: list[tuple[int, int]]) -> pl.DataFrame:
    """The graded calls (verdict set, "didn't happen" included) in the given weeks."""
    g = _fresh().filter((pl.col("season").cast(pl.Int64) * 100 + pl.col("week")).is_in([s * 100 + w for s, w in wk]))
    if "line_verdict" not in g.columns:
        for c in ("line_result", "direction"):
            if c not in g.columns:
                g = g.with_columns(pl.lit(None, pl.String).alias(c))
        g = g.with_columns(line_verdict_expr().alias("line_verdict"))
    return g.filter(pl.col("verdict").is_not_null())


def track_record(weeks: int = 22, min_n: int = 1) -> dict:
    """Hit rate per family over the last ``weeks`` graded weeks of the record
    season (:func:`record_season`), plus the calls that landed hardest. What
    the matchup page puts next to an angle for an upcoming game."""
    season = record_season()
    wk = recent_weeks(weeks, season) if season is not None else []
    out: dict = {"season": season, "current": season == CURRENT_SEASON, "weeks": wk, "n": 0, "hits": 0,
                 "absent": 0, "injured": 0, "line_n": 0, "line_hits": 0, "families": [], "by_kind": [], "best": []}
    if not wk:
        return out
    g = _window(wk)
    dec = g.filter(pl.col("verdict").is_in(DECIDED))
    out["n"], out["hits"] = dec.height, int((dec["verdict"] == "hit").sum())
    out["absent"] = int((g["verdict"] == ABSENT).sum())
    out["injured"] = int((g["verdict"] == INJURED).sum())
    # Against the closing line, where there was one: its own count, since
    # only some calls had a line and a push on the line is not a push on
    # the average.
    ld = g.filter(pl.col("line_verdict").is_in(DECIDED))
    out["line_n"], out["line_hits"] = ld.height, int((ld["line_verdict"] == "hit").sum())
    line_agg = [pl.col("line_verdict").is_in(DECIDED).sum().alias("line_n"), (pl.col("line_verdict") == "hit").sum().alias("line_hits")]
    # Keyed by lean too: "vs man coverage" leaning over and leaning under are
    # opposite calls that share a title.
    fam = (dec.group_by("family", "kind", "lean").agg(pl.len().alias("n"), (pl.col("verdict") == "hit").sum().alias("hits"), *line_agg)
           .filter(pl.col("n") >= min_n).with_columns((pl.col("hits") / pl.col("n")).alias("rate"))
           .sort(["n", "rate"], descending=True))
    out["families"] = fam.to_dicts()
    out["by_kind"] = (dec.group_by("kind").agg(pl.len().alias("n"), (pl.col("verdict") == "hit").sum().alias("hits"), *line_agg)
                      .with_columns((pl.col("hits") / pl.col("n")).alias("rate")).sort("kind").to_dicts())
    # The clearest wins: hits where the number moved furthest, relative to
    # where it started, on the strongest angles.
    hits = dec.filter((pl.col("verdict") == "hit") & pl.col("baseline").is_not_null() & (pl.col("baseline").abs() > 1e-6))
    if not hits.is_empty():
        hits = hits.with_columns(((pl.col("actual") - pl.col("baseline")).abs() / pl.col("baseline").abs()).alias("_move"))
        out["best"] = explain(hits.sort(["strength", "_move"], descending=True).head(12).drop("_move").to_dicts())
    return _json(out)


# --- one family, every game behind its number ----------------------------------
#
# "Heavy boxes vs the run: 11 of 16" is a claim about sixteen games. Clicking
# it should show them: who the angle was about, what the page said before
# kickoff, what happened. And the reasoning, so a reader can judge whether a
# record is a mechanism showing through or a coin that came up heads.

#: Why each kind of angle should work, keyed by a pattern on the family and
#: optionally the lean. First match wins. Written as the case for the angle;
#: the record under it says whether the case held.
_WHY: list[tuple[str, str | None, str]] = [
    # player splits
    (r"vs stacked boxes$", None,
     "Eight or more defenders near the line means more defenders than blockers: fewer lanes, and a back who gets hit "
     "sooner. This back has averaged clearly fewer yards a carry against stacked boxes than light ones, and this "
     "defense loads the box more than most, so more of his carries should come into eight-man fronts."),
    (r"vs light boxes$", None,
     "Six or fewer in the box leaves the offense with a blocker for every defender and room to get to the second "
     "level. This back has averaged clearly more a carry against light boxes than stacked ones, and this defense "
     "plays lighter fronts than most."),
    (r"vs (man|zone) coverage$", "over",
     "Some players win one-on-one and some live in the soft spots of a zone. This one has been clearly better "
     "against the coverage this defense plays more than most teams, so the matchup plays to his strength."),
    (r"vs (man|zone) coverage$", "under",
     "Some players win one-on-one and some live in the soft spots of a zone. This one has been clearly worse against "
     "the coverage this defense plays more than most teams, so the matchup plays to his weakness."),
    (r"vs the blitz$", "over",
     "A blitz sends extra rushers and leaves fewer men in coverage. This quarterback has been better blitzed than "
     "not, a sign he finds the open man quickly, and this defense blitzes more than most."),
    (r"vs the blitz$", "under",
     "A blitz sends extra rushers and leaves fewer men in coverage. This quarterback has been worse blitzed than "
     "not, and this defense blitzes more than most, so he should see more of what bothers him."),
    (r"vs two-high shells$", "over",
     "Two deep safeties take away the deep ball and invite the short game. This quarterback has been better against "
     "two-high than single-high looks, and this defense lives in two-high."),
    (r"vs two-high shells$", "under",
     "Two deep safeties take away the deep ball and make a quarterback take the checkdown. This one has been worse "
     "against two-high than single-high looks, and this defense lives in two-high."),
    (r"under pressure vs a pressure defense$", None,
     "Every quarterback is worse under pressure, but some fall off a cliff. This one loses close to half a point of "
     "EPA a dropback when pressured, and this defense gets home more than most."),
    (r", history$", None,
     "He has done much better or worse against this defense than against everyone else across recent meetings. It "
     "can be scheme fit or a particular matchup, but it is also a small sample, so this is the angle most likely to "
     "be noise. The record is the test."),
    # team: efficiency vs efficiency
    (r"^Pass-heavy offense vs a pass defense that leaks", None,
     "A team that throws a lot, against a defense that gives up more per dropback than most. The offense leans into "
     "its strength where the defense is weakest, so it should pass better than it usually does."),
    (r"^Run-heavy offense vs a run defense that leaks", None,
     "A team that runs a lot, against a defense that gives up more per carry than most, so it should run better than "
     "it usually does."),
    (r"^Pass-heavy offense into a stingy pass defense", None,
     "A team that leans on the pass, into one of the best pass defenses. Strength into strength usually favours the "
     "defense, so the offense should pass worse than it usually does."),
    (r"^Run-first offense into a stout run defense", None,
     "A team that leans on the run, into one of the best run defenses, so it should run worse than it usually does."),
    (r"passing game beats most defenses", None,
     "Defenses facing this offense have given up more through the air than they usually do: it makes most defenses "
     "look worse. So this one should give up more than its usual too."),
    (r"passing game has been easy to defend", None,
     "Defenses facing this offense have given up less through the air than they usually do. So this one should allow "
     "less than its usual too."),
    (r"run game beats most defenses", None,
     "Defenses facing this offense have given up more on the ground than they usually do, so this one should too."),
    (r"run game has been easy to stop", None,
     "Defenses facing this offense have given up less on the ground than they usually do, so this one should too."),
    # boxes and coverage shells
    (r"^Heavy boxes vs the run", None,
     "The defense puts extra men near the line against the run. More defenders than blockers means fewer lanes, so "
     "the offense should run less efficiently than it usually does."),
    (r"^Light boxes", None,
     "The defense keeps its box light, trading run defense for coverage. With a blocker for every defender, the "
     "offense should run more efficiently than it usually does."),
    (r"load the box more than usual", None,
     "The matchup view projects how this defense plays this offense from how the defense usually plays and how "
     "defenses have played this offense. The projection has it loading the box well beyond its usual, which clogs "
     "the run: the offense should run worse than usual."),
    (r"lighten the box", None,
     "The matchup view projects this defense playing lighter fronts than usual against this offense, which opens "
     "running lanes: the offense should run better than usual."),
    (r"likely to (play more|sit in|blitz)", None,
     "The matchup view projects how this defense plays this offense from how it usually plays and how defenses have "
     "played this offense. When that projection lands well away from its usual rank, the defense should play that "
     "way more in this game."),
    # pressure and sacks
    (r"line gives up pressure", None,
     "This offense's line lets defenses get home more than they usually do, so this pass rush should reach the "
     "quarterback more than usual."),
    (r"keeps the pocket clean", None,
     "This offense keeps defenses from getting home as often as they usually do, so this pass rush should get there "
     "less than usual."),
    (r"should sack .* more than", None,
     "This offense takes sacks and this defense makes them: both halves of a sack point the same way."),
    (r"rarely goes down", None,
     "This offense rarely takes sacks against anyone, so this defense's sack rate should dip below its usual."),
    (r"^Sacks: a line that gives them up", None,
     "A line that allows sacks against a rush that gets them. Both halves point the same way, so the offense should "
     "take more sacks than usual."),
    (r"^Clean pockets", None,
     "A line that rarely allows sacks against a rush that rarely gets them, so the offense should take fewer sacks "
     "than usual."),
    # script, pace and volume
    (r"^Big favourite", None,
     "Teams expected to win comfortably spend the second half ahead and run to kill the clock, so their pass rate "
     "should fall below usual."),
    (r"^Big underdog", None,
     "Teams expected to trail spend the second half throwing to catch up, so their pass rate should rise above usual."),
    (r"^Slow offense", None,
     "A slow offense runs fewer plays, and so does its opponent: fewer chances for everyone's counting stats."),
    (r"^Fast offense", None,
     "A fast offense runs more plays than most, and gives its opponent more too: more chances for counting stats."),
    (r"is thrown on", None,
     "Offenses throw more than usual against this defense, and this one is projected to follow: its pass rate should "
     "rise."),
    (r"is run on", None,
     "Offenses run more than usual against this defense, and this one is projected to follow: its pass rate should "
     "drop."),
    (r"^Kicker volume", None,
     "An offense that kicks a lot of field goals, against a defense that forces a lot of them: more tries than "
     "usual."),
    # red zone, drives, turnovers
    (r"^Red zone favours touchdowns", None,
     "A good red-zone offense against a defense that gives up touchdowns there, so more of its trips should end in "
     "seven."),
    (r"^Red zone favours field goals", None,
     "A red-zone offense that stalls, against a defense that holds there, so more trips should end in three."),
    (r"^Drives should sustain", None,
     "Good on third down against a defense that is bad on it, so the offense should convert more third downs than "
     "usual."),
    (r"^Three-and-outs likely", None,
     "Bad on third down against a defense that is good on it, so the offense should convert fewer than usual."),
    (r"^Interception risk", None,
     "A quarterback who throws picks against a defense that makes them, so the interception rate should rise."),
    (r"^Interceptions unlikely", None,
     "A careful passer against a defense that rarely intercepts, so the interception rate should fall."),
    # who gets the ball
    (r"^Screens", None,
     "Screens punish a blitz: the extra rushers run past the back, who catches it with blockers in front. This "
     "offense screens a lot and this defense blitzes a lot, so the backs should see more of the targets."),
    (r"^Running backs in the passing game|^Running back in the red zone|funnels targets to backs", None,
     "The offense throws to its backs and this defense lets backs catch more of the targets than most, so the "
     "running backs' share of targets should rise."),
    (r"takes backs away", None,
     "This defense takes running backs out of the passing game, so the offense's backs should see a smaller share of "
     "targets than usual."),
    (r"^Tight end targets|funnels targets to tight ends|^Tight end in the red zone", None,
     "The offense uses its tight ends and this defense gives up targets to them, so tight ends should see more of "
     "the ball."),
    (r"takes tight ends away", None,
     "This defense takes tight ends away, so the offense's tight ends should see a smaller share of targets than "
     "usual."),
    (r"^Shots downfield", None,
     "An offense that takes deep shots, against a defense that gives up big plays, so the big-play rate should rise."),
    (r"^Mobile QB", None,
     "A quarterback who runs, against a run defense that leaks, so he should keep it more than usual."),
    # position defense and weather
    (r"has been generous to", None,
     "This defense has given up well above the league average to the position this season, so the offense's players "
     "there should out-gain what they usually get. The record is against their own usual, not the league's, and "
     "against the sum of their prop lines where there are some."),
    (r"has clamped", None,
     "This defense has held the position well below the league average this season, so the offense's players there "
     "should come in under what they usually get. The record is against their own usual, not the league's, and "
     "against the sum of their prop lines where there are some."),
    (r"^Wind$", None, "Wind makes passing and kicking harder, so the game should score under the closing total."),
    (r"^Cold$", None, "Cold weather tends to slow scoring, so the game should come in under the closing total."),
]


@lru_cache(maxsize=64)
def _game_plays(game_id: str) -> pl.DataFrame:
    """One game's runs and dropbacks with FTN's charting (box count, blitzers)
    joined on. FTN charts in season, so the premise of a box or blitz angle
    can be checked on the very snaps it was about."""
    from .pbp import _PBP_COLS, _scan_cast
    try:
        df = (scan("pbp").select(_PBP_COLS).filter(pl.col("game_id") == game_id)
              .filter(((pl.col("rush") == 1) | (pl.col("qb_dropback") == 1)) & (pl.col("qb_kneel") != 1)
                      & (pl.col("qb_spike") != 1) & (pl.col("aborted_play") != 1))
              .collect().with_columns(pl.col("play_id").cast(pl.Int64)))
        ftn = (_scan_cast("ftn_charting", "nflverse_play_id").filter(pl.col("nflverse_game_id") == game_id)
               .select(pl.col("nflverse_game_id").alias("game_id"), pl.col("nflverse_play_id").alias("play_id"),
                       "n_defense_box", "n_blitzers").unique(subset=["game_id", "play_id"]).collect())
    except FileNotFoundError:
        return pl.DataFrame()
    return df.join(ftn, on=["game_id", "play_id"], how="left")


def _ypc(df: pl.DataFrame) -> str:
    return f"{float(df['yards_gained'].fill_null(0).sum()) / df.height:.1f}" if df.height else "–"


def _epa(df: pl.DataFrame) -> str:
    return f"{float(df['epa'].fill_null(0).mean()):+.2f}" if df.height else "–"


#: Angles whose premise is a kind of snap FTN charts: (family pattern, whose
#: plays, which snaps count). The rest are about season-long rates and have no
#: single-game premise to check.
_PREMISE = [
    (r"vs stacked boxes$", "rusher", "stacked"), (r"vs light boxes$", "rusher", "light"),
    (r"vs the blitz$", "passer", "blitz"),
    (r"^Heavy boxes vs the run|load the box more than usual", "offense_runs", "stacked"),
    (r"^Light boxes|lighten the box", "offense_runs", "light"),
    (r"likely to blitz (more|less) than usual", "offense_dropbacks", "blitz"),
]


def in_game(r: dict) -> dict | None:
    """Did the thing the angle was about happen in the game, and how did the
    player or offense do on those snaps? ``None`` when the angle has no
    snap-level premise or the game has no charting yet."""
    fam = r.get("family") or ""
    hit = next(((who, what) for pat, who, what in _PREMISE if re.search(pat, fam)), None)
    if not hit:
        return None
    plays = _game_plays(r["game_id"])
    if plays.is_empty() or "n_defense_box" not in plays.columns:
        return None
    who, what = hit
    if who == "rusher":
        mine = plays.filter((pl.col("rusher_player_id") == r["player_id"]) & (pl.col("rush") == 1))
    elif who == "passer":
        mine = plays.filter((pl.col("passer_player_id") == r["player_id"]) & (pl.col("qb_dropback") == 1))
    elif who == "offense_runs":
        mine = plays.filter((pl.col("posteam") == r["offense"]) & (pl.col("rush") == 1))
    else:
        mine = plays.filter((pl.col("posteam") == r["offense"]) & (pl.col("qb_dropback") == 1))
    col = "n_blitzers" if what == "blitz" else "n_defense_box"
    mine = mine.filter(pl.col(col).is_not_null())
    if mine.is_empty():
        return None
    cond = {"stacked": pl.col(col) >= 8, "light": pl.col(col) <= 6, "blitz": pl.col(col) > 0}[what]
    on, off = mine.filter(cond), mine.filter(~cond)
    name = r.get("player") or r["offense"]
    val = "epa" if what == "blitz" else "yards_gained"
    # Raw sums too, so a family can add its games up (:func:`_premise_total`).
    raw = {"on_n": on.height, "on_sum": float(on[val].fill_null(0).sum()),
           "off_n": off.height, "off_sum": float(off[val].fill_null(0).sum())}
    if what == "blitz":
        return raw | {"snaps": on.height, "of": mine.height, "label": "blitzed", "unit": "EPA per dropback",
                "premise": f"{r['defense']} blitzed on {on.height} of {mine.height} {name} dropbacks",
                "split": f"EPA per dropback {_epa(on)} blitzed, {_epa(off)} not"}
    word = "8+ in the box" if what == "stacked" else "6 or fewer in the box"
    avg = float(mine["n_defense_box"].mean())
    return raw | {"snaps": on.height, "of": mine.height, "label": "8+ box" if what == "stacked" else "light box", "unit": "yards a carry",
            "premise": f"{on.height} of {mine.height} {name} carries came against {word} (average box {avg:.1f})"
            if who == "rusher" else f"{r['defense']} had {word} on {on.height} of {mine.height} {name} runs (average box {avg:.1f})",
            "split": f"{_ypc(on)} yards a carry on those, {_ypc(off)} on the rest"}


#: The families graded only where their box showed up (:data:`ABSENT`).
BOX_FAMILIES = r"vs stacked boxes$|vs light boxes$|^Heavy boxes vs the run|load the box more than usual|^Light boxes|lighten the box"


def _premise_cols(r: dict) -> dict:
    """``premise_snaps`` / ``premise_of`` for a box angle: of the carries the
    angle was about, how many came into that box. Stored when the week is
    graded, so reading a grade never needs play-by-play. Null for other
    angles, and for a game FTN has not charted."""
    if not re.search(BOX_FAMILIES, r.get("family") or ""):
        return {"premise_snaps": None, "premise_of": None}
    try:
        ig = in_game(r)
    except Exception:
        ig = None
    return {"premise_snaps": ig["snaps"] if ig else None, "premise_of": ig["of"] if ig else None}


def backfill_premise(files=None, log=print) -> int:
    """Fill in the premise columns wherever a box angle is missing them:
    weeks graded before the columns existed, and weeks graded before FTN had
    charted them (the charting can land a day or two after the games). No
    regrade: only the box angles' rows need play-by-play. Returns the number
    of files rewritten."""
    files = files if files is not None else sorted(GRADED_DIR.glob("angles_*.parquet"))
    done = 0
    for f in files:
        df = pl.read_parquet(f)
        rows = df.to_dicts()
        todo = [r for r in rows if r.get("verdict") is not None and r.get("premise_snaps") is None
                and re.search(BOX_FAMILIES, r.get("family") or "")]
        if not todo:
            continue
        for r in rows:
            r.setdefault("premise_snaps", None)
            r.setdefault("premise_of", None)
        for r in todo:
            r |= _premise_cols(r)
        out = pl.DataFrame(rows, schema={**SCHEMA, **{k: v for k, v in df.schema.items() if k not in SCHEMA}})
        out.select([c for c in SCHEMA]).write_parquet(f, compression="zstd")
        n = sum(1 for r in todo if r["premise_snaps"] is not None)
        log(f"[angles] {f.name}: premise on {n} of {len(todo)} box angles, {sum(1 for r in todo if r['premise_snaps'] == 0)} never happened")
        done += 1
    graded.cache_clear()
    return done


def _premise_total(rows: list[dict]) -> dict | None:
    """The family's games added up: how often the premise actually held, and
    how the snaps it was about went against the rest. A record built on games
    where the box was never stacked says nothing about stacked boxes."""
    g = [r["in_game"] for r in rows if r.get("in_game")]
    if not g:
        return None
    on_n, off_n = sum(x["on_n"] for x in g), sum(x["off_n"] for x in g)
    return {"label": g[0]["label"], "unit": g[0]["unit"], "games": len(g), "snaps": on_n, "of": on_n + off_n,
            "on": sum(x["on_sum"] for x in g) / on_n if on_n else None,
            "off": sum(x["off_sum"] for x in g) / off_n if off_n else None,
            "never": sum(1 for x in g if x["snaps"] == 0)}


def why(family: str, lean: str | None = None) -> str | None:
    for pat, ln, text in _WHY:
        if (ln is None or ln == lean) and re.search(pat, family):
            return text
    return None


def family_record(family: str, kind: str, lean: str, weeks: int = 22) -> dict:
    """Every graded call of one family over the track record's window, newest
    first, each with what it said before kickoff and what happened."""
    season = record_season()
    wk = recent_weeks(weeks, season) if season is not None else []
    out: dict = {"family": family, "kind": kind, "lean": lean, "season": season, "weeks": wk, "why": why(family, lean),
                 "n": 0, "hits": 0, "absent": 0, "injured": 0, "graded_on": None, "prop": None, "premise": None, "rows": []}
    if not wk:
        return out
    g = _window(wk).filter((pl.col("family") == family) & (pl.col("kind") == kind) & (pl.col("lean") == lean))
    if g.is_empty():
        return out
    dec = g.filter(pl.col("verdict").is_in(DECIDED))
    out["n"], out["hits"] = dec.height, int((dec["verdict"] == "hit").sum())
    out["absent"], out["injured"] = int((g["verdict"] == ABSENT).sum()), int((g["verdict"] == INJURED).sum())
    first = g.row(0, named=True)
    out["graded_on"] = {"measure": first["measure"], "baseline_label": first["baseline_label"], "direction": first["direction"]}
    # Where a closing line was graded that week (a player's own, or the sum
    # of a position's): the angle against the number a bettor actually faced.
    props = g.filter(pl.col("line_verdict").is_in(DECIDED) & (pl.col("verdict") != ABSENT))
    if not props.is_empty():
        out["prop"] = {"n": props.height, "agreed": int((props["line_verdict"] == "hit").sum())}
    rows = explain(g.sort(["season", "week", "game_id"], descending=True).to_dicts())
    for r in rows:
        try:
            r["in_game"] = in_game(r)
            if r["in_game"]:
                r["note"] = None    # "the box score does not split those snaps": the charting just did
        except Exception:       # charting missing or odd for one game: that row just goes without
            r["in_game"] = None
    out["rows"] = rows
    out["premise"] = _premise_total(rows)
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
    ap.add_argument("--backfill-premise", action="store_true",
                    help="add the box-angle premise columns to every graded week, without regrading")
    a = ap.parse_args(argv)
    if a.backfill_premise:
        backfill_premise()
        return 0
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
        dec = _with_margin(df).filter(pl.col("verdict").is_in(DECIDED))
        rate = f"{(dec['verdict'] == 'hit').mean():.0%}" if dec.height else "–"
        print(f"[angles] {a.season} wk{w:02d}: {df.height} angles, {dec.height} graded, {rate} hit", flush=True)
    # Box angles graded before FTN charted their game pick it up now.
    backfill_premise(sorted(GRADED_DIR.glob(f"angles_{a.season}_*.parquet")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
