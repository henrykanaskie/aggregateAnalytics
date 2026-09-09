"""The site password gate, on the dashboard app and on a minimal app.

The minimal app pins the dependency's own behaviour without needing the
parquet cache; the dashboard checks prove it is actually wired in there.
"""

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from webauth import auth, auth_router, require_session

PW = "hut-hut"


def _minimal() -> FastAPI:
    app = FastAPI(dependencies=[Depends(require_session)])
    app.include_router(auth_router)

    @app.get("/api/thing")
    async def thing() -> dict:
        return {"secret": 42}

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
    assert client.get("/api/auth/me").json() == {"authenticated": True}


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
    exp, sig = auth.make_token(now=0).split(".")
    assert not auth.token_is_valid(f"{int(exp) + 10**9}.{sig}", now=0)   # pushed expiry
    assert not auth.token_is_valid(f"{exp}.{'0' * 64}", now=0)           # forged sig
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
