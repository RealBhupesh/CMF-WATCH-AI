# M0 Findings — F1 go/no-go

> Record **observed bytes only**. If something was not seen in a capture, it stays `TBD`.
> A guess written here becomes a fact three weeks from now, which is how a month gets lost.

Date started: TBD
Watch firmware version: TBD
Companion app + version used for capture: TBD  ← pin this; CMF is folding into Nothing X
Phone: iQOO Neo 10, Android TBD

---

## Capture 01 — Does WhatsApp even offer a reply on the watch?

No code, no tooling. Send yourself a WhatsApp message, look at the watch, try to reply.

- Reply affordance shown on **SMS** notification: TBD (yes/no)
- Reply affordance shown on **WhatsApp** notification: TBD (yes/no)
- If yes: does sending actually work? TBD
- Number of canned replies the watch displays: TBD
- Notes:

**This single answer determines which product v1 is.** See "If F1 fails" in PRD.md.

---

## Capture 02 — `QUICK_REPLY_SET`

Set a quick reply in the companion app to a distinctive marker (e.g. `ZZMARKER1`)
so it is greppable in the capture.

```
tools/pull-hci-log.sh 02-quick-reply-set
tools/att-writes.sh 02-quick-reply-set ZZMARKER1
```

- Marker string found in capture: TBD (yes/no)
- Encoding (ASCII / UTF-8 / UTF-16 / length-prefixed): TBD
- Write characteristic handle: TBD
- Write characteristic UUID (from `tools/gatt-dump.py`): TBD
- Opcode byte(s): TBD
- Full payload layout:

```
TBD — annotate the hex, byte by byte, only where the meaning was observed
```

- Are all replies written as one packet or one each? TBD
- Max replies accepted: TBD
- Max bytes per reply: TBD

---

## Capture 03 — reply-tapped reverse event

Tap a reply on the watch against a real SMS while capturing.

```
tools/pull-hci-log.sh 03-reply-tapped
tools/att-writes.sh 03-reply-tapped
```

Look for `<--` (NOTIFY/INDICATE) frames — those are watch→phone.

- Reverse event observed at all: TBD (yes/no)   ← **this is F1(b)**
- Notify characteristic handle / UUID: TBD
- Opcode byte(s): TBD
- Does the event carry the reply **text**, or only an **index**? TBD
- Does it carry a notification id / correlation key? TBD
- Does it carry the destination (phone number / contact)? TBD
- Full payload layout:

```
TBD
```

---

## F1 verdict

- **F1(a)** phone can write an arbitrary reply list: TBD
- **F1(b)** watch emits an identifiable tap event: TBD

**Verdict:** TBD — one of `GO` / `SMS-ONLY` / `NO-REVERSE-CHANNEL`

**Therefore v1 is:** TBD (name the PRD fallback branch taken)

Decided by: TBD on TBD
