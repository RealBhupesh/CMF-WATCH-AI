import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';

import type { Env } from '../env';
import type { AppEnv } from '../types';
import { fail } from '../lib/http';

type Jwks = ReturnType<typeof createRemoteJWKSet>;

/**
 * JWKS handles cache signing keys per isolate. Keyed by team domain so a
 * configuration change cannot silently reuse another team's keys.
 */
const jwksCache = new Map<string, Jwks>();

function teamOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function jwksFor(origin: string): Jwks {
  const existing = jwksCache.get(origin);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(`${origin}/cdn-cgi/access/certs`), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
    timeoutDuration: 5000,
  });
  jwksCache.set(origin, jwks);
  return jwks;
}

export type AccessResult =
  | { ok: true; email: string | null; mode: 'dev' | 'access' }
  | { ok: false; status: 401 | 503; reason: string };

export async function verifyAccess(
  request: Request,
  env: Env,
): Promise<AccessResult> {
  const devBypass = env.ENVIRONMENT !== 'production' && env.AUTH_MODE === 'dev';
  if (devBypass) return { ok: true, email: null, mode: 'dev' };

  if (env.AUTH_MODE !== 'access') {
    // Deployed without Access would leave the dashboard public. Stop.
    return { ok: false, status: 503, reason: 'auth mode is not access' };
  }

  const origin = teamOrigin(env.ACCESS_TEAM_DOMAIN);
  const audience = env.ACCESS_AUD.trim();
  if (!origin || !audience) {
    return { ok: false, status: 503, reason: 'access config is incomplete' };
  }

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return { ok: false, status: 401, reason: 'missing access jwt' };

  try {
    const { payload } = await jwtVerify(token, jwksFor(origin), {
      issuer: origin,
      audience,
      algorithms: ['RS256'],
      clockTolerance: 60,
    });
    const email = typeof payload.email === 'string' ? payload.email : null;
    return { ok: true, email, mode: 'access' };
  } catch (error) {
    return {
      ok: false,
      status: 401,
      reason: error instanceof Error ? error.message : 'invalid access jwt',
    };
  }
}

export const accessAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const result = await verifyAccess(c.req.raw, c.env);
  if (!result.ok) {
    if (result.status === 503) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'access_misconfigured',
          request_id: c.get('requestId'),
          reason: result.reason,
        }),
      );
      return fail(c, 503, 'auth_misconfigured');
    }
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'access_rejected',
        request_id: c.get('requestId'),
        reason: result.reason,
      }),
    );
    return fail(c, 401, 'unauthorized');
  }

  if (result.email) c.set('ownerEmail', result.email);
  c.header('X-Auth-Mode', result.mode);
  await next();
};
