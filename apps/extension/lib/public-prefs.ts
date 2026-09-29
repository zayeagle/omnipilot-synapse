/**
 * The content-script-facing projection of the settings.
 *
 * This module is a LEAF on purpose: it imports nothing, so the content-script bundle can read the
 * projection without pulling in the vault, the crypto layer or the storage key table. That is what
 * makes the build-time assertion in `scripts/assert-content-no-secrets.mjs` meaningful — a page
 * context can only ever learn whether a credential exists, never what it is.
 */

export const PUBLIC_PREFS_KEY = 'local:publicPrefs';

export type PublicSecurityMode = 'vault' | 'transparent';
export type PublicAuthMode = 'token' | 'ssh';
export type CompanionState = 'ok' | 'missing' | 'mismatch';
export type PublicSyncOutcome =
  | 'never'
  | 'upToDate'
  | 'pulled'
  | 'pushed'
  | 'merged'
  | 'conflict'
  | 'failed'
  | 'busy';

/** Sync state as the UI sees it — counts and timestamps, never content. */
export interface PublicSyncState {
  lastSyncAt: string | null;
  lastOutcome: PublicSyncOutcome;
  /**
   * The **code** of the last failure, so the surface can render its own translated guidance.
   *
   * A code, never the worker's sentence: an outside string rendered in a page is exactly what the whole
   * secret-hygiene design avoids.
   */
  lastFailureCode: string | null;
  /** Locally changed paths waiting to be pushed. */
  pending: number;
  /** Paths where both sides changed and both versions were kept. */
  conflicts: number;
}

export interface PublicPrefs {
  enabled: boolean;
  storeKind: 'github';
  repoFullName: string;
  securityMode: PublicSecurityMode;
  hasPat: boolean;
  hasKey: boolean;
  vaultLocked: boolean;
  aiAuthorized: boolean;
  authMode: PublicAuthMode;
  /** The branch remote operations use — `main` unless the user overrode it. */
  branch: string;
  /** SSH host, shown so the user can confirm which remote the companion will use. */
  sshHost: string;
  /** Whether the companion process is usable right now. */
  companion: CompanionState;
  sync: PublicSyncState;
}

export const DEFAULT_SYNC_STATE: PublicSyncState = {
  lastSyncAt: null,
  lastOutcome: 'never',
  lastFailureCode: null,
  pending: 0,
  conflicts: 0,
};

export const DEFAULT_PUBLIC_PREFS: PublicPrefs = {
  enabled: true,
  storeKind: 'github',
  repoFullName: '',
  securityMode: 'transparent',
  hasPat: false,
  hasKey: false,
  vaultLocked: true,
  aiAuthorized: false,
  authMode: 'token',
  branch: 'main',
  sshHost: 'github.com',
  companion: 'missing',
  sync: { ...DEFAULT_SYNC_STATE },
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function normalizeSyncState(value: unknown): PublicSyncState {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SYNC_STATE };
  const raw = value as Record<string, unknown>;
  const outcome = raw['lastOutcome'];
  const allowed: PublicSyncOutcome[] = [
    'never',
    'upToDate',
    'pulled',
    'pushed',
    'merged',
    'conflict',
    'failed',
    'busy',
  ];
  return {
    lastSyncAt: typeof raw['lastSyncAt'] === 'string' ? raw['lastSyncAt'] : null,
    lastOutcome:
      typeof outcome === 'string' && (allowed as string[]).includes(outcome)
        ? (outcome as PublicSyncOutcome)
        : 'never',
    pending: count(raw['pending']),
    conflicts: count(raw['conflicts']),
    lastFailureCode: typeof raw['lastFailureCode'] === 'string' ? raw['lastFailureCode'] : null,
  };
}

/** Defensive read: the projection is written by the worker but read from an untrusted context. */
export function normalizePublicPrefs(value: unknown): PublicPrefs {
  if (typeof value !== 'object' || value === null) return structuredClonePrefs(DEFAULT_PUBLIC_PREFS);
  const raw = value as Record<string, unknown>;
  const companion = raw['companion'];
  return {
    enabled: bool(raw['enabled'], DEFAULT_PUBLIC_PREFS.enabled),
    storeKind: 'github',
    repoFullName: str(raw['repoFullName'], ''),
    securityMode: raw['securityMode'] === 'vault' ? 'vault' : 'transparent',
    hasPat: bool(raw['hasPat'], false),
    hasKey: bool(raw['hasKey'], false),
    vaultLocked: bool(raw['vaultLocked'], true),
    aiAuthorized: bool(raw['aiAuthorized'], false),
    authMode: raw['authMode'] === 'ssh' ? 'ssh' : 'token',
    branch: str(raw['branch'], DEFAULT_PUBLIC_PREFS.branch) || DEFAULT_PUBLIC_PREFS.branch,
    sshHost: str(raw['sshHost'], DEFAULT_PUBLIC_PREFS.sshHost) || DEFAULT_PUBLIC_PREFS.sshHost,
    companion:
      companion === 'ok' || companion === 'mismatch' ? companion : 'missing',
    sync: normalizeSyncState(raw['sync']),
  };
}

function structuredClonePrefs(prefs: PublicPrefs): PublicPrefs {
  return { ...prefs, sync: { ...prefs.sync } };
}

export function isConfigured(prefs: PublicPrefs): boolean {
  if (prefs.repoFullName.length === 0) return false;
  // Token mode needs a token; SSH mode needs the companion instead.
  return prefs.authMode === 'ssh' ? prefs.companion === 'ok' : prefs.hasPat;
}
