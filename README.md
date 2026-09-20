# BLE Reverse Engineering — CMF Watch Pro 2

Workspace for WatchAI v1 (see [PRD.md](PRD.md)).

## Status

- PRD committed, resequenced around the F1 gate. No app code yet — and none until M0 answers F1.
- **M0 needs no Android toolchain.** The old JDK/Gradle/Android SDK blocker applies to M2 onward, not to now.

## M0 — the only thing that matters right now

M0 answers one question: *can the phone write arbitrary quick replies to the watch,
and does the watch tell the phone which one was tapped?* If the answer is no, the
product changes shape. Everything else is ordinary engineering.

### Setup (once)

```bash
brew install --cask android-platform-tools && brew install wireshark
```

`android-platform-tools` gives `adb`; `wireshark` gives `tshark`. Neither needs sudo
for what M0 does (we only read capture files, never capture live on the Mac).

On the phone: Developer options → USB debugging, **and** Developer options →
Bluetooth HCI snoop log → Enabled. The snoop setting only takes effect after the
Bluetooth stack restarts — toggle Bluetooth fully off and on, or reboot.

```bash
adb devices   # must show the device as 'device', not 'unauthorized'
```

### Capture 01 — look at the watch (no tooling)

Send yourself a WhatsApp message. Does the watch offer a reply at all? Then the
same for an SMS. Write both answers in [notes/m0-findings.md](notes/m0-findings.md).
This costs two minutes and can save two weeks.

### Capture 02 — `QUICK_REPLY_SET`

In the companion app, set a quick reply to a distinctive marker like `ZZMARKER1`,
so it is trivially greppable in the capture.

```bash
tools/pull-hci-log.sh 02-quick-reply-set
tools/att-writes.sh   02-quick-reply-set ZZMARKER1
```

### Capture 03 — the reverse event

Tap a reply on the watch against a real SMS.

```bash
tools/pull-hci-log.sh 03-reply-tapped
tools/att-writes.sh   03-reply-tapped
```

`-->` frames are phone→watch; `<--` frames are watch→phone. The `<--` ones are F1(b).

### Resolving handles to UUIDs

The snoop shows ATT handles. To write from your own code you need UUIDs. Turn
Bluetooth **off on the phone** first — the watch takes one connection and the
companion app is holding it.

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install bleak
python3 tools/gatt-dump.py --scan
python3 tools/gatt-dump.py --address <ADDR>
```

### Exit criteria

[notes/m0-findings.md](notes/m0-findings.md) has the protocol table filled from
observed bytes and an F1 verdict of `GO`, `SMS-ONLY` or `NO-REVERSE-CHANNEL`.
Record only what was seen — never guess a field.

## Prior art

[Gadgetbridge](https://gadgetbridge.org/gadgets/wearables/nothing/) has a CMF Watch
Pro / Pro 2 driver with auth, pairing, notifications, music and activity sync
already reverse-engineered. Quick reply is **not** in it. Start from their framing
rather than from a blank nRF Connect session; GPLv3, so fine to learn from and
build on privately.

## Layout

```
PRD.md                  product definition, F1 gate, fallback branches
notes/m0-findings.md    the M0 record — protocol facts live here
tools/                  M0 capture + analysis scripts
captures/               raw btsnoop logs (gitignored)
app/                    Android app — empty until M2
```
