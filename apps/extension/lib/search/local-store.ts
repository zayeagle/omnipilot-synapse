/**
 * The search index kept on this machine.
 *
 * The index is derived data - everything in it is rebuildable from the records - so it does not belong in the
 * repository. Keeping it there cost three things that were all measured: every capture rewrote every bucket it
 * touched (89 requests for one Chinese note), the repository grew with a file per bucket per change, and in the
 * vault tier the shards sat in the open as plaintext while the records themselves stayed sealed.
 *
 * This module is only storage: a small key -> text backend (IndexedDB in the worker, a Map in tests and as the
 * fallback when IndexedDB is unavailable) exposed as the SearchStore the index already knows how to use.
 */

import type { SearchStore } from './index';

/** The slice of storage the index needs. Deliberately tiny: read, write, remove, list. */
export interface LocalShardBackend {
  read(key: string): Promise<string | null>;
  write(key: string, content: string): Promise<void>;
  remove(key: string): Promise<void>;
  list(): Promise<string[]>;
}

/** In-memory backend: tests, and the fallback when IndexedDB is unavailable. */
export function createMemoryShardBackend(): LocalShardBackend {
  const shards = new Map<string, string>();
  return {
    async read(key) {
      return shards.get(key) ?? null;
    },
    async write(key, content) {
      shards.set(key, content);
    },
    async remove(key) {
      shards.delete(key);
    },
    async list() {
      return [...shards.keys()].sort();
    },
  };
}

/**
 * IndexedDB backend.
 *
 * Its own database, not the sync cache's: the cache is disposable record storage with a fixed schema, and a
 * version bump there would invalidate every existing installation for no reason. This one holds only shards.
 */
export function createIndexedDbShardBackend(factory: IDBFactory): LocalShardBackend {
  const database = 'omnipilot-search';
  const store = 'shards';
  let opening: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(database, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('search index: cannot open storage'));
    });
    return opening;
  };

  /** One transaction, resolved on completion, rejected on error. */
  const run = async <T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = work(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error('search index: transaction aborted'));
      transaction.onerror = () => reject(transaction.error ?? new Error('search index: transaction failed'));
    });
  };

  return {
    async read(key) {
      const value = await run<string | undefined>('readonly', (s) => s.get(key));
      return typeof value === 'string' ? value : null;
    },
    async write(key, content) {
      await run('readwrite', (s) => s.put(content, key));
    },
    async remove(key) {
      await run('readwrite', (s) => s.delete(key));
    },
    async list() {
      const keys = await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
      return keys.filter((key): key is string => typeof key === 'string').sort();
    },
  };
}

/**
 * The index's view of a local backend.
 *
 * Writes land immediately: there is no commit to batch them into, which is the point - nothing about the index
 * touches the network any more.
 */
export function createLocalShardStore(backend: LocalShardBackend): SearchStore {
  return {
    listShards: () => backend.list(),
    readShard: (key) => backend.read(key),
    writeShard: (key, content) => backend.write(key, content),
    removeShard: (key) => backend.remove(key),
  };
}
