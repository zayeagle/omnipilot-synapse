import { describe, expect, it } from 'vitest';

import { createHandlers, type BackgroundContext } from './handlers';
import { MessageRouter, createRouterOptions } from './router';
import { SyncCache, createMemoryBackend } from '../sync/cache';
import { AiLedger, CaptureQueue } from '../queues';
import { MIN_ITERATIONS } from '../security/crypto-key';
import { KeySession, MemorySessionKeyStore } from '../security/key-session';
import { MemoryStorageArea, STORAGE_KEYS, SettingsStore } from '../settings-store';
import { normalizePublicPrefs } from '../public-prefs';

const PAT = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop';
const PASSPHRASE = 'correct horse battery';
const FIXED_NOW = Date.parse('2026-07-09T00:00:00.000Z');
const OPTIONS_SENDER = { url: 'chrome-extension://abcdefghijklmnop/options.html' };

/**
 * TC-F18-I01/I02 — the capture switch at the seam the page actually reads.
 *
 * The content script never reads the settings: it decides whether to offer the selection bubble from
 * `local:publicPrefs`, the content-script-safe projection. So the switch only works if **every** write of
 * the switch also republishes that projection. This pins the write half — the worker's toggle must leave
 * the projection saying exactly what was stored, off stays off and on stays on — which is the seam the
 * three earlier switch fixes kept missing.
 *
 * The read half (the bubble gate itself) is pinned with it: "开启就支持，不开启就关闭" is only true when
 * both halves hold.
 */
describe('the capture switch reaches the projection (F18 INT)', () => {
  async function worker(): Promise<{
    send: (type: string, payload?: unknown) => Promise<{ ok: boolean }>;
    area: MemoryStorageArea;
  }> {
    const area = new MemoryStorageArea();
    const session = new KeySession({
      store: new MemorySessionKeyStore(),
      now: () => FIXED_NOW,
      ttlMs: 60 * 60 * 1000,
    });
    const settings = new SettingsStore({ area, session, iterations: MIN_ITERATIONS, now: () => FIXED_NOW });
    const context: BackgroundContext = {
      syncCache: new SyncCache(createMemoryBackend()),
      settings,
      queue: new CaptureQueue(area, () => FIXED_NOW),
      ledger: new AiLedger(area, () => FIXED_NOW),
      session,
      fetchImpl: async () => new Response('{}', { status: 200 }),
      now: () => FIXED_NOW,
      activeTab: async () => ({ id: 42, url: 'https://example.com/article' }),
      pageClip: async () => true,
    };
    const router = new MessageRouter(
      createRouterOptions(createHandlers(context), { secrets: async () => [] }),
    );
    return {
      send: (type, payload) =>
        router.handle({ type, payload }, OPTIONS_SENDER as never) as Promise<{ ok: boolean }>,
      area,
    };
  }

  /** What a content script would read back from the projection. */
  async function projectedSwitch(area: MemoryStorageArea): Promise<boolean | undefined> {
    const stored = await area.get(STORAGE_KEYS.publicPrefs);
    return normalizePublicPrefs(stored[STORAGE_KEYS.publicPrefs]).enabled;
  }

  it('TC-F18-I01 switching capture off leaves the projection saying off', async () => {
    const w = await worker();
    await w.send('vault.setup', { passphrase: PASSPHRASE });
    await w.send('settings.github', {
      owner: 'zayeagle',
      repo: 'omnipilot-synapse',
      branch: 'main',
      pat: PAT,
    });

    const off = await w.send('settings.security', { enabled: false });
    expect(off.ok).toBe(true);
    expect(await projectedSwitch(w.area)).toBe(false);

    // And it comes back on, through the same projection.
    const on = await w.send('settings.security', { enabled: true });
    expect(on.ok).toBe(true);
    expect(await projectedSwitch(w.area)).toBe(true);
  });

  it('TC-F18-I02 a capture is refused while the switch is off', async () => {
    const w = await worker();
    await w.send('vault.setup', { passphrase: PASSPHRASE });
    await w.send('settings.github', {
      owner: 'zayeagle',
      repo: 'omnipilot-synapse',
      branch: 'main',
      pat: PAT,
    });
    await w.send('settings.security', { enabled: false });

    const refused = (await w.send('capture.request', {
      mode: 'note',
      url: 'https://example.com/note',
      title: 'no capture while off',
      selection: 'this must not be written',
    })) as { ok: boolean; code?: string };
    // The worker is the gate that cannot be bypassed: a refusal here is what makes "不开启就关闭"
    // true even for a content script that never learned about the switch.
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('disabled');
    expect(await projectedSwitch(w.area)).toBe(false);
  });
});
