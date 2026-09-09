"""The site password gate.

The dependency and the auth routes will be lifted into the real dashboard
unchanged, so their behaviour is what is pinned here: fail closed without a
password, 401 on API routes until login, the cookie round-trips, logout
revokes it, and the throttle bites.
"""

import pytest
from fastapi.testclient import TestClient

from webauth import auth
from webauth.mock_app import create_app, latest_week

PW = "hut-hut"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("SITE_PASSWORD", PW)
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    auth.reset_throttle()
    return TestClient(create_app())


# --- fail closed --------------------------------------------------------------

def test_unconfigured_password_refuses_everything(monkeypatch):
    monkeypatch.delenv("SITE_PASSWORD", raising=False)
    c = TestClient(create_app())
    assert c.get("/api/board").status_code == 503
    assert c.post("/api/auth/login", json={"password": ""}).status_code == 503
    assert c.get("/healthz").status_code == 200          # exempt, so a host can probe it


# --- the gate -----------------------------------------------------------------

def test_api_is_401_before_login(client):
    r = client.get("/api/board")
    assert r.status_code == 401
    assert r.headers["X-Login-Url"] == "/password"


def test_browser_navigation_is_redirected_to_the_password_box(client):
    """A person, not a fetch: Accept says text/html, so they are sent to the
    box rather than shown a JSON error. Nothing of the page is served."""
    r = client.get("/", headers={"Accept": "text/html,*/*"}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/password"
    r = client.get("/api/board", headers={"Accept": "text/html"}, follow_redirects=False)
    assert r.status_code == 303


def test_password_page_is_open(client):
    r = client.get("/password")
    assert r.status_code == 200
    assert b"<form" in r.content


def test_wrong_password_is_401_and_sets_no_cookie(client):
    r = client.post("/api/auth/login", json={"password": "hut"})
    assert r.status_code == 401
    assert auth.COOKIE not in r.cookies


def test_login_sets_cookie_and_opens_the_api(client):
    r = client.post("/api/auth/login", json={"password": PW})
    assert r.status_code == 204
    assert auth.COOKIE in r.cookies
    assert client.get("/api/board").status_code == 200
    assert client.get("/").status_code == 200
    assert client.get("/api/auth/me").json() == {"authenticated": True}


def test_logged_in_visitor_to_login_page_is_sent_home(client):
    client.post("/api/auth/login", json={"password": PW})
    r = client.get("/password", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/"


def test_logout_revokes(client):
    client.post("/api/auth/login", json={"password": PW})
    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/board").status_code == 401


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
    # And the right password is locked out too until the window passes.
    assert client.post("/api/auth/login", json={"password": PW}).status_code == 429


# --- the placeholder board ----------------------------------------------------

def test_board_labels_example_rows_when_log_absent(client, monkeypatch, tmp_path):
    monkeypatch.setattr("webauth.mock_app.TRACK_CSV", tmp_path / "missing.csv")
    client.post("/api/auth/login", json={"password": PW})
    b = client.get("/api/board").json()
    assert b["example"] is True
    assert all(r["game_id"].startswith("2026_01_EXAMPLE") for r in b["rows"])


def test_latest_week_keeps_earliest_log_per_game():
    rows = [
        {"season": "2026", "week": "1", "game_id": "g", "logged_at": "2026-09-08 22:00:00"},
        {"season": "2026", "week": "1", "game_id": "g", "logged_at": "2026-09-08 20:00:00"},
        {"season": "2025", "week": "18", "game_id": "old", "logged_at": "2026-01-01 00:00:00"},
    ]
    out = latest_week(rows)
    assert [r["game_id"] for r in out] == ["g"]
    assert out[0]["logged_at"] == "2026-09-08 20:00:00"
