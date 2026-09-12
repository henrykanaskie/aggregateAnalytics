"""One shared password in front of the whole site. No accounts, no middleware.

How it works
------------
``GET /password`` is the box you type the password into. ``POST
/api/auth/login`` with ``{"password": ...}`` checks it and sets an HttpOnly
cookie holding a signed expiry, so the browser is not asked again for
``SESSION_DAYS``. :func:`require_session` is a FastAPI dependency that verifies
the cookie; attach it app-wide with
``FastAPI(dependencies=[Depends(require_session)])`` and every route is gated
except the ones this module exempts.

A stranger sees nothing but the password box: a browser navigation without a
valid cookie is redirected to ``/password``; a ``fetch`` from the app gets a
401 with an ``X-Login-Url`` header. Serve ``index.html`` through a *route* so
that redirect covers it; a ``StaticFiles`` mount is not a route and is not
gated, which is fine for hashed assets and wrong for the page itself.

Two roles
---------
A cookie carries one of ``view`` or ``admin``, signed alongside the expiry.
``require_session`` accepts either; ``require_admin`` accepts only the second
and guards the routes that write to disk or spend Odds API credits. Which role
a login gets is decided by which password matched.

Configuration (environment)
---------------------------
SITE_PASSWORD    required. Without it every gated request answers 503.
ADMIN_PASSWORD   optional, and required before anyone but you has an account.
                 Unset, or equal to SITE_PASSWORD, means no admin session can
                 be issued and the write routes answer 503 for everybody.
SESSION_SECRET   optional. Signs the cookie. Defaults to a hash of both
                 passwords, so changing either logs everyone out.
SESSION_DAYS     optional, default 30.

What this is not
----------------
One password shared by everyone is a gate against strangers, not identity: the
admin role says which password was typed, never which person typed it. The
failed-attempt throttle is per process and in memory; behind more than one
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
LOGIN_PATH = "/password"
EXEMPT_PREFIXES = ("/api/auth/", LOGIN_PATH, "/healthz", "/api/health")

#: The two things a session can be. A viewer reads; an admin also spends money.
VIEW, ADMIN = "view", "admin"

MAX_FAILURES = 10          # per client address ...
FAILURE_WINDOW = 15 * 60   # ... within this many seconds -> 429

_LOGIN_HTML = Path(__file__).with_name("login.html")
_failures: dict[str, list[float]] = {}


# --- configuration ------------------------------------------------------------

def _password() -> str:
    return os.environ.get("SITE_PASSWORD", "")


def _admin_password() -> str:
    return os.environ.get("ADMIN_PASSWORD", "")


def admin_unavailable() -> str | None:
    """``None`` when admin sessions can be issued, else why they cannot.

    Both refusals are deliberate, and the second one is the mistake worth
    catching: the same string in both variables reads as "I configured admin"
    and means "every visitor is an admin".
    """
    site, admin = _password(), _admin_password()
    if not admin:
        return "ADMIN_PASSWORD is not set, so the endpoints that write or spend are closed to everyone."
    if hmac.compare_digest(admin.encode("utf-8"), site.encode("utf-8")):
        return "ADMIN_PASSWORD and SITE_PASSWORD are the same, which would make every visitor an admin."
    return None


def _secret() -> bytes:
    explicit = os.environ.get("SESSION_SECRET")
    if explicit:
        return explicit.encode("utf-8")
    # The prefix below is not a name, it is the salt this key is derived from,
    # and it keeps the project's old one on purpose. Change it and every cookie
    # ever signed stops verifying, so everyone holding a valid session is
    # bounced to the password box the next time they load a page. It is never
    # displayed anywhere. Renaming it buys nothing and costs that.
    #
    # The admin password is mixed in, and this is the load-bearing part of the
    # role gate rather than a flourish. Every viewer knows SITE_PASSWORD: it is
    # how they got in. A key derived from that alone is a key they can compute,
    # and anyone who can compute the key can sign themselves an `admin` cookie
    # and spend the Odds API credits. Mixing in a secret they do not hold is
    # what makes the role in the token mean anything.
    #
    # The cost is one extra way to log everyone out: setting or rotating
    # ADMIN_PASSWORD changes the key, exactly as rotating SITE_PASSWORD does.
    # That is the right trade, and it is the only way to revoke a live admin
    # cookie without an explicit SESSION_SECRET.
    return hashlib.sha256(b"nfl_predictor.session:" + _password().encode("utf-8")
                          + b":" + _admin_password().encode("utf-8")).digest()


def _session_seconds() -> int:
    return int(os.environ.get("SESSION_DAYS", "30")) * 86400


# --- token ---------------------------------------------------------------------

def _sign(payload: str) -> str:
    return hmac.new(_secret(), payload.encode("ascii"), hashlib.sha256).hexdigest()


def make_token(now: float | None = None, role: str = VIEW) -> str:
    exp = int((now if now is not None else time.time()) + _session_seconds())
    return f"{exp}.{role}.{_sign(f'{exp}.{role}')}"


def token_role(token: str | None, now: float | None = None) -> str | None:
    """The role a cookie carries, or ``None`` if it is absent, forged or spent.

    One function, so "is this session valid" and "what may it do" can never
    disagree about the same string.
    """
    if not token:
        return None
    parts = token.split(".")
    if len(parts) == 3:
        exp_s, role, sig = parts
        if role not in (VIEW, ADMIN):
            return None
        payload = f"{exp_s}.{role}"
    elif len(parts) == 2:
        # Minted before roles existed, and signed over the expiry alone. Worth
        # honouring so a deploy does not bounce everyone already signed in; it
        # reads as view-only, which is everything it could do when it was made.
        exp_s, sig = parts
        payload, role = exp_s, VIEW
    else:
        return None
    if not exp_s.isdigit():
        return None
    if not hmac.compare_digest(sig, _sign(payload)):
        return None
    return role if int(exp_s) > (now if now is not None else time.time()) else None


def token_is_valid(token: str | None, now: float | None = None) -> bool:
    return token_role(token, now) is not None


def is_authenticated(request: Request) -> bool:
    return token_is_valid(request.cookies.get(COOKIE))


def is_admin(request: Request) -> bool:
    """A valid admin cookie *and* admin still configured, so clearing
    ADMIN_PASSWORD revokes the sessions it issued rather than leaving them."""
    return admin_unavailable() is None and token_role(request.cookies.get(COOKIE)) == ADMIN


# --- the gate -------------------------------------------------------------------

async def require_session(request: Request) -> None:
    """App-wide dependency. Exempts the auth routes so login is reachable."""
    if request.url.path.startswith(EXEMPT_PREFIXES):
        return
    if not _password():
        raise HTTPException(503, "Site password is not configured. Set SITE_PASSWORD.")
    if not is_authenticated(request):
        if request.method == "GET" and "text/html" in request.headers.get("accept", ""):
            # A person in a browser: send them to the password box, not to
            # a JSON error. HTTPException carries the status and headers
            # straight through, so no exception handler needs registering.
            raise HTTPException(303, headers={"Location": LOGIN_PATH})
        raise HTTPException(401, "Password required.", headers={"X-Login-Url": LOGIN_PATH})


async def require_admin(request: Request) -> None:
    """Gate for the handful of routes that write to disk or spend money.

    Deliberately a second dependency rather than a stricter `require_session`:
    a viewer holds a perfectly valid session and must still be refused here.
    ``POST /api/odds/pull`` buys Odds API credits, so the cost of getting this
    one wrong arrives as a bill rather than as a leak.
    """
    why = admin_unavailable()
    if why:
        raise HTTPException(503, why)
    if not is_admin(request):
        raise HTTPException(403, "This needs the admin password. Sign out, then sign in with it.")


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

    # Admin first, so that a deployment which has (wrongly) set both variables
    # to the same string still hands out the lesser role: `admin_unavailable`
    # refuses that configuration, the `elif` catches the password, and nobody
    # is quietly promoted.
    supplied = body.password.encode("utf-8")
    admin = _admin_password()
    if admin and admin_unavailable() is None and hmac.compare_digest(supplied, admin.encode("utf-8")):
        role = ADMIN
    elif hmac.compare_digest(supplied, expected.encode("utf-8")):
        role = VIEW
    else:
        _record_failure(key, now)
        raise HTTPException(401, "Wrong password.")

    response.set_cookie(
        COOKIE, make_token(now, role),
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
    ok = bool(_password()) and is_authenticated(request)
    # `admin_note` is why the write controls are missing, for a signed-in
    # maintainer looking at a page that used to have buttons on it. Only ever
    # sent to a valid session: a stranger learns nothing about the setup.
    return {"authenticated": ok, "admin": ok and is_admin(request),
            "admin_note": (admin_unavailable() if ok else None)}


@auth_router.get(LOGIN_PATH, response_class=HTMLResponse)
async def login_page(request: Request):
    if is_authenticated(request):
        return RedirectResponse("/", status_code=303)
    return HTMLResponse(_LOGIN_HTML.read_text(encoding="utf-8"))
