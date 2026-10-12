import { describe, expect, it } from 'vitest';

import { newSourceItem } from '../core/ckf';

import { SearchIndex } from './index';
import {
  createLocalShardStore,
  createMemoryShardBackend,
  markBuiltFrom,
  readBuiltFrom,
} from './local-store';

/**
 * F16 step 2b/2c - the index can live on this machine, and it remembers the head it was built from.
 *
 * The point is not that bytes are stored differently; it is that the whole index can be built and queried
 * without a single repository write, and that a later sync can tell whether it still describes what it can see.
 */
describe('local shard store (F16 UNIT)', () => {
  const record = newSourceItem({
    id: 'src00001',
    url: 'https://example.com/a',
    title: 'Spaced repetition',
    body: 'Reviewing material near the point of forgetting',
    capturedAt: new Date(0),
  });

  it('TC-F16-U04 builds and queries an index that never leaves the machine', async () => {
    const backend = createMemoryShardBackend();
    const store = createLocalShardStore(backend);
    const index = new SearchIndex({ store, now: () => 0 });

    const files = await index.rebuild([record]);
    expect(files.length).toBeGreaterThan(0);
    expect((await store.listShards()).length).toBeGreaterThan(0);

    const hits = await index.query('forgetting');
    expect(hits.map((hit) => hit.id)).toContain('src00001');
  });

  it('TC-F16-U05 reads, lists and removes through the backend', async () => {
    const backend = createMemoryShardBackend();
    expect(await backend.read('c00')).toBeNull();
    await backend.write('c00', 'one');
    await backend.write('c1f', 'two');
    expect(await backend.read('c00')).toBe('one');
    expect(await backend.list()).toEqual(['c00', 'c1f']);
    await backend.remove('c00');
    expect(await backend.read('c00')).toBeNull();
    expect(await backend.list()).toEqual(['c1f']);
  });

  it('TC-F16-U06 keeps the built-for head out of the shard listing', async () => {
    const backend = createMemoryShardBackend();
    const store = createLocalShardStore(backend);
    await backend.write('c00', 'a shard');
    expect(await readBuiltFrom(backend)).toBeNull();

    await markBuiltFrom(backend, 'headsha1');
    expect(await readBuiltFrom(backend)).toBe('headsha1');
    // The marker lives beside the shards but is not one of them: listing it as a shard would make the index
    // parse its own metadata as postings.
    expect(await store.listShards()).toEqual(['c00']);

    await markBuiltFrom(backend, 'headsha2');
    expect(await readBuiltFrom(backend)).toBe('headsha2');
    expect(await store.listShards()).toEqual(['c00']);
  });
});
