#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import argparse
import json
import os
from pathlib import Path
import ssl
from urllib.parse import quote


class HtmlIndexHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def do_GET(self) -> None:
        if self.path == "/files":
            html_files = sorted(
                p.relative_to(Path.cwd()).as_posix()
                for p in Path.cwd().rglob("*.html")
                if p.is_file() and ".codex_snapshots" not in p.parts
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"files": html_files}).encode("utf-8"))
            return

        if self.path == "/last-post":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(_last_post.encode("utf-8"))
            return

        if self.path not in ("/", "/index.html"):
            return super().do_GET()

        html_files = sorted(
            p.relative_to(Path.cwd()).as_posix()
            for p in Path.cwd().rglob("*.html")
            if p.is_file() and ".codex_snapshots" not in p.parts
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

    def do_POST(self) -> None:
        global _last_post
        if self.path == "/revert":
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                print("revert: empty body")
                self.send_error(400)
                return
            payload = {}
            try:
                raw_body = self.rfile.read(length).decode("utf-8")
                print(f"revert: raw body={raw_body!r}")
                payload = json.loads(raw_body)
            except Exception as exc:
                print(f"revert: parse error={exc!r}")
                self.send_error(400)
                return
            file_path = str(payload.get("file", ""))
            timestamp = str(payload.get("timestamp", ""))
            index = payload.get("index", None)
            if isinstance(index, str) and index.isdigit():
                index = int(index)
            if not file_path or (not timestamp and index is None):
                self.send_error(400)
                return
            if Path(file_path).is_absolute() or ".." in Path(file_path).parts:
                self.send_error(400)
                return

            root = Path.cwd()
            snapshots_root = root / ".codex_snapshots"
            snapshot_dir = snapshots_root / timestamp if timestamp else None
            if snapshot_dir and not snapshot_dir.is_dir():
                snapshot_dir = None
            if snapshot_dir is None:
                snapshot_dirs = []
                for p in sorted(snapshots_root.iterdir(), key=lambda p: p.name, reverse=True):
                    if not p.is_dir() or p.name == "latest.json":
                        continue
                    if (p / file_path).is_file():
                        snapshot_dirs.append(p)
                if isinstance(index, int) and 0 <= index < len(snapshot_dirs):
                    snapshot_dir = snapshot_dirs[index]
            if not snapshot_dir.is_dir():
                self.send_error(404)
                return
            snapshot_file = snapshot_dir / file_path
            if not snapshot_file.is_file():
                self.send_error(404)
                return
            dest = root / file_path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(snapshot_file.read_bytes())
            info = timestamp if timestamp else f"index:{index}"
            _last_post = f"revert {file_path} {info}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            payload = {
                "status": "ok",
                "file": file_path,
                "timestamp": snapshot_dir.name,
            }
            self.wfile.write(json.dumps(payload).encode("utf-8"))
            return

        if self.path == "/save":
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                print("save: empty body")
                self.send_error(400)
                return
            try:
                raw_body = self.rfile.read(length).decode("utf-8")
                print(f"save: raw body={raw_body!r}")
                payload = json.loads(raw_body)
            except Exception as exc:
                print(f"save: parse error={exc!r}")
                self.send_error(400)
                return
            file_path = str(payload.get("file", ""))
            content = payload.get("content", None)
            if not file_path or content is None:
                self.send_error(400)
                return
            if Path(file_path).is_absolute() or ".." in Path(file_path).parts:
                self.send_error(400)
                return
            dest = Path.cwd() / file_path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(str(content), encoding="utf-8")
            _last_post = f"save {file_path}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "file": file_path}).encode("utf-8"))
            return

        if self.path == "/save-diff":
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                print("save-diff: empty body")
                self.send_error(400)
                return
            try:
                raw_body = self.rfile.read(length).decode("utf-8")
                print(f"save-diff: raw body={raw_body!r}")
                payload = json.loads(raw_body)
            except Exception as exc:
                print(f"save-diff: parse error={exc!r}")
                self.send_error(400)
                return
            file_path = str(payload.get("file", ""))
            timestamp = str(payload.get("timestamp", ""))
            patch = payload.get("patch", None)
            if not file_path or not timestamp or patch is None:
                self.send_error(400)
                return
            if Path(file_path).is_absolute() or ".." in Path(file_path).parts:
                self.send_error(400)
                return
            diff_root = Path.cwd() / "diff" / file_path
            diff_root.mkdir(parents=True, exist_ok=True)
            diff_path = diff_root / f"{timestamp}.patch"
            diff_path.write_text(str(patch), encoding="utf-8")
            _last_post = f"save-diff {file_path} {timestamp}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                json.dumps({"status": "ok", "file": file_path, "timestamp": timestamp}).encode("utf-8")
            )
            return

        self.send_error(404)


_last_post = "(none)"


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
    print(f"Serving {root} at {scheme}://{args.host}:{args.port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
