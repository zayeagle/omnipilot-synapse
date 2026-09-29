/**
 * Turning a conflict into a decision (F4 / SC-R3-02).
 *
 * The engine already does the hard, correct part: when a note changed on both sides it keeps **both** versions,
 * the remote one at the original path and ours in a `.conflict-<stamp>` sibling. What was missing is an exit: the
 * user was left with a mysterious extra file and three buttons that only re-ran the sync. This module is that
 * exit — three honest choices, each ending in one commit (or none).
 *
 * - `keep-mine`    — our version takes the original path; the remote body is archived.
 * - `keep-remote`  — the remote version stays; our version is archived.
 * - `keep-both`    — nothing is read, moved or risked: both files stay where they are and only the conflict
 *   marker is cleared. This is also the only choice that works with a locked vault, which is why it exists as a
 *   first-class action rather than as "do nothing".
 *
 * In every case the losing version is **archived, not deleted**, and the vacated path gets a signpost naming where
 * it went — the same rule the card decision follows, so the repository reads consistently.
 */

import type { CkfRecord } from '../core/ckf';
import { indexPath as indexPathFor } from '../core/paths';
import { archivePathFor, tombstoneFor } from '../core/tombstone';
import type { ConflictAction } from '../messages';
import type { ContentCodec } from '../store/codec';
import { indexToFile, mergeIndex, type IndexFile } from '../store/tier';
import type { RepoFile } from '../store/types';

export const CONFLICT_ARCHIVE_ROOT = 'archive/conflicts';

export interface ConflictShards {
  /** Shard files for the surviving version's postings (removing the loser's, which shares the record id). */
  change(survivor: CkfRecord, loser: CkfRecord): Promise<readonly RepoFile[]>;
}

export interface ConflictDeps {
  codec: ContentCodec;
  index: IndexFile;
  /** Read the main path or the `.conflict-` sibling. */
  read(path: string): Promise<string | null>;
  shards: ConflictShards;
  prefix?: string | null;
  now?: () => number;
}

export interface ConflictPlan {
  action: ConflictAction;
  /** Everything for the one commit; empty when `commit` is false. */
  files: RepoFile[];
  index: IndexFile;
  message: string;
  /** The original path, which survives in all three actions. */
  path: string;
  archivedPath?: string;
  /** False when the action changes no repository content (`keep-both`). */
  commit: boolean;
}

/** Drop every index entry that points at `path` (the sibling's entry is keyed by a synthesised id). */
export function dropIndexItemsAtPath(index: IndexFile, path: string): IndexFile {
  const items = { ...index.items };
  let changed = false;
  for (const [key, item] of Object.entries(items)) {
    if (item.path === path) {
      delete items[key];
      changed = true;
    }
  }
  return changed ? { ...index, items } : index;
}

export async function planConflictResolution(
  input: { path: string; conflictPath: string; action: ConflictAction },
  deps: ConflictDeps,
): Promise<ConflictPlan> {
  const prefix = deps.prefix ?? null;
  const at = new Date(deps.now?.() ?? Date.now()).toISOString();

  if (input.action === 'keep-both') {
    return {
      action: 'keep-both',
      files: [],
      index: deps.index,
      message: '',
      path: input.path,
      commit: false,
    };
  }

  const mainText = await deps.read(input.path);
  const siblingText = await deps.read(input.conflictPath);
  if (mainText === null || siblingText === null) {
    throw new Error('conflict: one of the two versions is no longer in the repository');
  }
  // Both versions are the same record (same id) at different content, which is why the postings are replaced
  // rather than duplicated when one of them wins.
  const theirs = await deps.codec.decode(mainText);
  const mine = await deps.codec.decode(siblingText);

  const archivedPath = archivePathFor(CONFLICT_ARCHIVE_ROOT, input.path);
  const survivor: CkfRecord = input.action === 'keep-mine' ? mine : theirs;
  const loser: CkfRecord = input.action === 'keep-mine' ? theirs : mine;

  const files: RepoFile[] = [];
  if (input.action === 'keep-mine') {
    // Our version takes the original path — re-encoded, so the tier's encoding rules still hold.
    files.push({ path: input.path, content: await deps.codec.encode(mine) });
  }
  // The loser is copied byte-for-byte into the archive: no decode, no re-encode, no chance of mangling it.
  files.push({ path: archivedPath, content: input.action === 'keep-mine' ? mainText : siblingText });
  files.push({
    path: input.conflictPath,
    content: tombstoneFor(archivedPath, '冲突已由你决定，这一版已归档', at),
  });
  for (const shard of await deps.shards.change(survivor, loser)) files.push(shard);

  // The survivor keeps the original path, so its index entry is refreshed in place; the sibling's synthesised
  // entry goes away with the sibling.
  const withoutSibling = dropIndexItemsAtPath(deps.index, input.conflictPath);
  const index = mergeIndex(withoutSibling, [deps.codec.indexEntry(survivor, input.path)]);
  files.push(indexToFile(index, prefix));

  return {
    action: input.action,
    files,
    index,
    message: `conflict: ${input.action} ${input.path}`,
    path: input.path,
    archivedPath,
    commit: true,
  };
}
