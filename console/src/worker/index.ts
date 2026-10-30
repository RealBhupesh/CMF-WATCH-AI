import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';

import { accessAuth } from './auth/access';
import { prune } from './db/queries';
import type { Env } from './env';
import {
  applySecurityHeaders,
  fail,
  isAdminPath,
  isApiHost,
  isApiPath,
  isDashboardHost,
  json,
  requestId,
  requestLogger,
  securityHeaders,
} from './lib/http';
import { admin } from './routes/admin';
import { v1 } from './routes/v1';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

/**
 * One gate for both hostnames.
 *
 * - `/healthz` stays public.
 * - Phone routes only exist on the API host.
 * - Admin routes and dashboard assets only exist on the dashboard host, and
 *   always pass Access verification first. Static assets are not left to the
 *   asset worker, because that would let a direct hit skip the JWT check.
 */
const gate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;

  if (path === '/healthz') return next();

  if (isApiPath(path)) {
    if (!isApiHost(c)) return fail(c, 404, 'not_found');
    return next();
  }

  if (!isDashboardHost(c)) return fail(c, 404, 'not_found');
  if (isAdminPath(path) || !isApiPath(path)) {
    return accessAuth(c, next);
  }

  return next();
};

app.use('*', requestId);
app.use('*', securityHeaders);
app.use('*', requestLogger);
app.use('*', gate);

app.get('/healthz', (c) =>
  json(c, {
    ok: true,
    version: c.env.VERSION,
  }),
);

app.route('/v1', v1);
app.route('/admin/api', admin);

// A wrong method on a known prefix should still look like an API, not like a
// dashboard route that could fall through to index.html.
app.all('/v1/*', (c) => fail(c, 404, 'not_found'));
app.all('/admin/api/*', (c) => fail(c, 404, 'not_found'));

app.get('*', async (c) => {
  if (!c.env.ASSETS) {
    return c.text(
      'Dashboard assets are not built. Run `npm run build`, or use the Vite dev server.\n',
      404,
    );
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.all('*', (c) => fail(c, 405, 'method_not_allowed'));

app.notFound((c) => fail(c, 404, 'not_found'));

app.onError((error, c) => {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'unhandled_error',
      request_id: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  c.header('Cache-Control', 'no-store');
  const response = c.json({ error: 'server_error' }, 500);
  applySecurityHeaders(response.headers, c.env);
  return response;
});

const worker: ExportedHandler<Env> = {
  fetch: app.fetch,
  scheduled: async (_event, env, ctx) => {
    ctx.waitUntil(
      prune(env).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'retention_prune_failed',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    );
  },
};

export default worker;
