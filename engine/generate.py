"""Reply generation: Groq when it answers in time, static fallback when it doesn't.

Stdlib only -- no `requests`, no `groq` SDK -- so this runs and is testable on a
bare Mac. The network call goes through an injectable `transport` so the tests
never touch the internet and never need an API key.

The API key is read from the environment here because this module is intended to
run in the backend proxy, not in the APK (PRD scope item 6).
"""

import json
import os
import time
import urllib.error
import urllib.request
from typing import Callable, Dict, List, Optional

from .model import GenerationResult, IncomingMessage, Intent, Reply, ReplySet, Tone
from .prompt import build_system_prompt, build_user_prompt, infer_tone
from .sanitize import dedupe, sanitize_reply

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")

# PRD latency budget allows 1200ms for generation. Past that the user has
# probably already looked at the watch, so stale AI replies are worth less than
# instant static ones.
TIMEOUT_S = 1.2

# Static fallbacks. Every tone x intent covered: this path runs whenever the
# network, the key, the model or the budget fails, which is not a rare case.
_FALLBACKS: Dict[Tone, Dict[Intent, str]] = {
    Tone.CASUAL_HINGLISH: {
        Intent.POSITIVE: "Haan theek hai",
        Intent.NEUTRAL: "Abhi busy hu, baad mein baat karte hai",
        Intent.DECLINE: "Nahi yaar, aaj nahi ho payega",
    },
    Tone.CASUAL_ENGLISH: {
        Intent.POSITIVE: "Yeah sounds good",
        Intent.NEUTRAL: "Busy right now, will get back to you",
        Intent.DECLINE: "Can't today, sorry",
    },
    Tone.PROFESSIONAL: {
        Intent.POSITIVE: "Yes, that works for me.",
        Intent.NEUTRAL: "Noted. I will follow up shortly.",
        Intent.DECLINE: "I am not available for that, apologies.",
    },
}

Transport = Callable[[str, dict, dict, float], str]


def _http_post(url: str, headers: dict, payload: dict, timeout: float) -> str:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8")


def static_replies(tone: Tone) -> ReplySet:
    table = _FALLBACKS[tone]
    return ReplySet(
        replies=[Reply(sanitize_reply(table[i]), i) for i in Intent],
        tone=tone,
        from_ai=False,
    )


def _parse_model_output(raw: str, tone: Tone) -> Optional[ReplySet]:
    """Turn the model's JSON into a validated ReplySet, or None if unusable.

    Returning None rather than raising keeps the caller's fallback path single.
    """
    try:
        envelope = json.loads(raw)
        content = envelope["choices"][0]["message"]["content"]
        obj = json.loads(content)
    except (ValueError, KeyError, IndexError, TypeError):
        return None

    if not isinstance(obj, dict):
        return None

    replies: List[Reply] = []
    for intent in Intent:
        text = obj.get(intent.value)
        if not isinstance(text, str):
            return None
        clean = sanitize_reply(text)
        if not clean:
            return None
        replies.append(Reply(clean, intent))

    # Three slots that say the same thing is a failed generation, not a partial
    # success -- the static set is more useful than one real choice plus two
    # echoes of it.
    if len(dedupe([r.text for r in replies])) != len(list(Intent)):
        return None

    return ReplySet(replies=replies, tone=tone, from_ai=True)


def generate(
    msg: IncomingMessage,
    transport: Optional[Transport] = None,
    api_key: Optional[str] = None,
    model: str = DEFAULT_MODEL,
    timeout_s: float = TIMEOUT_S,
) -> GenerationResult:
    """Produce three watch-ready replies. Never raises, never returns fewer than three."""
    started = time.monotonic()
    tone = infer_tone(msg)

    def done(reply_set: ReplySet, error: Optional[str] = None) -> GenerationResult:
        elapsed = int((time.monotonic() - started) * 1000)
        return GenerationResult(reply_set=reply_set, latency_ms=elapsed, error=error)

    key = api_key if api_key is not None else os.environ.get("GROQ_API_KEY")
    if not key:
        return done(static_replies(tone), "no api key")

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": build_system_prompt(tone)},
            {"role": "user", "content": build_user_prompt(msg)},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.7,
        "max_tokens": 200,
    }
    headers = {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
    }

    post = transport or _http_post
    try:
        raw = post(GROQ_URL, headers, payload, timeout_s)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return done(static_replies(tone), "transport: {}".format(exc))

    parsed = _parse_model_output(raw, tone)
    if parsed is None:
        return done(static_replies(tone), "unusable model output")

    return done(parsed)
