/**
 * Confidentiality tier: which codec a store uses, and the two cleartext JSON files that survive in
 * both tiers.
 *
 * `.omnipilot/config.json` records the tier per store ("mode switch is per-store" — 04-design F3
 * step 5). `index.json` is a projection of the vault `meta` so the extension can list, sort and dedup
 * without holding the key; it is never allowed to carry content.
 *
 * The index/config helpers are pure so the read-modify-write path can be reasoned about (and tested)
 * without a repository. Only `loadStoreConfig`/`saveStoreConfig`/`switchTier` touch a store, and they
 * do it through the narrow `TierStore` port below.
 *
 * `resolveTier` is the single decision point for which tier applies. Precedence: the mode recorded in
 * `.omnipilot/config.json` always wins; only a brand-new, empty repository may inherit the tier chosen
 * in the settings UI; anything unreadable or ambiguous fails closed (04-design F6 step 2).
 */

import { isIsoTimestamp } from '../core/ckf';
import { indexPath, storeConfigPath } from '../core/paths';
import type { ErrorCode, SecurityMode } from '../messages';
import type { CryptoProvider } from '../security/crypto-key';
import type { KeySession } from '../security/key-session';
import {
  createTransparentCodec,
  isRecordKind,
  type ContentCodec,
  type IndexItem,
} from './codec';
import { createVaultCodec, type VaultKdf } from './vault-codec';
import type { CommitResult, RepoFile } from './types';

/**
 * Format version of `.omnipilot/config.json`.
 *
 * Stays 1 while `branch`/`sync_policy`/`client_version` are added: those fields are optional and
 * additive, so a 0.1.0 file stays readable and a 0.1.0 reader keeps accepting a new file by ignoring
 * what it does not know. Bumping would advertise a break that does not exist and would make older
 * clients reject the file (04-design F6 step 5).
 */
export const STORE_CONFIG_SCHEMA_VERSION = 1;
export const INDEX_SCHEMA_VERSION = 1;

/** Branch recorded when the config predates the field (mirrors `DEFAULT_SETTINGS.github.branch`). */
export const DEFAULT_STORE_BRANCH = 'main';

/** `client_version` recorded when the file predates the field: an unknown, older writer. */
export const UNKNOWN_CLIENT_VERSION = '';

/**
 * Sync policy as persisted in `.omnipilot/config.json`.
 *
 * Deliberately a store-owned shape rather than `SyncPolicy` from `../messages`: this is a file-format
 * contract shared with other clients, so it must not move when the UI's message payload changes. The
 * values mirror `DEFAULT_SYNC_POLICY` in `lib/settings-store.ts` (a unit test asserts they agree).
 */
export interface StoreSyncPolicy {
  /** Minutes between automatic pulls. `0` disables the periodic pull. */
  interval_minutes: number;
  on_startup: boolean;
  on_capture: boolean;
  pull_only: boolean;
}

export const DEFAULT_STORE_SYNC_POLICY: StoreSyncPolicy = {
  interval_minutes: 30,
  on_startup: true,
  on_capture: true,
  pull_only: false,
};

/** Mirrors `SYNC_INTERVAL_MAX`; duplicated to keep the store layer free of the message protocol. */
const MAX_SYNC_INTERVAL_MINUTES = 24 * 60;

/**
 * The tier a **brand-new** store gets.
 *
 * The product asks for a repository a human can read, so a new store is readable Markdown by default;
 * the encrypted tier is one explicit, warned choice away. This is deliberately paired with
 * `SAFE_FALLBACK_MODE` below — read the comment there before changing either.
 */
export const DEFAULT_SECURITY_MODE: SecurityMode = 'transparent';

/**
 * The tier used when the stored configuration is **corrupt, unrecognised, or absent on a repository
 * that already holds content** (see the precedence list on `resolveTier`).
 *
 * This must stay `vault`: falling back to `transparent` would mean a single unreadable byte in
 * `.omnipilot/config.json` silently downgrades a user's encrypted repository to plaintext. Unknown
 * state always fails closed, even though the *default for a new store* is the readable tier.
 */
export const SAFE_FALLBACK_MODE: SecurityMode = 'vault';

export const CONFIG_COMMIT_MESSAGE = 'config: set content tier';

/**
 * The tier changed while the store already holds content and the MVP has no re-encode migration.
 * Callers surface this to the user instead of switching, because switching would orphan every file
 * under the previous extension (04-design F3 step 5).
 */
export class TierMigrationRequiredError extends Error {
  readonly code: ErrorCode = 'validation';
  readonly from: SecurityMode;
  readonly to: SecurityMode;
  readonly itemCount: number;

  constructor(from: SecurityMode, to: SecurityMode, itemCount: number) {
    super(
      `tier: switching ${from} → ${to} requires a re-encode migration of ${itemCount} item(s)`,
    );
    this.name = 'TierMigrationRequiredError';
    this.from = from;
    this.to = to;
    this.itemCount = itemCount;
  }
}

/** Vault mode was selected but the store has no KDF parameters, i.e. no passphrase was ever set. */
export class TierConfigError extends Error {
  readonly code: ErrorCode = 'notConfigured';

  constructor(message: string) {
    super(message);
    this.name = 'TierConfigError';
  }
}

export interface StoreConfig {
  schema_version: typeof STORE_CONFIG_SCHEMA_VERSION;
  security_mode: SecurityMode;
  /** Default branch clients should read/write, so a repository is self-describing. */
  branch: string;
  sync_policy: StoreSyncPolicy;
  /** Version of the client that last wrote the file; `''` when the file predates the field. */
  client_version: string;
  created_at: string;
  updated_at: string;
}

/** Optional content for a freshly created config; everything else takes the documented default. */
export interface StoreConfigSeed {
  branch?: string;
  sync_policy?: Partial<StoreSyncPolicy>;
  client_version?: string;
}

export interface IndexFile {
  schema: typeof INDEX_SCHEMA_VERSION;
  items: Record<string, IndexItem>;
}

/* ------------------------------------------------------------------ *
 * Pure: `.omnipilot/config.json`
 * ------------------------------------------------------------------ */

export function createStoreConfig(
  mode: SecurityMode,
  now: string,
  seed: StoreConfigSeed = {},
): StoreConfig {
  return {
    schema_version: STORE_CONFIG_SCHEMA_VERSION,
    security_mode: mode,
    branch: normalizeBranch(seed.branch, DEFAULT_STORE_BRANCH),
    sync_policy: normalizeStoreSyncPolicy(seed.sync_policy),
    client_version: normalizeClientVersion(seed.client_version),
    created_at: now,
    updated_at: now,
  };
}

function isoOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && isIsoTimestamp(value) ? value : fallback;
}

function normalizeBranch(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function normalizeClientVersion(value: unknown): string {
  return typeof value === 'string' ? value.trim() : UNKNOWN_CLIENT_VERSION;
}

/**
 * Tolerant read of the persisted policy.
 *
 * A partial object keeps the fields it carries and defaults the rest, so a config written by a client
 * that knows only some keys is still usable; junk is replaced rather than propagated.
 */
export function normalizeStoreSyncPolicy(value: unknown): StoreSyncPolicy {
  const raw: Record<string, unknown> =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const minutes = raw['interval_minutes'];
  return {
    interval_minutes:
      typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0
        ? Math.min(MAX_SYNC_INTERVAL_MINUTES, Math.round(minutes))
        : DEFAULT_STORE_SYNC_POLICY.interval_minutes,
    on_startup: asBoolean(raw['on_startup'], DEFAULT_STORE_SYNC_POLICY.on_startup),
    on_capture: asBoolean(raw['on_capture'], DEFAULT_STORE_SYNC_POLICY.on_capture),
    pull_only: asBoolean(raw['pull_only'], DEFAULT_STORE_SYNC_POLICY.pull_only),
  };
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Fixed key order. `JSON.stringify` follows insertion order, so canonicalizing keeps a rewrite
 * diff-free and lets a round trip be compared byte for byte.
 */
function canonicalStoreConfig(config: StoreConfig): StoreConfig {
  return {
    schema_version: STORE_CONFIG_SCHEMA_VERSION,
    security_mode: config.security_mode,
    branch: normalizeBranch(config.branch, DEFAULT_STORE_BRANCH),
    sync_policy: normalizeStoreSyncPolicy(config.sync_policy),
    client_version: normalizeClientVersion(config.client_version),
    created_at: config.created_at,
    updated_at: config.updated_at,
  };
}

/**
 * Tolerant read of a config file.
 *
 * A missing config uses `fallbackMode` (a fresh repository inherits whatever the user chose in the
 * settings UI). An *unreadable* `security_mode` always resolves to `vault`: a corrupt file must never
 * silently downgrade the store to plaintext.
 */
export function parseStoreConfig(
  value: unknown,
  now: string,
  fallbackMode: SecurityMode = DEFAULT_SECURITY_MODE,
): StoreConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return createStoreConfig(fallbackMode, now);
  }
  const raw = value as Record<string, unknown>;
  const mode = raw['security_mode'];
  const securityMode: SecurityMode =
    mode === 'transparent' ? 'transparent' : mode === 'vault' ? 'vault' : SAFE_FALLBACK_MODE;
  const createdAt = isoOr(raw['created_at'], now);
  return {
    schema_version: STORE_CONFIG_SCHEMA_VERSION,
    security_mode: securityMode,
    // A 0.1.0 file has none of these; they take their defaults in memory and reach the file only on
    // the next explicit write.
    branch: normalizeBranch(raw['branch'], DEFAULT_STORE_BRANCH),
    sync_policy: normalizeStoreSyncPolicy(raw['sync_policy']),
    client_version: normalizeClientVersion(raw['client_version']),
    created_at: createdAt,
    updated_at: isoOr(raw['updated_at'], createdAt),
  };
}

export function serializeStoreConfig(config: StoreConfig): string {
  return `${JSON.stringify(canonicalStoreConfig(config), null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * Pure: tier precedence
 * ------------------------------------------------------------------ */

/** How the tier to use was decided. */
export type TierSource = 'config' | 'default' | 'unknown';

export interface ResolveTierOptions {
  /** Raw text of `.omnipilot/config.json`; `null`/`undefined`/blank means the file is absent. */
  configText?: string | null;
  /** True when the repository already holds captured content (a non-empty `index.json`). */
  hasContent?: boolean;
  /** Tier a brand-new, empty repository inherits from the settings UI. */
  fallbackMode?: SecurityMode;
  /** Injected clock, for the timestamps of a synthesized config. */
  now?: string;
}

export interface TierResolution {
  /** The tier to use — the recorded one, the new-store default, or the fail-closed mode. */
  mode: SecurityMode;
  source: TierSource;
  /** True for `unknown`: the UI must ask the user before anything is written. */
  requiresUserDecision: boolean;
  /** Effective config. Synthesized when nothing readable exists; `resolveTier` never writes it. */
  config: StoreConfig;
}

/**
 * Decide which tier applies. Pure and injectable.
 *
 * Precedence, in order:
 * 1. a valid `security_mode` in the config wins outright — an existing vault repository is never
 *    downgraded and an existing transparent one is never upgraded behind the user's back;
 * 2. an absent config on a repository that already holds content is *unknown*, not a new store: the
 *    fallback fails closed and the user is asked;
 * 3. an absent config on an empty repository is the brand-new-store default (`fallbackMode`);
 * 4. anything unreadable or unrecognised is *unknown* as well — never guessed.
 */
export function resolveTier(options: ResolveTierOptions = {}): TierResolution {
  const now = options.now ?? new Date().toISOString();
  const fallbackMode = options.fallbackMode ?? DEFAULT_SECURITY_MODE;
  const text = options.configText;
  if (text === null || text === undefined || text.trim() === '') {
    if (options.hasContent === true) {
      // Rule 2: content proves this is not a fresh repository, so the default would be a guess.
      return unknownTier(now);
    }
    return {
      mode: fallbackMode,
      source: 'default',
      requiresUserDecision: false,
      config: createStoreConfig(fallbackMode, now),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return unknownTier(now);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return unknownTier(now);
  const recorded = (parsed as Record<string, unknown>)['security_mode'];
  const mode: SecurityMode | null =
    recorded === 'transparent' || recorded === 'vault' ? recorded : null;
  if (mode === null) return unknownTier(now);
  return {
    mode,
    source: 'config',
    requiresUserDecision: false,
    config: parseStoreConfig(parsed, now, fallbackMode),
  };
}

function unknownTier(now: string): TierResolution {
  return {
    mode: SAFE_FALLBACK_MODE,
    source: 'unknown',
    requiresUserDecision: true,
    config: createStoreConfig(SAFE_FALLBACK_MODE, now),
  };
}

/* ------------------------------------------------------------------ *
 * Pure: `index.json`
 * ------------------------------------------------------------------ */

export function emptyIndex(): IndexFile {
  return { schema: INDEX_SCHEMA_VERSION, items: {} };
}

/**
 * Fixed key order for an index entry.
 *
 * `JSON.stringify` follows insertion order, so without this a round trip through `parseIndex` would
 * reshuffle the keys and every write would produce a spurious diff in the repository. Optional keys
 * are always present in the order and dropped by `JSON.stringify` when undefined, which keeps one
 * order for every record kind.
 */
function canonicalIndexItem(item: IndexItem): IndexItem {
  return {
    id: item.id,
    kind: item.kind,
    path: item.path,
    url_key: item.url_key,
    content_key: item.content_key,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function parseIndexItem(id: string, value: unknown): IndexItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = raw['kind'];
  const path = raw['path'];
  const createdAt = raw['created_at'];
  const updatedAt = raw['updated_at'];
  if (typeof kind !== 'string' || !isRecordKind(kind)) return null;
  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof createdAt !== 'string' || !isIsoTimestamp(createdAt)) return null;
  if (typeof updatedAt !== 'string' || !isIsoTimestamp(updatedAt)) return null;

  // The map key is authoritative, so a hand-edited `id` can never desynchronise the entry.
  const item: IndexItem = { id, kind, path, created_at: createdAt, updated_at: updatedAt };
  const urlKey = raw['url_key'];
  if (typeof urlKey === 'string' && urlKey.length > 0) item.url_key = urlKey;
  const contentKey = raw['content_key'];
  if (typeof contentKey === 'string' && contentKey.length > 0) item.content_key = contentKey;
  return item;
}

/**
 * Tolerant read: an unparseable or absent index is an empty index, and a malformed entry is dropped
 * rather than guessed at. Losing one listing line is recoverable; inventing a path is not.
 */
export function parseIndex(text: string | null | undefined): IndexFile {
  if (typeof text !== 'string' || text.trim() === '') return emptyIndex();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return emptyIndex();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyIndex();
  const rawItems = (parsed as Record<string, unknown>)['items'];
  if (typeof rawItems !== 'object' || rawItems === null || Array.isArray(rawItems)) {
    return emptyIndex();
  }

  const items: Record<string, IndexItem> = {};
  for (const [id, value] of Object.entries(rawItems as Record<string, unknown>)) {
    const item = parseIndexItem(id, value);
    if (item) items[id] = item;
  }
  return { schema: INDEX_SCHEMA_VERSION, items };
}

/** Deterministic serialization: ids sorted and keys canonicalized, so a rewrite is diff-free. */
export function serializeIndex(index: IndexFile): string {
  const items: Record<string, IndexItem> = {};
  for (const id of Object.keys(index.items).sort()) {
    const item = index.items[id];
    if (item) items[id] = canonicalIndexItem(item);
  }
  return `${JSON.stringify({ schema: INDEX_SCHEMA_VERSION, items }, null, 2)}\n`;
}

/**
 * Merge freshly encoded entries into an index. Last write wins — a repeated id is a re-capture, not
 * a conflict (F2 edge case). Neither argument is mutated.
 */
export function mergeIndex(
  base: IndexFile | null | undefined,
  entries: readonly IndexItem[],
): IndexFile {
  const items: Record<string, IndexItem> = {};
  if (base) {
    for (const [id, item] of Object.entries(base.items)) items[id] = item;
  }
  for (const entry of entries) items[entry.id] = entry;
  return { schema: INDEX_SCHEMA_VERSION, items };
}

export function indexItemCount(index: IndexFile): number {
  return Object.keys(index.items).length;
}

export function isIndexEmpty(index: IndexFile): boolean {
  return indexItemCount(index) === 0;
}

export function findIndexItem(index: IndexFile, id: string): IndexItem | null {
  return index.items[id] ?? null;
}

export type IndexKeyField = 'url_key' | 'content_key';

/** The keyless dedup probe (F1): find an existing capture without reading any content file. */
export function findIndexItemByKey(
  index: IndexFile,
  field: IndexKeyField,
  value: string,
): IndexItem | null {
  if (value === '') return null;
  for (const item of Object.values(index.items)) {
    if (item[field] === value) return item;
  }
  return null;
}

export function indexToFile(index: IndexFile, prefix?: string | null): RepoFile {
  return { path: indexPath(prefix), content: serializeIndex(index) };
}

/* ------------------------------------------------------------------ *
 * Codec selection
 * ------------------------------------------------------------------ */

export interface SelectCodecOptions {
  /** Store-wide KDF parameters from the `secretVault` envelope. Required in vault mode. */
  kdf?: VaultKdf | null;
  prefix?: string | null;
  now?: () => number;
}

/**
 * The one place a tier becomes a codec.
 *
 * `session` may be `null` (or locked) and the codec is still returned: the vault codec fails closed
 * per operation, which keeps "the vault is locked" a recoverable runtime state rather than a
 * construction error.
 */
export function selectCodec(
  mode: SecurityMode,
  session: KeySession | null,
  crypto?: CryptoProvider,
  options: SelectCodecOptions = {},
): ContentCodec {
  const shared = { prefix: options.prefix ?? null, now: options.now };
  if (mode === 'transparent') return createTransparentCodec(shared);
  if (!options.kdf) {
    throw new TierConfigError(
      'tier: vault mode needs the store KDF parameters — set a vault passphrase first',
    );
  }
  return createVaultCodec({ ...shared, session, kdf: options.kdf, crypto });
}

/* ------------------------------------------------------------------ *
 * Store-bound operations
 * ------------------------------------------------------------------ */

/**
 * The narrow slice of `KnowledgeStore` this layer needs. A full `KnowledgeStore` satisfies it
 * structurally, and a test fake can implement just these two members.
 */
export interface TierStore {
  readFile(path: string): Promise<string | null>;
  commitFiles(files: RepoFile[], message: string): Promise<CommitResult>;
}

export interface TierContext {
  store: TierStore;
  prefix?: string | null;
  /** Injected clock (deterministic tests). */
  now?: () => number;
  /**
   * Version of the running client, injected by the composition root instead of read from
   * `browser.runtime` here so this layer stays pure and testable; recorded as `client_version` on the
   * next config write.
   */
  clientVersion?: string;
}

function nowIso(context: TierContext): string {
  return new Date((context.now ?? Date.now)()).toISOString();
}

export async function loadStoreConfig(
  context: TierContext,
  fallbackMode: SecurityMode = DEFAULT_SECURITY_MODE,
): Promise<StoreConfig> {
  const text = await context.store.readFile(storeConfigPath(context.prefix));
  // `index.json` is the catalogue in every layout version (0.1.0 included), so it is the authoritative
  // content probe; the extra read only happens on the ambiguous path where the config is missing.
  const hasContent = text === null || text.trim() === '' ? await storeHasContent(context) : false;
  return resolveTier({ configText: text, hasContent, fallbackMode, now: nowIso(context) }).config;
}

async function storeHasContent(context: TierContext): Promise<boolean> {
  return !isIndexEmpty(parseIndex(await context.store.readFile(indexPath(context.prefix))));
}

export async function saveStoreConfig(
  context: TierContext,
  config: StoreConfig,
  message: string = CONFIG_COMMIT_MESSAGE,
): Promise<StoreConfig> {
  const next = canonicalStoreConfig({
    ...config,
    // Whoever writes now is the writer of record; the injected version wins over whatever the file
    // claimed.
    client_version: context.clientVersion ?? config.client_version,
    updated_at: nowIso(context),
  });
  await context.store.commitFiles(
    [{ path: storeConfigPath(context.prefix), content: serializeStoreConfig(next) }],
    message,
  );
  return next;
}

export interface SwitchTierOptions extends TierContext {
  to: SecurityMode;
  /** The already-loaded config, to avoid a second read. */
  current?: StoreConfig;
  message?: string;
}

/**
 * Switch the store's confidentiality tier, or refuse.
 *
 * Allowed only when the store holds no items: the MVP has no re-encode migration, so flipping the
 * tier on a used store would leave every existing file unreadable by the new codec. Switching to the
 * tier already in force is an idempotent no-op.
 */
export async function switchTier(options: SwitchTierOptions): Promise<StoreConfig> {
  const current = options.current ?? (await loadStoreConfig(options));
  if (current.security_mode === options.to) return current;

  const index = parseIndex(await options.store.readFile(indexPath(options.prefix)));
  const itemCount = indexItemCount(index);
  if (itemCount > 0) {
    throw new TierMigrationRequiredError(current.security_mode, options.to, itemCount);
  }

  return saveStoreConfig(
    options,
    { ...current, security_mode: options.to },
    options.message ?? `config: switch content tier to ${options.to}`,
  );
}
