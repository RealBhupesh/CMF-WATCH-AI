"""Make model output safe to write to the watch.

The watch's accepted encoding and per-reply byte limit are TBD until M0
(see the protocol table in PRD.md). Until they are observed, we assume the
strictest plausible case -- ASCII-only, short -- because a reply that renders
as mojibake on the watch is worse than a blunter reply that renders.

When M0 fills in the real limits, relax WATCH_REPLY_MAX_CHARS and ASCII_ONLY
rather than scattering new rules through the generator.
"""

import re
import unicodedata
from typing import List

# Conservative until M0 observes the real cap. The watch face is small and the
# protocol's length field width is unknown.
WATCH_REPLY_MAX_CHARS = 40

# Assume the firmware is ASCII-only until a capture proves otherwise.
ASCII_ONLY = True

# Latin-script Hinglish survives ASCII folding fine ("theek hai"), which is why
# the tone is worth keeping even under this constraint. Devanagari does not.
_SMART_PUNCT = {
    "‘": "'", "’": "'",
    "“": '"', "”": '"',
    "–": "-", "—": "-",
    "…": "...",
    " ": " ",
}

_WHITESPACE = re.compile(r"\s+")


def _fold_to_ascii(text: str) -> str:
    """Strip accents and drop anything still non-ASCII (emoji, CJK, Devanagari)."""
    for bad, good in _SMART_PUNCT.items():
        text = text.replace(bad, good)
    # NFKD splits accented chars into base + combining mark; dropping the marks
    # turns "café" into "cafe" rather than deleting the letter outright.
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return stripped.encode("ascii", "ignore").decode("ascii")


def _truncate(text: str, limit: int) -> str:
    """Cut to `limit`, preferring a word boundary over a mid-word chop."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    # Only honour the word boundary if it doesn't gut the reply.
    if space >= limit // 2:
        cut = cut[:space]
    return cut.rstrip(" ,;:-")


def sanitize_reply(text: str) -> str:
    """Normalise one reply to something the watch can certainly render."""
    text = text.strip().strip('"').strip()
    if ASCII_ONLY:
        text = _fold_to_ascii(text)
    text = _WHITESPACE.sub(" ", text).strip()
    return _truncate(text, WATCH_REPLY_MAX_CHARS)


def dedupe(texts: List[str]) -> List[str]:
    """Drop near-duplicates, preserving order.

    Three replies that all mean "yes" waste two of the three slots, which is the
    entire product. Compared case- and punctuation-insensitively.
    """
    seen = set()
    out = []
    for t in texts:
        key = re.sub(r"[^a-z0-9 ]", "", t.lower()).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(t)
    return out
