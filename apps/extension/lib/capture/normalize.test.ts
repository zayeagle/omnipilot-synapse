import { describe, expect, it } from 'vitest';

import { parseSourceItem } from '../core/ckf';
import {
  MAX_BODY_BYTES,
  byteLength,
  buildSourceItem,
  normalizeWhitespace,
  truncateBody,
} from './normalize';

const URL = 'https://example.com/posts/spaced-repetition';

/** A UTF-16 lone surrogate is what a mid-character cut would leave behind. */
function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ''));
}

describe('normalizeWhitespace (F1 UNIT)', () => {
  it('TC-F1-U07 collapses runs of spaces, tabs and unicode spaces', () => {
    expect(normalizeWhitespace('  a \t b\u00a0\u3000c  ')).toBe('a b c');
  });

  it('TC-F1-U07 keeps paragraph breaks as a single blank line and normalises CRLF', () => {
    expect(normalizeWhitespace('one\r\n\r\ntwo\r\nthree')).toBe('one\n\ntwo\nthree');
    expect(normalizeWhitespace('a\n\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeWhitespace('a  \n  b')).toBe('a\nb');
  });

  it('TC-F1-U07 is idempotent and never throws on empty input', () => {
    for (const input of ['', '   ', '\n\n\n', 'x', 'a\n\nb']) {
      const once = normalizeWhitespace(input);
      expect(normalizeWhitespace(once)).toBe(once);
    }
  });

  it('TC-F1-U07 measures UTF-8 bytes, not UTF-16 code units', () => {
    expect(byteLength('')).toBe(0);
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('中文')).toBe(6);
    expect(byteLength('😀')).toBe(4);
    expect(byteLength('a😀中')).toBe(8);
  });
});

describe('truncateBody (F1 UNIT)', () => {
  it('TC-F1-U07 truncates a 700 KB body to the 512 KB cap and reports the original size', () => {
    const body = 'a'.repeat(700 * 1024);
    const result = truncateBody(body);

    expect(MAX_BODY_BYTES).toBe(512 * 1024);
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(700 * 1024);
    expect(byteLength(result.text)).toBe(MAX_BODY_BYTES);
    expect(result.text).toHaveLength(MAX_BODY_BYTES);
  });

  it('TC-F1-U07 leaves a body at exactly the cap — and anything smaller — untouched', () => {
    const exact = 'a'.repeat(MAX_BODY_BYTES);
    expect(truncateBody(exact)).toEqual({
      text: exact,
      truncated: false,
      originalBytes: MAX_BODY_BYTES,
    });
    expect(truncateBody('small body')).toEqual({
      text: 'small body',
      truncated: false,
      originalBytes: 10,
    });
    expect(truncateBody(exact, MAX_BODY_BYTES + 1).truncated).toBe(false);
  });

  it('TC-F1-U07 never cuts a multi-byte character', () => {
    const cjk = '间隔重复'.repeat(4); // 16 characters × 3 bytes
    const result = truncateBody(cjk, 7);

    expect(result.text).toBe('间隔');
    expect(byteLength(result.text)).toBe(6);
    expect(result.originalBytes).toBe(48);
    expect(cjk.startsWith(result.text)).toBe(true);
    // The cut is maximal: the next character would push it past the cap.
    const next = Array.from(cjk)[Array.from(result.text).length] ?? '';
    expect(byteLength(result.text + next)).toBeGreaterThan(7);
    expect(hasLoneSurrogate(result.text)).toBe(false);
  });

  it('TC-F1-U07 never splits a surrogate pair', () => {
    const emoji = `aaaa😀${'b'.repeat(10)}`; // 4 + 4 + 10 bytes
    expect(truncateBody(emoji, 6).text).toBe('aaaa');
    expect(truncateBody(emoji, 7).text).toBe('aaaa');
    expect(truncateBody(emoji, 8).text).toBe('aaaa😀');
    expect(truncateBody(emoji, 9).text).toBe('aaaa😀b');
    expect(byteLength(truncateBody(emoji, 8).text)).toBe(8);

    for (const maxBytes of [5, 6, 7, 8, 9, 10]) {
      const cut = truncateBody(emoji, maxBytes).text;
      expect(hasLoneSurrogate(cut)).toBe(false);
      expect(emoji.startsWith(cut)).toBe(true);
      expect(byteLength(cut)).toBeLessThanOrEqual(maxBytes);
    }
    expect(truncateBody(emoji).originalBytes).toBe(18);
  });

  it('TC-F1-U07 trims a dangling space left by the cut and handles a non-positive cap', () => {
    expect(truncateBody('aaaa  bbbbbb', 6).text).toBe('aaaa');
    expect(truncateBody('truncated', 0)).toEqual({
      text: '',
      truncated: true,
      originalBytes: 9,
    });
    expect(truncateBody('', 0)).toEqual({ text: '', truncated: false, originalBytes: 0 });
  });
});

describe('buildSourceItem (F1 UNIT)', () => {
  const FIXED_AT = new Date('2024-05-01T10:00:00.000Z');

  it('TC-F1-U06 gives two captures of the same page the same content_hash', () => {
    const first = buildSourceItem({
      url: URL,
      title: 'Spaced repetition',
      text: 'Spaced   repetition\n\nschedules  reviews.',
      capturedAt: FIXED_AT,
    });
    const second = buildSourceItem({
      url: URL,
      title: 'Spaced repetition',
      text: 'Spaced repetition\n\nschedules reviews.',
      capturedAt: FIXED_AT,
    });

    expect(first.body).toBe('Spaced repetition\n\nschedules reviews.');
    expect(second.body).toBe(first.body);
    expect(second.content_hash).toBe(first.content_hash);

    const other = buildSourceItem({
      url: 'https://example.com/other',
      title: 'Something else',
      text: 'Unrelated content entirely.',
      capturedAt: FIXED_AT,
    });
    expect(other.content_hash).not.toBe(first.content_hash);
  });

  it('TC-F1-U06 builds a storeable SourceItem with the documented defaults', () => {
    const item = buildSourceItem({
      url: URL,
      title: 'Spaced repetition',
      text: 'Body text.',
      byline: 'Ada',
      lang: 'en',
      capturedAt: FIXED_AT,
      id: 'abc12345',
    });

    expect(item).toMatchObject({
      id: 'abc12345',
      kind: 'source',
      channel: 'extension',
      url: URL,
      title: 'Spaced repetition',
      body: 'Body text.',
      tags: [],
      byline: 'Ada',
      lang: 'en',
      extraction: 'full',
    });
    expect(item.truncated).toBeUndefined();
    expect(item.original_bytes).toBeUndefined();
    expect(item.captured_at).toBe('2024-05-01T10:00:00.000Z');
    expect(item.content_hash).toMatch(/^[0-9a-f]{16}$/u);
    expect(parseSourceItem(item)).toEqual(item);
  });

  it('TC-F1-U06 marks an empty body as title-only instead of storing an empty full record', () => {
    const item = buildSourceItem({ url: URL, title: 'Only a title', text: '   \n\u00a0 ' });

    expect(item.body).toBe('');
    expect(item.extraction).toBe('title-only');
    expect(parseSourceItem(item).extraction).toBe('title-only');
  });

  it('TC-F1-U07 caps the body and records truncated / original_bytes on the item', () => {
    const item = buildSourceItem({
      url: URL,
      title: 'A very long page',
      text: 'a'.repeat(700 * 1024),
      capturedAt: FIXED_AT,
    });

    expect(item.truncated).toBe(true);
    expect(item.original_bytes).toBe(700 * 1024);
    expect(byteLength(item.body)).toBe(MAX_BODY_BYTES);
    expect(item.extraction).toBe('full');
    // The stored form must survive the CKF validator, which requires original_bytes when truncated.
    expect(parseSourceItem(item)).toEqual(item);
  });

  it('TC-F1-U07 honours a caller-supplied cap without touching the item shape', () => {
    const item = buildSourceItem(
      { url: URL, title: 'Short page', text: 'abcdefghij' },
      { maxBodyBytes: 4 },
    );
    expect(item.body).toBe('abcd');
    expect(item.truncated).toBe(true);
    expect(item.original_bytes).toBe(10);
  });

  it('TC-F1-U04 records a selection as an excerpt of the page it came from', () => {
    const item = buildSourceItem({
      url: URL,
      title: 'Spaced repetition',
      text: 'The selected   words.',
      excerptOf: URL,
      extraction: 'full',
      capturedAt: FIXED_AT,
    });

    expect(item.body).toBe('The selected words.');
    expect(item.excerpt_of).toBe(URL);
    expect(item.tags).toEqual([]);
    expect(parseSourceItem(item).excerpt_of).toBe(URL);
  });

  it('TC-F1-U06 attaches caller tags and lets the extraction quality be overridden', () => {
    const item = buildSourceItem(
      { url: URL, title: 'Tagged', text: 'Body.', extraction: 'title-only', channel: 'manual' },
      { tags: ['clip', 'reading'] },
    );
    expect(item.tags).toEqual(['clip', 'reading']);
    expect(item.extraction).toBe('title-only');
    expect(item.channel).toBe('manual');
  });
});
