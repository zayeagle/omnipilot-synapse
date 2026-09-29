import { describe, expect, it } from 'vitest';

import { MIN_ITERATIONS, WrongPassphraseError } from './security/crypto-key';
import { KeySession, MemorySessionKeyStore, VaultLockedError } from './security/key-session';
import {
  EMPTY_SECRETS,
  MemoryStorageArea,
  STORAGE_KEYS,
  SettingsStore,
} from './settings-store';

const PASSPHRASE = 'correct horse battery';
const SECRETS = {
  githubPat: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
  providerKey: 'sk-abcdefghijklmnopqrstuvwxyz',
};

function makeStore(area = new MemoryStorageArea(), clock = 1_000_000) {
  const session = new KeySession({
    ttlMs: 60 * 60 * 1000,
    now: () => clock,
    store: new MemorySessionKeyStore(),
  });
  const store = new SettingsStore({ area, session, iterations: MIN_ITERATIONS, now: () => clock });
  return { area, session, store };
}

describe('vault lifecycle (F4 INT)', () => {
  it('TC-F4-I02 stores secrets only inside the envelope and projects them as booleans', async () => {
    const { area, store } = makeStore();
    await store.setupVault(PASSPHRASE, SECRETS);

    const dump = JSON.stringify(Object.fromEntries(area.keys().map((key) => [key, null])));
    expect(dump).toContain(STORAGE_KEYS.secretVault);

    const stored = await area.get([STORAGE_KEYS.secretVault, STORAGE_KEYS.publicPrefs, STORAGE_KEYS.settings]);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(SECRETS.githubPat);
    expect(serialized).not.toContain(SECRETS.providerKey);
    expect(serialized).not.toContain(PASSPHRASE);

    const prefs = stored[STORAGE_KEYS.publicPrefs];
    expect(prefs).toMatchObject({ hasPat: true, hasKey: true, vaultLocked: false });

    await expect(store.getSecrets()).resolves.toEqual(SECRETS);
  });

  it('TC-F4-I02 fails closed while locked and reopens only with the right passphrase', async () => {
    const { area, store } = makeStore();
    await store.setupVault(PASSPHRASE, SECRETS);

    await store.lock();
    await expect(store.getSecrets()).rejects.toThrow(VaultLockedError);
    expect((await store.publicPrefs()).vaultLocked).toBe(true);
    expect(await store.peekSecrets()).toBeNull();

    await expect(store.unlock('definitely not it')).rejects.toThrow(WrongPassphraseError);
    await expect(store.getSecrets()).rejects.toThrow(VaultLockedError);

    await expect(store.unlock(PASSPHRASE)).resolves.toEqual(SECRETS);
    expect((await store.publicPrefs()).vaultLocked).toBe(false);

    // Nothing plaintext was ever written, even after a failed unlock.
    const stored = await area.get([STORAGE_KEYS.secretVault]);
    expect(JSON.stringify(stored)).not.toContain(SECRETS.githubPat);
  });

  it('TC-F4-I02 merges a secret patch and keeps the vault openable with the same passphrase', async () => {
    const { store } = makeStore();
    await store.setupVault(PASSPHRASE, EMPTY_SECRETS);

    await store.updateSecrets({ githubPat: SECRETS.githubPat });
    await expect(store.getSecrets()).resolves.toEqual({ ...EMPTY_SECRETS, githubPat: SECRETS.githubPat });

    await store.updateSecrets({ providerKey: SECRETS.providerKey });
    await store.lock();
    await expect(store.unlock(PASSPHRASE)).resolves.toEqual(SECRETS);
  });

  it('TC-F4-I02 refuses to touch secrets before a vault exists', async () => {
    const { store } = makeStore();
    await expect(store.getSecrets()).rejects.toThrow(VaultLockedError);
    await expect(store.updateSecrets({ githubPat: 'x' })).rejects.toThrow(VaultLockedError);
    await expect(store.unlock(PASSPHRASE)).rejects.toThrow(VaultLockedError);
    expect((await store.vaultStatus()).configured).toBe(false);
  });

  it('TC-F4-I02 resets everything including the session', async () => {
    const { area, store } = makeStore();
    await store.patch({ aiAuthorized: true });
    await store.setupVault(PASSPHRASE, SECRETS);
    expect(area.keys().length).toBeGreaterThan(2);

    await store.reset();
    expect(area.keys()).toEqual([]);
    await expect(store.getSecrets()).rejects.toThrow(VaultLockedError);
    expect(await store.load()).toMatchObject({ aiAuthorized: false, enabled: true });
  });

  it('TC-F4-I02 exports configuration without any secret value', async () => {
    const { store } = makeStore();
    await store.setupVault(PASSPHRASE, SECRETS);
    const exported = await store.exportConfig();
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain(SECRETS.githubPat);
    expect(serialized).not.toContain(SECRETS.providerKey);
    expect(exported['secretsPresent']).toEqual({ githubPat: true, providerKey: true });
    expect(exported['vault']).toMatchObject({ configured: true, unlocked: true });
  });

  it('TC-F4-I02 treats a corrupt envelope as "no vault" and lets the user set one up again', async () => {
    const area = new MemoryStorageArea({ [STORAGE_KEYS.secretVault]: { v: 1, alg: 'rot13' } });
    const { store } = makeStore(area);
    await expect(store.getEnvelope()).resolves.toBeNull();
    expect((await store.vaultStatus()).configured).toBe(false);
    await store.setupVault(PASSPHRASE, SECRETS);
    await expect(store.getSecrets()).resolves.toEqual(SECRETS);
  });

  it('TC-F4-I02 keeps the public projection in step with settings changes', async () => {
    const { store } = makeStore();
    await store.patch({
      enabled: false,
      aiAuthorized: true,
      securityMode: 'transparent',
      github: { owner: 'zayeagle', repo: 'omnipilot-synapse' },
    });
    await expect(store.publicPrefs()).resolves.toMatchObject({
      enabled: false,
      aiAuthorized: true,
      securityMode: 'transparent',
      repoFullName: 'zayeagle/omnipilot-synapse',
    });
    expect(store.autoLockTtlMs(await store.load())).toBe(30 * 60 * 1000);
  });
});
