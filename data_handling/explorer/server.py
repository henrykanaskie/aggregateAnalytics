"""Stdlib HTTP server for the explorer: JSON API plus static files.

Design notes worth keeping in mind:

* ``ThreadingHTTPServer`` is not a luxury. A pbp scan can take seconds and the
  single-threaded server would stall the whole page behind it, so every request
  gets its own thread.
* We never call ``send_error``: its default body is HTML, and an HTML body
  reaching ``fetch()`` turns a useful backend message into "Unexpected token
  <". Every response from this module is JSON or a file.
* Bind is 127.0.0.1 by default. This tool reads a local data cache and runs an
  arbitrary SQL console, so it must not be reachable from the network.
"""

from __future__ import annotations

import argparse
import gzip
import json
import mimetypes
import socket
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

# Allow both ``python -m explorer.server`` and ``python explorer/server.py``.
if __package__ in (None, ""):  # pragma: no cover - script entry only
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    __package__ = "explorer"

from . import api, paths  # noqa: E402

DEFAULT_PORT = 8777
PORT_SCAN = 20                  # how many ports past the default we will try
GZIP_MIN_BYTES = 4096           # below this, compression costs more than it saves
MAX_BODY_BYTES = 16 * 1024 * 1024

# Explicit map: mimetypes guesses ``application/javascript`` on some machines
# and ``text/plain`` for .js on others, and a wrong type breaks module loading.
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
}
TEXTUAL = (".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt", ".map")


def _fmt_size(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1e6:.1f} MB"
    if n >= 1000:
        return f"{n / 1e3:.1f} KB"
    return f"{n} B"


class Handler(BaseHTTPRequestHandler):
    """One request. Routing lives in ``api.ROUTES``; this class is transport."""

    protocol_version = "HTTP/1.1"      # keep-alive: every response sets a length
    server_version = "nfl-explorer"
    sys_version = ""

    # -- logging ----------------------------------------------------------
    def log_message(self, fmt: str, *args: Any) -> None:
        """Silence the stock two-line-per-request logging: we log our own."""

    def log_error(self, fmt: str, *args: Any) -> None:
        """Also silenced. Real errors are reported by the dispatcher."""

    def _log(self, method: str, target: str, status: int, t0: float, size: int) -> None:
        ms = (time.perf_counter() - t0) * 1000
        if len(target) > 88:
            target = target[:85] + "..."
        print(f"{method:<6} {target:<88} {status} {ms:7.1f}ms {_fmt_size(size):>9}",
              flush=True)

    # -- verbs ------------------------------------------------------------
    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_HEAD(self) -> None:
        self._dispatch("HEAD")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    # -- transport --------------------------------------------------------
    def handle_one_request(self) -> None:
        """Browsers abort in-flight fetches constantly (every keystroke in a
        filter box). A cancelled request is normal, not an error."""
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            self.close_connection = True

    def send_error(self, code: int, message: str | None = None,
                   explain: str | None = None) -> None:
        """Never emit the stock HTML error page; a fetch() caller cannot use it."""
        self._send(code, json.dumps({"error": message or f"HTTP {code}"}).encode(),
                   "application/json; charset=utf-8", allow_gzip=False)

    def _send(self, status: int, body: bytes, content_type: str,
              extra: dict[str, str] | None = None, allow_gzip: bool = True) -> int:
        """Write one complete response. Returns bytes actually put on the wire."""
        if allow_gzip and len(body) >= GZIP_MIN_BYTES and self._accepts_gzip():
            body = gzip.compress(body, 6)
            extra = dict(extra or {})
            extra["Content-Encoding"] = "gzip"
            extra["Vary"] = "Accept-Encoding"
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD" and body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        return len(body)

    def _accepts_gzip(self) -> bool:
        return "gzip" in (self.headers.get("Accept-Encoding") or "").lower()

    def _json(self, status: int, payload: Any,
              extra: dict[str, str] | None = None) -> tuple[int, int]:
        """allow_nan=False: NaN/Infinity are not JSON and JSON.parse rejects them,
        so a leaking NaN must fail loudly here rather than break the browser."""
        try:
            body = json.dumps(payload, allow_nan=False, default=str).encode("utf-8")
        except ValueError as exc:
            body = json.dumps({
                "error": f"response contained a value JSON cannot represent ({exc}). "
                         "This is a server bug: NaN/Inf must be nulled by the data layer."
            }).encode("utf-8")
            status = 500
            print(f"[500] non-finite value in payload: {exc}", file=sys.stderr, flush=True)
        headers = {"Cache-Control": "no-store, no-cache, must-revalidate"}
        headers.update(extra or {})
        # Return the status too: the NaN branch above rewrites it, and the
        # request log must show what the client actually got.
        return status, self._send(status, body, "application/json; charset=utf-8", headers)

    # -- routing ----------------------------------------------------------
    def _dispatch(self, method: str) -> None:
        t0 = time.perf_counter()
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        target = self.path
        try:
            if path.startswith("/api"):
                status, size = self._handle_api(method, path, parsed.query)
            else:
                status, size = self._handle_static(method, path)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return
        except Exception as exc:                       # last-resort net
            traceback.print_exc()
            status, size = self._json(500, {"error": f"{type(exc).__name__}: {exc}"})
        self._log(method, target, status, t0, size)

    def _read_body(self) -> Any:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise api.BadRequest(f"request body too large ({length} bytes)")
        raw = self.rfile.read(length)
        if not raw.strip():
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise api.BadRequest(f"request body is not valid JSON: {exc}") from None

    def _handle_api(self, method: str, path: str, query: str) -> tuple[int, int]:
        lookup = "GET" if method == "HEAD" else method
        route = api.ROUTES.get((lookup, path))
        if route is None:
            if path in api.API_PATHS:
                allowed = sorted(m for m, p in api.ROUTES if p == path)
                return self._json(405, {
                    "error": f"{method} not allowed on {path}. Allowed: {', '.join(allowed)}"
                }, {"Allow": ", ".join(allowed)})
            return self._json(404, {"error": f"no such endpoint: {path}"})

        handler, is_download = route
        try:
            if lookup in ("POST", "PUT", "PATCH"):
                params = self._read_body()
                if not isinstance(params, dict):
                    raise api.BadRequest("request body must be a JSON object")
            else:
                # Last value wins, which matches how browsers treat duplicates.
                params = {k: v[-1] for k, v in parse_qs(query, keep_blank_values=True).items()}
            result = handler(params)
        except api.CLIENT_ERRORS as exc:
            return self._json(400, {"error": str(exc)})
        except Exception as exc:
            traceback.print_exc()
            return self._json(500, {"error": f"{type(exc).__name__}: {exc}"})

        if is_download:
            return self._send_download(result)
        return self._json(200, result)

    def _send_download(self, result: tuple[bytes, str, str, bool]) -> tuple[int, int]:
        payload, filename, content_type, truncated = result
        headers = {
            # Quotes plus a sanitised name: the filename comes from user input
            # and a raw CR/LF in a header would be response splitting.
            "Content-Disposition": f'attachment; filename="{api.safe_filename(filename, "export")}"',
            "Cache-Control": "no-store",
            "X-Export-Truncated": "true" if truncated else "false",
        }
        # No gzip here: csv downloads are already saved to disk by the browser
        # and parquet is compressed already.
        return 200, self._send(200, payload, content_type, headers, allow_gzip=False)

    # -- static -----------------------------------------------------------
    def _resolve_static(self, path: str) -> Path | None:
        """Map a URL path to a file under STATIC_DIR, or None if it escapes.

        The guard is required even locally: a browser tab from any site can
        issue GETs at 127.0.0.1, and ``/static/../../ingest.py`` must not read
        outside the static tree.
        """
        if "\x00" in path:
            return None
        if path in ("/", "/index.html"):
            rel = "index.html"
        elif path.startswith("/static/"):
            rel = path[len("/static/"):]
        elif path == "/favicon.ico":
            rel = "favicon.ico"
        else:
            return None
        root = paths.STATIC_DIR.resolve()
        full = (root / rel).resolve()
        if full != root and root not in full.parents:
            return None
        return full

    def _handle_static(self, method: str, path: str) -> tuple[int, int]:
        if method not in ("GET", "HEAD"):
            return self._json(405, {"error": f"{method} not allowed on {path}"})

        full = self._resolve_static(path)
        if full is None:
            if path.startswith("/static/") or path in ("/", "/index.html", "/favicon.ico"):
                return self._json(403, {"error": "path escapes the static directory"})
            return self._json(404, {"error": f"not found: {path}"})

        if not full.is_file():
            if path in ("/", "/index.html"):
                return self._json(503, {
                    "error": "static/index.html is missing. The frontend has not been "
                             "built into data_handling/explorer/static/ yet."
                })
            return self._json(404, {"error": f"not found: {path}"})

        stat = full.stat()
        etag = f'W/"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        if (self.headers.get("If-None-Match") or "") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return 304, 0

        ext = full.suffix.lower()
        ctype = MIME_TYPES.get(ext) or mimetypes.guess_type(full.name)[0] or "application/octet-stream"
        headers = {
            # Short max-age plus revalidation: fast reloads, but an edited file
            # is picked up on the next request during development.
            "Cache-Control": "public, max-age=5, must-revalidate",
            "ETag": etag,
        }
        body = full.read_bytes()
        return 200, self._send(200, body, ctype, headers, allow_gzip=ext in TEXTUAL)


class ExplorerServer(ThreadingHTTPServer):
    daemon_threads = True           # Ctrl-C must not wait on an in-flight scan
    allow_reuse_address = True


def bind(host: str, port: int, scan: int = PORT_SCAN) -> ExplorerServer:
    """Bind the first free port at or after ``port``. Report which one we got."""
    last: OSError | None = None
    for candidate in range(port, port + scan + 1):
        try:
            return ExplorerServer((host, candidate), Handler)
        except OSError as exc:
            last = exc
            continue
    hint = ("Ports below 1024 need root: pick a higher one."
            if port < 1024 else
            "Something else is using that range. Try --port 9100.")
    raise SystemExit(
        f"Could not bind {host}:{port}-{port + scan} ({last}). {hint}"
    )


def warm_caches() -> None:
    """Pre-build schema and coverage caches so the first click is not the slow
    one. Runs on a background thread: the UI should be usable while it works."""
    t0 = time.perf_counter()
    try:
        from . import catalog
        catalog.catalog_payload()
        names = catalog.dataset_names()
        for name in names:
            try:
                catalog.get_schema(name)
            except Exception as exc:
                print(f"[warm] schema {name}: {type(exc).__name__}: {exc}", flush=True)
        catalog.coverage_payload()
        print(f"[warm] {len(names)} schemas + coverage in "
              f"{time.perf_counter() - t0:.1f}s", flush=True)
    except Exception as exc:
        print(f"[warm] failed: {type(exc).__name__}: {exc}", flush=True)


def banner(host: str, port: int) -> None:
    url = f"http://{host}:{port}"
    line = "-" * 58
    print(line)
    print("  NFL Data Explorer")
    print(f"  {url}")
    print(f"  data   {paths.DATA_DIR}")
    print(f"  static {paths.STATIC_DIR}")
    print("  Ctrl-C to stop")
    print(line, flush=True)


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="explore",
        description="Local browser for the nflverse Parquet cache.",
    )
    ap.add_argument("--port", type=int, default=DEFAULT_PORT,
                    help=f"port to serve on (default {DEFAULT_PORT}); "
                         f"the next {PORT_SCAN} are tried if it is taken")
    ap.add_argument("--host", default="127.0.0.1",
                    help="bind address (default 127.0.0.1, localhost only)")
    ap.add_argument("--no-browser", action="store_true",
                    help="do not open a browser window")
    ap.add_argument("--warm", action="store_true",
                    help="pre-build the schema and coverage caches at boot")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"[warn] binding {args.host}: the SQL console will be reachable "
              f"from the network", flush=True)

    httpd = bind(args.host, args.port)
    port = httpd.server_address[1]
    paths.ensure_cache()
    banner(args.host, port)

    if args.warm:
        threading.Thread(target=warm_caches, name="warm", daemon=True).start()
    if not args.no_browser:
        # The socket is already listening, so anything the browser sends now
        # simply waits in the accept backlog.
        threading.Thread(target=webbrowser.open,
                         args=(f"http://{args.host}:{port}",), daemon=True).start()

    try:
        httpd.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("\nstopping", flush=True)
    finally:
        httpd.shutdown()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
