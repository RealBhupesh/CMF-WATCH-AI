/**
 * Reply generation: Groq when it answers in time, static fallback when it doesn't.
 *
 * The network call goes through an injectable transport so tests never touch
 * the internet and never need an API key.
 */

import {
  INTENTS,
  type GenerationResult,
  type IncomingMessage,
  type Intent,
  type Reply,
  type ReplySet,
  type Tone,
} from './model';
import { buildSystemPrompt, buildUserPrompt, inferTone } from './prompt';
import { dedupe, sanitizeReply } from './sanitize';

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

/** PRD latency budget allows 1200 ms for generation. */
export const TIMEOUT_MS = 1200;

/**
 * Static fallbacks. Every tone x intent covered: this path runs whenever the
 * network, the key, the model or the budget fails, which is not a rare case.
 */
const FALLBACKS: Record<Tone, Record<Intent, string>> = {
  casual_hinglish: {
    positive: 'Haan theek hai',
    neutral: 'Abhi busy hu, baad mein baat karte hai',
    decline: 'Nahi yaar, aaj nahi ho payega',
  },
  casual_english: {
    positive: 'Yeah sounds good',
    neutral: 'Busy right now, will get back to you',
    decline: "Can't today, sorry",
  },
  professional: {
    positive: 'Yes, that works for me.',
    neutral: 'Noted. I will follow up shortly.',
    decline: 'I am not available for that, apologies.',
  },
};

export type Transport = (
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number,
) => Promise<string>;

export interface GenerateOptions {
  transport?: Transport;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Force a register instead of inferring it. */
  tone?: Tone | 'auto';
}

export function staticReplies(tone: Tone): ReplySet {
  const table = FALLBACKS[tone];
  return {
    replies: INTENTS.map((intent) => ({
      text: sanitizeReply(table[intent]),
      intent,
    })),
    tone,
    fromAi: false,
  };
}

/**
 * Turn the model's JSON into a validated ReplySet, or null if unusable.
 *
 * Returning null rather than throwing keeps the caller's fallback path single.
 */
export function parseModelOutput(raw: string, tone: Tone): ReplySet | null {
  let content: unknown;
  try {
    const envelope = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    content = envelope.choices?.[0]?.message?.content;
  } catch {
    return null;
  }

  if (typeof content !== 'string') return null;

  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return null;
  }

  const record = obj as Record<string, unknown>;
  const replies: Reply[] = [];
  for (const intent of INTENTS) {
    const text = record[intent];
    if (typeof text !== 'string') return null;
    const clean = sanitizeReply(text);
    if (!clean) return null;
    replies.push({ text: clean, intent });
  }

  // Three slots that say the same thing is a failed generation, not a partial
  // success — the static set is more useful than one real choice plus two
  // echoes of it.
  if (dedupe(replies.map((r) => r.text)).length !== INTENTS.length) {
    return null;
  }

  return { replies, tone, fromAi: true };
}

async function httpPost(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number,
): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`groq responded ${response.status}`);
  }
  return response.text();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Produce three watch-ready replies. Never throws, never returns fewer than
 * three. `fromAi` tells the caller whether Groq actually answered.
 */
export async function generate(
  msg: IncomingMessage,
  options: GenerateOptions = {},
): Promise<GenerationResult> {
  const started = performance.now();
  const tone: Tone =
    options.tone && options.tone !== 'auto' ? options.tone : inferTone(msg);

  const done = (
    replySet: ReplySet,
    error?: string,
  ): GenerationResult => ({
    replySet,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
    ...(error ? { error } : {}),
  });

  const apiKey = options.apiKey ?? '';
  if (!apiKey) return done(staticReplies(tone), 'no api key');

  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const payload = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt(tone) },
      { role: 'user', content: buildUserPrompt(msg) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
    max_tokens: 200,
  };
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const post = options.transport ?? httpPost;
  let raw: string;
  try {
    raw = await post(GROQ_URL, headers, payload, timeoutMs);
  } catch (error) {
    return done(staticReplies(tone), `transport: ${errorMessage(error)}`);
  }

  const parsed = parseModelOutput(raw, tone);
  if (!parsed) return done(staticReplies(tone), 'unusable model output');
  return done(parsed);
}
