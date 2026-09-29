import { describe, expect, it } from 'vitest';

import {
  CkfError,
  isIsoTimestamp,
  newKnowledgeCard,
  newSourceItem,
  parseCkfRecord,
  parseKnowledgeCard,
  parseReviewState,
  parseSourceItem,
  parseTopic,
} from './ckf';

const baseSource = {
  id: 'abcd1234',
  kind: 'source',
  channel: 'extension',
  url: 'https://example.com/a',
  title: 'Example',
  body: 'hello',
  content_hash: 'deadbeefdeadbeef',
  captured_at: '2026-07-09T00:00:00.000Z',
  tags: [],
};

describe('ckf source item (F2 UNIT)', () => {
  it('TC-F2-U03 rejects a record that is missing a required field', () => {
    const { url: _url, ...withoutUrl } = baseSource;
    expect(() => parseSourceItem(withoutUrl)).toThrow(CkfError);
    try {
      parseSourceItem(withoutUrl);
    } catch (error) {
      expect((error as CkfError).field).toBe('url');
      expect((error as CkfError).message).toContain('url');
    }
  });

  it('TC-F2-U03 rejects wrong types and unknown channel values', () => {
    expect(() => parseSourceItem({ ...baseSource, tags: 'nope' })).toThrow(CkfError);
    expect(() => parseSourceItem({ ...baseSource, channel: 'telepathy' })).toThrow(CkfError);
    expect(() => parseSourceItem({ ...baseSource, captured_at: 'yesterday' })).toThrow(CkfError);
    expect(() => parseSourceItem('not an object')).toThrow(CkfError);
    expect(() => parseSourceItem({ ...baseSource, truncated: true })).toThrow(CkfError);
  });

  it('TC-F2-U03 drops unknown keys instead of carrying them through', () => {
    const parsed = parseSourceItem({ ...baseSource, somethingElse: 'x', __proto__hack: 1 });
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'body',
        'captured_at',
        'channel',
        'content_hash',
        'id',
        'kind',
        'tags',
        'title',
        'url',
      ].sort(),
    );
  });

  it('TC-F2-U03 keeps optional fields only when they are present', () => {
    const parsed = parseSourceItem({
      ...baseSource,
      byline: 'Ada',
      lang: 'zh-CN',
      excerpt_of: 'https://example.com/a',
      truncated: true,
      original_bytes: 4096,
      extraction: 'title-only',
    });
    expect(parsed.byline).toBe('Ada');
    expect(parsed.lang).toBe('zh-CN');
    expect(parsed.truncated).toBe(true);
    expect(parsed.original_bytes).toBe(4096);
    expect(parsed.extraction).toBe('title-only');
    expect(parseSourceItem(baseSource).byline).toBeUndefined();
  });
});

describe('ckf knowledge card (F2 UNIT)', () => {
  const baseCard = {
    id: 'card0001',
    kind: 'card',
    source_id: 'abcd1234',
    title: 'Card',
    summary: 'summary',
    points: ['one', 'two'],
    tags: ['a'],
    evidence_paths: ['inbox/2026/07/example-abcd1234.md'],
    status: 'pending',
  };

  it('TC-F2-U04 rejects a points field that is not a string array', () => {
    expect(() => parseKnowledgeCard({ ...baseCard, points: 'one, two' })).toThrow(CkfError);
    expect(() => parseKnowledgeCard({ ...baseCard, points: [1, 2] })).toThrow(CkfError);
    try {
      parseKnowledgeCard({ ...baseCard, points: 'one, two' });
    } catch (error) {
      expect((error as CkfError).field).toBe('points');
    }
  });

  it('TC-F2-U04 rejects an empty points array and a bad status', () => {
    expect(() => parseKnowledgeCard({ ...baseCard, points: [] })).toThrow(CkfError);
    expect(() => parseKnowledgeCard({ ...baseCard, status: 'maybe' })).toThrow(CkfError);
  });

  it('TC-F2-U04 defaults status to pending when it is absent and not required', () => {
    const { status: _status, ...withoutStatus } = baseCard;
    expect(parseKnowledgeCard(withoutStatus).status).toBe('pending');
    expect(() => parseKnowledgeCard(withoutStatus, { requireStatus: true })).toThrow(CkfError);
  });

  it('TC-F2-U04 validates nested distill provenance', () => {
    const card = parseKnowledgeCard({
      ...baseCard,
      distilled_by: { provider: 'deepseek', model: 'deepseek-chat', at: '2026-07-09T00:00:00.000Z' },
    });
    expect(card.distilled_by?.provider).toBe('deepseek');
    expect(() =>
      parseKnowledgeCard({ ...baseCard, distilled_by: { provider: 'x', model: 'y', at: 'soon' } }),
    ).toThrow(CkfError);
  });
});

describe('ckf other records and factories (F2 UNIT)', () => {
  it('TC-F2-U03 parses topic and review state', () => {
    expect(parseTopic({ id: 't1', kind: 'topic', name: 'AI', path: 'ai' }).name).toBe('AI');
    const review = parseReviewState({
      id: 'r1',
      kind: 'review',
      stability: 1,
      retrievability: 0.5,
      next_review_at: '2026-07-10T00:00:00.000Z',
      use_count: 0,
    });
    expect(review.retrievability).toBe(0.5);
    expect(() =>
      parseReviewState({
        id: 'r1',
        kind: 'review',
        stability: 'high',
        retrievability: 0.5,
        next_review_at: '2026-07-10T00:00:00.000Z',
        use_count: 0,
      }),
    ).toThrow(CkfError);
  });

  it('TC-F2-U03 dispatches on kind and rejects unknown kinds', () => {
    expect(parseCkfRecord(baseSource).kind).toBe('source');
    expect(() => parseCkfRecord({ kind: 'poem' })).toThrow(CkfError);
  });

  it('TC-F2-U03 builds a source item with derived fields', () => {
    const item = newSourceItem({
      url: 'https://example.com',
      title: 'T',
      body: '  Hello   World ',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    expect(item.kind).toBe('source');
    expect(item.channel).toBe('extension');
    expect(item.captured_at).toBe('2026-07-09T00:00:00.000Z');
    expect(item.tags).toEqual([]);
    expect(item.content_hash).toMatch(/^[0-9a-f]{16}$/u);
    // Content hash ignores whitespace and case differences.
    expect(newSourceItem({ url: 'u', title: 't', body: 'hello world' }).content_hash).toBe(
      item.content_hash,
    );
  });

  it('TC-F2-U03 records truncation metadata', () => {
    const item = newSourceItem({
      url: 'u',
      title: 't',
      body: 'abc',
      truncated: true,
      original_bytes: 700_000,
    });
    expect(item.truncated).toBe(true);
    expect(item.original_bytes).toBe(700_000);
    expect(parseSourceItem({ ...item }).original_bytes).toBe(700_000);
  });

  it('TC-F2-U03 builds a pending card by default with copied arrays', () => {
    const points = ['a'];
    const card = newKnowledgeCard({
      source_id: 's1',
      title: 'T',
      summary: 'S',
      points,
      evidence_paths: ['p'],
    });
    expect(card.status).toBe('pending');
    expect(card.tags).toEqual([]);
    points.push('mutated');
    expect(card.points).toEqual(['a']);
  });

  it('TC-F2-U03 recognises only real ISO timestamps', () => {
    expect(isIsoTimestamp('2026-07-09T00:00:00.000Z')).toBe(true);
    expect(isIsoTimestamp('2026-07-09T08:00:00+08:00')).toBe(true);
    expect(isIsoTimestamp('2026-07-09')).toBe(false);
    expect(isIsoTimestamp('2026-13-45T99:00:00.000Z')).toBe(false);
  });
});
