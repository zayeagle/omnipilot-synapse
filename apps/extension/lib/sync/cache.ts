/**
 * Local cache for the sync engine.
 *
 * Two things live here and nothing else:
 * 1. **decoded records** keyed by repository path — so search and the UI never re-read the network,
 *    and so reconciliation can compare against what we last saw;
 * 2. **sync state** — the last synced head, the outcome, and the set of paths changed locally since
 *    the last successful push ("dirty").
 *
 * The storage is behind a `CacheBackend` interface: IndexedDB in the worker, an in-memory map in
 * tests and as a graceful fallback if IndexedDB is unavailable. **The cache is always disposable** —
 * everything in it can be rebuilt from the repository, which is what makes a corrupt cache a
 * recoverable state (`indexUnavailable`) rather than a data-loss event.
 */

import type { CkfRecord } from '../core/ckf';
import type { ErrorCode } from '../messages';
import type { PublicSyncOutcome } from '../public-prefs';

import type { Sealer } from '../security/sealer';

/** Fields every cached entry has, stored or usable. */
interface CachedBase {
  path: string;
  /** Blob sha (REST) or commit hash context (companion) — used to skip unchanged files on a pull. */
  sha: string;
  kind: CkfRecord['kind'];
  id: string;
  updatedAt: string;
  /**
   * The remote manifest's `content_key` for this path, when one was recorded.
   *
   * Without it a pulled record could never be recognised as unchanged: the manifest identifies a version
   * by `content_key`, while `updatedAt` here is the moment it landed in the cache. Keeping the remote's
   * own key is what makes the second sync a no-op (SC-F5-01) instead of re-fetching the world.
   */
  contentKey?: string;
  /** The remote manifest's `updated_at`, kept for the fallback comparison when no key exists. */
  remoteUpdatedAt?: string;
}

/**
 * A cached record as a caller sees it: the body is always readable.
 *
 * `StoredRecord` is what the backend actually holds when a sealer is configured — the same metadata with
 * the body replaced by ciphertext — so sealing stays an implementation detail of storage and no caller
 * has to handle a bodyless entry.
 */
export interface CachedRecord extends CachedBase {
  record: CkfRecord;
}

export interface SealedCachedRecord extends CachedBase {
  sealed: string;
}

export type StoredRecord = CachedRecord | SealedCachedRecord;


export interface SyncState {
  head: string | null;
  lastSyncAt: string | null;
  lastOutcome: PublicSyncOutcome;
  /** Paths where both sides changed; both versions were preserved. */
  conflicts: string[];
  /**
   * main path → the @@.conflict-<stamp>@@ sibling that holds **our** version.
   *
   * Recorded at sync time because the stamp cannot be re-derived later, and the decision surface needs to name
   * the file it is deciding about (F4). Kept alongside @@conflicts@@ rather than replacing it so every existing
   * reader — the count in public prefs, the status line — keeps working unchanged.
   */
  conflictPaths: Record<string, string>;
  /**
   * The **code** of the last failure — never the worker's sentence.
   *
   * A code is a member of a closed union, so the UI can render a translated, actionable sentence from its own
   * table (F5) while an outside string can never reach the screen. `lastError` keeps the scrubbed text for
   * diagnostics, but nothing renders it.
   */
  lastErrorCode: ErrorCode | null;
  /** Non-secret explanation of the last failure, for the UI. */
  lastError: string | null;
}

export const EMPTY_SYNC_STATE: SyncState = {
  head: null,
  lastSyncAt: null,
  lastOutcome: 'never',
  conflicts: [],
  conflictPaths: {},
  lastErrorCode: null,
  lastError: null,
};

export interface CacheBackend {
  getRecord(path: string): Promise<StoredRecord | null>;
  putRecord(record: StoredRecord): Promise<void>;
  deleteRecord(path: string): Promise<void>;
  listRecords(): Promise<StoredRecord[]>;
  clearRecords(): Promise<void>;

  readState(): Promise<SyncState>;
  writeState(state: SyncState): Promise<void>;

  /** Mark a path as changed locally since the last successful push. */
  markDirty(path: string): Promise<void>;
  /** Clear the given dirty paths (called after a successful push). */
  clearDirty(paths: readonly string[]): Promise<void>;
  dirtyPaths(): Promise<string[]>;
}

/** Strip anything that is not part of the cached shape — defensive against an older/foreign entry. */
export function normalizeCachedRecord(value: unknown): StoredRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const path = raw['path'];
  const sha = raw['sha'];
  const record = raw['record'];
  const sealed = raw['sealed'];
  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof sha !== 'string') return null;
  if (typeof record !== 'object' || record === null) {
    // A sealed entry carries no readable record, so its identity comes from the entry's own fields.
    if (typeof sealed !== 'string' || sealed.length === 0) return null;
  }
  const asRecord = typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : null;
  const kind = asRecord ? asRecord['kind'] : raw['kind'];
  const id = asRecord ? asRecord['id'] : raw['id'];
  if (typeof kind !== 'string' || typeof id !== 'string') return null;
  // The guard above proved exactly one arm is present. A union type cannot express that, so the assembly
  // is asserted once, here, rather than making every caller narrow before it can read a record.
  return {
    path,
    sha,
    kind: kind as CkfRecord['kind'],
    id,
    updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : new Date(0).toISOString(),
    ...(asRecord ? { record: asRecord as unknown as CkfRecord } : {}),
    ...(typeof sealed === 'string' ? { sealed } : {}),
    ...(typeof raw['contentKey'] === 'string' ? { contentKey: raw['contentKey'] } : {}),
    ...(typeof raw['remoteUpdatedAt'] === 'string' ? { remoteUpdatedAt: raw['remoteUpdatedAt'] } : {}),
  } as StoredRecord;
}

/** Only string→string pairs survive: a foreign or half-written entry must not become a path we later commit to. */
function readConflictPaths(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry.length > 0) out[key] = entry;
  }
  return out;
}

export function normalizeSyncState(value: unknown): SyncState {
  if (typeof value !== 'object' || value === null) return { ...EMPTY_SYNC_STATE };
  const raw = value as Record<string, unknown>;
  const outcome = raw['lastOutcome'];
  const allowed = [
    'never',
    'upToDate',
    'pulled',
    'pushed',
    'merged',
    'conflict',
    'failed',
    'busy',
  ];
  return {
    head: typeof raw['head'] === 'string' ? raw['head'] : null,
    lastSyncAt: typeof raw['lastSyncAt'] === 'string' ? raw['lastSyncAt'] : null,
    lastOutcome:
      typeof outcome === 'string' && allowed.includes(outcome)
        ? (outcome as PublicSyncOutcome)
        : 'never',
    conflicts: Array.isArray(raw['conflicts'])
      ? raw['conflicts'].filter((entry): entry is string => typeof entry === 'string')
      : [],
    conflictPaths: readConflictPaths(raw['conflictPaths']),
    // Typed loosely on read and rendered through the guidance table, which has a safe fallback for anything
    // that is not a code we know.
    lastErrorCode: typeof raw['lastErrorCode'] === 'string' ? (raw['lastErrorCode'] as ErrorCode) : null,
    lastError: typeof raw['lastError'] === 'string' ? raw['lastError'] : null,
  };
}

/** The cache the engine talks to. Deliberately thin: it validates, then delegates. */
export class SyncCache {
  constructor(
    private readonly backend: CacheBackend,
    /** Seals record bodies at rest; absent in tests and in a profile with no configured vault. */
    private readonly sealer?: Sealer,
  ) {}

  /** The form that goes to the backend: the record sealed when a sealer is present. */
  private async stored(entry: CachedRecord): Promise<StoredRecord> {
    if (!this.sealer) return entry;
    const sealed = await this.sealer.seal(JSON.stringify(entry.record));
    const rest: CachedRecord = { ...entry };
    delete (rest as { record?: CkfRecord }).record;
    return { ...rest, sealed };
  }

  /** The usable form, or null when a sealed body cannot be opened right now (the vault is locked). */
  private async opened(entry: StoredRecord | null): Promise<CachedRecord | null> {
    if (!entry) return null;
    if ('record' in entry) return entry;
    if (!this.sealer) return null;
    try {
      const record = JSON.parse(await this.sealer.open(entry.sealed)) as CkfRecord;
      const rest: SealedCachedRecord = { ...entry };
      delete (rest as { sealed?: string }).sealed;
      return { ...rest, record };
    } catch {
      return null;
    }
  }

  async get(path: string): Promise<CachedRecord | null> {
    return this.opened(await this.backend.getRecord(path));
  }

  async put(
    record: CkfRecord,
    options: {
      path: string;
      sha: string;
      markDirty?: boolean;
      /** The remote manifest's version identifiers, when the record came from the remote. */
      contentKey?: string;
      remoteUpdatedAt?: string;
    },
  ): Promise<CachedRecord> {
    const entry: CachedRecord = {
      path: options.path,
      sha: options.sha,
      kind: record.kind,
      id: record.id,
      updatedAt: new Date().toISOString(),
      record,
      ...(options.contentKey !== undefined ? { contentKey: options.contentKey } : {}),
      ...(options.remoteUpdatedAt !== undefined ? { remoteUpdatedAt: options.remoteUpdatedAt } : {}),
    };
    await this.backend.putRecord(await this.stored(entry));
    if (options.markDirty === true) await this.backend.markDirty(options.path);
    return entry;
  }

  async forget(path: string): Promise<void> {
    await this.backend.deleteRecord(path);
  }

  async all(): Promise<CachedRecord[]> {
    const out: CachedRecord[] = [];
    for (const row of await this.backend.listRecords()) {
      const opened = await this.opened(row);
      // Unreadable-while-locked entries are skipped, never returned half-formed: every caller reads
      // `entry.record` without checking, so a bodyless entry would be a crash rather than a miss.
      if (opened) out.push(opened);
    }
    return out;
  }

  /** Drop the whole cache. Safe: everything is rebuildable from the repository (SC-F6-03). */
  async clear(): Promise<void> {
    await this.backend.clearRecords();
    await this.backend.writeState({ ...EMPTY_SYNC_STATE });
  }

  async state(): Promise<SyncState> {
    return normalizeSyncState(await this.backend.readState());
  }

  async updateState(patch: Partial<SyncState>): Promise<SyncState> {
    const next = { ...(await this.state()), ...patch };
    await this.backend.writeState(next);
    return next;
  }

  async dirty(): Promise<string[]> {
    return [...new Set(await this.backend.dirtyPaths())].sort();
  }

  async clean(paths: readonly string[]): Promise<void> {
    await this.backend.clearDirty(paths);
  }
}

/** In-memory backend: tests, and the fallback when IndexedDB is unavailable. */
export function createMemoryBackend(): CacheBackend {
  const records = new Map<string, StoredRecord>();
  const dirty = new Set<string>();
  let state: SyncState = { ...EMPTY_SYNC_STATE };

  return {
    async getRecord(path) {
      return records.get(path) ?? null;
    },
    async putRecord(record) {
      records.set(record.path, record);
    },
    async deleteRecord(path) {
      records.delete(path);
    },
    async listRecords() {
      return [...records.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
    async clearRecords() {
      records.clear();
      dirty.clear();
    },
    async readState() {
      return { ...state, conflicts: [...state.conflicts], conflictPaths: { ...state.conflictPaths } };
    },
    async writeState(next) {
      state = { ...next, conflicts: [...next.conflicts], conflictPaths: { ...next.conflictPaths } };
    },
    async markDirty(path) {
      dirty.add(path);
    },
    async clearDirty(paths) {
      for (const path of paths) dirty.delete(path);
    },
    async dirtyPaths() {
      return [...dirty];
    },
  };
}

const DB_NAME = 'omnipilot-sync';
const DB_VERSION = 1;
const RECORD_STORE = 'records';
const DIRTY_STORE = 'dirty';
const STATE_KEY = 'syncState';

/**
 * IndexedDB backend for the service worker.
 *
 * One object store for records (keyed by path), one for dirty markers, and a single state row. No
 * indexes are needed: the sharded search index owns retrieval, this store owns reconciliation.
 */
export function createIndexedDbBackend(factory: IDBFactory): CacheBackend {
  let database: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (database) return database;
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECORD_STORE)) db.createObjectStore(RECORD_STORE, { keyPath: 'path' });
        if (!db.objectStoreNames.contains(DIRTY_STORE)) db.createObjectStore(DIRTY_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexeddb: open failed'));
    });
    return database;
  };

  const run = async <T>(
    store: string,
    mode: IDBTransactionMode,
    action: (objectStore: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = action(transaction.objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexeddb: request failed'));
    });
  };

  return {
    async getRecord(path) {
      try {
        return normalizeCachedRecord(await run<unknown>(RECORD_STORE, 'readonly', (s) => s.get(path)));
      } catch {
        return null;
      }
    },
    async putRecord(record) {
      await run(RECORD_STORE, 'readwrite', (s) => s.put(record) as IDBRequest<IDBValidKey>);
    },
    async deleteRecord(path) {
      await run(RECORD_STORE, 'readwrite', (s) => s.delete(path) as IDBRequest<undefined>);
    },
    async listRecords() {
      const all = await run<unknown[]>(RECORD_STORE, 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
      return all
        .map((entry) => normalizeCachedRecord(entry))
        .filter((entry): entry is CachedRecord => entry !== null)
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
    async clearRecords() {
      await run(RECORD_STORE, 'readwrite', (s) => s.clear() as IDBRequest<undefined>);
      await run(DIRTY_STORE, 'readwrite', (s) => s.clear() as IDBRequest<undefined>);
    },
    async readState() {
      try {
        return normalizeSyncState(
          await run<unknown>(DIRTY_STORE, 'readonly', (s) => s.get(STATE_KEY)),
        );
      } catch {
        return { ...EMPTY_SYNC_STATE };
      }
    },
    async writeState(state) {
      await run(DIRTY_STORE, 'readwrite', (s) => s.put(state, STATE_KEY) as IDBRequest<IDBValidKey>);
    },
    async markDirty(path) {
      await run(DIRTY_STORE, 'readwrite', (s) => s.put(true, `dirty:${path}`) as IDBRequest<IDBValidKey>);
    },
    async clearDirty(paths) {
      for (const path of paths) {
        await run(DIRTY_STORE, 'readwrite', (s) => s.delete(`dirty:${path}`) as IDBRequest<undefined>);
      }
    },
    async dirtyPaths() {
      const keys = await run<IDBValidKey[]>(DIRTY_STORE, 'readonly', (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>);
      return keys
        .map((key) => String(key))
        .filter((key) => key.startsWith('dirty:'))
        .map((key) => key.slice('dirty:'.length));
    },
  };
}

/**
 * Open the best backend available in this context.
 *
 * IndexedDB is the intended one; when it is missing (a bare test harness, or a locked-down profile)
 * we degrade to memory and report it, rather than failing the sync.
 */
export function createBestBackend(factory?: IDBFactory | null): {
  backend: CacheBackend;
  persistent: boolean;
} {
  if (factory) {
    try {
      return { backend: createIndexedDbBackend(factory), persistent: true };
    } catch {
      // fall through
    }
  }
  return { backend: createMemoryBackend(), persistent: false };
}
