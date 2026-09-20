#!/usr/bin/env python3
"""Run the reply engine against a message and print what the watch would show.

Without GROQ_API_KEY set it exercises the static fallback path, which is worth
seeing on its own -- it is what ships whenever the network or the budget fails.

    python3 tools/reply-demo.py "kal office aa rahe ho?" --sender Rahul
    GROQ_API_KEY=... python3 tools/reply-demo.py "Can you review the deck?" \
        --app com.microsoft.teams
"""

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.generate import generate
from engine.model import IncomingMessage
from engine.sanitize import WATCH_REPLY_MAX_CHARS


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("body", help="the incoming message text")
    ap.add_argument("--sender", default="Rahul")
    ap.add_argument("--app", default="com.whatsapp")
    ap.add_argument("--history", nargs="*", default=[], help="earlier thread messages")
    args = ap.parse_args()

    msg = IncomingMessage(sender=args.sender, body=args.body,
                          app=args.app, history=args.history)
    res = generate(msg)

    source = "Groq" if res.reply_set.from_ai else "static fallback"
    print("from:    {} via {}".format(msg.sender, msg.app))
    print("message: {}".format(msg.body))
    print("tone:    {}".format(res.reply_set.tone.value))
    print("source:  {}{}".format(source, "  (" + res.error + ")" if res.error else ""))
    print("latency: {} ms  [budget 1200 ms for generation]".format(res.latency_ms))
    print()
    for reply in res.reply_set.replies:
        print("  [{:<8}] {:<{w}}  {:>2}/{}".format(
            reply.intent.value, reply.text, len(reply.text),
            WATCH_REPLY_MAX_CHARS, w=WATCH_REPLY_MAX_CHARS))

    if not os.environ.get("GROQ_API_KEY"):
        print("\nGROQ_API_KEY unset -- set it to exercise the real generation path.")


if __name__ == "__main__":
    main()
