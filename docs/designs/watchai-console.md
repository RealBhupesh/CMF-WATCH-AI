# WatchAI Console — design

Status: approved 2026-10-29
Scope: Phase 1 (hosted dashboard + Mac BLE lab). The Android companion is a later phase.

## Goal

Give WatchAI a hosted control center for AI reply generation, device management, privacy
settings, and BLE protocol work — deployable on Cloudflare's free tier. The Mac is the
browser and, for lab work, the BLE radio. The phone remains the daily notification bridge.

## Non-goals for Phase 1

- No automatic notification capture on the phone.
- No automatic quick-reply writes to the watch.
- No Android app.
- No message-body storage anywhere.
- No multi-user support. One owner, one deployment.

## Architecture

```
Mac Chrome ──HTTPS──> watchai.<domain> ──┐
   │                                      ├── Cloudflare Worker (TypeScript)
   └──Web Bluetooth──> CMF Watch Pro 2    │      ├── D1
                                          │      ├── Groq API (secret)
Android app ──HTTPS──> api.<domain> ──────┘      └── static dashboard assets
```

- One Worker, two hostnames.
- `watchai.<domain>`: dashboard + `/admin/api/*`, protected by Cloudflare Access.
- `api.<domain>`: `/v1/*`, protected by per-device bearer tokens.
- `/healthz` is public on both and returns no secrets.
- Host guard: admin routes are 404 on the API host; phone routes are 404 on the dashboard host.
- `workers.dev` disabled in production. The Worker verifies the Access JWT itself, so a
  direct hit fails closed.

## Repository layout

```
console/
  package.json                 workspace root
  wrangler.jsonc               Worker config, D1 binding, assets, cron
  worker/
    src/
      index.ts                 Hono app, host guard, middleware
      auth/access.ts           Access JWT verification
      auth/device.ts           device token issue/verify
      db/queries.ts            prepared statements
      engine/                  TypeScript port of engine/
      routes/admin.ts
      routes/v1.ts
      lib/                     validation, rate limit, http helpers
    test/                      Vitest + Workers pool
  dashboard/
    src/
      pages/                   Overview, Playground, Devices, Lab, Activity, Settings
      components/
      lib/                     api client, BLE wrapper, formatting
      styles.css
```

The Python `engine/`, `proxy/`, and `tests/` stay untouched as the reference implementation
and local CLI. The deployed engine is the TypeScript port; logic changes must update both
until the Python engine is explicitly retired.

## Dashboard pages

### Overview
Worker/Groq/D1 status, devices online, replies today, AI success rate, p50/p95 latency,
fallback count, 24-hour latency sparkline, recent metadata-only events, onboarding checklist
when empty.

### Playground
Sender, app, message, optional history. Generates exactly three replies (positive, neutral,
decline) with tone, latency, and an honest `from_ai` badge. `Cmd+Enter` submits. Copy per
reply. "Send to Device Lab" keeps the reply set in app state. A privacy note states that the
message is processed in memory and never stored.

### Devices
Generate one-time enrollment code (10 characters, 10-minute expiry) and a QR encoding
`watchai://enroll?code=...&api=...`. List devices with last seen, watch name, firmware,
battery, status. Revoke one or all. Empty state explains the Android app is Phase 3.

### Device Lab
Chrome/Edge Web Bluetooth only. Scan, connect, enumerate GATT services/characteristics,
read/write/notify, raw frame composer (UTF-8 or hex, optional prefix/suffix), saved write
recipes in localStorage, live log with export. "Send from Playground" writes a selected
reply through a saved recipe. A persistent warning says the protocol is unverified until M0.
Phone-conflict checklist: turn off phone Bluetooth or force-stop the companion before
scanning; re-enable afterwards.

### Activity
Metadata-only table: time, source (phone/playground/lab), app, sender alias, latency,
AI/fallback, reply count, outcome. Filters, pagination, CSV export. No message bodies.

### Settings
Groq model ID, forced tone or auto, per-contact opt-outs, retention days, revoke all
devices, delete all events. "Store message bodies" is shown disabled with an explanation.

## API contract

### Public

- `GET /healthz` → `{ ok: true, version }`

### Phone (`api.<domain>`, device bearer)

- `POST /v1/enroll` `{ code, name, platform, app_version }`
  → `{ device_id, token, api_origin }` (token shown once)
- `POST /v1/replies` `{ sender, body, app, history? }`
  → `{ replies: [{ intent, text }], tone, from_ai, latency_ms }`
  - 30 requests/minute/device, 16 KB body cap, history max 10.
  - Opted-out sender → `403 { error: "opted_out" }` without calling Groq.
- `POST /v1/events` `{ app, sender_alias, latency_ms, from_ai, reply_count, outcome }`
  → `{ ok: true }`
- `GET /v1/me` → `{ device, settings }`; updates last seen.
- `POST /v1/heartbeat` `{ watch_name?, watch_firmware?, battery? }` → `{ ok: true }`
- `POST /v1/unenroll` → `{ ok: true }`

### Admin (`watchai.<domain>`, Access)

- `GET /admin/api/overview`
- `GET /admin/api/events?limit&offset&source&app&from_ai&outcome`
- `GET /admin/api/settings`, `PUT /admin/api/settings`
- `GET /admin/api/devices`
- `POST /admin/api/enrollment-codes` → `{ code, expires_at }`
- `DELETE /admin/api/devices/:id`
- `POST /admin/api/devices/revoke-all`
- `DELETE /admin/api/events`
- `POST /admin/api/playground` `{ sender, body, app, history?, tone? }`
  → replies + `event_id`

## Data model (D1)

`devices`: id, name, token_hash, platform, app_version, watch_name, watch_firmware,
battery, last_seen_at, created_at, revoked_at.

`enrollment_codes`: code_hash, expires_at, used_at, created_at.

`settings` (singleton id=1): model, forced_tone, opt_outs JSON, retention_days, updated_at.

`events`: id, device_id, source, app, sender_alias, latency_ms, from_ai, reply_count,
outcome, created_at. **No body column.**

`rate_limits`: key, window_start, count.

Cron daily: delete events past retention, expired enrollment codes, and stale rate-limit rows.

## Auth

### Dashboard
Cloudflare Access self-hosted application on `watchai.<domain>`. The Worker verifies
`Cf-Access-Jwt-Assertion` against the team JWKS, issuer, and audience. Missing/invalid JWT
→ 401. Production fails closed if Access config is absent. Local dev uses `AUTH_MODE=dev`
and a visible dev banner.

### Phone
Token format `wai_` + 32 random bytes base64url. Stored as SHA-256(pepper + token); only the
hash is persisted. Revocation is immediate. Enrollment codes are hashed, one-time, and
expire in 10 minutes.

## Privacy

- Bodies exist only in the request and the Groq call. Never logged, never written to D1.
- Activity stores sender aliases only.
- Opt-outs are enforced on the phone before transmission and re-checked by the Worker.
- Outbound calls: Groq only. No analytics, no third-party scripts.
- Logs contain request id, route, status, latency, device id; never body/sender/message.

## Engine port

Mirror the Python engine exactly:

- Tone inference: professional apps win; Hinglish marker count over history + body.
- Prompts: same system/user text, 40-char ASCII cap.
- Sanitize: smart punctuation, NFKD accent folding, ASCII filter, whitespace collapse,
  word-boundary truncation, trailing punctuation strip.
- Dedupe: case/punctuation-insensitive.
- Static fallbacks for every tone × intent.
- Groq call with 1200 ms timeout, JSON object response, `from_ai` false on any failure.
- `generate()` never throws and always returns three replies.

Add a forced-tone override for Settings/Playground without changing auto inference.

## Device Lab notes

- Web Bluetooth is available in Chrome/Edge on macOS over HTTPS or localhost.
- The watch holds one companion connection; the phone must release it.
- Until M0, the lab writes raw frames only. A saved recipe is a service UUID,
  characteristic UUID, encoding, and optional prefix/suffix hex.
- If Web Bluetooth cannot access the watch's services, the fallback is the existing
  `tools/gatt-dump.py` / `bleak` CLI; a local native helper can be added later.

## Deployment

- Cloudflare free tier: Workers 100k requests/day, D1 5 GB, Access 50 users, cron included.
- `wrangler d1 create watchai-console`, apply migrations, set secrets
  `GROQ_API_KEY` and `TOKEN_PEPPER`.
- Custom domains: `watchai.<domain>` and `api.<domain>`; `workers_dev = false`.
- Access: self-hosted app for the dashboard host, allow owner email; copy the AUD tag into
  `ACCESS_AUD` and the team domain into `ACCESS_TEAM_DOMAIN`.
- Verification: health check, enrollment via curl, Playground generation, Access login,
  Device Lab on real hardware.

## Roadmap after Phase 1

1. M0 captures using the Device Lab + HCI tools; fill `notes/m0-findings.md`; F1 verdict.
2. Android companion: NotificationListenerService, backend client, BLE quick-reply write,
   tap correlation, RemoteInput send. Its own spec.
3. Daily-loop hardening and optional hosting upgrades.

## Risks

- F1 is unanswered; automatic watch replies depend on it.
- Web Bluetooth may not see a bonded watch; CLI fallback exists.
- The Android companion is the real daily bridge and is a separate substantial build.
- Groq free-tier latency/quota can change; fallbacks keep the UX honest.
- Cloudflare Access setup is manual and must fail closed if misconfigured.
