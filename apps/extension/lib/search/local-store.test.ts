import { describe, expect, it } from 'vitest';

import { newSourceItem } from '../core/ckf';

import { SearchIndex } from './index';
import { createLocalShardStore, createMemoryShardBackend } from './local-store';

/**
 * F16 step 2b - the index can live on this machine.
 *
 * The point of the local store is not that it stores bytes differently; it is that the whole index can be built
 * and queried without a single repository write. This drives a real SearchIndex through it.
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
    // The store was written directly, and the shards are listed from it - no repository involved.
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
});
