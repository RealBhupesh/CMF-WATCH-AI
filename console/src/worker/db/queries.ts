/** D1 access. Every query is prepared; nothing interpolates untrusted text. */

import type { Env } from '../env';

export interface DeviceRow {
  id: string;
  name: string;
  token_hash: string;
  platform: string;
  app_version: string;
  watch_name: string;
  watch_firmware: string;
  battery: number | null;
  last_seen_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export type PublicDevice = Omit<DeviceRow, 'token_hash'>;

export interface EventRow {
  id: string;
  device_id: string | null;
  source: 'phone' | 'playground' | 'lab';
  app: string;
  sender_alias: string;
  latency_ms: number;
  from_ai: number;
  reply_count: number;
  outcome: 'generated' | 'delivered' | 'failed' | 'opted_out';
  created_at: string;
}

export interface SettingsRow {
  id: number;
  model: string;
  forced_tone: string;
  opt_outs: string;
  retention_days: number;
  updated_at: string;
}

export interface EventInput {
  id: string;
  deviceId?: string | null;
  source: EventRow['source'];
  app: string;
  senderAlias: string;
  latencyMs: number;
  fromAi: boolean;
  replyCount: number;
  outcome: EventRow['outcome'];
}

export interface EventFilters {
  source?: EventRow['source'];
  app?: string;
  fromAi?: boolean;
  outcome?: EventRow['outcome'];
}

const DEFAULT_SETTINGS: SettingsRow = {
  id: 1,
  model: 'llama-3.3-70b-versatile',
  forced_tone: 'auto',
  opt_outs: '[]',
  retention_days: 30,
  updated_at: '',
};

export function toPublicDevice(row: DeviceRow): PublicDevice {
  const { token_hash: _tokenHash, ...device } = row;
  return device;
}

export async function getSettings(env: Env): Promise<SettingsRow> {
  const row = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first<SettingsRow>();
  return row ?? DEFAULT_SETTINGS;
}

export async function updateSettings(
  env: Env,
  input: {
    model: string;
    forcedTone: string;
    optOuts: string[];
    retentionDays: number;
  },
): Promise<SettingsRow> {
  await env.DB.prepare(
    `UPDATE settings
       SET model = ?, forced_tone = ?, opt_outs = ?, retention_days = ?,
           updated_at = datetime('now')
     WHERE id = 1`,
  )
    .bind(input.model, input.forcedTone, JSON.stringify(input.optOuts), input.retentionDays)
    .run();
  return getSettings(env);
}

export async function listDevices(env: Env): Promise<PublicDevice[]> {
  const result = await env.DB.prepare(
    'SELECT * FROM devices ORDER BY created_at DESC',
  ).all<DeviceRow>();
  return result.results.map(toPublicDevice);
}

export async function getDevice(env: Env, id: string): Promise<PublicDevice | null> {
  const row = await env.DB.prepare('SELECT * FROM devices WHERE id = ?')
    .bind(id)
    .first<DeviceRow>();
  return row ? toPublicDevice(row) : null;
}

export async function getDeviceByTokenHash(
  env: Env,
  tokenHash: string,
): Promise<DeviceRow | null> {
  return env.DB.prepare(
    'SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL',
  )
    .bind(tokenHash)
    .first<DeviceRow>();
}

export async function createDevice(
  env: Env,
  input: {
    id: string;
    name: string;
    tokenHash: string;
    platform: string;
    appVersion: string;
  },
): Promise<DeviceRow> {
  await env.DB.prepare(
    `INSERT INTO devices (id, name, token_hash, platform, app_version, last_seen_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(input.id, input.name, input.tokenHash, input.platform, input.appVersion)
    .run();
  const row = await env.DB.prepare('SELECT * FROM devices WHERE id = ?')
    .bind(input.id)
    .first<DeviceRow>();
  if (!row) throw new Error('device insert failed');
  return row;
}

export async function touchDevice(env: Env, device: DeviceRow): Promise<void> {
  const last = device.last_seen_at
    ? Date.parse(device.last_seen_at.replace(' ', 'T') + 'Z')
    : 0;
  if (Number.isFinite(last) && Date.now() - last < 5 * 60 * 1000) return;
  await env.DB.prepare("UPDATE devices SET last_seen_at = datetime('now') WHERE id = ?")
    .bind(device.id)
    .run();
}

export async function heartbeat(
  env: Env,
  deviceId: string,
  input: { watchName?: string; watchFirmware?: string; battery?: number },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE devices
        SET last_seen_at = datetime('now'),
            watch_name = COALESCE(?, watch_name),
            watch_firmware = COALESCE(?, watch_firmware),
            battery = COALESCE(?, battery)
      WHERE id = ?`,
  )
    .bind(
      input.watchName ?? null,
      input.watchFirmware ?? null,
      input.battery ?? null,
      deviceId,
    )
    .run();
}

export async function revokeDevice(env: Env, id: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE devices SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL",
  )
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function revokeAllDevices(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    "UPDATE devices SET revoked_at = datetime('now') WHERE revoked_at IS NULL",
  ).run();
  return result.meta.changes ?? 0;
}

export async function createEnrollmentCode(
  env: Env,
  codeHash: string,
  expiresAt: string,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO enrollment_codes (code_hash, expires_at) VALUES (?, ?)',
  )
    .bind(codeHash, expiresAt)
    .run();
}

export async function consumeEnrollmentCode(
  env: Env,
  codeHash: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT code_hash FROM enrollment_codes
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`,
  )
    .bind(codeHash)
    .first<{ code_hash: string }>();
  if (!row) return false;

  const result = await env.DB.prepare(
    "UPDATE enrollment_codes SET used_at = datetime('now') WHERE code_hash = ? AND used_at IS NULL",
  )
    .bind(codeHash)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function insertEvent(env: Env, input: EventInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events
       (id, device_id, source, app, sender_alias, latency_ms, from_ai, reply_count, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.deviceId ?? null,
      input.source,
      input.app,
      input.senderAlias,
      input.latencyMs,
      input.fromAi ? 1 : 0,
      input.replyCount,
      input.outcome,
    )
    .run();
}

export async function listEvents(
  env: Env,
  filters: EventFilters,
  limit: number,
  offset: number,
): Promise<{ events: EventRow[]; total: number }> {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (filters.source) {
    where.push('source = ?');
    params.push(filters.source);
  }
  if (filters.app) {
    where.push('app = ?');
    params.push(filters.app);
  }
  if (filters.fromAi !== undefined) {
    where.push('from_ai = ?');
    params.push(filters.fromAi ? 1 : 0);
  }
  if (filters.outcome) {
    where.push('outcome = ?');
    params.push(filters.outcome);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM events ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
      .bind(...params, limit, offset)
      .all<EventRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM events ${clause}`)
      .bind(...params)
      .first<{ n: number }>(),
  ]);

  return { events: rows.results, total: count?.n ?? 0 };
}

export async function deleteAllEvents(env: Env): Promise<number> {
  const result = await env.DB.prepare('DELETE FROM events').run();
  return result.meta.changes ?? 0;
}

export async function countEvents(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>();
  return row?.n ?? 0;
}

export interface DeviceCounts {
  total: number;
  online: number;
  revoked: number;
}

export async function getDeviceCounts(env: Env): Promise<DeviceCounts> {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE
         WHEN revoked_at IS NULL AND last_seen_at >= datetime('now', '-5 minutes')
         THEN 1 ELSE 0 END), 0) AS online,
       COALESCE(SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS revoked
     FROM devices`,
  ).first<DeviceCounts>();
  return {
    total: row?.total ?? 0,
    online: row?.online ?? 0,
    revoked: row?.revoked ?? 0,
  };
}

export interface TodayStats {
  replies: number;
  ai_replies: number;
  fallbacks: number;
  opted_out: number;
}

export async function getTodayStats(env: Env): Promise<TodayStats> {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN outcome = 'generated' THEN 1 ELSE 0 END), 0) AS replies,
       COALESCE(SUM(CASE WHEN outcome = 'generated' AND from_ai = 1 THEN 1 ELSE 0 END), 0) AS ai_replies,
       COALESCE(SUM(CASE WHEN outcome = 'generated' AND from_ai = 0 THEN 1 ELSE 0 END), 0) AS fallbacks,
       COALESCE(SUM(CASE WHEN outcome = 'opted_out' THEN 1 ELSE 0 END), 0) AS opted_out
     FROM events
     WHERE created_at >= datetime('now', 'start of day')`,
  ).first<TodayStats>();
  return {
    replies: row?.replies ?? 0,
    ai_replies: row?.ai_replies ?? 0,
    fallbacks: row?.fallbacks ?? 0,
    opted_out: row?.opted_out ?? 0,
  };
}

/**
 * Latency samples for the percentile cards. Bounded so a busy year cannot make
 * an overview request expensive; the percentile is over recent traffic anyway.
 */
export async function getRecentLatencies(env: Env, hours = 24, cap = 5000): Promise<number[]> {
  const result = await env.DB.prepare(
    `SELECT latency_ms FROM events
      WHERE outcome = 'generated' AND created_at >= datetime('now', ?)
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(`-${hours} hours`, cap)
    .all<{ latency_ms: number }>();
  return result.results.map((row) => row.latency_ms);
}

export interface SparklineRow {
  hour: string;
  replies: number;
  avg_latency_ms: number;
}

export async function getSparkline(env: Env, hours = 24): Promise<SparklineRow[]> {
  const result = await env.DB.prepare(
    `SELECT
       strftime('%Y-%m-%d %H:00:00', created_at) AS hour,
       COUNT(*) AS replies,
       CAST(COALESCE(AVG(latency_ms), 0) AS INTEGER) AS avg_latency_ms
     FROM events
     WHERE outcome = 'generated' AND created_at >= datetime('now', ?)
     GROUP BY hour
     ORDER BY hour ASC`,
  )
    .bind(`-${hours} hours`)
    .all<SparklineRow>();
  return result.results;
}

export async function prune(env: Env): Promise<void> {
  const settings = await getSettings(env);
  const cutoff = new Date(
    Date.now() - settings.retention_days * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  await env.DB.prepare('DELETE FROM events WHERE created_at < ?').bind(cutoff).run();
  await env.DB.prepare("DELETE FROM enrollment_codes WHERE expires_at < datetime('now')").run();
  const rateCutoff = Math.floor(Date.now() / 1000 / 60) - 10;
  await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(rateCutoff)
    .run();
}

/**
 * Fixed-window-per-caller limiter backed by D1. A restart does not forgive
 * callers; a runaway notification loop still hits the ceiling.
 */
export async function allowRequest(
  env: Env,
  key: string,
  limit: number,
  windowSeconds = 60,
): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE
         WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1
         ELSE 1
       END,
       window_start = excluded.window_start
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}
