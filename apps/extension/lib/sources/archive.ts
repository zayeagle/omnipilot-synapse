/**
 * Archiving a note.
 *
 * The storage API can add and overwrite but not delete, and that is deliberate: the same rule governs
 * sync, so content that stops living at a path gets a signpost instead of vanishing (core/tombstone.ts).
 * "Delete a note" therefore means: the body moves under archive/sources/, the original path keeps a
 * tombstone that says where it went, and the index and the search shards stop referring to it.
 *
 * Mirrors `planCardDecision`'s discard branch (F3) so the two speak one language.
 */

import type { CkfRecord } from '../core/ckf';
import { archivePathFor, tombstoneFor } from '../core/tombstone';
import type { IndexFile } from '../store/tier';
import { indexToFile } from '../store/tier';
import type { RepoFile } from '../store/types';
import { dropIndexItem } from '../cards/decide';

export const SOURCE_ARCHIVE_ROOT = 'archive/sources';

/** The shard operation an archive needs: drop this record's postings. */
export interface SourceArchiveShards {
  remove(record: CkfRecord, path: string): Promise<readonly RepoFile[]>;
}

export interface SourceArchivePlan {
  archivedPath: string;
  files: RepoFile[];
  index: IndexFile;
  message: string;
}

/**
 * Everything that goes into the one commit: the archived body, the tombstone, the shards it left and the
 * index without it. `content` is what the codec wrote for this record, so a vault-tier repository archives
 * ciphertext rather than leaking a plaintext body into archive/.
 */
export async function planSourceArchive(
  input: { record: CkfRecord; path: string; content: string; index: IndexFile },
  deps: { shards: SourceArchiveShards; prefix: string | null; now?: () => number },
): Promise<SourceArchivePlan> {
  const at = new Date(deps.now?.() ?? Date.now()).toISOString();
  const archivedPath = archivePathFor(SOURCE_ARCHIVE_ROOT, input.path);
  const shards = await deps.shards.remove(input.record, input.path);
  const index = dropIndexItem(input.index, input.record.id);
  const files: RepoFile[] = [
    { path: archivedPath, content: input.content },
    { path: input.path, content: tombstoneFor(archivedPath, '笔记已归档，正文仍在', at) },
    ...shards,
    indexToFile(index, deps.prefix),
  ];
  return { archivedPath, files, index, message: 'note: archive ' + input.record.id };
}
