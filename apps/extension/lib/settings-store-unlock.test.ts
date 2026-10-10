import { describe, expect, it } from 'vitest';

import { MIN_ITERATIONS } from './security/crypto-key';
import { MemoryStorageArea, STORAGE_KEYS, SettingsStore } from './settings-store';

/**
 * The unlock policy is a security setting, so its defaults matter more than its features.
 *
 * Pinned here: an install that never answered the question is REMEMBER (the owner's default, disclosed
 * on the Security page), an explicit choice always wins, and leaving remember mode drops the key rather
 * than keeping a way back in.
 */
describe('unlock policy (R8 UNIT)', () => {
  // A6: the default moved from `remember` to `keyless` on the owner's instruction (no passphrase at all).
  it('TC-R8-U04 defaults to keyless, and keeps the policy next to the key it authorizes', async () => {
    const store = new SettingsStore({ area: new MemoryStorageArea(), now: () => 0, iterations: 1 });
    expect(await store.getUnlockPolicy()).toBe('keyless');

    await store.setUnlockPolicy('strict');
    expect(await store.getUnlockPolicy()).toBe('strict');

    // An explicit choice always wins over the default.
    await store.setUnlockPolicy('remember');
    expect(await store.getUnlockPolicy()).toBe('remember');
  });

  it('TC-R8-U05 leaving remember mode drops the key, and restores nothing without a session', async () => {
    const area = new MemoryStorageArea({
      [STORAGE_KEYS.unlockPolicy]: { policy: 'remember', key: 'AAAA' },
    });
    const store = new SettingsStore({ area, now: () => 0, iterations: 1 });
    expect(await store.getUnlockPolicy()).toBe('remember');

    await store.setUnlockPolicy('strict');
    const stored = await area.get(STORAGE_KEYS.unlockPolicy);
    expect(stored[STORAGE_KEYS.unlockPolicy]).toEqual({ policy: 'strict' });
    expect(await store.restoreRememberedKey()).toBe(false);
  });

  it('TC-R8-U07 a fresh install is keyless: the vault appears on demand and stores a managed secret', async () => {
    const area = new MemoryStorageArea();
    // The KDF floor is a security guard, so the test uses it rather than lowering it.
    const store = new SettingsStore({
      area,
      now: () => 0,
      iterations: MIN_ITERATIONS,
      crypto: globalThis.crypto,
    });
    expect(await store.getEnvelope()).toBeNull();

    await store.ensureKeylessVault();
    // Configured, with no passphrase anywhere: that is what "never asks" is made of.
    expect(await store.getEnvelope()).not.toBeNull();
    expect((await store.vaultStatus()).configured).toBe(true);
    const stored = await area.get(STORAGE_KEYS.vaultLocalSecret);
    expect(typeof stored[STORAGE_KEYS.vaultLocalSecret]).toBe('string');
    // A second call is a no-op rather than a second vault.
    const first = await store.getEnvelope();
    await store.ensureKeylessVault();
    expect(await store.getEnvelope()).toEqual(first);
  });

  it('TC-R8-U06 remembering the live session is a no-op without one, and never throws', async () => {
    const store = new SettingsStore({ area: new MemoryStorageArea(), now: () => 0, iterations: 1 });
    await store.setUnlockPolicy('remember');
    // No session: nothing to remember, and asking must not be an error the caller has to handle. This is
    // the gap an install unlocked before the policy existed would otherwise sit in forever.
    await expect(store.rememberCurrentKey()).resolves.toBeUndefined();
  });
});
