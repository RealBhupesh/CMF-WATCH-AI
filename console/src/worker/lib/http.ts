import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

import type { Env } from '../env';
import type { AppEnv } from '../types';

/** PRD scope item 5: notification payloads stay small and ephemeral. */
export const MAX_BODY_BYTES = 16 * 1024;

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export type ErrorCode =
  | 'bad_request'
  | 'invalid_body'
  | 'invalid_json'
  | 'body_too_large'
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_code'
  | 'opted_out'
  | 'rate_limited'
  | 'not_found'
  | 'method_not_allowed'
  | 'auth_misconfigured'
  | 'server_error'
  | 'server_misconfigured';

export function json<T>(
  c: Context<AppEnv>,
  data: T,
  status: ContentfulStatusCode = 200,
): Response {
  c.header('Cache-Control', 'no-store');
  return c.json(data, status);
}

export function fail(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  error: ErrorCode,
  extra: Record<string, unknown> = {},
): Response {
  return json(c, { error, ...extra }, status);
}

export type ReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

/**
 * Read and validate JSON without ever retaining the raw body.
 *
 * Content-Length is checked first so an oversized upload is rejected before
 * buffering; the post-read byte count covers chunked requests that omit it.
 */
export async function readJson<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
  maxBytes = MAX_BODY_BYTES,
): Promise<ReadResult<z.infer<S>>> {
  const declared = c.req.header('content-length');
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      return {
        ok: false,
        response: fail(c, 413, 'body_too_large', { max_bytes: maxBytes }),
      };
    }
  }

  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return { ok: false, response: fail(c, 400, 'invalid_json') };
  }

  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return {
      ok: false,
      response: fail(c, 413, 'body_too_large', { max_bytes: maxBytes }),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, response: fail(c, 400, 'invalid_json') };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    // Issue values can echo the submitted body. Only paths and codes leave the
    // Worker so a validation error never becomes a place message text is kept.
    return {
      ok: false,
      response: fail(c, 400, 'invalid_body', {
        details: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      }),
    };
  }

  return { ok: true, data: result.data };
}

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const supplied = c.req.header('x-request-id');
  const id =
    supplied && REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
};

/**
 * Never log the request body, query string, sender alias or message text.
 * Route + status + device id is enough to debug an outage.
 */
export const requestLogger: MiddlewareHandler<AppEnv> = async (c, next) => {
  const started = Date.now();
  await next();
  const device = c.get('device');
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'request',
      request_id: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - started,
      ...(device ? { device_id: device.id } : {}),
    }),
  );
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function applySecurityHeaders(headers: Headers, env: Env): void {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );

  const contentType = headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    headers.set(
      'Content-Security-Policy',
      env.ENVIRONMENT === 'production'
        ? `${CSP}; upgrade-insecure-requests`
        : CSP,
    );
  }
  if (env.ENVIRONMENT === 'production') {
    headers.set(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  }
}

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const requestIdValue = c.get('requestId') ?? '';
  try {
    applySecurityHeaders(c.res.headers, c.env);
    if (requestIdValue) c.res.headers.set('X-Request-Id', requestIdValue);
  } catch {
    // Static-asset responses expose immutable headers. Copy them before
    // adding policy so the asset body can still stream through untouched.
    const headers = new Headers(c.res.headers);
    applySecurityHeaders(headers, c.env);
    if (requestIdValue) headers.set('X-Request-Id', requestIdValue);
    c.res = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  }
};

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Accept `watchai.example.com`, `https://watchai.example.com/`, or a host:port. */
export function normalizeConfiguredHost(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    return raw.split('/')[0].split(':')[0];
  }
}

export function isDashboardHost(c: Context<AppEnv>): boolean {
  const host = hostnameOf(c.req.url);
  const configured = normalizeConfiguredHost(c.env.DASHBOARD_HOST);
  if (configured && host === configured) return true;
  return c.env.ENVIRONMENT !== 'production' && LOCAL_HOSTS.has(host);
}

export function isApiHost(c: Context<AppEnv>): boolean {
  const host = hostnameOf(c.req.url);
  const configured = normalizeConfiguredHost(c.env.API_HOST);
  if (configured && host === configured) return true;
  return c.env.ENVIRONMENT !== 'production' && LOCAL_HOSTS.has(host);
}

export function isApiPath(path: string): boolean {
  return path === '/v1' || path.startsWith('/v1/');
}

export function isAdminPath(path: string): boolean {
  return path === '/admin/api' || path.startsWith('/admin/api/');
}
