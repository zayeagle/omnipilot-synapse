/**
 * Vault cryptography: PBKDF2-SHA256 → AES-GCM-256, with an envelope that carries its own KDF
 * parameters so the work factor can be raised later without orphaning existing ciphertext.
 *
 * Every entry point accepts an injected `CryptoProvider`, which keeps the module testable without
 * stubbing `globalThis.crypto` and keeps the iteration count low in tests.
 */

import { base64ToBytes, bytesToBase64, isBase64 } from './base64';

export interface CryptoProvider {
  subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

export const DEFAULT_ITERATIONS = 250_000;
export const MIN_ITERATIONS = 10_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const KEY_BITS = 256;
export const MIN_PASSPHRASE_LENGTH = 8;
export const MAX_PASSPHRASE_LENGTH = 256;

export class VaultCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultCryptoError';
  }
}

export class WrongPassphraseError extends VaultCryptoError {
  constructor() {
    super('vault: wrong passphrase or corrupted ciphertext');
    this.name = 'WrongPassphraseError';
  }
}

export interface EncryptedEnvelope {
  v: 1;
  alg: 'AES-GCM';
  kdf: {
    name: 'PBKDF2-SHA256';
    iterations: number;
    salt_b64: string;
  };
  iv_b64: string;
  cipher_b64: string;
}

export function resolveCrypto(provider?: CryptoProvider): CryptoProvider {
  const candidate = provider ?? (globalThis.crypto as CryptoProvider | undefined);
  if (!candidate || typeof candidate.subtle?.importKey !== 'function') {
    throw new VaultCryptoError('vault: WebCrypto is unavailable in this context');
  }
  return candidate;
}

/**
 * Bridge `Uint8Array` to WebCrypto's `BufferSource`.
 *
 * TypeScript's DOM/Node libs disagree about `Uint8Array`'s buffer type argument
 * (`ArrayBufferLike` vs `ArrayBuffer`), so a direct pass fails to typecheck on some toolchain
 * versions. The cast is type-only — no copy is made, which matters for 512 KB bodies.
 */
export function toBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

export function assertPassphrase(passphrase: string): string {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new VaultCryptoError(`vault: passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  if (passphrase.length > MAX_PASSPHRASE_LENGTH) {
    throw new VaultCryptoError(`vault: passphrase must be at most ${MAX_PASSPHRASE_LENGTH} characters`);
  }
  return passphrase;
}

export interface DeriveKeyOptions {
  iterations?: number;
  crypto?: CryptoProvider;
  /** Only tests need to export the raw key; production keeps keys non-extractable. */
  extractable?: boolean;
}

export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  options: DeriveKeyOptions = {},
): Promise<CryptoKey> {
  assertPassphrase(passphrase);
  const provider = resolveCrypto(options.crypto);
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  if (iterations < MIN_ITERATIONS) {
    throw new VaultCryptoError(`vault: iterations must be at least ${MIN_ITERATIONS}`);
  }

  const material = await provider.subtle.importKey(
    'raw',
    toBufferSource(new TextEncoder().encode(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return provider.subtle.deriveKey(
    { name: 'PBKDF2', salt: toBufferSource(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    options.extractable ?? false,
    ['encrypt', 'decrypt'],
  );
}

export interface CipherText {
  iv_b64: string;
  cipher_b64: string;
}

export async function encryptText(
  key: CryptoKey,
  plaintext: string,
  crypto?: CryptoProvider,
): Promise<CipherText> {
  const provider = resolveCrypto(crypto);
  const iv = provider.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await provider.subtle.encrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    key,
    toBufferSource(new TextEncoder().encode(plaintext)),
  );
  return { iv_b64: bytesToBase64(iv), cipher_b64: bytesToBase64(new Uint8Array(cipher)) };
}

export async function decryptText(
  key: CryptoKey,
  cipherText: CipherText,
  crypto?: CryptoProvider,
): Promise<string> {
  const provider = resolveCrypto(crypto);
  const iv = base64ToBytes(cipherText.iv_b64);
  const data = base64ToBytes(cipherText.cipher_b64);
  try {
    const plain = await provider.subtle.decrypt(
      { name: 'AES-GCM', iv: toBufferSource(iv) },
      key,
      toBufferSource(data),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // AES-GCM authenticates: a failure means the key or the ciphertext is wrong.
    throw new WrongPassphraseError();
  }
}

export interface CreateEnvelopeOptions {
  iterations?: number;
  crypto?: CryptoProvider;
}

export async function createEnvelope(
  passphrase: string,
  plaintext: string,
  options: CreateEnvelopeOptions = {},
): Promise<EncryptedEnvelope> {
  const provider = resolveCrypto(options.crypto);
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const salt = provider.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(passphrase, salt, { iterations, crypto: provider });
  const cipher = await encryptText(key, plaintext, provider);
  return {
    v: 1,
    alg: 'AES-GCM',
    kdf: { name: 'PBKDF2-SHA256', iterations, salt_b64: bytesToBase64(salt) },
    iv_b64: cipher.iv_b64,
    cipher_b64: cipher.cipher_b64,
  };
}

/** Derive the key described by an envelope — used to unlock a session. */
export async function deriveKeyFromEnvelope(
  passphrase: string,
  envelope: EncryptedEnvelope,
  options: { crypto?: CryptoProvider; extractable?: boolean } = {},
): Promise<CryptoKey> {
  const salt = base64ToBytes(envelope.kdf.salt_b64);
  return deriveKey(passphrase, salt, {
    iterations: envelope.kdf.iterations,
    crypto: options.crypto,
    extractable: options.extractable,
  });
}

export async function openEnvelopeWithKey(
  key: CryptoKey,
  envelope: EncryptedEnvelope,
  crypto?: CryptoProvider,
): Promise<string> {
  return decryptText(key, { iv_b64: envelope.iv_b64, cipher_b64: envelope.cipher_b64 }, crypto);
}

export async function openEnvelope(
  passphrase: string,
  envelope: EncryptedEnvelope,
  options: { crypto?: CryptoProvider } = {},
): Promise<string> {
  const key = await deriveKeyFromEnvelope(passphrase, envelope, options);
  return openEnvelopeWithKey(key, envelope, options.crypto);
}

export function parseEnvelope(value: unknown): EncryptedEnvelope {
  if (typeof value !== 'object' || value === null) {
    throw new VaultCryptoError('vault: envelope must be an object');
  }
  const raw = value as Record<string, unknown>;
  const kdf = raw['kdf'];
  if (typeof kdf !== 'object' || kdf === null) {
    throw new VaultCryptoError('vault: envelope.kdf is missing');
  }
  const kdfRaw = kdf as Record<string, unknown>;
  const iterations = kdfRaw['iterations'];
  const salt = kdfRaw['salt_b64'];
  const iv = raw['iv_b64'];
  const cipher = raw['cipher_b64'];

  if (raw['v'] !== 1) throw new VaultCryptoError('vault: unsupported envelope version');
  if (raw['alg'] !== 'AES-GCM') throw new VaultCryptoError('vault: unsupported algorithm');
  if (kdfRaw['name'] !== 'PBKDF2-SHA256') throw new VaultCryptoError('vault: unsupported KDF');
  if (typeof iterations !== 'number' || iterations < MIN_ITERATIONS) {
    throw new VaultCryptoError('vault: invalid iteration count');
  }
  if (typeof salt !== 'string' || !isBase64(salt) || base64ToBytes(salt).length !== SALT_BYTES) {
    throw new VaultCryptoError('vault: invalid salt');
  }
  if (typeof iv !== 'string' || !isBase64(iv) || base64ToBytes(iv).length !== IV_BYTES) {
    throw new VaultCryptoError('vault: invalid IV');
  }
  if (typeof cipher !== 'string' || !isBase64(cipher)) {
    throw new VaultCryptoError('vault: invalid ciphertext');
  }

  return {
    v: 1,
    alg: 'AES-GCM',
    kdf: { name: 'PBKDF2-SHA256', iterations, salt_b64: salt },
    iv_b64: iv,
    cipher_b64: cipher,
  };
}

export function isEnvelope(value: unknown): value is EncryptedEnvelope {
  try {
    parseEnvelope(value);
    return true;
  } catch {
    return false;
  }
}
