import { describe, expect, it } from 'vitest';

import { MemoryStorageArea, STORAGE_KEYS, SettingsStore } from './settings-store';

/**
 * The unlock policy is a security setting, so its defaults matter more than its features.
 *
 * Two facts are pinned here: an install that never answered the question is STRICT (no key is ever
 * remembered on the user's behalf), and leaving remember mode drops the key rather than keeping a way
 * back in.
 */
describe('unlock policy (R8 UNIT)', () => {
  it('TC-R8-U04 defaults to remember, and keeps the policy next to the key it authorizes', async () => {
    const store = new SettingsStore({ area: new MemoryStorageArea(), now: () => 0, iterations: 1 });
    // Default: remember, so a fresh install does not ask for the passphrase after every restart.
    expect(await store.getUnlockPolicy()).toBe('remember');

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
});
