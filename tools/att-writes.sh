#!/usr/bin/env bash
# Dump every ATT operation from a capture as: frame, direction, handle, hex payload, ASCII.
#
# This is the whole of M0 analysis. Run it on capture 02 (quick-reply-set) and
# capture 03 (reply-tapped), then look for your marker strings.
#
# Usage: tools/att-writes.sh <capture-name> [ascii-filter]
#   tools/att-writes.sh 02-quick-reply-set
#   tools/att-writes.sh 02-quick-reply-set ZZMARKER

set -euo pipefail

NAME="${1:-}"
FILTER="${2:-}"
if [[ -z "$NAME" ]]; then
  echo "usage: $0 <capture-name> [ascii-filter]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/captures/$NAME/btsnoop_hci.log"
[[ -f "$LOG" ]] || { echo "No capture at $LOG — run tools/pull-hci-log.sh $NAME first" >&2; exit 1; }

command -v tshark >/dev/null || { echo "tshark not found: brew install wireshark" >&2; exit 1; }

tshark -r "$LOG" \
  -Y 'btatt.opcode && btatt.value' \
  -T fields -E separator=/t \
  -e frame.number \
  -e btatt.opcode \
  -e btatt.handle \
  -e btatt.value \
2>/dev/null | python3 -c '
import sys

OPCODES = {
    "0x12": "WRITE_REQ", "0x52": "WRITE_CMD",
    "0x1b": "NOTIFY",    "0x1d": "INDICATE",
    "0x0b": "READ_RSP",
}
needle = sys.argv[1].lower() if len(sys.argv) > 1 else None

for line in sys.stdin:
    parts = line.rstrip("\n").split("\t")
    if len(parts) < 4:
        continue
    frame, opcode, handle, value = parts[:4]
    raw = value.replace(":", "")
    try:
        data = bytes.fromhex(raw)
    except ValueError:
        continue
    ascii_ = "".join(chr(b) if 32 <= b < 127 else "." for b in data)
    if needle and needle not in ascii_.lower() and needle not in raw.lower():
        continue
    op = OPCODES.get(opcode.lower(), opcode)
    # Direction matters: WRITE_* is phone->watch, NOTIFY/INDICATE is watch->phone.
    arrow = "<--" if op in ("NOTIFY", "INDICATE") else "-->"
    print(f"{frame:>7}  {arrow} {op:<10} h={handle:<6} len={len(data):<4} {raw}")
    print(f"{'':>7}      {'':<10} {'':<8} {'':<8} |{ascii_}|")
' ${FILTER:+"$FILTER"}
