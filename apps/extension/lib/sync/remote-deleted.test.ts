import { describe, expect, it } from 'vitest';

import { remoteFromStore, remoteFromTransport } from './engine';

/**
 * F16 step 1 - a commit has to be able to DELETE, because the index is leaving the repository.
 *
 * The REST store already expresses a deletion as a tree entry with a null sha; what was missing was the
 * plumbing: the remote interface dropped the argument, so a caller could not delete anything through it at
 * all. The companion transport must NOT quietly ignore the paths - it refuses them (deleteUnsupported).
 */
describe('remote deletions (F16 UNIT)', () => {
  const index = { schema: 1 as const, items: {} };

  it('TC-F16-U01 forwards deletions to the REST store', async () => {
    const seen: string[][] = [];
    const remote = remoteFromStore({
      readIndex: async () => index,
      readFile: async () => null,
      listDir: async () => [],
      commitFiles: async (_files, _message, deleted) => {
        seen.push([...(deleted ?? [])]);
        return { sha: 'c1', htmlUrl: 'https://example.com/c1', paths: [] };
      },
    });
    await remote.commitFiles([], 'x', ['search/ag.json']);
    expect(seen).toEqual([['search/ag.json']]);
  });

  it('TC-F16-U02 forwards deletions to the companion transport, which is what refuses them', async () => {
    const seen: string[][] = [];
    const remote = remoteFromTransport({
      readFile: async () => null,
      listDir: async () => [],
      commitFiles: async (_files, _message, deleted) => {
        seen.push([...(deleted ?? [])]);
        return { sha: 'c2', htmlUrl: 'https://example.com/c2', paths: [] };
      },
    });
    await remote.commitFiles([], 'x', ['search/ag.json']);
    expect(seen).toEqual([['search/ag.json']]);
  });
});
