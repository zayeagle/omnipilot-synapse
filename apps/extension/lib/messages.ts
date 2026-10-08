/**
 * The message protocol between the content script, the extension pages and the background worker.
 *
 * This module is the security boundary expressed as types:
 * - content scripts may only ask for public preferences and submit a capture;
 * - everything that touches a credential additionally requires an *extension page* sender, so a
 *   compromised page cannot ask the worker to spend the user's GitHub token or model credits.
 *
 * Pure module (no browser APIs), which is why it is also the easiest place to test the boundary.
 */

export const REQUEST_TYPES = [
  'prefs.get',
  'status.get',
  'inbox.list',
  'cards.list',
  'card.decide',
  'conflict.resolve',
  'review.due',
  'capture.request',
  'capture.page',
  'distill.request',
  'store.probe',
  'auth.probe',
  'native.status',
  'sync.now',
  'sync.status',
  'sync.policy',
  'search.query',
  'search.rebuild',
  'settings.provider',
  'settings.github',
  'settings.security',
  'settings.export',
  'settings.reset',
  'vault.setup',
  'vault.unlock',
  'vault.lock',
  'vault.status',
  'ai.ledger',
  'ai.ledger.clear',
] as const;

export type RequestType = (typeof REQUEST_TYPES)[number];

/**
 * Background → content-script message asking a tab to clip itself.
 *
 * It is not a `RequestType`: it never passes through the router, and only the extension can send it
 * (a page cannot reach another extension's content script through `runtime.sendMessage`). It lives
 * here so the background and the content script agree on one constant.
 */
export const PAGE_CLIP_MESSAGE = 'page.clip';

export type CaptureMode = 'page' | 'selection' | 'note';
export type SecurityMode = 'vault' | 'transparent';

export interface CaptureRequestPayload {
  mode: CaptureMode;
  url: string;
  title: string;
  /** Extracted page body. Omitted for `selection`/`note`, where `selection` carries the text. */
  body?: string;
  selection?: string;
  byline?: string;
  lang?: string;
  capturedAt?: string;
  /**
   * Ask the worker to distil the newly captured item in the same round trip (the bubble's 提炼).
   * Still subject to the AI authorization gates — the capture happens either way.
   */
  distill?: boolean;
}

export interface DistillRequestPayload {
  sourceId: string;
  sourcePath: string;
  /** Skip the per-item ledger gate for this session (the user ticked "allow in this session"). */
  allowThisSession?: boolean;
}

export interface ProviderSettingsPayload {
  providerId: string;
  model: string;
  baseUrl?: string;
  /** Omit to keep the stored key. */
  apiKey?: string;
  /** Required when a non-default base URL is used (SC-F5-02). */
  trustAcknowledged?: boolean;
}

export interface GithubSettingsPayload {
  owner: string;
  repo: string;
  branch: string;
  pathPrefix?: string;
  /** Omit to keep the stored token. */
  pat?: string;
  apiBase?: string;
  publicRepoAcknowledged?: boolean;
}

export interface SecuritySettingsPayload {
  enabled?: boolean;
  aiAuthorized?: boolean;
  securityMode?: SecurityMode;
  autoLockMinutes?: number;
  /**
   * How the vault session survives a restart. Travels with the other security choices, and lands in the
   * vault's own record rather than in `local:settings`.
   */
  unlockPolicy?: 'strict' | 'remember';
  /**
   * Which credential mode remote operations use.
   *
   * Travels on `settings.security` because it *is* a security choice, and because the storage form's
   * save path already carries this payload — a separate message type would have meant two round trips
   * that can disagree.
   */
  authMode?: AuthMode;
  /**
   * Whether the user has now made the content-tier choice explicitly (T7).
   *
   * Travels here rather than in its own message because the storage form's save already carries
   * this payload, and two round trips for one decision could disagree.
   */
  contentTierChosen?: boolean;
}

export interface SecretPayloadPatch {
  githubPat?: string;
  providerKey?: string;
}

/* --------------------------- sync / search / auth -------------------------- */

export type AuthMode = 'token' | 'ssh';

/** What a human can do with a proposed card. Discarding archives it; nothing is destroyed. */
export type CardDecisionAction = 'accept' | 'edit' | 'discard';

/**
 * The only fields a user may rewrite on a proposal.
 *
 * A whitelist rather than a spread: `id`, `status` and `source_id` describe what the card *is*, and letting
 * the page rewrite them would let a card claim to be a different card.
 */
/** What a human can do about a note that changed on both sides (SC-R3-02). */
export type ConflictAction = 'keep-mine' | 'keep-remote' | 'keep-both';

export interface CardPatch {
  title?: string;
  summary?: string;
  points?: string[];
  tags?: string[];
}
export type SyncReason = 'manual' | 'startup' | 'capture' | 'alarm' | 'unlock';
export type CompanionState = 'ok' | 'missing' | 'mismatch';
export type SyncOutcome = 'upToDate' | 'pulled' | 'pushed' | 'merged' | 'conflict' | 'failed' | 'busy';

export interface SyncPolicyPayload {
  /** Minutes between automatic pulls. `0` disables the periodic pull. */
  intervalMinutes?: number;
  onStartup?: boolean;
  onCapture?: boolean;
  /** Pull only — never push automatically (read-only mirror mode). */
  pullOnly?: boolean;
}

export interface SearchFiltersPayload {
  tag?: string;
  topic?: string;
  in?: 'inbox' | 'cards' | 'topics';
}

export interface SyncPolicy {
  intervalMinutes: number;
  onStartup: boolean;
  onCapture: boolean;
  pullOnly: boolean;
}

export const SYNC_INTERVAL_MIN = 0;
export const SYNC_INTERVAL_MAX = 24 * 60;

export function validateSyncPolicy(payload: unknown): SyncPolicyPayload {
  if (payload === undefined || payload === null) return {};
  const raw = requireRecord(payload);
  const out: SyncPolicyPayload = {};
  if (raw['intervalMinutes'] !== undefined) {
    const minutes = raw['intervalMinutes'];
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
      throw new MessageError('intervalMinutes must be a non-negative number');
    }
    out.intervalMinutes = Math.min(SYNC_INTERVAL_MAX, Math.round(minutes));
  }
  for (const key of ['onStartup', 'onCapture', 'pullOnly'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') throw new MessageError(`${key} must be a boolean`);
    out[key] = raw[key] as boolean;
  }
  return out;
}

export function validateSearchQuery(payload: unknown): {
  text: string;
  limit: number;
  filters: SearchFiltersPayload;
} {
  const raw = requireRecord(payload);
  const text = requireString(raw['text'], 'text', 500, { allowEmpty: true });
  const limit = Math.min(100, Math.max(1, Math.round(typeof raw['limit'] === 'number' ? raw['limit'] : 20)));
  const filters: SearchFiltersPayload = {};
  if (raw['filters'] !== undefined && raw['filters'] !== null) {
    const filtersRaw = requireRecord(raw['filters']);
    if (filtersRaw['tag'] !== undefined) filters.tag = requireString(filtersRaw['tag'], 'tag', 80);
    if (filtersRaw['topic'] !== undefined) filters.topic = requireString(filtersRaw['topic'], 'topic', 120);
    if (filtersRaw['in'] !== undefined) {
      const scope = filtersRaw['in'];
      if (scope !== 'inbox' && scope !== 'cards' && scope !== 'topics') {
        throw new MessageError('filters.in must be inbox | cards | topics');
      }
      filters.in = scope;
    }
  }
  return { text, limit, filters };
}

export function validateSyncRequest(payload: unknown): { reason: SyncReason } {
  if (payload === undefined || payload === null) return { reason: 'manual' };
  const raw = requireRecord(payload);
  const reason = raw['reason'];
  if (reason === undefined) return { reason: 'manual' };
  if (
    reason !== 'manual' &&
    reason !== 'startup' &&
    reason !== 'capture' &&
    reason !== 'alarm' &&
    reason !== 'unlock'
  ) {
    throw new MessageError('reason must be manual | startup | capture | alarm | unlock');
  }
  return { reason };
}

const CARD_PATCH_STRINGS: ReadonlyArray<keyof CardPatch> = ['title', 'summary'];

function optionalPatch(raw: Record<string, unknown>): CardPatch | undefined {
  const value = raw['patch'];
  if (value === undefined || value === null) return undefined;
  const patch = requireRecord(value);
  const out: CardPatch = {};
  for (const field of CARD_PATCH_STRINGS) {
    const candidate = patch[field];
    if (candidate === undefined) continue;
    (out as Record<string, unknown>)[field] = requireString(candidate, field, 2_000, { allowEmpty: true });
  }
  for (const field of ['points', 'tags'] as const) {
    const candidate = patch[field];
    if (candidate === undefined) continue;
    if (!Array.isArray(candidate) || candidate.length > 50) {
      throw new MessageError(`${field} must be an array of at most 50 entries`);
    }
    out[field] = candidate.map((entry) => requireString(entry, field, 500));
  }
  return out;
}

/** `cards.list` — how many pending cards to return. */
export function validateCardList(payload: unknown): { limit: number } {
  if (payload === undefined || payload === null) return { limit: 20 };
  const raw = requireRecord(payload);
  return { limit: Math.min(100, Math.max(1, Math.round(typeof raw['limit'] === 'number' ? raw['limit'] : 20))) };
}

/**
 * `card.decide` — accept, edit or discard one proposal.
 *
 * `path` is required alongside `id` because the index is keyed by id but the file is keyed by path: a card
 * edited elsewhere can leave the two disagreeing, and the file is what is being decided about. A mismatch is
 * reported rather than guessed at.
 */
export function validateCardDecide(payload: unknown): {
  id: string;
  path: string;
  action: CardDecisionAction;
  patch?: CardPatch;
} {
  const raw = requireRecord(payload);
  const id = requireString(raw['id'], 'id', 200);
  const path = requireString(raw['path'], 'path', 1_000);
  if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    throw new MessageError('path must be a repository-relative path');
  }
  const action = raw['action'];
  if (action !== 'accept' && action !== 'edit' && action !== 'discard') {
    throw new MessageError('action must be accept | edit | discard');
  }
  const patch = optionalPatch(raw);
  if (action === 'edit' && patch === undefined) throw new MessageError('edit requires a patch');
  if (action !== 'edit' && patch !== undefined) throw new MessageError('only edit accepts a patch');
  return { id, path, action, ...(patch !== undefined ? { patch } : {}) };
}

/** `conflict.resolve` — which version survives, and where the other one goes. */
export function validateConflictResolve(payload: unknown): {
  path: string;
  conflictPath: string;
  action: ConflictAction;
} {
  const raw = requireRecord(payload);
  const path = requireString(raw['path'], 'path', 1_000);
  const conflictPath = requireString(raw['conflictPath'], 'conflictPath', 1_000);
  for (const [field, value] of [['path', path], ['conflictPath', conflictPath]] as const) {
    if (value.startsWith('/') || value.includes('..') || value.includes('\\')) {
      throw new MessageError(`${field} must be a repository-relative path`);
    }
  }
  if (path === conflictPath) throw new MessageError('path and conflictPath must differ');
  const action = raw['action'];
  if (action !== 'keep-mine' && action !== 'keep-remote' && action !== 'keep-both') {
    throw new MessageError('action must be keep-mine | keep-remote | keep-both');
  }
  return { path, conflictPath, action };
}

export function validateAuthMode(value: unknown): AuthMode {
  if (value !== 'token' && value !== 'ssh') throw new MessageError('authMode must be token | ssh');
  return value;
}

export interface RequestPayloads {
  'prefs.get': void;
  'status.get': void;
  'inbox.list': { limit?: number };
  'capture.request': CaptureRequestPayload;
  /** Ask the worker to clip the active tab: it resolves the tab and drives the content script. */
  'capture.page': { distill?: boolean };
  'distill.request': DistillRequestPayload;
  'store.probe': void;
  /** Probe using the *currently selected* auth mode (token or SSH). */
  'auth.probe': void;
  'native.status': void;
  'sync.now': { reason?: SyncReason };
  'sync.status': void;
  'sync.policy': SyncPolicyPayload;
  'search.query': { text: string; limit?: number; filters?: SearchFiltersPayload };
  'search.rebuild': void;
  /** The AI's proposals, so a proposal has a decision surface (SC-R3-01). */
  'cards.list': { limit?: number };
  'card.decide': { id: string; path: string; action: CardDecisionAction; patch?: CardPatch };
  'conflict.resolve': { path: string; conflictPath: string; action: ConflictAction };
  /** The notes that are due for review (F7/G10) — no payload; the schedule lives in the repository. */
  'review.due': void;
  'settings.provider': ProviderSettingsPayload;
  'settings.github': GithubSettingsPayload;
  'settings.security': SecuritySettingsPayload;
  'settings.export': void;
  'settings.reset': void;
  'vault.setup': { passphrase: string; secrets?: SecretPayloadPatch };
  'vault.unlock': { passphrase: string };
  'vault.lock': void;
  'vault.status': void;
  'ai.ledger': { limit?: number };
  'ai.ledger.clear': void;
}

export type ExtensionRequest = {
  [K in RequestType]: { type: K; payload?: RequestPayloads[K] };
}[RequestType];

export type ErrorCode =
  | 'auth'
  | 'scope'
  | 'notFound'
  | 'conflict'
  | 'rateLimited'
  | 'timeout'
  | 'network'
  | 'locked'
  | 'needVault'
  | 'wrongPassphrase'
  | 'passphraseTooShort'
  | 'badJson'
  | 'emptyResponse'
  | 'publicRepo'
  | 'notConfigured'
  | 'parse'
  | 'validation'
  /** The companion process is not installed, not running, or refused the connection. */
  | 'nativeUnavailable'
  /** The companion speaks a different protocol version — the user must upgrade one side. */
  | 'protocolMismatch'
  /** A git operation itself failed (dirty tree, rejected merge, ssh auth). NOT a network problem. */
  | 'gitFailed'
  /** A merge produced a conflict copy; both versions were preserved. */
  | 'syncConflict'
  /** The local search index is missing or corrupt and must be rebuilt. */
  | 'indexUnavailable'
  /** The content tier cannot be changed here: the repository already holds content (R8). */
  | 'tierLocked'
  /** Token mode with no stored token: a different fix from "nothing is configured". */
  | 'needToken'
  /** One commit carried more files than the guard allows (search-shard fan-out). */
  | 'commitTooLarge'
  | 'unknown';

export interface OkResponse<T = unknown> {
  ok: true;
  data: T;
}

export interface ErrResponse {
  ok: false;
  error: string;
  code: ErrorCode;
}

export type ExtensionResponse<T = unknown> = OkResponse<T> | ErrResponse;

export function ok<T>(data: T): OkResponse<T> {
  return { ok: true, data };
}

export function fail(error: string, code: ErrorCode = 'unknown'): ErrResponse {
  return { ok: false, error, code };
}

/** Map an error code onto the i18n key the UI should render. */
export function errorKeyFor(code: ErrorCode): string {
  return `error.${code}`;
}

export function isExtensionResponse(value: unknown): value is ExtensionResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { ok?: unknown };
  return typeof candidate.ok === 'boolean';
}

/* ----------------------------- response shapes ---------------------------- */

/** Why a requested distillation did not run, so the UI can offer the right next step. */
export type DistillSkipReason = 'not-authorized' | 'no-provider-key' | 'no-provider-model' | 'failed';

export interface CaptureResultData {
  /** Repository path of the written (or already existing) source item. */
  path: string;
  commitUrl: string;
  /** True when an equivalent item was already in the Inbox and nothing was written. */
  duplicate: boolean;
  /** The capture could not be written yet and now waits in the retry queue. */
  queued?: boolean;
  /** Present when the caller asked for a distillation in the same round trip. */
  distill?: { cardPath: string; commitUrl: string; warnings: string[] } | null;
  distillSkipped?: DistillSkipReason;
}

export interface DistillResultData {
  cardPath: string;
  commitUrl: string;
  warnings: string[];
}

export interface InboxEntry {
  id: string;
  path: string;
  title: string;
  url: string;
  capturedAt: string;
}

/** Hard caps. Anything beyond these is rejected before a handler, a fetch or a write happens. */
export const LIMITS = {
  bodyChars: 600_000,
  selectionChars: 200_000,
  titleChars: 500,
  urlChars: 4_096,
  bylineChars: 500,
  langChars: 35,
  passphraseChars: 256,
  modelChars: 120,
  baseUrlChars: 2_048,
  apiKeyChars: 4_096,
  ownerChars: 100,
  repoChars: 200,
  branchChars: 200,
  pathPrefixChars: 500,
  inboxLimit: 100,
  ledgerLimit: 500,
} as const;

/** The only two requests a page-context script may send. */
export const CONTENT_SCRIPT_ALLOWED_TYPES: ReadonlySet<RequestType> = new Set<RequestType>([
  'prefs.get',
  'capture.request',
]);

/** Requests that read or write a credential, therefore require an extension-page sender. */
export const SECRET_BEARING_TYPES: ReadonlySet<RequestType> = new Set<RequestType>([
  'settings.provider',
  'settings.github',
  'settings.export',
  'settings.reset',
  'vault.setup',
  'vault.unlock',
  'vault.lock',
  'store.probe',
  'distill.request',
  // These reach the repository (which needs a credential) or ask the companion to run git, so they
  // are extension-page only as well — never reachable from page-context code.
  'auth.probe',
  'native.status',
  'sync.now',
  'sync.status',
  'sync.policy',
  'search.query',
  'search.rebuild',
  'cards.list',
  'card.decide',
  'conflict.resolve',
  'review.due',
]);

export class MessageError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode = 'validation') {
    super(message);
    this.name = 'MessageError';
    this.code = code;
  }
}

/** Structural view of a `runtime.MessageSender` — avoids importing browser types here. */
export interface SenderLike {
  url?: string;
  tab?: { url?: string; id?: number } | undefined;
  id?: string;
}

const EXTENSION_URL_PREFIXES = ['chrome-extension://', 'moz-extension://', 'extension://'];

/**
 * True when the sender is an extension page (popup/options) or the extension itself.
 * A content script always reports the page URL, so a hostile page can never be mistaken for one.
 */
export function isExtensionPageSender(sender: SenderLike | null | undefined): boolean {
  if (!sender) return true; // internal/background call
  const url = sender.url ?? sender.tab?.url;
  if (!url) return true; // no page context (e.g. a worker-internal caller)
  return EXTENSION_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export function isRequestType(value: unknown): value is RequestType {
  return typeof value === 'string' && (REQUEST_TYPES as readonly string[]).includes(value);
}

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (typeof value !== 'object' || value === null) return false;
  return isRequestType((value as { type?: unknown }).type);
}

export function isContentScriptAllowed(type: RequestType): boolean {
  return CONTENT_SCRIPT_ALLOWED_TYPES.has(type);
}

export function requiresExtensionPageSender(type: RequestType): boolean {
  return SECRET_BEARING_TYPES.has(type);
}

/**
 * The single gate every inbound message passes through, in order:
 * 1. the type must be known;
 * 2. a page-context sender may only send allow-listed types;
 * 3. credential-touching types need an extension-page sender.
 *
 * Throws `MessageError` — callers reply with `fail(...)` and never run the handler.
 */
export function assertRequestAllowed(request: unknown, sender?: SenderLike | null): RequestType {
  if (!isExtensionRequest(request)) {
    throw new MessageError('unknown request type', 'validation');
  }
  const type = request.type;
  const fromExtensionPage = isExtensionPageSender(sender);

  if (!fromExtensionPage && !isContentScriptAllowed(type)) {
    throw new MessageError(`request "${type}" is not allowed from a page context`, 'auth');
  }
  if (!fromExtensionPage && requiresExtensionPageSender(type)) {
    throw new MessageError(`request "${type}" requires an extension page sender`, 'auth');
  }
  return type;
}

/* ------------------------------- validation ------------------------------- */

function requireString(
  value: unknown,
  field: string,
  maxChars: number,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') throw new MessageError(`${field} must be a string`);
  if (!options.allowEmpty && value.length === 0) throw new MessageError(`${field} must not be empty`);
  if (value.length > maxChars) throw new MessageError(`${field} exceeds ${maxChars} characters`);
  return value;
}

function optionalString(value: unknown, field: string, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, maxChars, { allowEmpty: true });
}

function requireRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    throw new MessageError('payload must be an object');
  }
  return payload as Record<string, unknown>;
}

function ensureSafeRelativePath(prefix: string, field: string): string {
  const segments = prefix.split('/').filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new MessageError(`${field} must not contain "." or ".." segments`);
    }
  }
  return prefix;
}

/** https:// everywhere; http:// is tolerated only for loopback (local stubs and bridges). */
export function isAcceptableEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  }
  return false;
}

export function validateCaptureRequest(payload: unknown): CaptureRequestPayload {
  const raw = requireRecord(payload);
  const mode = raw['mode'];
  if (mode !== 'page' && mode !== 'selection' && mode !== 'note') {
    throw new MessageError('mode must be page | selection | note');
  }
  const url = requireString(raw['url'], 'url', LIMITS.urlChars);
  const title = requireString(raw['title'], 'title', LIMITS.titleChars, { allowEmpty: true });

  if (mode === 'selection' || mode === 'note') {
    // The selection is the payload's reason to exist; an empty one is a bug, not a capture.
    requireString(raw['selection'], 'selection', LIMITS.selectionChars);
  }

  const out: CaptureRequestPayload = { mode, url, title };
  const body = optionalString(raw['body'], 'body', LIMITS.bodyChars);
  if (body !== undefined) out.body = body;
  const selection = optionalString(raw['selection'], 'selection', LIMITS.selectionChars);
  if (selection !== undefined) out.selection = selection;
  const byline = optionalString(raw['byline'], 'byline', LIMITS.bylineChars);
  if (byline !== undefined) out.byline = byline;
  const lang = optionalString(raw['lang'], 'lang', LIMITS.langChars);
  if (lang !== undefined) out.lang = lang;
  const capturedAt = optionalString(raw['capturedAt'], 'capturedAt', 40);
  if (capturedAt !== undefined) out.capturedAt = capturedAt;
  if (raw['distill'] !== undefined) {
    if (typeof raw['distill'] !== 'boolean') {
      throw new MessageError('distill must be a boolean');
    }
    out.distill = raw['distill'];
  }
  return out;
}

export function validatePassphrase(payload: unknown): string {
  const raw = requireRecord(payload);
  return requireString(raw['passphrase'], 'passphrase', LIMITS.passphraseChars);
}

export function validateProviderSettings(payload: unknown): ProviderSettingsPayload {
  const raw = requireRecord(payload);
  const providerId = requireString(raw['providerId'], 'providerId', 40);
  const model = requireString(raw['model'], 'model', LIMITS.modelChars);
  const out: ProviderSettingsPayload = { providerId, model };

  const baseUrl = optionalString(raw['baseUrl'], 'baseUrl', LIMITS.baseUrlChars);
  if (baseUrl !== undefined && baseUrl.length > 0) {
    if (!isAcceptableEndpoint(baseUrl)) {
      throw new MessageError('baseUrl must be an https URL (http is allowed for loopback only)');
    }
    out.baseUrl = baseUrl;
  }
  const apiKey = optionalString(raw['apiKey'], 'apiKey', LIMITS.apiKeyChars);
  if (apiKey !== undefined) out.apiKey = apiKey;
  if (raw['trustAcknowledged'] !== undefined) {
    if (typeof raw['trustAcknowledged'] !== 'boolean') {
      throw new MessageError('trustAcknowledged must be a boolean');
    }
    out.trustAcknowledged = raw['trustAcknowledged'];
  }
  return out;
}

export function validateGithubSettings(payload: unknown): GithubSettingsPayload {
  const raw = requireRecord(payload);
  const owner = requireString(raw['owner'], 'owner', LIMITS.ownerChars);
  const repo = requireString(raw['repo'], 'repo', LIMITS.repoChars);
  const branch = requireString(raw['branch'], 'branch', LIMITS.branchChars);
  if (/[\s]/u.test(owner) || /[\s/]/u.test(repo) || /\s/u.test(branch)) {
    throw new MessageError('owner, repo and branch must not contain whitespace or slashes');
  }
  const out: GithubSettingsPayload = { owner, repo, branch };

  const pathPrefix = optionalString(raw['pathPrefix'], 'pathPrefix', LIMITS.pathPrefixChars);
  if (pathPrefix !== undefined) out.pathPrefix = ensureSafeRelativePath(pathPrefix, 'pathPrefix');
  const pat = optionalString(raw['pat'], 'pat', LIMITS.apiKeyChars);
  if (pat !== undefined) out.pat = pat;
  const apiBase = optionalString(raw['apiBase'], 'apiBase', LIMITS.baseUrlChars);
  if (apiBase !== undefined && apiBase.length > 0) {
    if (!isAcceptableEndpoint(apiBase)) {
      throw new MessageError('apiBase must be an https URL (http is allowed for loopback only)');
    }
    out.apiBase = apiBase;
  }
  if (raw['publicRepoAcknowledged'] !== undefined) {
    if (typeof raw['publicRepoAcknowledged'] !== 'boolean') {
      throw new MessageError('publicRepoAcknowledged must be a boolean');
    }
    out.publicRepoAcknowledged = raw['publicRepoAcknowledged'];
  }
  return out;
}

export function validateSecuritySettings(payload: unknown): SecuritySettingsPayload {
  const raw = requireRecord(payload);
  const out: SecuritySettingsPayload = {};
  if (raw['enabled'] !== undefined) {
    if (typeof raw['enabled'] !== 'boolean') throw new MessageError('enabled must be a boolean');
    out.enabled = raw['enabled'];
  }
  if (raw['aiAuthorized'] !== undefined) {
    if (typeof raw['aiAuthorized'] !== 'boolean') {
      throw new MessageError('aiAuthorized must be a boolean');
    }
    out.aiAuthorized = raw['aiAuthorized'];
  }
  if (raw['securityMode'] !== undefined) {
    if (raw['securityMode'] !== 'vault' && raw['securityMode'] !== 'transparent') {
      throw new MessageError('securityMode must be vault | transparent');
    }
    out.securityMode = raw['securityMode'];
  }
  if (raw['autoLockMinutes'] !== undefined) {
    const minutes = raw['autoLockMinutes'];
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
      throw new MessageError('autoLockMinutes must be a positive number');
    }
    out.autoLockMinutes = Math.min(720, Math.max(1, Math.round(minutes)));
  }
  if (raw['unlockPolicy'] !== undefined) {
    if (raw['unlockPolicy'] !== 'strict' && raw['unlockPolicy'] !== 'remember') {
      throw new MessageError('unlockPolicy must be strict | remember');
    }
    out.unlockPolicy = raw['unlockPolicy'];
  }
  if (raw['authMode'] !== undefined) out.authMode = validateAuthMode(raw['authMode']);
  if (raw['contentTierChosen'] !== undefined) {
    if (typeof raw['contentTierChosen'] !== 'boolean') {
      throw new MessageError('contentTierChosen must be a boolean');
    }
    out.contentTierChosen = raw['contentTierChosen'];
  }
  return out;
}

export function validateCapturePageRequest(payload: unknown): { distill?: boolean } {
  if (payload === undefined || payload === null) return {};
  const raw = requireRecord(payload);
  const out: { distill?: boolean } = {};
  if (raw['distill'] !== undefined) {
    if (typeof raw['distill'] !== 'boolean') throw new MessageError('distill must be a boolean');
    out.distill = raw['distill'];
  }
  return out;
}

export function validateDistillRequest(payload: unknown): DistillRequestPayload {
  const raw = requireRecord(payload);
  const sourceId = requireString(raw['sourceId'], 'sourceId', 32);
  const sourcePath = requireString(raw['sourcePath'], 'sourcePath', LIMITS.pathPrefixChars);
  const out: DistillRequestPayload = { sourceId, sourcePath };
  if (raw['allowThisSession'] !== undefined) {
    if (typeof raw['allowThisSession'] !== 'boolean') {
      throw new MessageError('allowThisSession must be a boolean');
    }
    out.allowThisSession = raw['allowThisSession'];
  }
  return out;
}

export function validateLimit(payload: unknown, fallback: number, max: number): number {
  if (payload === undefined || payload === null) return fallback;
  if (typeof payload !== 'object') throw new MessageError('payload must be an object');
  const raw = payload as Record<string, unknown>;
  const limit = raw['limit'];
  if (limit === undefined || limit === null) return fallback;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    throw new MessageError('limit must be a positive number');
  }
  return Math.min(max, Math.floor(limit));
}
