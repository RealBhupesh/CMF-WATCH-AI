import { beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import schema from '../migrations/0001_init.sql?raw';

beforeAll(async () => {
  // D1's exec splits on statement boundaries and trips over leading comments.
  const sql = schema
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
});
