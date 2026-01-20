#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import argparse
import os
from pathlib import Path
import ssl


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

    server = ThreadingHTTPServer((args.host, args.port), SimpleHTTPRequestHandler)
    scheme = "http"
    if args.https:
        if not args.cert or not args.key:
            raise SystemExit("--https requires --cert and --key")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=args.cert, keyfile=args.key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    print(f"Serving {root} at {scheme}://{args.host}:{args.port}/index.html")
    server.serve_forever()


if __name__ == "__main__":
    main()
