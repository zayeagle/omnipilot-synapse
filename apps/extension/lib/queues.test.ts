import { describe, expect, it } from 'vitest';

import type { CaptureRequestPayload } from './messages';
import {
  AiLedger,
  CaptureQueue,
  MAX_LEDGER_ENTRIES,
  MAX_QUEUE_AGE_MS,
  MAX_QUEUE_ENTRIES,
} from './queues';
import { MemoryStorageArea, STORAGE_KEYS } from './settings-store';

function capture(url: string, mode: CaptureRequestPayload['mode'] = 'page'): CaptureRequestPayload {
  return { mode, url, title: `Title ${url}`, body: 'body' };
}

describe('CaptureQueue', () => {
  it('TC-F1-U05 requeues the same URL instead of duplicating it', async () => {
    let clock = 1_000;
    const area = new MemoryStorageArea();
    const queue = new CaptureQueue(area, () => clock);

    const first = await queue.enqueue(capture('https://example.com/a?utm_source=x'));
    clock += 500;
    const second = await queue.enqueue(capture('https://www.example.com/a/'));

    expect(await queue.size()).toBe(1);
    expect(second.id).toBe(first.id);
    expect(second.url_key).toBe(first.url_key);
  });

  it('TC-F1-U05 tracks attempts and only retries within the attempt budget', async () => {
    const queue = new CaptureQueue(new MemoryStorageArea(), () => 0);
    const entry = await queue.enqueue(capture('https://example.com/a'));

    await queue.markAttempt(entry.id, 'offline');
    await queue.markAttempt(entry.id);
    expect((await queue.list())[0]).toMatchObject({ attempts: 2, last_error: 'offline' });

    const retryable = await queue.retryable(2);
    expect(retryable).toHaveLength(0);
    expect(await queue.retryable(3)).toHaveLength(1);

    await queue.markAttempt('does-not-exist');
    expect(await queue.size()).toBe(1);
  });

  it('TC-F1-U05 drops entries older than the queue age', async () => {
    let clock = 0;
    const area = new MemoryStorageArea();
    const queue = new CaptureQueue(area, () => clock);
    await queue.enqueue(capture('https://example.com/old'));

    clock = MAX_QUEUE_AGE_MS + 1;
    expect(await queue.size()).toBe(0);
  });

  it('TC-F1-U05 caps the queue length, keeping the newest entries', async () => {
    const queue = new CaptureQueue(new MemoryStorageArea(), () => 0);
    for (let i = 0; i < MAX_QUEUE_ENTRIES + 5; i += 1) {
      await queue.enqueue(capture(`https://example.com/${i}`));
    }
    const entries = await queue.list();
    expect(entries).toHaveLength(MAX_QUEUE_ENTRIES);
    expect(entries.at(-1)?.payload.url).toBe(`https://example.com/${MAX_QUEUE_ENTRIES + 4}`);
  });

  it('TC-F1-U05 removes a single entry and clears the queue', async () => {
    const area = new MemoryStorageArea();
    const queue = new CaptureQueue(area, () => 0);
    const a = await queue.enqueue(capture('https://example.com/a'));
    await queue.enqueue(capture('https://example.com/b'));

    await queue.remove(a.id);
    expect((await queue.list()).map((entry) => entry.payload.url)).toEqual(['https://example.com/b']);

    await queue.clear();
    expect(await queue.size()).toBe(0);
    expect((await area.get(STORAGE_KEYS.captureQueue))[STORAGE_KEYS.captureQueue]).toBeUndefined();
  });

  it('TC-F1-U05 ignores a corrupted queue value', async () => {
    const area = new MemoryStorageArea({ [STORAGE_KEYS.captureQueue]: 'not an array' });
    const queue = new CaptureQueue(area, () => 0);
    expect(await queue.list()).toEqual([]);
    expect(await queue.enqueue(capture('https://example.com/a'))).toMatchObject({ attempts: 0 });
  });
});

describe('AiLedger', () => {
  it('TC-F7-U05 records ids, provider and outcome but never content', async () => {
    const area = new MemoryStorageArea();
    const ledger = new AiLedger(area, () => 1_000_000);
    await ledger.append({ source_id: 's1', provider: 'deepseek', model: 'deepseek-chat', ok: true });
    await ledger.append({
      source_id: 's2',
      provider: 'openai',
      model: 'gpt-4o-mini',
      ok: false,
      error_code: 'timeout',
    });

    const stored = await area.get(STORAGE_KEYS.aiLedger);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('body');
    expect(serialized).not.toContain('prompt');

    const entries = await ledger.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      source_id: 's2',
      provider: 'openai',
      purpose: 'distill',
      ok: false,
      error_code: 'timeout',
      at: new Date(1_000_000).toISOString(),
    });
  });

  it('TC-F7-U05 reports per-item authorization from the newest entry', async () => {
    let clock = 0;
    const ledger = new AiLedger(new MemoryStorageArea(), () => clock);
    expect(await ledger.has('s1')).toBe(false);

    await ledger.append({ source_id: 's1', provider: 'p', model: 'm', ok: true });
    expect(await ledger.has('s1')).toBe(true);

    clock += 1;
    await ledger.append({ source_id: 's1', provider: 'p', model: 'm', ok: false });
    // The newest outcome wins, so a later failure means the item must be authorized again.
    expect(await ledger.has('s1')).toBe(false);
  });

  it('TC-F7-U05 caps the ledger and supports clearing', async () => {
    const area = new MemoryStorageArea();
    const ledger = new AiLedger(area, () => 0, 5);
    for (let i = 0; i < 12; i += 1) {
      await ledger.append({ source_id: `s${i}`, provider: 'p', model: 'm', ok: true });
    }
    expect(await ledger.size()).toBe(5);
    expect((await ledger.list(2)).map((entry) => entry.source_id)).toEqual(['s11', 's10']);

    await ledger.clear();
    expect(await ledger.size()).toBe(0);
    expect(MAX_LEDGER_ENTRIES).toBe(500);
  });

  it('TC-F7-U05 tolerates a corrupted ledger value', async () => {
    const area = new MemoryStorageArea({ [STORAGE_KEYS.aiLedger]: { nope: true } });
    const ledger = new AiLedger(area, () => 0);
    expect(await ledger.list()).toEqual([]);
    expect(await ledger.has('s1')).toBe(false);
  });
});
