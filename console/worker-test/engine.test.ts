/**
 * Reply engine tests. No network, no API key, no Android toolchain.
 *
 * Mirrors tests/test_engine.py in the Python reference implementation.
 */

import { describe, expect, it } from 'vitest';

import {
  generate,
  parseModelOutput,
  staticReplies,
  type Transport,
} from '../src/worker/engine/generate';
import {
  INTENTS,
  TONES,
  type IncomingMessage,
  type Tone,
} from '../src/worker/engine/model';
import { buildSystemPrompt, inferTone } from '../src/worker/engine/prompt';
import {
  WATCH_REPLY_MAX_CHARS,
  dedupe,
  sanitizeReply,
} from '../src/worker/engine/sanitize';

function groqResponse(obj: Record<string, unknown>): string {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify(obj) } }],
  });
}

function transportReturning(raw: string): Transport {
  return async () => raw;
}

function transportRaising(error: Error): Transport {
  return async () => {
    throw error;
  };
}

const msg = (body: string, app = 'com.whatsapp', history: string[] = []): IncomingMessage => ({
  sender: 'Rahul',
  body,
  app,
  history,
});

describe('sanitize', () => {
  it('strips emoji and keeps words', () => {
    expect(sanitizeReply('Sounds good \u{1F44D}')).toBe('Sounds good');
  });

  it('folds accents rather than deleting letters', () => {
    expect(sanitizeReply('See you at the café')).toBe('See you at the cafe');
  });

  it('normalises smart punctuation', () => {
    expect(sanitizeReply('I’m on my way')).toBe("I'm on my way");
  });

  it('drops Devanagari', () => {
    expect(sanitizeReply('हाँ ok')).toBe('ok');
  });

  it('truncates at a word boundary', () => {
    const long = 'yes absolutely that works perfectly for me and everyone else too';
    const out = sanitizeReply(long);
    expect(out.length).toBeLessThanOrEqual(WATCH_REPLY_MAX_CHARS);
    expect(out.endsWith(' ')).toBe(false);
    expect(long.startsWith(out)).toBe(true);
    expect(out).toContain(' ');
  });

  it('never exceeds the cap when no word boundary exists', () => {
    const out = sanitizeReply('x'.repeat(200));
    expect(out).toHaveLength(WATCH_REPLY_MAX_CHARS);
  });

  it('collapses whitespace and quotes', () => {
    expect(sanitizeReply('  "yes   ok"  ')).toBe('yes ok');
  });

  it('dedupes case and punctuation-insensitively', () => {
    expect(dedupe(['Yes, ok!', 'yes ok', 'No'])).toEqual(['Yes, ok!', 'No']);
  });
});

describe('tone inference', () => {
  it('lets a work app win over casual content', () => {
    expect(inferTone(msg('haan bhai kya chal raha hai', 'com.microsoft.teams'))).toBe(
      'professional',
    );
  });

  it('detects Hinglish', () => {
    expect(inferTone(msg('yaar kal milte hai kya'))).toBe('casual_hinglish');
  });

  it('does not flag plain English as Hinglish', () => {
    expect(inferTone(msg('Are you free to grab lunch tomorrow?'))).toBe(
      'casual_english',
    );
  });

  it('does not match marker substrings', () => {
    expect(
      inferTone(msg('hair salon then karaoke at the hotel with nachos')),
    ).toBe('casual_english');
  });

  it('needs only one marker in a short message', () => {
    expect(inferTone(msg('theek?'))).toBe('casual_hinglish');
  });

  it('uses history to infer tone', () => {
    expect(inferTone(msg('ok', 'com.whatsapp', ['kal milte hai', 'haan theek hai']))).toBe(
      'casual_hinglish',
    );
  });

  it('handles an empty body', () => {
    expect(inferTone(msg(''))).toBe('casual_english');
  });
});

describe('fallbacks', () => {
  it('has three distinct watch-safe replies for every tone', () => {
    for (const tone of TONES) {
      const set = staticReplies(tone);
      expect(set.replies).toHaveLength(3);
      expect(set.replies.map((r) => r.intent)).toEqual([...INTENTS]);
      expect(dedupe(set.replies.map((r) => r.text))).toHaveLength(3);
      expect(set.fromAi).toBe(false);
      for (const reply of set.replies) {
        expect(reply.text.length).toBeGreaterThan(0);
        expect(reply.text.length).toBeLessThanOrEqual(WATCH_REPLY_MAX_CHARS);
        expect(/^[\x00-\x7F]*$/.test(reply.text)).toBe(true);
      }
    }
  });
});

describe('generate', () => {
  it('returns AI replies on the happy path', async () => {
    const raw = groqResponse({
      positive: 'Haan aa raha hu',
      neutral: 'Abhi confirm nahi',
      decline: 'Nahi kal nahi aa payega',
    });
    const result = await generate(msg('kal office aa rahe ho?'), {
      transport: transportReturning(raw),
      apiKey: 'k',
    });
    expect(result.replySet.fromAi).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.replySet.replies[0].text).toBe('Haan aa raha hu');
    expect(result.replySet.tone).toBe('casual_hinglish');
  });

  it('falls back without a key and does not call transport', async () => {
    let called = false;
    const transport: Transport = async () => {
      called = true;
      return '';
    };
    const result = await generate(msg('kal office aa rahe ho?'), {
      transport,
      apiKey: '',
    });
    expect(called).toBe(false);
    expect(result.replySet.fromAi).toBe(false);
    expect(result.error).toBe('no api key');
  });

  it('falls back on transport failure', async () => {
    const result = await generate(msg('kal office aa rahe ho?'), {
      transport: transportRaising(new Error('timed out')),
      apiKey: 'k',
    });
    expect(result.replySet.fromAi).toBe(false);
    expect(result.error).toContain('transport');
    expect(result.replySet.replies).toHaveLength(3);
  });

  it('falls back on malformed JSON', async () => {
    const result = await generate(msg('hi'), {
      transport: transportReturning('not json'),
      apiKey: 'k',
    });
    expect(result.replySet.fromAi).toBe(false);
  });

  it('falls back when an intent is missing', async () => {
    const raw = groqResponse({ positive: 'ok', neutral: 'hmm' });
    const result = await generate(msg('hi'), {
      transport: transportReturning(raw),
      apiKey: 'k',
    });
    expect(result.replySet.fromAi).toBe(false);
  });

  it('rejects three identical replies', async () => {
    const raw = groqResponse({ positive: 'Ok', neutral: 'ok!', decline: 'OK' });
    const result = await generate(msg('hi'), {
      transport: transportReturning(raw),
      apiKey: 'k',
    });
    expect(result.replySet.fromAi).toBe(false);
    expect(result.error).toBe('unusable model output');
  });

  it('truncates overlong output instead of rejecting it', async () => {
    const raw = groqResponse({
      positive: 'yes absolutely that works perfectly for me and everyone',
      neutral: 'let me check my calendar and come back to you later today',
      decline: 'unfortunately I cannot make that work at all this week',
    });
    const result = await generate(msg('hi'), {
      transport: transportReturning(raw),
      apiKey: 'k',
    });
    expect(result.replySet.fromAi).toBe(true);
    for (const reply of result.replySet.replies) {
      expect(reply.text.length).toBeLessThanOrEqual(WATCH_REPLY_MAX_CHARS);
    }
  });

  it('never lets emoji reach the watch', async () => {
    const raw = groqResponse({
      positive: 'Sure \u{1F44D}',
      neutral: 'Maybe \u{1F914}',
      decline: 'Nope \u{1F645}',
    });
    const result = await generate(msg('hi'), {
      transport: transportReturning(raw),
      apiKey: 'k',
    });
    for (const reply of result.replySet.replies) {
      expect(/^[\x00-\x7F]*$/.test(reply.text)).toBe(true);
    }
  });

  it('always returns three replies', async () => {
    const cases = [
      transportReturning('garbage'),
      transportRaising(new Error('down')),
      transportReturning(groqResponse({})),
      transportReturning(
        groqResponse({ positive: 1, neutral: 2, decline: 3 }),
      ),
    ];
    for (const transport of cases) {
      const result = await generate(msg('hi'), { transport, apiKey: 'k' });
      expect(result.replySet.replies).toHaveLength(3);
      expect(result.replySet.replies.map((r) => r.intent)).toEqual([...INTENTS]);
    }
  });

  it('honours a forced tone', async () => {
    const result = await generate(msg('yaar kal milte hai'), {
      apiKey: '',
      tone: 'professional',
    });
    expect(result.replySet.tone).toBe('professional');
    expect(result.replySet.fromAi).toBe(false);
  });

  it('carries the length cap in the system prompt', () => {
    expect(buildSystemPrompt('professional')).toContain(String(WATCH_REPLY_MAX_CHARS));
    expect(buildSystemPrompt('professional')).toContain('{"positive"');
  });

  it('parses a direct Groq envelope', () => {
    const raw = groqResponse({
      positive: 'Yes',
      neutral: 'Maybe',
      decline: 'No',
    });
    const parsed = parseModelOutput(raw, 'casual_english' satisfies Tone);
    expect(parsed?.replies.map((r) => r.text)).toEqual(['Yes', 'Maybe', 'No']);
  });
});
