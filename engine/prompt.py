"""Tone inference and prompt construction."""

import re
from typing import List

from .model import IncomingMessage, Tone
from .sanitize import WATCH_REPLY_MAX_CHARS

# Apps whose traffic is work by default.
_PROFESSIONAL_APPS = {
    "com.microsoft.teams",
    "com.slack",
    "com.google.android.gm",
    "com.linkedin.android",
    "com.microsoft.office.outlook",
}

# Latin-script Hinglish markers. Matched as whole words -- "hai" must not fire
# on "hair", and "ho" must not fire on "hotel".
_HINGLISH_MARKERS = {
    "hai", "haan", "nahi", "nahin", "kya", "kaise", "kab", "kahan", "theek",
    "thik", "acha", "accha", "yaar", "bhai", "arre", "abhi", "chal", "chalo",
    "karo", "kar", "raha", "rahi", "hoga", "hogi", "mat", "bas", "matlab",
    "kaam", "ghar", "aaj", "kal", "milte", "bhej", "bol", "bola", "dekh",
    "ho", "na", "ji", "ki", "ka", "ke", "mein", "tera", "tumhara", "apna",
}

_WORD = re.compile(r"[a-z]+")


def infer_tone(msg: IncomingMessage) -> Tone:
    """Pick the register to reply in.

    Order matters: a work app wins outright, because replying "haan bhai" to a
    Teams message is a worse failure than replying formally to a friend.
    """
    if msg.app in _PROFESSIONAL_APPS:
        return Tone.PROFESSIONAL

    # Weigh the whole thread, not just the latest message -- one-word messages
    # ("ok") carry almost no signal on their own.
    corpus = " ".join(msg.history + [msg.body]).lower()
    words = _WORD.findall(corpus)
    if not words:
        return Tone.CASUAL_ENGLISH

    hits = sum(1 for w in words if w in _HINGLISH_MARKERS)
    # Hinglish markers are common short words; a couple of incidental hits in a
    # long English message shouldn't flip the register.
    if hits >= 2 or (hits == 1 and len(words) <= 6):
        return Tone.CASUAL_HINGLISH
    return Tone.CASUAL_ENGLISH


_TONE_GUIDANCE = {
    Tone.CASUAL_HINGLISH: (
        "Casual Hinglish, Latin script only (never Devanagari). "
        "How a friend texts: 'haan theek hai', 'abhi busy hu', 'thoda late hounga'."
    ),
    Tone.CASUAL_ENGLISH: (
        "Casual English. Relaxed and short, how you'd text a friend. "
        "Contractions fine, no corporate phrasing."
    ),
    Tone.PROFESSIONAL: (
        "Professional English. Courteous and concise. "
        "No slang, no emoji, no exclamation marks."
    ),
}

SYSTEM_PROMPT = """You write smartwatch quick replies.

Output exactly three replies to the message, as JSON:
{{"positive": "...", "neutral": "...", "decline": "..."}}

positive = agree or accept. neutral = acknowledge or defer without committing.
decline = say no or not now, politely.

Hard rules:
- Each reply at most {max_chars} characters. They render on a watch face.
- ASCII characters only. No emoji.
- Reply as the RECIPIENT, in first person. Never restate the question.
- The three must be genuinely different choices, not rewordings.
- Tone: {tone_guidance}

Output the JSON object only."""


def build_system_prompt(tone: Tone) -> str:
    return SYSTEM_PROMPT.format(
        max_chars=WATCH_REPLY_MAX_CHARS,
        tone_guidance=_TONE_GUIDANCE[tone],
    )


def build_user_prompt(msg: IncomingMessage) -> str:
    lines: List[str] = []
    if msg.history:
        # Last few only: notification-derived history is unreliable, and stale
        # turns drag the reply off-topic.
        lines.append("Earlier in this thread:")
        for h in msg.history[-4:]:
            lines.append("  " + h)
        lines.append("")
    lines.append("From: " + msg.sender)
    lines.append("Message: " + msg.body)
    return "\n".join(lines)
