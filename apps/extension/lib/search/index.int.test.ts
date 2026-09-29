import { describe, expect, it } from 'vitest';

import { newKnowledgeCard, newSourceItem, type CkfRecord } from '../core/ckf';
import { SearchIndex, shardKeyFromPath, type SearchStore } from './index';
import { parseShard, type PostingsShard } from './postings';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** In-memory stand-in for the repository: the whole feature is testable through this port. */
class MemoryShardStore implements SearchStore {
  readonly shards = new Map<string, string>();
  readonly writes: string[] = [];
  readonly removes: string[] = [];
  failList = false;
  failRead = false;

  async listShards(): Promise<readonly string[]> {
    if (this.failList) throw new Error('store unavailable');
    return [...this.shards.keys()];
  }

  async readShard(key: string): Promise<string | null> {
    if (this.failRead) throw new Error('store unavailable');
    return this.shards.get(key) ?? null;
  }

  async writeShard(key: string, content: string): Promise<void> {
    this.shards.set(key, content);
    this.writes.push(key);
  }

  async removeShard(key: string): Promise<void> {
    this.shards.delete(key);
    this.removes.push(key);
  }
}

/** Ten sources: exactly one is about spaced repetition, the rest share a gardening vocabulary. */
function corpus(): CkfRecord[] {
  const records: CkfRecord[] = [];
  for (let i = 0; i < 10; i += 1) {
    records.push(
      newSourceItem({
        id: `s${String(i).padStart(2, '0')}`,
        url: `https://example.com/${i}`,
        title: i === 6 ? 'Spaced repetition explained' : `Field note ${i}`,
        body:
          i === 6
            ? 'Spaced repetition schedules reviews so that each one lands just before you would forget.'
            : `Unrelated gardening notes number ${i}.`,
        tags: [i % 2 === 0 ? 'ai' : 'gardening'],
        capturedAt: new Date(NOW - i * DAY),
      }),
    );
  }
  return records;
}

async function seeded(): Promise<{ store: MemoryShardStore; index: SearchIndex }> {
  const store = new MemoryShardStore();
  const index = new SearchIndex({ store, now: () => NOW, prefix: null });
  for (const record of corpus()) await index.upsert(record);
  return { store, index };
}

describe('SearchIndex (F4 INT)', () => {
  it('TC-F4-I01 seeds ten records through upsert and finds the right one with a snippet', async () => {
    const { store, index } = await seeded();

    expect(store.shards.size).toBeGreaterThan(1);
    for (const key of store.shards.keys()) {
      expect(Array.from(key).length).toBeLessThanOrEqual(2);
      expect(parseShard(store.shards.get(key) ?? null)).not.toBeNull();
    }

    const results = await index.query('spaced repetition');
    expect(results.needsRebuild).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('s06');
    expect(results[0]?.path).toBe('inbox/2026/05/spaced-repetition-explained-s06.md');
    expect(results[0]?.title).toBe('Spaced repetition explained');
    expect(results[0]?.snippet).toContain('Spaced repetition');
    expect(results[0]?.fields).toEqual(['title', 'body']);

    // A second query path: a term the other nine records share, and a filter.
    const gardening = await index.query('gardening');
    expect(gardening).toHaveLength(9);
    expect(gardening.some((hit) => hit.id === 's06')).toBe(false);

    const tagged = await index.query('tag:ai in:inbox');
    expect(tagged.map((hit) => hit.id).sort()).toEqual(['s00', 's02', 's04', 's06', 's08']);
  });

  it('TC-F4-I02 changedShards returns exactly the shards one record touches, as JSON', async () => {
    const store = new MemoryShardStore();
    const index = new SearchIndex({ store, now: () => NOW });
    const fresh = newSourceItem({
      id: 'new1',
      url: 'https://example.com/new',
      title: 'Interval training',
      body: 'A short note about intervals.',
      capturedAt: new Date(NOW),
    });

    const expectedKeys = index.shardsFor(fresh);
    const files = await index.changedShards(fresh);

    // Exactly the shards the record touches: nothing more, and computing wrote nothing.
    expect(files.map((file) => shardKeyFromPath(file.path)).sort()).toEqual(expectedKeys);
    expect(files.length).toBe(expectedKeys.length);
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThanOrEqual(12);
    expect(store.writes).toEqual([]);

    for (const file of files) {
      expect(file.path).toMatch(/^search\/[^/]+\.json$/u);
      const parsed = JSON.parse(file.content) as PostingsShard;
      expect(parsed.schema).toBe(1);
      expect(Object.keys(parsed.terms).length).toBeGreaterThan(0);
      expect(parseShard(file.content)).not.toBeNull();
    }

    // A shard the record does not touch is not rewritten.
    await index.applyShards(files);
    expect(store.writes).toEqual(files.map((file) => shardKeyFromPath(file.path)));
    for (const file of files) {
      expect(store.shards.get(shardKeyFromPath(file.path))).toBe(file.content);
    }

    // The record is now retrievable, and re-indexing it is a no-op.
    expect((await index.query('intervals'))[0]?.id).toBe('new1');
    expect(await index.changedShards(fresh)).toEqual([]);
  });

  it('TC-F4-I02 keeps a card’s postings in step when its path changes', async () => {
    const store = new MemoryShardStore();
    const index = new SearchIndex({ store, now: () => NOW });
    const pending = newKnowledgeCard({
      id: 'c1',
      source_id: 's06',
      title: 'Interval recall',
      summary: 'Recall just before forgetting.',
      points: ['Grow the interval'],
      evidence_paths: ['inbox/2026/06/field-note-6-s06.md'],
      status: 'pending',
    });
    const confirmed = newKnowledgeCard({ ...pending, status: 'confirmed' });

    await index.upsert(pending);
    expect((await index.query('interval'))[0]?.path).toBe('cards/pending/interval-recall-c1.md');

    const files = await index.upsert(confirmed, pending);
    expect(files.length).toBeGreaterThan(0);
    const hit = (await index.query('interval'))[0];
    expect(hit?.path).toBe('cards/interval-recall-c1.md');
    // The stale path is gone from every shard.
    for (const content of store.shards.values()) {
      expect(content).not.toContain('cards/pending/interval-recall-c1.md');
    }

    // Deleting it removes the postings entirely.
    const removed = await index.remove('c1', 'cards/interval-recall-c1.md', confirmed);
    expect(removed.length).toBeGreaterThan(0);
    expect(await index.query('interval')).toHaveLength(0);
    expect(store.removes).toEqual([]); // the shards were rewritten, not dropped
  });

  it('TC-F4-I03 rebuilds dropped shards from the records and returns the same ids', async () => {
    const { store, index } = await seeded();
    const before = (await index.query('spaced repetition')).map((hit) => hit.id);
    expect(before).toEqual(['s06']);

    // Drop the index entirely: a cold, empty repository.
    store.shards.clear();
    expect(await index.query('spaced repetition')).toHaveLength(0);

    const rebuilt = await index.rebuild(corpus());
    expect(rebuilt.length).toBeGreaterThan(0);
    expect(rebuilt.every((file) => file.path.startsWith('search/'))).toBe(true);

    const after = await index.query('spaced repetition');
    expect(after.needsRebuild).toBe(false);
    expect(after.map((hit) => hit.id)).toEqual(before);

    // A second rebuild is a no-op, so it adds no commit noise.
    expect(await index.rebuild(corpus())).toEqual([]);
  });

  it('TC-F4-I03 drops shards that a rebuild no longer needs', async () => {
    const { store, index } = await seeded();
    const shardCount = store.shards.size;

    await index.rebuild([]);
    expect(store.removes.length).toBe(shardCount);
    expect(store.shards.size).toBe(0);
    expect(await index.query('spaced repetition')).toHaveLength(0);
  });

  it('TC-F4-I03 flags a corrupt shard or an unreachable store instead of throwing', async () => {
    const { store, index } = await seeded();
    const first = [...store.shards.keys()][0] ?? '';
    store.shards.set(first, '{ corrupt');

    const corrupt = await index.query('spaced repetition');
    expect(corrupt.needsRebuild).toBe(true);

    store.failRead = true;
    expect((await index.query('spaced repetition')).needsRebuild).toBe(true);

    store.failRead = false;
    store.failList = true;
    const offline = await index.query('spaced repetition');
    expect(offline.needsRebuild).toBe(true);
    expect(offline).toHaveLength(0);

    // A repository that simply has no index yet is not corrupt.
    store.failList = false;
    store.shards.clear();
    expect((await index.query('spaced repetition')).needsRebuild).toBe(false);
  });
});
