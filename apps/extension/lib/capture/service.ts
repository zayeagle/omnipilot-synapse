/**
 * The capture pipeline: message payload → CKF record → (codec) → one atomic commit.
 *
 * Responsibilities kept here (and out of the entrypoint) so they can be tested:
 * - dedup BEFORE any write, so a repeat capture costs one index read and no commit (SC-F1-03);
 * - the 512 KB body cap and whitespace normalisation (via `normalize.ts`);
 * - offline / transient failure handling: the payload is queued instead of lost, and replayed later;
 * - no AI work: distillation is a separate, explicitly authorized step (see `distill-service.ts`).
 */

import type { CkfRecord, SourceItem } from '../core/ckf';
import type { CaptureRequestPayload } from '../messages';
import type { CaptureQueue } from '../queues';
import { dedupUrlKey } from '../store/codec';
import { isStoreError, NotFoundError, RateLimitError, ServerError, TimeoutError, NetworkError, NotConfiguredError } from '../store/errors';
import type { RepoStore } from '../store/repo-store';
import type { RepoFile } from '../store/types';
import { buildSourceItem } from './normalize';

export interface CaptureOutcome {
  item: SourceItem;
  path: string;
  commitUrl: string;
  duplicate: boolean;
  /** The capture could not be written yet and now sits in the retry queue. */
  queued: boolean;
}

export interface CaptureServiceOptions {
  store: RepoStore;
  queue: CaptureQueue;
  now?: () => number;
  /** Recent key → path cache to short-circuit an index read for a just-captured page. */
  recentLimit?: number;
  /**
   * The postings shards a record changes, computed so they can ride in the same commit (T5.7).
   *
   * Injected rather than built here: the search layer needs to read the current shards, which means
   * repository access, and this service deliberately only knows the store interface.
   */
  shards?: (record: CkfRecord) => Promise<readonly RepoFile[]>;
  /**
   * Files the repository must hold that are not part of this capture — `.omnipilot/config.json`.
   *
   * They ride in the capture's own commit, so recording the store's tier never costs a second
   * commit and a failed capture cannot leave a half-configured store behind.
   */
  bootstrap?: () => Promise<readonly RepoFile[]>;
}

/** Errors worth retrying later rather than surfacing as a hard failure. */
export function isTransientStoreError(error: unknown): boolean {
  if (!isStoreError(error)) return false;
  return (
    error instanceof NetworkError ||
    error instanceof TimeoutError ||
    error instanceof RateLimitError ||
    error instanceof ServerError
  );
}

/**
 * Bodies shorter than this are not used for content-based dedup.
 *
 * Without the floor, two unrelated title-only captures (both with an empty body) would share the
 * fingerprint of "" and the second would be silently reported as a duplicate of the first. A short
 * body carries too little signal to justify that risk; the canonical URL is still compared.
 */
export const MIN_CONTENT_DEDUP_CHARS = 200;

export function dedupContentKey(item: SourceItem): string {
  return item.body.trim().length >= MIN_CONTENT_DEDUP_CHARS ? item.content_hash : '';
}

export class CaptureService {
  private readonly store: RepoStore;
  private readonly queue: CaptureQueue;
  private readonly now: () => number;
  private readonly recentLimit: number;
  private readonly shards?: (record: CkfRecord) => Promise<readonly RepoFile[]>;
  private readonly bootstrap?: () => Promise<readonly RepoFile[]>;

  constructor(options: CaptureServiceOptions) {
    this.store = options.store;
    this.queue = options.queue;
    this.now = options.now ?? Date.now;
    this.recentLimit = options.recentLimit ?? 20;
    if (options.shards) this.shards = options.shards;
    if (options.bootstrap) this.bootstrap = options.bootstrap;
  }

  /**
   * Shards are best-effort: the index is derived data that `search.rebuild` can regenerate, while the
   * note the user just captured is not. A failing shard read must not turn a capture into a failure.
   */
  private async shardsFor(record: CkfRecord): Promise<readonly RepoFile[]> {
    if (!this.shards) return [];
    try {
      return await this.shards(record);
    } catch {
      return [];
    }
  }

  /**
   * Best-effort for the same reason the shards are: the note the user just captured is the thing
   * that must not fail. A store whose tier could not be read keeps working from the settings.
   */
  private async bootstrapFiles(): Promise<readonly RepoFile[]> {
    if (!this.bootstrap) return [];
    try {
      return await this.bootstrap();
    } catch {
      return [];
    }
  }

  /**
   * Convert a validated message payload into a CKF record.
   *
   * `title` is never empty in practice (the content script falls back to the first line of the
   * selection); when it is, the URL stands in so the record stays identifiable.
   */
  buildItem(payload: CaptureRequestPayload): SourceItem {
    const isSelection = payload.mode === 'selection';
    const isNote = payload.mode === 'note';
    const text = payload.mode === 'page' ? (payload.body ?? '') : (payload.selection ?? '');
    const capturedAt = payload.capturedAt ? new Date(payload.capturedAt) : new Date(this.now());
    // A NOTE is the user's own text: titled after its first line, and never an excerpt of a URL. A
    // SELECTION is an excerpt, so it keeps the page it came from. A page keeps the URL fallback.
    const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
    const fallbackTitle = isNote && firstLine.length > 0 ? firstLine : payload.url;

    return buildSourceItem({
      url: payload.url,
      title: payload.title || fallbackTitle,
      text,
      ...(payload.byline ? { byline: payload.byline } : {}),
      ...(payload.lang ? { lang: payload.lang } : {}),
      channel: 'extension',
      ...(isSelection ? { excerptOf: payload.url } : {}),
      capturedAt: Number.isNaN(capturedAt.getTime()) ? new Date(this.now()) : capturedAt,
    });
  }

  /**
   * Write a capture, or report that it is already in the Inbox.
   *
   * A transient failure queues the payload and returns `queued: true` — the user is told "later"
   * rather than "failed", which is what the requirements ask for ("稍后处理 不阻塞捕获").
   */
  async capture(payload: CaptureRequestPayload): Promise<CaptureOutcome> {
    const item = this.buildItem(payload);
    // Must match how the active codec derives the index key, otherwise dedup silently stops working
    // in vault mode (the index holds a fingerprint there, not the canonical URL).
    const key = dedupUrlKey(item.url, this.store.contentCodec.mode);

    let index;
    try {
      index = await this.store.readIndex();
    } catch (error) {
      if (isTransientStoreError(error)) return this.enqueue(payload, item);
      throw error;
    }

    const existing = await this.store.findExisting(key, dedupContentKey(item), index);
    if (existing) {
      return {
        item,
        path: existing.path,
        commitUrl: this.store.fileUrl(existing.path),
        duplicate: true,
        queued: false,
      };
    }

    try {
      const extraFiles = [...(await this.shardsFor(item)), ...(await this.bootstrapFiles())];
      const committed = await this.store.commitRecord(item, {
        index,
        ...(extraFiles.length > 0 ? { extraFiles } : {}),
      });
      return {
        item,
        path: committed.path,
        commitUrl: committed.commit.htmlUrl,
        duplicate: false,
        queued: false,
      };
    } catch (error) {
      if (isTransientStoreError(error)) return this.enqueue(payload, item);
      throw error;
    }
  }

  private async enqueue(payload: CaptureRequestPayload, item: SourceItem): Promise<CaptureOutcome> {
    await this.queue.enqueue(payload);
    return {
      item,
      path: '',
      commitUrl: '',
      duplicate: false,
      queued: true,
    };
  }

  /**
   * Replay queued captures.
   *
   * Stops at the first transient failure: if the network is still down, hammering GitHub would only
   * burn rate limit and add noise. Entries that fail permanently are dropped after their attempt is
   * recorded, so a broken URL cannot loop forever.
   */
  async flushQueue(maxAttempts = 5): Promise<{ flushed: number; remaining: number }> {
    const pending = await this.queue.retryable(maxAttempts);
    let flushed = 0;

    for (const entry of pending) {
      try {
        const outcome = await this.capture(entry.payload);
        // `capture` re-queues on a transient failure; a successful or duplicate result clears it.
        if (!outcome.queued) {
          await this.queue.remove(entry.id);
          flushed += 1;
        } else {
          await this.queue.markAttempt(entry.id, 'transient');
          break;
        }
      } catch (error) {
        await this.queue.markAttempt(entry.id, error instanceof Error ? error.message : 'error');
        if (isTransientStoreError(error)) break;
      }
    }

    return { flushed, remaining: await this.queue.size() };
  }
}

/** Storage not configured yet — the UI shows 引导 rather than an opaque failure. */
export function isNotConfigured(error: unknown): boolean {
  return error instanceof NotConfiguredError;
}

export { NotFoundError };
