import { z } from 'zod';

const TONES = ['auto', 'casual_hinglish', 'casual_english', 'professional'] as const;
const SOURCES = ['phone', 'playground', 'lab'] as const;
const OUTCOMES = ['generated', 'delivered', 'failed', 'opted_out'] as const;

export const toneSchema = z.enum(TONES);

const senderSchema = z.string().trim().max(80);
const appSchema = z.string().trim().max(100);
const bodySchema = z.string().trim().min(1).max(6000);
const historySchema = z
  .array(z.string().max(2000))
  .max(50)
  .transform((items) => items.filter((item) => item.trim().length > 0).slice(-10));

export const replyRequestSchema = z.object({
  sender: senderSchema.optional(),
  body: bodySchema,
  app: appSchema.optional(),
  history: historySchema.optional(),
});

export const playgroundSchema = replyRequestSchema.extend({
  tone: toneSchema.optional(),
});

export const enrollSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(60),
  platform: z.string().trim().max(40).optional(),
  app_version: z.string().trim().max(40).optional(),
});

export const eventSchema = z.object({
  app: appSchema.default(''),
  sender_alias: z.string().trim().max(80).default(''),
  latency_ms: z.number().int().min(0).max(60_000),
  from_ai: z.boolean(),
  reply_count: z.number().int().min(0).max(10),
  outcome: z.enum(OUTCOMES),
});

export const heartbeatSchema = z.object({
  watch_name: z.string().trim().max(80).optional(),
  watch_firmware: z.string().trim().max(80).optional(),
  battery: z.number().int().min(0).max(100).optional(),
});

export const settingsSchema = z.object({
  model: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._:/-]+$/, 'model id contains unsupported characters'),
  forced_tone: toneSchema,
  opt_outs: z.array(z.string().trim().min(1).max(100)).max(200),
  retention_days: z.number().int().min(1).max(365),
});

export const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  source: z.enum(SOURCES).optional(),
  app: z.string().trim().max(100).optional(),
  from_ai: z.enum(['true', 'false', '1', '0']).optional(),
  outcome: z.enum(OUTCOMES).optional(),
});

export interface EventQuery {
  limit: number;
  offset: number;
  source?: (typeof SOURCES)[number];
  app?: string;
  fromAi?: boolean;
  outcome?: (typeof OUTCOMES)[number];
}

export function toEventQuery(parsed: z.infer<typeof eventsQuerySchema>): EventQuery {
  return {
    limit: parsed.limit,
    offset: parsed.offset,
    ...(parsed.source ? { source: parsed.source } : {}),
    ...(parsed.app ? { app: parsed.app } : {}),
    ...(parsed.from_ai !== undefined
      ? { fromAi: parsed.from_ai === 'true' || parsed.from_ai === '1' }
      : {}),
    ...(parsed.outcome ? { outcome: parsed.outcome } : {}),
  };
}
