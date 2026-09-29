/**
 * Content codec — the single seam that decides what the Git host can read (F3).
 *
 * One interface, two implementations:
 * - `transparentCodec` writes plain Markdown (F2 `document.ts`) so the repository stays human-readable;
 * - `createVaultCodec` (see `vault-codec.ts`) writes an AES-GCM envelope whose payload is that very
 *   same Markdown document.
 *
 * `encode`/`decode` are async even for the transparent codec: WebCrypto is inherently async, and a
 * sync/async split would push the tier into every caller and every adapter.
 *
 * Cleartext surface of a file is deliberately tiny. For the transparent codec everything is cleartext
 * by definition; for the vault codec only the KDF parameters and `meta` (kind, id, timestamps) are —
 * never a title, never the raw `url` field, never a byte of the body.
 */

import { type CkfRecord } from '../core/ckf';
import { contentKey, urlKey } from '../core/dedup';
import { docToRecord, recordToDoc } from '../core/document';
import { cardPath, joinPath, normalizePrefix, sourceItemPath, topicPath } from '../core/paths';
import type { ErrorCode, SecurityMode } from '../messages';
import type { RepoFile } from './types';

export const TRANSPARENT_EXTENSION = '.md';
export const VAULT_EXTENSION = '.md.enc';

export const RECORD_KINDS = ['source', 'card', 'topic', 'review'] as const;

export function isRecordKind(value: string): value is CkfRecord['kind'] {
  return (RECORD_KINDS as readonly string[]).includes(value);
}

/**
 * A codec failure that is not a crypto failure.
 *
 * It carries a protocol `ErrorCode` instead of extending `StoreError`, because `StoreErrorName` is a
 * closed union owned by `store/errors.ts` and this is not an HTTP outcome. `errorCodeOf` in the
 * router reads `error.code`, so the classification still reaches the UI.
 */
export class CodecError extends Error {
  readonly code: ErrorCode = 'parse';

  constructor(message: string) {
    super(message);
    this.name = 'CodecError';
  }
}

/**
 * One `index.json` entry.
 *
 * Redundant-but-harmless `id`: the map key already carries it, and keeping it inside the value makes
 * the entry self-describing for the read-modify-write path. `parseIndex` re-injects the key, so the
 * two can never diverge.
 *
 * `url_key`/`content_key` are the F1 dedup keys. They are *derived* values (canonical URL without
 * tracking parameters; the non-cryptographic body fingerprint from `dedup.ts`) — the raw `url` field,
 * the `title` and the `body` never enter the index.
 */
export interface IndexItem {
  id: string;
  kind: CkfRecord['kind'];
  path: string;
  url_key?: string;
  content_key?: string;
  created_at: string;
  updated_at: string;
}

/** A record rendered for the repository: the file to commit plus its minimal index entry. */
export interface EncodedRecord extends RepoFile {
  index: IndexItem;
}

export interface ContentCodec {
  readonly mode: SecurityMode;
  /** File extension this codec claims, including the leading dot. */
  readonly extension: string;
  encode(record: CkfRecord): Promise<string>;
  decode(text: string): Promise<CkfRecord>;
  /** True when this path/content pair is owned by this codec (used to read a mixed repository). */
  matches(path: string, text: string): boolean;
  /** Minimal index entry: identifiers and timestamps only (plus the two dedup keys). */
  indexEntry(record: CkfRecord, path: string): IndexItem;
  /** Path + encoded content + index entry, ready to go into a single commit (F6). */
  encodeRecord(record: CkfRecord, prefix?: string | null): Promise<EncodedRecord>;
}

export interface CodecOptions {
  /** Repository path prefix; the codec itself only needs it to derive `encodeRecord` paths. */
  prefix?: string | null;
  /** Injected clock so index timestamps are deterministic in tests. */
  now?: () => number;
}

/* ------------------------------------------------------------------ *
 * Shared helpers — exported because F6 needs the same path and index
 * derivation without going through a codec instance.
 * ------------------------------------------------------------------ */

function withExtension(path: string, extension: string): string {
  if (extension === TRANSPARENT_EXTENSION) return path;
  return path.endsWith(TRANSPARENT_EXTENSION)
    ? `${path.slice(0, -TRANSPARENT_EXTENSION.length)}${extension}`
    : `${path}${extension}`;
}

/**
 * Repository path for a record, with the codec's extension applied to the F2 path.
 *
 * `ReviewState` is deliberately unsupported: `review/state.json` always stays cleartext
 * (04-design F3 step 3), so a review record never passes through a content codec.
 */
export function recordContentPath(
  record: CkfRecord,
  extension: string,
  prefix?: string | null,
): string {
  switch (record.kind) {
    case 'source':
      return withExtension(sourceItemPath(record, prefix), extension);
    case 'card':
      return withExtension(cardPath(record, prefix), extension);
    case 'topic':
      return withExtension(topicPath(record, prefix), extension);
    case 'review':
      throw new CodecError(
        'codec: review state is always cleartext at review/state.json and is not coded',
      );
  }
}

/**
 * Opaque repository path: date partition + record id, with NO title slug.
 *
 * This is the vault-mode naming rule. A slug derived from the title would put the headline of every
 * captured page into the file path — visible in the repository tree, in every commit diff and in the
 * host's logs — which is exactly the metadata the vault exists to hide. Transparent mode keeps the
 * readable slug because readability is that mode's whole point.
 */
export function opaqueRecordContentPath(
  record: CkfRecord,
  extension: string,
  prefix?: string | null,
): string {
  const base = normalizePrefix(prefix);
  switch (record.kind) {
    case 'source': {
      const captured = new Date(record.captured_at);
      if (Number.isNaN(captured.getTime())) {
        throw new CodecError('codec: invalid capture timestamp');
      }
      const year = String(captured.getUTCFullYear()).padStart(4, '0');
      const month = String(captured.getUTCMonth() + 1).padStart(2, '0');
      return withExtension(joinPath(base, 'inbox', year, month, `${record.id}.md`), extension);
    }
    case 'card':
      return withExtension(
        record.status === 'pending'
          ? joinPath(base, 'cards', 'pending', `${record.id}.md`)
          : joinPath(base, 'cards', `${record.id}.md`),
        extension,
      );
    case 'topic':
      return withExtension(joinPath(base, 'topics', `${record.id}.md`), extension);
    case 'review':
      throw new CodecError(
        'codec: review state is always cleartext at review/state.json and is not coded',
      );
  }
}

function timestamps(
  record: CkfRecord,
  fallback: string,
): { created_at: string; updated_at: string } {
  switch (record.kind) {
    case 'source':
      return { created_at: record.captured_at, updated_at: record.captured_at };
    case 'card': {
      // A card has no timestamps of its own; distillation is when it came into existence.
      const at = record.distilled_by?.at ?? fallback;
      return { created_at: at, updated_at: at };
    }
    case 'review':
      return { created_at: fallback, updated_at: record.last_reviewed_at ?? fallback };
    case 'topic':
      return { created_at: fallback, updated_at: fallback };
  }
}

/**
 * The dedup key for a page URL, for the tier in use.
 *
 * Vault mode stores a fingerprint so the cleartext index never lists the pages read; transparent
 * mode stores the canonical URL so a human browsing the repository can see what is there. Both the
 * index writer and the dedup reader MUST derive this the same way — deriving it differently is how
 * duplicate detection silently stops working after switching tiers.
 */
export function dedupUrlKey(rawUrl: string, mode: SecurityMode): string {
  const canonical = urlKey(rawUrl);
  return mode === 'vault' ? contentKey(canonical) : canonical;
}

/**
 * Build the index entry for a record.
 *
 * `content_key` reuses the record's own `content_hash` rather than re-fingerprinting the body: the
 * CKF field exists for exactly this purpose, and re-hashing a 512 KB body on every capture would be
 * wasted work.
 */
export function indexItemFor(
  record: CkfRecord,
  path: string,
  fallback: string,
  options: { mode?: SecurityMode; hashUrlKey?: boolean } = {},
): IndexItem {
  const { created_at, updated_at } = timestamps(record, fallback);
  const item: IndexItem = {
    id: record.id,
    kind: record.kind,
    path,
    created_at,
    updated_at,
  };
  if (record.kind === 'source') {
    item.url_key = dedupUrlKey(record.url, options.mode ?? 'transparent');
    item.content_key = record.content_hash;
  }
  return item;
}

export function isPlainMarkdownPath(path: string): boolean {
  // `.md.enc` does not end in `.md`, so the two codecs can never claim the same path.
  return path.endsWith(TRANSPARENT_EXTENSION);
}

export function isVaultPath(path: string): boolean {
  return path.endsWith(VAULT_EXTENSION);
}

/** True when `text` decodes as a CKF document (frontmatter with a known `kind`). */
export function isCkfDocument(text: string): boolean {
  try {
    docToRecord(text);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Transparent codec
 * ------------------------------------------------------------------ */

class TransparentCodec implements ContentCodec {
  readonly mode: SecurityMode = 'transparent';
  readonly extension: string = TRANSPARENT_EXTENSION;

  private readonly prefix: string | null;
  private readonly now: () => number;

  constructor(options: CodecOptions = {}) {
    this.prefix = options.prefix ?? null;
    this.now = options.now ?? Date.now;
  }

  async encode(record: CkfRecord): Promise<string> {
    return recordToDoc(record);
  }

  async decode(text: string): Promise<CkfRecord> {
    // No envelope, no key: a plaintext repository is readable by anyone the repository is.
    return docToRecord(text);
  }

  matches(path: string, text: string): boolean {
    return isPlainMarkdownPath(path) && isCkfDocument(text);
  }

  indexEntry(record: CkfRecord, path: string): IndexItem {
    return indexItemFor(record, path, new Date(this.now()).toISOString());
  }

  async encodeRecord(record: CkfRecord, prefix: string | null = this.prefix): Promise<EncodedRecord> {
    const path = recordContentPath(record, this.extension, prefix);
    return { path, content: await this.encode(record), index: this.indexEntry(record, path) };
  }
}

/** Default transparent codec: no prefix, wall-clock timestamps. */
export const transparentCodec: ContentCodec = new TransparentCodec();

export function createTransparentCodec(options: CodecOptions = {}): ContentCodec {
  return new TransparentCodec(options);
}
