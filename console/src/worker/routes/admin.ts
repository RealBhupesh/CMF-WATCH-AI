import { Hono } from 'hono';

import {
  countEvents,
  createEnrollmentCode,
  deleteAllEvents,
  getDeviceCounts,
  getRecentLatencies,
  getSettings,
  getSparkline,
  getTodayStats,
  insertEvent,
  listDevices,
  listEvents,
  revokeAllDevices,
  revokeDevice,
  updateSettings,
} from '../db/queries';
import type { DeviceRow } from '../db/queries';
import {
  enrollmentExpiry,
  generateEnrollmentCode,
  hashSecret,
  isPepperConfigured,
} from '../auth/device';
import { generate } from '../engine/generate';
import { isTone, type Tone } from '../engine/model';
import { fail, json, readJson } from '../lib/http';
import {
  eventsQuerySchema,
  playgroundSchema,
  settingsSchema,
  toEventQuery,
} from '../lib/schemas';
import { isOptedOut, normalizeOptOuts, parseOptOuts } from '../lib/settings';
import {
  serializeDevice,
  serializeEvent,
  serializeSettings,
} from '../lib/serialize';
import type { AppEnv } from '../types';

export const admin = new Hono<AppEnv>();

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return Math.round(sorted[index]);
}

function sparklineBuckets(
  rows: Array<{ hour: string; replies: number; avg_latency_ms: number }>,
): Array<{ hour: string; replies: number; avg_latency_ms: number }> {
  const byHour = new Map(
    rows.map((row) => [row.hour.replace(' ', 'T').slice(0, 13), row]),
  );
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);

  return Array.from({ length: 24 }, (_, index) => {
    const at = new Date(now.getTime() - (23 - index) * 60 * 60 * 1000);
    const key = at.toISOString().slice(0, 13);
    const row = byHour.get(key);
    return {
      hour: `${key}:00:00Z`,
      replies: row?.replies ?? 0,
      avg_latency_ms: row?.avg_latency_ms ?? 0,
    };
  });
}

admin.get('/overview', async (c) => {
  const [
    deviceCounts,
    today,
    latencies,
    sparkRows,
    recent,
    eventCount,
    settings,
  ] = await Promise.all([
    getDeviceCounts(c.env),
    getTodayStats(c.env),
    getRecentLatencies(c.env),
    getSparkline(c.env),
    listEvents(c.env, {}, 8, 0),
    countEvents(c.env),
    getSettings(c.env),
  ]);

  return json(c, {
    version: c.env.VERSION,
    environment: c.env.ENVIRONMENT,
    auth_mode: c.env.AUTH_MODE,
    groq_configured: Boolean(c.env.GROQ_API_KEY),
    api_origin: c.env.API_ORIGIN,
    retention_days: settings.retention_days,
    devices: deviceCounts,
    today: {
      ...today,
      ai_success_rate: today.replies > 0 ? today.ai_replies / today.replies : null,
    },
    latency: {
      p50_ms: percentile(latencies, 0.5),
      p95_ms: percentile(latencies, 0.95),
      samples: latencies.length,
    },
    sparkline: sparklineBuckets(sparkRows),
    recent: recent.events.map(serializeEvent),
    onboarding: {
      has_device: deviceCounts.total > 0,
      has_event: eventCount > 0,
    },
  });
});

admin.get('/events', async (c) => {
  const parsed = eventsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return fail(c, 400, 'invalid_body', {
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    });
  }

  const query = toEventQuery(parsed.data);
  const { events, total } = await listEvents(
    c.env,
    {
      source: query.source,
      app: query.app,
      fromAi: query.fromAi,
      outcome: query.outcome,
    },
    query.limit,
    query.offset,
  );

  return json(c, {
    events: events.map(serializeEvent),
    total,
    limit: query.limit,
    offset: query.offset,
  });
});

admin.delete('/events', async (c) => {
  const deleted = await deleteAllEvents(c.env);
  return json(c, { deleted });
});

admin.get('/settings', async (c) => {
  return json(c, serializeSettings(await getSettings(c.env)));
});

admin.put('/settings', async (c) => {
  const body = await readJson(c, settingsSchema);
  if (!body.ok) return body.response;

  const row = await updateSettings(c.env, {
    model: body.data.model,
    forcedTone: body.data.forced_tone,
    optOuts: normalizeOptOuts(body.data.opt_outs),
    retentionDays: body.data.retention_days,
  });

  return json(c, serializeSettings(row));
});

admin.get('/devices', async (c) => {
  const devices = await listDevices(c.env);
  return json(c, {
    devices: devices.map((device) => serializeDevice(device as DeviceRow)),
  });
});

admin.post('/enrollment-codes', async (c) => {
  if (c.env.ENVIRONMENT === 'production' && !isPepperConfigured(c.env)) {
    return fail(c, 503, 'server_misconfigured');
  }

  const code = generateEnrollmentCode();
  const codeHash = await hashSecret(c.env, code);
  const expiry = enrollmentExpiry(10);

  await createEnrollmentCode(c.env, codeHash, expiry.sql);
  return json(c, { code, expires_at: expiry.iso });
});

admin.delete('/devices/:id', async (c) => {
  const id = c.req.param('id');
  if (!id || id.length > 80) return fail(c, 400, 'bad_request');

  const revoked = await revokeDevice(c.env, id);
  if (!revoked) return fail(c, 404, 'not_found');
  return json(c, { ok: true });
});

admin.post('/devices/revoke-all', async (c) => {
  const revoked = await revokeAllDevices(c.env);
  return json(c, { revoked });
});

admin.post('/playground', async (c) => {
  const body = await readJson(c, playgroundSchema);
  if (!body.ok) return body.response;

  const settings = await getSettings(c.env);
  const optOuts = parseOptOuts(settings.opt_outs);
  const sender = body.data.sender || 'Unknown';

  if (isOptedOut(sender, optOuts)) {
    await insertEvent(c.env, {
      id: crypto.randomUUID(),
      source: 'playground',
      app: body.data.app ?? '',
      senderAlias: sender,
      latencyMs: 0,
      fromAi: false,
      replyCount: 0,
      outcome: 'opted_out',
    });
    return fail(c, 403, 'opted_out', {
      message: 'This sender is opted out in Settings. No generation was attempted.',
    });
  }

  // In the Playground, an explicit "auto" means infer the tone; omitting the
  // field means use the Settings default, which is what the phone does.
  const tone: Tone | 'auto' =
    body.data.tone === undefined
      ? settings.forced_tone !== 'auto' && isTone(settings.forced_tone)
        ? settings.forced_tone
        : 'auto'
      : body.data.tone;

  const result = await generate(
    {
      sender,
      body: body.data.body,
      app: body.data.app ?? '',
      history: body.data.history ?? [],
    },
    {
      apiKey: c.env.GROQ_API_KEY,
      model: settings.model || c.env.GROQ_MODEL,
      tone,
    },
  );

  const eventId = crypto.randomUUID();
  await insertEvent(c.env, {
    id: eventId,
    source: 'playground',
    app: body.data.app ?? '',
    senderAlias: sender,
    latencyMs: result.latencyMs,
    fromAi: result.replySet.fromAi,
    replyCount: result.replySet.replies.length,
    outcome: 'generated',
  });

  return json(c, {
    replies: result.replySet.replies,
    tone: result.replySet.tone,
    from_ai: result.replySet.fromAi,
    latency_ms: result.latencyMs,
    event_id: eventId,
    ...(result.error ? { fallback_reason: result.error } : {}),
  });
});
