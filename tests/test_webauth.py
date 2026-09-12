"""The site password gate, on the dashboard app and on a minimal app.

The minimal app pins the dependency's own behaviour without needing the
parquet cache; the dashboard checks prove it is actually wired in there.
"""

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from webauth import auth, auth_router, require_admin, require_session

PW = "hut-hut"
ADMIN_PW = "the-coach"


def _minimal() -> FastAPI:
    app = FastAPI(dependencies=[Depends(require_session)])
    app.include_router(auth_router)

    @app.get("/api/thing")
    async def thing() -> dict:
        return {"secret": 42}

    @app.post("/api/write", dependencies=[Depends(require_admin)])
    async def write() -> dict:
        return {"wrote": True}

    @app.get("/api/health")
    async def health() -> dict:
        return {"ok": True}

    @app.get("/{path:path}")
    async def spa(path: str) -> dict:
        return {"page": path or "index"}

    return app


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("SITE_PASSWORD", PW)
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    auth.reset_throttle()
    return TestClient(_minimal())


# --- fail closed --------------------------------------------------------------

def test_unconfigured_password_refuses_everything(monkeypatch):
    monkeypatch.delenv("SITE_PASSWORD", raising=False)
    c = TestClient(_minimal())
    assert c.get("/api/thing").status_code == 503
    assert c.post("/api/auth/login", json={"password": ""}).status_code == 503
    assert c.get("/api/health").status_code == 200        # the host's probe stays open


# --- the gate -----------------------------------------------------------------

def test_api_is_401_before_login(client):
    r = client.get("/api/thing")
    assert r.status_code == 401
    assert r.headers["X-Login-Url"] == "/password"


def test_browser_navigation_is_redirected_to_the_password_box(client):
    """A person, not a fetch: Accept says text/html, so they are sent to the
    box rather than shown a JSON error. Nothing of the page is served."""
    r = client.get("/", headers={"Accept": "text/html,*/*"}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/password"
    r = client.get("/research/abc", headers={"Accept": "text/html"}, follow_redirects=False)
    assert r.status_code == 303


def test_password_page_is_open(client):
    r = client.get("/password")
    assert r.status_code == 200
    assert b"<form" in r.content


def test_wrong_password_is_401_and_sets_no_cookie(client):
    r = client.post("/api/auth/login", json={"password": "hut"})
    assert r.status_code == 401
    assert auth.COOKIE not in r.cookies


def test_login_sets_cookie_and_opens_everything(client):
    r = client.post("/api/auth/login", json={"password": PW})
    assert r.status_code == 204
    assert auth.COOKIE in r.cookies
    assert client.get("/api/thing").json() == {"secret": 42}
    assert client.get("/", headers={"Accept": "text/html"}).json() == {"page": "index"}
    assert client.get("/api/auth/me").json() == {"authenticated": True, "admin": False,
                                                 "admin_note": auth.admin_unavailable()}


def test_logged_in_visitor_to_password_page_is_sent_home(client):
    client.post("/api/auth/login", json={"password": PW})
    r = client.get("/password", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/"


def test_logout_revokes(client):
    client.post("/api/auth/login", json={"password": PW})
    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/thing").status_code == 401


# --- the token ----------------------------------------------------------------

def test_token_expires(monkeypatch):
    monkeypatch.setenv("SITE_PASSWORD", PW)
    monkeypatch.setenv("SESSION_DAYS", "1")
    t = auth.make_token(now=1_000_000)
    assert auth.token_is_valid(t, now=1_000_000 + 86_399)
    assert not auth.token_is_valid(t, now=1_000_000 + 86_401)


def test_tampered_token_is_rejected(monkeypatch):
    monkeypatch.setenv("SITE_PASSWORD", PW)
    exp, role, sig = auth.make_token(now=0).split(".")
    assert not auth.token_is_valid(f"{int(exp) + 10**9}.{role}.{sig}", now=0)  # pushed expiry
    assert not auth.token_is_valid(f"{exp}.{role}.{'0' * 64}", now=0)          # forged sig
    assert not auth.token_is_valid(f"{exp}.admin.{sig}", now=0)                # swapped role
    assert not auth.token_is_valid(f"{exp}.root.{sig}", now=0)                 # invented role
    assert not auth.token_is_valid("garbage", now=0)


def test_changing_the_password_invalidates_sessions(monkeypatch):
    monkeypatch.setenv("SITE_PASSWORD", PW)
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    t = auth.make_token(now=0)
    monkeypatch.setenv("SITE_PASSWORD", "rotated")
    assert not auth.token_is_valid(t, now=0)


def test_explicit_secret_survives_a_password_change(monkeypatch):
    monkeypatch.setenv("SITE_PASSWORD", PW)
    monkeypatch.setenv("SESSION_SECRET", "fixed")
    t = auth.make_token(now=0)
    monkeypatch.setenv("SITE_PASSWORD", "rotated")
    assert auth.token_is_valid(t, now=0)


# --- throttle -----------------------------------------------------------------

def test_throttle_after_repeated_failures(client):
    for _ in range(auth.MAX_FAILURES):
        assert client.post("/api/auth/login", json={"password": "no"}).status_code == 401
    assert client.post("/api/auth/login", json={"password": "no"}).status_code == 429
    assert client.post("/api/auth/login", json={"password": PW}).status_code == 429


# --- wired into the real dashboard ----------------------------------------------

@pytest.fixture
def dashboard_client(monkeypatch):
    monkeypatch.setenv("SITE_PASSWORD", PW)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    monkeypatch.delenv("ODDS_REPO", raising=False)         # sync is a no-op in tests
    auth.reset_throttle()
    from dashboard.api.app import app
    return TestClient(app)


def test_dashboard_api_is_gated(dashboard_client):
    assert dashboard_client.get("/api/meta").status_code == 401
    assert dashboard_client.get("/api/players?q=x").status_code == 401
    assert dashboard_client.post("/api/odds/pull", json={"source": "espn"}).status_code == 401


def test_dashboard_password_box_and_health_are_open(dashboard_client):
    assert dashboard_client.get("/password").status_code == 200
    # Health also reports the commit the process was built from (None off
    # Render), so the check is on the flag, not the whole body.
    health = dashboard_client.get("/api/health").json()
    assert health["ok"] is True
    assert "commit" in health


def test_dashboard_browser_visit_is_redirected(dashboard_client):
    r = dashboard_client.get("/research", headers={"Accept": "text/html"}, follow_redirects=False)
    # 303 when the built SPA is present (catch-all route); 404 without it.
    # Either way, nothing of the app is served.
    assert r.status_code in (303, 404)
    if r.status_code == 303:
        assert r.headers["location"] == "/password"


def test_dashboard_starts_and_warms_without_a_cache(monkeypatch, capsys):
    """The warm-up must never keep the app from serving: with no parquet
    cache on disk every step is skipped and logged, and health still answers."""
    import time
    monkeypatch.setenv("SITE_PASSWORD", PW)
    monkeypatch.setenv("NFL_DATA_DIR", "/nonexistent-cache")
    monkeypatch.delenv("ODDS_REPO", raising=False)
    from dashboard.api import app as m
    with TestClient(m.app) as c:
        assert c.get("/api/health").json()["ok"] is True
        m._warm()                      # run it synchronously too, for the log
    out = capsys.readouterr().out
    assert "[warm]" in out


# --- the admin role -------------------------------------------------------------
# The routes behind `require_admin` write to disk or buy Odds API credits. A
# viewer holds a valid session, so "signed in" is not the question these tests
# ask; "which password did they type" is.

@pytest.fixture
def admin_client(monkeypatch):
    monkeypatch.setenv("SITE_PASSWORD", PW)
    monkeypatch.setenv("ADMIN_PASSWORD", ADMIN_PW)
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    auth.reset_throttle()
    return TestClient(_minimal())


def test_write_is_closed_to_everyone_until_admin_is_configured(client):
    """No ADMIN_PASSWORD is not "anyone may write", it is "nobody may"."""
    client.post("/api/auth/login", json={"password": PW})
    assert client.get("/api/thing").status_code == 200
    r = client.post("/api/write")
    assert r.status_code == 503
    assert "ADMIN_PASSWORD" in r.json()["detail"]


def test_two_identical_passwords_are_refused_rather_than_promoting_everyone(monkeypatch):
    """The copy-paste mistake: the same string in both variables reads as
    configured and would mean every visitor can spend money."""
    monkeypatch.setenv("SITE_PASSWORD", PW)
    monkeypatch.setenv("ADMIN_PASSWORD", PW)
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    auth.reset_throttle()
    c = TestClient(_minimal())
    assert c.post("/api/auth/login", json={"password": PW}).status_code == 204
    r = c.post("/api/write")
    assert r.status_code == 503
    assert "the same" in r.json()["detail"]


def test_a_viewer_is_signed_in_and_still_cannot_write(admin_client):
    admin_client.post("/api/auth/login", json={"password": PW})
    assert admin_client.get("/api/thing").status_code == 200
    assert admin_client.post("/api/write").status_code == 403
    me = admin_client.get("/api/auth/me").json()
    assert me == {"authenticated": True, "admin": False, "admin_note": None}


def test_the_admin_password_writes(admin_client):
    assert admin_client.post("/api/auth/login", json={"password": ADMIN_PW}).status_code == 204
    assert admin_client.post("/api/write").json() == {"wrote": True}
    assert admin_client.get("/api/auth/me").json()["admin"] is True
    assert admin_client.get("/api/thing").status_code == 200      # and still reads


def test_a_viewer_cannot_forge_an_admin_cookie(monkeypatch):
    """The property the whole gate rests on.

    Every viewer knows SITE_PASSWORD: it is how they got in. If the signing key
    were derived from that alone they could compute it, sign themselves
    ``<exp>.admin.<sig>`` and spend the credits. This builds exactly that
    forgery, from only what a viewer holds, and it must not verify.
    """
    monkeypatch.setenv("SITE_PASSWORD", PW)
    monkeypatch.setenv("ADMIN_PASSWORD", ADMIN_PW)
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    import hashlib
    import hmac as _hmac
    viewer_key = hashlib.sha256(b"nfl_predictor.session:" + PW.encode()).digest()
    exp = 10**10
    payload = f"{exp}.admin"
    forged = f"{payload}.{_hmac.new(viewer_key, payload.encode(), hashlib.sha256).hexdigest()}"
    assert auth.token_role(forged, now=0) is None

    c = TestClient(_minimal())
    c.cookies.set(auth.COOKIE, forged)
    assert c.post("/api/write").status_code in (401, 403)


def test_clearing_the_admin_password_revokes_the_sessions_it_issued(monkeypatch):
    monkeypatch.setenv("SITE_PASSWORD", PW)
    monkeypatch.setenv("ADMIN_PASSWORD", ADMIN_PW)
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    t = auth.make_token(now=0, role=auth.ADMIN)
    assert auth.token_role(t, now=0) == auth.ADMIN
    monkeypatch.delenv("ADMIN_PASSWORD")
    # The key moved with the password, so the cookie stops verifying at all.
    assert auth.token_role(t, now=0) is None


def test_a_cookie_minted_before_roles_existed_reads_as_view_only(monkeypatch):
    """A deploy must not bounce everyone already signed in, so the two-part
    token still verifies. It gets the role it could act with when it was made."""
    monkeypatch.setenv("SITE_PASSWORD", PW)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    exp = 10**10
    old = f"{exp}.{auth._sign(str(exp))}"
    assert auth.token_role(old, now=0) == auth.VIEW


def test_the_dashboard_write_routes_need_admin(dashboard_client):
    """Wired in the real app, not just the minimal one. 403 is raised by the
    dependency, so no handler runs and nothing is pulled or written."""
    writes = [("/api/odds/pull", {"source": "espn"}),
              ("/api/grading/run", {"season": 2026, "week": 1}),
              ("/api/projections/log", {})]
    for path, body in writes:
        assert dashboard_client.post(path, json=body).status_code == 401     # a stranger
    dashboard_client.post("/api/auth/login", json={"password": PW})
    for path, body in writes:
        r = dashboard_client.post(path, json=body)
        assert r.status_code == 503, f"{path} answered {r.status_code}"      # admin unset
