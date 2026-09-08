# Track record

`predictions.csv` is the git-tracked copy of `data/predictions.parquet`,
re-exported in full every time a slate is logged. It is append-only by
convention: a row is never edited or removed, and a game logged twice is
scored on its **earliest** `logged_at`.

Commit this file before kickoff. The commit is the timestamp a stranger can
check; the parquet on one laptop is not.

Regenerate without predicting anything:

    python -m model.predict --export
