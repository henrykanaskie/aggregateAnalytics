"""The league-import routes. Every one reads from another site on the person's
behalf and hands the result straight back; nothing about their league is
kept on this server.

    GET /api/leagues/status                  which imports this host can offer
    GET /api/leagues/sleeper?username=...    a Sleeper user's teams
    GET /api/leagues/espn?league=...         every team in a public ESPN league
    GET /api/leagues/yahoo/start             off to Yahoo to sign in
    GET /api/leagues/yahoo/callback          back from Yahoo; hands the result to the page

Yahoo's result cannot come back as a fetch response, because the person
arrives at the callback by being redirected, not by the page asking. So the
callback answers with a tiny page that puts the result in this tab's
sessionStorage and moves on to /fantasy, which picks it up.
"""

from __future__ import annotations

import hmac
import json
import os
import secrets

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from ..config import CURRENT_SEASON
from . import espn, sleeper, yahoo
from .common import LeagueError

router = APIRouter(prefix="/api/leagues")
STATE_COOKIE = "yahoo_oauth_state"
#: Where the page looks for a Yahoo import that just came back.
HANDOFF_KEY = "league.import"


def _error(e: LeagueError) -> JSONResponse:
    return JSONResponse({"detail": str(e)}, status_code=e.status)


@router.get("/status")
def status():
    return {"sleeper": True, "espn": True, "yahoo": yahoo.credentials() is not None}


@router.get("/sleeper")
def sleeper_route(username: str, season: int = CURRENT_SEASON):
    try:
        return sleeper.import_user(username, season)
    except LeagueError as e:
        return _error(e)


@router.get("/espn")
def espn_route(league: str, season: int = CURRENT_SEASON):
    try:
        return espn.import_league(league, season)
    except LeagueError as e:
        return _error(e)


def _redirect_uri(request: Request) -> str:
    """Yahoo compares this, character for character, with the one registered
    for the app. Behind Render's proxy the request itself looks like plain
    http, so the forwarded scheme is used, or YAHOO_REDIRECT_URI outright."""
    if os.environ.get("YAHOO_REDIRECT_URI"):
        return os.environ["YAHOO_REDIRECT_URI"]
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    return f"{scheme}://{request.url.netloc}/api/leagues/yahoo/callback"


@router.get("/yahoo/start")
def yahoo_start(request: Request):
    # A random value that must come back unchanged from Yahoo, kept in a
    # short-lived cookie: proof the callback answers a sign-in this browser
    # started, not a link someone else crafted (CSRF).
    state = secrets.token_urlsafe(24)
    try:
        url = yahoo.authorize_url(_redirect_uri(request), state)
    except LeagueError as e:
        return _error(e)
    resp = RedirectResponse(url, status_code=302)
    resp.set_cookie(STATE_COOKIE, state, max_age=600, httponly=True, samesite="lax",
                    secure=_redirect_uri(request).startswith("https"), path="/api/leagues/yahoo")
    return resp


def _handoff(payload: dict) -> HTMLResponse:
    # json.dumps does not escape "<", so "</script>" inside a team name could
    # end the script early; < keeps it inert.
    data = json.dumps(json.dumps(payload)).replace("<", "\\u003c")
    html = (f"<!doctype html><meta charset=utf-8><title>Importing…</title><script>"
            f"sessionStorage.setItem({json.dumps(HANDOFF_KEY)}, {data});"
            f"location.replace('/fantasy?import=yahoo');</script>")
    resp = HTMLResponse(html, headers={"Cache-Control": "no-store"})
    resp.delete_cookie(STATE_COOKIE, path="/api/leagues/yahoo")
    return resp


@router.get("/yahoo/callback")
def yahoo_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
    expected = request.cookies.get(STATE_COOKIE)
    if error:
        return _handoff({"error": "Yahoo sign-in was cancelled." if error == "access_denied" else f"Yahoo said: {error}"})
    if not code or not state or not expected or not hmac.compare_digest(state, expected):
        return _handoff({"error": "That Yahoo sign-in had expired or did not start here. Start the import again."})
    try:
        token = yahoo.exchange(code, _redirect_uri(request))
        return _handoff(yahoo.import_with_token(token))
    except LeagueError as e:
        return _handoff({"error": str(e)})
