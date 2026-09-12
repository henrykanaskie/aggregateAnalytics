"""A single-password login for the dashboard, built into the app.

    from webauth import auth_router, require_admin, require_session
    app = FastAPI(dependencies=[Depends(require_session)])
    app.include_router(auth_router)

Every route on ``app`` then requires a valid session cookie except the auth
routes and ``/healthz``. A route that writes or spends adds ``require_admin``
on top, which a viewer's session does not satisfy. See ``webauth/README.md``.
"""

from .auth import auth_router, require_admin, require_session

__all__ = ["auth_router", "require_admin", "require_session"]
