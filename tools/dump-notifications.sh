#!/usr/bin/env bash
# Dump live notification extras from the phone.
#
# The M3 parser has to read sender and body out of WhatsApp's notification
# extras, and their exact shape varies by app version and Android version:
# android.text vs android.textLines vs android.messages, bundled summaries
# ("3 new messages"), and group conversations where the sender is embedded in
# the body. Guessing that shape is how the parser ends up wrong on real traffic.
#
# So: send yourself a message, leave it unread, and run this.
#
# Output lands in captures/ (gitignored) because it contains real message
# content and contact names. Paste only the anonymised field shapes into notes/.
#
# Usage: tools/dump-notifications.sh [name]

set -euo pipefail

NAME="${1:-notifications}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/captures/$NAME-$(date +%Y%m%d-%H%M%S).txt"
mkdir -p "$(dirname "$OUT")"

command -v adb >/dev/null || {
  echo "adb not found: brew install --cask android-platform-tools" >&2; exit 1; }

if ! adb get-state >/dev/null 2>&1; then
  echo "No device via adb. Check USB debugging is on and 'adb devices' is authorised." >&2
  exit 1
fi

# --noredact is what makes the extras readable; without it text shows as null.
# The service is 'notification' on most builds; some report it as
# 'notification_manager', so fall back rather than silently dumping nothing.
if ! adb shell dumpsys notification --noredact > "$OUT" 2>/dev/null || [[ ! -s "$OUT" ]]; then
  adb shell dumpsys notification_manager --noredact > "$OUT" 2>/dev/null || true
fi

if [[ ! -s "$OUT" ]]; then
  echo "Dump was empty. Requires an unread notification present on the device." >&2
  exit 1
fi

echo "==> $OUT ($(wc -l < "$OUT") lines)"
echo
echo "Fields the parser cares about:"
grep -nE 'android\.(title|text|textLines|messages|selfDisplayName|isGroupConversation)|^ *pkg=|RemoteInput' "$OUT" \
  | head -40 || echo "  (none matched -- check an unread message is actually present)"
echo
echo "RemoteInput presence decides whether M7 can send at all for that app:"
grep -c 'RemoteInput' "$OUT" || true
