import { describe, expect, it } from 'vitest';

import {
  cardPath,
  indexPath,
  joinPath,
  newId,
  normalizePrefix,
  resetIdSequence,
  reviewStatePath,
  slugify,
  sourceItemPath,
  storeConfigPath,
  topicPath,
} from './paths';

describe('slugify (F2 UNIT)', () => {
  it('TC-F2-U05 folds punctuation and whitespace for latin titles', () => {
    expect(slugify('  Hello, World!!  ')).toBe('hello-world');
    expect(slugify('A/B\\C:D')).toBe('a-b-c-d');
  });

  it('TC-F2-U05 keeps CJK characters', () => {
    expect(slugify('中文：测试/标题')).toBe('中文-测试-标题');
    expect(slugify('间隔重复 Spaced Repetition')).toBe('间隔重复-spaced-repetition');
  });

  it('TC-F2-U05 removes emoji and characters that are unsafe in file names', () => {
    expect(slugify('hi 😀 there')).toBe('hi-there');
    expect(slugify('a<b>c|d?e*f"g')).toBe('a-b-c-d-e-f-g');
    expect(slugify('...')).toBe('item');
    expect(slugify('')).toBe('item');
    expect(slugify('   ')).toBe('item');
  });

  it('TC-F2-U05 caps the length and never ends with a dash', () => {
    const slug = slugify('a'.repeat(200));
    expect(slug).toHaveLength(60);
    const dashed = slugify(`${'b'.repeat(59)}-tail`);
    expect(dashed.endsWith('-')).toBe(false);
    expect(Array.from(dashed).length).toBeLessThanOrEqual(60);
  });
});

describe('newId (F2 UNIT)', () => {
  it('TC-F2-U06 produces 10 000 unique, time-ordered ids', () => {
    resetIdSequence(0);
    let clock = 33_554_432 * 1000;
    const seen = new Set<string>();
    let previous = '';
    let ordered = true;
    for (let i = 0; i < 10_000; i += 1) {
      clock += 1;
      const id = newId(() => clock);
      expect(id).toHaveLength(8);
      expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/u);
      seen.add(id);
      if (previous !== '' && id <= previous) ordered = false;
      previous = id;
    }
    expect(seen.size).toBe(10_000);
    expect(ordered).toBe(true);
  });

  it('TC-F2-U06 stays collision-free when the clock is frozen', () => {
    resetIdSequence(0);
    const ids = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) ids.add(newId(() => 1_700_000_000_000));
    expect(ids.size).toBe(5_000);
  });
});

describe('repository paths (F2 UNIT)', () => {
  it('TC-F2-U07 builds a date-partitioned inbox path', () => {
    const item = { id: 'abcd1234', title: 'Hello World!', captured_at: '2026-07-09T23:59:00.000Z' };
    expect(sourceItemPath(item)).toBe('inbox/2026/07/hello-world-abcd1234.md');
  });

  it('TC-F2-U07 uses UTC so a capture never lands in the wrong month', () => {
    const item = { id: 'abcd1234', title: 'T', captured_at: '2026-07-31T20:00:00.000Z' };
    expect(sourceItemPath(item)).toBe('inbox/2026/07/t-abcd1234.md');
  });

  it('TC-F2-U07 applies and normalises a path prefix', () => {
    const item = { id: 'abcd1234', title: 'T', captured_at: '2026-07-09T00:00:00.000Z' };
    expect(sourceItemPath(item, '/notes/')).toBe('notes/inbox/2026/07/t-abcd1234.md');
    expect(sourceItemPath(item, 'notes')).toBe('notes/inbox/2026/07/t-abcd1234.md');
    expect(sourceItemPath(item, '  ')).toBe('inbox/2026/07/t-abcd1234.md');
    expect(normalizePrefix('/a//b/')).toBe('a/b');
    expect(normalizePrefix('../escape')).toBe('escape');
  });

  it('TC-F2-U07 separates pending cards from confirmed cards', () => {
    expect(cardPath({ id: 'c1', title: 'Card', status: 'pending' })).toBe('cards/pending/card-c1.md');
    expect(cardPath({ id: 'c1', title: 'Card', status: 'confirmed' })).toBe('cards/card-c1.md');
    expect(cardPath({ id: 'c1', title: '卡片', status: 'pending' }, 'kb')).toBe(
      'kb/cards/pending/卡片-c1.md',
    );
  });

  it('TC-F2-U07 builds the remaining well-known paths', () => {
    expect(topicPath({ name: 'AI 基础' })).toBe('topics/ai-基础.md');
    expect(indexPath()).toBe('index.json');
    expect(indexPath('kb')).toBe('kb/index.json');
    expect(reviewStatePath('kb')).toBe('kb/review/state.json');
    expect(storeConfigPath('kb')).toBe('kb/.omnipilot/config.json');
  });

  it('TC-F2-U07 refuses an unparseable timestamp', () => {
    expect(() => sourceItemPath({ id: 'a', title: 't', captured_at: 'nope' })).toThrow(/invalid timestamp/u);
  });

  it('TC-F2-U07 joins path segments without duplicated slashes', () => {
    expect(joinPath('a', '', 'b', undefined, 'c')).toBe('a/b/c');
    expect(joinPath('/a/', '/b/')).toBe('a/b');
  });
});
