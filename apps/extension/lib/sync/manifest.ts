/**
 * Remote-manifest diffing: what changed on the remote since we last looked?
 *
 * The repository's own `index.json` doubles as the **remote manifest** — every commit writes it, and
 * it already lists every record path with its kind, id and timestamps. That means a pull needs no
 * tree walk and no `compare` API: read the ref plus the index (two requests), diff it against the
 * local cache, and fetch only the blobs that actually moved.
 *
 * This module is pure: it turns two snapshots into the `PathChange[]` that `planMerge` consumes.
 */

import type { PathChange } from './reconcile';

/** The slice of `index.json` this module needs. The catalog format itself lives in `store/tier.ts`. */
export interface ManifestEntry {
  path: string;
  id: string;
  kind: string;
  updated_at: string;
  content_key?: string;
  url_key?: string;
}

/** The slice of a cached record this module needs. */
export interface CacheEntry {
  path: string;
  id: string;
  kind: string;
  updatedAt: string;
  /** Present when the cache kept the record's own content fingerprint. */
  contentKey?: string;
}

export interface ManifestDiff {
  /** Paths the remote added or changed since the last sync. */
  remote: PathChange[];
  /** Paths we have cached that the remote no longer lists. */
  deletedRemotely: string[];
  /** Paths present on both sides with the same version — nothing to do. */
  unchanged: string[];
}

/**
 * Compare a manifest against the cache.
 *
 * Version comparison prefers `content_key` when both sides have one: it identifies the *content*,
 * so a metadata-only touch (a rewritten `updated_at` with identical bytes) correctly reads as
 * unchanged. Without a key we fall back to `updated_at`, which is the best signal the catalog offers.
 */
export function sameVersion(remote: ManifestEntry, cached: CacheEntry): boolean {
  if (remote.content_key && cached.contentKey) {
    return remote.content_key === cached.contentKey;
  }
  return remote.updated_at === cached.updatedAt;
}

export function diffRemoteManifest(
  manifest: readonly ManifestEntry[],
  cached: readonly CacheEntry[],
): ManifestDiff {
  const cachedByPath = new Map(cached.map((entry) => [entry.path, entry]));
  const manifestPaths = new Set<string>();

  const remote: PathChange[] = [];
  const unchanged: string[] = [];

  for (const entry of manifest) {
    manifestPaths.add(entry.path);
    const previous = cachedByPath.get(entry.path);
    if (!previous) {
      remote.push({ path: entry.path, kind: 'added', ...(entry.content_key ? { key: entry.content_key } : {}) });
      continue;
    }
    if (sameVersion(entry, previous)) {
      unchanged.push(entry.path);
      continue;
    }
    remote.push({
      path: entry.path,
      kind: 'modified',
      ...(entry.content_key ? { key: entry.content_key } : {}),
    });
  }

  const deletedRemotely = cached
    .filter((entry) => !manifestPaths.has(entry.path))
    .map((entry) => entry.path);

  const byPath = (a: { path: string }, b: { path: string }): number =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

  return {
    remote: [...remote].sort(byPath),
    deletedRemotely: [...deletedRemotely].sort(),
    unchanged: [...unchanged].sort(),
  };
}

/**
 * Turn a dirty set into local `PathChange`s for `planMerge`.
 *
 * The dirty set only records *paths* (cheap to maintain on every capture), so a path is reported as
 * `modified` when the cache already had it and `added` when it did not. The engine does not need the
 * distinction — both are pushed — but `planMerge` uses it to avoid pushing a local deletion.
 */
export function localChanges(
  dirtyPaths: readonly string[],
  cached: readonly CacheEntry[],
): PathChange[] {
  const known = new Set(cached.map((entry) => entry.path));
  return dirtyPaths
    .map((path): PathChange => ({ path, kind: known.has(path) ? 'modified' : 'added' }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** True when the manifest and the cache agree — a pull would fetch nothing. */
export function manifestMatches(diff: ManifestDiff): boolean {
  return diff.remote.length === 0 && diff.deletedRemotely.length === 0;
}

/** A content-free one-line summary for the status row and the logs. */
export function describeManifestDiff(diff: ManifestDiff): string {
  return `remote=${diff.remote.length} deleted=${diff.deletedRemotely.length} unchanged=${diff.unchanged.length}`;
}
