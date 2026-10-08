/**
 * Presentation logic for the two human surfaces (popup console + options page).
 *
 * Everything here is a PURE function: no DOM, no `browser`, no network, no storage. That is what
 * lets `entrypoints/popup/main.ts` and `entrypoints/options/main.ts` stay thin — they only build
 * nodes and call these helpers — and it is what makes the whole interface testable in Node.
 *
 * Two rules are load-bearing and are enforced by the shapes below:
 * - nothing in this module ever reads or returns a credential *value*; `maskSecret` is a constant,
 *   `secretsPresence` collapses the export to two booleans, and every row builder is a whitelist
 *   projection (unknown fields are dropped, never spread);
 * - every user-visible sentence comes from `lib/i18n.ts`, and every bounded value is trimmed and
 *   length-capped before it can reach a node's `textContent`.
 */

import { t, type Lang } from '../i18n';
import {
  SYNC_INTERVAL_MAX,
  SYNC_INTERVAL_MIN,
  errorKeyFor,
  type CaptureRequestPayload,
  type DistillRequestPayload,
  type ErrorCode,
  type GithubSettingsPayload,
  type ProviderSettingsPayload,
  type SecurityMode,
  type SecuritySettingsPayload,
  type SyncPolicyPayload,
} from '../messages';
import { PROVIDERS, isValidBaseUrl, requiresTrustAck, resolveProvider } from '../providers';
import { DEFAULT_PUBLIC_PREFS, normalizePublicPrefs, type PublicPrefs } from '../public-prefs';
import {
  canSaveStorageSection,
  captureReadiness,
  isPublicRepoWarning,
  readinessLabel,
  statusLine,
  syncLineParts,
  visibilityLabel,
  type CaptureReadiness,
  type StatusLine,
} from '../status';
import {
  branchCheckFromProbe,
  branchNotice,
  repoFileUrl,
  type BranchCheck,
  type BranchNotice,
} from './auth-form';

export type { BranchCheck, BranchNotice };
import type { RepoVisibility, StoreProbe } from '../store/types';

/* --------------------------------- helpers -------------------------------- */

/** Object narrowing that never throws and never treats an array as a record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Trim, collapse control characters and cap the length of any string that came from outside the
 * UI (a page title, a repository path, a ledger row). Control characters are removed rather than
 * escaped because they are never legitimate here and would otherwise break the layout.
 */
export function safeText(value: unknown, maxChars = 120): string {
  if (typeof value !== 'string') return '';
  // Control characters are dropped deliberately: they are never legitimate here and would break
  // the layout (or a toasting line) if they reached `textContent`.
  const cleaned = value.replace(/[\u0000-\u001F\u007F]+/gu, ' ').trim();
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
  if (limit === 0) return '';
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, Math.max(0, limit - 1))}…`;
}

/* ------------------------------- secret masks ------------------------------ */

export const MASK_CHAR = '•';
/** Fixed width: a mask that grew with the secret would leak the secret's length. */
export const MASK_WIDTH = 8;

/**
 * A masked stand-in for a stored credential. It is deliberately a CONSTANT — it reveals neither the
 * value nor its length — so it can be rendered anywhere without a second thought.
 */
export function maskSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return MASK_CHAR.repeat(MASK_WIDTH);
}

/** `{ githubPat: true, providerKey: false }` — presence only, never a value. */
export interface SecretsPresence {
  githubPat: boolean;
  providerKey: boolean;
}

/** Read the presence flags out of a `settings.export` payload (or a `vault.*` reply). */
export function secretsPresence(source: unknown): SecretsPresence {
  const root = asRecord(source);
  const nested = root ? asRecord(root['secretsPresent']) : null;
  const raw = nested ?? root ?? {};
  return {
    githubPat: raw['githubPat'] === true || raw['hasPat'] === true,
    providerKey: raw['providerKey'] === true || raw['hasKey'] === true,
  };
}

/* -------------------------------- providers -------------------------------- */

export interface ProviderOption {
  value: string;
  label: string;
}

/** `<select>` rows for the six providers of blueprint §5, in display order. */
export function providerOptions(): ProviderOption[] {
  return PROVIDERS.map((spec) => ({ value: spec.id, label: spec.label }));
}

export function providerLabel(providerId: unknown): string {
  return resolveProvider(typeof providerId === 'string' ? providerId : null).label;
}

/** Curated model ids for the `<datalist>`; the input itself stays free-text. */
export function modelSuggestions(providerId: unknown): string[] {
  const spec = resolveProvider(typeof providerId === 'string' ? providerId : null);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const model of spec.models) {
    if (typeof model !== 'string' || model.length === 0 || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

/** The base URL a provider ships with, or `''` for a provider kind that needs a user-supplied one. */
export function providerDefaultBaseUrl(providerId: unknown): string {
  return resolveProvider(typeof providerId === 'string' ? providerId : null).baseUrl;
}

export type ProviderIssue = 'model' | 'base-url' | 'trust';

export interface ProviderValidation {
  ok: boolean;
  issue: ProviderIssue | null;
  /** i18n key of the inline message; empty when `ok`. */
  messageKey: string;
}

/** Inline validation for the 模型 section — the same rules the worker's payload validator applies. */
export function validateProviderForm(
  payload: ProviderSettingsPayload,
  trustAcknowledged: boolean,
): ProviderValidation {
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  if (model.length === 0) {
    return { ok: false, issue: 'model', messageKey: 'options.provider.modelRequired' };
  }
  const baseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
  if (baseUrl.length === 0) {
    if (providerDefaultBaseUrl(payload.providerId).length === 0) {
      return { ok: false, issue: 'base-url', messageKey: 'options.provider.baseUrlRequired' };
    }
  } else if (!isValidBaseUrl(baseUrl)) {
    // An insecure or malformed endpoint is refused here, before the worker sees it.
    return { ok: false, issue: 'base-url', messageKey: 'options.error.baseUrlInvalid' };
  }
  if (requiresTrustAck(baseUrl) && trustAcknowledged !== true) {
    return { ok: false, issue: 'trust', messageKey: 'options.provider.trustRequired' };
  }
  return { ok: true, issue: null, messageKey: '' };
}

export function saveProviderDisabled(
  payload: ProviderSettingsPayload,
  trustAcknowledged: boolean,
): boolean {
  return !validateProviderForm(payload, trustAcknowledged).ok;
}

/** `https://host/*` — the runtime host permission matching an origin, or `null` when not grantable. */
export function hostPermissionPattern(baseUrl: unknown): string | null {
  if (typeof baseUrl !== 'string') return null;
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return `${parsed.protocol}//${parsed.host}/*`;
}

/* ------------------------------ error surfaces ----------------------------- */

const ERROR_CODES: readonly ErrorCode[] = [
  'auth',
  'scope',
  'notFound',
  'conflict',
  'rateLimited',
  'timeout',
  'network',
  'locked',
  'needVault',
  'wrongPassphrase',
  'passphraseTooShort',
  'badJson',
  'emptyResponse',
  'publicRepo',
  'notConfigured',
  'parse',
  'validation',
  'unknown',
];

/**
 * HTTP status → protocol code. 403 is a *scope* problem (the classic "token is fine but cannot
 * write here"), 409 a moved branch and 422 a rejected commit body, so each one gets its own fixed
 * sentence instead of a generic failure.
 */
export function httpStatusToErrorCode(status: number): ErrorCode {
  if (status === 400) return 'validation';
  if (status === 401) return 'auth';
  if (status === 403) return 'scope';
  if (status === 404) return 'notFound';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation';
  if (status === 429) return 'rateLimited';
  if (status >= 500) return 'network';
  return 'unknown';
}

/** Coerce anything a handler might have thrown at us into a known code; never throws. */
export function normalizeErrorCode(value: unknown): ErrorCode {
  if (typeof value === 'number' && Number.isFinite(value)) return httpStatusToErrorCode(value);
  if (typeof value === 'string') {
    return (ERROR_CODES as readonly string[]).includes(value) ? (value as ErrorCode) : 'unknown';
  }
  const raw = asRecord(value);
  if (raw) {
    const code = raw['code'];
    if (typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)) {
      return code as ErrorCode;
    }
    const status = raw['status'];
    if (typeof status === 'number' && Number.isFinite(status)) return httpStatusToErrorCode(status);
  }
  return 'unknown';
}

const ERROR_HINT_KEYS: Partial<Record<ErrorCode, string>> = {
  scope: 'options.store.scopeHint',
  notConfigured: 'popup.needSetup',
  needToken: 'options.store.patMissing',
  needVault: 'popup.needUnlock',
  locked: 'popup.needUnlock',
  publicRepo: 'options.store.publicWarning',
  passphraseTooShort: 'options.security.vaultHint',
};

export interface DescribedError {
  code: ErrorCode;
  /** Fixed, translated sentence — the raw server/handler message is never shown. */
  message: string;
  /** Optional "what to do about it" line, also fixed and translated. */
  hint: string | null;
}

export function describeError(value: unknown, lang?: Lang): DescribedError {
  const code = normalizeErrorCode(value);
  const hintKey = ERROR_HINT_KEYS[code] ?? null;
  return {
    code,
    message: t(errorKeyFor(code), null, lang),
    hint: hintKey === null ? null : t(hintKey, null, lang),
  };
}

/** The single line a toast shows for a failed request. */
export function errorText(value: unknown, lang?: Lang): string {
  return describeError(value, lang).message;
}

/* ---------------------------------- ledger --------------------------------- */

export interface LedgerRow {
  provider: string;
  model: string;
  at: string;
  ok: boolean;
}

/**
 * Whitelist projection of the AI ledger. Only these four fields survive, which is the mechanical
 * proof that the options page cannot display captured content even if the worker started storing it.
 */
export function ledgerRows(entries: unknown): LedgerRow[] {
  if (!Array.isArray(entries)) return [];
  const rows: LedgerRow[] = [];
  for (const entry of entries) {
    const raw = asRecord(entry);
    if (!raw) continue;
    rows.push({
      provider: safeText(raw['provider'] ?? raw['providerId'], 60),
      model: safeText(raw['model'], 80),
      at: formatTimestamp(raw['at'] ?? raw['timestamp'] ?? raw['createdAt']),
      ok: raw['ok'] === true,
    });
  }
  return rows;
}

const ISO_PREFIX = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/u;

/**
 * Render an ISO-8601 instant as `YYYY-MM-DD HH:mm UTC`. Deliberately timezone-free (the stored
 * value is UTC) so the output is deterministic and unit-testable.
 */
export function formatTimestamp(value: unknown): string {
  let text: string | null = null;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    try {
      text = new Date(value).toISOString();
    } catch {
      return '';
    }
  }
  if (text === null) return '';
  const match = ISO_PREFIX.exec(text.trim());
  if (!match) return '';
  const [, date, time] = match;
  if (date === undefined || time === undefined) return '';
  return `${date} ${time} UTC`;
}

/* ---------------------------------- inbox ---------------------------------- */

export interface InboxRow {
  id: string;
  path: string;
  title: string;
  url: string;
  capturedAt: string;
}

/** Only ever `https:` — a commit URL is the one thing the popup opens in a new tab. */
export function isSafeExternalUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  try {
    return new URL(trimmed).protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeInboxEntry(raw: Record<string, unknown>): InboxRow | null {
  const id = safeText(raw['id'], 40);
  const path = safeText(raw['path'], 300);
  if (id.length === 0 && path.length === 0) return null;
  const url = typeof raw['url'] === 'string' ? raw['url'].trim() : '';
  return {
    id,
    path,
    title: safeText(raw['title'], 120) || path || id,
    url: isSafeExternalUrl(url) ? url : '',
    capturedAt: formatTimestamp(raw['capturedAt'] ?? raw['captured_at']),
  };
}

/** The popup's recent-Inbox list: capped, junk-tolerant and never longer than `limit`. */
export function inboxRows(entries: unknown, limit = 5): InboxRow[] {
  if (!Array.isArray(entries)) return [];
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (max === 0) return [];
  const rows: InboxRow[] = [];
  for (const entry of entries) {
    if (rows.length >= max) break;
    const raw = asRecord(entry);
    if (!raw) continue;
    const row = normalizeInboxEntry(raw);
    if (row) rows.push(row);
  }
  return rows;
}

/** `distill.request` payload for one Inbox row, or `null` when the row is not actionable. */
export function distillPayloadFor(id: unknown, path: unknown): DistillRequestPayload | null {
  const sourceId = safeText(id, 32);
  const sourcePath = safeText(path, 500);
  if (sourceId.length === 0 || sourcePath.length === 0) return null;
  return { sourceId, sourcePath };
}

/**
 * `capture.request` payload for a selection the popup read out of the active tab.
 * Returns `null` when there is nothing worth clipping.
 */
export function selectionCapturePayload(
  url: unknown,
  title: unknown,
  selection: unknown,
  lang?: string,
): CaptureRequestPayload | null {
  const text = typeof selection === 'string' ? selection.trim() : '';
  if (text.length === 0) return null;
  const payload: CaptureRequestPayload = {
    mode: 'selection',
    url: safeText(url, 4_096),
    title: safeText(title, 500) || safeText(text, 80),
    selection: text.slice(0, 200_000),
  };
  const documentLanguage = safeText(lang, 35);
  if (documentLanguage.length > 0) payload.lang = documentLanguage;
  return payload;
}
/** A note has no page: a stable synthetic URL keeps the record identifiable without pretending otherwise. */
export const NOTE_URL = 'omnipilot:note';

/**
 * A note the user wrote by hand.
 *
 * `mode: 'note'` has been in the protocol since capture shipped, with no surface that could send it - which
 * is what "no manual entry" meant. This mirrors `selectionCapturePayload`; the difference is the URL, which
 * a note does not have, so it carries the synthetic one and the worker is told not to call it an excerpt.
 * An empty body returns null: refusing locally is cheaper than a round trip that fails.
 */
export function noteCapturePayload(
  title: unknown,
  body: unknown,
  sourceUrl?: unknown,
): CaptureRequestPayload | null {
  const text = typeof body === 'string' ? body.trim() : '';
  if (text.length === 0) return null;
  const pageUrl = safeText(sourceUrl, 4_096);
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  return {
    mode: 'note',
    url: pageUrl.length > 0 ? pageUrl : NOTE_URL,
    // The worker repeats this fallback, so a record stays right even if a caller sends an empty title.
    title: safeText(title, 500) || safeText(firstLine, 80),
    selection: text.slice(0, 200_000),
  };
}

/**
 * Chrome returns `InjectionResult[]`, Firefox a single result — normalise both to the raw value the
 * injected function returned, and treat anything unexpected as "no value".
 */
export function firstInjectionResult(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    const first: unknown = raw[0];
    const record = asRecord(first);
    return record ? record['result'] : undefined;
  }
  const record = asRecord(raw);
  return record ? record['result'] : undefined;
}

/* ---------------------------------- status --------------------------------- */

export interface VaultInfo {
  configured: boolean;
  unlocked: boolean;
  /** How the session survives a restart; `strict` when the worker did not say. */
  unlockPolicy: 'strict' | 'remember';
  expiresAt: number | null;
  remainingMs: number;
}

export interface StatusPayload {
  prefs: PublicPrefs;
  probe: StoreProbe | null;
  vault: VaultInfo;
}

export function emptyVaultInfo(): VaultInfo {
  return { configured: false, unlocked: false, unlockPolicy: 'strict', expiresAt: null, remainingMs: 0 };
}

export function normalizeVaultInfo(value: unknown): VaultInfo {
  const raw = asRecord(value);
  if (!raw) return emptyVaultInfo();
  const expiresAtRaw = raw['expiresAt'];
  const remainingRaw = raw['remainingMs'];
  return {
    configured: raw['configured'] === true,
    unlocked: raw['unlocked'] === true,
    unlockPolicy: raw['unlockPolicy'] === 'remember' ? 'remember' : 'strict',
    expiresAt: typeof expiresAtRaw === 'number' && Number.isFinite(expiresAtRaw) ? expiresAtRaw : null,
    remainingMs:
      typeof remainingRaw === 'number' && Number.isFinite(remainingRaw) && remainingRaw > 0
        ? Math.floor(remainingRaw)
        : 0,
  };
}

const VISIBILITIES: readonly RepoVisibility[] = ['private', 'internal', 'public', 'unknown'];

/**
 * Defensive read of a `StoreProbe`. When the shape is unexpected the result fails CLOSED: an
 * unknown visibility is reported as `unknown` and a public repository with no explicit `canWrite`
 * flag is treated as not writable.
 */
export function normalizeStoreProbe(value: unknown): StoreProbe | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const visibilityRaw = raw['visibility'];
  const visibility =
    typeof visibilityRaw === 'string' && (VISIBILITIES as readonly string[]).includes(visibilityRaw)
      ? (visibilityRaw as RepoVisibility)
      : 'unknown';
  const canPush = raw['canPush'] === true;
  const canWriteRaw = raw['canWrite'];
  const canWrite =
    typeof canWriteRaw === 'boolean' ? canWriteRaw : canPush && visibility !== 'public';
  const probe: StoreProbe = {
    kind: 'github',
    repoFullName: safeText(raw['repoFullName'], 200),
    visibility,
    defaultBranch: safeText(raw['defaultBranch'], 200),
    canPush,
    canWrite,
    checkedAt: formatTimestamp(raw['checkedAt']),
  };
  if (raw['warning'] === 'public-repo') probe.warning = 'public-repo';
  return probe;
}

export function emptyStatusPayload(): StatusPayload {
  return { prefs: { ...DEFAULT_PUBLIC_PREFS }, probe: null, vault: emptyVaultInfo() };
}

/** Tolerant read of the worker's `status.get` reply (`{ prefs, probe, vault }`). */
export function normalizeStatusPayload(value: unknown): StatusPayload {
  const raw = asRecord(value);
  if (!raw) return emptyStatusPayload();
  return {
    prefs: normalizePublicPrefs(raw['prefs']),
    probe: normalizeStoreProbe(raw['probe']),
    vault: normalizeVaultInfo(raw['vault']),
  };
}

export interface StatusPanel {
  readiness: CaptureReadiness;
  readinessLabel: string;
  /** Why the clip buttons are unavailable (or "ready"). */
  notice: string;
  rows: StatusLine;
  canClip: boolean;
  publicWarning: boolean;
  visibility: RepoVisibility;
  visibilityLabel: string;
  vaultConfigured: boolean;
  vaultUnlocked: boolean;
  /** `token` / `ssh` + branch, already translated. */
  auth: string;
  /** `last sync · pending · conflicts`. */
  sync: string;
  /** The branch the popup shows next to the authorization mode. */
  branch: string;
  authMode: 'token' | 'ssh';
  companion: 'ok' | 'missing' | 'mismatch';
  canSync: boolean;
  lastOutcome: string;
}

/** The whole popup status block, derived from one defensive read of `status.get`. */
export function statusPanel(value: unknown, lang?: Lang): StatusPanel {
  const status = normalizeStatusPayload(value);
  const readiness = captureReadiness({ prefs: status.prefs, probe: status.probe });
  const rows = statusLine({ prefs: status.prefs, probe: status.probe }, lang);
  const sync = syncLineParts(status.prefs, lang);
  const syncEnabled = status.prefs.enabled && readiness !== 'not-configured';
  return {
    readiness,
    readinessLabel: readinessLabel(readiness, lang),
    notice: readinessNotice(readiness, lang),
    rows,
    canClip: readiness === 'ready',
    publicWarning: isPublicRepoWarning(status.probe),
    visibility: status.probe?.visibility ?? 'unknown',
    visibilityLabel: visibilityLabel(status.probe?.visibility ?? 'unknown', lang),
    vaultConfigured: status.vault.configured,
    vaultUnlocked: status.vault.unlocked,
    auth: rows.auth,
    sync: rows.sync,
    branch: status.prefs.branch,
    authMode: status.prefs.authMode,
    companion: status.prefs.companion,
    canSync: syncEnabled,
    lastOutcome: sync.outcome,
  };
}

export function readinessNotice(readiness: CaptureReadiness, lang?: Lang): string {
  switch (readiness) {
    case 'ready':
      return t('popup.ready', null, lang);
    case 'disabled':
      return t('popup.notice.disabled', null, lang);
    case 'not-configured':
      return t('popup.needSetup', null, lang);
    case 'vault-locked':
      return t('popup.needUnlock', null, lang);
    case 'public-repo-blocked':
      return t('error.publicRepo', null, lang);
    default:
      return t('error.unknown', null, lang);
  }
}

/* ------------------------------- settings form ----------------------------- */

export const DEFAULT_AUTO_LOCK_MINUTES = 30;
export const MIN_AUTO_LOCK_MINUTES = 1;
export const MAX_AUTO_LOCK_MINUTES = 720;
/** Mirrors `MIN_PASSPHRASE_LENGTH` in `lib/security/crypto-key.ts` (asserted by the unit test). */
export const MIN_PASSPHRASE_CHARS = 8;

export interface SettingsForm {
  enabled: boolean;
  aiAuthorized: boolean;
  securityMode: SecurityMode;
  /** Whether this installation has already recorded an explicit tier choice (T7). */
  contentTierChosen: boolean;
  autoLockMinutes: number;
  owner: string;
  repo: string;
  branch: string;
  pathPrefix: string;
  apiBase: string;
  providerId: string;
  model: string;
  baseUrl: string;
  publicRepoAcknowledged: boolean;
  /** Which authorization mode remote operations use (F5). */
  authMode: 'token' | 'ssh';
  /** The SSH block, as stored. `keyRef` is an identifier; `repoRoot` is the local clone path. */
  ssh: { host: string; user: string; keyRef: string; repoRoot: string };
}

export function clampAutoLockMinutes(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_AUTO_LOCK_MINUTES;
  return Math.min(MAX_AUTO_LOCK_MINUTES, Math.max(MIN_AUTO_LOCK_MINUTES, Math.round(parsed)));
}

export function defaultSettingsForm(): SettingsForm {
  return {
    enabled: true,
    aiAuthorized: false,
    securityMode: 'vault',
    contentTierChosen: false,
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
    owner: '',
    repo: '',
    branch: 'main',
    pathPrefix: '',
    apiBase: '',
    providerId: 'openai',
    model: '',
    baseUrl: '',
    publicRepoAcknowledged: false,
    authMode: 'token',
    ssh: { host: 'github.com', user: 'git', keyRef: 'default', repoRoot: '' },
  };
}

/**
 * Build the form model from `settings.export` (which nests the settings under `settings`) or from a
 * bare settings object. Only non-secret fields are read; a stored credential can never reach a form
 * field, which is why the key inputs always start empty with `options.apiKeyKeep` as placeholder.
 */
export function settingsToForm(source: unknown): SettingsForm {
  const root = asRecord(source);
  const nested = root ? asRecord(root['settings']) : null;
  const raw = nested ?? root;
  if (!raw) return defaultSettingsForm();

  const github = asRecord(raw['github']) ?? {};
  const ai = asRecord(raw['ai']) ?? {};
  const ssh = asRecord(raw['ssh']) ?? {};
  const providerIdRaw = ai['providerId'];

  return {
    enabled: raw['enabled'] !== false,
    aiAuthorized: raw['aiAuthorized'] === true,
    securityMode: raw['securityMode'] === 'transparent' ? 'transparent' : 'vault',
    contentTierChosen: raw['contentTierChosen'] === true,
    autoLockMinutes: clampAutoLockMinutes(raw['autoLockMinutes']),
    owner: safeText(github['owner'], 100),
    repo: safeText(github['repo'], 200),
    branch: safeText(github['branch'], 200) || 'main',
    pathPrefix: safeText(github['pathPrefix'], 500),
    apiBase: typeof github['apiBase'] === 'string' ? github['apiBase'].trim() : '',
    providerId:
      typeof providerIdRaw === 'string' && providerIdRaw.trim().length > 0
        ? providerIdRaw.trim()
        : 'openai',
    model: safeText(ai['model'], 120),
    baseUrl: typeof ai['baseUrl'] === 'string' ? ai['baseUrl'].trim() : '',
    publicRepoAcknowledged: github['publicRepoAcknowledged'] === true,
    authMode: raw['authMode'] === 'ssh' ? 'ssh' : 'token',
    ssh: {
      host: safeText(ssh['host'], 200) || 'github.com',
      user: safeText(ssh['user'], 100) || 'git',
      keyRef: safeText(ssh['keyRef'], 120) || 'default',
      repoRoot: safeText(ssh['repoRoot'], 500),
    },
  };
}

export interface GithubForm {
  owner: string;
  repo: string;
  branch: string;
  pathPrefix: string;
  pat: string;
  apiBase: string;
  publicRepoAcknowledged: boolean;
}

export function githubFormOf(form: SettingsForm, pat = ''): GithubForm {
  return {
    owner: form.owner,
    repo: form.repo,
    branch: form.branch,
    pathPrefix: form.pathPrefix,
    pat,
    apiBase: form.apiBase,
    publicRepoAcknowledged: form.publicRepoAcknowledged,
  };
}

/**
 * Form → `settings.github` payload. An empty token or API base is OMITTED, never sent as `''`:
 * omission means "keep what is stored", while an empty string would wipe it.
 */
export function formToGithubPayload(form: GithubForm): GithubSettingsPayload {
  const payload: GithubSettingsPayload = {
    owner: form.owner.trim(),
    repo: form.repo.trim(),
    branch: form.branch.trim() || 'main',
    pathPrefix: form.pathPrefix.trim(),
    publicRepoAcknowledged: form.publicRepoAcknowledged === true,
  };
  const pat = form.pat.trim();
  if (pat.length > 0) payload.pat = pat;
  const apiBase = form.apiBase.trim();
  if (apiBase.length > 0) payload.apiBase = apiBase;
  return payload;
}

export function trustedHostsOf(value: unknown): string[] {
  const ai = asRecord(asRecord(value)?.["ai"]);
  const hosts = ai?.["trustedHosts"];
  if (!Array.isArray(hosts)) return [];
  return hosts.filter((host): host is string => typeof host === "string" && host.length > 0);
}

export interface ProviderForm {
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  trustAcknowledged: boolean;
}

export function providerFormOf(form: SettingsForm, apiKey = '', trustAcknowledged = false): ProviderForm {
  return {
    providerId: form.providerId,
    model: form.model,
    baseUrl: form.baseUrl,
    apiKey,
    trustAcknowledged,
  };
}

/** Form → `settings.provider` payload; an empty key is omitted ("keep the stored key"). */
export function formToProviderPayload(form: ProviderForm): ProviderSettingsPayload {
  const baseUrl = form.baseUrl.trim();
  const payload: ProviderSettingsPayload = {
    providerId: form.providerId,
    model: form.model.trim(),
  };
  if (baseUrl.length > 0) payload.baseUrl = baseUrl;
  const apiKey = form.apiKey.trim();
  if (apiKey.length > 0) payload.apiKey = apiKey;
  if (requiresTrustAck(baseUrl)) payload.trustAcknowledged = form.trustAcknowledged === true;
  return payload;
}

export function formToSecurityPayload(form: SettingsForm): SecuritySettingsPayload {
  return {
    enabled: form.enabled,
    aiAuthorized: form.aiAuthorized,
    securityMode: form.securityMode,
    autoLockMinutes: clampAutoLockMinutes(form.autoLockMinutes),
  };
}

export function repoFullNameOf(owner: unknown, repo: unknown): string {
  const ownerText = safeText(owner, 100);
  const repoText = safeText(repo, 200);
  return ownerText.length > 0 && repoText.length > 0 ? `${ownerText}/${repoText}` : '';
}

export function passphraseTooShort(passphrase: unknown): boolean {
  return typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_CHARS;
}

/** Transparent mode writes plaintext, so switching to it needs an explicit confirmation. */
export function transparentModeNeedsConfirm(mode: SecurityMode, confirmed: boolean): boolean {
  return mode === 'transparent' && confirmed !== true;
}

/* ----------------------------- storage section ----------------------------- */

/**
 * The 存储 section may only be saved once the visibility question is settled — or with a typed token,
 * which the save itself verifies (see `canSaveStorageSection`).
 */
export function saveStorageDisabled(
  probe: StoreProbe | null,
  acknowledged: boolean,
  typedToken = false,
): boolean {
  return !canSaveStorageSection(probe, acknowledged, typedToken);
}

/** Inline reason for a disabled 保存 button (empty when saving is allowed). */
export function storageSaveHint(
  probe: StoreProbe | null,
  acknowledged: boolean,
  lang?: Lang,
): string {
  if (!probe) return t('options.store.testFirst', null, lang);
  if (probe.visibility === 'public' && acknowledged !== true) {
    return t('options.store.ackBlocked', null, lang);
  }
  if (!probe.canPush) return t('options.store.noPush', null, lang);
  return '';
}

/* --------------------------- first-run tier choice -------------------------- */

/**
 * Whether the 存储 page has to ask which tier the repository uses before it may save.
 *
 * The inputs are the facts `resolveTier` decides on, minus the ones this page cannot observe:
 * `recorded` (the repository's `.omnipilot/config.json` already names a tier) and `ambiguous`
 * (the repository holds content but records nothing). A page cannot open the store, so it passes
 * neither and leans on `chosen`, its own record of an explicit decision. The worker enforces the
 * stronger rules: `resolveTier` never guesses, and the tier write never overwrites a recorded mode.
 */
export function needsTierChoice(input: {
  recorded?: boolean;
  ambiguous?: boolean;
  chosen: boolean;
}): boolean {
  // A tier the repository already records wins outright: this is not a first run for that store.
  if (input.recorded === true) return false;
  // Content with no record is the one case that must never be resolved by a default.
  if (input.ambiguous === true) return true;
  return input.chosen !== true;
}

export interface TierChoiceOption {
  value: SecurityMode;
  label: string;
  /** What the choice means for the user's own files — the tradeoff, not the implementation. */
  consequence: string;
}

/**
 * The two tiers, each with the consequence a person actually needs: who can read the repository,
 * and what is lost if the passphrase is. Readable first, because that is the product's stance.
 */
export function tierChoiceOptions(lang?: Lang): TierChoiceOption[] {
  return [
    {
      value: 'transparent',
      label: t('options.security.mode.transparent', null, lang),
      consequence: t('options.store.tier.transparent.consequence', null, lang),
    },
    {
      value: 'vault',
      label: t('options.security.mode.vault', null, lang),
      consequence: t('options.store.tier.vault.consequence', null, lang),
    },
  ];
}

/** Why the 存储 save is refused, in the order the user has to fix things ('' when it may be saved). */
export function storageSaveBlocked(
  probe: StoreProbe | null,
  acknowledged: boolean,
  tierRequired: boolean,
  lang?: Lang,
): string {
  // The tier comes first: it decides what the repository even contains, so the probe's answer
  // cannot be judged before it is settled.
  if (tierRequired) return t('options.store.tier.blocked', null, lang);
  return storageSaveHint(probe, acknowledged, lang);
}

/* ------------------------------ sync surface ------------------------------- */

/**
 * `sync.status` as the UI reads it. The worker may not have the handler yet (it is written in
 * parallel), so every field is optional-with-a-fallback and a junk reply degrades to "never synced"
 * rather than throwing.
 */
/**
 * One conflict as the status surface needs it.
 *
 * `conflictPath` is what makes the decision possible: the sibling holds **our** version and the original path
 * holds theirs, and without both the UI can only ask for another sync. `readable` says whether a content
 * comparison is possible right now (a locked vault can still choose to keep both).
 */
export interface ConflictStatus {
  path: string;
  conflictPath: string;
  readable: boolean;
}

export interface SyncStatusView {
  head: string;
  lastSyncAt: string;
  outcome: string;
  pending: number;
  conflicts: ConflictStatus[];
  /**
   * The **code** of the last failure (never the worker's sentence): the surface renders its own
   * translated guidance and the one action that fixes it (F5).
   */
  failureCode: string | null;
  /** The index/cache could not be read and a rebuild is the next step. */
  needsRebuild: boolean;
}

const SYNC_OUTCOMES = [
  'never',
  'upToDate',
  'pulled',
  'pushed',
  'merged',
  'conflict',
  'failed',
  'busy',
] as const;

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function normalizeSyncStatus(value: unknown): SyncStatusView {
  const raw = asRecord(value);
  if (!raw) {
    return { head: '', lastSyncAt: '', outcome: 'never', pending: 0, conflicts: [], failureCode: null, needsRebuild: false };
  }
  const outcome = asRecord(raw['sync'])?.['lastOutcome'] ?? raw['lastOutcome'] ?? raw['outcome'];
  const conflictsRaw = raw['conflicts'];
  // Accepts both shapes on purpose: the worker sends structured entries, while an older reply (or a test stub)
  // may still carry bare paths. A conflict the surface cannot name is a conflict the user cannot decide, so
  // dropping it would be worse than showing it without a sibling.
  const conflicts: ConflictStatus[] = Array.isArray(conflictsRaw)
    ? conflictsRaw
        .map((entry) => {
          if (typeof entry === 'string') {
            const path = safeText(entry, 300);
            return path.length > 0 ? { path, conflictPath: '', readable: false } : null;
          }
          const record = asRecord(entry);
          if (!record) return null;
          const path = safeText(record['path'], 300);
          if (path.length === 0) return null;
          return {
            path,
            conflictPath: safeText(record['conflictPath'], 300),
            readable: record['readable'] === true,
          };
        })
        .filter((entry): entry is ConflictStatus => entry !== null)
        .slice(0, 50)
    : [];
  const pendingRaw = raw['pending'];
  return {
    // The code, not a sentence: the surface translates it itself (and `raw` is non-null on this path).
    failureCode: (asRecord(raw['state'])?.['lastErrorCode'] as string | undefined) ?? null,
    head: safeText(raw['head'], 120),
    lastSyncAt: formatTimestamp(raw['lastSyncAt'] ?? raw['syncedAt']),
    outcome:
      typeof outcome === 'string' && (SYNC_OUTCOMES as readonly string[]).includes(outcome)
        ? outcome
        : 'never',
    pending:
      typeof pendingRaw === 'number' ? safeCount(pendingRaw) : safeCount(Array.isArray(pendingRaw) ? pendingRaw.length : 0),
    conflicts,
    needsRebuild: raw['needsRebuild'] === true || raw['needs_rebuild'] === true,
  };
}

/** `sync.now` result: the outcome plus the counts a row can show. */
export interface SyncRunView {
  outcome: string;
  pulled: number;
  pushed: number;
  conflicts: number;
  upToDate: boolean;
}

export function normalizeSyncResult(value: unknown): SyncRunView {
  const raw = asRecord(value);
  const outcome = raw ? raw['outcome'] : undefined;
  const known =
    typeof outcome === 'string' && (SYNC_OUTCOMES as readonly string[]).includes(outcome)
      ? outcome
      : 'failed';
  return {
    outcome: known,
    pulled: safeCount(raw?.['pulled']),
    pushed: safeCount(raw?.['pushed']),
    conflicts: Array.isArray(raw?.['conflicts']) ? safeCount((raw?.['conflicts'] as unknown[]).length) : safeCount(raw?.['conflicts']),
    upToDate: known === 'upToDate' || raw?.['upToDate'] === true,
  };
}

/** One conflict path with the three resolutions §F5 offers. Buttons carry no payload of their own. */
export interface ConflictRow {
  path: string;
  /** Empty when the reply did not name the sibling — the caller must not invent one. */
  conflictPath: string;
  readable: boolean;
  keepMine: string;
  keepTheirs: string;
  keepBoth: string;
}

export function conflictRows(
  conflicts: readonly ConflictStatus[],
  lang?: Lang,
): ConflictRow[] {
  return conflicts.map((conflict) => ({
    path: safeText(conflict.path, 300),
    conflictPath: safeText(conflict.conflictPath, 300),
    readable: conflict.readable === true,
    keepMine: t('options.sync.conflict.keepMine', null, lang),
    keepTheirs: t('options.sync.conflict.keepTheirs', null, lang),
    keepBoth: t('options.sync.conflict.keepBoth', null, lang),
  }));
}

/**
 * `sync.policy` payload from the three controls.
 *
 * The interval is clamped to the worker's own bounds (`SYNC_INTERVAL_MIN/MAX`) so a value typed by
 * hand can never make the router reject the whole save.
 */
export function syncPolicyPayload(form: {
  intervalMinutes: string | number;
  onStartup: boolean;
  onCapture: boolean;
  pullOnly: boolean;
}): SyncPolicyPayload | null {
  const parsed =
    typeof form.intervalMinutes === 'number'
      ? form.intervalMinutes
      : Number.parseInt(String(form.intervalMinutes).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < SYNC_INTERVAL_MIN || parsed > SYNC_INTERVAL_MAX) {
    return null;
  }
  return {
    intervalMinutes: Math.round(parsed),
    onStartup: form.onStartup === true,
    onCapture: form.onCapture === true,
    pullOnly: form.pullOnly === true,
  };
}

/** The branch check the 存储 section runs through `auth.probe` (T6.3). */
export function branchCheck(value: unknown, branch: string): BranchCheck {
  return branchCheckFromProbe(value, branch);
}

export function branchCheckNotice(check: BranchCheck, lang?: Lang): BranchNotice {
  return branchNotice(check, lang);
}

/* ----------------------------- search surface ------------------------------ */

export interface SearchResultRow {
  id: string;
  path: string;
  title: string;
  snippet: string;
  /** `https://…` when it could be derived, empty when there is nothing safe to open. */
  url: string;
}

export interface SearchResultsView {
  rows: SearchResultRow[];
  needsRebuild: boolean;
}

/**
 * `search.query` → renderable rows.
 *
 * Whitelist projection: only id, path, title and snippet survive, each length-capped and stripped of
 * control characters before it can reach a node. The repository URL is derived *here* rather than
 * taken from the reply, so a compromised worker cannot hand the popup a `javascript:` link.
 */
export function searchResultRows(
  value: unknown,
  options: { repoFullName?: string; branch?: string; limit?: number } = {},
): SearchResultsView {
  const raw = asRecord(value);
  const entries = Array.isArray(value) ? value : Array.isArray(raw?.['results']) ? (raw?.['results'] as unknown[]) : [];
  const needsRebuild = raw?.['needsRebuild'] === true || raw?.['needs_rebuild'] === true;
  const max = Number.isFinite(options.limit) && (options.limit ?? 0) > 0 ? Math.floor(options.limit as number) : 8;
  const repo = typeof options.repoFullName === 'string' ? options.repoFullName : '';
  const branch = typeof options.branch === 'string' ? options.branch : '';
  const rows: SearchResultRow[] = [];
  for (const entry of entries) {
    if (rows.length >= max) break;
    const item = asRecord(entry);
    if (!item) continue;
    const path = safeText(item['path'], 300);
    const id = safeText(item['id'], 64);
    if (path.length === 0 && id.length === 0) continue;
    rows.push({
      id,
      path,
      title: safeText(item['title'], 120) || path || id,
      snippet: safeText(item['snippet'], 240),
      url: repoFileUrl(repo, branch, path) ?? '',
    });
  }
  return { rows, needsRebuild };
}

/* ------------------------------ conflict gate ------------------------------ */

/*
 * How a conflict resolution is expressed today.
 *
 * There is deliberately no resolution message type: the request contract exposes `sync.now` and
 * `sync.policy` only, and inventing a type here would silently do nothing. Each action therefore
 * records *which* side the user wants and asks for a sync — the worker keeps both versions until a
 * real resolution op exists, which is why the UI shows the explanatory hint next to the buttons.
 */
export type ConflictChoice = 'mine' | 'theirs' | 'both';

export function conflictChoiceLabel(choice: ConflictChoice, lang?: Lang): string {
  switch (choice) {
    case 'mine':
      return t('options.sync.conflict.keepMine', null, lang);
    case 'theirs':
      return t('options.sync.conflict.keepTheirs', null, lang);
    default:
      return t('options.sync.conflict.keepBoth', null, lang);
  }
}

/* ----------------------------------- data ---------------------------------- */

/** Pretty JSON for the 数据 section. Never throws, even on a cyclic or exotic export payload. */
export function exportJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}
