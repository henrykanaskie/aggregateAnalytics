"""Who a team is *now*: this season's games weighed against last season's.

Until this module, every ranked team number on the research and matchup pages
came from exactly one season. :func:`coaches.season_used` read last season
until a team had four games, then switched outright to the new one, so a team
went from being wholly its 2025 self to wholly three-and-a-bit weeks of 2026
overnight. Neither end is right. Last season describes a roster and a staff
that have partly gone; four games are four games.

The blend
---------
Each metric is ``w * this_season + (1 - w) * prior`` with ``w = g / (g + K)``,
where ``g`` is the games this season with data for that metric. ``prior`` is
last season pulled part of the way to last season's league average, because a
team's number regresses from one year to the next even with nothing changed.

``K`` (how many games last season is worth) and the regression both depend on
what kind of number it is, and were fitted on 2017-2025 regular seasons by
predicting each game's rate from everything known before it
(each game's rate predicted from everything known before it):

    scheme       personnel, formation, box, coverage, blitz. A new
                 coordinator changes these at once and they settle within a
                 few games, so this season takes over fast (K=3).
    tendency     pass rate, pace, target distribution. Steadier within a year
                 and sticky across it (K=10).
    efficiency   EPA, success, red-zone TD rate, sacks, pressure. Noisy game
                 to game and regress hard across seasons (K=16).

A coaching change on that side of the ball (head coach, or the coordinator
for it) does not make this season take over faster -- the fits were the same
-- but it does make last season less informative, so the prior is regressed
harder toward league average. Every group beat both "last season only" and
"this season only" in that backtest, and the blend cut the error of the old
four-game switch by 4-10% on every metric checked (2019-2025, weeks 1-17).

Head to head
------------
What a defense shows depends on who it is facing. Defenses play lighter boxes
against offenses that punish them through the air and more two-high shells
against quarterbacks who throw deep, whatever their own habit. The team table
already records, for every game, what each offense *faced*, so an offense's
faced rate is a real measurement of how defenses treat it. The matchup view
is ``defense + beta * (offense_faced - league)``, with ``beta`` fitted the
same way (:data:`H2H_BETA`); the same idea runs the other way for the few
offensive tendencies a defense bends (pass rate, RB and TE target share).
On top of the blend it cut the error of the defensive numbers by another
1-5% (box count 3.7%, pressure 4.3%, pass EPA allowed 4.8%).
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import polars as pl

from .team import METRIC_BY_KEY, METRICS, team_games, with_ranks


@dataclass(frozen=True)
class Prior:
    k: float                 # games of last season the prior is worth
    regress: float           # share of the way last season is pulled to league average
    regress_new_staff: float # the same after a coaching change on that side


PRIORS: dict[str, Prior] = {
    "scheme": Prior(3, 0.4, 0.8),
    "tendency": Prior(10, 0.5, 0.7),
    "efficiency": Prior(16, 0.6, 0.75),
}

_SCHEME = {
    "shotgun_rate", "no_huddle_rate", "pa_rate", "motion_rate", "rpo_rate", "screen_rate", "box_faced",
    "p11_rate", "p12_rate", "p21_rate", "under_center_rate",
    "def_blitz_rate", "def_box_avg", "def_man_rate", "def_cover1_rate", "def_cover3_rate",
    "def_two_high_rate", "def_cover0_rate",
}
_TENDENCY = {
    "plays_pg", "pass_rate", "proe", "early_down_pass_rate", "neutral_pass_rate", "sec_per_play", "fourth_go_rate",
    "adot", "rz_pass_rate", "gtg_rush_rate", "rb_target_share", "wr_target_share", "te_target_share",
    "rb_carry_share", "lead_rb_share", "rb_touch_pg", "qb_rush_rate", "fga_pg", "rz_rb_target_share",
    "rz_wr_target_share", "rz_te_target_share", "deep_rate",
    "def_pass_rate_faced", "def_fga_pg", "def_adot_faced", "def_deep_rate_faced", "def_rb_target_share",
    "def_te_target_share",
}


def group_of(key: str) -> str:
    return "scheme" if key in _SCHEME else "tendency" if key in _TENDENCY else "efficiency"


#: How far an offense moves what a defense shows, per unit of the offense's
#: own faced rate above league average. Fitted on 2019-2025 with the blended
#: numbers as of each week; see the module docstring.
H2H_BETA: dict[str, float] = {
    # Scheme: the defense's own habit still does most of the work.
    "def_box_avg": 0.6,
    "def_man_rate": 0.4,
    "def_two_high_rate": 0.5,
    "def_blitz_rate": 0.35,
    # Results: the offense matters as much as the defense (fits ran 1.0-1.3;
    # held at 1.0 so a projection never overshoots the offense's own number).
    "def_pressure_rate": 1.0,
    "def_sack_rate": 1.0,
    "def_pass_epa": 1.0,
    "def_rush_epa": 1.0,
}

#: The mirror image: offensive tendencies a defense pulls one way or the
#: other, keyed by the defensive metric that measures the pull.
H2H_OFF: dict[str, tuple[str, float]] = {
    "pass_rate": ("def_pass_rate_faced", 0.75),
    "rb_target_share": ("def_rb_target_share", 0.5),
    "te_target_share": ("def_te_target_share", 0.25),
}


def _reg() -> pl.DataFrame:
    return team_games().filter(pl.col("season_type") == "REG")


def through_week(season: int, before_week: int | None = None) -> int:
    """The last week of ``season`` the numbers include: everything played
    before ``before_week``, capped at what the table actually has.

    Two requests that would read the same games get the same answer, which is
    what lets the precomputed angle table key on it.
    """
    s = _reg().filter(pl.col("season") == season)
    if before_week is not None:
        s = s.filter(pl.col("week") < before_week)
    return int(s["week"].max()) if not s.is_empty() else 0


def _sums(df: pl.DataFrame, by: str) -> pl.DataFrame:
    """Numerators, denominators and games-with-data for every metric."""
    cols = sorted({m.num for m in METRICS} | {m.den for m in METRICS} - {"games"})
    cols = [c for c in cols if c in df.columns]
    return df.group_by(by).agg(
        [pl.col(c).sum() for c in cols]
        + [pl.col("games").sum()]
        + [(pl.col(m.den) > 0).sum().alias(f"_g_{m.key}") if m.den != "games" else pl.col("games").sum().alias(f"_g_{m.key}")
           for m in METRICS if m.den in df.columns or m.den == "games"]
    ).rename({by: "team"})


def _rate(m) -> pl.Expr:
    return pl.when(pl.col(m.den) > 0).then(pl.col(m.num) / pl.col(m.den)).otherwise(None)


def _staff_changed(season: int) -> dict[str, tuple[bool, bool]]:
    """``{team: (offense_changed, defense_changed)}`` against last season."""
    from .coaches import current_staff
    now, then = current_staff(season), current_staff(season - 1)
    out = {}
    for t, s in now.items():
        p = then.get(t, {})
        hc = bool(p.get("HC")) and s.get("HC") != p.get("HC")
        oc = bool(p.get("OC")) and bool(s.get("OC")) and s.get("OC") != p.get("OC")
        dc = bool(p.get("DC")) and bool(s.get("DC")) and s.get("DC") != p.get("DC")
        out[t] = (hc or oc, hc or dc)
    return out


def _blend(season: int, through: int, by: str) -> pl.DataFrame:
    """One row per team: every metric blended. ``by="opponent"`` gives what
    each team's *opponents* recorded, i.e. what that offense faced."""
    reg = _reg()
    cur = _sums(reg.filter((pl.col("season") == season) & (pl.col("week") <= through)), by)
    prev_rows = reg.filter(pl.col("season") == season - 1)
    prev = _sums(prev_rows, by)
    league = _sums(prev_rows.with_columns(pl.lit("_").alias("_all")), "_all")

    lg = {m.key: (league[m.num][0] / league[m.den][0]) if (m.num in league.columns and m.den in league.columns
                                                          and league[m.den][0]) else None for m in METRICS}
    staff = _staff_changed(season)
    teams = sorted(set(cur["team"].to_list()) | set(prev["team"].to_list()))
    base = pl.DataFrame({"team": teams})
    c = base.join(cur, on="team", how="left").fill_null(0)
    p = base.join(prev, on="team", how="left")

    out = {"team": teams}
    for m in METRICS:
        if m.num not in c.columns or m.den not in c.columns:
            continue
        pr = prior_for(m.key)
        cur_v = c.select(_rate(m)).to_series().to_list()
        prev_v = p.select(_rate(m)).to_series().to_list() if m.num in p.columns else [None] * len(teams)
        g = c[f"_g_{m.key}"].to_list()
        vals = []
        for i, t in enumerate(teams):
            changed = staff.get(t, (False, False))[0 if m.side == "off" else 1]
            r = pr.regress_new_staff if changed else pr.regress
            pv = prev_v[i]
            if pv is not None and lg[m.key] is not None:
                pv = (1 - r) * pv + r * lg[m.key]
            cv = cur_v[i]
            if cv is None:
                vals.append(pv)
            elif pv is None:
                vals.append(cv)
            else:
                w = g[i] / (g[i] + pr.k)
                vals.append(w * cv + (1 - w) * pv)
        out[m.key] = vals
    frame = pl.DataFrame(out, schema_overrides={k: pl.Float64 for k in out if k != "team"})
    return frame.with_columns(
        games=pl.Series(c["games"].to_list(), dtype=pl.Int32),
        prior_games=pl.Series([x or 0 for x in p["games"].to_list()], dtype=pl.Int32),
        off_staff_changed=pl.Series([staff.get(t, (False, False))[0] for t in teams]),
        def_staff_changed=pl.Series([staff.get(t, (False, False))[1] for t in teams]),
    )


def prior_for(key: str) -> Prior:
    return PRIORS[group_of(key)]


@lru_cache(maxsize=64)
def _blended(season: int, through: int) -> pl.DataFrame:
    own = _blend(season, through, "team")
    # Only teams that exist this season: a relocated franchise's old code
    # would otherwise sit in the ranks as a 33rd team.
    live = set(_reg().filter(pl.col("season") == season)["team"].unique().to_list()) or \
        set(_reg().filter(pl.col("season") == season - 1)["team"].unique().to_list())
    own = own.filter(pl.col("team").is_in(list(live)))
    faced = _blend(season, through, "opponent")
    def_keys = [m.key for m in METRICS if m.side == "def" and m.key in faced.columns]
    faced = faced.select(["team"] + [pl.col(k).alias(f"faced_{k}") for k in def_keys])
    out = with_ranks(own.with_columns(pl.lit(season, dtype=pl.Int32).alias("season")))
    out = out.join(faced, on="team", how="left")
    return out.with_columns(
        pl.lit(season - 1, dtype=pl.Int32).alias("prior_season"),
        pl.lit(through, dtype=pl.Int32).alias("through_week"),
        pl.lit("blend").alias("basis"),
    ).sort("team")


def blended(season: int, before_week: int | None = None) -> pl.DataFrame:
    """Every team's blended numbers with league ranks, as of ``before_week``
    (all of ``season`` so far when omitted). Same columns as a row of
    :func:`coaches.season_ranks`, plus ``faced_<def metric>`` for what each
    offense has drawn from defenses, and the blend's own bookkeeping."""
    return _blended(season, through_week(season, before_week))


def blend_info(row: dict | None) -> dict | None:
    """What the page says about how a blended row was made."""
    if not row:
        return None
    g = row.get("games") or 0
    return {
        "season": row.get("season"), "prior_season": row.get("prior_season"), "games": g,
        "prior_games": row.get("prior_games"), "through_week": row.get("through_week"),
        "weights": {k: round(g / (g + p.k), 2) for k, p in PRIORS.items()},
        "off_staff_changed": row.get("off_staff_changed"), "def_staff_changed": row.get("def_staff_changed"),
    }


def season_in_progress(season: int) -> bool:
    """True while ``season`` has fewer than a full slate of regular-season
    games and the one before it is in the table to blend with."""
    reg = _reg()
    cur = reg.filter(pl.col("season") == season)
    if reg.filter(pl.col("season") == season - 1).is_empty():
        return False
    if cur.is_empty():
        return True
    return int(cur.group_by("team").len()["len"].max()) < 17


# --- head to head --------------------------------------------------------------

def _rank_among(value: float, league: list[float], descending: bool = True) -> int:
    return 1 + sum(1 for v in league if v is not None and (v > value if descending else v < value))


def matchup_view(off_row: dict | None, def_row: dict | None, table: pl.DataFrame) -> tuple[dict | None, dict | None, list[dict]]:
    """The offense and defense rows as they should read *against each other*.

    Returns adjusted copies of both rows plus the list of adjustments, each
    with the team's usual number, what the other side draws, and the
    projection. Ranks on projected numbers are where that number would sit
    among the 32 teams' usual ones, so "#3" still means third-heaviest box in
    the league.
    """
    if not off_row or not def_row:
        return off_row, def_row, []
    off, deff = dict(off_row), dict(def_row)
    shifts: list[dict] = []

    def league_of(key: str) -> list[float]:
        return [v for v in table[key].to_list() if v is not None] if key in table.columns else []

    def record(row: dict, key: str, base: float, pulled_by: float | None, pulled_rank: int | None, expected: float, who: str, side: str):
        vals = league_of(key)
        rank = _rank_among(expected, vals)
        n = len(vals)
        row[key] = expected
        row[f"{key}_rank"] = rank
        shifts.append({
            "key": key, "label": METRIC_BY_KEY[key].label, "fmt": METRIC_BY_KEY[key].fmt, "side": side,
            "usual": base, "usual_rank": def_row.get(f"{key}_rank") if side == "def" else off_row.get(f"{key}_rank"),
            "drawn": pulled_by, "drawn_rank": pulled_rank, "expected": expected, "expected_rank": rank,
            "n_teams": n, "by": who,
        })

    # Defense, bent by the offense it is facing.
    for key, beta in H2H_BETA.items():
        base, faced = def_row.get(key), off_row.get(f"faced_{key}")
        if base is None or faced is None:
            continue
        faced_all = [v for v in table[f"faced_{key}"].to_list() if v is not None]
        if not faced_all:
            continue
        lg = sum(faced_all) / len(faced_all)
        exp = base + beta * (faced - lg)
        if METRIC_BY_KEY[key].fmt == "pct":
            exp = min(max(exp, 0.0), 1.0)
        record(deff, key, base, faced, _rank_among(faced, faced_all), exp, off_row.get("team"), "def")

    # Offense, bent by the defense it is facing.
    for key, (dkey, beta) in H2H_OFF.items():
        base, allows = off_row.get(key), def_row.get(dkey)
        vals = league_of(dkey)
        if base is None or allows is None or not vals:
            continue
        lg = sum(vals) / len(vals)
        exp = min(max(base + beta * (allows - lg), 0.0), 1.0)
        record(off, key, base, allows, _rank_among(allows, vals), exp, def_row.get("team"), "off")

    for s in shifts:
        s["moved"] = (s["usual_rank"] or 0) - s["expected_rank"] if s["usual_rank"] else 0
    off["_h2h"] = [s for s in shifts if s["side"] == "off"]
    deff["_h2h"] = [s for s in shifts if s["side"] == "def"]
    return off, deff, shifts


# --- defense vs position -----------------------------------------------------------

#: DVP numbers are per-game box-score totals allowed: noisy like efficiency.
DVP_PRIOR = Prior(12, 0.6, 0.6)


@lru_cache(maxsize=64)
def _dvp_blend(season: int, position: str, through: int) -> pl.DataFrame:
    from .context import DVP_STATS, dvp_games
    g = dvp_games().filter((pl.col("pos") == position) & (pl.col("season_type") == "REG"))
    cur = g.filter((pl.col("season") == season) & (pl.col("week") <= through)).group_by("defense").agg(
        [pl.len().alias("games")] + [pl.col(c).mean().alias(c) for c in DVP_STATS])
    prev_g = g.filter(pl.col("season") == season - 1)
    prev = prev_g.group_by("defense").agg([pl.len().alias("prior_games")] + [pl.col(c).mean().alias(f"_p_{c}") for c in DVP_STATS])
    lg = {c: float(prev_g[c].mean()) if not prev_g.is_empty() else None for c in DVP_STATS}
    live = cur["defense"].to_list() or prev["defense"].to_list()
    t = pl.DataFrame({"defense": live}).join(cur, on="defense", how="left").join(prev, on="defense", how="left")
    t = t.with_columns(pl.col("games").fill_null(0), pl.col("prior_games").fill_null(0))
    w = pl.col("games") / (pl.col("games") + DVP_PRIOR.k)
    exprs = []
    for c in DVP_STATS:
        prior = pl.col(f"_p_{c}") if lg[c] is None else (1 - DVP_PRIOR.regress) * pl.col(f"_p_{c}") + DVP_PRIOR.regress * lg[c]
        exprs.append(pl.when(pl.col(c).is_null()).then(prior)
                     .when(prior.is_null()).then(pl.col(c))
                     .otherwise(w * pl.col(c) + (1 - w) * prior).alias(c))
    t = t.with_columns(exprs).drop([f"_p_{c}" for c in DVP_STATS])
    return t.with_columns([pl.col(c).rank(method="min", descending=True).alias(f"{c}_rank") for c in DVP_STATS]
                          + [pl.len().alias("n_teams"), pl.lit(season - 1).alias("prior_season"),
                             pl.lit(through).alias("through_week")]).sort("defense")


def dvp_blended(season: int, position: str, before_week: int | None = None) -> pl.DataFrame:
    """:func:`context.dvp_table`'s shape, blended the same way as the team
    numbers: this season's per-game allowed, weighed against last season's."""
    return _dvp_blend(season, position, through_week(season, before_week))


def clear() -> None:
    _blended.cache_clear()
    _dvp_blend.cache_clear()
