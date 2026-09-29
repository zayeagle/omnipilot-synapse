/**
 * The decision surface for an AI proposal (F3 / SC-R3-01).
 *
 * Before this module a distilled card was written to `cards/pending/` and then… nothing: no way to see it in the
 * product, no way to decide about it. The AI had "produced" something and the collaboration had not actually
 * happened (criteria W2/W3, E2/E5).
 *
 * Three decisions, and the rules they share:
 * 1. **accept** — the card becomes a confirmed note at its confirmed path; its postings move with it.
 * 2. **edit**   — the human rewrites title/summary/points/tags; the AI's text is corrected, not replaced.
 * 3. **discard** — the card is **archived**, never deleted, and stops being indexed.
 *
 * Two constraints shape the implementation:
 * - **Nothing is destroyed.** The storage API can add and overwrite but not delete, and that is a feature (the same
 *   rule already governs sync: a remote deletion resurrects rather than drops). So a path that stops being the live
 *   location gets a small, human-readable **tombstone** naming where the content went — a reader of the repository
 *   finds a signpost instead of a mystery.
 * - **One commit.** The card, the manifest and the affected search shards travel together, so a reader can never
 *   observe a card that is confirmed in the index but pending on disk (or the other way round).
 */

import type { KnowledgeCard } from '../core/ckf';
import { archivePathFor as sharedArchivePath, tombstoneFor } from '../core/tombstone';
import { indexPath as indexPathFor } from '../core/paths';
import type { CardDecisionAction, CardPatch } from '../messages';
import type { ContentCodec } from '../store/codec';
import { indexToFile, mergeIndex, type IndexFile } from '../store/tier';
import type { RepoFile } from '../store/types';

export { TOMBSTONE_MARKER, isTombstone, tombstoneFor } from '../core/tombstone';

export const ARCHIVE_ROOT = 'archive/cards';

/** Where a displaced card body goes. Keeps the original path so the archive reads like a tree, not a pile. */
export function archivePathFor(path: string): string {
  return sharedArchivePath(ARCHIVE_ROOT, path);
}

/** Remove one index entry (by id) without touching anything else. */
export function dropIndexItem(index: IndexFile, id: string): IndexFile {
  if (index.items[id] === undefined) return index;
  const items = { ...index.items };
  delete items[id];
  return { ...index, items };
}

/** Only the four whitelisted fields; everything else about a card is identity, not content. */
export function applyCardPatch(card: KnowledgeCard, patch: CardPatch): KnowledgeCard {
  const next: KnowledgeCard = { ...card };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.summary !== undefined) next.summary = patch.summary;
  if (patch.points !== undefined) next.points = [...patch.points];
  if (patch.tags !== undefined) next.tags = [...patch.tags];
  return next;
}

export interface CardDecisionShards {
  /** Shard files for the card's new postings. */
  change(card: KnowledgeCard, previous?: KnowledgeCard): Promise<readonly RepoFile[]>;
  /** Shard files that remove the card's postings (discard). */
  remove(card: KnowledgeCard, path: string): Promise<readonly RepoFile[]>;
}

export interface CardDecisionDeps {
  codec: ContentCodec;
  index: IndexFile;
  shards: CardDecisionShards;
  prefix?: string | null;
  now?: () => number;
}

export interface CardDecisionPlan {
  action: CardDecisionAction;
  /** The surviving card (null when discarded). */
  card: KnowledgeCard | null;
  /** Repository path of the surviving card ('' when discarded). */
  path: string;
  /** Where the card lived before the decision. */
  previousPath: string;
  /** Set when the body was archived (discard). */
  archivedPath?: string;
  /** Everything that goes into the one commit, manifest included. */
  files: RepoFile[];
  /** The manifest after the decision. */
  index: IndexFile;
  message: string;
}

export async function planCardDecision(
  input: { card: KnowledgeCard; path: string; action: CardDecisionAction; patch?: CardPatch },
  deps: CardDecisionDeps,
): Promise<CardDecisionPlan> {
  const at = new Date(deps.now?.() ?? Date.now()).toISOString();
  const prefix = deps.prefix ?? null;

  if (input.action === 'discard') {
    const archivedPath = archivePathFor(input.path);
    const shards = await deps.shards.remove(input.card, input.path);
    const index = dropIndexItem(deps.index, input.card.id);
    const files: RepoFile[] = [
      { path: archivedPath, content: await deps.codec.encode(input.card) },
      { path: input.path, content: tombstoneFor(archivedPath, '提案被丢弃，正文已归档', at) },
      ...shards,
      indexToFile(index, prefix),
    ];
    return {
      action: 'discard',
      card: null,
      path: '',
      previousPath: input.path,
      archivedPath,
      files,
      index,
      message: 'card: discard ' + input.card.id,
    };
  }

  const next: KnowledgeCard =
    input.action === 'edit'
      ? applyCardPatch(input.card, input.patch ?? {})
      : { ...input.card, status: 'confirmed' };

  const encoded = await deps.codec.encodeRecord(next, prefix);
  const shards = await deps.shards.change(next, input.card);
  const index = mergeIndex(deps.index, [encoded.index]);
  const files: RepoFile[] = [
    { path: encoded.path, content: encoded.content },
    ...shards,
    indexToFile(index, prefix),
  ];
  // The card changed address (confirmed cards, and edits that changed the title) — signpost the old one.
  if (encoded.path !== input.path) {
    const reason = input.action === 'accept' ? '提案已确认，正文在新位置' : '标题被改写，正文在新位置';
    files.push({ path: input.path, content: tombstoneFor(encoded.path, reason, at) });
  }

  return {
    action: input.action,
    card: next,
    path: encoded.path,
    previousPath: input.path,
    files,
    index,
    message: 'card: ' + input.action + ' ' + next.id,
  };
}
