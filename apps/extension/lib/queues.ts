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

export const MAX_QUEUE_ENTRIES = 50;
export const MAX_QUEUE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_LEDGER_ENTRIES = 500;

export interface QueuedCapture {
  id: string;
  url_key: string;
  payload: CaptureRequestPayload;
  attempts: number;
  queued_at: string;
  last_error?: string;
}

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

function makeQueueId(now: () => number): string {
  return `q${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class CaptureQueue {
  private readonly area: StorageAreaLike;
  private readonly now: () => number;

  constructor(area: StorageAreaLike, now: () => number = Date.now) {
    this.area = area;
    this.now = now;
  }

  private async read(): Promise<QueuedCapture[]> {
    const stored = await this.area.get(STORAGE_KEYS.captureQueue);
    const raw = stored[STORAGE_KEYS.captureQueue];
    if (!Array.isArray(raw)) return [];
    return this.prune(raw as QueuedCapture[]);
  }

  /** Drop entries that are too old to be worth replaying. */
  private prune(entries: QueuedCapture[]): QueuedCapture[] {
    const cutoff = this.now() - MAX_QUEUE_AGE_MS;
    return entries.filter((entry) => {
      const at = Date.parse(entry.queued_at);
      return Number.isFinite(at) ? at >= cutoff : true;
    });
  }

  private async write(entries: QueuedCapture[]): Promise<void> {
    await this.area.set({
      [STORAGE_KEYS.captureQueue]: entries.slice(-MAX_QUEUE_ENTRIES),
    });
  }

  /** Queue a capture. Re-queuing the same URL replaces the previous attempt instead of duplicating. */
  async enqueue(payload: CaptureRequestPayload): Promise<QueuedCapture> {
    const entries = await this.read();
    const key = urlKey(payload.url);
    const existingIndex = entries.findIndex((entry) => entry.url_key === key);
    const entry: QueuedCapture = {
      id: existingIndex >= 0 ? (entries[existingIndex]?.id ?? makeQueueId(this.now)) : makeQueueId(this.now),
      url_key: key,
      payload,
      attempts: 0,
      queued_at: isoNow(this.now),
    };
    if (entry.attempts === 0 && existingIndex >= 0) entry.attempts = entries[existingIndex]?.attempts ?? 0;
    if (existingIndex >= 0) {
      entries[existingIndex] = entry;
    } else {
      entries.push(entry);
    }
    await this.write(entries);
    return entry;
  }

  async list(): Promise<QueuedCapture[]> {
    return this.read();
  }

  async size(): Promise<number> {
    return (await this.read()).length;
  }

  async remove(id: string): Promise<void> {
    const entries = (await this.read()).filter((entry) => entry.id !== id);
    await this.write(entries);
  }

  async markAttempt(id: string, error?: string): Promise<void> {
    const entries = await this.read();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const entry = entries[index] as QueuedCapture;
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
