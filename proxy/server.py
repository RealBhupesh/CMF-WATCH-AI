"""Backend proxy holding the Groq key, so it never ships in the APK.

PRD scope item 5: ephemeral processing. Message bodies are never logged, never
written to disk, and never held past the request. The access log prints timing
and outcome only -- if you add a body to a log line here, you have broken the
privacy promise the product makes.

Stdlib only:

    GROQ_API_KEY=... python3 proxy/server.py --port 8787
    curl -s localhost:8787/healthz
    curl -s localhost:8787/replies -H 'content-type: application/json' \
      -d '{"sender":"Rahul","body":"kal office aa rahe ho?","app":"com.whatsapp"}'
"""

import argparse
import json
import os
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Deque, Dict, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.generate import generate
from engine.model import IncomingMessage

# A phone generating replies per notification does not need a high ceiling, and
# a runaway NotificationListenerService loop would otherwise burn the quota.
RATE_LIMIT_REQUESTS = 30
RATE_LIMIT_WINDOW_S = 60.0

MAX_BODY_BYTES = 16 * 1024
MAX_HISTORY = 10


class RateLimiter:
    """Fixed-window-per-caller limiter. In-memory: a restart forgives everyone."""

    def __init__(self, limit: int, window_s: float) -> None:
        self._limit = limit
        self._window = window_s
        self._hits: Dict[str, Deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and now - hits[0] > self._window:
                hits.popleft()
            if len(hits) >= self._limit:
                return False
            hits.append(now)
            return True


def parse_request(payload: bytes) -> Tuple[IncomingMessage, str]:
    """Validate a request body. Returns (message, error); error is '' when valid."""
    try:
        obj = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None, "body must be JSON"
    if not isinstance(obj, dict):
        return None, "body must be a JSON object"

    body = obj.get("body")
    if not isinstance(body, str) or not body.strip():
        return None, "'body' is required"

    sender = obj.get("sender")
    if not isinstance(sender, str):
        sender = "Unknown"

    app = obj.get("app")
    if not isinstance(app, str):
        app = ""

    history = obj.get("history")
    if not isinstance(history, list):
        history = []
    history = [h for h in history if isinstance(h, str)][-MAX_HISTORY:]

    return IncomingMessage(sender=sender, body=body, app=app, history=history), ""


class Handler(BaseHTTPRequestHandler):
    limiter = RateLimiter(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_S)
    server_version = "watchai-proxy"

    def _send(self, code: int, obj: dict) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            # Report only whether a key is present, never any part of it.
            self._send(200, {"ok": True, "key_configured": bool(os.environ.get("GROQ_API_KEY"))})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/replies":
            self._send(404, {"error": "not found"})
            return

        if not self.limiter.allow(self.client_address[0]):
            self._send(429, {"error": "rate limited"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(400, {"error": "bad Content-Length"})
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send(400, {"error": "body must be 1..{} bytes".format(MAX_BODY_BYTES)})
            return

        msg, err = parse_request(self.rfile.read(length))
        if err:
            self._send(400, {"error": err})
            return

        result = generate(msg)
        self._send(200, {
            "replies": [
                {"intent": r.intent.value, "text": r.text}
                for r in result.reply_set.replies
            ],
            "tone": result.reply_set.tone.value,
            # The client must surface this: fallback replies are not AI replies.
            "from_ai": result.reply_set.from_ai,
            "latency_ms": result.latency_ms,
        })

    def log_message(self, fmt: str, *args) -> None:
        # Default BaseHTTPRequestHandler logging would print the request line
        # only, but be explicit: never let a message body reach a log.
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1",
                    help="default is loopback; bind wider only behind TLS")
    args = ap.parse_args()

    if not os.environ.get("GROQ_API_KEY"):
        print("warning: GROQ_API_KEY unset -- every request returns static fallbacks",
              file=sys.stderr)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print("listening on http://{}:{}".format(args.host, args.port), file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
