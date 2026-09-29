import { describe, expect, it } from 'vitest';

import { newSourceItem } from './core/ckf';
import {
  DistillParseError,
  MAX_POINTS,
  buildDistillPrompt,
  extractJsonObject,
  parseDistillResult,
  stripCodeFence,
} from './distill';

const SOURCE = newSourceItem({
  url: 'https://example.com/spaced-repetition',
  title: 'Spaced repetition',
  body: 'Reviewing material near the point of forgetting is the most efficient schedule.',
  tags: [],
  capturedAt: new Date('2026-07-09T00:00:00.000Z'),
});

const CONTEXT = {
  sourceId: SOURCE.id,
  sourcePath: 'inbox/2026/07/spaced-repetition-abcd1234.md',
  provider: 'deepseek',
  model: 'deepseek-chat',
  at: '2026-07-09T01:00:00.000Z',
};

const VALID_JSON = JSON.stringify({
  title: 'Spaced repetition scheduling',
  summary: 'Review near the forgetting point instead of on a fixed calendar.',
  points: ['Schedule by retrievability', 'Rate each review honestly', 'Shorten intervals after a miss'],
  scenarios: ['Daily review queue'],
  counter_examples: ['Cramming the night before an exam'],
  tags: ['learning', 'memory'],
});

describe('buildDistillPrompt (F7 UNIT)', () => {
  it('TC-F7-U01 demands strict JSON and carries only the selected source', () => {
    const messages = buildDistillPrompt(SOURCE);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('JSON');
    expect(messages[0]?.content).toContain('"points"');
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toContain(SOURCE.body);
    expect(messages[1]?.content).toContain(SOURCE.url);
  });

  it('TC-F7-U01 never puts a credential in the prompt', () => {
    const serialized = JSON.stringify(buildDistillPrompt(SOURCE));
    expect(serialized).not.toMatch(/gh[pousr]_|sk-|github_pat_|Bearer/u);
  });

  it('TC-F7-U01 truncates a long body and notes the truncation', () => {
    const long = newSourceItem({
      url: 'https://example.com/long',
      title: 'Long',
      body: 'x'.repeat(50_000),
      truncated: true,
      original_bytes: 500_000,
    });
    const messages = buildDistillPrompt(long, { maxBodyChars: 100 });
    const user = messages[1]?.content ?? '';
    expect(user).toContain('truncated when captured');
    expect(user.length).toBeLessThan(500);
  });

  it('TC-F7-U01 omits empty optional metadata lines', () => {
    const bare = newSourceItem({ url: 'https://example.com/b', title: '', body: 'body' });
    const user = buildDistillPrompt(bare)[1]?.content ?? '';
    expect(user).not.toContain('title:');
    expect(user).not.toContain('byline:');
    expect(user).not.toContain('lang:');
  });
});

describe('parseDistillResult (F7 UNIT)', () => {
  it('TC-F7-U02 parses a fenced json block into a pending card', () => {
    const parsed = parseDistillResult(`\`\`\`json\n${VALID_JSON}\n\`\`\``, CONTEXT);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.card).toMatchObject({
      kind: 'card',
      source_id: SOURCE.id,
      status: 'pending',
      title: 'Spaced repetition scheduling',
      tags: ['learning', 'memory'],
      evidence_paths: [CONTEXT.sourcePath],
      distilled_by: { provider: 'deepseek', model: 'deepseek-chat', at: CONTEXT.at },
    });
    expect(parsed.card.points).toHaveLength(3);
    expect(parsed.card.scenarios).toEqual(['Daily review queue']);
    expect(parsed.card.counter_examples).toEqual(['Cramming the night before an exam']);
    expect(parsed.card.id).toBe(`${SOURCE.id}-c`);
  });

  it('TC-F7-U02 recovers a JSON object embedded in prose', () => {
    const parsed = parseDistillResult(`Sure! Here is the card:\n${VALID_JSON}\nHope that helps.`, CONTEXT);
    expect(parsed.card.title).toBe('Spaced repetition scheduling');
  });

  it('TC-F7-U02 unwraps a single-key wrapper object', () => {
    const wrapped = JSON.stringify({ card: JSON.parse(VALID_JSON) as unknown });
    expect(parseDistillResult(wrapped, CONTEXT).card.points).toHaveLength(3);
  });

  it('TC-F7-U02 keeps braces inside strings from confusing the scanner', () => {
    const tricky = JSON.stringify({
      title: 'Braces { and }',
      summary: 'A summary with {curly} braces',
      points: ['a {b} c', 'd', 'e'],
    });
    expect(parseDistillResult(tricky, CONTEXT).card.title).toBe('Braces { and }');
  });

  it('TC-F7-U03 rejects a reply with no JSON at all', () => {
    expect(() => parseDistillResult('I cannot help with that.', CONTEXT)).toThrow(DistillParseError);
    expect(() => parseDistillResult('', CONTEXT)).toThrow(DistillParseError);
    expect(() => parseDistillResult('{ "title": "unterminated"', CONTEXT)).toThrow(DistillParseError);
  });

  it('TC-F7-U03 rejects malformed JSON', () => {
    expect(() => parseDistillResult('{ "title": "x", }', CONTEXT)).toThrow(DistillParseError);
    try {
      parseDistillResult('{ "title": "x", }', CONTEXT);
    } catch (error) {
      expect((error as DistillParseError).code).toBe('badJson');
    }
  });

  it('TC-F7-U04 rejects a schema violation instead of guessing', () => {
    expect(() => parseDistillResult(JSON.stringify({ summary: 's', points: ['a'] }), CONTEXT)).toThrow(
      /title/u,
    );
    expect(() =>
      parseDistillResult(JSON.stringify({ title: 't', summary: 's', points: 'not an array' }), CONTEXT),
    ).toThrow(DistillParseError);
    expect(() =>
      parseDistillResult(JSON.stringify({ title: 't', summary: 's', points: [1, 2, 3] }), CONTEXT),
    ).toThrow(DistillParseError);
    expect(() =>
      parseDistillResult(JSON.stringify({ title: 't', summary: 's', points: [] }), CONTEXT),
    ).toThrow(DistillParseError);
    expect(() => parseDistillResult('[]', CONTEXT)).toThrow(DistillParseError);
    expect(() => parseDistillResult('"a string"', CONTEXT)).toThrow(DistillParseError);
  });

  it('TC-F7-U06 caps an over-long points list and warns', () => {
    const many = JSON.stringify({
      title: 'Many',
      summary: 's',
      points: Array.from({ length: 15 }, (_, index) => `point ${index}`),
    });
    const parsed = parseDistillResult(many, CONTEXT);
    expect(parsed.card.points).toHaveLength(MAX_POINTS);
    expect(parsed.warnings.join(' ')).toContain(`capped at ${MAX_POINTS}`);
  });

  it('TC-F7-U06 accepts a short list but warns', () => {
    const few = JSON.stringify({ title: 'Few', summary: 's', points: ['only one'] });
    const parsed = parseDistillResult(few, CONTEXT);
    expect(parsed.card.points).toEqual(['only one']);
    expect(parsed.warnings.join(' ')).toContain('recommended');
  });

  it('TC-F7-U06 clips over-long values and drops blank list entries', () => {
    const noisy = JSON.stringify({
      title: 'T'.repeat(400),
      summary: 'S'.repeat(900),
      points: ['   ', 'x'.repeat(900), 'second'],
      tags: ['  ', 'tag'],
    });
    const parsed = parseDistillResult(noisy, CONTEXT);
    expect(Array.from(parsed.card.title).length).toBeLessThanOrEqual(161);
    expect(Array.from(parsed.card.summary).length).toBeLessThanOrEqual(401);
    expect(parsed.card.points).toHaveLength(2);
    expect(Array.from(parsed.card.points[0] ?? '').length).toBeLessThanOrEqual(301);
    expect(parsed.card.tags).toEqual(['tag']);
  });

  it('TC-F7-U06 omits optional sections when the model returns them empty', () => {
    const minimal = JSON.stringify({ title: 'T', summary: 'S', points: ['a', 'b', 'c'] });
    const parsed = parseDistillResult(minimal, CONTEXT);
    expect(parsed.card.scenarios).toBeUndefined();
    expect(parsed.card.counter_examples).toBeUndefined();
    expect(parsed.card.tags).toEqual([]);
  });
});

describe('distill helpers (F7 UNIT)', () => {
  it('TC-F7-U02 strips fences and finds balanced objects', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('  {"a":1}  ')).toBe('{"a":1}');
    expect(extractJsonObject('prefix {"a":{"b":1}} suffix')).toBe('{"a":{"b":1}}');
    expect(extractJsonObject('no object here')).toBeNull();
    expect(extractJsonObject('{"unterminated": true')).toBeNull();
    expect(extractJsonObject('{ "quote": "}" }')).toBe('{ "quote": "}" }');
  });
});
