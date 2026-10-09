import { describe, expect, it } from 'vitest';

import {
  MAX_POSTINGS_PER_TERM,
  POSTINGS_SCHEMA_VERSION,
  addPosting,
  addRecord,
  addTermPostings,
  emptyShard,
  groupTermPostings,
  isTruncated,
  isTruncationMarker,
  parseShard,
  queryShard,
  removeRecord,
  serializeShard,
  shardPath,
  shardTerms,
  termPostings,
  type Posting,
  type PostingsShard,
  type SearchDocument,
} from './postings';
import { shardKey } from './tokenize';

/** Minimal indexable document; every test overrides only the fields it is about. */
function doc(id: string, overrides: Partial<SearchDocument> = {}): SearchDocument {
  return {
    id,
    kind: 'source',
    path: `inbox/2026/01/${id}.md`,
    title: `Title ${id}`,
    fields: {},
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function ids(postings: readonly Posting[]): string[] {
  return postings.map((posting) => `${posting.id}:${posting.field}`);
}

describe('postings (F4 UNIT)', () => {
  it('TC-F4-U01 records one posting per term and field, ordered by id then field', () => {    let shard = emptyShard();
    shard = addRecord(
      shard,
      doc('a', { fields: { title: ['Alpha beta'], body: ['alpha gamma'] } }),
    );
    shard = addRecord(shard, doc('b', { fields: { body: ['alpha'] } }));

    expect(ids(queryShard(shard, 'alpha'))).toEqual(['a:title', 'a:body', 'b:body']);
    expect(queryShard(shard, 'gamma')).toEqual([
      { id: 'a', path: 'inbox/2026/01/a.md', field: 'body', tf: 1 },
    ]);
    expect(queryShard(shard, 'missing')).toEqual([]);
    expect(shardTerms(shard)).toEqual(['alpha', 'beta', 'gamma']);
    expect(shard.schema).toBe(POSTINGS_SCHEMA_VERSION);
  });

  it('TC-F4-U01 counts term frequency across a field’s texts', () => {
    let shard = emptyShard();
    shard = addRecord(
      shard,
      doc('a', { kind: 'card', fields: { point: ['alpha', 'alpha and beta'] } }),
    );

    expect(queryShard(shard, 'alpha')).toEqual([
      { id: 'a', path: 'inbox/2026/01/a.md', field: 'point', tf: 2 },
    ]);
    expect(queryShard(shard, 'beta')).toEqual([
      { id: 'a', path: 'inbox/2026/01/a.md', field: 'point', tf: 1 },
    ]);
  });

  it('TC-F4-U01 indexes the same term once per field it appears in', () => {
    let shard = emptyShard();
    shard = addRecord(shard, doc('a', { fields: { title: ['alpha'], body: ['alpha'] } }));

    expect(queryShard(shard, 'alpha').map((posting) => posting.field)).toEqual(['title', 'body']);
    // Re-adding the same document is idempotent: no duplicate postings.
    const again = addRecord(shard, doc('a', { fields: { title: ['alpha'], body: ['alpha'] } }));
    expect(serializeShard(again)).toBe(serializeShard(shard));
  });

  it('TC-F4-U01 is deterministic regardless of insertion order', () => {
    const forward = addRecord(
      addRecord(emptyShard(), doc('a', { fields: { body: ['alpha'] } })),
      doc('b', { fields: { body: ['alpha beta'] } }),
    );
    const backward = addRecord(
      addRecord(emptyShard(), doc('b', { fields: { body: ['alpha beta'] } })),
      doc('a', { fields: { body: ['alpha'] } }),
    );

    expect(serializeShard(forward)).toBe(serializeShard(backward));
    expect(ids(queryShard(forward, 'alpha'))).toEqual(['a:body', 'b:body']);
  });

  it('TC-F4-U01 emits no tokens for punctuation-only or review content', () => {
    const shard = addRecord(emptyShard(), doc('a', { fields: { body: ['!!! …'], title: [''] } }));
    expect(shardTerms(shard)).toEqual([]);
    expect(termPostings(doc('r', { kind: 'review' }))).toEqual([]);
  });

  it('TC-F4-U02 removes a record and leaves a shard that still round-trips as JSON', () => {
    let shard = emptyShard();
    shard = addRecord(shard, doc('a', { fields: { title: ['alpha'], body: ['gamma'] } }));
    shard = addRecord(shard, doc('b', { fields: { body: ['alpha'] } }));

    const next = removeRecord(shard, 'a');
    expect(ids(queryShard(next, 'alpha'))).toEqual(['b:body']);
    expect(queryShard(next, 'gamma')).toEqual([]);
    // The input shard is untouched: add/remove return new shards.
    expect(ids(queryShard(shard, 'alpha'))).toEqual(['a:title', 'b:body']);

    const parsed = parseShard(serializeShard(next));
    expect(parsed).not.toBeNull();
    expect(parsed?.terms).toEqual(next.terms);
    expect(JSON.parse(serializeShard(next))).toEqual({ schema: 1, terms: next.terms });
  });

  it('TC-F4-U02 drops a term once its last posting is removed, and keeps markers otherwise', () => {
    let shard = emptyShard();
    shard = addRecord(shard, doc('a', { fields: { title: ['alpha'], body: ['gamma'] } }));
    shard = addRecord(shard, doc('b', { fields: { body: ['alpha'] } }));
    // `removeRecord` on an id that is not there changes nothing at all.
    expect(removeRecord(shard, 'nobody')).toBe(shard);

    const removed = removeRecord(shard, 'b');
    expect(shardTerms(removed)).toEqual(['alpha', 'gamma']);

    // A capped term carries a marker; removing an unrelated record must not erase that evidence.
    const capped: PostingsShard = {
      schema: POSTINGS_SCHEMA_VERSION,
      terms: {
        alpha: [
          { id: 'a', path: 'a.md', field: 'body', tf: 1 },
          { truncated: true, dropped: 3 },
        ],
        beta: [{ id: 'b', path: 'b.md', field: 'body', tf: 1 }],
      },
    };
    expect(removeRecord(capped, 'b').terms['alpha']).toEqual([
      { id: 'a', path: 'a.md', field: 'body', tf: 1 },
      { truncated: true, dropped: 3 },
    ]);
    expect(removeRecord(capped, 'a').terms['alpha']).toBeUndefined();
    expect(shardTerms(removeRecord(capped, 'nobody'))).toEqual(['alpha', 'beta']);
  });

  it('TC-F4-U04 marks truncation beyond MAX_POSTINGS_PER_TERM instead of dropping silently', () => {
    const corpus = 5000; // the corpus size TC-F4-U04 names
    let shard = emptyShard();
    for (let i = 0; i < corpus; i += 1) {
      const id = `id-${String(i).padStart(5, '0')}`;
      shard = addRecord(shard, doc(id, { fields: { body: ['common term'] } }));
    }

    const list = shard.terms['common'] ?? [];
    const marker = list.find(isTruncationMarker);
    expect(marker).toEqual({ truncated: true, dropped: corpus - MAX_POSTINGS_PER_TERM });
    expect(queryShard(shard, 'common')).toHaveLength(MAX_POSTINGS_PER_TERM);
    expect(isTruncated(shard, 'common')).toBe(true);
    // The marker is the last entry, and it survives a serialize/parse round trip.
    expect(list[list.length - 1]).toEqual(marker);
    expect(parseShard(serializeShard(shard))?.terms['common']).toHaveLength(
      MAX_POSTINGS_PER_TERM + 1,
    );
    // Truncation is per term: a rare term added alongside is untouched.
    const rare = addRecord(shard, doc('id-rare', { fields: { body: ['common unicorn'] } }));
    expect(queryShard(rare, 'unicorn')).toHaveLength(1);
    expect(isTruncated(rare, 'unicorn')).toBe(false);
    expect(isTruncated(rare, 'common')).toBe(true);
  });

  it('TC-F4-U04 reports truncation through the shard model, not by growing without bound', () => {
    let shard = emptyShard();
    for (let i = 0; i <= MAX_POSTINGS_PER_TERM; i += 1) {
      shard = addPosting(shard, 'alpha', {
        id: `id-${String(i).padStart(5, '0')}`,
        path: 'p.md',
        field: 'body',
        tf: 1,
      });
    }
    expect(shard.terms['alpha']).toHaveLength(MAX_POSTINGS_PER_TERM + 1);
    expect(shard.terms['alpha']?.at(-1)).toEqual({ truncated: true, dropped: 1 });
  });

  it('TC-F4-U04 writes shards to the documented path', () => {
    expect(shardPath('al')).toBe('search/al.json');
    expect(shardPath('间隔', 'notes')).toBe('notes/search/间隔.json');
    expect(shardPath('al', '/notes/')).toBe('notes/search/al.json');
  });

  it('TC-F4-U04 parses a shard tolerantly and rejects structural corruption', () => {
    expect(parseShard(null)).toBeNull();
    expect(parseShard('')).toBeNull();
    expect(parseShard('{ not json')).toBeNull();
    expect(parseShard('[]')).toBeNull();
    expect(parseShard('{"schema":2,"terms":{}}')).toBeNull();
    expect(parseShard('{"schema":1,"terms":[]}')).toBeNull();

    // Malformed entries are dropped rather than guessed at; the rest of the shard survives.
    const parsed = parseShard(
      JSON.stringify({
        schema: 1,
        terms: {
          alpha: [
            { id: 'a', path: 'a.md', field: 'body', tf: 1 },
            { id: 'b', path: 'b.md', field: 'nope', tf: 1 },
            { id: 'c', path: 'c.md', field: 'body', tf: 0 },
            'garbage',
          ],
          beta: 'not a list',
        },
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.terms['alpha']).toEqual([{ id: 'a', path: 'a.md', field: 'body', tf: 1 }]);
    expect(parsed?.terms['beta']).toBeUndefined();
  });

  it('TC-F4-U01 groups a document’s postings by shard key for the sharded write path', () => {
    const document = doc('a', {
      fields: { title: ['Alpha note'], body: ['间隔重复'], tag: ['ai'] },
    });

    const grouped = groupTermPostings(document);
    // Every term lands in exactly one group, and the group key is that term's shard key.
    for (const [key, entries] of grouped) {
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) expect(shardKey(entry.term)).toBe(key);
    }
    // The key is the term's bucket, not its text: ask for it the way the write path does. `toContain`
    // rather than an exact list, because two terms may share a bucket and that is not a failure.
    expect(grouped.get(shardKey('间隔'))?.map((entry) => entry.term)).toContain('间隔');
    expect(grouped.get(shardKey('ai'))?.map((entry) => entry.posting.field)).toContain('tag');

    // The whole-document form is the same postings, all in one shard.
    const whole = addRecord(emptyShard(), document);
    const summed = [...grouped.values()].flat();
    let distributed = emptyShard();
    for (const [key, entries] of grouped) {
      distributed = addTermPostings(distributed, entries);
      expect(key.length).toBeGreaterThan(0);
    }
    expect(serializeShard(whole)).toBe(serializeShard(distributed));
    expect(queryShard(whole, 'alpha')).toEqual(queryShard(distributed, 'alpha'));
    expect(summed).toHaveLength(termPostings(document).length);

    expect(groupTermPostings(doc('r', { kind: 'review' })).size).toBe(0);
  });
});
