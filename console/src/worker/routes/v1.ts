import { Hono, type Context } from 'hono';

import {
  allowRequest,
  consumeEnrollmentCode,
  createDevice,
  getSettings,
  heartbeat,
  insertEvent,
  revokeDevice,
} from '../db/queries';
import type { DeviceRow } from '../db/queries';
import {
  deviceAuth,
  generateDeviceToken,
  hashSecret,
  isPepperConfigured,
  normalizeEnrollmentCode,
} from '../auth/device';
import { generate } from '../engine/generate';
import { isTone, type Tone } from '../engine/model';
import { fail, json, readJson } from '../lib/http';
import {
  enrollSchema,
  eventSchema,
  heartbeatSchema,
  replyRequestSchema,
} from '../lib/schemas';
import { isOptedOut, parseOptOuts } from '../lib/settings';
import { serializeDevice, serializeSettings } from '../lib/serialize';
import type { AppEnv } from '../types';

export const v1 = new Hono<AppEnv>();

function currentDevice(c: Context<AppEnv>): DeviceRow {
  const device = c.get('device');
  if (!device) throw new Error('device middleware did not run');
  return device;
}

async function enforceLimit(
  c: Context<AppEnv>,
  key: string,
  limit: number,
): Promise<Response | null> {
  const allowed = await allowRequest(c.env, key, limit);
  if (allowed) return null;
  const retryAfter = 60 - (Math.floor(Date.now() / 1000) % 60);
  c.header('Retry-After', String(retryAfter));
  return fail(c, 429, 'rate_limited', { retry_after_s: retryAfter });
}

function toneFor(forced: string, override?: string): Tone | 'auto' {
  if (override && override !== 'auto' && isTone(override)) return override;
  if (forced !== 'auto' && isTone(forced)) return forced;
  return 'auto';
}

function clientIp(c: Context<AppEnv>): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

/**
 * Enrollment is the only phone route without a bearer token. It is rate
 * limited by IP so a code cannot be brute-forced even though the 10-character
 * alphabet already makes guessing impractical.
 */
v1.post('/enroll', async (c) => {
  if (c.env.ENVIRONMENT === 'production' && !isPepperConfigured(c.env)) {
    return fail(c, 503, 'server_misconfigured');
  }

  const limit = await enforceLimit(c, `enroll:${clientIp(c)}`, 10);
  if (limit) return limit;

  const body = await readJson(c, enrollSchema);
  if (!body.ok) return body.response;

  const code = normalizeEnrollmentCode(body.data.code);
  const codeHash = await hashSecret(c.env, code);
  const consumed = await consumeEnrollmentCode(c.env, codeHash);
  if (!consumed) return fail(c, 403, 'invalid_code');

  const token = generateDeviceToken();
  const tokenHash = await hashSecret(c.env, token);
  const deviceId = `dev_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const device = await createDevice(c.env, {
    id: deviceId,
    name: body.data.name,
    tokenHash,
    platform: body.data.platform ?? '',
    appVersion: body.data.app_version ?? '',
  });

  return json(c, {
    device_id: device.id,
    token,
    api_origin: c.env.API_ORIGIN || new URL(c.req.url).origin,
  });
});

v1.use('/replies', deviceAuth);
v1.use('/events', deviceAuth);
v1.use('/me', deviceAuth);
v1.use('/heartbeat', deviceAuth);
v1.use('/unenroll', deviceAuth);

v1.post('/replies', async (c) => {
  const device = currentDevice(c);
  const limit = await enforceLimit(
    c,
    `replies:${device.id}`,
    Number(c.env.RATE_LIMIT_PER_MIN) || 30,
  );
  if (limit) return limit;

  const body = await readJson(c, replyRequestSchema);
  if (!body.ok) return body.response;

  const settings = await getSettings(c.env);
  const optOuts = parseOptOuts(settings.opt_outs);
  const sender = body.data.sender || 'Unknown';

  if (isOptedOut(sender, optOuts)) {
    try {
      await insertEvent(c.env, {
        id: crypto.randomUUID(),
        deviceId: device.id,
        source: 'phone',
        app: body.data.app ?? '',
        senderAlias: sender,
        latencyMs: 0,
        fromAi: false,
        replyCount: 0,
        outcome: 'opted_out',
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'warn',
          msg: 'event_insert_failed',
          request_id: c.get('requestId'),
          device_id: device.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return fail(c, 403, 'opted_out');
  }

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
      tone: toneFor(settings.forced_tone),
    },
  );

  try {
    await insertEvent(c.env, {
      id: crypto.randomUUID(),
      deviceId: device.id,
      source: 'phone',
      app: body.data.app ?? '',
      senderAlias: sender,
      latencyMs: result.latencyMs,
      fromAi: result.replySet.fromAi,
      replyCount: result.replySet.replies.length,
      outcome: 'generated',
    });
  } catch (error) {
    // Analytics must never cost the user their replies.
    console.error(
      JSON.stringify({
        level: 'warn',
        msg: 'event_insert_failed',
        request_id: c.get('requestId'),
        device_id: device.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return json(c, {
    replies: result.replySet.replies,
    tone: result.replySet.tone,
    from_ai: result.replySet.fromAi,
    latency_ms: result.latencyMs,
  });
});

v1.post('/events', async (c) => {
  const device = currentDevice(c);
  const limit = await enforceLimit(c, `events:${device.id}`, 120);
  if (limit) return limit;

  const body = await readJson(c, eventSchema);
  if (!body.ok) return body.response;

  try {
    await insertEvent(c.env, {
      id: crypto.randomUUID(),
      deviceId: device.id,
      source: 'phone',
      app: body.data.app,
      senderAlias: body.data.sender_alias,
      latencyMs: body.data.latency_ms,
      fromAi: body.data.from_ai,
      replyCount: body.data.reply_count,
      outcome: body.data.outcome,
    });
  } catch {
    return fail(c, 500, 'server_error');
  }

  return json(c, { ok: true });
});

v1.get('/me', async (c) => {
  const device = currentDevice(c);
  const settings = await getSettings(c.env);

  return json(c, {
    device: serializeDevice(device),
    settings: serializeSettings(settings),
  });
});

v1.post('/heartbeat', async (c) => {
  const device = currentDevice(c);
  const body = await readJson(c, heartbeatSchema);
  if (!body.ok) return body.response;

  await heartbeat(c.env, device.id, {
    watchName: body.data.watch_name,
    watchFirmware: body.data.watch_firmware,
    battery: body.data.battery,
  });

  return json(c, { ok: true });
});

v1.post('/unenroll', async (c) => {
  const device = currentDevice(c);
  await revokeDevice(c.env, device.id);
  return json(c, { ok: true });
});
