/**
 * Background handlers — everything the router dispatches to.
 *
 * Kept in `lib/` rather than in the entrypoint so the whole worker surface is testable in Node with
 * an injected fetch, clock and storage area. `entrypoints/background.ts` is then pure wiring.
 *
 * The store is built on demand (`resolveStore`) because it needs three things that can each be
 * missing or locked at request time: repository settings, an unlocked vault, and the store KDF
 * parameters. Building it per request also means a settings change takes effect immediately.
 */

import { resolveAuth, probeAvailability } from '../auth/resolve';
import type { AuthContext } from '../auth/types';
import { CaptureService } from '../capture/service';
import { DistillService, isDistillSkipped } from '../distill-service';
import { MessageError, fail, ok, type DistillSkipReason, type ExtensionRequest, type ExtensionResponse, type InboxEntry, type RequestType } from '../messages';
import type { AiLedger, CaptureQueue } from '../queues';
import type { CryptoProvider } from '../security/crypto-key';
import { parseEnvelope } from '../security/crypto-key';
import { VaultLockedError, type KeySession } from '../security/key-session';
import { scrub, scrubError } from '../security/redact';
import {
  ConflictError,
  NotConfiguredError,
  NotFoundError,
  PublicRepoError,
  StoreError,
} from '../store/errors';

import { createGithubApi, type FetchLike } from '../store/github-api';
import { vaultKdfFromEnvelope } from '../store/vault-codec';
import { createGitTransportStore } from '../store/git-transport';
import { createRepoStore, type RepoStore } from '../store/repo-store';
import { isShardKey } from '../search/tokenize';
import { loadStoreConfig, selectCodec, storeConfigFileIfMissing, switchTier } from '../store/tier';
import type { ContentCodec } from '../store/codec';
import type { CkfRecord } from '../core/ckf';
import { reviewStatePath } from '../core/paths';
import type { RepoFile } from '../store/types';
import type { StoreProbe } from '../store/types';
import type { PublicSyncState } from '../public-prefs';
import { NativeError } from '../native/client';
import type { NativeClient } from '../native/client';
import { SyncCache, createBestBackend } from '../sync/cache';
import {
  remoteFromStore,
  runSync,
  type SyncRemote,
  type SyncReport,
} from '../sync/engine';
import { planCardDecision, type CardDecisionShards } from '../cards/decide';
import { planSourceArchive } from '../sources/archive';
import { planSourceDelete } from '../sources/delete';
import { dueForReview, parseReviewFile } from '../local/insights';
import { planConflictResolution } from '../sync/conflict';
import { createRemoteShardStore } from '../sync/shard-store';
import type { SyncTriggers } from '../sync/triggers';
import { SearchIndex } from '../search/index';
import { documentOf } from '../search/postings';
import type { SyncReason } from '../messages';
import {
  validateCapturePageRequest,
  validateCaptureRequest,
  validateDistillRequest,
  validateGithubSettings,
  validateLimit,
  validatePassphrase,
  validateProviderSettings,
  validateCardDecide,
  validateCardList,
  validateConflictResolve,
  validateSearchQuery,
  validateSecuritySettings,
  validateSourceArchive,
  validateSourceDelete,
  validateSyncPolicy,
  validateSyncRequest,
  LIMITS,
  type SecurityMode,
} from '../messages';
import type { SettingsStore, UnlockPolicy } from '../settings-store';
import type { StatusData, VaultStatusData } from '../status';
import { errorCodeOf, type HandlerMap } from './router';

export interface BackgroundContext {
  settings: SettingsStore;
  queue: CaptureQueue;
  ledger: AiLedger;
  session: KeySession;
  fetchImpl: FetchLike;
  now?: () => number;
  crypto?: CryptoProvider;
  /** Resolve the active tab, for `capture.page`. */
  activeTab?: () => Promise<{ id?: number; url?: string } | null>;
  /** Ask the content script in a tab to clip itself. Returns false when the page is unreachable. */
  pageClip?: (tabId: number, distill: boolean) => Promise<boolean>;
  /** Open a URL in a new tab (used by the UI reply path when needed). */
  openUrl?: (url: string) => Promise<void>;
  /** Native-messaging client; `null`/`undefined` when the platform (or a test) has none. */
  native?: NativeClient | null;
  /** Injected in tests; production builds one lazily-created cache per worker. */
  syncCache?: SyncCache;
  /** Injected in tests; the entrypoint owns the `browser.alarms` binding. */
  triggers?: SyncTriggers;
  /**
   * The running extension version, recorded as `client_version` in `.omnipilot/config.json`.
   * Optional so a bare test harness can leave it unknown rather than invent one.
   */
  clientVersion?: string;
}

function notConfigured(): never {
  throw new NotConfiguredError();
}

/**
 * Build the GitHub store for the current settings.
 *
 * Fails closed: without an unlocked vault there are no secrets and therefore no store — the caller
 * gets `VaultLockedError` (code `locked`) and the UI offers to unlock, rather than any plaintext path.
 */
interface ResolvedRepo {
  store: RepoStore;
  prefix: string | null;
}

/**
 * The repository, resolved through the **selected authorization mode**.
 *
 * This is the single place that decides which transport serves a request: token mode gets the REST
 * store, SSH mode gets the companion's git wrapped in the same face. Everything above it — capture,
 * distill, cards, review, conflicts, search — is written against that one face, which is what makes
 * "SSH is a supported mode" true rather than a claim about the picker alone (R7).
 *
 * The content tier is resolved here too, and the **repository's own record wins**: a store that says
 * `vault` is read and written as vault even when this installation's settings say otherwise, so no
 * client can downgrade another client's repository to plaintext (R8).
 */
async function resolveRepo(context: BackgroundContext): Promise<ResolvedRepo> {
  const authContext = await buildAuthContext(context);
  const settings = authContext.snapshot;
  const prefix = settings.github.pathPrefix || null;
  // A diagnosis, not a second gate: the repository is named and the vault is open, but no token was ever
  // stored. `notConfigured` cannot tell that apart from "no repository", and the two need different fixes —
  // so this one says exactly what is missing. The auth layer below still decides whether the mode can run.
  if (settings.authMode === 'token' && settings.github.owner.length > 0 && settings.github.repo.length > 0) {
    const stored = await context.settings.peekSecrets();
    if (stored && !stored.githubPat) {
      throw new MessageError('storage: no GitHub token is stored yet', 'needToken');
    }
  }

  const resolution = await resolveAuth(authContext);
  if (!resolution.ok) raiseUnavailable(resolution.reason, resolution.message);
  const auth = resolution.auth;

  const envelope = await context.settings.getEnvelope();
  const kdf = envelope ? vaultKdfFromEnvelope(envelope) : null;
  const tierContext = {
    prefix,
    ...(context.clientVersion ? { clientVersion: context.clientVersion } : {}),
    ...(context.now ? { now: context.now } : {}),
  };

  if (auth.mode === 'token') {
    // The store needs a tier to exist, and the tier needs the store to be read: start from the
    // settings, then rebuild once if the repository records something else. The rebuild happens only
    // in the case this whole path exists to fix.
    const first = await auth.createStore();
    const recorded = await loadStoreConfig({ store: first, ...tierContext }, settings.securityMode);
    if (recorded.security_mode === settings.securityMode) return { store: first, prefix };
    return { store: await auth.createStore(recorded.security_mode), prefix };
  }

  const transport = await auth.createTransport();
  const repoFullName = `${settings.github.owner}/${settings.github.repo}`;
  const knowledge = createGitTransportStore({
    native: transport.native,
    repoRoot: transport.repoRoot,
    branch: transport.branch,
    repoFullName,
    ...(context.now ? { now: context.now } : {}),
  });
  const recorded = await loadStoreConfig({ store: knowledge, ...tierContext }, settings.securityMode);
  const codec = selectCodec(recorded.security_mode, context.session, context.crypto, {
    ...(kdf ? { kdf } : {}),
    prefix,
    ...(context.now ? { now: context.now } : {}),
  });
  return {
    store: createRepoStore(knowledge, { codec, prefix, repoFullName, branch: transport.branch }),
    prefix,
  };
}

/**
 * The repository every caller above the sync engine talks to.
 *
 * Fails closed: without an unlocked vault there are no secrets and therefore no store — the caller
 * gets `VaultLockedError` (code `locked`) and the UI offers to unlock, rather than any plaintext path.
 */
export async function resolveStore(context: BackgroundContext): Promise<RepoStore> {
  // Shared with any other message in flight: see `resolveRepoShared`.
  return (await resolveRepoShared(context)).store;
}

/**
 * Concurrent messages share ONE in-flight store resolution.
 *
 * The popup opens with five of them at once (status, inbox, cards, review, sync), and each used to resolve
 * the store on its own - including a network read of `.omnipilot/config.json` per message. Sharing the
 * promise is safe by construction: only requests already in flight coalesce, so nothing is cached and a
 * later request always gets a fresh resolution (no TTL, no stale tier, no stale credential).
 */
const inFlightResolve = new WeakMap<BackgroundContext, Promise<ResolvedRepo>>();

function resolveRepoShared(context: BackgroundContext): Promise<ResolvedRepo> {
  const running = inFlightResolve.get(context);
  if (running) return running;
  const started = resolveRepo(context);
  inFlightResolve.set(context, started);
  // Cleared on success AND failure: a remembered rejection would poison the next burst.
  void started
    .catch(() => undefined)
    .finally(() => {
      inFlightResolve.delete(context);
    });
  return started;
}

/* ------------------------------------------------------------------ *
 * Sync / search wiring
 * ------------------------------------------------------------------ */

async function buildAuthContext(context: BackgroundContext): Promise<AuthContext> {
  const snapshot = await context.settings.load();
  return {
    settings: context.settings,
    snapshot,
    session: context.session,
    fetchImpl: context.fetchImpl,
    native: context.native ?? null,
    ...(context.crypto ? { crypto: context.crypto } : {}),
    ...(context.now ? { now: context.now } : {}),
  };
}

/**
 * Turn an `unavailable` resolution into the classified error the router already knows how to report.
 *
 * Deliberately not a generic failure: "the companion is not installed" and "the vault is locked" lead
 * the user to completely different actions, and collapsing them into one message loses that.
 */
function raiseUnavailable(reason: string, message: string): never {
  if (reason === 'native-missing') throw new NativeError('nativeUnavailable', message);
  if (reason === 'protocol-mismatch') throw new NativeError('protocolMismatch', message);
  if (reason === 'vault-locked') throw new VaultLockedError(message);
  throw new NotConfiguredError(message);
}

/**
 * Build the remote + codec for the **currently selected** auth mode.
 *
 * Going through `resolveAuth` rather than branching here is what keeps token and SSH honest: the same
 * call the UI probes with is the one the sync runs with, so "the picker says SSH is ready" and "the
 * sync used SSH" cannot drift apart.
 */
/**
 * Record a tier change where it belongs — in the repository — or refuse it.
 *
 * A store that already holds content cannot be switched (there is no re-encode migration in this MVP),
 * and saying so is what stops a tier change from silently orphaning every file the previous codec
 * wrote. A store that is not reachable yet is left alone: the tier still travels in the settings, and
 * the first content write records it (`storeConfigFileIfMissing`).
 */
async function recordTierChange(context: BackgroundContext, to: SecurityMode): Promise<void> {
  let store: RepoStore;
  try {
    store = await resolveStore(context);
  } catch {
    // Not configured, or the vault is locked: nothing to record yet, and the choice is not lost.
    return;
  }
  const settings = await context.settings.load();
  await switchTier({
    store,
    prefix: settings.github.pathPrefix || null,
    to,
    ...(context.clientVersion ? { clientVersion: context.clientVersion } : {}),
    ...(context.now ? { now: context.now } : {}),
  });
}

/**
 * The sync engine's view of the same repository.
 *
 * Deliberately built from `resolveRepo` rather than resolving auth a second time: the mode and the
 * tier a sync uses must be the ones every other handler uses, or a sync could write ciphertext into a
 * store the rest of the worker reads as plaintext.
 */
async function resolveSyncRemote(
  context: BackgroundContext,
): Promise<{ remote: SyncRemote; codec: ContentCodec; prefix: string | null }> {
  const { store, prefix } = await resolveRepo(context);
  const base = remoteFromStore(store);
  // `refresh` (git fetch) only exists on the companion transport; the REST path reads the remote.
  const remote: SyncRemote = store.refresh ? { ...base, refresh: () => store.refresh!() } : base;
  return { remote, codec: store.contentCodec, prefix };
}

/**
 * The worker's cache: IndexedDB when the context has it, the memory fallback in a bare harness.
 *
 * A single instance per context matters — the cache holds the dirty set, and two instances would each
 * believe they owned it.
 */
export function createSyncCache(context: BackgroundContext): SyncCache {
  return (
    context.syncCache ??
    new SyncCache(createBestBackend((globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null).backend)
  );
}

/**
 * Run one reconciliation. Exported because the periodic/startup triggers must reach it without going
 * through the message router (the router would — correctly — refuse a request with no page sender).
 */
export async function performSync(
  context: BackgroundContext,
  reason: SyncReason,
): Promise<SyncReport> {
  const settings = await context.settings.load();
  const cache = createSyncCache(context);
  /*
   * Resolving the remote is inside its own guard, because it is the step that fails first when the
   * repository, the credential or the tier cannot be resolved - and it used to leave NO trace: the panel went
   * on saying "never synced" while the toast reported a failure, and the reason was never stored, so no
   * surface could show it. A failure has to be recorded wherever it happens, not only where reconciliation
   * happens (failure visible, with a reason the UI can translate).
   */
  let resolved: Awaited<ReturnType<typeof resolveSyncRemote>>;
  try {
    resolved = await resolveSyncRemote(context);
  } catch (error) {
    await cache.updateState({ lastOutcome: 'failed', lastErrorCode: errorCodeOf(error) });
    throw error;
  }
  const { remote, codec, prefix } = resolved;
  const { index, drain } = buildSearchIndex(remote, prefix, cache, context);
  try {
    const report = await runSync(
    {
      cache,
      index,
      codec,
      remote,
      prefix,
      session: context.session,
      policy: settings.syncPolicy,
        drainShards: drain,
        ...(context.now ? { now: context.now } : {}),
      },
      reason,
    );
    /*
     * A success is recorded too. Only the failure path used to write state, so a sync that succeeded left the
     * panel reading "never synced" - a surface that was confidently wrong, which is the exact failure mode
     * this projection exists to remove. `upToDate` in particular writes nothing on the remote, so nothing else
     * had recorded it either. The engine's own write wins when there is one: this only fills the gap.
     */
    const previous = await cache.state();
    if (previous.lastOutcome !== report.outcome) {
      await cache.updateState({
        lastOutcome: report.outcome,
        ...(previous.lastSyncAt === null
          ? { lastSyncAt: new Date(context.now?.() ?? Date.now()).toISOString() }
          : {}),
      });
    }
    return report;
  } catch (error) {
    // Record **why** in a form the UI can translate, then let the failure propagate: a caller (the message
    // router, a trigger) still has to see it. Storing the code rather than the sentence is what keeps an
    // outside string out of the status line.
    await cache.updateState({ lastOutcome: 'failed', lastErrorCode: errorCodeOf(error) });
    throw error;
  }
}

/**
 * The shard operations a card decision needs, read against the repository so the postings travel with the card
 * in the same commit (the same rule captures follow since T5.7).
 */
function cardShards(store: RepoStore, prefix: string | null): CardDecisionShards {
  const shards = createRemoteShardStore(store, prefix);
  const index = new SearchIndex({ store: shards, prefix });
  return {
    change: (card, previous) => index.changedShards(card, previous),
    remove: (card, path) => index.remove(card.id, path, card),
  };
}

/** The index reads its shards out of the repository; the cache supplies the text for snippets. */
function buildSearchIndex(
  remote: SyncRemote,
  prefix: string | null,
  cache: SyncCache,
  context: BackgroundContext,
): { index: SearchIndex; drain: () => import('../store/types').RepoFile[] } {
  const shards = createRemoteShardStore(remote, prefix);
  const index = new SearchIndex({
    store: shards,
    prefix,
    docs: async () => {
      const cached = (await cache.all())
        .filter((entry) => entry.record.kind !== 'review')
        .map((entry) => documentOf(entry.record, entry.path));
      if (cached.length > 0) return cached;
      /*
       * A cold record cache must not read as "no results". The query needs a document per hit only to show
       * a title and a snippet; the manifest already knows which records exist and where, so falling back to
       * it returns the right hits (title/snippet stay empty until the cache warms up, and the popup already
       * falls back to the path for a missing title).
       */
      const manifest = await remote.readIndex();
      return Object.values(manifest.items).map((item) => ({
        id: item.id,
        kind: item.kind,
        path: item.path,
        title: '',
        fields: {},
        updated_at: typeof item.updated_at === 'string' ? item.updated_at : '',
      }));
    },
    ...(context.now ? { now: context.now } : {}),
  });
  return { index, drain: () => shards.drain() };
}

/**
 * The shard files a record changes, read against the repository so they can ride in its commit (T5.7).
 *
 * Built from the *store*, not from the sync transport: a capture commits through the token path even
 * when the sync mode is SSH, so the shards it produces must be produced the same way.
 */
export function shardProvider(
  store: RepoStore,
  prefix: string | null,
): (record: CkfRecord) => Promise<RepoFile[]> {
  const shards = createRemoteShardStore(store, prefix);
  const index = new SearchIndex({ store: shards, prefix });
  return (record) => index.changedShards(record);
}

/** Filters are part of the query language (`tag:x`), so they are folded into the text. */
function withFilters(text: string, filters: { tag?: string; topic?: string; in?: string }): string {
  const parts = [text];
  if (filters.tag) parts.push(`tag:${filters.tag}`);
  if (filters.topic) parts.push(`topic:${filters.topic}`);
  if (filters.in) parts.push(`in:${filters.in}`);
  return parts.filter((part) => part.length > 0).join(' ').trim();
}

/** Last write wins per path — a rebuild and a shard buffer can name the same shard file. */
function dedupeFiles(
  files: readonly import('../store/types').RepoFile[],
): import('../store/types').RepoFile[] {
  const byPath = new Map<string, import('../store/types').RepoFile>();
  for (const file of files) byPath.set(file.path, file);
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function safeProbe(store: RepoStore): Promise<StoreProbe | null> {
  try {
    return await store.probe();
  } catch (error) {
    // A probe failure is metadata, not an error: the UI shows "unknown" instead of a broken page.
    if (error instanceof StoreError) return null;
    throw error;
  }
}

function vaultStatusData(vault: {
  configured: boolean;
  unlocked: boolean;
  expiresAt: number | null;
  remainingMs: number;
  unlockPolicy: UnlockPolicy;
}): VaultStatusData {
  return {
    configured: vault.configured,
    unlocked: vault.unlocked,
    expiresAt: vault.expiresAt,
    remainingMs: vault.remainingMs,
    unlockPolicy: vault.unlockPolicy,
  };
}

/**
 * Probe with the credentials the user just typed, BEFORE persisting them.
 * This is what makes "save the storage section" fail early on a bad token or a public repo.
 */
async function probeCandidate(
  context: BackgroundContext,
  candidate: { owner: string; repo: string; branch: string; apiBase?: string; pat?: string },
): Promise<StoreProbe | null> {
  const existing = await context.settings.peekSecrets();
  const token = candidate.pat && candidate.pat.length > 0 ? candidate.pat : (existing?.githubPat ?? '');
  // SSH mode stores no token, so there is nothing to probe with — and failing the save for that made
  // an SSH-only configuration impossible to record (the mode is chosen in the same save, so the stored
  // mode is still `token` when this runs). The page's own 测试连接 is what verifies it (R7).
  if (!token) return null;

  const api = createGithubApi({
    fetchImpl: context.fetchImpl,
    token,
    owner: candidate.owner,
    repo: candidate.repo,
    branch: candidate.branch,
    ...(candidate.apiBase ? { apiBase: candidate.apiBase } : {}),
    ...(context.now ? { now: context.now } : {}),
  });
  return api.probeRepo();
}

/**
 * The sync half of the public projection.
 *
 * It was never supplied, which meant `PublicPrefs.sync` was always the default — the row said "never synced"
 * no matter what had actually happened. A surface that is confidently wrong is the same failure mode this whole
 * requirement exists to remove, so the state now comes from the cache and the failure is a **code** the UI
 * translates from its own table.
 */
async function syncStateForPrefs(cache: SyncCache): Promise<PublicSyncState> {
  const [state, dirty] = await Promise.all([cache.state(), cache.dirty()]);
  return {
    lastSyncAt: state.lastSyncAt,
    lastOutcome: state.lastOutcome,
    pending: dirty.length,
    conflicts: state.conflicts.length,
    lastFailureCode: state.lastErrorCode,
  };
}

/**
 * Add (or refresh) one card's entry in `review/state.json`.
 *
 * Accepting a proposal is the moment a card becomes something worth remembering, so it is also the moment the
 * review record is born — the audit's U2: the type existed for three releases and had **never** been created by any
 * production path. The file is cleartext by design (the codec refuses review records), holds no content, and is
 * rebuilt from scratch when it is unreadable rather than trusted.
 *
 * Shape (canonical, since nothing else defines it yet): `{ schema: 1, items: { <card id>: ReviewState } }`.
 */
function reviewStateWithEntry(raw: string | null, id: string, at: number): string {
  let items: Record<string, unknown> = {};
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const nested = record['items'];
        items =
          typeof nested === 'object' && nested !== null && !Array.isArray(nested)
            ? { ...(nested as Record<string, unknown>) }
            : { ...record };
      }
    } catch {
      items = {};
    }
  }
  items[id] = {
    id,
    kind: 'review',
    stability: 0,
    retrievability: 0,
    next_review_at: new Date(at).toISOString(),
    use_count: 0,
  };
  return JSON.stringify({ schema: 1, items }, null, 2) + '\n';
}

export function createHandlers(context: BackgroundContext): HandlerMap {
  const syncCache = createSyncCache(context);

  const handlers: Partial<Record<RequestType, (request: ExtensionRequest) => Promise<ExtensionResponse>>> = {
    'prefs.get': async () =>
      ok(await context.settings.publicPrefs({ sync: await syncStateForPrefs(syncCache) })),

    'status.get': async () => {
      const [prefs, vault] = await Promise.all([
        context.settings.publicPrefs({ sync: await syncStateForPrefs(syncCache) }),
        context.settings.vaultStatus(),
      ]);
      const data: StatusData = { prefs, probe: null, vault: vaultStatusData(vault) };
      if (!prefs.hasPat || prefs.repoFullName.length === 0) return ok(data);
      try {
        data.probe = await safeProbe(await resolveStore(context));
      } catch {
        data.probe = null;
      }
      return ok(data);
    },

    'inbox.list': async (request) => {
      const limit = validateLimit(request.payload, 10, LIMITS.inboxLimit);
      const store = await resolveStore(context);
      const items = await store.listInbox(limit);
      const entries: InboxEntry[] = items.map((item) => ({
        id: item.id,
        path: item.path,
        // The index carries no title in vault mode; the path is the honest fallback.
        title: item.path.split('/').pop() ?? item.id,
        url: '',
        capturedAt: item.created_at,
      }));
      return ok(entries);
    },

    'capture.request': async (request) => {
      const payload = validateCaptureRequest(request.payload);
      const store = await resolveStore(context);
      const settings = await context.settings.load();
      const service = new CaptureService({
        store,
        queue: context.queue,
        shards: shardProvider(store, settings.github.pathPrefix || null),
        // The first write of a capture also records which tier this repository holds, so it describes
        // itself from its first commit onward instead of leaving every client to assume (T7.1).
        bootstrap: async () => {
          const file = await storeConfigFileIfMissing({
            store,
            prefix: settings.github.pathPrefix || null,
            chosenMode: settings.securityMode,
            branch: settings.github.branch,
            ...(context.clientVersion ? { clientVersion: context.clientVersion } : {}),
            ...(context.now ? { now: context.now } : {}),
          });
          return file ? [file] : [];
        },
        ...(context.now ? { now: context.now } : {}),
      });
      const outcome = await service.capture(payload);

      const data = {
        path: outcome.path,
        commitUrl: outcome.commitUrl,
        duplicate: outcome.duplicate,
        ...(outcome.queued ? { queued: true } : {}),
      };

      if (payload.distill !== true || outcome.queued || outcome.duplicate) return ok(data);

      // The capture has already succeeded: a distillation problem must not turn it into a failure.
      try {
        const distill = await runDistill(context, {
          sourceId: outcome.item.id,
          sourcePath: outcome.path,
          // Clicking 提炼 IS the per-item authorization (§6.2 "显式授权"); the global AI switch and
          // the ledger entry recorded below still apply.
          allowThisSession: true,
        });
        if (isDistillSkipped(distill)) {
          return ok({ ...data, distill: null, distillSkipped: distill.skipped });
        }
        return ok({ ...data, distill: { cardPath: distill.cardPath, commitUrl: distill.commitUrl, warnings: distill.warnings } });
      } catch {
        return ok({ ...data, distill: null, distillSkipped: 'failed' as DistillSkipReason });
      }
    },

    'capture.page': async (request) => {
      const { distill } = validateCapturePageRequest(request.payload);
      if (!context.activeTab || !context.pageClip) {
        throw new MessageError('capture: the active tab is not reachable');
      }
      const tab = await context.activeTab();
      if (!tab || typeof tab.id !== 'number') {
        throw new MessageError('capture: no active tab');
      }
      const accepted = await context.pageClip(tab.id, distill === true);
      if (!accepted) {
        throw new MessageError('capture: the page did not accept the clip request (reload it and retry)');
      }
      // The content script performs the capture and reports through its own toast.
      return ok({ accepted: true });
    },

    'distill.request': async (request) => {
      const payload = validateDistillRequest(request.payload);
      const result = await runDistill(context, payload);
      if (isDistillSkipped(result)) {
        return fail(`distill skipped: ${result.skipped}`, 'notConfigured');
      }
      return ok({ cardPath: result.cardPath, commitUrl: result.commitUrl, warnings: result.warnings });
    },

    'store.probe': async () => ok(await (await resolveStore(context)).probe()),

    'settings.provider': async (request) => {
      const payload = validateProviderSettings(request.payload);
      const current = await context.settings.load();
      const trustedHosts = new Set(current.ai.trustedHosts);
      /*
       * Trust is granted by the CONSENT FLAG, never by the mere presence of a base URL. This used to add the
       * host whenever the field was non-empty, which quietly made the sender of every custom endpoint trusted
       * whether or not the user had ticked the box - the one thing the product rules are explicit about (AI
       * egress is off by default and granted one endpoint at a time).
       */
      if (payload.baseUrl && payload.trustAcknowledged === true) {
        try {
          trustedHosts.add(new URL(payload.baseUrl).host);
        } catch {
          throw new MessageError('settings: the base URL is not valid');
        }
      }

      const patched = await context.settings.patch({
        ai: {
          providerId: payload.providerId,
          model: payload.model,
          baseUrl: payload.baseUrl ?? '',
          trustedHosts: [...trustedHosts],
        },
      });

      if (payload.apiKey !== undefined && payload.apiKey.length > 0) {
        if (!context.session.isUnlocked()) throw new MessageError('vault: unlock first', 'locked');
        await context.settings.updateSecrets({ providerKey: payload.apiKey });
      }
      return ok(patched.ai);
    },

    'settings.github': async (request) => {
      const payload = validateGithubSettings(request.payload);
      // Best-effort by design: a configuration must be recordable before it is verified. `null` means
      // "nothing to probe with", which is the normal state of an SSH-only setup (R7).
      const probe = await probeCandidate(context, payload);

      if (probe && probe.visibility === 'public' && payload.publicRepoAcknowledged !== true) {
        throw new PublicRepoError(
          'storage: this repository is public — acknowledge the risk before saving',
        );
      }

      const patched = await context.settings.patch({
        github: {
          owner: payload.owner,
          repo: payload.repo,
          branch: payload.branch,
          pathPrefix: payload.pathPrefix ?? '',
          ...(payload.apiBase ? { apiBase: payload.apiBase } : {}),
          publicRepoAcknowledged: payload.publicRepoAcknowledged === true,
        },
      });

      if (payload.pat !== undefined && payload.pat.length > 0) {
        if (!context.session.isUnlocked()) throw new MessageError('vault: unlock first', 'locked');
        await context.settings.updateSecrets({ githubPat: payload.pat });
      }
      return ok({ settings: patched.github, probe });
    },

    'settings.security': async (request) => {
      const payload = validateSecuritySettings(request.payload);
      // A tier change is a REPOSITORY operation, not a local preference (R8): it must be recorded where
      // the repository lives, and refused when the store already holds content the previous codec wrote.
      if (payload.securityMode !== undefined) {
        const current = await context.settings.load();
        if (payload.securityMode !== current.securityMode) {
          await recordTierChange(context, payload.securityMode);
        }
      }
      // The unlock policy is a VAULT setting, not part of local:settings: it lives next to the key it
      // authorizes, so the policy and the key cannot drift apart.
      if (payload.unlockPolicy !== undefined) {
        await context.settings.setUnlockPolicy(payload.unlockPolicy);
      }
      const patched = await context.settings.patch(payload);
      return ok({
        enabled: patched.enabled,
        aiAuthorized: patched.aiAuthorized,
        securityMode: patched.securityMode,
        autoLockMinutes: patched.autoLockMinutes,
        unlockPolicy: await context.settings.getUnlockPolicy(),
        // Echoed so the picker can confirm what was actually stored rather than assume.
        authMode: patched.authMode,
      });
    },

    'settings.export': async () => ok(await context.settings.exportConfig()),

    'settings.reset': async () => {
      await context.settings.reset();
      await context.queue.clear();
      await context.ledger.clear();
      return ok({ reset: true });
    },

    'vault.setup': async (request) => {
      const passphrase = validatePassphrase(request.payload);
      const payload = (request.payload ?? {}) as { secrets?: { githubPat?: string; providerKey?: string } };
      const patch = {
        ...(payload.secrets?.githubPat ? { githubPat: payload.secrets.githubPat } : {}),
        ...(payload.secrets?.providerKey ? { providerKey: payload.secrets.providerKey } : {}),
      };
      await context.settings.setupVault(passphrase, patch);
      return ok(await context.settings.vaultStatus());
    },

    'vault.unlock': async (request) => {
      const passphrase = validatePassphrase(request.payload);
      const secrets = await context.settings.unlock(passphrase);
      // Report presence only; the values stay in the worker.
      return ok({ githubPat: secrets.githubPat ? '[set]' : '', providerKey: secrets.providerKey ? '[set]' : '' });
    },

    'vault.lock': async () => {
      await context.settings.lock();
      return ok(await context.settings.vaultStatus());
    },

    'vault.status': async () => ok(vaultStatusData(await context.settings.vaultStatus())),

    'auth.probe': async () => {
      const authContext = await buildAuthContext(context);
      // Both modes are probed, so the picker can enable SSH before the user commits to it.
      return ok(await probeAvailability(authContext, context.native ?? null));
    },

    'native.status': async () => {
      const native = context.native ?? null;
      if (!native) {
        return ok({ availability: 'missing', protocolVersion: null, gitVersion: null, platform: null });
      }
      const availability = await native.availability(true);
      const ping = availability === 'ok' ? await native.ping() : null;
      return ok({
        availability,
        protocolVersion: ping?.protocolVersion ?? null,
        gitVersion: ping?.gitVersion ?? null,
        platform: ping?.platform ?? null,
      });
    },

    'sync.status': async () => {
      const settings = await context.settings.load();
      const [state, dirty] = await Promise.all([syncCache.state(), syncCache.dirty()]);
      return ok({
        state,
        pending: dirty.length,
        policy: settings.syncPolicy,
        /**
         * The decision surface needs to name the file it is deciding about, and to say whether a content
         * comparison is even possible — a locked vault can still choose "keep both", so the choice is offered
         * rather than hidden. Nothing here reads a note body: the paths come from the sync state.
         */
        conflicts: state.conflicts.map((path) => ({
          path,
          conflictPath: state.conflictPaths[path] ?? '',
          readable: context.session.isUnlocked(),
        })),
      });
    },

    'conflict.resolve': async (request) => {
      const { path, conflictPath, action } = validateConflictResolve(request.payload);
      const state = await syncCache.state();
      // Only a conflict we actually recorded may be resolved: this is a decision surface, not a file mover, so it
      // must not be usable to overwrite arbitrary paths.
      if (!state.conflicts.includes(path)) {
        throw new NotFoundError('conflict: that path is not recorded as conflicted');
      }
      const recorded = state.conflictPaths[path];
      if (recorded !== undefined && recorded !== conflictPath) {
        throw new ConflictError(`conflict: the recorded sibling is ${recorded}`);
      }

      const store = await resolveStore(context);
      const settings = await context.settings.load();
      const prefix = settings.github.pathPrefix || null;
      const index = await store.readIndex();
      const shards = createRemoteShardStore(store, prefix);
      const searchIndex = new SearchIndex({ store: shards, prefix });

      const plan = await planConflictResolution(
        { path, conflictPath, action },
        {
          codec: store.contentCodec,
          index,
          read: (candidate) => store.readFile(candidate),
          shards: { change: (survivor, loser) => searchIndex.changedShards(survivor, loser) },
          prefix,
          ...(context.now ? { now: context.now } : {}),
        },
      );
      // 'keep both' reads and writes nothing, so it is recorded without a commit — which is also what makes it
      // the one action a locked vault can take.
      if (plan.commit) await store.commitFiles(plan.files, plan.message);

      const remaining: Record<string, string> = {};
      for (const [main, sibling] of Object.entries(state.conflictPaths)) {
        if (main !== path) remaining[main] = sibling;
      }
      await syncCache.updateState({
        conflicts: state.conflicts.filter((entry) => entry !== path),
        conflictPaths: remaining,
      });

      return ok({
        action: plan.action,
        path: plan.path,
        committed: plan.commit,
        ...(plan.archivedPath !== undefined ? { archivedPath: plan.archivedPath } : {}),
      });
    },

    'sync.now': async (request) => {
      const { reason } = validateSyncRequest(request.payload);
      const report = await performSync(context, reason);
      /*
       * The prefs ride along so the UI does not need a second round trip to redraw the status row - and the
       * sync half is passed EXPLICITLY, read back from the cache the sync just wrote to. `publicPrefs()` is a
       * stored projection, so leaving it to itself returned the previous one: the row said "never synced"
       * immediately after a successful sync, which is how a green "finished" line ended up next to
       * "last sync failed" and "never".
       */
      const fresh = syncStateForPrefs(createSyncCache(context));
      return ok({ report, prefs: await context.settings.publicPrefs({ sync: await fresh }) });
    },

    'sync.policy': async (request) => {
      const payload = validateSyncPolicy(request.payload);
      const patched = await context.settings.patch({ syncPolicy: payload });
      // Keep the alarm in step with the stored policy: interval 0 must actually stop the timer.
      await context.triggers?.schedule(patched.syncPolicy);
      return ok(patched.syncPolicy);
    },

    'search.query': async (request) => {
      const { text, limit, filters } = validateSearchQuery(request.payload);
      const { remote, prefix } = await resolveSyncRemote(context);
      const { index } = buildSearchIndex(remote, prefix, syncCache, context);
      const query = withFilters(text, filters);
      const hits = await index.query(query, { limit });
      return ok({
        hits,
        needsRebuild: (hits as { needsRebuild?: boolean }).needsRebuild === true,
        indexMissing: (hits as { indexMissing?: boolean }).indexMissing === true,
      });
    },

    'search.rebuild': async () => {
      const { remote, prefix } = await resolveSyncRemote(context);
      const { index, drain } = buildSearchIndex(remote, prefix, syncCache, context);
      /*
       * The rebuild is derived FROM THE RECORDS, and the records live in the repository. Reading them only
       * from the local cache meant a cold cache produced a rebuild that wrote nothing at all - while the UI
       * reported success - which is how a repository can have no search/ directory at all and still be told
       * its index was rebuilt. So a cold cache is filled from the repository first.
       */
      /*
       * Always refresh from the repository first. The rebuild is derived FROM THE RECORDS, and reading them
       * only from the local cache meant a cold cache wrote nothing, while a merely stale one wrote shards for
       * part of the corpus - and the UI reported success either way, so the repository could end up with no
       * search/ directory at all while it was told the index had been rebuilt. A rebuild is deliberate and
       * rare, so paying for one sync here is the right trade; if the sync fails, the failure IS the answer
       * (the user sees the real reason instead of a green line covering an empty result).
       */
      let records = (await syncCache.all()).filter((entry) => entry.record.kind !== 'review');
      if (records.length === 0) {
        // Only when there is nothing to index: a cache that is merely stale still rebuilds what it has, and
        // forcing a sync here made the rebuild itself fail whenever the sync could not run (found by the
        // end-to-end test, which is the reason it exists).
        await performSync(context, 'manual');
        records = (await syncCache.all()).filter((entry) => entry.record.kind !== 'review');
      }
      // How many of those records carry text a term can be cut from. A rebuild can honestly write zero
      // shards while holding records (empty ones), and a bare 1 / 0 is a plausible-looking dead end.
      const indexable = records.filter((entry) =>
        Object.values(documentOf(entry.record, entry.path).fields).some((field) => field.length > 0),
      ).length;
      const files = [...(await index.rebuild(records.map((entry) => entry.record))), ...drain()];
      const pending = dedupeFiles(files);
      if (pending.length > 0) {
      /*
       * Shards written under the old key scheme are DELETED, not blanked: the query rejects the key, so a blank
       * shard at the same path kept the index permanently "stale" and made the rebuild button useless. The
       * commit API expresses a deletion as a tree entry with `sha: null`, which this path already supports.
       */
      if (pending.length > 0) {
        await remote.commitFiles(pending, 'search: rebuild index');
      }
      }
      return ok({ records: records.length, shards: pending.length, indexable });
    },

    'review.due': async () => {
      const store = await resolveStore(context);
      const prefix = (await context.settings.load()).github.pathPrefix || null;
      // The review file is cleartext by design, so this read needs no unlock: a locked vault can still ask what
      // is due. The index supplies the label and the path; the review file supplies the schedule, and nothing
      // else is read.
      const [raw, index] = await Promise.all([
        store.readFile(reviewStatePath(prefix)),
        store.readIndex(),
      ]);
      const due = dueForReview(
        parseReviewFile(raw).map((entry) => ({
          id: entry.id,
          path: index.items[entry.id]?.path ?? '',
          // The index deliberately carries no title (content lives in the record), so the path is the label.
          title: index.items[entry.id]?.path ?? '',
          next_review_at: entry.next_review_at,
        })),
        context.now?.() ?? Date.now(),
      ).slice(0, 20);
      return ok({ due });
    },

    'cards.list': async (request) => {
      const { limit } = validateCardList(request.payload);
      const store = await resolveStore(context);
      const index = await store.readIndex();
      // The AI's proposals are exactly the cards still parked in the pending segment, newest first.
      const pending = Object.values(index.items)
        .filter((item) => item.kind === 'card' && /(?:^|\/)cards\/pending\//u.test(item.path))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
        .slice(0, limit);

      const cards: Array<Record<string, unknown>> = [];
      for (const item of pending) {
        // A body that cannot be read is reported as unreadable rather than dropping the whole list: the user
        // should still see that a proposal is waiting (and a locked vault surfaces as 'locked' one level up).
        try {
          const record = await store.readRecord(item.path);
          if (record.kind !== 'card') continue;
          cards.push({
            id: record.id,
            path: item.path,
            title: record.title,
            summary: record.summary,
            points: record.points,
            tags: record.tags,
            evidence_paths: record.evidence_paths,
            created_at: item.created_at,
          });
        } catch {
          cards.push({ id: item.id, path: item.path, unreadable: true, created_at: item.created_at });
        }
      }
      return ok({ cards });
    },

    /*
     * Deleting a note FOR GOOD. Separate from the archive action on purpose: this one cannot be undone,
     * so it is asked for explicitly (the popup arms the button first) and never happens as a side effect.
     */
    'source.delete': async (request) => {
      const { id, path } = validateSourceDelete(request.payload);
      const store = await resolveStore(context);
      const settings = await context.settings.load();
      const index = await store.readIndex();
      const item = index.items[id];
      if (!item) throw new NotFoundError('note: that note is not in the index');
      if (item.path !== path) {
        throw new ConflictError('note: the index records ' + item.path + ', the request said ' + path);
      }
      const record = await store.readRecord(path);
      if (record.kind !== 'source') throw new MessageError('note: the target record is not a note');

      const prefix = settings.github.pathPrefix || null;
      const plan = await planSourceDelete(
        { record, path, index },
        { shards: cardShards(store, prefix), prefix },
      );
      await store.commitFiles(plan.files, plan.message, plan.deleted);
      try {
        await createSyncCache(context).forget(path);
      } catch {
        // The cache is disposable: a delete that landed must not be reported as failed.
      }
      return ok({ deleted: path });
    },

    'source.archive': async (request) => {
      const { id, path } = validateSourceArchive(request.payload);
      const store = await resolveStore(context);
      const settings = await context.settings.load();
      const index = await store.readIndex();
      const item = index.items[id];
      if (!item) throw new NotFoundError('note: that note is not in the index');
      // Same rule as the card decision: a disagreement between the index and the request is surfaced,
      // never resolved by guessing.
      if (item.path !== path) {
        throw new ConflictError('note: the index records ' + item.path + ', the request said ' + path);
      }
      const record = await store.readRecord(path);
      if (record.kind !== 'source') throw new MessageError('note: the target record is not a note');

      const prefix = settings.github.pathPrefix || null;
      const encoded = await store.contentCodec.encodeRecord(record, prefix);
      const plan = await planSourceArchive(
        { record, path, content: encoded.content, index },
        { shards: cardShards(store, prefix), prefix, ...(context.now ? { now: context.now } : {}) },
      );
      await store.commitFiles(plan.files, plan.message);
      // After the commit, so a failed write cannot evict a cache entry for a note that is still there.
      try {
        await createSyncCache(context).forget(path);
      } catch {
        // The cache is disposable and rebuildable; an archive that landed must not be reported as failed.
      }
      return ok({ archivedPath: plan.archivedPath, previousPath: path });
    },

    'card.decide': async (request) => {
      const { id, path, action, patch } = validateCardDecide(request.payload);
      const store = await resolveStore(context);
      const settings = await context.settings.load();
      const index = await store.readIndex();
      const item = index.items[id];
      if (!item) throw new NotFoundError('card: that card is not in the index');
      // The file is what is being decided about, so a disagreement between index and request is surfaced
      // rather than resolved by guessing — the two can drift if the card was edited outside the product.
      if (item.path !== path) {
        throw new ConflictError(`card: the index records ${item.path}, the request said ${path}`);
      }
      const record = await store.readRecord(path);
      if (record.kind !== 'card') throw new MessageError('card: the target record is not a card');

      const prefix = settings.github.pathPrefix || null;
      const plan = await planCardDecision(
        { card: record, path, action, ...(patch !== undefined ? { patch } : {}) },
        {
          codec: store.contentCodec,
          index,
          shards: cardShards(store, prefix),
          prefix,
          ...(context.now ? { now: context.now } : {}),
        },
      );
      // An accepted card becomes reviewable in the **same** commit: a reader can never see a confirmed card whose
      // review entry is missing, and a failed write cannot leave the two out of step.
      if (plan.action === 'accept' && plan.card !== null) {
        const existing = await store.readFile(reviewStatePath(prefix));
        plan.files.push({
          path: reviewStatePath(prefix),
          content: reviewStateWithEntry(existing, plan.card.id, context.now?.() ?? Date.now()),
        });
      }
      await store.commitFiles(plan.files, plan.message);
      return ok({
        action: plan.action,
        path: plan.path,
        previousPath: plan.previousPath,
        ...(plan.archivedPath !== undefined ? { archivedPath: plan.archivedPath } : {}),
        ...(plan.card !== null ? { card: plan.card } : {}),
      });
    },

    'ai.ledger': async (request) => {
      const limit = validateLimit(request.payload, 20, LIMITS.ledgerLimit);
      // `list` already returns identifiers, provider and outcome only — never content.
      return ok(await context.ledger.list(limit));
    },

    'ai.ledger.clear': async () => {
      await context.ledger.clear();
      return ok({ cleared: true });
    },
  };

  // The router only awaits; wrapping keeps the handler signature uniform.
  const wrapped: HandlerMap = {};
  for (const [type, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    wrapped[type as RequestType] = async (request) => handler(request);
  }
  return wrapped;
}

async function runDistill(
  context: BackgroundContext,
  payload: { sourceId: string; sourcePath: string; allowThisSession?: boolean },
) {
  const settings = await context.settings.load();
  const secrets = await context.settings.getSecrets();
  const store = await resolveStore(context);
  const service = new DistillService({
    store,
    ledger: context.ledger,
    settings,
    secrets,
    fetchImpl: context.fetchImpl,
    shards: shardProvider(store, settings.github.pathPrefix || null),
    ...(context.now ? { now: context.now } : {}),
  });
  return service.distill(payload);
}

/** Scrub anything a handler error might carry before it is logged. */
export async function scrubHandlerError(
  error: unknown,
  context: Pick<BackgroundContext, 'settings'>,
): Promise<string> {
  const secrets = await context.settings.peekSecrets();
  return scrub(
    scrubError(error),
    secrets ? [secrets.githubPat, secrets.providerKey] : [],
  );
}
