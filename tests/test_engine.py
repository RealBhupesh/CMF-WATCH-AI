"""Reply engine tests. No network, no API key, no Android toolchain.

    python3 -m unittest discover -s tests -v
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.generate import generate, static_replies
from engine.model import IncomingMessage, Intent, Tone
from engine.prompt import build_system_prompt, infer_tone
from engine.sanitize import WATCH_REPLY_MAX_CHARS, dedupe, sanitize_reply


def groq_response(obj):
    """Shape a fake Groq envelope around a reply dict."""
    return json.dumps({"choices": [{"message": {"content": json.dumps(obj)}}]})


def transport_returning(raw):
    def _t(url, headers, payload, timeout):
        return raw
    return _t


def transport_raising(exc):
    def _t(url, headers, payload, timeout):
        raise exc
    return _t


class TestSanitize(unittest.TestCase):
    def test_strips_emoji_and_keeps_words(self):
        self.assertEqual(sanitize_reply("Sounds good \U0001F44D"), "Sounds good")

    def test_folds_accents_rather_than_deleting_letters(self):
        self.assertEqual(sanitize_reply("See you at the café"), "See you at the cafe")

    def test_normalises_smart_punctuation(self):
        self.assertEqual(sanitize_reply("I’m on my way"), "I'm on my way")

    def test_drops_devanagari(self):
        # Hinglish must be Latin script; Devanagari would not render.
        self.assertEqual(sanitize_reply("हाँ ok"), "ok")

    def test_truncates_at_word_boundary(self):
        long = "yes absolutely that works perfectly for me and everyone else too"
        out = sanitize_reply(long)
        self.assertLessEqual(len(out), WATCH_REPLY_MAX_CHARS)
        self.assertFalse(out.endswith(" "))
        # Should not chop mid-word when a decent boundary exists.
        self.assertTrue(long.startswith(out))
        self.assertIn(" ", out)

    def test_truncation_never_exceeds_cap(self):
        out = sanitize_reply("x" * 200)  # no spaces: word boundary unavailable
        self.assertEqual(len(out), WATCH_REPLY_MAX_CHARS)

    def test_collapses_whitespace_and_quotes(self):
        self.assertEqual(sanitize_reply('  "yes   ok"  '), "yes ok")

    def test_dedupe_ignores_case_and_punctuation(self):
        self.assertEqual(dedupe(["Yes, ok!", "yes ok", "No"]), ["Yes, ok!", "No"])


class TestToneInference(unittest.TestCase):
    def test_work_app_wins_over_casual_content(self):
        msg = IncomingMessage("Boss", "haan bhai kya chal raha hai",
                              app="com.microsoft.teams")
        self.assertEqual(infer_tone(msg), Tone.PROFESSIONAL)

    def test_hinglish_detected(self):
        msg = IncomingMessage("Rahul", "yaar kal milte hai kya", app="com.whatsapp")
        self.assertEqual(infer_tone(msg), Tone.CASUAL_HINGLISH)

    def test_plain_english_not_flagged_hinglish(self):
        msg = IncomingMessage("Sam", "Are you free to grab lunch tomorrow?",
                              app="com.whatsapp")
        self.assertEqual(infer_tone(msg), Tone.CASUAL_ENGLISH)

    def test_marker_substrings_do_not_false_positive(self):
        # "hai" in "hair", "ka" in "karaoke", "ho" in "hotel", "na" in "nachos"
        msg = IncomingMessage("Sam", "hair salon then karaoke at the hotel with nachos",
                              app="com.whatsapp")
        self.assertEqual(infer_tone(msg), Tone.CASUAL_ENGLISH)

    def test_short_message_needs_only_one_marker(self):
        msg = IncomingMessage("Rahul", "theek?", app="com.whatsapp")
        self.assertEqual(infer_tone(msg), Tone.CASUAL_HINGLISH)

    def test_history_informs_tone(self):
        msg = IncomingMessage("Rahul", "ok", app="com.whatsapp",
                              history=["kal milte hai", "haan theek hai"])
        self.assertEqual(infer_tone(msg), Tone.CASUAL_HINGLISH)

    def test_empty_body_does_not_crash(self):
        self.assertEqual(infer_tone(IncomingMessage("X", "", app="com.whatsapp")),
                         Tone.CASUAL_ENGLISH)


class TestFallbacks(unittest.TestCase):
    def test_every_tone_has_three_distinct_watch_safe_replies(self):
        for tone in Tone:
            rs = static_replies(tone)
            self.assertEqual(len(rs.replies), 3, tone)
            self.assertEqual([r.intent for r in rs.replies], list(Intent), tone)
            self.assertEqual(len(dedupe(rs.texts())), 3, tone)
            self.assertFalse(rs.from_ai, tone)
            for text in rs.texts():
                self.assertTrue(text)
                self.assertLessEqual(len(text), WATCH_REPLY_MAX_CHARS, (tone, text))
                self.assertTrue(text.isascii(), (tone, text))


class TestGenerate(unittest.TestCase):
    msg = IncomingMessage("Rahul", "kal office aa rahe ho?", app="com.whatsapp")

    def test_happy_path(self):
        raw = groq_response({
            "positive": "Haan aa raha hu",
            "neutral": "Abhi confirm nahi",
            "decline": "Nahi kal nahi aa payega",
        })
        res = generate(self.msg, transport=transport_returning(raw), api_key="k")
        self.assertTrue(res.reply_set.from_ai)
        self.assertIsNone(res.error)
        self.assertEqual(res.reply_set.texts()[0], "Haan aa raha hu")
        self.assertEqual(res.reply_set.tone, Tone.CASUAL_HINGLISH)

    def test_missing_api_key_falls_back_without_calling_transport(self):
        def explode(*a):
            self.fail("transport must not be called without a key")
        res = generate(self.msg, transport=explode, api_key="")
        self.assertFalse(res.reply_set.from_ai)
        self.assertEqual(res.error, "no api key")

    def test_timeout_falls_back(self):
        res = generate(self.msg, transport=transport_raising(OSError("timed out")),
                       api_key="k")
        self.assertFalse(res.reply_set.from_ai)
        self.assertIn("transport", res.error)
        self.assertEqual(len(res.reply_set.replies), 3)

    def test_malformed_json_falls_back(self):
        res = generate(self.msg, transport=transport_returning("not json"), api_key="k")
        self.assertFalse(res.reply_set.from_ai)

    def test_missing_intent_falls_back(self):
        raw = groq_response({"positive": "ok", "neutral": "hmm"})  # no decline
        res = generate(self.msg, transport=transport_returning(raw), api_key="k")
        self.assertFalse(res.reply_set.from_ai)

    def test_three_identical_replies_rejected(self):
        raw = groq_response({"positive": "Ok", "neutral": "ok!", "decline": "OK"})
        res = generate(self.msg, transport=transport_returning(raw), api_key="k")
        self.assertFalse(res.reply_set.from_ai)
        self.assertEqual(res.error, "unusable model output")

    def test_overlong_model_output_is_truncated_not_rejected(self):
        raw = groq_response({
            "positive": "yes absolutely that works perfectly for me and everyone",
            "neutral": "let me check my calendar and come back to you later today",
            "decline": "unfortunately I cannot make that work at all this week",
        })
        res = generate(self.msg, transport=transport_returning(raw), api_key="k")
        self.assertTrue(res.reply_set.from_ai)
        for text in res.reply_set.texts():
            self.assertLessEqual(len(text), WATCH_REPLY_MAX_CHARS)

    def test_emoji_from_model_never_reaches_the_watch(self):
        raw = groq_response({
            "positive": "Sure \U0001F44D", "neutral": "Maybe \U0001F914",
            "decline": "Nope \U0001F645",
        })
        res = generate(self.msg, transport=transport_returning(raw), api_key="k")
        for text in res.reply_set.texts():
            self.assertTrue(text.isascii(), text)

    def test_always_three_replies_whatever_happens(self):
        cases = [
            transport_returning("garbage"),
            transport_raising(OSError("down")),
            transport_returning(groq_response({})),
            transport_returning(groq_response({"positive": 1, "neutral": 2, "decline": 3})),
        ]
        for t in cases:
            res = generate(self.msg, transport=t, api_key="k")
            self.assertEqual(len(res.reply_set.replies), 3)
            self.assertEqual([r.intent for r in res.reply_set.replies], list(Intent))

    def test_prompt_carries_the_length_cap(self):
        self.assertIn(str(WATCH_REPLY_MAX_CHARS), build_system_prompt(Tone.PROFESSIONAL))


if __name__ == "__main__":
    unittest.main()
