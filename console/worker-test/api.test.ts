import { beforeEach, describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';

import { verifyAccess } from '../src/worker/auth/access';
import type { Env } from '../src/worker/env';

const DASHBOARD = 'https://watchai.test';
const API = 'https://api.watchai.test';

beforeEach(async () => {
  // The Workers test pool shares storage between requests in this file, so
  // each test starts from a clean slate instead of relying on rollback.
  await env.DB.prepare('DELETE FROM events').run();
  await env.DB.prepare('DELETE FROM devices').run();
  await env.DB.prepare('DELETE FROM enrollment_codes').run();
  await env.DB.prepare('DELETE FROM rate_limits').run();
  await env.DB.prepare(
    `UPDATE settings
        SET model = 'llama-3.3-70b-versatile',
            forced_tone = 'auto',
            opt_outs = '[]',
            retention_days = 30
      WHERE id = 1`,
  ).run();
});

async function call(
  origin: string,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  if (token) headers.set('authorization', `Bearer ${token}`);

  return SELF.fetch(
    new Request(`${origin}${path}`, {
      ...init,
      headers,
    }),
  );
}

const admin = (path: string, init?: RequestInit) =>
  call(DASHBOARD, path, init);
const phone = (path: string, init?: RequestInit, token?: string) =>
  call(API, path, init, token);

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function newCode(): Promise<string> {
  const response = await admin('/admin/api/enrollment-codes', {
    method: 'POST',
  });
  expect(response.status).toBe(200);
  const body = await json<{ code: string; expires_at: string }>(response);
  expect(body.code).toMatch(/^[A-Z2-9]{10}$/);
  return body.code;
}

async function enroll(name = 'Test phone'): Promise<{
  device_id: string;
  token: string;
  api_origin: string;
}> {
  const code = await newCode();
  const response = await phone('/v1/enroll', {
    method: 'POST',
    body: JSON.stringify({
      code,
      name,
      platform: 'android',
      app_version: '0.1.0',
    }),
  });
  expect(response.status).toBe(200);
  return json(response);
}

interface ReplyResponse {
  replies: Array<{ intent: string; text: string }>;
  tone: string;
  from_ai: boolean;
  latency_ms: number;
}

interface EventResponse {
  events: Array<{
    id: string;
    source: string;
    app: string;
    sender_alias: string;
    latency_ms: number;
    from_ai: boolean;
    reply_count: number;
    outcome: string;
    created_at: string;
  }>;
  total: number;
  limit: number;
  offset: number;
}

describe('public and host isolation', () => {
  it('serves health on both hosts without auth', async () => {
    for (const origin of [DASHBOARD, API]) {
      const response = await call(origin, '/healthz');
      expect(response.status).toBe(200);
      const body = await json<{ ok: boolean; version: string }>(response);
      expect(body.ok).toBe(true);
      expect(body.version).toBe('test');
    }
  });

  it('does not expose admin routes on the API host', async () => {
    const response = await phone('/admin/api/settings');
    expect(response.status).toBe(404);
  });

  it('does not expose phone routes on the dashboard host', async () => {
    const response = await admin('/v1/me');
    expect(response.status).toBe(404);
  });

  it('returns 401 for an unknown API path rather than the dashboard', async () => {
    const response = await phone('/v1/does-not-exist');
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: 'not_found' });
  });
});

describe('enrollment', () => {
  it('issues a one-time token and refuses code reuse', async () => {
    const code = await newCode();
    const first = await phone('/v1/enroll', {
      method: 'POST',
      body: JSON.stringify({ code, name: 'Pixel' }),
    });
    expect(first.status).toBe(200);
    const enrolled = await json<{
      device_id: string;
      token: string;
      api_origin: string;
    }>(first);
    expect(enrolled.token).toMatch(/^wai_[A-Za-z0-9_-]{40,}$/);
    expect(enrolled.api_origin).toBe('https://api.watchai.test');

    const second = await phone('/v1/enroll', {
      method: 'POST',
      body: JSON.stringify({ code, name: 'Again' }),
    });
    expect(second.status).toBe(403);
    expect(await json(second)).toEqual({ error: 'invalid_code' });
  });

  it('rejects an unknown enrollment code', async () => {
    const response = await phone('/v1/enroll', {
      method: 'POST',
      body: JSON.stringify({ code: 'ZZZZZZZZZZ', name: 'Pixel' }),
    });
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: 'invalid_code' });
  });

  it('normalizes spaces and dashes in a code', async () => {
    const code = await newCode();
    const spaced = `${code.slice(0, 5)} ${code.slice(5)}`;
    const response = await phone('/v1/enroll', {
      method: 'POST',
      body: JSON.stringify({ code: spaced.toLowerCase(), name: 'Pixel' }),
    });
    expect(response.status).toBe(200);
  });
});

describe('device auth', () => {
  it('rejects missing and malformed bearer tokens', async () => {
    const missing = await phone('/v1/me');
    expect(missing.status).toBe(401);

    const wrong = await phone('/v1/me', {}, 'wai_not-a-real-token');
    expect(wrong.status).toBe(401);
  });

  it('returns the device and settings without the token hash', async () => {
    const enrolled = await enroll('Pixel 9');
    const response = await phone('/v1/me', {}, enrolled.token);
    expect(response.status).toBe(200);

    const body = await json<{
      device: Record<string, unknown>;
      settings: { opt_outs: string[] };
    }>(response);
    expect(body.device.id).toBe(enrolled.device_id);
    expect(body.device.name).toBe('Pixel 9');
    expect(body.device).not.toHaveProperty('token_hash');
    expect(body.settings.opt_outs).toEqual([]);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('token_hash');
    expect(raw).not.toContain(enrolled.token);
  });

  it('records a heartbeat on the device', async () => {
    const enrolled = await enroll();
    const heartbeat = await phone(
      '/v1/heartbeat',
      {
        method: 'POST',
        body: JSON.stringify({
          watch_name: 'CMF Watch Pro 2',
          watch_firmware: '1.2.3',
          battery: 64,
        }),
      },
      enrolled.token,
    );
    expect(heartbeat.status).toBe(200);

    const me = await phone('/v1/me', {}, enrolled.token);
    const body = await json<{
      device: {
        watch_name: string;
        watch_firmware: string;
        battery: number;
        online: boolean;
      };
    }>(me);
    expect(body.device.watch_name).toBe('CMF Watch Pro 2');
    expect(body.device.watch_firmware).toBe('1.2.3');
    expect(body.device.battery).toBe(64);
    expect(body.device.online).toBe(true);
  });

  it('rejects a token immediately after unenroll', async () => {
    const enrolled = await enroll();
    const response = await phone(
      '/v1/unenroll',
      { method: 'POST' },
      enrolled.token,
    );
    expect(response.status).toBe(200);

    const after = await phone('/v1/me', {}, enrolled.token);
    expect(after.status).toBe(401);
  });
});

describe('reply generation', () => {
  it('returns three watch-safe fallbacks when no Groq key is configured', async () => {
    const enrolled = await enroll();
    const response = await phone(
      '/v1/replies',
      {
        method: 'POST',
        body: JSON.stringify({
          sender: 'Rahul',
          body: 'kal office aa rahe ho?',
          app: 'com.whatsapp',
        }),
      },
      enrolled.token,
    );
    expect(response.status).toBe(200);

    const body = await json<ReplyResponse>(response);
    expect(body.replies).toHaveLength(3);
    expect(body.replies.map((reply) => reply.intent)).toEqual([
      'positive',
      'neutral',
      'decline',
    ]);
    expect(body.tone).toBe('casual_hinglish');
    expect(body.from_ai).toBe(false);
    expect(body.latency_ms).toBeGreaterThanOrEqual(0);
    for (const reply of body.replies) {
      expect(reply.text.length).toBeGreaterThan(0);
      expect(reply.text.length).toBeLessThanOrEqual(40);
      expect(/^[\x00-\x7F]*$/.test(reply.text)).toBe(true);
    }
  });

  it('writes metadata-only events for the Activity page', async () => {
    const enrolled = await enroll();
    await phone(
      '/v1/replies',
      {
        method: 'POST',
        body: JSON.stringify({
          sender: 'Rahul',
          body: 'secret message text',
          app: 'com.whatsapp',
        }),
      },
      enrolled.token,
    );

    const response = await admin('/admin/api/events');
    expect(response.status).toBe(200);
    const body = await json<EventResponse>(response);
    expect(body.total).toBe(1);
    expect(body.events[0]).toMatchObject({
      source: 'phone',
      app: 'com.whatsapp',
      sender_alias: 'Rahul',
      from_ai: false,
      reply_count: 3,
      outcome: 'generated',
    });
    expect(JSON.stringify(body)).not.toContain('secret message text');
  });

  it('rejects a missing body, malformed JSON, and oversized bodies', async () => {
    const enrolled = await enroll();

    const missing = await phone(
      '/v1/replies',
      { method: 'POST', body: JSON.stringify({ sender: 'Rahul' }) },
      enrolled.token,
    );
    expect(missing.status).toBe(400);

    const malformed = await phone(
      '/v1/replies',
      { method: 'POST', body: '{not json' },
      enrolled.token,
    );
    expect(malformed.status).toBe(400);
    expect(await json(malformed)).toEqual({ error: 'invalid_json' });

    const oversized = await phone(
      '/v1/replies',
      {
        method: 'POST',
        body: JSON.stringify({ body: 'x'.repeat(20_000) }),
      },
      enrolled.token,
    );
    expect(oversized.status).toBe(413);
  });

  it('does not echo message text in a validation error', async () => {
    const enrolled = await enroll();
    const response = await phone(
      '/v1/replies',
      {
        method: 'POST',
        body: JSON.stringify({ body: 'secret message', history: [42] }),
      },
      enrolled.token,
    );
    expect(response.status).toBe(400);
    const raw = await response.text();
    expect(raw).not.toContain('secret message');
  });

  it('blocks opted-out senders before generation', async () => {
    const enrolled = await enroll();
    const update = await admin('/admin/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        forced_tone: 'auto',
        opt_outs: ['Rahul'],
        retention_days: 30,
      }),
    });
    expect(update.status).toBe(200);

    const response = await phone(
      '/v1/replies',
      {
        method: 'POST',
        body: JSON.stringify({
          sender: ' rahul ',
          body: 'should never reach the engine',
          app: 'com.whatsapp',
        }),
      },
      enrolled.token,
    );
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: 'opted_out' });

    const events = await admin('/admin/api/events?outcome=opted_out');
    const body = await json<EventResponse>(events);
    expect(body.total).toBe(1);
    expect(body.events[0]).toMatchObject({
      sender_alias: 'rahul',
      outcome: 'opted_out',
      reply_count: 0,
    });
  });
});

describe('rate limiting', () => {
  it('returns 429 after the per-device ceiling', async () => {
    const enrolled = await enroll();
    const send = () =>
      phone(
        '/v1/replies',
        {
          method: 'POST',
          body: JSON.stringify({ sender: 'Rahul', body: 'ping' }),
        },
        enrolled.token,
      );

    for (let index = 0; index < 3; index += 1) {
      expect((await send()).status).toBe(200);
    }
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(await json(limited)).toHaveProperty('error', 'rate_limited');
  });
});

describe('phone event reporting', () => {
  it('accepts a delivery outcome and exposes it in Activity', async () => {
    const enrolled = await enroll();
    const response = await phone(
      '/v1/events',
      {
        method: 'POST',
        body: JSON.stringify({
          app: 'com.whatsapp',
          sender_alias: 'Rahul',
          latency_ms: 850,
          from_ai: true,
          reply_count: 3,
          outcome: 'delivered',
        }),
      },
      enrolled.token,
    );
    expect(response.status).toBe(200);

    const events = await admin('/admin/api/events?source=phone');
    const body = await json<EventResponse>(events);
    expect(body.events[0]).toMatchObject({
      source: 'phone',
      outcome: 'delivered',
      from_ai: true,
      latency_ms: 850,
    });
  });

  it('rejects invalid outcomes and reply counts', async () => {
    const enrolled = await enroll();
    for (const payload of [
      {
        latency_ms: 10,
        from_ai: true,
        reply_count: 3,
        outcome: 'sent',
      },
      {
        latency_ms: -1,
        from_ai: true,
        reply_count: 3,
        outcome: 'delivered',
      },
      {
        latency_ms: 10,
        from_ai: true,
        reply_count: 99,
        outcome: 'delivered',
      },
    ]) {
      const response = await phone(
        '/v1/events',
        { method: 'POST', body: JSON.stringify(payload) },
        enrolled.token,
      );
      expect(response.status).toBe(400);
    }
  });
});

describe('admin API', () => {
  it('returns settings with parsed opt-outs and updates them', async () => {
    const initial = await admin('/admin/api/settings');
    expect(initial.status).toBe(200);
    const defaults = await json<{
      model: string;
      forced_tone: string;
      opt_outs: string[];
      retention_days: number;
    }>(initial);
    expect(defaults.forced_tone).toBe('auto');
    expect(defaults.opt_outs).toEqual([]);

    const updated = await admin('/admin/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        forced_tone: 'professional',
        opt_outs: ['Rahul', 'rahul', '  Priya  '],
        retention_days: 7,
      }),
    });
    expect(updated.status).toBe(200);
    const body = await json<{
      model: string;
      forced_tone: string;
      opt_outs: string[];
      retention_days: number;
    }>(updated);
    expect(body.model).toBe('openai/gpt-oss-120b');
    expect(body.forced_tone).toBe('professional');
    expect(body.opt_outs).toEqual(['Rahul', 'Priya']);
    expect(body.retention_days).toBe(7);
  });

  it('rejects an invalid settings payload', async () => {
    const response = await admin('/admin/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        forced_tone: 'auto',
        opt_outs: [],
        retention_days: 0,
      }),
    });
    expect(response.status).toBe(400);
  });

  it('generates a playground reply set and records it', async () => {
    const response = await admin('/admin/api/playground', {
      method: 'POST',
      body: JSON.stringify({
        sender: 'Priya',
        body: 'Can you review the deck?',
        app: 'com.microsoft.teams',
      }),
    });
    expect(response.status).toBe(200);

    const body = await json<
      ReplyResponse & { event_id: string; fallback_reason?: string }
    >(response);
    expect(body.replies).toHaveLength(3);
    expect(body.tone).toBe('professional');
    expect(body.from_ai).toBe(false);
    expect(body.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.fallback_reason).toBe('no api key');

    const events = await admin('/admin/api/events?source=playground');
    const list = await json<EventResponse>(events);
    expect(list.total).toBe(1);
    expect(list.events[0].outcome).toBe('generated');
  });

  it('honours an explicit auto tone in the playground', async () => {
    await admin('/admin/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        forced_tone: 'professional',
        opt_outs: [],
        retention_days: 30,
      }),
    });

    const auto = await admin('/admin/api/playground', {
      method: 'POST',
      body: JSON.stringify({
        sender: 'Rahul',
        body: 'yaar kal milte hai',
        app: 'com.whatsapp',
        tone: 'auto',
      }),
    });
    const body = await json<ReplyResponse>(auto);
    expect(body.tone).toBe('casual_hinglish');
  });

  it('lists devices and revokes one', async () => {
    const enrolled = await enroll('Old phone');
    const list = await admin('/admin/api/devices');
    const listed = await json<{
      devices: Array<{ id: string; token_hash?: string; online: boolean }>;
    }>(list);
    expect(listed.devices).toHaveLength(1);
    expect(listed.devices[0].id).toBe(enrolled.device_id);
    expect(listed.devices[0]).not.toHaveProperty('token_hash');
    expect(listed.devices[0].online).toBe(true);

    const revoke = await admin(`/admin/api/devices/${enrolled.device_id}`, {
      method: 'DELETE',
    });
    expect(revoke.status).toBe(200);

    const after = await phone('/v1/me', {}, enrolled.token);
    expect(after.status).toBe(401);
  });

  it('revokes all devices', async () => {
    await enroll('One');
    await enroll('Two');
    const response = await admin('/admin/api/devices/revoke-all', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ revoked: 2 });
  });

  it('filters and paginates events', async () => {
    for (let index = 0; index < 3; index += 1) {
      await admin('/admin/api/playground', {
        method: 'POST',
        body: JSON.stringify({
          sender: `Person ${index}`,
          body: 'hello',
          app: index === 0 ? 'com.whatsapp' : 'com.microsoft.teams',
        }),
      });
    }

    const page = await admin(
      '/admin/api/events?limit=2&offset=0&source=playground&from_ai=false',
    );
    const body = await json<EventResponse>(page);
    expect(body.total).toBe(3);
    expect(body.events).toHaveLength(2);
    expect(body.limit).toBe(2);

    const apps = await admin('/admin/api/events?app=com.whatsapp');
    const filtered = await json<EventResponse>(apps);
    expect(filtered.total).toBe(1);

    const invalid = await admin('/admin/api/events?limit=0');
    expect(invalid.status).toBe(400);
  });

  it('overview returns the expected shape and a 24-bucket sparkline', async () => {
    const response = await admin('/admin/api/overview');
    expect(response.status).toBe(200);
    const body = await json<{
      version: string;
      environment: string;
      auth_mode: string;
      groq_configured: boolean;
      devices: { total: number; online: number; revoked: number };
      today: { replies: number; ai_success_rate: number | null };
      latency: { p50_ms: number | null; p95_ms: number | null; samples: number };
      sparkline: Array<{ hour: string; replies: number }>;
      recent: unknown[];
      onboarding: { has_device: boolean; has_event: boolean };
    }>(response);

    expect(body.version).toBe('test');
    expect(body.environment).toBe('test');
    expect(body.auth_mode).toBe('dev');
    expect(body.groq_configured).toBe(false);
    expect(body.sparkline).toHaveLength(24);
    expect(body.latency.samples).toBe(0);
    expect(body.latency.p50_ms).toBeNull();
    expect(body.onboarding.has_device).toBe(false);
  });

  it('deletes all events', async () => {
    await admin('/admin/api/playground', {
      method: 'POST',
      body: JSON.stringify({ sender: 'A', body: 'hello' }),
    });
    const response = await admin('/admin/api/events', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ deleted: 1 });

    const list = await admin('/admin/api/events');
    expect((await json<EventResponse>(list)).total).toBe(0);
  });
});

describe('privacy schema', () => {
  it('has no message body column on events', async () => {
    const { env } = await import('cloudflare:test');
    const columns = await env.DB.prepare('PRAGMA table_info(events)').all<{
      name: string;
    }>();
    const names = columns.results.map((column) => column.name.toLowerCase());
    expect(names).not.toContain('body');
    expect(names).not.toContain('message');
    expect(names).not.toContain('text');
    expect(names).not.toContain('content');
    expect(names).toContain('sender_alias');
  });
});

describe('access verification', () => {
  it('allows the dev bypass outside production', async () => {
    const { env } = await import('cloudflare:test');
    const result = await verifyAccess(
      new Request(`${DASHBOARD}/`),
      env as unknown as Env,
    );
    expect(result).toMatchObject({ ok: true, mode: 'dev' });
  });

  it('fails closed when production is missing Access config', async () => {
    const { env } = await import('cloudflare:test');
    const fake = {
      ...env,
      ENVIRONMENT: 'production',
      AUTH_MODE: 'access',
      ACCESS_TEAM_DOMAIN: '',
      ACCESS_AUD: '',
    } as unknown as Env;
    const result = await verifyAccess(new Request(`${DASHBOARD}/`), fake);
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it('refuses a production deployment that left dev auth on', async () => {
    const { env } = await import('cloudflare:test');
    const fake = {
      ...env,
      ENVIRONMENT: 'production',
      AUTH_MODE: 'dev',
    } as unknown as Env;
    const result = await verifyAccess(new Request(`${DASHBOARD}/`), fake);
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it('requires the Access JWT header when configured', async () => {
    const { env } = await import('cloudflare:test');
    const fake = {
      ...env,
      ENVIRONMENT: 'production',
      AUTH_MODE: 'access',
      ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      ACCESS_AUD: 'aud-tag',
    } as unknown as Env;
    const result = await verifyAccess(new Request(`${DASHBOARD}/`), fake);
    expect(result).toMatchObject({ ok: false, status: 401 });
  });
});
