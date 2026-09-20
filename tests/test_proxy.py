"""Proxy tests: request validation, rate limiting, and a real end-to-end request."""

import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from proxy.server import Handler, RateLimiter, parse_request


class TestParseRequest(unittest.TestCase):
    def test_valid(self):
        msg, err = parse_request(b'{"sender":"Rahul","body":"aa rahe ho?","app":"com.whatsapp"}')
        self.assertEqual(err, "")
        self.assertEqual(msg.sender, "Rahul")
        self.assertEqual(msg.app, "com.whatsapp")

    def test_missing_body_rejected(self):
        _, err = parse_request(b'{"sender":"Rahul"}')
        self.assertIn("body", err)

    def test_blank_body_rejected(self):
        _, err = parse_request(b'{"body":"   "}')
        self.assertIn("body", err)

    def test_not_json_rejected(self):
        _, err = parse_request(b"not json")
        self.assertIn("JSON", err)

    def test_json_array_rejected(self):
        _, err = parse_request(b'[1,2,3]')
        self.assertIn("object", err)

    def test_missing_sender_defaults_rather_than_failing(self):
        msg, err = parse_request(b'{"body":"hi"}')
        self.assertEqual(err, "")
        self.assertEqual(msg.sender, "Unknown")

    def test_wrong_typed_fields_coerced_not_crashed(self):
        msg, err = parse_request(b'{"body":"hi","sender":5,"app":[],"history":"nope"}')
        self.assertEqual(err, "")
        self.assertEqual(msg.sender, "Unknown")
        self.assertEqual(msg.history, [])

    def test_history_non_strings_dropped_and_capped(self):
        payload = json.dumps({"body": "hi", "history": [str(i) for i in range(25)] + [None]})
        msg, err = parse_request(payload.encode())
        self.assertEqual(err, "")
        self.assertEqual(len(msg.history), 10)
        self.assertEqual(msg.history[-1], "24")  # keeps the most recent


class TestRateLimiter(unittest.TestCase):
    def test_blocks_past_limit_per_caller(self):
        rl = RateLimiter(limit=3, window_s=60.0)
        self.assertTrue(all(rl.allow("a") for _ in range(3)))
        self.assertFalse(rl.allow("a"))
        # A different caller is unaffected.
        self.assertTrue(rl.allow("b"))

    def test_window_expiry_forgives(self):
        rl = RateLimiter(limit=1, window_s=0.0)
        self.assertTrue(rl.allow("a"))
        self.assertTrue(rl.allow("a"))


class TestServer(unittest.TestCase):
    """Drives the real handler over a real socket on an ephemeral port."""

    @classmethod
    def setUpClass(cls):
        Handler.limiter = RateLimiter(1000, 60.0)  # don't trip while testing
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def url(self, path):
        return "http://127.0.0.1:{}{}".format(self.port, path)

    def post(self, path, payload):
        data = json.dumps(payload).encode()
        req = urllib.request.Request(self.url(path), data=data,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_healthz_never_leaks_the_key(self):
        with urllib.request.urlopen(self.url("/healthz"), timeout=5) as r:
            body = r.read().decode()
        self.assertEqual(r.status, 200)
        self.assertIn("key_configured", body)
        self.assertNotIn("gsk_", body)

    def test_unknown_path_404s(self):
        status, _ = self.post("/nope", {"body": "hi"})
        self.assertEqual(status, 404)

    def test_end_to_end_returns_three_replies(self):
        status, obj = self.post("/replies", {
            "sender": "Rahul", "body": "kal office aa rahe ho?", "app": "com.whatsapp",
        })
        self.assertEqual(status, 200)
        self.assertEqual(len(obj["replies"]), 3)
        self.assertEqual([r["intent"] for r in obj["replies"]],
                         ["positive", "neutral", "decline"])
        self.assertEqual(obj["tone"], "casual_hinglish")
        self.assertIn("from_ai", obj)
        self.assertIsInstance(obj["latency_ms"], int)

    def test_bad_request_400s(self):
        status, obj = self.post("/replies", {"sender": "Rahul"})
        self.assertEqual(status, 400)
        self.assertIn("error", obj)

    def test_oversized_body_rejected(self):
        status, _ = self.post("/replies", {"body": "x" * 20000})
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
