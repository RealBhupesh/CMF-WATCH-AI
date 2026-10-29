import { z } from "zod";

export const WATCH_MIN_INTERVAL_MINUTES = 15;
export const WATCH_MAX_INTERVAL_MINUTES = 10_080;
export const WATCH_MAX_COUNT = 200;
export const WATCH_MAX_EVENTS = 500;
export const WATCH_MAX_DIFF_LINES = 200;
export const WATCH_MAX_DIFF_LINE_CHARS = 500;
export const WATCH_MAX_EXCERPT_CHARS = 2_000;
export const WATCH_MAX_FAILURES = 5;

export const watchStatusSchema = z.enum(["active", "paused", "blocked"]);
export type WatchStatus = z.infer<typeof watchStatusSchema>;

export const watchCheckResultSchema = z.enum([
  "baseline",
  "unchanged",
  "changed",
  "error",
]);
export type WatchCheckResult = z.infer<typeof watchCheckResultSchema>;

export const watchCheckSchema = z.object({
  at: z.string(),
  result: watchCheckResultSchema,
  durationMs: z.number().int().nonnegative(),
  error: z.string().max(2_000).optional(),
});
export type WatchCheck = z.infer<typeof watchCheckSchema>;

export const watchBaselineSchema = z.object({
  hash: z.string().min(1),
  title: z.string(),
  url: z.string(),
  capturedAt: z.string(),
  chars: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type WatchBaseline = z.infer<typeof watchBaselineSchema>;

export const watchSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(200),
  url: z.string().url(),
  intent: z.string().min(1).max(1_000),
  selector: z.string().min(1).max(500).optional(),
  intervalMinutes: z
    .number()
    .int()
    .min(WATCH_MIN_INTERVAL_MINUTES)
    .max(WATCH_MAX_INTERVAL_MINUTES),
  sessionId: z.string().min(1),
  status: watchStatusSchema,
  baseline: watchBaselineSchema.optional(),
  lastCheck: watchCheckSchema.optional(),
  lastChangeAt: z.string().optional(),
  nextRunAt: z.string(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastError: z.string().max(2_000).optional(),
  reason: z.string().max(200).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Watch = z.infer<typeof watchSchema>;

export const watchEventSchema = z.object({
  id: z.uuid(),
  watchId: z.uuid(),
  watchName: z.string().min(1).max(200),
  url: z.string(),
  previousUrl: z.string().optional(),
  title: z.string(),
  previousTitle: z.string().optional(),
  titleChanged: z.boolean(),
  intent: z.string().min(1).max(1_000),
  detectedAt: z.string(),
  added: z.array(z.string()).max(WATCH_MAX_DIFF_LINES),
  removed: z.array(z.string()).max(WATCH_MAX_DIFF_LINES),
  addedCount: z.number().int().nonnegative(),
  removedCount: z.number().int().nonnegative(),
  diffTruncated: z.boolean(),
  currentExcerpt: z.string().max(WATCH_MAX_EXCERPT_CHARS),
  snapshotChars: z.number().int().nonnegative(),
  truncated: z.boolean(),
  acknowledgedAt: z.string().optional(),
});
export type WatchEvent = z.infer<typeof watchEventSchema>;

export interface NewWatch {
  name: string;
  url: string;
  intent: string;
  selector?: string;
  intervalMinutes: number;
  sessionId: string;
}

export function watchIntervalMs(watch: Pick<Watch, "intervalMinutes">): number {
  return watch.intervalMinutes * 60_000;
}
