import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ITERATIONS,
  MIN_ITERATIONS,
  SALT_BYTES,
  VaultCryptoError,
  WrongPassphraseError,
  assertPassphrase,
  createEnvelope,
  decryptText,
  deriveKey,
  deriveKeyFromEnvelope,
  encryptText,
  isEnvelope,
  openEnvelope,
  parseEnvelope,
} from './crypto-key';

/** Low but legal work factor — keeps the suite fast while still exercising PBKDF2. */
const ITERATIONS = MIN_ITERATIONS;
const cryptoProvider = globalThis.crypto;

async function rawKeyBytes(key: CryptoKey): Promise<string> {
  const raw = await cryptoProvider.subtle.exportKey('raw', key);
  return Array.from(new Uint8Array(raw)).join(',');
}

describe('deriveKey (F4 UNIT)', () => {
  it('TC-F4-U01 derives identical key bytes for the same passphrase and salt', async () => {
    const salt = new Uint8Array(SALT_BYTES).fill(7);
    const a = await deriveKey('correct horse battery', salt, {
      iterations: ITERATIONS,
      extractable: true,
    });
    const b = await deriveKey('correct horse battery', salt, {
      iterations: ITERATIONS,
      extractable: true,
    });
    expect(await rawKeyBytes(a)).toBe(await rawKeyBytes(b));
  });

  it('TC-F4-U01 derives different key bytes for a different salt', async () => {
    const a = await deriveKey('correct horse battery', new Uint8Array(SALT_BYTES).fill(1), {
      iterations: ITERATIONS,
      extractable: true,
    });
    const b = await deriveKey('correct horse battery', new Uint8Array(SALT_BYTES).fill(2), {
      iterations: ITERATIONS,
      extractable: true,
    });
    expect(await rawKeyBytes(a)).not.toBe(await rawKeyBytes(b));
  });

  it('TC-F4-U01 derives different key bytes for a different passphrase', async () => {
    const salt = new Uint8Array(SALT_BYTES).fill(3);
    const a = await deriveKey('passphrase one', salt, { iterations: ITERATIONS, extractable: true });
    const b = await deriveKey('passphrase two', salt, { iterations: ITERATIONS, extractable: true });
    expect(await rawKeyBytes(a)).not.toBe(await rawKeyBytes(b));
  });

  it('TC-F4-U01 rejects short passphrases and unsafe iteration counts', async () => {
    expect(() => assertPassphrase('short')).toThrow(VaultCryptoError);
    expect(() => assertPassphrase('x'.repeat(257))).toThrow(VaultCryptoError);
    expect(assertPassphrase('long enough')).toBe('long enough');
    await expect(
      deriveKey('long enough', new Uint8Array(SALT_BYTES), { iterations: 1000 }),
    ).rejects.toThrow(VaultCryptoError);
  });

  it('TC-F4-U01 keeps production keys non-extractable by default', async () => {
    const key = await deriveKey('correct horse battery', new Uint8Array(SALT_BYTES), {
      iterations: ITERATIONS,
    });
    await expect(cryptoProvider.subtle.exportKey('raw', key)).rejects.toThrow();
  });
});

describe('encryptText / decryptText (F4 UNIT)', () => {
  it('TC-F4-U02 round trips 1 byte, 1 KB and 512 KB exactly', async () => {
    const key = await deriveKey('correct horse battery', new Uint8Array(SALT_BYTES).fill(9), {
      iterations: ITERATIONS,
    });
    for (const size of [1, 1024, 512 * 1024]) {
      const plaintext = 'a'.repeat(size);
      const cipher = await encryptText(key, plaintext);
      expect(await decryptText(key, cipher)).toBe(plaintext);
    }
  });

  it('TC-F4-U02 round trips unicode and empty strings', async () => {
    const key = await deriveKey('correct horse battery', new Uint8Array(SALT_BYTES).fill(4), {
      iterations: ITERATIONS,
    });
    for (const plaintext of ['', '😀 中文 body', '---\n---\n']) {
      expect(await decryptText(key, await encryptText(key, plaintext))).toBe(plaintext);
    }
  });

  it('TC-F4-U02 uses a fresh IV for every encryption', async () => {
    const key = await deriveKey('correct horse battery', new Uint8Array(SALT_BYTES).fill(5), {
      iterations: ITERATIONS,
    });
    const first = await encryptText(key, 'same input');
    const second = await encryptText(key, 'same input');
    expect(first.iv_b64).not.toBe(second.iv_b64);
    expect(first.cipher_b64).not.toBe(second.cipher_b64);
  });

  it('TC-F4-U02 fails closed on a wrong key', async () => {
    const salt = new Uint8Array(SALT_BYTES).fill(6);
    const good = await deriveKey('correct horse battery', salt, { iterations: ITERATIONS });
    const bad = await deriveKey('wrong horse battery!!', salt, { iterations: ITERATIONS });
    const cipher = await encryptText(good, 'secret payload');
    await expect(decryptText(bad, cipher)).rejects.toThrow(WrongPassphraseError);
  });

  it('TC-F4-U02 fails closed on tampered ciphertext', async () => {
    const key = await deriveKey('correct horse battery', new Uint8Array(SALT_BYTES).fill(8), {
      iterations: ITERATIONS,
    });
    const cipher = await encryptText(key, 'secret payload');
    const bytes = atob(cipher.cipher_b64).split('');
    bytes[0] = String.fromCharCode(bytes[0]!.charCodeAt(0) ^ 0xff);
    const tampered = { ...cipher, cipher_b64: btoa(bytes.join('')) };
    await expect(decryptText(key, tampered)).rejects.toThrow(WrongPassphraseError);
  });
});

describe('envelopes (F4 UNIT)', () => {
  it('TC-F4-U02 creates a self-describing envelope and opens it again', async () => {
    const envelope = await createEnvelope('correct horse battery', 'top secret', {
      iterations: ITERATIONS,
    });
    expect(envelope.kdf.iterations).toBe(ITERATIONS);
    expect(envelope.kdf.name).toBe('PBKDF2-SHA256');
    expect(envelope.alg).toBe('AES-GCM');
    expect(envelope.v).toBe(1);
    expect(JSON.stringify(envelope)).not.toContain('top secret');
    await expect(openEnvelope('correct horse battery', envelope)).resolves.toBe('top secret');
  });

  it('TC-F4-U02 refuses the wrong passphrase on an envelope', async () => {
    const envelope = await createEnvelope('correct horse battery', 'top secret', {
      iterations: ITERATIONS,
    });
    await expect(openEnvelope('not the passphrase', envelope)).rejects.toThrow(WrongPassphraseError);
  });

  it('TC-F4-U02 uses a distinct salt per envelope', async () => {
    const a = await createEnvelope('correct horse battery', 'x', { iterations: ITERATIONS });
    const b = await createEnvelope('correct horse battery', 'x', { iterations: ITERATIONS });
    expect(a.kdf.salt_b64).not.toBe(b.kdf.salt_b64);
    expect(a.iv_b64).not.toBe(b.iv_b64);
  });

  it('TC-F4-U02 re-derives the same key from a stored envelope', async () => {
    const envelope = await createEnvelope('correct horse battery', 'payload', {
      iterations: ITERATIONS,
    });
    const key = await deriveKeyFromEnvelope('correct horse battery', envelope, {
      extractable: true,
    });
    const again = await deriveKeyFromEnvelope('correct horse battery', envelope, {
      extractable: true,
    });
    expect(await rawKeyBytes(key)).toBe(await rawKeyBytes(again));
  });

  it('TC-F4-U02 defaults to the documented production work factor', () => {
    expect(DEFAULT_ITERATIONS).toBeGreaterThanOrEqual(250_000);
  });
});

describe('envelope validation (F4 UNIT)', () => {
  const valid = {
    v: 1,
    alg: 'AES-GCM',
    kdf: { name: 'PBKDF2-SHA256', iterations: 250_000, salt_b64: btoa('0123456789abcdef') },
    iv_b64: btoa('0123456789ab'),
    cipher_b64: btoa('ciphertext'),
  };

  it('TC-F4-U02 accepts a well-formed envelope', () => {
    expect(isEnvelope(valid)).toBe(true);
    expect(parseEnvelope(valid).kdf.iterations).toBe(250_000);
  });

  it('TC-F4-U02 rejects malformed envelopes instead of guessing', () => {
    const cases: unknown[] = [
      null,
      'string',
      { ...valid, v: 2 },
      { ...valid, alg: 'AES-CBC' },
      { ...valid, kdf: { ...valid.kdf, name: 'scrypt' } },
      { ...valid, kdf: { ...valid.kdf, iterations: 10 } },
      { ...valid, kdf: { ...valid.kdf, salt_b64: 'not base64!' } },
      { ...valid, kdf: { ...valid.kdf, salt_b64: btoa('too short') } },
      { ...valid, iv_b64: btoa('short') },
      { ...valid, cipher_b64: '!!' },
      { ...valid, kdf: undefined },
    ];
    for (const value of cases) {
      expect(isEnvelope(value)).toBe(false);
      expect(() => parseEnvelope(value)).toThrow(VaultCryptoError);
    }
  });
});
