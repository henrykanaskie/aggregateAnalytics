# webauth: the site password

One password. Anyone you give it to can open the site; anyone else sees a
password box and nothing behind it. No accounts, no usernames, no host
middleware. The password comes from an environment variable.

## Try it now (placeholder UI)

    pip install -e ".[dev,web]"
    SITE_PASSWORD=hut-hut uvicorn webauth.mock_app:app --port 8017

Open http://127.0.0.1:8017. You are sent to `/password`; enter it; you see the
latest week from `track_record/predictions.csv` (or labelled example rows if it
has not been exported). "Sign out" clears the cookie so the box comes back.

## Migrating to `dashboard/`

Three edits, none of them in the data layer.

**1. `dashboard/api/app.py`**, where the app is constructed:

    from fastapi import Depends, FastAPI
    from webauth import auth_router, require_session

    app = FastAPI(dependencies=[Depends(require_session)])   # gates every route
    app.include_router(auth_router)                          # /password, /api/auth/*

Then make sure the page itself goes through a route, not only a mount. A
`StaticFiles` mount is not a route and is never gated. Keep the mount for
the hashed assets and serve `index.html` from a catch-all:

    app.mount("/assets", StaticFiles(directory="dashboard/ui/dist/assets"))

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        return FileResponse("dashboard/ui/dist/index.html")

Now a stranger who opens any URL is redirected to `/password` before a byte
of the app is served. (If you had `StaticFiles(..., html=True)` mounted at
`/`, this replaces it.)

**2. The frontend's fetch wrapper** (wherever `/api/` calls are made): on a
401, go to the password box. This covers a cookie that expired mid-session.

    if (res.status === 401) { window.location.replace('/password'); return; }

**3. Somewhere in Settings**, a way to forget the password on this browser:

    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.replace('/password');

**4. Odds sync**, next to the password lines, so the deployed app picks up
snapshots the lines workflow commits without a rebuild:

    from data_handling import sync_odds
    sync_odds.install(app)

Then delete `webauth/mock_app.py`; nothing else imports it.

## Environment

| variable | required | meaning |
|---|---|---|
| `SITE_PASSWORD` | yes | the password. Unset means every gated request answers 503. |
| `SESSION_SECRET` | no | signs the cookie. Defaults to a hash of the password, so rotating the password signs everyone out. |
| `SESSION_DAYS` | no | cookie lifetime, default 30. |

Set them in the host's dashboard, never in the repo. `.env` is already
ignored by the dashboard's own config.

## Hosting

Render's free web service, via `render.yaml`. The full pipeline (scheduled
pulls in GitHub Actions, the cache on a Release, the in-app odds sync) is in
[DEPLOY.md](../DEPLOY.md). The cookie is marked `Secure` whenever the request
arrives over HTTPS, directly or via `X-Forwarded-Proto`, which Render sets.

## What it is and is not

A gate against strangers. Everyone shares one password, there is no
per-person identity, and the failed-attempt throttle (10 per 15 minutes per
address) is in-process memory. Fine for a private dashboard over HTTPS. Not
fine for anything you would mind leaking if the password leaked.
