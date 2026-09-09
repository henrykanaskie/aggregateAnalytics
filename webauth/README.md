# webauth: the site password

One password. Anyone you give it to can open the site; anyone else sees a
password box and nothing behind it. No accounts, no usernames, no host
middleware. The password comes from an environment variable.

## Where it is wired

`dashboard/api/app.py` constructs the app with the gate and includes the
auth router before any route, so `/password` wins over the SPA catch-all.
`dashboard/web/src/api.ts` sends a 401 to the password box, and the Settings
page has "Sign out". Nothing else in the dashboard knows the gate exists.

## Run it locally

    pip install -e ".[dev,dashboard]"
    (cd dashboard/web && npm ci && npm run build)
    SITE_PASSWORD=hut-hut uvicorn dashboard.api.app:app --port 8017

Open http://127.0.0.1:8017: you are sent to `/password`; enter it; the
dashboard loads. Settings has "Sign out", which clears the cookie.

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
