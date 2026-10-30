# WatchAI Console — implementation plan

Design: [../designs/watchai-console.md](../designs/watchai-console.md)

## Milestones

### M1 — scaffold
- [x] `console/` workspace, TypeScript, Wrangler, Vite, Vitest.
- [x] `wrangler.jsonc`, D1 migration, local dev scripts.
- [x] `.env.example`, `.gitignore`, README.

### M2 — engine port
- [x] `model.ts`, `sanitize.ts`, `prompt.ts`, `generate.ts`.
- [x] Port all engine tests 1:1 from `tests/test_engine.py`.
- [x] Add forced-tone tests and fallback invariants.

### M3 — Worker API
- [x] Hono app, host guard, security headers, request id, logging without bodies.
- [x] D1 queries and migration.
- [x] Access JWT auth (fail closed) + dev mode.
- [x] Device token auth, enrollment, revocation.
- [x] `POST /v1/replies`, `/v1/events`, `/v1/me`, `/v1/heartbeat`, `/v1/unenroll`.
- [x] Admin overview/events/settings/devices/enrollment/playground.
- [x] Rate limiting and body caps.
- [x] Cron retention cleanup.
- [x] API tests: enrollment, auth, validation, rate limit, privacy schema.

### M4 — dashboard shell
- [x] Design tokens, fonts, layout, sidebar, topbar, responsive drawer.
- [x] API client, query polling, toasts, form primitives.
- [x] Overview page.
- [x] Playground page and shared reply-set context.

### M5 — devices, activity, settings
- [x] Devices page, enrollment dialog, QR, revoke.
- [x] Activity filters, pagination, CSV export.
- [x] Settings form, opt-outs, retention, danger zone.

### M6 — Device Lab
- [x] Web Bluetooth wrapper with capability detection.
- [x] GATT tree, read/write/notify, log, export.
- [x] Frame composer and saved recipes.
- [x] Playground → Lab handoff.
- [x] Phone-conflict checklist and M0 warning.

### M7 — verification
- [x] `npm test`, `npm run typecheck`, `npm run build`.
- [x] Local smoke with `wrangler dev` + Vite.
- [x] Playwright or manual browser smoke of every page.
- [x] README deployment instructions.
- [x] Commit and push.

### M8 — deploy (needs owner inputs)
- [ ] Create D1, set `GROQ_API_KEY` and `TOKEN_PEPPER`.
- [ ] Set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, hostnames.
- [ ] Attach custom domains, disable `workers.dev`.
- [ ] Access application + owner policy.
- [ ] Enroll a test device with curl, generate a reply, verify dashboard.
- [ ] Real Device Lab check against the watch.

## Commands

```bash
cd console
npm install
npm run dev          # Vite + wrangler dev
npm test
npm run typecheck
npm run build
npm run deploy       # requires Cloudflare auth and real IDs
```

## Definition of done for Phase 1

- Dashboard loads behind Access, all six pages work.
- Playground returns three replies from Groq, or honest fallbacks with a reason.
- Enrollment code + device token flow works end to end via curl.
- Activity contains metadata only; a schema test proves there is no body column.
- Device Lab can scan/connect on Chrome/macOS (hardware-dependent).
- No message body appears in logs or D1.
- Deployment steps are documented and reproducible.
