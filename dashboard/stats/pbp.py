"""Play-level splits for one player, straight from play-by-play.

This is where "4.9 yards per carry from under center vs 3.4 from shotgun"
comes from. The player's plays are pulled once (predicate pushdown makes the
27-season scan cheap for a single id), decorated with FTN charting (2022+:
play action, motion, RPO, screens, box count) and NFL participation data
(2016-2023: formation, personnel, coverage, pressure), and then grouped by
whichever dimension the caller asks for.

Three roles, because the same play means different things to different
players on it: ``rush`` (rusher_player_id), ``rec`` (receiver_player_id),
``pass`` (passer_player_id).
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import polars as pl

from nfl.data import dataset_files, scan

from .players import player_index


def _scan_cast(name: str, play_col: str) -> pl.LazyFrame:
    """Union a season-partitioned table whose play id drifts between Int32
    and Float64 across files (participation does this in 2023). Each file is
    cast to Int64 before the union so polars does not refuse the mismatch."""
    parts = []
    for f in dataset_files(name):
        lf = pl.scan_parquet(f)
        parts.append(lf.with_columns(pl.col(play_col).cast(pl.Int64, strict=False)))
    return pl.concat(parts, how="diagonal_relaxed")

_PBP_COLS = [
    "game_id", "play_id", "season", "week", "season_type", "posteam", "defteam", "home_team",
    "play_type", "pass", "rush", "qb_dropback", "qb_scramble", "qb_kneel", "qb_spike", "shotgun",
    "no_huddle", "down", "ydstogo", "yardline_100", "goal_to_go", "qtr", "half_seconds_remaining",
    "score_differential", "wp", "xpass", "pass_oe", "epa", "success", "air_yards", "yards_after_catch",
    "yards_gained", "complete_pass", "incomplete_pass", "interception", "sack", "touchdown",
    "pass_touchdown", "rush_touchdown", "first_down", "cpoe", "run_location", "run_gap",
    "pass_location", "pass_length", "receiver_player_id", "rusher_player_id", "passer_player_id",
    "receiving_yards", "rushing_yards", "passing_yards", "penalty", "aborted_play",
]

ROLE_ID = {"rush": "rusher_player_id", "rec": "receiver_player_id", "pass": "passer_player_id"}


@dataclass(frozen=True)
class Dim:
    key: str
    label: str
    expr: pl.Expr
    roles: tuple[str, ...] = ("rush", "rec", "pass")
    since: int = 1999
    note: str = ""
    order: tuple[str, ...] = ()   # explicit level order for bucketed dims; else alphabetical


def _bucket(col: str, edges: list[tuple[float, str]], default: str = "Other") -> pl.Expr:
    """Ordered thresholds: value <= edge -> label."""
    e = pl.when(pl.col(col).is_null()).then(pl.lit(None, dtype=pl.String))
    for edge, label in edges:
        e = e.when(pl.col(col) <= edge).then(pl.lit(label))
    return e.otherwise(pl.lit(default))


def _flag(col: str, yes: str, no: str) -> pl.Expr:
    """Boolean charting flag -> label, keeping nulls null so seasons without
    the charting data are excluded rather than counted as 'no'."""
    return (
        pl.when(pl.col(col).is_null()).then(pl.lit(None, dtype=pl.String))
        .when(pl.col(col).cast(pl.Boolean, strict=False)).then(pl.lit(yes))
        .otherwise(pl.lit(no))
    )


def _blank(col: str) -> pl.Expr:
    """Empty strings (the 2023+ participation feed) behave as nulls."""
    return pl.when(pl.col(col) == "").then(None).otherwise(pl.col(col))


def _personnel(col: str) -> pl.Expr:
    """'1 RB, 1 TE, 3 WR' (2016-2022) or '1 C, 2 G, 1 QB, 1 RB, 2 T, 1 TE, 3 WR'
    (2023+) -> '11 personnel'. Fullbacks count as backs."""
    rb = pl.col(col).str.extract(r"(\d+) RB", 1).cast(pl.Int8, strict=False).fill_null(0) \
        + pl.col(col).str.extract(r"(\d+) FB", 1).cast(pl.Int8, strict=False).fill_null(0)
    te = pl.col(col).str.extract(r"(\d+) TE", 1).cast(pl.Int8, strict=False).fill_null(0)
    ok = pl.col(col).is_not_null() & pl.col(col).str.contains(r"\d+ (RB|TE|WR|FB)")
    return (
        pl.when(~ok).then(pl.lit(None, dtype=pl.String))
        .otherwise(rb.cast(pl.String) + te.cast(pl.String) + pl.lit(" personnel"))
    )


DIMS: list[Dim] = [
    Dim("formation", "Shotgun vs under center",
        _flag("shotgun", "Shotgun", "Under center"),
        note="nflverse flags pistol as shotgun"),
    Dim("huddle", "Huddle vs no-huddle",
        _flag("no_huddle", "No huddle", "Huddle")),
    Dim("down", "Down", pl.when(pl.col("down").is_null()).then(None).otherwise(pl.lit("Down ") + pl.col("down").cast(pl.Int8).cast(pl.String))),
    Dim("distance", "Distance to go", _bucket("ydstogo", [(3, "Short (1-3)"), (6, "Medium (4-6)"), (10, "Long (7-10)")], "Very long (11+)"),
        order=("Short (1-3)", "Medium (4-6)", "Long (7-10)", "Very long (11+)")),
    Dim("field", "Field position",
        _bucket("yardline_100", [(5, "Goal line (≤5)"), (20, "Red zone (6-20)"), (49, "Opp territory (21-49)"), (80, "Own 20-50")], "Backed up (own ≤20)"),
        order=("Backed up (own ≤20)", "Own 20-50", "Opp territory (21-49)", "Red zone (6-20)", "Goal line (≤5)")),
    Dim("redzone", "Red zone",
        pl.when(pl.col("yardline_100").is_null()).then(None).when(pl.col("yardline_100") <= 20).then(pl.lit("Red zone")).otherwise(pl.lit("Outside red zone"))),
    Dim("quarter", "Quarter", pl.when(pl.col("qtr").is_null()).then(None).when(pl.col("qtr") >= 5).then(pl.lit("OT")).otherwise(pl.lit("Q") + pl.col("qtr").cast(pl.Int8).cast(pl.String))),
    Dim("script", "Score situation",
        _bucket("score_differential", [(-9, "Trailing 9+"), (-1, "Trailing 1-8"), (0, "Tied"), (8, "Leading 1-8")], "Leading 9+"),
        order=("Trailing 9+", "Trailing 1-8", "Tied", "Leading 1-8", "Leading 9+")),
    Dim("wp", "Win probability (game script)",
        _bucket("wp", [(0.2, "Blowout loss (<20%)"), (0.4, "Trailing (20-40%)"), (0.6, "Neutral (40-60%)"), (0.8, "Leading (60-80%)")], "Blowout win (>80%)"),
        order=("Blowout loss (<20%)", "Trailing (20-40%)", "Neutral (40-60%)", "Leading (60-80%)", "Blowout win (>80%)")),
    Dim("twomin", "Two-minute drill",
        pl.when(pl.col("half_seconds_remaining").is_null()).then(None).when(pl.col("half_seconds_remaining") <= 120).then(pl.lit("Final 2 min of half")).otherwise(pl.lit("Rest of game"))),
    Dim("venue", "Home / away", pl.when(pl.col("posteam") == pl.col("home_team")).then(pl.lit("Home")).otherwise(pl.lit("Away"))),
    Dim("opponent", "Opponent", pl.col("defteam")),
    Dim("season", "Season", pl.col("season").cast(pl.String)),
    Dim("passer", "Quarterback throwing", pl.col("passer_name"), roles=("rec",), note="Per target, so mid-game QB changes count correctly"),
    Dim("roof", "Dome vs outdoors", pl.when(pl.col("roof").is_null()).then(None).when(pl.col("roof").is_in(["dome", "closed"])).then(pl.lit("Indoors")).otherwise(pl.lit("Outdoors"))),
    Dim("temp", "Temperature", _bucket("temp", [(32, "Freezing (≤32°F)"), (45, "Cold (33-45°F)"), (65, "Mild (46-65°F)"), (80, "Warm (66-80°F)")], "Hot (81°F+)"), note="Outdoor games only; nflverse has no weather for domes",
        order=("Freezing (≤32°F)", "Cold (33-45°F)", "Mild (46-65°F)", "Warm (66-80°F)", "Hot (81°F+)")),
    Dim("wind", "Wind", _bucket("wind", [(7, "Calm (≤7 mph)"), (14, "Breezy (8-14 mph)")], "Windy (15+ mph)"), note="Outdoor games only",
        order=("Calm (≤7 mph)", "Breezy (8-14 mph)", "Windy (15+ mph)")),
    # receiving / passing only
    Dim("depth", "Target depth",
        _bucket("air_yards", [(-1, "Behind LOS"), (9, "Short (0-9)"), (19, "Intermediate (10-19)")], "Deep (20+)"),
        roles=("rec", "pass"), since=2006),
    Dim("pass_location", "Pass direction", pl.col("pass_location").str.to_titlecase(), roles=("rec", "pass")),
    # rushing only
    Dim("run_location", "Run direction", pl.col("run_location").str.to_titlecase(), roles=("rush",)),
    Dim("run_gap", "Run gap", pl.col("run_gap").str.to_titlecase(), roles=("rush",)),
    # FTN charting, 2022+
    Dim("play_action", "Play action", _flag("is_play_action", "Play action", "No play action"), roles=("rec", "pass"), since=2022, note="FTN charting, 2022+"),
    Dim("motion", "Pre-snap motion", _flag("is_motion", "Motion", "No motion"), since=2022, note="FTN charting, 2022+"),
    Dim("rpo", "RPO", _flag("is_rpo", "RPO", "Not RPO"), since=2022, note="FTN charting, 2022+"),
    Dim("screen", "Screen pass", _flag("is_screen_pass", "Screen", "Not screen"), roles=("rec", "pass"), since=2022, note="FTN charting, 2022+"),
    Dim("box", "Defenders in box", _bucket("n_defense_box", [(6, "Light box (≤6)"), (7, "7 in box")], "Stacked (8+)"), since=2022, note="FTN charting, 2022+"),
    Dim("qb_location", "QB alignment (FTN)", pl.col("qb_location").replace_strict({"U": "Under center", "S": "Shotgun", "P": "Pistol"}, default=None), since=2022, note="FTN charting: separates pistol from shotgun. 2022+"),
    Dim("backfield", "Players in backfield", pl.when(pl.col("n_offense_backfield").is_null()).then(None).otherwise(pl.lit("Backfield ") + pl.col("n_offense_backfield").cast(pl.Int8).cast(pl.String)), since=2022, note="FTN charting, 2022+"),
    Dim("blitz", "Blitzed", pl.when(pl.col("n_blitzers").is_null()).then(None).when(pl.col("n_blitzers") > 0).then(pl.lit("Blitz")).otherwise(pl.lit("No blitz")), roles=("rec", "pass"), since=2022, note="FTN charting, 2022+"),
    # participation, 2016-2023
    Dim("offense_formation", "Formation (NGS)", _blank("offense_formation").str.to_titlecase().str.replace("_", " "), since=2016, note="NFL participation data, 2016+. Labels changed in 2023 (singleback/I-form became 'Under center')"),
    Dim("personnel", "Personnel grouping", _personnel("offense_personnel"), since=2016, note="RB-TE count, e.g. 11 = 1 RB 1 TE 3 WR. Fullbacks count as RBs. 2016+"),
    Dim("coverage", "Coverage faced", _blank("defense_coverage_type").str.to_titlecase().str.replace("_", " "), roles=("rec", "pass"), since=2016, note="NFL participation data, 2016+"),
    Dim("man_zone", "Man vs zone", _blank("defense_man_zone_type").str.to_titlecase().str.replace("_", " "), roles=("rec", "pass"), since=2016, note="2016+"),
    Dim("pressure", "Pressured", _flag("was_pressure", "Pressured", "Clean pocket"), roles=("pass", "rec"), since=2016, note="2016+"),
    Dim("route", "Route run", _blank("route").str.to_titlecase(), roles=("rec",), since=2016, note="Targeted routes only, 2016+"),
    Dim("ngs_box", "Defenders in box (NGS)", _bucket("defenders_in_box", [(6, "Light box (≤6)"), (7, "7 in box")], "Stacked (8+)"), since=2016, note="2016+"),
]
DIM_BY_KEY = {d.key: d for d in DIMS}


@lru_cache(maxsize=128)
def player_plays(player_id: str) -> pl.DataFrame:
    """Every play the player rushed, was targeted or threw on, with charting
    columns attached where they exist."""
    lf = scan("pbp").select(_PBP_COLS).filter(
        (pl.col("rusher_player_id") == player_id)
        | (pl.col("receiver_player_id") == player_id)
        | (pl.col("passer_player_id") == player_id)
    )
    df = lf.collect().with_columns(pl.col("play_id").cast(pl.Int64))
    if df.is_empty():
        return df
    games = df["game_id"].unique().to_list()
    try:
        ftn = (
            _scan_cast("ftn_charting", "nflverse_play_id")
            .filter(pl.col("nflverse_game_id").is_in(games))
            .select(pl.col("nflverse_game_id").alias("game_id"), pl.col("nflverse_play_id").alias("play_id"),
                    "is_play_action", "is_motion", "is_rpo", "is_screen_pass", "n_defense_box", "qb_location",
                    "n_offense_backfield", "n_blitzers", "n_pass_rushers", "is_qb_out_of_pocket")
            .unique(subset=["game_id", "play_id"])
            .collect()
        )
        df = df.join(ftn, on=["game_id", "play_id"], how="left")
    except FileNotFoundError:
        pass
    try:
        part = (
            _scan_cast("participation", "play_id")
            .filter(pl.col("nflverse_game_id").is_in(games))
            .select(pl.col("nflverse_game_id").alias("game_id"), "play_id", "offense_formation", "offense_personnel",
                    "defenders_in_box", "defense_personnel", "defense_man_zone_type", "defense_coverage_type",
                    "route", "was_pressure", "time_to_throw")
            .unique(subset=["game_id", "play_id"])
            .collect()
        )
        df = df.join(part, on=["game_id", "play_id"], how="left")
    except FileNotFoundError:
        pass
    for c in ("is_play_action", "is_motion", "is_rpo", "is_screen_pass", "was_pressure", "is_qb_out_of_pocket"):
        if c in df.columns:
            df = df.with_columns(pl.col(c).cast(pl.Boolean, strict=False))
    # Who threw it, by name, so a receiver can be split by quarterback.
    names = player_index().select(pl.col("player_id").alias("passer_player_id"), pl.col("name").alias("passer_name"))
    df = df.join(names, on="passer_player_id", how="left")
    # Weather from the schedule, for cold / wind / dome splits at play level.
    wx = scan("schedules").select("game_id", "roof", "temp", "wind").collect()
    df = df.join(wx, on="game_id", how="left")
    return df


def role_plays(df: pl.DataFrame, role: str) -> pl.DataFrame:
    """Restrict to the plays that count for the role."""
    if df.is_empty():
        return df
    pid_col = ROLE_ID[role]
    pid = df.filter(pl.col(pid_col).is_not_null())[pid_col][0] if df.height else None
    base = df.filter((pl.col("qb_kneel") != 1) & (pl.col("qb_spike") != 1) & (pl.col("aborted_play") != 1))
    if role == "rush":
        return base.filter((pl.col("rusher_player_id") == pid) & (pl.col("rush") == 1))
    if role == "rec":
        return base.filter((pl.col("receiver_player_id") == pid) & (pl.col("pass") == 1) & (pl.col("sack") != 1))
    return base.filter((pl.col("passer_player_id") == pid) & (pl.col("qb_dropback") == 1))


def _mean(col: str, alias: str | None = None) -> pl.Expr:
    return pl.col(col).cast(pl.Float64).mean().alias(alias or col)


METRICS: dict[str, list[tuple[str, str, str]]] = {
    # key, label, fmt
    "rush": [("plays", "Carries", "int"), ("yards", "Yards", "int"), ("ypc", "Yds/carry", "dec1"), ("td", "TD", "int"),
             ("success", "Success %", "pct"), ("epa", "EPA/carry", "dec2"), ("first_down", "1st down %", "pct"),
             ("explosive", "10+ yd %", "pct"), ("stuffed", "Stuffed %", "pct"), ("share", "Share of plays", "pct")],
    "rec": [("plays", "Targets", "int"), ("catches", "Rec", "int"), ("yards", "Yards", "int"), ("ypt", "Yds/target", "dec1"),
            ("catch_rate", "Catch %", "pct"), ("adot", "aDOT", "dec1"), ("yac", "YAC/rec", "dec1"), ("td", "TD", "int"),
            ("success", "Success %", "pct"), ("epa", "EPA/target", "dec2"), ("first_down", "1st down %", "pct"),
            ("explosive", "20+ yd %", "pct"), ("share", "Share of targets", "pct")],
    "pass": [("plays", "Dropbacks", "int"), ("attempts", "Att", "int"), ("comp_pct", "Comp %", "pct"), ("yards", "Yards", "int"),
             ("ypa", "Yds/att", "dec1"), ("td", "TD", "int"), ("int", "INT", "int"), ("sack_rate", "Sack %", "pct"),
             ("adot", "aDOT", "dec1"), ("cpoe", "CPOE", "dec1"), ("success", "Success %", "pct"), ("epa", "EPA/dropback", "dec2"),
             ("scramble", "Scramble %", "pct"), ("share", "Share of dropbacks", "pct")],
}


def _aggs(role: str) -> list[pl.Expr]:
    if role == "rush":
        return [
            pl.len().alias("plays"), pl.col("rushing_yards").sum().alias("yards"),
            _mean("rushing_yards", "ypc"), pl.col("rush_touchdown").sum().alias("td"),
            _mean("success"), _mean("epa"), _mean("first_down"),
            (pl.col("rushing_yards") >= 10).mean().alias("explosive"),
            (pl.col("rushing_yards") <= 0).mean().alias("stuffed"),
        ]
    if role == "rec":
        return [
            pl.len().alias("plays"), pl.col("complete_pass").sum().alias("catches"),
            pl.col("receiving_yards").sum().alias("yards"), _mean("receiving_yards", "ypt"),
            _mean("complete_pass", "catch_rate"), _mean("air_yards", "adot"),
            pl.col("yards_after_catch").filter(pl.col("complete_pass") == 1).mean().alias("yac"),
            pl.col("pass_touchdown").sum().alias("td"), _mean("success"), _mean("epa"), _mean("first_down"),
            (pl.col("receiving_yards") >= 20).mean().alias("explosive"),
        ]
    attempts = (pl.col("sack") != 1) & (pl.col("qb_scramble") != 1)
    return [
        pl.len().alias("plays"), attempts.sum().alias("attempts"),
        pl.col("complete_pass").filter(attempts).mean().alias("comp_pct"),
        pl.col("passing_yards").sum().alias("yards"),
        pl.col("passing_yards").filter(attempts).mean().alias("ypa"),
        pl.col("pass_touchdown").sum().alias("td"), pl.col("interception").sum().alias("int"),
        _mean("sack", "sack_rate"), pl.col("air_yards").filter(attempts).mean().alias("adot"),
        _mean("cpoe"), _mean("success"), _mean("epa"), _mean("qb_scramble", "scramble"),
    ]


def splits(player_id: str, role: str, dims: list[str] | None = None, since: int = 1999,
           season_type: str | None = None) -> dict:
    return _splits_cached(player_id, role, tuple(dims) if dims else None, since, season_type)


@lru_cache(maxsize=2048)
def _splits_cached(player_id: str, role: str, dims: tuple[str, ...] | None, since: int, season_type: str | None) -> dict:
    df = role_plays(player_plays(player_id), role)
    df = df.filter(pl.col("season") >= since)
    if season_type in ("REG", "POST"):
        df = df.filter(pl.col("season_type") == season_type)
    total = df.height
    out: dict = {"role": role, "n_plays": total, "since": since, "metrics": METRICS[role], "dims": []}
    if total == 0:
        return out
    wanted = [DIM_BY_KEY[k] for k in (dims or DIM_BY_KEY) if k in DIM_BY_KEY and role in DIM_BY_KEY[k].roles]
    for d in wanted:
        needed = _needed_cols(d.expr)
        if any(c not in df.columns for c in needed):
            continue
        sub = df.with_columns(d.expr.alias("_level")).filter(pl.col("_level").is_not_null())
        if sub.is_empty():
            continue
        agg = sub.group_by("_level").agg(_aggs(role)).with_columns((pl.col("plays") / sub.height).alias("share"))
        agg = agg.sort("plays", descending=True) if d.key in ("opponent", "route", "coverage", "offense_formation", "personnel", "passer") else agg.sort("_level")
        levels = [{"level": r.pop("_level"), **{k: (None if v is None or v != v else v) for k, v in r.items()}} for r in agg.to_dicts()]
        if d.order:
            levels.sort(key=lambda l: d.order.index(l["level"]) if l["level"] in d.order else 99)
        out["dims"].append({"key": d.key, "label": d.label, "note": d.note, "since": d.since,
                            "n": sub.height, "levels": levels})
    return out


def _needed_cols(expr: pl.Expr) -> list[str]:
    return list(expr.meta.root_names())


def splits_by_game(player_id: str, role: str, dim: str, since: int = 1999) -> dict:
    """Per-game values for each level of one dimension, for grouped-bar charts:
    'ypc from shotgun vs under center, game by game'."""
    d = DIM_BY_KEY[dim]
    df = role_plays(player_plays(player_id), role).filter(pl.col("season") >= since)
    if df.is_empty() or any(c not in df.columns for c in _needed_cols(d.expr)):
        return {"role": role, "dim": dim, "games": []}
    sub = df.with_columns(d.expr.alias("_level")).filter(pl.col("_level").is_not_null())
    agg = (
        sub.group_by(["game_id", "season", "week", "season_type", "defteam", "_level"])
        .agg(_aggs(role))
        .sort(["season", "week"])
    )
    games: dict[str, dict] = {}
    for r in agg.to_dicts():
        g = games.setdefault(r["game_id"], {"game_id": r["game_id"], "season": r["season"], "week": r["week"],
                                             "season_type": r["season_type"], "opponent": r["defteam"], "levels": {}})
        lvl = r.pop("_level")
        for k in ("game_id", "season", "week", "season_type", "defteam"):
            r.pop(k, None)
        g["levels"][lvl] = {k: (None if v is None or v != v else v) for k, v in r.items()}
    return {"role": role, "dim": dim, "label": d.label, "games": list(games.values())}


def default_role(position: str | None, stat_key: str | None = None) -> str:
    if stat_key:
        if stat_key.startswith(("passing", "comp", "attempts", "completions", "yards_per_attempt", "pacr", "long_completion", "ngs_pass", "pfr_pass", "xp_pass", "pass_")):
            return "pass"
        if stat_key.startswith(("rushing", "carries", "yards_per_carry", "long_rush", "ngs_rush", "pfr_rush", "xp_rush")):
            return "rush"
        if stat_key.startswith(("receiving", "receptions", "targets", "catch", "yards_per_target", "yards_per_reception", "adot", "racr", "long_reception", "ngs_rec", "pfr_rec", "xp_rec", "target_share", "air_yards", "wopr")):
            return "rec"
    return {"QB": "pass", "RB": "rush", "FB": "rush"}.get(position or "", "rec")


def available_roles(player_id: str) -> dict[str, int]:
    df = player_plays(player_id)
    return {r: role_plays(df, r).height for r in ROLE_ID} if not df.is_empty() else {r: 0 for r in ROLE_ID}
