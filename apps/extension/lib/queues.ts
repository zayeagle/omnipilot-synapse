/**
 * Two durable queues, both content-conscious.
 *
 * - `CaptureQueue` — captures that could not be written yet (offline, locked vault, GitHub down).
 *   Keeping them means "稍后处理" never loses a capture; the body is already the user's own text and
 *   is bounded by the message limits.
 * - `AiLedger` — the audit trail required by §6.2 "AI 外发最小权限 / 账本". It stores identifiers,
 *   provider, model and the outcome — never the prompt and never the content.
 */

import { urlKey } from './core/dedup';
import type { CaptureRequestPayload, ErrorCode } from './messages';
import { STORAGE_KEYS, type StorageAreaLike } from './settings-store';

import type { Sealer } from './security/sealer';

export const MAX_QUEUE_ENTRIES = 50;
export const MAX_QUEUE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_LEDGER_ENTRIES = 500;

/** Fields every queued entry has, stored or usable. */
interface QueuedBase {
  id: string;
  url_key: string;
  attempts: number;
  queued_at: string;
  last_error?: string;
}

/** A queued capture as a caller sees it: the payload is always readable. */
export interface QueuedCapture extends QueuedBase {
  payload: CaptureRequestPayload;
}

/** A queued capture as storage holds it when a sealer exists: the payload is ciphertext. */
export interface StoredQueuedCapture extends QueuedBase {
  sealed: string;
}

/**
 * What actually sits in `chrome.storage.local`: one arm or the other. The split exists so sealing stays
 * an implementation detail of storage — everything above `CaptureQueue` still sees a required payload.
 */
export type StoredQueued = QueuedCapture | StoredQueuedCapture;

export interface LedgerEntry {
  source_id: string;
  provider: string;
  model: string;
  purpose: 'distill';
  ok: boolean;
  at: string;
  error_code?: ErrorCode;
}

function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}

  /** The metadata half of an entry, copied without the payload arm. */
function base(entry: StoredQueued): QueuedBase {
  return {
    id: entry.id,
    url_key: entry.url_key,
    attempts: entry.attempts,
    queued_at: entry.queued_at,
    ...(entry.last_error !== undefined ? { last_error: entry.last_error } : {}),
  };
}

function makeQueueId(now: () => number): string {
  return `q${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class CaptureQueue {
  private readonly area: StorageAreaLike;
  private readonly now: () => number;
  /**
   * Optional: a queue without one stores the payload as-is (tests, or a profile with no vault). With
   * one, what lands in browser storage is ciphertext — a capture that could not be written yet must not
   * become a plaintext copy of the page sitting in the profile.
   */
  private readonly sealer?: Sealer;

  constructor(area: StorageAreaLike, now: () => number = Date.now, sealer?: Sealer) {
    this.area = area;
    this.now = now;
    if (sealer) this.sealer = sealer;
  }

  /** Every stored entry, pruned — without trying to open any payload. */
  private async rawEntries(): Promise<StoredQueued[]> {
    const stored = await this.area.get(STORAGE_KEYS.captureQueue);
    const raw = stored[STORAGE_KEYS.captureQueue];
    return Array.isArray(raw) ? this.prune(raw as StoredQueued[]) : [];
  }

  private async read(): Promise<QueuedCapture[]> {
    const opened: QueuedCapture[] = [];
    for (const entry of await this.rawEntries()) {
      const payload = await this.openPayload(entry);
      // An entry that cannot be opened right now (the vault is locked) stays on disk rather than being
      // dropped: it is still the user's capture, and it becomes replayable the moment they unlock.
      if (payload) opened.push({ ...base(entry), payload });
    }
    return opened;
  }

  /** The payload of one entry, opened with the session key when it was sealed. */
  private async openPayload(entry: StoredQueued): Promise<CaptureRequestPayload | null> {
    if ('payload' in entry) return entry.payload;
    if (!this.sealer) return null;
    try {
      return JSON.parse(await this.sealer.open(entry.sealed)) as CaptureRequestPayload;
    } catch {
      return null;
    }
  }

  /** Drop entries that are too old to be worth replaying. */
  private prune(entries: StoredQueued[]): StoredQueued[] {
    const cutoff = this.now() - MAX_QUEUE_AGE_MS;
    return entries.filter((entry) => {
      const at = Date.parse(entry.queued_at);
      return Number.isFinite(at) ? at >= cutoff : true;
    });
  }

  private async write(entries: StoredQueued[]): Promise<void> {
    await this.area.set({
      [STORAGE_KEYS.captureQueue]: entries.slice(-MAX_QUEUE_ENTRIES),
    });
  }

  /** Queue a capture. Re-queuing the same URL replaces the previous attempt instead of duplicating. */
  async enqueue(payload: CaptureRequestPayload): Promise<QueuedCapture> {
    const entries = await this.rawEntries();
    const key = urlKey(payload.url);
    const existingIndex = entries.findIndex((entry) => entry.url_key === key);
    const id = existingIndex >= 0 ? (entries[existingIndex]?.id ?? makeQueueId(this.now)) : makeQueueId(this.now);
    const attempts = existingIndex >= 0 ? (entries[existingIndex]?.attempts ?? 0) : 0;
    const queuedAt = isoNow(this.now);
    // Sealed when a vault exists: a capture that could not be written yet must not become a plaintext
    // copy of the page sitting in browser storage.
    const stored: StoredQueued = this.sealer
      ? { id, url_key: key, attempts, queued_at: queuedAt, sealed: await this.sealer.seal(JSON.stringify(payload)) }
      : { id, url_key: key, attempts, queued_at: queuedAt, payload };
    if (existingIndex >= 0) {
      entries[existingIndex] = stored;
    } else {
      entries.push(stored);
    }
    await this.write(entries);
    // The caller gets the usable form; only storage ever saw the sealed one.
    return { id, url_key: key, attempts, queued_at: queuedAt, payload };
  }

  async list(): Promise<QueuedCapture[]> {
    return this.read();
  }

  /** The count of QUEUED captures, readable or not: a locked vault must not look like an empty queue. */
  async size(): Promise<number> {
    return (await this.rawEntries()).length;
  }

  async remove(id: string): Promise<void> {
    const entries = (await this.read()).filter((entry) => entry.id !== id);
    await this.write(entries);
  }

  async markAttempt(id: string, error?: string): Promise<void> {
    const entries = await this.read();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const entry = entries[index] as StoredQueued;
    entry.attempts += 1;
    if (error !== undefined) entry.last_error = error;
    await this.write(entries);
  }

  /** Entries still worth retrying — bounded attempts so a permanently broken URL stops looping. */
  async retryable(maxAttempts = 5): Promise<QueuedCapture[]> {
    return (await this.read()).filter((entry) => entry.attempts < maxAttempts);
  }

  async clear(): Promise<void> {
    await this.area.remove(STORAGE_KEYS.captureQueue);
  }
}

export class AiLedger {
  private readonly area: StorageAreaLike;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(area: StorageAreaLike, now: () => number = Date.now, maxEntries = MAX_LEDGER_ENTRIES) {
    this.area = area;
    this.now = now;
    this.maxEntries = maxEntries;
  }

  private async read(): Promise<LedgerEntry[]> {
    const stored = await this.area.get(STORAGE_KEYS.aiLedger);
    const raw = stored[STORAGE_KEYS.aiLedger];
    return Array.isArray(raw) ? (raw as LedgerEntry[]) : [];
  }

  async append(entry: Omit<LedgerEntry, 'at' | 'purpose'> & { at?: string }): Promise<LedgerEntry> {
    const full: LedgerEntry = {
      source_id: entry.source_id,
      provider: entry.provider,
      model: entry.model,
      purpose: 'distill',
      ok: entry.ok,
      at: entry.at ?? isoNow(this.now),
    };
    if (entry.error_code !== undefined) full.error_code = entry.error_code;
    const entries = await this.read();
    entries.push(full);
    await this.area.set({
      [STORAGE_KEYS.aiLedger]: entries.slice(-this.maxEntries),
    });
    return full;
  }

  async list(limit = 50): Promise<LedgerEntry[]> {
    const entries = await this.read();
    return entries.slice(-Math.max(1, limit)).reverse();
  }

  /** Newest first, filtered to successful sends. Drives the per-item authorization gate. */
  async has(sourceId: string): Promise<boolean> {
    const entries = await this.read();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i] as LedgerEntry;
      if (entry.source_id === sourceId) return entry.ok;
    }
    return false;
  }

  async size(): Promise<number> {
    return (await this.read()).length;
  }

  async clear(): Promise<void> {
    await this.area.remove(STORAGE_KEYS.aiLedger);
  }
}
