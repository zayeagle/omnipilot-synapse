/**
 * Settings and secret custody.
 *
 * Two storage layers, deliberately kept apart:
 * - `local:settings` — non-secret configuration, safe to read from anywhere in the extension;
 * - `local:secretVault` — a single AES-GCM envelope holding the GitHub token and the provider key.
 *
 * The vault is the only place a credential is ever written. There is no plaintext fallback: if the
 * vault is locked, secret reads fail closed (SC-F3-03), and `local:publicPrefs` is a projection that
 * can express "a token exists" without ever containing one (TC-F8-U01).
 */

import type { AuthMode, SecurityMode, SyncPolicy } from './messages';
import {
  DEFAULT_SYNC_STATE,
  PUBLIC_PREFS_KEY,
  type CompanionState,
  type PublicPrefs,
  type PublicSyncState,
} from './public-prefs';
import {
  createEnvelope,
  deriveKeyFromEnvelope,
  encryptText,
  openEnvelopeWithKey,
  parseEnvelope,
  type EncryptedEnvelope,
} from './security/crypto-key';
import { base64ToBytes, bytesToBase64 } from './security/base64';
import { KeySession, VaultLockedError, clampTtl } from './security/key-session';

export type { PublicPrefs };

export const STORAGE_KEYS = {
  settings: 'local:settings',
  secretVault: 'local:secretVault',
  publicPrefs: PUBLIC_PREFS_KEY,
  captureQueue: 'local:captureQueue',
  aiLedger: 'local:aiLedger',
  sessionKey: 'session:vaultKey',
  /** Non-secret policy plus the key it authorizes; one record so the two cannot drift apart. */
  unlockPolicy: 'local:unlockPolicy',
} as const;

export const SCHEMA_VERSION = 1;
export const DEFAULT_API_BASE = 'https://api.github.com';
export const MIN_AUTO_LOCK_MINUTES = 1;
export const MAX_AUTO_LOCK_MINUTES = 720;

export interface GithubConfig {
  owner: string;
  repo: string;
  branch: string;
  pathPrefix: string;
  apiBase: string;
  publicRepoAcknowledged: boolean;
}

/**
 * SSH authorization settings.
 *
 * `keyRef` is an **identifier the companion resolves** (`default`, or a name it reported through
 * `key.list`) — never a path the extension reads, and never key material. The extension cannot see a
 * private key even if it wanted to.
 *
 * `repoRoot` is the user's **local clone** of the knowledge repository. SSH mode works through the
 * user's own `git`, which needs a working tree on disk; the companion confines every path it touches
 * to this directory and refuses anything outside it.
 */
export interface SshConfig {
  host: string;
  user: string;
  keyRef: string;
  repoRoot: string;
}

export const DEFAULT_SSH: SshConfig = {
  host: 'github.com',
  user: 'git',
  keyRef: 'default',
  repoRoot: '',
};

export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  intervalMinutes: 30,
  onStartup: true,
  onCapture: true,
  pullOnly: false,
};

export interface AiConfig {
  providerId: string;
  model: string;
  baseUrl: string;
  trustedHosts: string[];
}

export interface ExtensionSettings {
  schemaVersion: typeof SCHEMA_VERSION;
  enabled: boolean;
  aiAuthorized: boolean;
  securityMode: SecurityMode;
  /**
   * Whether the user has explicitly chosen the content tier on this installation.
   *
   * `false` is not "vault" and it is not "transparent": it means the question has not been
   * answered here yet, and the storage page must ask before it can save (T7). Existing installs
   * upgrade to `false` and are asked once, with their current tier pre-selected.
   */
  contentTierChosen: boolean;
  autoLockMinutes: number;
  storeKind: 'github';
  /** Which authorization mode remote operations use. */
  authMode: AuthMode;
  github: GithubConfig;
  ssh: SshConfig;
  syncPolicy: SyncPolicy;
  ai: AiConfig;
}

export interface SecretPayload {
  githubPat: string;
  providerKey: string;
}

/**
 * How the vault session survives a restart.
 *
 * `strict` keeps the derived key in memory only: a browser restart means re-entering the passphrase.
 * `remember` exports that key to local storage so the next start adopts it, which lowers the gate from
 * knows-the-passphrase to can-read-this-browser-profile. The options page states that next to the
 * control, and `strict` stays one click away. Neither setting touches the crypto: the envelope, the
 * cached records and the capture queue stay sealed either way, so this is a gate, not a plaintext mode.
 */
export type UnlockPolicy = 'strict' | 'remember';

/** The remembered key is a convenience, not a session: it may outlive an idle lock, not a profile. */
export const REMEMBERED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface VaultStatus {
  configured: boolean;
  unlocked: boolean;
  expiresAt: number | null;
  remainingMs: number;
  /** How the session survives a restart; see `UnlockPolicy`. */
  unlockPolicy: UnlockPolicy;
}

export interface StorageAreaLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface SettingsPatch {
  enabled?: boolean;
  aiAuthorized?: boolean;
  securityMode?: SecurityMode;
  contentTierChosen?: boolean;
  autoLockMinutes?: number;
  authMode?: AuthMode;
  github?: Partial<GithubConfig>;
  ssh?: Partial<SshConfig>;
  syncPolicy?: Partial<SyncPolicy>;
  ai?: Partial<AiConfig>;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  schemaVersion: SCHEMA_VERSION,
  enabled: true,
  aiAuthorized: false,
  /**
   * Readable Markdown is the default tier: the product asks for a repository a human can read, and
   * the encrypted tier stays one explicit choice away with its existing warning. An existing store
   * keeps whatever `.omnipilot/config.json` records — see `resolveTier`.
   */
  securityMode: 'transparent',
  contentTierChosen: false,
  autoLockMinutes: 30,
  storeKind: 'github',
  authMode: 'token',
  github: {
    owner: '',
    repo: '',
    branch: 'main',
    pathPrefix: '',
    apiBase: DEFAULT_API_BASE,
    publicRepoAcknowledged: false,
  },
  ssh: { ...DEFAULT_SSH },
  syncPolicy: { ...DEFAULT_SYNC_POLICY },
  ai: {
    providerId: 'openai',
    model: '',
    baseUrl: '',
    trustedHosts: [],
  },
};

export const EMPTY_SECRETS: SecretPayload = { githubPat: '', providerKey: '' };

/* ------------------------------ pure helpers ------------------------------ */

export function clampAutoLock(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_SETTINGS.autoLockMinutes;
  return Math.min(MAX_AUTO_LOCK_MINUTES, Math.max(MIN_AUTO_LOCK_MINUTES, Math.round(minutes)));
}

export function repoFullName(github: Pick<GithubConfig, 'owner' | 'repo'>): string {
  return github.owner && github.repo ? `${github.owner}/${github.repo}` : '';
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function cloneSettings(settings: ExtensionSettings): ExtensionSettings {
  return {
    ...settings,
    github: { ...settings.github },
    ssh: { ...settings.ssh },
    syncPolicy: { ...settings.syncPolicy },
    ai: { ...settings.ai, trustedHosts: [...settings.ai.trustedHosts] },
  };
}

function asAuthMode(value: unknown, fallback: AuthMode): AuthMode {
  return value === 'ssh' ? 'ssh' : value === 'token' ? 'token' : fallback;
}

function normalizeSyncPolicy(value: unknown): SyncPolicy {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SYNC_POLICY };
  const raw = value as Record<string, unknown>;
  const minutes = raw['intervalMinutes'];
  return {
    intervalMinutes:
      typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0
        ? Math.min(24 * 60, Math.round(minutes))
        : DEFAULT_SYNC_POLICY.intervalMinutes,
    onStartup: asBoolean(raw['onStartup'], DEFAULT_SYNC_POLICY.onStartup),
    onCapture: asBoolean(raw['onCapture'], DEFAULT_SYNC_POLICY.onCapture),
    pullOnly: asBoolean(raw['pullOnly'], DEFAULT_SYNC_POLICY.pullOnly),
  };
}

/** Tolerant load: unknown or corrupt fields fall back to defaults instead of breaking the worker. */
export function normalizeSettings(value: unknown): ExtensionSettings {
  if (typeof value !== 'object' || value === null) return cloneSettings(DEFAULT_SETTINGS);
  const raw = value as Record<string, unknown>;
  const githubRaw = (
    typeof raw['github'] === 'object' && raw['github'] !== null ? raw['github'] : {}
  ) as Record<string, unknown>;
  const aiRaw = (
    typeof raw['ai'] === 'object' && raw['ai'] !== null ? raw['ai'] : {}
  ) as Record<string, unknown>;
  const securityMode: SecurityMode = raw['securityMode'] === 'transparent' ? 'transparent' : 'vault';
  const sshRaw = (
    typeof raw['ssh'] === 'object' && raw['ssh'] !== null ? raw['ssh'] : {}
  ) as Record<string, unknown>;

  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: asBoolean(raw['enabled'], DEFAULT_SETTINGS.enabled),
    aiAuthorized: asBoolean(raw['aiAuthorized'], DEFAULT_SETTINGS.aiAuthorized),
    securityMode,
    // Only an explicit `true` counts: an absent or junk value keeps asking rather than assuming.
    contentTierChosen: raw['contentTierChosen'] === true,
    autoLockMinutes: clampAutoLock(
      typeof raw['autoLockMinutes'] === 'number'
        ? raw['autoLockMinutes']
        : DEFAULT_SETTINGS.autoLockMinutes,
    ),
    storeKind: 'github',
    authMode: asAuthMode(raw['authMode'], DEFAULT_SETTINGS.authMode),
    github: {
      owner: asString(githubRaw['owner'], ''),
      repo: asString(githubRaw['repo'], ''),
      branch: asString(githubRaw['branch'], DEFAULT_SETTINGS.github.branch),
      pathPrefix: asString(githubRaw['pathPrefix'], ''),
      apiBase: asString(githubRaw['apiBase'], DEFAULT_API_BASE) || DEFAULT_API_BASE,
      publicRepoAcknowledged: asBoolean(githubRaw['publicRepoAcknowledged'], false),
    },
    ssh: {
      host: asString(sshRaw['host'], DEFAULT_SSH.host) || DEFAULT_SSH.host,
      user: asString(sshRaw['user'], DEFAULT_SSH.user) || DEFAULT_SSH.user,
      keyRef: asString(sshRaw['keyRef'], DEFAULT_SSH.keyRef) || DEFAULT_SSH.keyRef,
      repoRoot: asString(sshRaw['repoRoot'], ''),
    },
    syncPolicy: normalizeSyncPolicy(raw['syncPolicy']),
    ai: {
      providerId: asString(aiRaw['providerId'], DEFAULT_SETTINGS.ai.providerId),
      model: asString(aiRaw['model'], ''),
      baseUrl: asString(aiRaw['baseUrl'], ''),
      trustedHosts: asStringArray(aiRaw['trustedHosts'], []),
    },
  };
}

export function mergeSettings(current: ExtensionSettings, patch: SettingsPatch): ExtensionSettings {
  const next = cloneSettings(current);
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.aiAuthorized !== undefined) next.aiAuthorized = patch.aiAuthorized;
  if (patch.securityMode !== undefined) next.securityMode = patch.securityMode;
  if (patch.contentTierChosen !== undefined) next.contentTierChosen = patch.contentTierChosen;
  if (patch.autoLockMinutes !== undefined) {
    next.autoLockMinutes = clampAutoLock(patch.autoLockMinutes);
  }
  if (patch.github) next.github = { ...next.github, ...patch.github };
  if (patch.ssh) next.ssh = { ...next.ssh, ...patch.ssh };
  if (patch.authMode !== undefined) next.authMode = patch.authMode;
  if (patch.syncPolicy) next.syncPolicy = normalizeSyncPolicy({ ...next.syncPolicy, ...patch.syncPolicy });
  if (patch.ai) {
    next.ai = {
      ...next.ai,
      ...patch.ai,
      trustedHosts: patch.ai.trustedHosts ? [...patch.ai.trustedHosts] : [...next.ai.trustedHosts],
    };
  }
  return next;
}

/** Companion + sync state, supplied by the worker because it is not part of the stored settings. */
export interface PublicPrefsExtra {
  companion?: CompanionState;
  sync?: PublicSyncState;
}

/**
 * The projection content scripts and the popup are allowed to see.
 * It can say *whether* a credential exists; it can never carry one.
 */
export function toPublicPrefs(
  settings: ExtensionSettings,
  secrets: SecretPayload | null,
  vault: VaultStatus,
  extra: PublicPrefsExtra = {},
): PublicPrefs {
  return {
    enabled: settings.enabled,
    storeKind: settings.storeKind,
    repoFullName: repoFullName(settings.github),
    securityMode: settings.securityMode,
    hasPat: Boolean(secrets?.githubPat),
    hasKey: Boolean(secrets?.providerKey),
    vaultLocked: !vault.unlocked,
    aiAuthorized: settings.aiAuthorized,
    authMode: settings.authMode,
    branch: settings.github.branch,
    sshHost: settings.ssh.host,
    companion: extra.companion ?? 'missing',
    sync: extra.sync ?? { ...DEFAULT_SYNC_STATE },
  };
}

export function parseSecrets(value: unknown): SecretPayload {
  if (typeof value !== 'object' || value === null) return { ...EMPTY_SECRETS };
  const raw = value as Record<string, unknown>;
  return {
    githubPat: asString(raw['githubPat'], ''),
    providerKey: asString(raw['providerKey'], ''),
  };
}

/* ------------------------------- the store ------------------------------- */

interface CryptoKeyProvider {
  subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

export interface SettingsStoreOptions {
  area: StorageAreaLike;
  session?: KeySession;
  crypto?: CryptoKeyProvider;
  now?: () => number;
  /** KDF work factor. Overridable so tests stay fast; production uses the default. */
  iterations?: number;
}

export class SettingsStore {
  private readonly area: StorageAreaLike;
  readonly session: KeySession | null;
  private readonly cryptoProvider: CryptoKeyProvider | undefined;
  private readonly now: () => number;
  private readonly iterations: number | undefined;

  constructor(options: SettingsStoreOptions) {
    this.area = options.area;
    this.session = options.session ?? null;
    this.cryptoProvider = options.crypto;
    this.now = options.now ?? Date.now;
    this.iterations = options.iterations;
  }

  async load(): Promise<ExtensionSettings> {
    const stored = await this.area.get(STORAGE_KEYS.settings);
    return normalizeSettings(stored[STORAGE_KEYS.settings]);
  }

  async save(settings: ExtensionSettings): Promise<ExtensionSettings> {
    const normalized = normalizeSettings(settings);
    await this.area.set({ [STORAGE_KEYS.settings]: normalized });
    await this.refreshPublicPrefs(normalized);
    return normalized;
  }

  async patch(patch: SettingsPatch): Promise<ExtensionSettings> {
    const current = await this.load();
    return this.save(mergeSettings(current, patch));
  }

  /**
   * The stored unlock policy. An absent or unreadable value means `strict`: an install that never
   * answered the question must not start remembering keys.
   */
  async getUnlockPolicy(): Promise<UnlockPolicy> {
    const stored = await this.area.get(STORAGE_KEYS.unlockPolicy);
    const raw = stored[STORAGE_KEYS.unlockPolicy];
    const policy = typeof raw === 'object' && raw !== null ? (raw as { policy?: unknown }).policy : undefined;
    if (policy === 'strict' || policy === 'remember') return policy;
    // The owner's chosen default. It is disclosed on the Security page next to the control, and `strict`
    // is one click away - a default that lowers a gate has to be visible, not silent.
    return 'remember';
  }

  /** Switching policy also settles the key: strict must not leave a usable one behind. */
  async setUnlockPolicy(policy: UnlockPolicy): Promise<void> {
    await this.area.set({ [STORAGE_KEYS.unlockPolicy]: { policy } });
    if (policy === 'strict') await this.refreshPublicPrefs();
  }

  /** The remembered key, or null. Never throws: a corrupt value is simply not a key. */
  private async readRememberedKey(): Promise<string | null> {
    const stored = await this.area.get(STORAGE_KEYS.unlockPolicy);
    const raw = stored[STORAGE_KEYS.unlockPolicy];
    const key = typeof raw === 'object' && raw !== null ? (raw as { key?: unknown }).key : undefined;
    return typeof key === 'string' && key.length > 0 ? key : null;
  }

  /** Drop the remembered key. An explicit lock, or leaving remember mode, must mean exactly that. */
  async forgetRememberedKey(): Promise<void> {
    const policy = await this.getUnlockPolicy();
    await this.area.set({ [STORAGE_KEYS.unlockPolicy]: { policy } });
  }

  /** Export the live key for the next start. Only under the remember policy; never a plaintext secret. */
  private async rememberKey(key: CryptoKey): Promise<void> {
    if ((await this.getUnlockPolicy()) !== 'remember') return;
    const subtle = this.cryptoProvider?.subtle;
    if (!subtle) return;
    try {
      const raw = await subtle.exportKey('raw', key);
      await this.area.set({
        [STORAGE_KEYS.unlockPolicy]: { policy: 'remember', key: bytesToBase64(new Uint8Array(raw)) },
      });
    } catch {
      // A key that cannot be exported is not a reason to fail an unlock; the policy just does nothing.
    }
  }

  /**
   * Adopt the remembered key when the policy allows it. Returns whether the session is unlocked now,
   * so the worker can report it without knowing how the key was kept.
   */
  async restoreRememberedKey(): Promise<boolean> {
    if (!this.session) return false;
    if ((await this.getUnlockPolicy()) !== 'remember') return false;
    const stored = await this.readRememberedKey();
    if (stored === null) return false;
    const subtle = this.cryptoProvider?.subtle;
    if (!subtle) return false;
    try {
      const key = await subtle.importKey(
        'raw',
        new Uint8Array(base64ToBytes(stored)),
        { name: 'AES-GCM' },
        true,
        ['encrypt', 'decrypt'],
      );
      // Remembering means not asking again: the idle lock is for a session opened by hand.
      this.session.setTtl(REMEMBERED_TTL_MS);
      await this.session.adopt(key, this.now());
      await this.refreshPublicPrefs();
      return true;
    } catch {
      await this.forgetRememberedKey();
      return false;
    }
  }

  async getEnvelope(): Promise<EncryptedEnvelope | null> {
    const stored = await this.area.get(STORAGE_KEYS.secretVault);
    const raw = stored[STORAGE_KEYS.secretVault];
    if (raw === undefined || raw === null) return null;
    try {
      return parseEnvelope(raw);
    } catch {
      // A corrupt envelope is reported as "no vault" so the user can set one up again.
      return null;
    }
  }

  async vaultStatus(): Promise<VaultStatus> {
    const envelope = await this.getEnvelope();
    const status = this.session?.status(this.now());
    return {
      configured: envelope !== null,
      unlocked: status?.unlocked ?? false,
      expiresAt: status?.expiresAt ?? null,
      remainingMs: status?.remainingMs ?? 0,
      unlockPolicy: await this.getUnlockPolicy(),
    };
  }

  /**
   * Create the vault, or re-key an existing one. Adopts the derived key so the session starts unlocked.
   *
   * Re-keying is the one irreversible thing this file does: the new envelope REPLACES the old one, so
   * every secret the caller does not pass is gone for good. Two rules stop that from happening by
   * accident — the readable secrets are carried forward, and when they cannot be read (the vault is
   * locked) the call is refused rather than allowed to destroy what it cannot see. An irreversible
   * action has to be asked for, not fallen into.
   */
  async setupVault(
    passphrase: string,
    secrets: Partial<SecretPayload> = {},
    options: { replaceSecrets?: boolean } = {},
  ): Promise<void> {
    let carried: Partial<SecretPayload> = {};
    if (await this.getEnvelope()) {
      const readable = await this.peekSecrets();
      if (readable) {
        carried = readable;
      } else if (options.replaceSecrets !== true) {
        throw new VaultLockedError('vault: unlock first — re-keying a locked vault would discard the stored secrets');
      }
    }
    const payload: SecretPayload = { ...EMPTY_SECRETS, ...carried, ...secrets };
    const envelope = await createEnvelope(passphrase, JSON.stringify(payload), {
      crypto: this.cryptoProvider,
      iterations: this.iterations,
    });
    await this.area.set({ [STORAGE_KEYS.secretVault]: envelope });
    if (this.session) {
      const key = await deriveKeyFromEnvelope(passphrase, envelope, {
        crypto: this.cryptoProvider,
        extractable: true,
      });
      await this.session.adopt(key, this.now());
      await this.rememberKey(key);
    }
    await this.refreshPublicPrefs();
  }

  async unlock(passphrase: string): Promise<SecretPayload> {
    const envelope = await this.getEnvelope();
    if (!envelope) throw new VaultLockedError('vault: not configured');
    const key = await deriveKeyFromEnvelope(passphrase, envelope, {
      crypto: this.cryptoProvider,
      extractable: true,
    });
    // Throws WrongPassphraseError when the passphrase or the ciphertext is wrong.
    const plaintext = await openEnvelopeWithKey(key, envelope, this.cryptoProvider);
    if (this.session) await this.session.adopt(key, this.now());
    await this.rememberKey(key);
    await this.refreshPublicPrefs();
    return parseSecrets(JSON.parse(plaintext) as unknown);
  }

  async lock(): Promise<void> {
    await this.session?.lock();
    // An explicit lock forgets the remembered key: otherwise "lock" would mean "until the next request",
    // which is not what the button says.
    await this.forgetRememberedKey();
    await this.refreshPublicPrefs();
  }

  /** Secrets, or throw `VaultLockedError`. There is no unencrypted path. */
  async getSecrets(): Promise<SecretPayload> {
    if (!this.session) throw new VaultLockedError('vault: no session configured');
    const envelope = await this.getEnvelope();
    if (!envelope) throw new VaultLockedError('vault: not configured');
    const key = this.session.requireKey(this.now());
    const plaintext = await openEnvelopeWithKey(key, envelope, this.cryptoProvider);
    return parseSecrets(JSON.parse(plaintext) as unknown);
  }

  /** Merge a patch into the vault. Requires an unlocked session; reuses the existing KDF params. */
  async updateSecrets(patch: Partial<SecretPayload>): Promise<void> {
    const envelope = await this.getEnvelope();
    if (!envelope) throw new VaultLockedError('vault: not configured');
    if (!this.session) throw new VaultLockedError('vault: no session configured');
    const key = this.session.requireKey(this.now());
    const current = await this.getSecrets();
    const merged: SecretPayload = { ...current, ...patch };
    const cipher = await encryptText(key, JSON.stringify(merged), this.cryptoProvider);
    const next: EncryptedEnvelope = {
      ...envelope,
      iv_b64: cipher.iv_b64,
      cipher_b64: cipher.cipher_b64,
    };
    await this.area.set({ [STORAGE_KEYS.secretVault]: next });
    await this.refreshPublicPrefs();
  }

  /** Secrets when the vault happens to be unlocked — used for badges and for secret scrubbing. */
  async peekSecrets(): Promise<SecretPayload | null> {
    if (!this.session?.isUnlocked(this.now())) return null;
    try {
      return await this.getSecrets();
    } catch {
      return null;
    }
  }

  async publicPrefs(extra: PublicPrefsExtra = {}): Promise<PublicPrefs> {
    const settings = await this.load();
    return toPublicPrefs(settings, await this.peekSecrets(), await this.vaultStatus(), extra);
  }

  /** Write the content-script-safe projection. Never includes a credential value. */
  async refreshPublicPrefs(
    settings?: ExtensionSettings,
    extra: PublicPrefsExtra = {},
  ): Promise<PublicPrefs> {
    const resolved = settings ?? (await this.load());
    const prefs = toPublicPrefs(
      resolved,
      await this.peekSecrets(),
      await this.vaultStatus(),
      extra,
    );
    await this.area.set({ [STORAGE_KEYS.publicPrefs]: prefs });
    return prefs;
  }

  /** Non-secret export for backup. Reports secret presence, never secret values. */
  async exportConfig(): Promise<Record<string, unknown>> {
    const settings = await this.load();
    const vault = await this.vaultStatus();
    const secrets = await this.peekSecrets();
    return {
      exportedAt: new Date(this.now()).toISOString(),
      settings,
      vault,
      secretsPresent: {
        githubPat: Boolean(secrets?.githubPat),
        providerKey: Boolean(secrets?.providerKey),
      },
    };
  }

  async reset(): Promise<void> {
    await this.session?.lock();
    await this.area.remove([
      STORAGE_KEYS.settings,
      STORAGE_KEYS.secretVault,
      STORAGE_KEYS.publicPrefs,
      STORAGE_KEYS.captureQueue,
      STORAGE_KEYS.aiLedger,
      STORAGE_KEYS.unlockPolicy,
    ]);
  }

  /** Effective auto-lock TTL for the vault session, in milliseconds. */
  autoLockTtlMs(settings: ExtensionSettings): number {
    return clampTtl(settings.autoLockMinutes * 60_000);
  }
}

/** In-memory `StorageAreaLike` for tests and for contexts without extension storage. */
export class MemoryStorageArea implements StorageAreaLike {
  private readonly data = new Map<string, unknown>();

  constructor(initial: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initial)) this.data.set(key, value);
  }

  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const key of list) {
      if (this.data.has(key)) out[key] = this.data.get(key);
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key);
  }

  keys(): string[] {
    return [...this.data.keys()].sort();
  }
}
