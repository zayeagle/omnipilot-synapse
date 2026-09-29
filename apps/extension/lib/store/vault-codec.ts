/**
 * Vault codec — the encrypted confidentiality tier (F3, SC-F3-01/02/03).
 *
 * A stored file is `<name>.md.enc` and contains a JSON envelope: the standard F4
 * `EncryptedEnvelope` (AES-GCM, self-describing PBKDF2 parameters) plus a minimal cleartext `meta`.
 * The payload is the exact Markdown document the transparent codec would have written, so a tier
 * switch never changes the record model — only the outer bytes.
 *
 * Three invariants this module exists to hold:
 * 1. a locked session produces `VaultLockedError` *before* any crypto runs, so nothing is written;
 * 2. a wrong key surfaces as `WrongPassphraseError` from AES-GCM authentication, never as a partial
 *    record or a plaintext fallback;
 * 3. the cleartext surface of a file is `meta` only — no title, no URL, no body.
 *
 * The KDF salt/iterations are the *store's*, taken from the `secretVault` envelope, so one derived
 * key opens the whole repository and every file envelope stays verifiable by `parseEnvelope`.
 */

import { isIsoTimestamp, type CkfRecord } from '../core/ckf';
import { docToRecord, recordToDoc } from '../core/document';
import {
  MIN_ITERATIONS,
  decryptText,
  encryptText,
  parseEnvelope,
  type CryptoProvider,
  type EncryptedEnvelope,
} from '../security/crypto-key';
import { VaultLockedError, type KeySession } from '../security/key-session';
import {
  CodecError,
  VAULT_EXTENSION,
  indexItemFor,
  isRecordKind,
  isVaultPath,
  opaqueRecordContentPath,
  type CodecOptions,
  type ContentCodec,
  type EncodedRecord,
  type IndexItem,
} from './codec';
import type { SecurityMode } from '../messages';

/** PBKDF2 parameters shared by every file in one vault. */
export interface VaultKdf {
  iterations: number;
  salt_b64: string;
}

/**
 * The only cleartext content of a vault file besides the KDF parameters.
 * `kind`/`id` let the index and the UI classify a file; the timestamps keep listings sortable.
 */
export interface VaultMeta {
  kind: CkfRecord['kind'];
  id: string;
  created_at: string;
  updated_at: string;
}

export interface VaultEnvelope extends EncryptedEnvelope {
  meta: VaultMeta;
}

export interface VaultCodecOptions extends CodecOptions {
  /** The unlocked session. `null` simply means "locked": every write fails closed. */
  session: KeySession | null;
  /** Store-wide KDF parameters (`vaultKdfFromEnvelope`); a fresh salt per file would need one key per file. */
  kdf: VaultKdf;
  crypto?: CryptoProvider;
}

export function vaultKdfFromEnvelope(envelope: EncryptedEnvelope): VaultKdf {
  return { iterations: envelope.kdf.iterations, salt_b64: envelope.kdf.salt_b64 };
}

export function parseVaultMeta(value: unknown): VaultMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodecError('codec: vault envelope meta is missing');
  }
  const raw = value as Record<string, unknown>;
  const kind = raw['kind'];
  const id = raw['id'];
  const createdAt = raw['created_at'];
  const updatedAt = raw['updated_at'];

  if (typeof kind !== 'string' || !isRecordKind(kind)) {
    throw new CodecError('codec: vault meta.kind is not a known record kind');
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new CodecError('codec: vault meta.id must be a non-empty string');
  }
  if (typeof createdAt !== 'string' || !isIsoTimestamp(createdAt)) {
    throw new CodecError('codec: vault meta.created_at must be an ISO-8601 timestamp');
  }
  if (typeof updatedAt !== 'string' || !isIsoTimestamp(updatedAt)) {
    throw new CodecError('codec: vault meta.updated_at must be an ISO-8601 timestamp');
  }
  return { kind, id, created_at: createdAt, updated_at: updatedAt };
}

/** Structural validation of a whole vault file. Throws `VaultCryptoError`/`CodecError`. */
export function parseVaultEnvelope(value: unknown): VaultEnvelope {
  const envelope = parseEnvelope(value);
  const meta = parseVaultMeta((value as Record<string, unknown>)['meta']);
  return { ...envelope, meta };
}

function looksLikeJsonObject(text: string): boolean {
  return text.trimStart().startsWith('{');
}

export function tryParseVaultEnvelope(text: string): VaultEnvelope | null {
  if (!looksLikeJsonObject(text)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  try {
    return parseVaultEnvelope(parsed);
  } catch {
    return null;
  }
}

/** True when the content is a well-formed vault file — usable without a key (F6 listings). */
export function isVaultFile(text: string): boolean {
  return tryParseVaultEnvelope(text) !== null;
}

/** The cleartext `meta` of a vault file, or `null`. Never decrypts. */
export function readVaultMeta(text: string): VaultMeta | null {
  return tryParseVaultEnvelope(text)?.meta ?? null;
}

/**
 * Read a cleartext document that predates the tier switch (SC-F3-02 mode mismatch).
 * Needs no key: those bytes are already readable by anyone with repository access.
 */
function decodePlaintext(text: string): CkfRecord {
  try {
    return docToRecord(text);
  } catch {
    throw new CodecError(
      'codec: the file is neither a knowledge record nor a vault envelope',
    );
  }
}

class VaultCodec implements ContentCodec {
  readonly mode: SecurityMode = 'vault';
  readonly extension: string = VAULT_EXTENSION;

  private readonly session: KeySession | null;
  private readonly kdf: VaultKdf;
  private readonly cryptoProvider: CryptoProvider | undefined;
  private readonly prefix: string | null;
  private readonly now: () => number;

  constructor(options: VaultCodecOptions) {
    if (!Number.isInteger(options.kdf.iterations) || options.kdf.iterations < MIN_ITERATIONS) {
      throw new CodecError(`codec: vault iterations must be at least ${MIN_ITERATIONS}`);
    }
    this.session = options.session;
    this.kdf = options.kdf;
    this.cryptoProvider = options.crypto;
    this.prefix = options.prefix ?? null;
    this.now = options.now ?? Date.now;
  }

  /**
   * Locked means fail closed — and fail *here*, before a single byte is produced.
   *
   * The session judges its own freshness (`requireKey()` with no clock argument): the codec's clock
   * is only for index timestamps, and letting it override the session's would make a store with an
   * injected clock see a perfectly valid session as expired.
   */
  private requireKey(): CryptoKey {
    if (!this.session) throw new VaultLockedError('vault: no key session configured');
    return this.session.requireKey();
  }

  private async render(record: CkfRecord, index: IndexItem): Promise<string> {
    // Ordered so that the locked check happens before any randomness or ciphertext exists.
    const key = this.requireKey();
    const cipher = await encryptText(key, recordToDoc(record), this.cryptoProvider);
    const envelope: VaultEnvelope = {
      v: 1,
      alg: 'AES-GCM',
      kdf: {
        name: 'PBKDF2-SHA256',
        iterations: this.kdf.iterations,
        salt_b64: this.kdf.salt_b64,
      },
      // A fresh IV per write (from `encryptText`) is what makes two encodes of the same record
      // produce different bytes while staying decryptable with the same key.
      iv_b64: cipher.iv_b64,
      cipher_b64: cipher.cipher_b64,
      meta: {
        kind: record.kind,
        id: record.id,
        created_at: index.created_at,
        updated_at: index.updated_at,
      },
    };
    return `${JSON.stringify(envelope, null, 2)}\n`;
  }

  private entryFor(record: CkfRecord, path: string): IndexItem {
    // Vault mode fingerprints the canonical URL so the cleartext index never lists the pages read.
    return indexItemFor(record, path, new Date(this.now()).toISOString(), { mode: 'vault' });
  }

  async encode(record: CkfRecord): Promise<string> {
    const path = opaqueRecordContentPath(record, this.extension, this.prefix);
    return this.render(record, this.entryFor(record, path));
  }

  /**
   * Decode a file that may be either tier.
   *
   * Order matches the design: try the plaintext document first (a file written before the tier
   * switch, or hand-edited), then the envelope. `VaultLockedError` and `WrongPassphraseError` are
   * never swallowed into `CodecError` — a locked or mis-keyed read must stay distinguishable.
   */
  async decode(text: string): Promise<CkfRecord> {
    if (!looksLikeJsonObject(text)) return decodePlaintext(text);

    const envelope = tryParseVaultEnvelope(text);
    if (!envelope) return decodePlaintext(text);

    const key = this.requireKey();
    const plaintext = await decryptText(
      key,
      { iv_b64: envelope.iv_b64, cipher_b64: envelope.cipher_b64 },
      this.cryptoProvider,
    );
    try {
      return docToRecord(plaintext);
    } catch {
      throw new CodecError('codec: the decrypted vault payload is not a knowledge record');
    }
  }

  matches(path: string, text: string): boolean {
    return isVaultPath(path) && isVaultFile(text);
  }

  indexEntry(record: CkfRecord, path: string): IndexItem {
    return this.entryFor(record, path);
  }

  async encodeRecord(record: CkfRecord, prefix: string | null = this.prefix): Promise<EncodedRecord> {
    // Opaque naming: a title slug in the path would leak the headline of the captured page (F3).
    const path = opaqueRecordContentPath(record, this.extension, prefix);
    const index = this.entryFor(record, path);
    return { path, content: await this.render(record, index), index };
  }
}

export function createVaultCodec(options: VaultCodecOptions): ContentCodec {
  return new VaultCodec(options);
}
