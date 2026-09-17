# WatchAI v1 PRD

## Goal

Turn the CMF Watch Pro 2 + iQOO Neo 10 into an AI-enhanced smartwatch without modifying watch firmware.

Core loop: notification → parse → AI reply generation (Groq) → BLE push of 3 contextual replies → tap on watch → event back to phone → Android `RemoteInput` sends via WhatsApp.

## v1 Scope

1. **AI Smart Replies** — 3 distinct AI replies (positive/neutral/decline), tone-matched to sender and message (casual Hinglish vs professional English).
2. **Watch Interface** — watch stays stock; WatchAI writes quick replies over BLE (coexists with CMF app first; becomes replacement companion if needed).
3. **Sending** — watch tap → detect selection → `RemoteInput` reply through the messaging app. This reverse direction (watch→phone) is the highest-priority hardware experiment.
4. **Context Engine** — sender + current notification + recent notification-derived messages + app + user prefs. No unnecessary storage.
5. **Privacy** — ephemeral processing; API keys live in a tiny backend proxy, never in the APK.
6. **Failure Handling** — AI down → static fallback replies; BLE fail → leave CMF defaults; unsupported `RemoteInput` → show but don't claim sent.

## Architecture

```
Messaging apps → NotificationListenerService → Message Parser → Context Engine
→ Groq API → WatchAI BLE Layer → CMF Watch Pro 2
```

Watch tap → BLE event → identify notification → `RemoteInput` → messaging app.

## Development Milestones

- **M0** CMF BLE connectivity test
- **M1** Dynamic quick-reply push test (QUICK_REPLY_SET)
- **M2** Capture incoming Android messages
- **M3** Groq-generated replies
- **M4** Push replies to watch
- **M5** Detect selected watch reply
- **M6** Send via RemoteInput
- **M7** Production smart replies
- **M8** Notification summarization (Phase 2)
- **M9** Voice assistant (Phase 3)

## v1 Success

Message arrives → within seconds watch shows 3 AI replies → tap one → exact reply sent, phone stays in pocket.
