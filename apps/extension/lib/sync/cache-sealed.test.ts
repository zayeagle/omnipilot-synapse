import { describe, expect, it } from 'vitest';

import { newSourceItem, type CkfRecord } from '../core/ckf';
import type { Sealer } from '../security/sealer';
import { SyncCache, createMemoryBackend } from './cache';

/**
 * R8 — the cache holds CONTENT, so it is sealed with the vault key.
 *
 * Two facts matter and neither is about cryptography: what reaches browser storage must not be note text,
 * and an entry that cannot be opened (the vault is locked) must be unreadable rather than lost.
 */
function fakeSealer(openable = true): Sealer {
  return {
    async seal(plaintext) {
      return 'sealed:' + Buffer.from(plaintext, 'utf8').toString('base64');
    },
    async open(sealed) {
      if (!openable) throw new Error('vault: locked');
      return Buffer.from(sealed.replace(/^sealed:/u, ''), 'base64').toString('utf8');
    },
  };
}

function source(id: string): CkfRecord {
  return newSourceItem({
    id,
    url: 'https://example.com/' + id,
    title: 'A private page',
    body: 'the body that must not sit in plaintext',
    tags: [],
    capturedAt: new Date(0),
  });
}

describe('cache sealing (R8 UNIT)', () => {
  it('TC-R8-U02 writes the body sealed, and reads it back whole', async () => {
    const backend = createMemoryBackend();
    const cache = new SyncCache(backend, fakeSealer());
    await cache.put(source('a'), { path: 'inbox/a.md', sha: 'sha-a' });

    const raw = JSON.stringify(await backend.listRecords());
    expect(raw).toContain('sealed:');
    expect(raw).not.toContain('example.com');
    expect(raw).not.toContain('the body that must not sit in plaintext');

    const back = await cache.get('inbox/a.md');
    expect(back?.record).toEqual(source('a'));
  });

  it('TC-R8-U03 a locked vault makes a sealed body unreadable — not lost', async () => {
    const backend = createMemoryBackend();
    await new SyncCache(backend, fakeSealer()).put(source('a'), { path: 'inbox/a.md', sha: 'sha-a' });

    const locked = new SyncCache(backend, fakeSealer(false));
    expect(await locked.get('inbox/a.md')).toBeNull();
    expect(await locked.all()).toEqual([]);

    // Still on disk: unlocking brings it back, which is the difference between locking and losing.
    expect(await new SyncCache(backend, fakeSealer()).get('inbox/a.md')).not.toBeNull();
  });
});
