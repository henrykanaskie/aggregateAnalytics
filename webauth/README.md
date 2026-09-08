# webauth: the site password

A login page and a session cookie, inside the FastAPI app. No host
middleware, no proxy config. One shared password from an environment
variable.

## Try it now (placeholder UI)

    pip install -e ".[dev,web]"
    SITE_PASSWORD=hut-hut uvicorn webauth.mock_app:app --port 8017

Open http://127.0.0.1:8017. You land on `/login`; sign in; you see the latest
week from `track_record/predictions.csv` (or labelled example rows if it has
not been exported). "Sign out" clears the cookie.

## Migrating to `dashboard/`

Three edits, none of them in the data layer.

**1. `dashboard/api/app.py`**, where the app is constructed:

    from fastapi import Depends, FastAPI
    from webauth import auth_router, require_session

    app = FastAPI(dependencies=[Depends(require_session)])   # gates every route
    app.include_router(auth_router)                          # /login, /api/auth/*

If the UI bundle is mounted with `StaticFiles`, leave it. Mounts are not
routes, so the bundle stays public and every `/api/*` route is gated. If the
SPA's `index.html` is served by a catch-all *route*, that is gated too, which
is fine: an unauthenticated visitor gets a 401 and the fetch wrapper below
sends them to `/login`.

**2. The frontend's fetch wrapper** (wherever `/api/` calls are made): on a
401, go to the login page.

    if (res.status === 401) { window.location.replace('/login'); return; }

The login page is served by the router, so the SPA does not need a Login
route of its own. Add one later if you want it inside the app shell.

**3. Somewhere in Settings**, a sign-out control:

    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.replace('/login');

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

The dashboard keeps odds snapshots under `data/odds/` and derived tables
under `data/derived/`, pulls from ESPN on a schedule, and rebuilds team
tendencies in about 45 seconds. That is a long-running process with a disk,
which rules out request-scoped function hosts (Vercel, Netlify) for this
app. Use a host that runs a process and mounts a volume: Render, Fly.io or
Railway. Start command on any of them:

    uvicorn dashboard.api.app:app --host 0.0.0.0 --port $PORT

The cookie is marked `Secure` whenever the request arrives over HTTPS
(directly or via `X-Forwarded-Proto`), which all three hosts set.

## What it is and is not

A gate against strangers. Everyone shares one password, there is no
per-person identity, and the failed-attempt throttle (10 per 15 minutes per
address) is in-process memory. Fine for a private dashboard over HTTPS. Not
fine for anything you would mind leaking if the password leaked.
