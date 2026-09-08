"""Session-cookie login behind one shared password. No middleware.

How it works
------------
``POST /api/auth/login`` with ``{"password": ...}`` sets an HttpOnly cookie
holding a signed expiry. :func:`require_session` is a FastAPI dependency that
verifies the cookie; attach it app-wide with
``FastAPI(dependencies=[Depends(require_session)])`` and every route is gated
except the ones this module exempts. Static mounts are not routes, so the built
UI bundle stays public; that is fine, because every byte of data is behind
``/api/*``.

Configuration (environment)
---------------------------
SITE_PASSWORD    required. Without it every gated request answers 503.
SESSION_SECRET   optional. Signs the cookie. Defaults to a hash of the
                 password, so changing the password logs everyone out.
SESSION_DAYS     optional, default 30.

What this is not
----------------
One password shared by everyone is a gate against strangers, not identity.
The failed-attempt throttle is per process and in memory; behind more than one
instance it is weaker than it looks. Adequate for a private dashboard over
HTTPS. Not adequate for anything you would mind leaking if the password leaked.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel

COOKIE = "nfl_session"
LOGIN_PATH = "/login"
EXEMPT_PREFIXES = ("/api/auth/", LOGIN_PATH, "/healthz")

MAX_FAILURES = 10          # per client address ...
FAILURE_WINDOW = 15 * 60   # ... within this many seconds -> 429

_LOGIN_HTML = Path(__file__).with_name("login.html")
_failures: dict[str, list[float]] = {}


# --- configuration ------------------------------------------------------------

def _password() -> str:
    return os.environ.get("SITE_PASSWORD", "")


def _secret() -> bytes:
    explicit = os.environ.get("SESSION_SECRET")
    if explicit:
        return explicit.encode("utf-8")
    return hashlib.sha256(b"nfl_predictor.session:" + _password().encode("utf-8")).digest()


def _session_seconds() -> int:
    return int(os.environ.get("SESSION_DAYS", "30")) * 86400


# --- token ---------------------------------------------------------------------

def _sign(exp: int) -> str:
    return hmac.new(_secret(), str(exp).encode("ascii"), hashlib.sha256).hexdigest()


def make_token(now: float | None = None) -> str:
    exp = int((now if now is not None else time.time()) + _session_seconds())
    return f"{exp}.{_sign(exp)}"


def token_is_valid(token: str | None, now: float | None = None) -> bool:
    if not token or "." not in token:
        return False
    exp_s, sig = token.split(".", 1)
    if not exp_s.isdigit():
        return False
    exp = int(exp_s)
    if not hmac.compare_digest(sig, _sign(exp)):
        return False
    return exp > (now if now is not None else time.time())


def is_authenticated(request: Request) -> bool:
    return token_is_valid(request.cookies.get(COOKIE))


# --- the gate -------------------------------------------------------------------

async def require_session(request: Request) -> None:
    """App-wide dependency. Exempts the auth routes so login is reachable."""
    if request.url.path.startswith(EXEMPT_PREFIXES):
        return
    if not _password():
        raise HTTPException(503, "Site password is not configured. Set SITE_PASSWORD.")
    if not is_authenticated(request):
        raise HTTPException(
            401, "Login required.", headers={"X-Login-Url": LOGIN_PATH}
        )


# --- throttle -------------------------------------------------------------------

def _client(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "?"


def _too_many_failures(key: str, now: float) -> bool:
    recent = [t for t in _failures.get(key, []) if now - t < FAILURE_WINDOW]
    _failures[key] = recent
    return len(recent) >= MAX_FAILURES


def _record_failure(key: str, now: float) -> None:
    _failures.setdefault(key, []).append(now)


def reset_throttle() -> None:
    """For tests."""
    _failures.clear()


# --- routes ---------------------------------------------------------------------

auth_router = APIRouter()


class LoginBody(BaseModel):
    password: str


def _secure(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    return proto == "https"


@auth_router.post("/api/auth/login", status_code=204)
async def login(body: LoginBody, request: Request, response: Response) -> Response:
    expected = _password()
    if not expected:
        raise HTTPException(503, "Site password is not configured. Set SITE_PASSWORD.")

    key, now = _client(request), time.time()
    if _too_many_failures(key, now):
        raise HTTPException(429, "Too many failed attempts. Try again later.")

    if not hmac.compare_digest(body.password.encode("utf-8"), expected.encode("utf-8")):
        _record_failure(key, now)
        raise HTTPException(401, "Wrong password.")

    response.set_cookie(
        COOKIE, make_token(now),
        max_age=_session_seconds(), httponly=True, samesite="lax",
        secure=_secure(request), path="/",
    )
    response.status_code = 204
    return response


@auth_router.post("/api/auth/logout", status_code=204)
async def logout(response: Response) -> Response:
    response.delete_cookie(COOKIE, path="/")
    response.status_code = 204
    return response


@auth_router.get("/api/auth/me")
async def me(request: Request) -> dict:
    return {"authenticated": bool(_password()) and is_authenticated(request)}


@auth_router.get(LOGIN_PATH, response_class=HTMLResponse)
async def login_page(request: Request):
    if is_authenticated(request):
        return RedirectResponse("/", status_code=303)
    return HTMLResponse(_LOGIN_HTML.read_text(encoding="utf-8"))
