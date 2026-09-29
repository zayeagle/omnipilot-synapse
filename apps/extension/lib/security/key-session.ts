/**
 * Session unlock for the vault.
 *
 * Security posture (deliberate, mirrors §6.2 of the requirements):
 * - the passphrase is never persisted and there is no auto-unlock;
 * - the derived key lives in service-worker memory, mirrored as raw bytes into
 *   `storage.session`, which is memory-backed and cleared when the browser exits;
 * - a locked vault fails closed — callers get `VaultLockedError` and no plaintext path exists.
 */

import { base64ToBytes, bytesToBase64 } from './base64';
import { VaultCryptoError, resolveCrypto, toBufferSource, type CryptoProvider } from './crypto-key';

export class VaultLockedError extends Error {
  constructor(message = 'vault: locked') {
    super(message);
    this.name = 'VaultLockedError';
  }
}

export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const MIN_TTL_MS = 60 * 1000;
export const MAX_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionSnapshot {
  rawKeyB64: string;
  unlockedAt: number;
}

export interface SessionKeyStore {
  read(): Promise<SessionSnapshot | null>;
  write(snapshot: SessionSnapshot): Promise<void>;
  clear(): Promise<void>;
}

export interface KeySessionOptions {
  ttlMs?: number;
  now?: () => number;
  store?: SessionKeyStore | null;
  crypto?: CryptoProvider;
}

export interface KeySessionStatus {
  unlocked: boolean;
  unlockedAt: number | null;
  expiresAt: number | null;
  remainingMs: number;
}

export function clampTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(ttlMs)));
}

export class KeySession {
  private rawKeyB64: string | null = null;
  private key: CryptoKey | null = null;
  private unlockedAt = 0;
  private readonly store: SessionKeyStore | null;
  private readonly cryptoProvider: CryptoProvider | undefined;
  private readonly now: () => number;
  /** Mutable so a change to `autoLockMinutes` applies to the session already in progress. */
  private ttlMs: number;

  constructor(options: KeySessionOptions = {}) {
    this.ttlMs = clampTtl(options.ttlMs ?? DEFAULT_TTL_MS);
    this.now = options.now ?? Date.now;
    this.store = options.store ?? null;
    this.cryptoProvider = options.crypto;
  }

  /** Apply a new auto-lock window. Clamped, and safe to call while locked. */
  setTtl(ttlMs: number): void {
    this.ttlMs = clampTtl(ttlMs);
  }

  get ttl(): number {
    return this.ttlMs;
  }

  /** Adopt a freshly derived key and start (or restart) the unlock window. */
  async adopt(key: CryptoKey, at: number = this.now()): Promise<void> {
    const provider = resolveCrypto(this.cryptoProvider);
    let raw: ArrayBuffer;
    try {
      raw = await provider.subtle.exportKey('raw', key);
    } catch {
      throw new VaultCryptoError('vault: the derived key must be extractable to start a session');
    }
    this.key = key;
    this.rawKeyB64 = bytesToBase64(new Uint8Array(raw));
    this.unlockedAt = at;
    if (this.store) {
      await this.store.write({ rawKeyB64: this.rawKeyB64, unlockedAt: this.unlockedAt });
    }
  }

  /** Re-hydrate a session after the service worker was recycled. */
  async restore(): Promise<boolean> {
    if (!this.store) return false;
    const snapshot = await this.store.read();
    if (!snapshot) return false;
    if (!this.isFresh(snapshot.unlockedAt)) {
      await this.store.clear();
      return false;
    }
    const provider = resolveCrypto(this.cryptoProvider);
    try {
      this.key = await provider.subtle.importKey(
        'raw',
        toBufferSource(base64ToBytes(snapshot.rawKeyB64)),
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    } catch {
      await this.store.clear();
      return false;
    }
    this.rawKeyB64 = snapshot.rawKeyB64;
    this.unlockedAt = snapshot.unlockedAt;
    return true;
  }

  isUnlocked(at: number = this.now()): boolean {
    this.expireIfStale(at);
    return this.key !== null;
  }

  private isFresh(unlockedAt: number, at: number = this.now()): boolean {
    return at - unlockedAt >= 0 && at - unlockedAt < this.ttlMs;
  }

  /**
   * Drop key material the moment the window closes. An expired key must not sit in worker memory
   * waiting for a caller that happens to check `isUnlocked` first.
   */
  private expireIfStale(at: number = this.now()): void {
    if (this.key === null) return;
    if (this.isFresh(this.unlockedAt, at)) return;
    this.key = null;
    this.rawKeyB64 = null;
    this.unlockedAt = 0;
    void this.store?.clear().catch(() => undefined);
  }

  private expiresAt(): number | null {
    return this.key === null ? null : this.unlockedAt + this.ttlMs;
  }

  status(at: number = this.now()): KeySessionStatus {
    const unlocked = this.isUnlocked(at);
    const expiresAt = this.expiresAt();
    return {
      unlocked,
      unlockedAt: this.key === null ? null : this.unlockedAt,
      expiresAt,
      remainingMs: unlocked && expiresAt !== null ? Math.max(0, expiresAt - at) : 0,
    };
  }

  /** Current key, or throw. Never returns a key for an expired session. */
  requireKey(at: number = this.now()): CryptoKey {
    if (!this.isUnlocked(at) || this.key === null) throw new VaultLockedError();
    return this.key;
  }

  async withKey<T>(fn: (key: CryptoKey) => Promise<T>): Promise<T> {
    return fn(this.requireKey());
  }

  async lock(): Promise<void> {
    this.key = null;
    this.rawKeyB64 = null;
    this.unlockedAt = 0;
    if (this.store) await this.store.clear();
  }
}

/** In-memory `SessionKeyStore` used by tests and by contexts without `storage.session`. */
export class MemorySessionKeyStore implements SessionKeyStore {
  private snapshot: SessionSnapshot | null = null;

  async read(): Promise<SessionSnapshot | null> {
    return this.snapshot;
  }

  async write(snapshot: SessionSnapshot): Promise<void> {
    this.snapshot = snapshot;
  }

  async clear(): Promise<void> {
    this.snapshot = null;
  }
}
