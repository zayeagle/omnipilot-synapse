import { describe, expect, it } from 'vitest';

import {
  addTermPostings,
  emptyShard,
  groupTermPostings,
  parseShard,
  queryShard,
  serializeShard,
  type PostingsShard,
  type SearchDocument,
} from './postings';
import {
  NEUTRAL_DECAY,
  RECENCY_HALF_LIFE_MS,
  SNIPPET_LENGTH,
  parseQuery,
  recencyDecay,
  scoreHit,
  search,
  snippetAround,
  type RawShard,
  type SearchOptions,
} from './query';

const NOW = Date.parse('2026-03-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** Minimal indexable document; every test overrides only the fields it is about. */
function doc(id: string, overrides: Partial<SearchDocument> = {}): SearchDocument {
  return {
    id,
    kind: 'source',
    path: `inbox/2026/01/${id}.md`,
    title: `Title ${id}`,
    fields: {},
    updated_at: iso(NOW),
    ...overrides,
  };
}

/** Build the shard set a corpus would have on disk (the same bucketing the index performs). */
function shardsOf(documents: readonly SearchDocument[]): RawShard[] {
  const byKey = new Map<string, PostingsShard>();
  for (const document of documents) {
    for (const [key, entries] of groupTermPostings(document)) {
      byKey.set(key, addTermPostings(byKey.get(key) ?? emptyShard(), entries));
    }
  }
  return [...byKey.entries()]
    .sort((a, b) => (a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1))
    .map(([key, shard]) => ({ key, text: serializeShard(shard) }));
}

function run(
  documents: readonly SearchDocument[],
  query: string,
  options: Partial<SearchOptions> = {},
): ReturnType<typeof search> {
  return search(shardsOf(documents), query, { docs: documents, now: () => NOW, ...options });
}

describe('query parsing (F4 UNIT)', () => {
  it('TC-F4-U08 splits terms, quoted phrases and filters', () => {
    const parsed = parseQuery('"spaced repetition" tag:ai topic:t-ml in:cards|topics gardening');

    expect(parsed.filters.tags).toEqual(['ai']);
    expect(parsed.filters.topics).toEqual(['t-ml']);
    expect(parsed.filters.kinds).toEqual(['card', 'topic']);
    expect(parsed.terms.map((term) => term.text)).toEqual(['spaced repetition', 'gardening']);
    expect(parsed.terms[0]?.phrase).toBe(true);
    expect(parsed.terms[1]?.phrase).toBe(false);
    expect(parsed.indexTerms).toEqual(
      expect.arrayContaining(['spaced', 'repetition', 'gardening']),
    );
  });

  it('TC-F4-U08 treats an unknown in: value as a filter that matches nothing', () => {
    // `[]` is "an in: filter was given and selects no kind"; `null` is "no in: filter at all".
    expect(parseQuery('in:bogus').filters.kinds).toEqual([]);
    expect(parseQuery('alpha').filters.kinds).toBeNull();
    expect(parseQuery('alpha').filters.tags).toEqual([]);
  });

  it('TC-F4-U09 drops segments that cannot produce an index term', () => {
    expect(parseQuery('!!!').terms).toEqual([]);
    expect(parseQuery('tag:').filters.tags).toEqual([]);
    expect(parseQuery('').indexTerms).toEqual([]);
    expect(parseQuery('alpha alpha').terms).toHaveLength(1);
  });
});

describe('query scoring (F4 UNIT)', () => {
  it('TC-F4-U06 multiplies coverage, field weight and recency decay', () => {
    expect(
      scoreHit({
        matchedIndexTerms: 1,
        totalIndexTerms: 1,
        fieldWeights: [5],
        updatedAt: iso(NOW),
        now: NOW,
      }),
    ).toBe(5);
    expect(
      scoreHit({
        matchedIndexTerms: 1,
        totalIndexTerms: 2,
        fieldWeights: [5],
        updatedAt: iso(NOW),
        now: NOW,
      }),
    ).toBe(2.5);
    // A filter-only query has no terms: full coverage, neutral weight, recency only.
    expect(
      scoreHit({
        matchedIndexTerms: 0,
        totalIndexTerms: 0,
        fieldWeights: [],
        updatedAt: iso(NOW),
        now: NOW,
      }),
    ).toBe(1);
  });

  it('TC-F4-U12 halves the recency factor every half-life and clamps clock skew', () => {
    expect(recencyDecay(iso(NOW), NOW)).toBe(1);
    expect(recencyDecay(iso(NOW - RECENCY_HALF_LIFE_MS), NOW)).toBeCloseTo(0.5, 10);
    expect(recencyDecay(iso(NOW - 10 * RECENCY_HALF_LIFE_MS), NOW)).toBeGreaterThan(0);
    expect(recencyDecay(iso(NOW + 5 * DAY), NOW)).toBe(1);
    expect(recencyDecay('not a timestamp', NOW)).toBe(NEUTRAL_DECAY);
  });

  it('TC-F4-U05 centres the snippet on the match and stays near 120 characters', () => {
    const body = `${'细'.repeat(200)} needle ${'尾'.repeat(200)}`;
    const documents = [doc('long', { fields: { body: [body] } })];

    const snippet = run(documents, 'needle')[0]?.snippet ?? '';
    expect(snippet).toContain('needle');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    // 120 characters plus the two ellipses, counted by code point (the body is all CJK).
    expect(Array.from(snippet).length).toBeLessThanOrEqual(SNIPPET_LENGTH + 2);

    expect(snippetAround('alpha beta', 'beta')).toBe('alpha beta');
    expect(snippetAround('alpha beta', 'missing')).toBe('alpha beta');
  });
});

describe('search (F4 UNIT)', () => {
  it('TC-F4-U05 matches a latin body term and returns the path plus a snippet', () => {
    const documents = [
      doc('s1', {
        fields: {
          title: ['Incremental reading'],
          body: [
            'Incremental reading turns long articles into a queue of small extracts you review later.',
          ],
        },
      }),
      doc('s2', { fields: { body: ['Gardening in the spring.'] } }),
    ];

    const results = run(documents, 'queue');

    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(1);
    expect(results.needsRebuild).toBe(false);
    expect(results[0]?.id).toBe('s1');
    expect(results[0]?.path).toBe('inbox/2026/01/s1.md');
    expect(results[0]?.title).toBe('Title s1');
    expect(results[0]?.snippet).toContain('queue');
    expect(results[0]?.fields).toEqual(['body']);
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it('TC-F4-U05 finds a term that appears in any of the record’s fields', () => {
    const documents = [
      doc('tagged', { fields: { tag: ['gardening'] } }),
      doc('summarised', { kind: 'card', fields: { summary: ['gardening notes'] } }),
      doc('pointed', { kind: 'card', fields: { point: ['gardening', 'other'] } }),
    ];

    const results = run(documents, 'gardening');
    // tag (4) outranks point and summary (3); the two equal weights fall back to id order.
    expect(results.map((hit) => hit.id)).toEqual(['tagged', 'pointed', 'summarised']);
    expect(results.map((hit) => hit.fields)).toEqual([['tag'], ['point'], ['summary']]);
  });

  it('TC-F4-U05 requires quoted phrases to be adjacent', () => {
    const documents = [
      doc('adjacent', { fields: { body: ['machine learning is a field'] } }),
      doc('scattered', { fields: { body: ['the machine can learning nothing'] } }),
    ];

    expect(run(documents, '"machine learning"').map((hit) => hit.id)).toEqual(['adjacent']);
    // Without quotes the same words are independent terms, so both records match.
    expect(run(documents, 'machine learning').map((hit) => hit.id)).toEqual([
      'adjacent',
      'scattered',
    ]);
  });

  it('TC-F4-U06 ranks a title match above a body match for the same query', () => {
    const documents = [
      doc('body-only', { fields: { body: ['alpha appears in the body'] } }),
      doc('title-only', { fields: { title: ['alpha'] } }),
    ];

    const results = run(documents, 'alpha');
    expect(results.map((hit) => hit.id)).toEqual(['title-only', 'body-only']);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[0]?.fields).toEqual(['title']);
  });

  it('TC-F4-U07 finds a Chinese record through the CJK bigram path', () => {
    const documents = [
      doc('repeat', { fields: { body: ['间隔重复的学习方法'] } }),
      doc('apart', { fields: { body: ['中间插了一道隔壁'] } }),
    ];
    const shards = shardsOf(documents);

    // The bigram is a term of its own, living in a shard of its own…
    expect(shards.map((shard) => shard.key)).toContain('间隔');
    const bigramShard = parseShard(shards.find((shard) => shard.key === '间隔')?.text ?? null);
    expect(queryShard(bigramShard ?? emptyShard(), '间隔').map((posting) => posting.id)).toEqual([
      'repeat',
    ]);

    // …and the query expands to it, which is what breaks the tie: 3/3 index terms vs 2/3.
    const results = search(shards, '间隔', { docs: documents, now: () => NOW });
    expect(results.terms).toContain('间隔');
    expect(results.map((hit) => hit.id)).toEqual(['repeat', 'apart']);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it('TC-F4-U08 narrows with tag:, topic: and in: filters, alone and with terms', () => {
    const documents = [
      doc('c1', { kind: 'card', fields: { title: ['Alpha card'], tag: ['ai'], topic: ['t-ml'] } }),
      doc('c2', {
        kind: 'card',
        fields: { title: ['Alpha card two'], tag: ['gardening'], topic: ['t-ml'] },
      }),
      doc('s1', { kind: 'source', fields: { title: ['Alpha source'], tag: ['ai'] } }),
    ];

    expect(run(documents, 'alpha tag:ai').map((hit) => hit.id)).toEqual(['c1', 's1']);
    expect(run(documents, 'tag:ai in:cards').map((hit) => hit.id)).toEqual(['c1']);
    expect(run(documents, 'tag:ai').map((hit) => hit.id)).toEqual(['c1', 's1']);
    expect(run(documents, 'topic:t-ml').map((hit) => hit.id)).toEqual(['c1', 'c2']);
    expect(run(documents, 'in:cards').map((hit) => hit.id)).toEqual(['c1', 'c2']);
    expect(run(documents, 'in:inbox').map((hit) => hit.id)).toEqual(['s1']);
    expect(run(documents, 'alpha in:inbox').map((hit) => hit.id)).toEqual(['s1']);
    expect(run(documents, 'in:bogus')).toHaveLength(0);
    expect(run(documents, 'tag:missing')).toHaveLength(0);
    // A filter that excludes everything still returns an empty list, not an error.
    expect(run(documents, 'alpha in:topics')).toHaveLength(0);
  });

  it('TC-F4-U09 returns no hits for an empty or punctuation-only query', () => {
    const documents = [doc('s1', { fields: { body: ['alpha'] } })];

    for (const query of ['', '   ', '!!!', '…—', '"   "', 'tag:']) {
      const results = run(documents, query);
      expect(results).toHaveLength(0);
      expect(results.needsRebuild).toBe(false);
      expect(results.terms).toEqual([]);
    }
  });

  it('TC-F4-U09 returns an explicit empty list when nothing matches', () => {
    const documents = [doc('s1', { fields: { body: ['alpha'] } })];
    const results = run(documents, 'unicorn');
    expect(results).toHaveLength(0);
    expect(results.terms).toEqual(['unicorn']);
  });

  it('TC-F4-U09 caps results with the limit option', () => {
    const documents = ['a', 'b', 'c'].map((id) =>
      doc(`s-${id}`, { fields: { body: ['alpha'] } }),
    );

    expect(run(documents, 'alpha', { limit: 1 }).map((hit) => hit.id)).toEqual(['s-a']);
    expect(run(documents, 'alpha', { limit: 0 })).toHaveLength(0);
    expect(run(documents, 'alpha')).toHaveLength(3);
  });

  it('TC-F4-U10 flags a corrupt or unreadable shard instead of throwing', () => {
    const documents = [doc('s1', { fields: { body: ['alpha'] } })];
    const good = shardsOf(documents);
    const options: SearchOptions = { docs: documents, now: () => NOW };

    const corrupt = search([...good, { key: 'zz', text: '{ not json' }], 'alpha', options);
    expect(corrupt.needsRebuild).toBe(true);
    expect(corrupt.map((hit) => hit.id)).toEqual(['s1']);

    expect(search([...good, { key: 'yy', text: null }], 'alpha', options).needsRebuild).toBe(true);

    const staleSchema = search([{ key: 'al', text: '{"schema":9,"terms":{}}' }], 'alpha', options);
    expect(staleSchema.needsRebuild).toBe(true);
    expect(staleSchema).toHaveLength(0);

    // A clean index reports nothing to rebuild.
    expect(search(good, 'alpha', options).needsRebuild).toBe(false);
    expect(search([], 'alpha', options).needsRebuild).toBe(false);
  });

  it('TC-F4-U12 ranks the newer record first when coverage and field weight tie', () => {
    const older = doc('older', {
      fields: { body: ['alpha'] },
      updated_at: iso(NOW - 30 * DAY),
    });
    const newer = doc('newer', { fields: { body: ['alpha'] }, updated_at: iso(NOW) });
    const documents = [older, newer];

    const results = run(documents, 'alpha');
    expect(results.map((hit) => hit.id)).toEqual(['newer', 'older']);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);

    // The clock really is injected: a year later the same pair decays, in the same order.
    const later = search(shardsOf(documents), 'alpha', {
      docs: documents,
      now: () => NOW + 365 * DAY,
    });
    expect(later.map((hit) => hit.id)).toEqual(['newer', 'older']);
    expect(later[0]?.score).toBeLessThan(results[0]?.score ?? 0);
  });

  it('TC-F4-U05 returns hits in a total order so a rebuild reproduces the list', () => {
    const documents = ['a', 'b', 'c'].map((id) => doc(`s-${id}`, { fields: { body: ['alpha'] } }));
    const first = run(documents, 'alpha').map((hit) => hit.id);
    const second = run([...documents].reverse(), 'alpha').map((hit) => hit.id);
    expect(first).toEqual(second);
    expect(first).toEqual(['s-a', 's-b', 's-c']);
  });
});
