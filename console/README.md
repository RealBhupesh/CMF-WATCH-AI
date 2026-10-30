# WatchAI Console

The hosted control plane for WatchAI: a dashboard for AI smart replies and device management, the phone-facing API the Android companion calls, and a Mac Web Bluetooth lab for the CMF Watch Pro 2.

Design: [../docs/designs/watchai-console.md](../docs/designs/watchai-console.md) · Plan: [../docs/plans/watchai-console.md](../docs/plans/watchai-console.md)

## What is in here

| Piece | Description |
| --- | --- |
| Dashboard | Overview, AI Playground, Devices, Mac Device Lab, Activity, Settings. React 19 + Vite + Tailwind 4. |
| Phone API | `/v1/*` — enrollment, reply generation, delivery events, heartbeat, unenroll. Bearer tokens per device. |
| Reply engine | TypeScript port of the Python engine in `../engine`. Groq first, deterministic fallbacks on any failure. |
| Storage | Cloudflare D1. Metadata only: device records, settings, enrollment codes, rate limits, and body-free events. |
| Device Lab | Chrome/Edge Web Bluetooth GATT explorer, raw frame writes, saved recipes, and Playground handoff. |

One Cloudflare Worker serves both hostnames. The dashboard host sits behind Cloudflare Access; the API host uses per-device bearer tokens. All routes run through the Worker, including static assets, so a direct asset hit cannot bypass the Access check.

## Privacy invariant

Message bodies are processed in memory, sent to Groq for that one request, and dropped. The `events` table has no body column. Logs contain request metadata, never message content. The Activity page and CSV export are metadata only. Tests in `worker-test/api.test.ts` assert the schema and the redaction behavior; if you add a body column, those tests are supposed to fail.

## Local development

Requirements: Node 22+, npm, and a Cloudflare account only when deploying.

```bash
npm install
npm run db:migrate:local
npm run dev
```

- Dashboard: <http://localhost:5173>
- Worker API: <http://localhost:8787>
- Health: <http://localhost:8787/healthz>

`npm run dev` runs Vite and `wrangler dev` together. Vite proxies `/admin/api`, `/v1`, and `/healthz` to the Worker.

Local auth uses `AUTH_MODE=dev`, so the dashboard is open on localhost. Never ship that config: the deploy scripts use `wrangler.production.jsonc`, where `AUTH_MODE` is `access`.

To get live AI replies locally, copy the template and add your Groq key:

```bash
cp .env.example .dev.vars
# edit .dev.vars
```

```dotenv
GROQ_API_KEY=gsk_...
TOKEN_PEPPER=any-long-random-string-for-local-only
```

Without those, the Playground and `/v1/replies` still work but return static fallbacks and report `from_ai: false`. `TOKEN_PEPPER` must be at least 16 characters; production refuses to enroll or generate without it.

If port 8787 is already taken, stop the other process or run `wrangler dev` with a different `--port` and a matching Vite proxy.

### Checks

```bash
npm run typecheck   # dashboard, worker, and node configs
npm test            # engine + API/privacy suites
npm run build       # static dashboard into dist/
```

## Configuration

Non-secret values live in the Wrangler config. Secrets are set per Worker with `wrangler secret put`.

| Name | Kind | Notes |
| --- | --- | --- |
| `ENVIRONMENT` | var | `development` or `production`. |
| `AUTH_MODE` | var | `dev` bypasses Access locally; `access` verifies the Access JWT and fails closed. |
| `DASHBOARD_HOST` | var | Host that serves the dashboard and admin API, e.g. `watchai.example.com`. |
| `API_HOST` | var | Host that serves `/v1/*`, e.g. `api.example.com`. |
| `DASHBOARD_ORIGIN` | var | Full dashboard origin, used for CORS and links. |
| `API_ORIGIN` | var | Full API origin returned to phones at enrollment. |
| `ACCESS_TEAM_DOMAIN` | var | `<team>.cloudflareaccess.com`. |
| `ACCESS_AUD` | var | Audience tag of the Access application. |
| `GROQ_MODEL` | var | Default model id. Settings can override it. |
| `RATE_LIMIT_PER_MIN` | var | Per-device limit for `/v1/replies`. |
| `GROQ_API_KEY` | secret | Groq key. Missing means fallbacks only. |
| `TOKEN_PEPPER` | secret | Peppers device tokens and enrollment code hashes. Required in production. |

Generate a pepper with:

```bash
openssl rand -base64 48
```

## Deploy

1. Authenticate and create the database:

   ```bash
   npx wrangler login
   npx wrangler d1 create watchai-console
   ```

2. Create the production config from the template. This file is gitignored because it contains real IDs:

   ```bash
   cp wrangler.prod.jsonc wrangler.production.jsonc
   ```

3. Fill in `database_id` from step 1, both hostnames, both origins, `ACCESS_TEAM_DOMAIN`, and `ACCESS_AUD`. Leave `workers_dev` disabled.

4. Set the secrets:

   ```bash
   npx wrangler secret put GROQ_API_KEY --config wrangler.production.jsonc
   npx wrangler secret put TOKEN_PEPPER --config wrangler.production.jsonc
   ```

5. Apply the schema and deploy:

   ```bash
   npm run db:migrate:remote
   npm run deploy
   ```

6. Attach the custom domains in the Cloudflare dashboard (Worker → Settings → Domains & Routes): the dashboard host and the API host. Both point at the same Worker.

7. Protect only the dashboard host with Cloudflare Access:

   - Create a self-hosted Access application for `https://<DASHBOARD_HOST>`.
   - Add an allow policy for your email (or your identity provider group).
   - Copy the application's Audience (AUD) tag into `ACCESS_AUD`.
   - Set `ACCESS_TEAM_DOMAIN` to your team's `cloudflareaccess.com` domain.
   - Redeploy so the Worker picks up the vars.

   Do not put Access in front of the API host: phones cannot complete a browser login and use bearer tokens instead. `/v1/*` is rejected on the dashboard host, and dashboard routes are rejected on the API host.

8. Verify:

   ```bash
   curl -s https://<API_HOST>/healthz
   ```

   Then open `https://<DASHBOARD_HOST>` in a browser. You should be asked to log in through Access, then land on Overview. If the Worker returns `503 server_misconfigured`, the Access vars or `TOKEN_PEPPER` are missing — it is failing closed on purpose.

### Enroll a device by hand

Generate a code from the dashboard (Devices → New enrollment code) or the admin API:

```bash
curl -s -X POST https://<DASHBOARD_HOST>/admin/api/enrollment-codes
# { "code": "ABCDEFGHJK", "expires_at": "..." }
```

Exchange it for a device token:

```bash
curl -s -X POST https://<API_HOST>/v1/enroll \
  -H 'content-type: application/json' \
  -d '{"code":"ABCDEFGHJK","name":"Test phone","platform":"android"}'
# { "device_id": "dev_...", "token": "...", "api_origin": "https://<API_HOST>" }
```

Generate replies:

```bash
curl -s -X POST https://<API_HOST>/v1/replies \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"sender":"Riya","app":"WhatsApp","body":"Are we still on for dinner?","history":[]}'
# { "replies": ["..."], "tone": "...", "from_ai": true, "latency_ms": 812 }
```

Codes expire after 10 minutes and are single use. Enrollment is rate limited by IP; replies are rate limited per device.

## Phone API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/v1/enroll` | enrollment code | Exchange a one-time code for a device token. |
| `POST` | `/v1/replies` | bearer | Generate three watch-sized replies. |
| `POST` | `/v1/events` | bearer | Record a delivery outcome (metadata only). |
| `GET` | `/v1/me` | bearer | Device record plus current settings. |
| `POST` | `/v1/heartbeat` | bearer | Watch name, firmware, battery. |
| `POST` | `/v1/unenroll` | bearer | Revoke this device. |

Opt-outs are matched by sender alias. An opted-out sender gets `403 opted_out` and only an `opted_out` metadata event is written.

## Mac Device Lab

Open the dashboard in Chrome or Edge on macOS, go to **Mac Device Lab**, and scan. Safari and Firefox do not expose Web Bluetooth. The lab reads the GATT tree, subscribes to notifications, and writes raw frames; it does not claim to speak the watch protocol yet.

Keep the phone's companion app disconnected while the Mac holds the BLE connection — the watch accepts one central at a time. Automatic watch replies remain gated on M0/F1: confirming that the watch surfaces a reply action for WhatsApp/SMS notifications. Until that is answered, treat writes as experiments, not a delivery path.

## Project layout

```text
console/
├── migrations/           D1 schema
├── src/
│   ├── dashboard/        React app (pages, components, API client, BLE layer)
│   └── worker/           Hono Worker (auth, routes, D1 queries, engine port)
├── worker-test/          API, auth, and privacy tests
├── wrangler.jsonc        Local/dev config (dummy D1 id, dev auth)
├── wrangler.test.jsonc   Vitest Worker config
├── wrangler.prod.jsonc   Production template (copy, do not fill in place)
└── vite.config.ts        Vite + proxy to the Worker
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `503 server_misconfigured` in production | Missing `TOKEN_PEPPER`, or `AUTH_MODE=access` without `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`. |
| Replies always `from_ai: false` | No `GROQ_API_KEY`, Groq timeout, or malformed model output. Fallbacks are intentional. |
| Access login loop or `401` on admin API | AUD does not match the Access application, or the team domain is wrong. |
| `404` on `/v1/*` | The request hit the dashboard host. Use the API host. |
| `404` on dashboard routes | The request hit the API host. Use the dashboard host. |
| Web Bluetooth button disabled | Not Chrome/Edge, insecure origin, or Bluetooth permission denied in macOS settings. |
| `EADDRINUSE` on 8787 | Another dev server is running. Stop it or change the port and Vite proxy. |
