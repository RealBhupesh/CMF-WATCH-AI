"""Core types for the reply engine.

Deliberately free of Android and BLE concerns: this layer is needed whichever
way F1 lands (see PRD.md), so it must not depend on the answer.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional


class Intent(Enum):
    """The three replies we always offer, one per intent."""

    POSITIVE = "positive"
    NEUTRAL = "neutral"
    DECLINE = "decline"


class Tone(Enum):
    """How the reply should sound. Inferred from the thread, never guessed at random."""

    CASUAL_HINGLISH = "casual_hinglish"
    CASUAL_ENGLISH = "casual_english"
    PROFESSIONAL = "professional"


@dataclass(frozen=True)
class IncomingMessage:
    """One notification-derived message."""

    sender: str
    body: str
    app: str  # package name, e.g. "com.whatsapp"
    # Prior messages in the same thread, oldest first. Notification-derived, so
    # this is best-effort and often empty -- the engine must work with none.
    history: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class Reply:
    text: str
    intent: Intent


@dataclass(frozen=True)
class ReplySet:
    """Exactly three replies, ready to write to the watch.

    `from_ai` is False when generation failed and we fell back to static text.
    The UI must not imply intelligence we did not deliver.
    """

    replies: List[Reply]
    tone: Tone
    from_ai: bool

    def texts(self) -> List[str]:
        return [r.text for r in self.replies]


@dataclass(frozen=True)
class GenerationResult:
    reply_set: ReplySet
    latency_ms: int
    error: Optional[str] = None
