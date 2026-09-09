"""Team tendencies from play-by-play: one row per team-game, with offense and
defense metrics stored as *sums and counts* so any aggregation (season,
coach tenure, last 8 games) is a correct weighted average.

Building the table means a pass over all of pbp (1999-2025), which takes a
couple of minutes, so the result is cached under ``data/derived``. Rebuild
after a new week's play-by-play is ingested:

    python -m dashboard.stats.team

Every metric is defined once in :data:`METRICS` as (numerator, denominator);
the API turns those into rates and league ranks per season.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import polars as pl

from nfl.data import dataset_files, scan

from ..config import DERIVED_DIR
from .players import player_index

VERSION = 4
CACHE = DERIVED_DIR / f"dashboard_team_games_v{VERSION}.parquet"

_COLS = [
    "game_id", "play_id", "season", "week", "season_type", "posteam", "defteam", "home_team", "drive",
    "play_type", "pass", "rush", "qb_dropback", "qb_scramble", "qb_kneel", "qb_spike", "shotgun", "no_huddle",
    "down", "ydstogo", "yardline_100", "goal_to_go", "qtr", "half_seconds_remaining", "game_seconds_remaining",
    "wp", "xpass", "pass_oe", "epa", "success", "yards_gained", "touchdown", "sack", "interception",
    "receiver_player_id", "rusher_player_id", "complete_pass", "aborted_play", "penalty", "air_yards",
    "field_goal_attempt", "punt_attempt", "fumble_lost", "third_down_converted", "third_down_failed",
]


@dataclass(frozen=True)
class Metric:
    key: str
    label: str
    num: str
    den: str
    fmt: str = "pct"          # pct | dec1 | dec2 | int
    side: str = "off"         # off | def
    since: int = 1999
    note: str = ""
    good: str = "high"        # which direction is "good" for the rank colouring; "none" for neutral tendencies


METRICS: list[Metric] = [
    # --- offense: identity --------------------------------------------------
    Metric("plays_pg", "Plays / game", "off_plays", "games", "dec1", note="Pass + rush plays, kneels and spikes excluded"),
    Metric("pass_rate", "Pass rate", "off_pass", "off_plays", good="none"),
    Metric("proe", "Pass rate over expected", "off_pass_oe_sum", "off_pass_oe_n", "dec1", since=2006, note="nflverse pass_oe, percentage points vs. situation-expected pass rate", good="none"),
    Metric("early_down_pass_rate", "Early-down pass rate", "off_ed_pass", "off_ed_plays", note="1st and 2nd down", good="none"),
    Metric("neutral_pass_rate", "Neutral-script pass rate", "off_neu_pass", "off_neu_plays", note="Win probability 20-80%, quarters 1-3, 1st-2nd down", good="none"),
    Metric("shotgun_rate", "Shotgun rate", "off_shotgun", "off_plays", note="Pistol counts as shotgun in nflverse", good="none"),
    Metric("no_huddle_rate", "No-huddle rate", "off_no_huddle", "off_plays", good="none"),
    Metric("sec_per_play", "Seconds / play (neutral)", "off_pace_sum", "off_pace_n", "dec1", note="Game-clock seconds between consecutive snaps on the same drive, neutral script. Rank 1 = slowest", good="none"),
    Metric("fourth_go_rate", "4th & short go rate", "off_4th_go", "off_4th_opps", note="4th and ≤2, outside the final 2 minutes of a half"),
    # --- offense: efficiency ----------------------------------------------
    Metric("epa_play", "EPA / play", "off_epa_sum", "off_plays", "dec2"),
    Metric("success_rate", "Success rate", "off_success", "off_plays"),
    Metric("pass_epa", "Pass EPA / dropback", "off_pass_epa_sum", "off_pass", "dec2"),
    Metric("rush_epa", "Rush EPA / carry", "off_rush_epa_sum", "off_rush", "dec2"),
    Metric("ypp", "Yards / play", "off_yards", "off_plays", "dec1"),
    Metric("explosive_rate", "Explosive play rate", "off_explosive", "off_plays", note="Passes of 20+ or rushes of 10+ yards"),
    Metric("adot", "aDOT", "off_air_yards_sum", "off_air_yards_n", "dec1", since=2006, good="none"),
    # --- offense: red zone -------------------------------------------------
    Metric("rz_trips_pg", "Red-zone trips / game", "off_rz_trips", "games", "dec2"),
    Metric("rz_td_rate", "Red-zone TD rate", "off_rz_td", "off_rz_trips", note="Touchdowns per trip inside the 20"),
    Metric("rz_pass_rate", "Red-zone pass rate", "off_rz_pass", "off_rz_plays", good="none"),
    Metric("gtg_rush_rate", "Goal-to-go rush rate", "off_gtg_rush", "off_gtg_plays", good="none"),
    # --- offense: distribution ---------------------------------------------
    Metric("rb_target_share", "RB target share", "off_rb_targets", "off_targets", good="none"),
    Metric("wr_target_share", "WR target share", "off_wr_targets", "off_targets", good="none"),
    Metric("te_target_share", "TE target share", "off_te_targets", "off_targets", good="none"),
    Metric("rb_carry_share", "RB share of carries", "off_rb_carries", "off_rush", good="none", note="Carries by running backs; the rest are QB scrambles/designed runs and WR/TE carries"),
    Metric("lead_rb_share", "Lead RB share of RB carries", "off_top_rb_carries", "off_rb_carries", good="none", note="Per game, the most-used back's share; committee offenses sit low"),
    Metric("rb_touch_pg", "RB touches / game", "off_rb_touches", "games", "dec1", good="none"),
    Metric("qb_rush_rate", "QB rush rate", "off_qb_rush", "off_plays", good="none", note="Scrambles and designed QB runs per play"),
    # --- offense: ball security, downs, kicking, red-zone distribution ------
    Metric("sack_rate_taken", "Sack rate taken", "off_sacks_taken", "off_pass", note="Sacks per dropback", good="low"),
    Metric("int_rate", "Interception rate", "off_ints", "off_pass", "pct", note="Interceptions thrown per dropback", good="low"),
    Metric("third_down_conv", "3rd-down conversion", "off_3rd_conv", "off_3rd_att"),
    Metric("fga_pg", "FG attempts / game", "off_fga", "games", "dec2", good="none"),
    Metric("rz_rb_target_share", "Red-zone RB target share", "off_rz_rb_t", "off_rz_targets", good="none"),
    Metric("rz_wr_target_share", "Red-zone WR target share", "off_rz_wr_t", "off_rz_targets", good="none"),
    Metric("rz_te_target_share", "Red-zone TE target share", "off_rz_te_t", "off_rz_targets", good="none"),
    Metric("deep_rate", "Deep target rate", "off_deep", "off_air_yards_n", since=2006, note="Share of targets thrown 20+ air yards", good="none"),
    # --- offense: charting (2022+) and personnel (2016-2023) ----------------
    Metric("pa_rate", "Play-action rate", "off_pa", "off_pa_n", since=2022, note="FTN charting, share of dropbacks", good="none"),
    Metric("motion_rate", "Motion rate", "off_motion", "off_motion_n", since=2022, note="FTN charting", good="none"),
    Metric("rpo_rate", "RPO rate", "off_rpo", "off_motion_n", since=2022, note="FTN charting", good="none"),
    Metric("screen_rate", "Screen rate", "off_screen", "off_pa_n", since=2022, note="FTN charting, share of dropbacks", good="none"),
    Metric("box_faced", "Defenders in box faced (rushes)", "off_box_sum", "off_box_n", "dec2", since=2022, note="FTN charting", good="none"),
    Metric("p11_rate", "11 personnel rate", "off_p11", "off_pers_n", since=2016, note="1 RB, 1 TE, 3 WR (fullbacks count as RBs). NFL participation data, 2016+", good="none"),
    Metric("p12_rate", "12 personnel rate", "off_p12", "off_pers_n", since=2016, note="1 RB, 2 TE. 2016+", good="none"),
    Metric("p21_rate", "21 personnel rate", "off_p21", "off_pers_n", since=2016, note="2 RB (incl. FB), 1 TE. 2016+", good="none"),
    Metric("under_center_rate", "Under-center rate (NGS)", "off_uc", "off_form_n", since=2016, note="Singleback, I-form, jumbo or 'under center' formations; the rest is shotgun, pistol and empty. 2016+", good="none"),
    # --- defense -----------------------------------------------------------
    Metric("def_epa_play", "EPA / play allowed", "def_epa_sum", "def_plays", "dec2", "def", good="low"),
    Metric("def_success_rate", "Success rate allowed", "def_success", "def_plays", "pct", "def", good="low"),
    Metric("def_pass_epa", "Pass EPA allowed / dropback", "def_pass_epa_sum", "def_pass", "dec2", "def", good="low"),
    Metric("def_rush_epa", "Rush EPA allowed / carry", "def_rush_epa_sum", "def_rush", "dec2", "def", good="low"),
    Metric("def_ypp", "Yards / play allowed", "def_yards", "def_plays", "dec1", "def", good="low"),
    Metric("def_explosive_rate", "Explosive rate allowed", "def_explosive", "def_plays", "pct", "def", good="low"),
    Metric("def_pass_rate_faced", "Pass rate faced", "def_pass", "def_plays", "pct", "def", good="none"),
    Metric("def_sack_rate", "Sack rate", "def_sacks", "def_pass", "pct", "def"),
    Metric("def_rz_td_rate", "Red-zone TD rate allowed", "def_rz_td", "def_rz_trips", "pct", "def", good="low"),
    Metric("def_blitz_rate", "Blitz rate", "def_blitz", "def_blitz_n", "pct", "def", since=2022, note="FTN charting: dropbacks with at least one blitzer", good="none"),
    Metric("def_box_avg", "Defenders in box (vs rushes)", "def_box_sum", "def_box_n", "dec2", "def", since=2022, note="FTN charting", good="none"),
    Metric("def_pressure_rate", "Pressure rate", "def_pressure", "def_pressure_n", "pct", "def", since=2016, note="NFL participation data, 2016+"),
    Metric("def_man_rate", "Man coverage rate", "def_man", "def_man_n", "pct", "def", since=2016, note="Share of charted dropbacks in man coverage, 2016+", good="none"),
    Metric("def_int_rate", "Interception rate", "def_ints", "def_pass", "pct", "def", note="Interceptions per opponent dropback"),
    Metric("def_third_down_conv", "3rd-down conversion allowed", "def_3rd_conv", "def_3rd_att", "pct", "def", good="low"),
    Metric("def_fga_pg", "FG attempts allowed / game", "def_fga", "games", "dec2", "def", good="none"),
    Metric("def_adot_faced", "aDOT faced", "def_air_sum", "def_air_n", "dec1", "def", since=2006, good="none"),
    Metric("def_deep_rate_faced", "Deep target rate faced", "def_deep", "def_air_n", "pct", "def", since=2006, note="Share of targets against them thrown 20+ air yards", good="none"),
    Metric("def_cover1_rate", "Cover 1 rate", "def_c1", "def_cov_n", "pct", "def", since=2016, note="Single-high man, charted dropbacks 2016+", good="none"),
    Metric("def_cover3_rate", "Cover 3 rate", "def_c3", "def_cov_n", "pct", "def", since=2016, good="none"),
    Metric("def_two_high_rate", "Two-high rate", "def_c2h", "def_cov_n", "pct", "def", since=2016, note="Cover 2, 4, 6 and 2-man", good="none"),
    Metric("def_cover0_rate", "Cover 0 rate", "def_c0", "def_cov_n", "pct", "def", since=2016, good="none"),
    Metric("def_rb_target_share", "RB target share allowed", "def_rb_targets", "def_targets", "pct", "def", good="none"),
    Metric("def_te_target_share", "TE target share allowed", "def_te_targets", "def_targets", "pct", "def", good="none"),
]
METRIC_BY_KEY = {m.key: m for m in METRICS}
SUM_COLS = sorted({m.num for m in METRICS} | {m.den for m in METRICS} - {"games"})


def _scan_cast(name: str, play_col: str, season: int) -> pl.DataFrame | None:
    files = [f for f in dataset_files(name) if f.stem.endswith(str(season))]
    if not files:
        return None
    return pl.read_parquet(files[0]).with_columns(pl.col(play_col).cast(pl.Int64, strict=False).alias("play_id"))


def _season_plays(season: int, pos_map: pl.DataFrame) -> pl.DataFrame:
    df = (
        scan("pbp").filter(pl.col("season") == season).select(_COLS).collect()
        .with_columns(pl.col("play_id").cast(pl.Int64))
    )
    ftn = _scan_cast("ftn_charting", "nflverse_play_id", season)
    if ftn is not None:
        ftn = ftn.select(pl.col("nflverse_game_id").alias("game_id"), "play_id", "is_play_action", "is_motion",
                         "is_rpo", "is_screen_pass", "n_defense_box", "n_blitzers").unique(subset=["game_id", "play_id"])
        df = df.join(ftn, on=["game_id", "play_id"], how="left")
    else:
        df = df.with_columns([pl.lit(None, dtype=pl.Boolean).alias(c) for c in ("is_play_action", "is_motion", "is_rpo", "is_screen_pass")]
                             + [pl.lit(None, dtype=pl.Float64).alias(c) for c in ("n_defense_box", "n_blitzers")])
    part = _scan_cast("participation", "play_id", season)
    if part is not None:
        part = part.select(pl.col("nflverse_game_id").alias("game_id"), "play_id", "offense_formation", "offense_personnel",
                           "defense_man_zone_type", "defense_coverage_type", "was_pressure").unique(subset=["game_id", "play_id"])
        df = df.join(part, on=["game_id", "play_id"], how="left")
    else:
        df = df.with_columns([pl.lit(None, dtype=pl.String).alias(c) for c in ("offense_formation", "offense_personnel", "defense_man_zone_type", "defense_coverage_type")]
                             + [pl.lit(None, dtype=pl.Boolean).alias("was_pressure")])
    # The participation feed changed shape in 2023: personnel strings list the
    # whole lineup, formations say "UNDER CENTER", and blanks replaced nulls.
    # Normalise here so every downstream indicator sees one format.
    rb = pl.col("offense_personnel").str.extract(r"(\d+) RB", 1).cast(pl.Int8, strict=False).fill_null(0) \
        + pl.col("offense_personnel").str.extract(r"(\d+) FB", 1).cast(pl.Int8, strict=False).fill_null(0)
    te = pl.col("offense_personnel").str.extract(r"(\d+) TE", 1).cast(pl.Int8, strict=False).fill_null(0)
    has_pers = pl.col("offense_personnel").is_not_null() & (pl.col("offense_personnel") != "") \
        & pl.col("offense_personnel").str.contains(r"\d+ (RB|TE|WR|FB)")
    df = df.with_columns(
        _rb=pl.when(has_pers).then(rb).otherwise(None), _te=pl.when(has_pers).then(te).otherwise(None),
        offense_formation=pl.when(pl.col("offense_formation") == "").then(None).otherwise(pl.col("offense_formation")),
        defense_man_zone_type=pl.when(pl.col("defense_man_zone_type") == "").then(None).otherwise(pl.col("defense_man_zone_type")),
        defense_coverage_type=pl.when(pl.col("defense_coverage_type") == "").then(None).otherwise(pl.col("defense_coverage_type")),
    )
    df = df.join(pos_map.rename({"player_id": "receiver_player_id", "position": "rec_pos"}), on="receiver_player_id", how="left")
    df = df.join(pos_map.rename({"player_id": "rusher_player_id", "position": "rush_pos"}), on="rusher_player_id", how="left")
    return df


def _indicators(df: pl.DataFrame) -> pl.DataFrame:
    is_play = (pl.col("play_type").is_in(["pass", "run"])) & (pl.col("qb_kneel") != 1) & (pl.col("qb_spike") != 1) & pl.col("posteam").is_not_null()
    is_pass = pl.col("pass") == 1
    is_rush = pl.col("rush") == 1
    is_target = is_pass & (pl.col("sack") != 1) & pl.col("receiver_player_id").is_not_null()
    neutral = (pl.col("wp") >= 0.2) & (pl.col("wp") <= 0.8) & (pl.col("qtr") <= 3) & (pl.col("down") <= 2)
    rz = pl.col("yardline_100") <= 20
    rb = pl.col("rec_pos").is_in(["RB", "FB", "HB"])
    rb_rush = pl.col("rush_pos").is_in(["RB", "FB", "HB"])
    fourth_short = (pl.col("down") == 4) & (pl.col("ydstogo") <= 2) & (pl.col("half_seconds_remaining") > 120) & pl.col("posteam").is_not_null()
    rb_pos = pl.col("rush_pos").is_in(["RB", "FB", "HB"])
    df = df.sort(["game_id", "play_id"]).with_columns(
        _pace=pl.when(
            (pl.col("drive") == pl.col("drive").shift(1)) & (pl.col("posteam") == pl.col("posteam").shift(1))
            & (pl.col("game_id") == pl.col("game_id").shift(1))
        ).then(pl.col("game_seconds_remaining").shift(1) - pl.col("game_seconds_remaining")).otherwise(None)
    )
    pace_ok = is_play & neutral & (pl.col("_pace") > 0) & (pl.col("_pace") <= 45)
    return df.with_columns(
        i_play=is_play.cast(pl.Int32), i_pass=(is_play & is_pass).cast(pl.Int32), i_rush=(is_play & is_rush).cast(pl.Int32),
        i_ed=(is_play & (pl.col("down") <= 2)).cast(pl.Int32), i_ed_pass=(is_play & is_pass & (pl.col("down") <= 2)).cast(pl.Int32),
        i_neu=(is_play & neutral).cast(pl.Int32), i_neu_pass=(is_play & neutral & is_pass).cast(pl.Int32),
        i_shotgun=(is_play & (pl.col("shotgun") == 1)).cast(pl.Int32), i_nh=(is_play & (pl.col("no_huddle") == 1)).cast(pl.Int32),
        v_pace=pl.when(pace_ok).then(pl.col("_pace")).otherwise(None), i_pace=pace_ok.cast(pl.Int32),
        i_4th_opp=fourth_short.cast(pl.Int32), i_4th_go=(fourth_short & pl.col("play_type").is_in(["pass", "run"])).cast(pl.Int32),
        v_epa=pl.when(is_play).then(pl.col("epa")).otherwise(None), i_success=(is_play & (pl.col("success") == 1)).cast(pl.Int32),
        v_pass_epa=pl.when(is_play & is_pass).then(pl.col("epa")).otherwise(None), v_rush_epa=pl.when(is_play & is_rush).then(pl.col("epa")).otherwise(None),
        v_yards=pl.when(is_play).then(pl.col("yards_gained")).otherwise(None),
        i_explosive=(is_play & ((is_pass & (pl.col("yards_gained") >= 20)) | (is_rush & (pl.col("yards_gained") >= 10)))).cast(pl.Int32),
        v_air=pl.when(is_target).then(pl.col("air_yards")).otherwise(None), i_air=(is_target & pl.col("air_yards").is_not_null()).cast(pl.Int32),
        i_rz=(is_play & rz).cast(pl.Int32), i_rz_pass=(is_play & rz & is_pass).cast(pl.Int32),
        i_rz_td=(is_play & rz & (pl.col("touchdown") == 1)).cast(pl.Int32),
        rz_drive=pl.when(is_play & rz).then(pl.col("drive")).otherwise(None),
        i_gtg=(is_play & (pl.col("goal_to_go") == 1)).cast(pl.Int32), i_gtg_rush=(is_play & (pl.col("goal_to_go") == 1) & is_rush).cast(pl.Int32),
        i_target=is_target.cast(pl.Int32), i_rb_t=(is_target & rb).cast(pl.Int32), i_wr_t=(is_target & (pl.col("rec_pos") == "WR")).cast(pl.Int32),
        i_te_t=(is_target & (pl.col("rec_pos") == "TE")).cast(pl.Int32),
        i_rb_c=(is_play & is_rush & rb_rush).cast(pl.Int32), i_qb_rush=(is_play & is_rush & (pl.col("rush_pos") == "QB")).cast(pl.Int32),
        i_rb_touch=(is_play & ((is_rush & rb_rush) | (is_pass & (pl.col("complete_pass") == 1) & rb))).cast(pl.Int32),
        i_pa=(is_play & is_pass & (pl.col("is_play_action") == True)).cast(pl.Int32), i_pa_n=(is_play & is_pass & pl.col("is_play_action").is_not_null()).cast(pl.Int32),
        i_screen=(is_play & is_pass & (pl.col("is_screen_pass") == True)).cast(pl.Int32),
        i_motion=(is_play & (pl.col("is_motion") == True)).cast(pl.Int32), i_motion_n=(is_play & pl.col("is_motion").is_not_null()).cast(pl.Int32),
        i_rpo=(is_play & (pl.col("is_rpo") == True)).cast(pl.Int32),
        v_box=pl.when(is_play & is_rush).then(pl.col("n_defense_box")).otherwise(None), i_box=(is_play & is_rush & pl.col("n_defense_box").is_not_null()).cast(pl.Int32),
        i_pers_n=(is_play & pl.col("_rb").is_not_null()).cast(pl.Int32),
        i_p11=(is_play & (pl.col("_rb") == 1) & (pl.col("_te") == 1)).cast(pl.Int32),
        i_p12=(is_play & (pl.col("_rb") == 1) & (pl.col("_te") == 2)).cast(pl.Int32),
        i_p21=(is_play & (pl.col("_rb") == 2) & (pl.col("_te") == 1)).cast(pl.Int32),
        i_form_n=(is_play & pl.col("offense_formation").is_not_null()).cast(pl.Int32),
        i_uc=(is_play & pl.col("offense_formation").is_in(["SINGLEBACK", "I_FORM", "JUMBO", "UNDER CENTER"])).cast(pl.Int32),
        i_sack=(is_play & (pl.col("sack") == 1)).cast(pl.Int32),
        i_int=(is_play & (pl.col("interception") == 1)).cast(pl.Int32),
        i_3rd=(is_play & (pl.col("down") == 3)).cast(pl.Int32), i_3rd_conv=(is_play & (pl.col("down") == 3) & (pl.col("third_down_converted") == 1)).cast(pl.Int32),
        i_fga=(pl.col("field_goal_attempt") == 1).cast(pl.Int32),
        i_rz_t=(is_target & rz).cast(pl.Int32), i_rz_rb_t=(is_target & rz & rb).cast(pl.Int32),
        i_rz_wr_t=(is_target & rz & (pl.col("rec_pos") == "WR")).cast(pl.Int32), i_rz_te_t=(is_target & rz & (pl.col("rec_pos") == "TE")).cast(pl.Int32),
        i_deep=(is_target & (pl.col("air_yards") >= 20)).cast(pl.Int32),
        i_cov_n=(is_play & is_pass & pl.col("defense_coverage_type").is_not_null()).cast(pl.Int32),
        i_c1=(is_play & is_pass & (pl.col("defense_coverage_type") == "COVER_1")).cast(pl.Int32),
        i_c3=(is_play & is_pass & (pl.col("defense_coverage_type") == "COVER_3")).cast(pl.Int32),
        i_c2h=(is_play & is_pass & pl.col("defense_coverage_type").is_in(["COVER_2", "COVER_4", "COVER_6", "2_MAN"])).cast(pl.Int32),
        i_c0=(is_play & is_pass & (pl.col("defense_coverage_type") == "COVER_0")).cast(pl.Int32),
        i_blitz=(is_play & is_pass & (pl.col("n_blitzers") > 0)).cast(pl.Int32), i_blitz_n=(is_play & is_pass & pl.col("n_blitzers").is_not_null()).cast(pl.Int32),
        i_pressure=(is_play & is_pass & (pl.col("was_pressure") == True)).cast(pl.Int32), i_pressure_n=(is_play & is_pass & pl.col("was_pressure").is_not_null()).cast(pl.Int32),
        i_man=(is_play & is_pass & (pl.col("defense_man_zone_type") == "MAN_COVERAGE")).cast(pl.Int32), i_man_n=(is_play & is_pass & pl.col("defense_man_zone_type").is_not_null()).cast(pl.Int32),
        _rb_pos=rb_pos,
    )


def _team_game(df: pl.DataFrame) -> pl.DataFrame:
    keys = ["season", "week", "season_type", "game_id", "posteam", "defteam", "home_team"]
    # Timeouts, end-of-quarter markers and the like carry no possession team;
    # left in, they become a phantom "null" team with two rows per game.
    df = df.filter(pl.col("posteam").is_not_null() & pl.col("defteam").is_not_null())
    off = df.group_by(keys).agg(
        off_plays=pl.col("i_play").sum(), off_pass=pl.col("i_pass").sum(), off_rush=pl.col("i_rush").sum(),
        off_pass_oe_sum=pl.col("pass_oe").filter(pl.col("i_play") == 1).sum(), off_pass_oe_n=pl.col("pass_oe").filter(pl.col("i_play") == 1).count(),
        off_ed_plays=pl.col("i_ed").sum(), off_ed_pass=pl.col("i_ed_pass").sum(),
        off_neu_plays=pl.col("i_neu").sum(), off_neu_pass=pl.col("i_neu_pass").sum(),
        off_shotgun=pl.col("i_shotgun").sum(), off_no_huddle=pl.col("i_nh").sum(),
        off_pace_sum=pl.col("v_pace").sum(), off_pace_n=pl.col("i_pace").sum(),
        off_4th_opps=pl.col("i_4th_opp").sum(), off_4th_go=pl.col("i_4th_go").sum(),
        off_epa_sum=pl.col("v_epa").sum(), off_success=pl.col("i_success").sum(),
        off_pass_epa_sum=pl.col("v_pass_epa").sum(), off_rush_epa_sum=pl.col("v_rush_epa").sum(),
        off_yards=pl.col("v_yards").sum(), off_explosive=pl.col("i_explosive").sum(),
        off_air_yards_sum=pl.col("v_air").sum(), off_air_yards_n=pl.col("i_air").sum(),
        off_rz_plays=pl.col("i_rz").sum(), off_rz_pass=pl.col("i_rz_pass").sum(), off_rz_td=pl.col("i_rz_td").sum(),
        off_rz_trips=pl.col("rz_drive").n_unique() - pl.col("rz_drive").is_null().any().cast(pl.Int32),
        off_gtg_plays=pl.col("i_gtg").sum(), off_gtg_rush=pl.col("i_gtg_rush").sum(),
        off_targets=pl.col("i_target").sum(), off_rb_targets=pl.col("i_rb_t").sum(), off_wr_targets=pl.col("i_wr_t").sum(), off_te_targets=pl.col("i_te_t").sum(),
        off_rb_carries=pl.col("i_rb_c").sum(), off_qb_rush=pl.col("i_qb_rush").sum(), off_rb_touches=pl.col("i_rb_touch").sum(),
        off_top_rb_carries=pl.col("rusher_player_id").filter((pl.col("i_rb_c") == 1)).value_counts(sort=True).struct.field("count").first().fill_null(0),
        off_pa=pl.col("i_pa").sum(), off_pa_n=pl.col("i_pa_n").sum(), off_screen=pl.col("i_screen").sum(),
        off_motion=pl.col("i_motion").sum(), off_motion_n=pl.col("i_motion_n").sum(), off_rpo=pl.col("i_rpo").sum(),
        off_box_sum=pl.col("v_box").sum(), off_box_n=pl.col("i_box").sum(),
        off_pers_n=pl.col("i_pers_n").sum(), off_p11=pl.col("i_p11").sum(), off_p12=pl.col("i_p12").sum(), off_p21=pl.col("i_p21").sum(),
        off_form_n=pl.col("i_form_n").sum(), off_uc=pl.col("i_uc").sum(),
        off_sacks_taken=pl.col("i_sack").sum(), off_ints=pl.col("i_int").sum(),
        off_3rd_att=pl.col("i_3rd").sum(), off_3rd_conv=pl.col("i_3rd_conv").sum(), off_fga=pl.col("i_fga").sum(),
        off_rz_targets=pl.col("i_rz_t").sum(), off_rz_rb_t=pl.col("i_rz_rb_t").sum(), off_rz_wr_t=pl.col("i_rz_wr_t").sum(), off_rz_te_t=pl.col("i_rz_te_t").sum(),
        off_deep=pl.col("i_deep").sum(),
        # seen from the defense: coverage mix
        def_cov_n=pl.col("i_cov_n").sum(), def_c1=pl.col("i_c1").sum(), def_c3=pl.col("i_c3").sum(), def_c2h=pl.col("i_c2h").sum(), def_c0=pl.col("i_c0").sum(),
        # the same plays seen from the defense's side
        def_sacks=pl.col("i_sack").sum(), def_blitz=pl.col("i_blitz").sum(), def_blitz_n=pl.col("i_blitz_n").sum(),
        def_pressure=pl.col("i_pressure").sum(), def_pressure_n=pl.col("i_pressure_n").sum(),
        def_man=pl.col("i_man").sum(), def_man_n=pl.col("i_man_n").sum(),
    ).rename({"posteam": "team", "defteam": "opponent"})
    # Defense rows: the opponent's offense line, relabelled.
    d = off.select(
        "season", "week", "season_type", "game_id", "home_team",
        pl.col("opponent").alias("team"), pl.col("team").alias("opponent"),
        pl.col("off_plays").alias("def_plays"), pl.col("off_pass").alias("def_pass"), pl.col("off_rush").alias("def_rush"),
        pl.col("off_epa_sum").alias("def_epa_sum"), pl.col("off_success").alias("def_success"),
        pl.col("off_pass_epa_sum").alias("def_pass_epa_sum"), pl.col("off_rush_epa_sum").alias("def_rush_epa_sum"),
        pl.col("off_yards").alias("def_yards"), pl.col("off_explosive").alias("def_explosive"),
        pl.col("off_rz_td").alias("def_rz_td"), pl.col("off_rz_trips").alias("def_rz_trips"),
        pl.col("off_targets").alias("def_targets"), pl.col("off_rb_targets").alias("def_rb_targets"), pl.col("off_te_targets").alias("def_te_targets"),
        pl.col("off_box_sum").alias("def_box_sum"), pl.col("off_box_n").alias("def_box_n"),
        "def_sacks", "def_blitz", "def_blitz_n", "def_pressure", "def_pressure_n", "def_man", "def_man_n",
        pl.col("off_ints").alias("def_ints"), pl.col("off_3rd_att").alias("def_3rd_att"), pl.col("off_3rd_conv").alias("def_3rd_conv"),
        pl.col("off_fga").alias("def_fga"), pl.col("off_air_yards_sum").alias("def_air_sum"), pl.col("off_air_yards_n").alias("def_air_n"),
        pl.col("off_deep").alias("def_deep"), "def_cov_n", "def_c1", "def_c3", "def_c2h", "def_c0",
    )
    off = off.drop("def_sacks", "def_blitz", "def_blitz_n", "def_pressure", "def_pressure_n", "def_man", "def_man_n",
                   "def_cov_n", "def_c1", "def_c3", "def_c2h", "def_c0")
    out = off.join(d, on=["season", "week", "season_type", "game_id", "home_team", "team", "opponent"], how="full", coalesce=True)
    return out.with_columns(home=(pl.col("team") == pl.col("home_team")), games=pl.lit(1, dtype=pl.Int32))


def build(seasons: list[int] | None = None, log=print) -> pl.DataFrame:
    pos_map = player_index().select("player_id", "position")
    if seasons is None:
        seasons = sorted({int(f.stem.split("_")[-1]) for f in dataset_files("pbp")})
    frames = []
    for s in seasons:
        df = _indicators(_season_plays(s, pos_map))
        tg = _team_game(df)
        frames.append(tg)
        log(f"[team] {s}: {tg.height} team-games")
    out = pl.concat(frames, how="diagonal_relaxed").sort(["season", "week", "game_id", "team"])
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    out.write_parquet(CACHE, compression="zstd")
    log(f"[team] wrote {out.height} rows -> {CACHE}")
    team_games.cache_clear()
    return out


@lru_cache(maxsize=1)
def team_games() -> pl.DataFrame:
    if not CACHE.exists():
        raise FileNotFoundError(f"{CACHE} missing. Run: python -m dashboard.stats.team")
    return pl.read_parquet(CACHE).filter(pl.col("team").is_not_null() & pl.col("opponent").is_not_null())


def rates(df: pl.DataFrame, keys: list[str]) -> pl.DataFrame:
    """Sum the numerators and denominators over ``keys`` and turn them into
    the metrics. Works for any grouping: season, coach tenure, last N games."""
    sums = [c for c in SUM_COLS if c in df.columns] + ["games"]
    agg = df.group_by(keys).agg([pl.col(c).sum() for c in sums] + [pl.col("home").cast(pl.Int32).sum().alias("home_games")])
    exprs = []
    for m in METRICS:
        if m.num not in agg.columns or m.den not in agg.columns:
            continue
        e = pl.when(pl.col(m.den) > 0).then(pl.col(m.num) / pl.col(m.den)).otherwise(None)
        exprs.append(e.alias(m.key))
    return agg.with_columns(exprs).sort(keys)


def with_ranks(season_rates: pl.DataFrame) -> pl.DataFrame:
    """Rank 1..n within each season for every metric; 1 = highest value.
    ``good`` on the metric says whether that is good, bad or neutral."""
    exprs = []
    for m in METRICS:
        if m.key in season_rates.columns:
            exprs.append(pl.col(m.key).rank(method="min", descending=True).over("season").alias(f"{m.key}_rank"))
    n = pl.len().over("season").alias("n_teams")
    return season_rates.with_columns(exprs + [n])


def metric_json() -> list[dict]:
    return [{"key": m.key, "label": m.label, "fmt": m.fmt, "side": m.side, "since": m.since, "note": m.note, "good": m.good} for m in METRICS]


if __name__ == "__main__":
    import sys
    yrs = [int(a) for a in sys.argv[1:]] or None
    build(yrs)
