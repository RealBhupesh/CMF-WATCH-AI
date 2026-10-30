/**
 * Core types for the reply engine.
 *
 * Free of HTTP, D1 and BLE concerns. This layer is needed whichever way F1
 * lands, so it must not depend on the answer.
 */

export const INTENTS = ['positive', 'neutral', 'decline'] as const;
export type Intent = (typeof INTENTS)[number];

export const TONES = [
  'casual_hinglish',
  'casual_english',
  'professional',
] as const;
export type Tone = (typeof TONES)[number];

export interface IncomingMessage {
  sender: string;
  body: string;
  /** Package name, e.g. "com.whatsapp". */
  app: string;
  /** Prior messages in the same thread, oldest first. Best-effort and often empty. */
  history: string[];
}

export interface Reply {
  text: string;
  intent: Intent;
}

/**
 * Exactly three replies, ready to write to the watch.
 *
 * `fromAi` is false when generation failed and we fell back to static text.
 * The UI must not imply intelligence we did not deliver.
 */
export interface ReplySet {
  replies: Reply[];
  tone: Tone;
  fromAi: boolean;
}

export interface GenerationResult {
  replySet: ReplySet;
  latencyMs: number;
  error?: string;
}

export function isTone(value: unknown): value is Tone {
  return typeof value === 'string' && (TONES as readonly string[]).includes(value);
}
