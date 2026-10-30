/** Tone inference and prompt construction. */

import type { IncomingMessage, Tone } from './model';
import { WATCH_REPLY_MAX_CHARS } from './sanitize';

/** Apps whose traffic is work by default. */
const PROFESSIONAL_APPS = new Set([
  'com.microsoft.teams',
  'com.slack',
  'com.google.android.gm',
  'com.linkedin.android',
  'com.microsoft.office.outlook',
]);

/**
 * Latin-script Hinglish markers. Matched as whole words — "hai" must not fire
 * on "hair", and "ho" must not fire on "hotel".
 */
const HINGLISH_MARKERS = new Set([
  'hai', 'haan', 'nahi', 'nahin', 'kya', 'kaise', 'kab', 'kahan', 'theek',
  'thik', 'acha', 'accha', 'yaar', 'bhai', 'arre', 'abhi', 'chal', 'chalo',
  'karo', 'kar', 'raha', 'rahi', 'hoga', 'hogi', 'mat', 'bas', 'matlab',
  'kaam', 'ghar', 'aaj', 'kal', 'milte', 'bhej', 'bol', 'bola', 'dekh',
  'ho', 'na', 'ji', 'ki', 'ka', 'ke', 'mein', 'tera', 'tumhara', 'apna',
]);

const WORD = /[a-z]+/g;

/**
 * Pick the register to reply in.
 *
 * Order matters: a work app wins outright, because replying "haan bhai" to a
 * Teams message is a worse failure than replying formally to a friend.
 */
export function inferTone(msg: IncomingMessage): Tone {
  if (PROFESSIONAL_APPS.has(msg.app)) return 'professional';

  // Weigh the whole thread, not just the latest message — one-word messages
  // ("ok") carry almost no signal on their own.
  const corpus = [...msg.history, msg.body].join(' ').toLowerCase();
  const words = corpus.match(WORD) ?? [];
  if (words.length === 0) return 'casual_english';

  let hits = 0;
  for (const word of words) {
    if (HINGLISH_MARKERS.has(word)) hits += 1;
  }

  // Hinglish markers are common short words; a couple of incidental hits in a
  // long English message shouldn't flip the register.
  if (hits >= 2 || (hits === 1 && words.length <= 6)) {
    return 'casual_hinglish';
  }
  return 'casual_english';
}

const TONE_GUIDANCE: Record<Tone, string> = {
  casual_hinglish:
    "Casual Hinglish, Latin script only (never Devanagari). " +
    "How a friend texts: 'haan theek hai', 'abhi busy hu', 'thoda late hounga'.",
  casual_english:
    'Casual English. Relaxed and short, how you\'d text a friend. ' +
    'Contractions fine, no corporate phrasing.',
  professional:
    'Professional English. Courteous and concise. ' +
    'No slang, no emoji, no exclamation marks.',
};

const SYSTEM_PROMPT = `You write smartwatch quick replies.

Output exactly three replies to the message, as JSON:
{{"positive": "...", "neutral": "...", "decline": "..."}}

positive = agree or accept. neutral = acknowledge or defer without committing.
decline = say no or not now, politely.

Hard rules:
- Each reply at most {{max_chars}} characters. They render on a watch face.
- ASCII characters only. No emoji.
- Reply as the RECIPIENT, in first person. Never restate the question.
- The three must be genuinely different choices, not rewordings.
- Tone: {{tone_guidance}}

Output the JSON object only.`;

export function buildSystemPrompt(tone: Tone): string {
  return SYSTEM_PROMPT.replace('{{max_chars}}', String(WATCH_REPLY_MAX_CHARS))
    .replace('{{tone_guidance}}', TONE_GUIDANCE[tone])
    .replaceAll('{{', '{')
    .replaceAll('}}', '}');
}

export function buildUserPrompt(msg: IncomingMessage): string {
  const lines: string[] = [];
  if (msg.history.length > 0) {
    // Last few only: notification-derived history is unreliable, and stale
    // turns drag the reply off-topic.
    lines.push('Earlier in this thread:');
    for (const h of msg.history.slice(-4)) {
      lines.push('  ' + h);
    }
    lines.push('');
  }
  lines.push('From: ' + msg.sender);
  lines.push('Message: ' + msg.body);
  return lines.join('\n');
}
