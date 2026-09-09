"""Stand-in for ``dashboard.api.app`` until the real dashboard is pushed.

Same shape as the real thing: a FastAPI app with the gate applied app-wide,
data behind ``/api/*``, and a single-page UI served at ``/``. The UI here is
one inline page that renders the latest week from ``track_record/`` so the
login flow can be exercised end to end.

    SITE_PASSWORD=... uvicorn webauth.mock_app:app --port 8017
"""

from __future__ import annotations

import csv
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.responses import HTMLResponse

from webauth import auth_router, require_session
from data_handling import sync_odds

REPO_ROOT = Path(__file__).resolve().parent.parent
TRACK_CSV = REPO_ROOT / "track_record" / "predictions.csv"

EXAMPLE_ROWS = [
    {"game_id": "2026_01_EXAMPLE_A", "season": "2026", "week": "1", "pred_margin": "3.6",
     "pred_win_prob": "0.607", "market_spread": "3.5", "model_version": "elo-v1",
     "logged_at": "2026-09-08 22:00:00"},
    {"game_id": "2026_01_EXAMPLE_B", "season": "2026", "week": "1", "pred_margin": "-1.2",
     "pred_win_prob": "0.464", "market_spread": "-2.5", "model_version": "elo-v1",
     "logged_at": "2026-09-08 22:00:00"},
]


def load_rows(path: Path = TRACK_CSV) -> tuple[list[dict], bool]:
    if not path.exists():
        return list(EXAMPLE_ROWS), True
    with path.open(newline="") as f:
        return list(csv.DictReader(f)), False


def latest_week(rows: list[dict]) -> list[dict]:
    """Most recent (season, week); the earliest ``logged_at`` per game wins."""
    if not rows:
        return []
    key = max((int(r["season"]), int(r["week"])) for r in rows)
    first: dict[str, dict] = {}
    for r in sorted(rows, key=lambda r: r["logged_at"]):
        if (int(r["season"]), int(r["week"])) == key:
            first.setdefault(r["game_id"], r)
    return list(first.values())


INDEX_HTML = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nfl_predictor</title>
<style>
  :root { color-scheme: light dark; --ink: #1c2230; --muted: #6b7280; --rule: #d9d7cf;
          --ground: #f6f5f1; --accent: #1f5c3a; --warn: #8a5a00; --warn-bg: #fff4d6; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e8e6df; --muted: #9a9890; --rule: #33373f; --ground: #15181e;
            --accent: #6fbf8e; --warn: #f0c060; --warn-bg: #3a2f10; }
  }
  body { margin: 0; background: var(--ground); color: var(--ink);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 56rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
  h1 { font-size: 1.5rem; margin: 0; }
  .sub { color: var(--muted); margin: .25rem 0 1.25rem; }
  .note { background: var(--warn-bg); color: var(--warn); padding: .6rem .9rem;
          border-radius: 4px; margin: 0 0 1.25rem; }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--rule); white-space: nowrap; }
  th { font-size: .78rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .num { text-align: right; }
  button { font: inherit; background: none; border: 1px solid var(--rule); color: var(--muted);
           border-radius: 4px; padding: .3rem .7rem; cursor: pointer; }
  footer { margin-top: 2rem; color: var(--muted); font-size: .85rem; }
</style>
<main>
  <header><h1 id="title">Predictions</h1><button id="out">Sign out</button></header>
  <p class="sub" id="sub">Loading…</p>
  <p class="note" id="note" hidden></p>
  <div class="wrap"><table>
    <thead><tr><th>Game</th><th class="num">Model margin</th><th class="num">Home win</th>
      <th class="num">Market</th><th class="num">Edge</th><th>Version</th><th>Logged (UTC)</th></tr></thead>
    <tbody id="rows"></tbody>
  </table></div>
  <footer>This model does not beat the closing line: on 2020-2025 its mean absolute error trails
    the market by 0.41 points. The value is the timestamped record, not the edge.</footer>
</main>
<script>
  function s(n, d) { return (n >= 0 ? '+' : '') + n.toFixed(d); }
  async function load() {
    var r = await fetch('/api/board');
    if (r.status === 401) { window.location.replace('/password'); return; }
    var b = await r.json();
    document.getElementById('title').textContent = 'Week ' + b.week + ' predictions';
    document.getElementById('sub').textContent = b.rows.length + ' games, ' +
      (b.example ? 'example data' : 'from the tracked log') + '. Positive margin favours the home team.';
    var note = document.getElementById('note');
    note.hidden = !b.example;
    note.textContent = 'Example rows. Run `python -m model.predict --export` and commit track_record/predictions.csv.';
    document.getElementById('rows').innerHTML = b.rows.map(function (x) {
      return '<tr><td>' + x.game_id + '</td><td class="num">' + s(x.pred_margin, 1) +
        '</td><td class="num">' + Math.round(100 * x.pred_win_prob) + '%</td><td class="num">' +
        s(x.market_spread, 1) + '</td><td class="num">' + s(x.pred_margin - x.market_spread, 1) +
        '</td><td>' + x.model_version + '</td><td>' + x.logged_at + '</td></tr>';
    }).join('');
  }
  document.getElementById('out').addEventListener('click', async function () {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.replace('/password');
  });
  load();
</script>
"""


def create_app() -> FastAPI:
    # The one line that gates everything. `/` below is a route, so a stranger
    # is redirected to the password box before seeing any of the page.
    app = FastAPI(title="nfl_predictor (placeholder)", dependencies=[Depends(require_session)])
    app.include_router(auth_router)
    sync_odds.install(app)          # data/odds from GitHub, on wake and every 30 min

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"ok": True, "log_present": TRACK_CSV.exists(), "odds": sync_odds.STATE}

    @app.get("/api/board")
    async def board() -> dict:
        rows, example = load_rows()
        slate = latest_week(rows)
        typed = [
            {**r, "pred_margin": float(r["pred_margin"]),
             "pred_win_prob": float(r["pred_win_prob"]),
             "market_spread": float(r["market_spread"] or 0.0)}
            for r in slate
        ]
        return {"week": slate[0]["week"] if slate else None, "rows": typed, "example": example}

    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    async def index() -> HTMLResponse:
        return HTMLResponse(INDEX_HTML)

    return app


app = create_app()
