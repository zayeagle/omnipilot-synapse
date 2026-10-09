/**
 * Deleting a note for good.
 *
 * The archive path (sources/archive.ts) moves a body and leaves a signpost; this one removes the file from
 * the repository in the same commit that drops it from the index and the search shards. That is
 * irreversible, so it is a separate, explicitly confirmed action - never a side effect of the other.
 *
 * The deletion itself is a transport capability: the REST store removes the path from the tree, while the
 * SSH companion can only add or overwrite and says so rather than pretending.
 */

import type { CkfRecord } from '../core/ckf';
import { dropIndexItem } from '../cards/decide';
import type { IndexFile } from '../store/tier';
import { indexToFile } from '../store/tier';
import type { RepoFile } from '../store/types';

/** The shard operation a delete needs: drop this record's postings. */
export interface SourceDeleteShards {
  remove(record: CkfRecord, path: string): Promise<readonly RepoFile[]>;
}

export interface SourceDeletePlan {
  files: RepoFile[];
  index: IndexFile;
  /** The path removed from the repository in the same commit. */
  deleted: string[];
  message: string;
}

export async function planSourceDelete(
  input: { record: CkfRecord; path: string; index: IndexFile },
  deps: { shards: SourceDeleteShards; prefix: string | null },
): Promise<SourceDeletePlan> {
  const shards = await deps.shards.remove(input.record, input.path);
  const index = dropIndexItem(input.index, input.record.id);
  return {
    files: [...shards, indexToFile(index, deps.prefix)],
    index,
    deleted: [input.path],
    message: 'note: delete ' + input.record.id,
  };
}
