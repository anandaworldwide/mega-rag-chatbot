#!/usr/bin/env python3
"""Local mock of the Luca request proxy for skill self-tests. No library text."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CSP = "default-src 'self'"
LOGIN_DATA = {
    "page": "/login",
    "props": {"pageProps": {"siteConfig": {"siteId": "ananda", "requireLogin": True, "shortname": "Luca"}}},
}
SHARE_DATA = {
    "page": "/share/[docId]",
    "props": {"pageProps": {"siteConfig": {"siteId": "ananda", "requireLogin": True, "shortname": "Luca"}}},
}
SHARE_OK_ID = "share-ok-id"
SHARE_OK_BODY = {"id": SHARE_OK_ID, "title": None, "turns": []}


def html_with_next_data(data: dict) -> bytes:
    payload = json.dumps(data)
    page = (
        "<!doctype html><html><head></head><body>"
        f'<script id="__NEXT_DATA__" type="application/json">{payload}</script>'
        "</body></html>"
    )
    return page.encode("utf-8")


class LucaProxyMock(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return

    def _send(self, code: int, body: bytes = b"", content_type: str = "text/plain", location: str | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Security-Policy", CSP)
        if location:
            self.send_header("Location", location)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/login":
            self._send(200, html_with_next_data(LOGIN_DATA), "text/html")
            return
        if path == "/":
            self._send(307, b"", location="/login")
            return
        if path == "/api/web-token":
            self._send(200, b"{}", "application/json")
            return
        if path == "/_next/static/chunks/pages/login.js":
            self._send(200, b"// mock login chunk\n", "application/javascript")
            return
        if path == "/api/chats":
            self._send(401, b'{"success":false}', "application/json")
            return
        if path.startswith("/api/document/"):
            self._send(401, b'{"success":false}', "application/json")
            return
        if path == f"/api/share/{SHARE_OK_ID}":
            self._send(200, json.dumps(SHARE_OK_BODY).encode("utf-8"), "application/json")
            return
        if path.startswith("/api/share/"):
            self._send(404, b'{"message":"Document not found"}', "application/json")
            return
        if path.startswith("/share/"):
            self._send(200, html_with_next_data(SHARE_DATA), "text/html")
            return
        self._send(404, b"not found")


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), LucaProxyMock)
    host, port = server.server_address[:2]
    print(f"{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
