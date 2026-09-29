import { describe, expect, it } from 'vitest';

import { newSourceItem, type CkfRecord, type SourceItem } from '../core/ckf';
import {
  CodecError,
  TRANSPARENT_EXTENSION,
  VAULT_EXTENSION,
  recordContentPath,
  transparentCodec,
  type ContentCodec,
} from './codec';
import {
  MIN_ITERATIONS,
  WrongPassphraseError,
  createEnvelope,
  deriveKeyFromEnvelope,
  encryptText,
  isEnvelope,
  parseEnvelope,
  type CryptoProvider,
  type EncryptedEnvelope,
} from '../security/crypto-key';
import { KeySession, MemorySessionKeyStore, VaultLockedError } from '../security/key-session';
import type { CommitResult, RepoFile } from './types';
import {
  createVaultCodec,
  parseVaultMeta,
  readVaultMeta,
  vaultKdfFromEnvelope,
  type VaultEnvelope,
} from './vault-codec';

const PASSPHRASE = 'correct horse battery';
const OTHER_PASSPHRASE = 'a completely different passphrase';
const BODY = 'the quick brown fox jumps over the lazy dog — 机密正文';
const TITLE = 'Vault round trip 笔记';
const URL = 'https://example.com/posts/one?utm_source=newsletter&b=2#frag';
const FIXED_NOW = Date.parse('2026-01-05T08:30:00.000Z');

function makeItem(): SourceItem {
  return newSourceItem({
    id: 'src00001',
    url: URL,
    title: TITLE,
    body: BODY,
    tags: ['architecture', '笔记'],
    byline: 'A. Author',
    lang: 'zh-CN',
    capturedAt: new Date(FIXED_NOW),
  });
}

/** The real WebCrypto, plus a counter proving whether the codec drew any randomness at all. */
function trackedRandomness(): { crypto: CryptoProvider; calls: () => number } {
  let calls = 0;
  const provider = globalThis.crypto as unknown as CryptoProvider;
  return {
    crypto: {
      subtle: provider.subtle,
      getRandomValues<T extends ArrayBufferView>(array: T): T {
        calls += 1;
        return provider.getRandomValues(array);
      },
    },
    calls: () => calls,
  };
}

interface CommitSink {
  commitFiles(files: RepoFile[], message: string): Promise<CommitResult>;
}

class RecordingStore implements CommitSink {
  readonly commits: RepoFile[][] = [];

  async commitFiles(files: RepoFile[]): Promise<CommitResult> {
    this.commits.push(files);
    return {
      sha: `sha-${this.commits.length}`,
      htmlUrl: 'https://example.test/commit',
      paths: files.map((file) => file.path),
    };
  }
}

/** The documented capture flow: encode, then commit. A locked vault must abort before the commit. */
async function capture(sink: CommitSink, codec: ContentCodec, record: CkfRecord): Promise<void> {
  const encoded = await codec.encodeRecord(record);
  await sink.commitFiles([{ path: encoded.path, content: encoded.content }], 'capture');
}

interface VaultFixture {
  session: KeySession;
  kdf: ReturnType<typeof vaultKdfFromEnvelope>;
  codec: ContentCodec;
  envelope: EncryptedEnvelope;
}

/**
 * Mirrors F4: `secretVault` exists once, the session adopts the derived key, and the store's KDF
 * parameters come from that same envelope so one key opens every content file.
 *
 * The session clock is pinned to `FIXED_NOW` so the unlock window is deterministic.
 */
async function vaultFixture(passphrase = PASSPHRASE): Promise<VaultFixture> {
  const envelope = await createEnvelope(passphrase, JSON.stringify({ githubPat: '', providerKey: '' }), {
    iterations: MIN_ITERATIONS,
  });
  const session = new KeySession({
    store: new MemorySessionKeyStore(),
    ttlMs: 60 * 60 * 1000,
    now: () => FIXED_NOW,
  });
  const key = await deriveKeyFromEnvelope(passphrase, envelope, { extractable: true });
  await session.adopt(key, FIXED_NOW);
  const kdf = vaultKdfFromEnvelope(envelope);
  return {
    session,
    kdf,
    envelope,
    codec: createVaultCodec({ session, kdf, now: () => FIXED_NOW }),
  };
}

describe('vault codec (F3 UNIT)', () => {
  it('TC-F3-U01 round-trips a SourceItem without leaking the body into the file', async () => {
    const { codec } = await vaultFixture();
    const item = makeItem();
    const text = await codec.encode(item);

    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain(BODY);
    expect(text).not.toContain('quick brown');
    expect(text).not.toContain(TITLE);
    // Base64 cannot contain ".", so a readable host in the file would mean the URL leaked verbatim.
    expect(text).not.toContain('example.com');
    expect(text).not.toContain(URL);

    await expect(codec.decode(text)).resolves.toEqual(item);
  });

  it('TC-F3-U01 round-trips empty, 1-byte and 512 KB bodies', async () => {
    const { codec } = await vaultFixture();
    for (const body of ['', 'x', 'a'.repeat(512 * 1024)]) {
      const item = newSourceItem({
        id: 'src00002',
        url: 'https://example.com/big',
        title: 'Big body',
        body,
        capturedAt: new Date(FIXED_NOW),
      });
      const text = await codec.encode(item);
      const decoded = await codec.decode(text);
      expect(decoded).toEqual(item);
      if (decoded.kind !== 'source') throw new Error('expected a source record');
      expect(decoded.body.length).toBe(body.length);
    }
  });

  it('TC-F3-U02 draws a fresh IV per write, one salt per vault, and writes a minimal meta', async () => {
    const { codec, kdf } = await vaultFixture();
    const item = makeItem();
    const first = JSON.parse(await codec.encode(item)) as VaultEnvelope;
    const second = JSON.parse(await codec.encode(item)) as VaultEnvelope;

    expect(first.iv_b64).not.toBe(second.iv_b64);
    expect(first.cipher_b64).not.toBe(second.cipher_b64);
    expect(first.kdf.salt_b64).toBe(kdf.salt_b64);
    expect(second.kdf.salt_b64).toBe(kdf.salt_b64);
    expect(first.kdf.iterations).toBe(MIN_ITERATIONS);
    expect(first.kdf.name).toBe('PBKDF2-SHA256');
    expect(first.alg).toBe('AES-GCM');
    expect(first.v).toBe(1);

    expect(Object.keys(first.meta).sort()).toEqual(['created_at', 'id', 'kind', 'updated_at']);
    expect(first.meta).toEqual({
      kind: 'source',
      id: item.id,
      created_at: item.captured_at,
      updated_at: item.captured_at,
    });
    const meta = JSON.stringify(first.meta);
    expect(meta).not.toContain(TITLE);
    expect(meta).not.toContain(BODY);
    expect(meta).not.toContain(URL);
    expect(readVaultMeta(await codec.encode(item))).toEqual(first.meta);

    // Every file we write is a well-formed F4 envelope, so `store` code can validate it back.
    expect(isEnvelope(first)).toBe(true);
    expect(parseEnvelope(first).kdf.salt_b64).toBe(kdf.salt_b64);

    // The index entry duplicated into `index.json` is equally free of content.
    const encoded = await codec.encodeRecord(item);
    const index = JSON.stringify(encoded.index);
    expect(index).not.toContain(TITLE);
    expect(index).not.toContain(BODY);
    expect(index).not.toContain(URL);
    expect(index).not.toContain('utm_source');

    // Vault naming is opaque: no title slug in the path, and the dedup key is a fingerprint of the
    // canonical URL rather than the URL itself (dedup still works, the Git host learns nothing).
    expect(encoded.path).toBe('inbox/2026/01/src00001.md.enc');
    expect(encoded.path).not.toContain('vault-round-trip');
    expect(index).not.toContain('example.com');
    expect(encoded.index.url_key).toMatch(/^[0-9a-f]{16}$/);
    expect(encoded.index.content_key).toBe(item.content_hash);
    expect(encoded.index.kind).toBe('source');
  });

  it('TC-F3-U03 fails closed while the vault is locked and produces no output', async () => {
    const envelope = await createEnvelope(PASSPHRASE, JSON.stringify({}), {
      iterations: MIN_ITERATIONS,
    });
    const session = new KeySession({ store: new MemorySessionKeyStore() });
    const tracked = trackedRandomness();
    const codec = createVaultCodec({
      session,
      kdf: vaultKdfFromEnvelope(envelope),
      crypto: tracked.crypto,
      now: () => FIXED_NOW,
    });
    const sink = new RecordingStore();
    const item = makeItem();

    expect(session.isUnlocked()).toBe(false);
    await expect(codec.encode(item)).rejects.toThrow(VaultLockedError);
    await expect(codec.encodeRecord(item)).rejects.toThrow(VaultLockedError);
    await expect(capture(sink, codec, item)).rejects.toThrow(VaultLockedError);

    // Fail-closed means nothing happened at all: no IV drawn, no ciphertext, no commit.
    expect(tracked.calls()).toBe(0);
    expect(sink.commits).toEqual([]);

    // A `null` session is the same state.
    const noSession = createVaultCodec({ session: null, kdf: vaultKdfFromEnvelope(envelope) });
    await expect(noSession.encode(item)).rejects.toThrow(VaultLockedError);

    // Even a file this vault could open is refused while locked.
    const unlocked = await vaultFixture(PASSPHRASE);
    const file = await unlocked.codec.encode(item);
    await expect(codec.decode(file)).rejects.toThrow(VaultLockedError);
    expect(tracked.calls()).toBe(0);
  });

  it('TC-F3-U04 surfaces a wrong key as WrongPassphraseError with no partial output', async () => {
    const good = await vaultFixture(PASSPHRASE);
    const bad = await vaultFixture(OTHER_PASSPHRASE);
    const item = makeItem();
    const file = await good.codec.encode(item);
    const path = recordContentPath(item, VAULT_EXTENSION);

    // The file is a well-formed vault file; it is simply not ours.
    expect(bad.codec.matches(path, file)).toBe(true);

    let decoded: CkfRecord | null = null;
    await expect(
      bad.codec.decode(file).then((record) => {
        decoded = record;
      }),
    ).rejects.toThrow(WrongPassphraseError);
    expect(decoded).toBeNull();

    // An authentication failure must not be downgraded into a generic parse error.
    await expect(bad.codec.decode(file)).rejects.not.toThrow(CodecError);
    await expect(bad.codec.decode(file)).rejects.toMatchObject({ name: 'WrongPassphraseError' });
  });

  it('TC-F3-U06 reads a plaintext file in vault mode and raises a typed error otherwise', async () => {
    const { codec, session, kdf } = await vaultFixture();
    const item = makeItem();
    const plain = await transparentCodec.encode(item);
    const plainPath = recordContentPath(item, TRANSPARENT_EXTENSION);

    // Mode mismatch: a transparent file written before the tier switch stays readable, key or no key.
    expect(codec.matches(plainPath, plain)).toBe(false);
    await expect(codec.decode(plain)).resolves.toEqual(item);
    const locked = createVaultCodec({ session: null, kdf });
    await expect(locked.decode(plain)).resolves.toEqual(item);

    // Anything else is a typed error rather than an exception from deep inside the parser.
    const vaultPath = recordContentPath(item, VAULT_EXTENSION);
    await expect(codec.decode('plain prose, no frontmatter')).rejects.toThrow(CodecError);
    await expect(codec.decode('{"schema":1,"items":{}}')).rejects.toThrow(CodecError);
    await expect(codec.decode('{"v":2,"alg":"AES-GCM"}')).rejects.toThrow(CodecError);
    await expect(codec.decode('plain prose, no frontmatter')).rejects.toMatchObject({
      name: 'CodecError',
      code: 'parse',
    });
    expect(codec.matches(vaultPath, 'plain prose, no frontmatter')).toBe(false);
    expect(codec.matches('index.json', await codec.encode(item))).toBe(false);

    // A payload that decrypts cleanly but is not a CKF document is still a typed error.
    const key = session.requireKey();
    const cipher = await encryptText(key, 'not a knowledge document');
    const imposter: VaultEnvelope = {
      v: 1,
      alg: 'AES-GCM',
      kdf: { name: 'PBKDF2-SHA256', iterations: kdf.iterations, salt_b64: kdf.salt_b64 },
      iv_b64: cipher.iv_b64,
      cipher_b64: cipher.cipher_b64,
      meta: { kind: 'source', id: item.id, created_at: item.captured_at, updated_at: item.captured_at },
    };
    await expect(codec.decode(JSON.stringify(imposter))).rejects.toThrow(CodecError);

    // A malformed cleartext meta makes the file unreadable rather than silently mis-classified.
    await expect(codec.decode(JSON.stringify({ ...imposter, meta: undefined }))).rejects.toThrow(
      CodecError,
    );
    await expect(codec.decode(JSON.stringify({ ...imposter, meta: { kind: 'source' } }))).rejects.toThrow(
      CodecError,
    );
    expect(() => parseVaultMeta({ kind: 'mystery', id: 'x', created_at: item.captured_at, updated_at: item.captured_at })).toThrow(
      CodecError,
    );
  });
});
