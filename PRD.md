# WatchAI v1 PRD

## Goal

Turn the CMF Watch Pro 2 + iQOO Neo 10 into an AI-enhanced smartwatch without modifying watch firmware.

Core loop: notification → parse → AI reply generation (Groq) → BLE push of 3 contextual replies → tap on watch → event back to phone → Android `RemoteInput` sends via WhatsApp.

## The assumption this project rests on

Everything below is conditional on **F1**, stated here so it is impossible to skip:

> **F1** — Stock CMF Watch Pro 2 firmware (a) accepts an arbitrary quick-reply list written over BLE, and (b) emits an event back to the phone when the user taps one, carrying enough information to identify which notification it answers.

What is known today:

- CMF documents quick reply as **"Quick Android SMS Replies"**, configured in the companion app. The reverse channel therefore exists in some form — the phone has to receive the chosen text in order to send the SMS. Whether it is offered for non-SMS notifications (WhatsApp) is **unverified**.
- Gadgetbridge's CMF Watch Pro / Pro 2 driver covers auth, notifications, music, activity sync, alarms and contacts. **Quick reply is not in it.** The framing and pairing are solved for us; this opcode pair is not.

F1 is not a milestone. It is a gate. M0 exists only to answer it, and no work past M0 starts until it is answered in writing in `notes/m0-findings.md`.

## v1 Scope

1. **AI Smart Replies** — 3 distinct AI replies (positive/neutral/decline), tone-matched to sender and message (casual Hinglish vs professional English).
2. **Watch Interface** — watch firmware stays stock. WatchAI writes quick replies over BLE.
3. **Companion replacement** — WatchAI **replaces** the CMF/Nothing X app as the connected companion. It does not coexist with it. A single companion holds the link; two contending for it fails non-deterministically. This means WatchAI inherits time sync, notification forwarding and connection upkeep — real scope, budgeted in M2.
4. **Sending** — watch tap → detect selection → `RemoteInput` reply through the messaging app.
5. **Context Engine** — sender + current notification + recent notification-derived messages + app + user prefs. No unnecessary storage.
6. **Privacy** — ephemeral processing; API keys live in a tiny backend proxy, never in the APK. Per-contact opt-out, since message text leaves the device.
7. **Failure Handling** — AI down → static fallback replies; BLE fail → leave existing defaults; unsupported `RemoteInput` → show but don't claim sent.

## Architecture

```
Messaging apps → NotificationListenerService → Message Parser → Context Engine
→ Groq API → WatchAI BLE Layer → CMF Watch Pro 2
```

Watch tap → BLE event → identify notification → `RemoteInput` → messaging app.

### Protocol data model

To be filled in by M0 from **observed bytes only**. Never guessed, never inferred from other vendors' protocols.

| Field | Value | Source capture |
|---|---|---|
| Service UUID | TBD | |
| Write characteristic | TBD | |
| Notify characteristic | TBD | |
| `QUICK_REPLY_SET` opcode + payload layout | TBD | |
| Reply-tapped event opcode + payload layout | TBD | |
| Notification correlation key (if any) | TBD | |
| Max replies, max bytes per reply, encoding | TBD | |

## Development Milestones

**M0 — F1 go/no-go (gate).** Three captures, no app code, no Android toolchain:
  1. Watch shows a reply affordance on a WhatsApp notification — yes/no, observed on the physical watch.
  2. HCI snoop of the CMF app writing a custom quick-reply string → `QUICK_REPLY_SET` layout.
  3. HCI snoop of a reply tapped on the watch → reverse event layout and correlation key.
  Exit: `notes/m0-findings.md` fills in the protocol table above and records an F1 verdict.

**M1** Replay — write our own reply list from the Mac over BLE, confirm it renders on the watch.
**M2** Companion replacement: pairing, auth, time sync, notification forward (Android app begins here).
**M3** Capture incoming Android messages via `NotificationListenerService`.
**M4** Groq-generated replies (proxy backend).
**M5** Push generated replies to watch within the latency budget.
**M6** Detect selected watch reply, correlate to source notification.
**M7** Send via `RemoteInput`.
**M8** Production smart replies.
**M9** Notification summarization (Phase 2).
**M10** Voice assistant (Phase 3).

## If F1 fails

A negative M0 does not end the project; it changes the product. Decided now so a bad result doesn't become a dead repo.

- **F1b fails (no reverse channel at all)** → v1 becomes read-only: AI-drafted replies surface on the phone's notification shade as `RemoteInput` actions, watch shows the message only. Loses "phone stays in pocket."
- **Reply works but is SMS-scoped** → ship SMS end-to-end as v1, and treat WhatsApp as a Phase 2 problem requiring either a notification-shape trick or full companion replacement.
- **Correlation key is absent** (watch returns text with no notification id) → fall back to "most recent repliable notification" heuristic, with a hard rule: never claim sent when ambiguous.

## Latency budget

The Groq round-trip has to finish before the user taps, or they see stale replies. Budget, notification arrival → replies rendered on watch:

| Stage | Target |
|---|---|
| Notification parse + context assembly | 100 ms |
| Groq generation | 1200 ms |
| BLE write + watch render | 500 ms |
| **Total** | **< 2 s** |

Exceeded → push static fallback replies immediately, replace with AI replies if they arrive in time.

## v1 Success

Message arrives → within 2 seconds watch shows 3 AI replies → tap one → exact reply sent, phone stays in pocket.

## Risks

- **Moving target.** The CMF app is being folded into Nothing X. Pin and archive the APK version used for M0 captures; protocol may shift under a forced update.
- **Companion replacement is all-or-nothing.** Once WatchAI holds the link, anything the stock app did that we don't implement simply stops working for the user.
- **Legal.** Reverse engineering for personal interoperability. Gadgetbridge is GPLv3 — fine to learn from and to build on privately; matters if this is ever distributed.
