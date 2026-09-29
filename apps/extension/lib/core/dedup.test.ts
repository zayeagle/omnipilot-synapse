import { describe, expect, it } from 'vitest';

import { contentKey, isNearDuplicate, normalizeText, similarity, tokenize, urlKey } from './dedup';

describe('urlKey (F1 UNIT)', () => {
  it('TC-F1-U05 strips tracking params, the fragment and a trailing slash', () => {
    expect(urlKey('https://WWW.Example.com/a/b/?utm_source=x&b=2&a=1#top')).toBe(
      'https://example.com/a/b?a=1&b=2',
    );
  });

  it('TC-F1-U05 lowercases the host and sorts the remaining params', () => {
    expect(urlKey('HTTPS://Example.COM/Path?z=1&a=2')).toBe('https://example.com/Path?a=2&z=1');
  });

  it('TC-F1-U05 keeps the root slash and non-default ports', () => {
    expect(urlKey('https://example.com/')).toBe('https://example.com/');
    expect(urlKey('http://example.com:8443/x')).toBe('http://example.com:8443/x');
  });

  it('TC-F1-U05 treats the same page with different tracking as one key', () => {
    const a = urlKey('https://example.com/post?utm_medium=social&id=7');
    const b = urlKey('https://www.example.com/post/?id=7&fbclid=abc');
    expect(a).toBe(b);
  });

  it('TC-F1-U05 falls back to a trimmed, lowercased string for a relative URL', () => {
    expect(urlKey('  /not-absolute  ')).toBe('/not-absolute');
  });
});

describe('content hashing (F1 UNIT)', () => {
  it('TC-F1-U06 ignores cosmetic whitespace and case differences', () => {
    expect(contentKey('Hello   World')).toBe(contentKey('hello world'));
    expect(contentKey('a\n\nb')).toBe(contentKey('a b'));
    expect(contentKey('a')).not.toBe(contentKey('b'));
  });

  it('TC-F1-U06 produces a stable 16-char hex fingerprint', () => {
    expect(contentKey('anything')).toMatch(/^[0-9a-f]{16}$/u);
    expect(contentKey('anything')).toBe(contentKey('anything'));
  });

  it('TC-F1-U06 normalises full-width text and ideographic spaces', () => {
    expect(normalizeText('ＡＢ\u3000Ｃ')).toBe('ab c');
  });
});

describe('near-duplicate detection (F1 UNIT)', () => {
  const words = Array.from({ length: 300 }, (_, index) => `token${index}`);
  const base = words.join(' ');

  it('TC-F1-U06 flags a 2 KB body with one changed word', () => {
    const changed = [...words.slice(0, 150), 'replaced', ...words.slice(151)].join(' ');
    expect(similarity(base, changed)).toBeGreaterThanOrEqual(0.9);
    expect(isNearDuplicate(base, changed)).toBe(true);
  });

  it('TC-F1-U06 does not flag unrelated content', () => {
    const other = Array.from({ length: 300 }, (_, index) => `different${index}`).join(' ');
    expect(isNearDuplicate(base, other)).toBe(false);
    expect(similarity(base, other)).toBe(0);
  });

  it('TC-F1-U06 treats identical and empty content consistently', () => {
    expect(isNearDuplicate(base, base)).toBe(true);
    expect(similarity('', '')).toBe(1);
    expect(similarity('', base)).toBe(0);
  });

  it('TC-F1-U06 tokenises CJK per character and latin per word', () => {
    expect(tokenize('间隔重复 spaced repetition')).toEqual([
      '间',
      '隔',
      '重',
      '复',
      'spaced',
      'repetition',
    ]);
  });

  it('TC-F1-U06 handles a body shorter than the shingle size', () => {
    expect(isNearDuplicate('short text', 'short text')).toBe(true);
    expect(isNearDuplicate('a b c', 'a b c d e f')).toBe(false);
  });
});
