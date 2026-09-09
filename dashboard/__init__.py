"""Props research dashboard.

A separate product from the prediction model: a place to look at player game
logs against sportsbook lines by hand. It reads the same parquet cache through
``nfl.data.scan`` and never imports from ``model/``, so the two can evolve
independently. The only coupling is the predictions slot in the UI, which reads
``data/predictions.parquet`` (game level) and, when it exists,
``data/derived/prop_predictions.parquet`` (player level).

Layout::

    dashboard.config     paths, env, current season
    dashboard.stats      stat catalog, per-player game logs, player index
    dashboard.odds       sportsbook providers, snapshot store, line analysis
    dashboard.api        FastAPI app (serves the built web UI too)
    dashboard/web        React + Vite frontend
"""
