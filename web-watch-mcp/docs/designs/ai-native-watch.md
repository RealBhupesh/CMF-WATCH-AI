# AI-native watches

Status: approved for implementation, 2026-10-29.

## Purpose

The server today runs browser work when the connected agent asks. A watch makes
that work recurring: the owner names a URL and describes, in natural language,
what change matters. The server captures readable content on a schedule,
compares it with the last baseline, and queues evidence. The connected agent
judges whether an event matches the intent, reports it, and acknowledges it.

The watch is deliberately not an embedded agent. It does not call an LLM, rank
changes, or act on a page. It produces trustworthy evidence; the connected
agent supplies the judgment. This preserves the server's model-free control
contract while making the watch genuinely intent-driven rather than a brittle
CSS or whole-page hash.

## Decisions

- **Evidence queue, not push.** MCP cannot wake a ChatGPT conversation. Events
  wait in `watch_inbox` until an agent session checks them. Email, webhook, or
  chat push is a separate future feature.
- **Report only.** Watches never fill, click, upload, or submit. A meaningful
  event can lead to an explicitly authorized workflow, but the watch itself
  does not start one.
- **Specific URLs.** Watches monitor one public HTTP(S) URL. Job-search
  subscriptions are a later feature.
- **Hosted process.** The scheduler runs inside the long-lived HTTP server.
  Nothing ticks while the process is down. On restart, each due watch runs
  once; intervals are not replayed as a backlog.
- **No new infrastructure.** One JSON watch file, one JSON event file, and one
  text snapshot per watch.

## Data model

`Watch` in `data/watches.json`:

- `id`, `name`, `url`, `intent`, optional `selector`, `sessionId`
- `intervalMinutes` (15 minutes to 7 days)
- `status`: `active`, `paused`, or `blocked`
- `baseline`: `hash`, `title`, `url`, `capturedAt`, `chars`, `truncated`
- `lastCheck`: `at`, `result` (`baseline|unchanged|changed|error`),
  `durationMs`, optional `error`
- `lastChangeAt`, `nextRunAt`, `consecutiveFailures`, `lastError`, `reason`
- `createdAt`, `updatedAt`

`WatchEvent` in `data/watch-events.json`:

- `id`, `watchId`, `watchName`, `url`, `previousUrl`, `title`,
  `previousTitle`, `titleChanged`, `intent`, `detectedAt`
- `added` and `removed` lines, capped per line and in count
- `addedCount`, `removedCount`, `diffTruncated`
- `currentExcerpt`, `snapshotChars`, `truncated`
- optional `acknowledgedAt`

The baseline text is stored separately at
`data/watches/snapshots/<watchId>.txt` with mode `0600`. Limits:

- 200 watches per deployment
- 500 events, oldest acknowledged events evicted first
- 20,000 characters per snapshot by default (`MAX_TEXT_CHARS`)
- 200 diff lines per side, 500 characters per displayed line
- 2,000-character current excerpt

Deleting a watch deletes its snapshot and events.

## Check pipeline

`WatchRunner` starts with the server. Every 15 seconds it looks for due,
`active` watches and processes them one at a time under the existing
`ToolControl` browser lock, up to a 45-second budget per tick. If a user tool
or workflow holds the lock, the watch waits for a later tick.

For each check:

1. Open a temporary tab in the watch's browser session. Saved sign-ins and
   cookies work because the session profile is reused.
2. Navigate with the existing URL guard and navigation timeout.
3. Wait briefly for client-rendered content and for the optional selector.
4. Detect human verification. A challenge blocks the watch; it is never
   bypassed.
5. Extract readable content:
   - the explicit selector if supplied;
   - otherwise the largest visible `main`, `[role=main]`, or `article`;
   - otherwise `body`, with semantic chrome (`nav`, `header`, `footer`,
     `aside`, scripts, forms, hidden elements) temporarily hidden.
   A missing or invalid explicit selector blocks the watch rather than falling
   back to the whole page.
6. Normalize to trimmed, non-empty lines with collapsed whitespace.
7. Compare `sha256(title + normalized text)` with the baseline.
8. First check: store the baseline silently. Unchanged: update timestamps.
   Changed: compute a prefix/suffix line diff, store the new baseline, and
   append an event with the diff and excerpt.
9. Close the temporary tab and restore the previous active tab in `finally`.

Failure handling:

- Transient errors increment `consecutiveFailures` and back off by
  `2^failures × interval`, capped at `8 × interval`.
- Five consecutive failures move the watch to `blocked` with reason
  `check_failures`.
- Verification moves it to `blocked` with reason `site_verification`.
- An unsafe URL moves it to `blocked` with reason `unsafe_url`.
- A missing or invalid selector moves it to `blocked` with reason
  `selector_not_found`.
- `watch_resume` clears the failure count and schedules an immediate check.
  The owner must have cleared any site challenge and updated the selector if
  that was the cause.
- A paused watch stays paused after a manual check.

The content hash includes the page title so title-only changes still produce an
event. A URL change alone does not; redirects are recorded when content or
title changes.

## MCP tools

- `watch_create` — name, URL, intent, interval, optional selector/session.
  Validates the URL shape and session. Runs the first check immediately unless
  the browser is busy, in which case the scheduler picks it up.
- `watch_list` — summaries with status, next run, last change, unread count.
- `watch_get` — one watch, recent events, optional baseline content.
- `watch_check` — run a check now. Blocked watches must be resumed first.
- `watch_update` — change name, intent, interval, or selector. A selector
  change clears the baseline and snapshot so the next check starts clean.
- `watch_pause`, `watch_resume`, `watch_delete`.
- `watch_inbox` — unread events across watches, newest first, with intent and
  diff evidence.
- `watch_ack` — acknowledge event IDs, all events for a watch, or all events.

Watch lifecycle mutations and checks take the browser lock, so a watch cannot
be checked, updated, or deleted mid-check. Acknowledging events does not touch
the browser and does not take the lock. Read-only tools do not take the lock.

`server_status` reports watch counts and unread events. The MCP server
instructions tell the agent to check `watch_inbox` at session start, judge
events against their intent, report meaningful ones, and acknowledge them.

## Safety

- Reuses the public HTTP(S) URL guard, including DNS checks at fetch time.
- Reuses human-verification detection and blocking behavior.
- Read-only page interaction. No form mutation, upload, download, or
  submission.
- Stored page text is private owner data under the existing data directory.
  Events can contain page content; back up and protect the data directory.
- Page content in events is untrusted data. It is never execution authority.
- Bounded tabs, content, events, watch count, and intervals.

## Testing

- Unit tests for normalization, hashing, prefix/suffix diffs, line clipping,
  and truncation.
- Store tests for create/update/delete, event retention, acknowledgement,
  snapshot read/write, and unread counts.
- Chromium integration tests with a stubbed `readPage` for baseline,
  unchanged, changed, selector, verification, failure backoff, pause, and tab
  restoration.
- Chromium `readPage` tests for chrome removal, selector scoping, HTTP errors,
  and missing or invalid selectors.
- MCP round-trip test: create, check, inbox, acknowledge, update, delete, and
  creation while the browser lock is busy.
- `npm run check` (lint, typecheck, tests, production build) must pass.

## Non-goals for v1

- Server-side LLM relevance scoring.
- Email, webhook, or chat push.
- Automatic workflow execution on match.
- Job-search subscriptions, sitemaps, pagination, or multi-page watches.
- Screenshot or visual diffs.
- Tenancy. One data directory belongs to one owner.

## Future extensions

- Optional webhook delivery with signed payloads.
- Optional per-watch LLM judge using an owner-supplied OpenAI-compatible
  endpoint.
- Structured watchers for job searches, feeds, and JSON endpoints.
- Watch templates and natural-language creation from an inspected page.
