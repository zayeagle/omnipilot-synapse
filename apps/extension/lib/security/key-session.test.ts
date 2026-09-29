import { describe, expect, it } from 'vitest';

import { MIN_ITERATIONS, SALT_BYTES, deriveKey } from './crypto-key';
import {
  DEFAULT_TTL_MS,
  KeySession,
  MAX_TTL_MS,
  MIN_TTL_MS,
  MemorySessionKeyStore,
  VaultLockedError,
  clampTtl,
} from './key-session';

const TTL = 60_000;

async function makeKey(seed = 1): Promise<CryptoKey> {
  return deriveKey('correct horse battery', new Uint8Array(SALT_BYTES).fill(seed), {
    iterations: MIN_ITERATIONS,
    extractable: true,
  });
}

describe('KeySession (F4 UNIT)', () => {
  it('TC-F4-U01 unlocks, grants the key and reports status', async () => {
    let clock = 1_000_000;
    const session = new KeySession({ ttlMs: TTL, now: () => clock });
    const key = await makeKey();

    expect(session.isUnlocked()).toBe(false);
    await expect(session.withKey(async () => 'nope')).rejects.toThrow(VaultLockedError);

    await session.adopt(key);
    expect(session.isUnlocked()).toBe(true);
    expect(await session.withKey(async (granted) => granted.algorithm.name)).toBe('AES-GCM');

    const status = session.status();
    expect(status.unlocked).toBe(true);
    expect(status.expiresAt).toBe(1_000_000 + TTL);
    expect(status.remainingMs).toBe(TTL);

    clock += 1_000;
    expect(session.status().remainingMs).toBe(TTL - 1_000);
  });

  it('TC-F4-U01 expires the session at the TTL boundary and locks afterwards', async () => {
    let clock = 0;
    const session = new KeySession({ ttlMs: TTL, now: () => clock });
    await session.adopt(await makeKey());

    clock = TTL - 1;
    expect(session.isUnlocked()).toBe(true);

    clock = TTL;
    expect(session.isUnlocked()).toBe(false);
    expect(() => session.requireKey()).toThrow(VaultLockedError);
    expect(session.status().expiresAt).toBeNull();
    expect(session.status().remainingMs).toBe(0);
  });

  it('TC-F4-U01 locks explicitly and clears the persisted snapshot', async () => {
    const store = new MemorySessionKeyStore();
    const session = new KeySession({ ttlMs: TTL, now: () => 0, store });
    await session.adopt(await makeKey());
    expect(await store.read()).not.toBeNull();

    await session.lock();
    expect(session.isUnlocked()).toBe(false);
    expect(await store.read()).toBeNull();
  });

  it('TC-F4-U01 restores a live session after a worker restart', async () => {
    const store = new MemorySessionKeyStore();
    let clock = 5_000;
    const first = new KeySession({ ttlMs: TTL, now: () => clock, store });
    await first.adopt(await makeKey());

    const revived = new KeySession({ ttlMs: TTL, now: () => clock, store });
    expect(await revived.restore()).toBe(true);
    expect(await revived.withKey(async (key) => key.algorithm.name)).toBe('AES-GCM');
  });

  it('TC-F4-U01 refuses to restore a stale snapshot', async () => {
    const store = new MemorySessionKeyStore();
    const first = new KeySession({ ttlMs: TTL, now: () => 0, store });
    await first.adopt(await makeKey());

    const revived = new KeySession({ ttlMs: TTL, now: () => TTL + 1, store });
    expect(await revived.restore()).toBe(false);
    expect(await store.read()).toBeNull();
    expect(revived.isUnlocked()).toBe(false);
  });

  it('TC-F4-U01 ignores a corrupt snapshot and clears it', async () => {
    const store = new MemorySessionKeyStore();
    await store.write({ rawKeyB64: 'not-a-key', unlockedAt: 0 });
    const session = new KeySession({ ttlMs: TTL, now: () => 1, store });
    expect(await session.restore()).toBe(false);
    expect(await store.read()).toBeNull();
  });

  it('TC-F4-U01 does nothing when no session store is configured', async () => {
    const session = new KeySession({ ttlMs: TTL, now: () => 0 });
    expect(await session.restore()).toBe(false);
    await session.adopt(await makeKey());
    await session.lock();
    expect(session.isUnlocked()).toBe(false);
  });

  it('TC-F4-U01 clamps the TTL into the supported range', () => {
    expect(clampTtl(Number.NaN)).toBe(DEFAULT_TTL_MS);
    expect(clampTtl(1)).toBe(MIN_TTL_MS);
    expect(clampTtl(Number.MAX_SAFE_INTEGER)).toBe(MAX_TTL_MS);
    expect(clampTtl(TTL)).toBe(TTL);
    expect(DEFAULT_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('TC-F4-U01 refuses to adopt a non-extractable key', async () => {
    const session = new KeySession({ ttlMs: TTL, now: () => 0 });
    const nonExtractable = await deriveKey('correct horse battery', new Uint8Array(SALT_BYTES), {
      iterations: MIN_ITERATIONS,
    });
    await expect(session.adopt(nonExtractable)).rejects.toThrow(/extractable/u);
  });
});
