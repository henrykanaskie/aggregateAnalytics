"""
Generate a self-contained HTML profile of everything in data/raw/.

The point is to make coverage cliffs and missingness visible before you build
features on top of columns that turn out to be 40% null or start in 2018.

    python nfl_profile.py            # writes nfl_data_profile.html
    python nfl_profile.py --open     # and opens it
"""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path

import polars as pl

from ingest import DATA_DIR, MANIFEST, REGISTRY, scan

OUT = Path("nfl_data_profile.html")

# Columns worth surfacing per dataset -- the ones you'd actually model on.
HIGHLIGHT = {
    "pbp": ["epa", "success", "wp", "cpoe", "pass_oe", "air_yards",
            "yards_after_catch", "vegas_wp", "qb_epa"],
    "schedules": ["spread_line", "total_line", "home_moneyline", "home_rest",
                  "away_rest", "temp", "wind", "roof", "surface", "div_game"],
    "snap_counts": ["offense_snaps", "offense_pct", "defense_pct"],
    "injuries": ["report_status", "practice_status", "report_primary_injury"],
    "pfr_pass": ["times_pressured", "times_pressured_pct", "times_blitzed"],
    "ngs_receiving": ["avg_separation", "avg_cushion",
                      "avg_yac_above_expectation"],
    "ngs_rushing": ["rush_yards_over_expected", "percent_attempts_gte_eight_defenders"],
    "ff_opportunity": ["total_fantasy_points_exp", "total_fantasy_points_diff"],
}


def season_counts(name: str) -> dict[int, int]:
    """Rows per season, read from Parquet metadata where possible."""
    d = DATA_DIR / name
    if not d.is_dir():
        return {}
    out = {}
    for f in sorted(d.glob("*.parquet")):
        yr = int(f.stem.split("_")[-1])
        out[yr] = pl.scan_parquet(f).select(pl.len()).collect().item()
    return out


def column_stats(name: str, cols: list[str]) -> list[dict]:
    """Null rate and a couple of summary numbers for highlighted columns."""
    try:
        # strict=False: the profiler reports *on* schema breaks rather than
        # modelling on them, so it wants the raw union that scan() otherwise
        # refuses. See nfl.data.UNSAFE_UNION.
        lf = scan(name, strict=False)
    except Exception:
        return []

    schema = lf.collect_schema()
    present = [c for c in cols if c in schema.names()]
    if not present:
        return []

    aggs = [pl.len().alias("_n")]
    for c in present:
        aggs.append(pl.col(c).null_count().alias(f"{c}__nulls"))
        if schema[c].is_numeric():
            aggs += [
                pl.col(c).mean().alias(f"{c}__mean"),
                pl.col(c).min().alias(f"{c}__min"),
                pl.col(c).max().alias(f"{c}__max"),
            ]
        else:
            aggs.append(pl.col(c).n_unique().alias(f"{c}__nuniq"))

    row = lf.select(aggs).collect().to_dicts()[0]
    n = row["_n"]

    out = []
    for c in present:
        nulls = row[f"{c}__nulls"] or 0
        rec = {
            "column": c,
            "dtype": str(schema[c]),
            "null_pct": round(100 * nulls / n, 1) if n else None,
        }
        if schema[c].is_numeric():
            for k in ("mean", "min", "max"):
                v = row.get(f"{c}__{k}")
                rec[k] = round(v, 3) if isinstance(v, float) else v
        else:
            rec["distinct"] = row.get(f"{c}__nuniq")
        out.append(rec)
    return out


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

CSS = """
:root{
  --paper:#F6F7F7; --ink:#14171A; --muted:#5D666E; --rule:#D6DADD;
  --panel:#FFFFFF; --steel:#2C5F7C;
  /* data ramp: only used to encode quantities, never decoration */
  --full:#1F6F4A; --part:#B8860B; --none:#E8EAEC;
}
*{box-sizing:border-box}
body{
  margin:0; background:var(--paper); color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
}
.wrap{max-width:1180px;margin:0 auto;padding:48px 28px 96px}
h1{font-size:30px;line-height:1.15;font-weight:640;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:19px;font-weight:620;letter-spacing:-.01em;margin:52px 0 6px;
   padding-bottom:7px;border-bottom:1.5px solid var(--ink)}
h3{font-size:14px;font-weight:640;margin:26px 0 8px}
p.lede{color:var(--muted);max-width:66ch;margin:0 0 8px}
.note{color:var(--muted);font-size:13.5px;max-width:70ch;margin:8px 0 18px}

/* coverage grid */
.cov{width:100%;border-collapse:collapse;font-size:12px}
.cov th{font-weight:500;color:var(--muted);text-align:center;padding:0 0 6px;
        font-variant-numeric:tabular-nums}
.cov th.lbl,.cov td.lbl{text-align:left;width:172px;padding-right:14px;
        font-size:13px;white-space:nowrap}
.cov td.lbl{font-weight:520}
.cell{width:15px;height:19px;border-radius:2px;background:var(--none)}
.cov td{padding:1.5px}
.rowsub{font-size:11px;color:var(--muted);padding-left:8px;white-space:nowrap;
        font-variant-numeric:tabular-nums}

/* tables */
table.dt{width:100%;border-collapse:collapse;font-size:13px;margin:4px 0 8px}
table.dt th{text-align:left;font-weight:560;color:var(--muted);
  border-bottom:1px solid var(--ink);padding:6px 10px 6px 0;font-size:12px}
table.dt td{border-bottom:1px solid var(--rule);padding:6px 10px 6px 0;
  vertical-align:top}
.num{font-variant-numeric:tabular-nums;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.col{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.dtype{color:var(--muted);font-size:11.5px}

/* null bar encodes missingness */
.nullbar{display:inline-block;height:8px;border-radius:1px;background:var(--part);
  vertical-align:middle;margin-right:7px;min-width:1px}
.ok{color:var(--muted)}
.warn{color:#8A5A00;font-weight:560}
.bad{color:#9B2C2C;font-weight:600}

details{background:var(--panel);border:1px solid var(--rule);border-radius:5px;
  padding:12px 16px;margin:8px 0}
summary{cursor:pointer;font-weight:560;font-size:14px}
summary::marker{color:var(--muted)}
.legend{display:flex;gap:20px;align-items:center;color:var(--muted);
  font-size:12.5px;margin:10px 0 20px}
.sw{display:inline-block;width:12px;height:12px;border-radius:2px;
  margin-right:6px;vertical-align:-2px}
.kpi{display:flex;gap:44px;margin:22px 0 4px;flex-wrap:wrap}
.kpi div span{display:block}
.kpi .v{font-size:27px;font-weight:640;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums}
.kpi .k{font-size:12.5px;color:var(--muted)}
@media (max-width:760px){.cov{font-size:10px}.cell{width:9px}
  .cov th.lbl,.cov td.lbl{width:120px;font-size:11.5px}}
"""


def coverage_table(counts: dict[str, dict[int, int]], lo: int, hi: int) -> str:
    years = list(range(lo, hi + 1))
    head = "".join(
        f"<th>{str(y)[2:]}</th>" for y in years
    )
    rows = []
    for name, cc in counts.items():
        if not cc:
            continue
        peak = max(cc.values())
        cells = []
        for y in years:
            n = cc.get(y, 0)
            if n == 0:
                cells.append('<td><div class="cell"></div></td>')
            else:
                # opacity encodes rows-that-season relative to peak
                a = 0.32 + 0.68 * (n / peak)
                cells.append(
                    f'<td><div class="cell" style="background:var(--full);'
                    f'opacity:{a:.2f}" title="{name} {y}: {n:,} rows"></div></td>'
                )
        total = sum(cc.values())
        rows.append(
            f'<tr><td class="lbl">{html.escape(name)}</td>{"".join(cells)}'
            f'<td class="rowsub">{total:,}</td></tr>'
        )
    return (
        f'<table class="cov"><thead><tr><th class="lbl"></th>{head}'
        f'<th class="rowsub">rows</th></tr></thead><tbody>'
        f'{"".join(rows)}</tbody></table>'
    )


def null_cell(pct: float | None) -> str:
    if pct is None:
        return "<span class='ok'>—</span>"
    cls = "ok" if pct < 5 else ("warn" if pct < 40 else "bad")
    w = max(1, round(pct * 0.72))
    return (f"<span class='nullbar' style='width:{w}px'></span>"
            f"<span class='{cls} num'>{pct}%</span>")


def render(manifest: dict, counts: dict, colstats: dict,
           lo: int, hi: int) -> str:
    ok = [k for k, v in manifest.items() if v.get("status") == "ok"]
    total_mb = sum(v.get("mb", 0) for v in manifest.values())
    total_rows = sum(sum(c.values()) for c in counts.values())

    parts = [f"<!doctype html><meta charset='utf-8'>"
             f"<meta name='viewport' content='width=device-width,initial-scale=1'>"
             f"<title>NFL data profile</title><style>{CSS}</style>"
             f"<div class='wrap'>"]

    parts.append(
        "<h1>What's actually in the dataset</h1>"
        "<p class='lede'>Generated from the local Parquet cache. Read the "
        "coverage grid first: the left edge of each row is the real start of "
        "your usable history for that feature, whatever the play-by-play "
        "goes back to.</p>"
        f"<div class='kpi'>"
        f"<div><span class='v'>{len(ok)}</span><span class='k'>datasets</span></div>"
        f"<div><span class='v'>{total_rows/1e6:.1f}M</span><span class='k'>season-partitioned rows</span></div>"
        f"<div><span class='v'>{total_mb:.0f}</span><span class='k'>MB on disk</span></div>"
        f"<div><span class='v'>{lo}–{hi}</span><span class='k'>seasons</span></div>"
        f"</div>"
    )

    parts.append("<h2>Coverage by season</h2>")
    parts.append("<div class='legend'>"
                 "<span><i class='sw' style='background:var(--full)'></i>"
                 "present — shade shows rows relative to that dataset's peak</span>"
                 "<span><i class='sw' style='background:var(--none)'></i>"
                 "no data</span></div>")
    parts.append(coverage_table(counts, lo, hi))
    parts.append(
        "<p class='note'>Every ragged left edge is a constraint on your model. "
        "Pressure rate and charting data are tier-1 features with a fraction of "
        "the history that play-by-play has, so any model using them is trained "
        "on a much smaller sample than the row count suggests.</p>")

    parts.append("<h2>Key columns and missingness</h2>")
    parts.append("<p class='note'>Null rates are computed across all cached "
                 "seasons, so a column added mid-history will show high "
                 "missingness even if it is complete in recent years. Check "
                 "the coverage grid before concluding a column is unusable.</p>")

    for name, stats in colstats.items():
        if not stats:
            continue
        note = REGISTRY[name].note
        rows = []
        for s in stats:
            extra = ""
            if "mean" in s:
                extra = (f"<td class='num'>{s.get('mean')}</td>"
                         f"<td class='num'>{s.get('min')}</td>"
                         f"<td class='num'>{s.get('max')}</td>")
            else:
                extra = (f"<td class='num'>{s.get('distinct','')}</td>"
                         f"<td></td><td></td>")
            rows.append(
                f"<tr><td class='col'>{html.escape(s['column'])}"
                f"<div class='dtype'>{html.escape(s['dtype'])}</div></td>"
                f"<td>{null_cell(s['null_pct'])}</td>{extra}</tr>")
        parts.append(
            f"<details><summary>{html.escape(name)}</summary>"
            f"<p class='note'>{html.escape(note)}</p>"
            f"<table class='dt'><thead><tr><th>column</th><th>null</th>"
            f"<th>mean / distinct</th><th>min</th><th>max</th></tr></thead>"
            f"<tbody>{''.join(rows)}</tbody></table></details>")

    parts.append("</div>")
    return "".join(parts)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()

    manifest = json.loads(MANIFEST.read_text())

    counts, lo, hi = {}, 9999, 0
    for name, v in manifest.items():
        if v.get("status") != "ok":
            continue
        cc = season_counts(name)
        if cc:
            counts[name] = cc
            lo, hi = min(lo, min(cc)), max(hi, max(cc))

    colstats = {}
    for name, cols in HIGHLIGHT.items():
        if name in counts or (DATA_DIR / f"{name}.parquet").exists():
            print(f"  profiling {name} ...", flush=True)
            colstats[name] = column_stats(name, cols)

    Path(args.out).write_text(render(manifest, counts, colstats, lo, hi))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()