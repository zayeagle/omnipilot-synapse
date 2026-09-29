/**
 * A `SearchStore` that reads its shards out of the repository.
 *
 * The search index is derived data that travels with the notes: `search/<key>.json` is committed in
 * the same commit as the record that changed it. So the engine never needs a local shard cache to
 * *answer* a query — it reads the shards that are already in the repository, which are always at least
 * as fresh as the local record cache.
 *
 * Writes are buffered rather than performed: committing is the engine's job (one commit per sync), and
 * `SearchIndex` already returns every file it produced. The buffer exists so a future caller that
 * ignores the return value cannot silently lose a shard.
 */

import { shardPath } from '../search/postings';
import type { SearchStore } from '../search/index';
import type { DirEntry, RepoFile } from '../store/types';

/** The slice of the repository this store needs. `KnowledgeStore` satisfies it. */
export interface ShardSeam {
  readFile(path: string): Promise<string | null>;
  listDir(path: string): Promise<DirEntry[]>;
}

export interface RemoteShardStore extends SearchStore {
  /** The shard files written since the last drain, sorted by path. */
  drain(): RepoFile[];
}

/** `[prefix/]search` — the directory the shards live in. Derived from {@link shardPath} so the two
 * can never disagree about the layout. */
export function shardDir(prefix?: string | null): string {
  const sample = shardPath('x', prefix);
  const slash = sample.lastIndexOf('/');
  return slash === -1 ? sample : sample.slice(0, slash);
}

export function createRemoteShardStore(
  seam: ShardSeam,
  prefix?: string | null,
): RemoteShardStore {
  const pending = new Map<string, string>();
  return {
    async listShards(): Promise<readonly string[]> {
      const entries = await seam.listDir(shardDir(prefix));
      return entries
        .filter((entry) => entry.type === 'file' && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -'.json'.length))
        .sort();
    },
    readShard(key: string): Promise<string | null> {
      return seam.readFile(shardPath(key, prefix));
    },
    async writeShard(key: string, content: string): Promise<void> {
      pending.set(key, content);
    },
    drain(): RepoFile[] {
      const files = [...pending.entries()].map(([key, content]) => ({
        path: shardPath(key, prefix),
        content,
      }));
      pending.clear();
      return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
  };
}
