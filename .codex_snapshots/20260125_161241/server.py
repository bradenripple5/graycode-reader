#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import argparse
import os
from pathlib import Path
import ssl
import threading
import time
from urllib.parse import quote


class HtmlIndexHandler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            with _client_lock:
                _clients.add(self.wfile)
            try:
                while True:
                    time.sleep(3600)
            except Exception:
                pass
            finally:
                with _client_lock:
                    _clients.discard(self.wfile)
            return

        if self.path not in ("/", "/index.html"):
            return super().do_GET()

        html_files = sorted(
            p.relative_to(Path.cwd()).as_posix()
            for p in Path.cwd().rglob("*.html")
            if p.is_file()
        )

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()

        body = ["<!doctype html>", "<html>", "<head>", "<meta charset=\"utf-8\">"]
        body.append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
        body.append("<title>HTML Files</title>")
        body.append("</head><body>")
        body.append("<h1>HTML Files</h1>")
        if html_files:
            body.append("<ul>")
            for path in html_files:
                href = quote(path)
                body.append(f"<li><a href=\"/{href}\">{path}</a></li>")
            body.append("</ul>")
        else:
            body.append("<p>No HTML files found.</p>")
        body.append("</body></html>")
        self.wfile.write("\n".join(body).encode("utf-8"))


_clients: set = set()
_client_lock = threading.Lock()


def broadcast_reload() -> None:
    dead = []
    with _client_lock:
        for client in _clients:
            try:
                client.write(b"data: reload\\n\\n")
                client.flush()
            except Exception:
                dead.append(client)
        for client in dead:
            _clients.discard(client)


def watch_html_changes(root: Path, interval: float = 0.5) -> None:
    last_mtimes: dict[str, float] = {}
    ignore_parts = {".git", ".codex_snapshots"}
    while True:
        changed = False
        for path in root.rglob("*.html"):
            if any(part in ignore_parts for part in path.parts):
                continue
            try:
                mtime = path.stat().st_mtime
            except FileNotFoundError:
                continue
            key = path.as_posix()
            if key not in last_mtimes:
                last_mtimes[key] = mtime
                continue
            if mtime != last_mtimes[key]:
                last_mtimes[key] = mtime
                changed = True
        if changed:
            broadcast_reload()
        time.sleep(interval)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve a static HTML file.")
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host interface to bind (default: 127.0.0.1).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port to listen on (default: 8000).",
    )
    parser.add_argument(
        "--root",
        default=".",
        help="Directory to serve (default: current directory).",
    )
    parser.add_argument(
        "--https",
        action="store_true",
        help="Enable HTTPS (requires --cert and --key).",
    )
    parser.add_argument(
        "--cert",
        help="Path to TLS certificate (PEM).",
    )
    parser.add_argument(
        "--key",
        help="Path to TLS private key (PEM).",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    os.chdir(root)

    server = ThreadingHTTPServer((args.host, args.port), HtmlIndexHandler)
    scheme = "http"
    if args.https:
        if not args.cert or not args.key:
            raise SystemExit("--https requires --cert and --key")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=args.cert, keyfile=args.key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    watcher = threading.Thread(
        target=watch_html_changes,
        args=(root,),
        daemon=True,
    )
    watcher.start()
    print(f"Serving {root} at {scheme}://{args.host}:{args.port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
