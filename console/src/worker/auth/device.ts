import type { MiddlewareHandler } from 'hono';

import type { Env } from '../env';
import type { AppEnv } from '../types';
import { getDeviceByTokenHash, touchDevice } from '../db/queries';
import { fail } from '../lib/http';

const TOKEN_PREFIX = 'wai_';
const TOKEN_BYTES = 32;
const CODE_LENGTH = 10;

/**
 * No I, O, 0 or 1. The code gets read off a screen and typed into a phone, and
 * those four cannot be told apart at a glance.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const DEV_PEPPER = 'watchai-local-dev-pepper';

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateDeviceToken(): string {
  return TOKEN_PREFIX + randomBase64Url(TOKEN_BYTES);
}

export function generateEnrollmentCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const byte of bytes) {
    // 256 % 32 === 0, so the modulo is unbiased.
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return code;
}

export function normalizeEnrollmentCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export function pepperFor(env: Env): string {
  return env.TOKEN_PEPPER && env.TOKEN_PEPPER.length > 0
    ? env.TOKEN_PEPPER
    : DEV_PEPPER;
}

export function isPepperConfigured(env: Env): boolean {
  return Boolean(env.TOKEN_PEPPER && env.TOKEN_PEPPER.length >= 16);
}

/**
 * SHA-256(pepper + token). Only this digest is stored, so a D1 dump cannot be
 * replayed against the API. The pepper lives in a Worker secret, not the DB.
 */
export async function hashSecret(env: Env, secret: string): Promise<string> {
  const data = new TextEncoder().encode(pepperFor(env) + secret);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function enrollmentExpiry(minutes = 10): {
  sql: string;
  iso: string;
} {
  const at = new Date(Date.now() + minutes * 60 * 1000);
  return {
    sql: at.toISOString().slice(0, 19).replace('T', ' '),
    iso: at.toISOString(),
  };
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Resolve a phone bearer token to an active device. A revoked device is
 * rejected immediately because the lookup filters on revoked_at.
 */
export const deviceAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearerToken(c.req.raw);
  if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 128) {
    return fail(c, 401, 'unauthorized');
  }

  const tokenHash = await hashSecret(c.env, token);
  const device = await getDeviceByTokenHash(c.env, tokenHash);
  if (!device) return fail(c, 401, 'unauthorized');

  c.set('device', device);

  // Last-seen is telemetry, not authorization. A failed write must not stop a
  // reply the user is waiting on.
  try {
    await touchDevice(c.env, device);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'warn',
        msg: 'touch_device_failed',
        request_id: c.get('requestId'),
        device_id: device.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  await next();
};
