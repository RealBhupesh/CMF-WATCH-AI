#!/usr/bin/env bash
# Pull the Bluetooth HCI snoop log off the phone.
#
# On Android 9+ /data/misc/bluetooth/logs/btsnoop_hci.log is not readable via
# `adb pull` without root, so we go through `adb bugreport`, which packages it.
#
# Usage: tools/pull-hci-log.sh <capture-name>
#   e.g. tools/pull-hci-log.sh 02-quick-reply-set

set -euo pipefail

NAME="${1:-}"
if [[ -z "$NAME" ]]; then
  echo "usage: $0 <capture-name>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/captures/$NAME"
mkdir -p "$OUT"

if ! adb get-state >/dev/null 2>&1; then
  echo "No device via adb. Check: USB debugging on, cable connected, 'adb devices' authorised." >&2
  exit 1
fi

echo "==> Taking bugreport (slow, ~1-3 min)"
adb bugreport "$OUT/bugreport.zip"

echo "==> Extracting btsnoop"
# Path inside the zip has varied across Android versions; match loosely.
SNOOP_PATH="$(unzip -Z1 "$OUT/bugreport.zip" | grep -i 'btsnoop.*\.log$' | head -1 || true)"
if [[ -z "$SNOOP_PATH" ]]; then
  echo "No btsnoop log inside the bugreport." >&2
  echo "Enable Developer options -> Bluetooth HCI snoop log, then FULLY toggle Bluetooth off/on" >&2
  echo "(the setting only takes effect on the next Bluetooth stack restart), reproduce, and retry." >&2
  exit 1
fi

unzip -p "$OUT/bugreport.zip" "$SNOOP_PATH" > "$OUT/btsnoop_hci.log"
echo "==> $OUT/btsnoop_hci.log ($(wc -c < "$OUT/btsnoop_hci.log") bytes)"
echo "Next: tools/att-writes.sh $NAME"
