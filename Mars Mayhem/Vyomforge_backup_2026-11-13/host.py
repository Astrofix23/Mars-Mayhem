#!/usr/bin/env python3
"""MARS: Outpost Survival — one-command host.

Serves this folder over HTTP so the ES-module game will load, picks a free port
if the default is busy, prints a local and a LAN address, and opens the browser.

    ./host.py                 # http://127.0.0.1:8123/
    ./host.py --port 9000     # a different port
    ./host.py --no-browser    # just serve, do not open anything
    ./host.py --lan           # listen on all interfaces so others can join

Standard library only: no installs, no network access required.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import socket
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_PORT = 8123
PORT_SCAN = 25  # how many ports to try past the requested one


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static handler that tells the browser never to cache anything.

    Browsers cache ES modules hard: without this you can edit a file, reload,
    and still run the old code while the HTML is fresh.
    """

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # Keep the console readable: one short line per request, errors always shown.
        if args and str(args[0]).startswith(("4", "5")):
            sys.stderr.write(f"  {args[0]}  {args[1]}\n")


def bind(host: str, port: int, tries: int) -> http.server.ThreadingHTTPServer:
    """Bind to the first free port in range, so a busy port is never fatal."""
    last: OSError | None = None
    for candidate in range(port, port + tries):
        try:
            http.server.ThreadingHTTPServer.allow_reuse_address = True
            return http.server.ThreadingHTTPServer((host, candidate), functools.partial(Handler, directory=str(ROOT)))
        except OSError as exc:  # in use, or not permitted
            last = exc
    raise SystemExit(
        f"No free port between {port} and {port + tries - 1}.\n"
        f"Last error: {last}\nTry: {Path(sys.argv[0]).name} --port 9000"
    )


def lan_address() -> str | None:
    """Best-effort LAN IP. Uses a UDP connect, which sends no packets."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            return probe.getsockname()[0]
    except OSError:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Host MARS: Outpost Survival on the local machine.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"preferred port (default {DEFAULT_PORT})")
    parser.add_argument("--host", default="127.0.0.1", help="interface to bind (default 127.0.0.1)")
    parser.add_argument("--lan", action="store_true", help="bind 0.0.0.0 so other devices on the network can play")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    args = parser.parse_args()

    if not (ROOT / "index.html").is_file():
        raise SystemExit(f"index.html not found in {ROOT} — run this script from the game folder.")

    host = "0.0.0.0" if args.lan else args.host
    server = bind(host, args.port, PORT_SCAN)
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}/"

    print("MARS: Outpost Survival")
    print(f"  serving   {ROOT}")
    print(f"  local     {url}")
    if args.lan or host == "0.0.0.0":
        ip = lan_address()
        if ip:
            print(f"  network   http://{ip}:{port}/")
    else:
        print("  network   only this machine (use --lan to share)")
    if port != args.port:
        print(f"  note      port {args.port} was busy, using {port}")
    print("  stop      Ctrl+C")
    print()

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  server stopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
