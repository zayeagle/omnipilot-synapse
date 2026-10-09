/**
 * Status surface shared by the popup and the options page.
 *
 * Pure formatting and classification: it decides whether a repository may be written to, whether a
 * capture is currently possible, and how to render all of that without ever printing a credential.
 */

import { t, type Lang } from './i18n';
import type { ErrorCode } from './messages';
import type { CompanionState, PublicAuthMode, PublicPrefs, PublicSyncOutcome } from './public-prefs';
import type { RepoVisibility, StoreProbe } from './store/types';

/** Vault state as the UI sees it — never the key, never the passphrase. */
export interface VaultStatusData {
  /** How the vault session survives a restart; the Security page reads this (R8). */
  unlockPolicy: 'strict' | 'remember';
  configured: boolean;
  unlocked: boolean;
  expiresAt: number | null;
  remainingMs: number;
}

/** Payload of the `status.get` request (see `lib/background/handlers.ts`). */
export interface StatusData {
  prefs: PublicPrefs;
  probe: StoreProbe | null;
  vault: VaultStatusData;
}

export type CaptureReadiness =
  | 'ready'
  | 'disabled'
  | 'not-configured'
  | 'vault-locked'
  | 'companion-missing'
  | 'public-repo-blocked';

export interface StatusInput {
  prefs: PublicPrefs;
  probe: StoreProbe | null;
}

/**
 * Whether repository READS can succeed right now.
 *
 * Capture has more gates (a probe, the public-repository acknowledgement). Reading needs only a
 * credential — and in token mode that credential lives in the vault, so a locked vault makes the Inbox,
 * the proposals and the review queue equally unreadable. The popup says that once instead of three times.
 */
export function canReadRepository(prefs: PublicPrefs): boolean {
  if (prefs.repoFullName.length === 0) return false;
  const tokenMode = prefs.authMode !== 'ssh';
  if ((tokenMode || prefs.securityMode === 'vault') && prefs.vaultLocked) return false;
  if (tokenMode && !prefs.hasPat) return false;
  if (!tokenMode && prefs.companion !== 'ok') return false;
  return true;
}

/**
 * Whether a capture can proceed right now, most-blocking reason first.
 * Mirrors the guards in the capture service so the UI and the writer can never disagree.
 */
export function captureReadiness(input: StatusInput): CaptureReadiness {
  const { prefs, probe } = input;
  if (!prefs.enabled) return 'disabled';
  if (prefs.repoFullName.length === 0) return 'not-configured';
  const tokenMode = prefs.authMode !== 'ssh';
  // The token lives IN the vault, so a locked vault makes hasPat read false. Asking someone who has
  // already configured a repository to configure storage is the plausible lie this surface exists to
  // remove: unlocking is the thing they can actually do. The content tier is a SECOND reason the vault
  // is needed, not the only one — the old check looked at the tier alone, which is exactly how a
  // transparent repository ended up telling its owner that nothing was configured.
  if ((tokenMode || prefs.securityMode === 'vault') && prefs.vaultLocked) return 'vault-locked';
  if (tokenMode && !prefs.hasPat) return 'not-configured';
  // SSH takes its credential from the companion, so a missing PAT must not block it (R7).
  if (!tokenMode && prefs.companion !== 'ok') return 'companion-missing';
  if (probe && probe.visibility === 'public' && !probe.canWrite) return 'public-repo-blocked';
  return 'ready';
}

export function readinessLabel(readiness: CaptureReadiness, lang?: Lang): string {
  switch (readiness) {
    case 'ready':
      return t('status.aiOn', null, lang);
    case 'disabled':
      return t('popup.masterSwitch', null, lang);
    case 'not-configured':
      return t('popup.needSetup', null, lang);
    case 'vault-locked':
      return t('popup.needUnlock', null, lang);
    case 'companion-missing':
      return t('popup.needCompanion', null, lang);
    case 'public-repo-blocked':
      return t('error.publicRepo', null, lang);
    default:
      return t('error.unknown', null, lang);
  }
}

export function visibilityLabel(visibility: RepoVisibility, lang?: Lang): string {
  switch (visibility) {
    case 'private':
      return t('options.store.visibility.private', null, lang);
    case 'public':
      return t('options.store.visibility.public', null, lang);
    case 'internal':
      return t('options.store.visibility.internal', null, lang);
    default:
      return t('options.store.visibility.unknown', null, lang);
  }
}

export interface StatusLine {
  store: string;
  repo: string;
  mode: string;
  vault: string;
  ai: string;
  /**
   * Authorization + branch, e.g. `ssh · main`. Every part is a fixed translated word or the branch
   * name the user themselves typed — there is no field here a credential could be rendered from.
   */
  auth: string;
  /** `last sync · pending · conflicts`; counts are integers, never content. */
  sync: string;
}

/**
 * Human-readable status rows. Every value here is either a fixed translated string or a repository
 * label — there is no code path that can place a token in one of these fields.
 */
export function statusLine(input: StatusInput, lang?: Lang): StatusLine {
  const { prefs } = input;
  return {
    store: prefs.storeKind,
    repo: prefs.repoFullName || t('status.unconfigured', null, lang),
    mode:
      prefs.securityMode === 'vault'
        ? t('options.security.mode.vault', null, lang)
        : t('options.security.mode.transparent', null, lang),
    vault: prefs.vaultLocked ? t('status.locked', null, lang) : t('status.unlocked', null, lang),
    ai: prefs.aiAuthorized ? t('status.aiOn', null, lang) : t('status.aiOff', null, lang),
    auth: authLine(prefs, lang),
    sync: syncLine(prefs, lang),
  };
}

/** `token` / `ssh`, plus the branch — never `sshHost`'s user, key or path. */
export function authModeLabel(mode: PublicAuthMode, lang?: Lang): string {
  return mode === 'ssh'
    ? t('status.auth.ssh', null, lang)
    : t('status.auth.token', null, lang);
}

export function authLine(prefs: PublicPrefs, lang?: Lang): string {
  const branch = prefs.branch.trim();
  const mode = authModeLabel(prefs.authMode, lang);
  return branch.length > 0 ? `${mode} · ${branch}` : mode;
}

/** The fixed sentence for each sync outcome (also used by the options section). */
export function syncOutcomeLabel(outcome: PublicSyncOutcome, lang?: Lang): string {
  return t(`options.sync.outcome.${outcome}`, null, lang);
}

export function companionLabel(state: CompanionState, lang?: Lang): string {
  switch (state) {
    case 'ok':
      return t('options.auth.companion.ok', null, lang);
    case 'mismatch':
      return t('options.auth.companion.mismatch', null, lang);
    default:
      return t('options.auth.companion.missing', null, lang);
  }
}

export interface SyncLineParts {
  outcome: string;
  lastSyncAt: string;
  pending: number;
  conflicts: number;
  /** Translated, actionable guidance for the last failure — never the worker's own sentence. */
  failure: ErrorGuidance | null;
}

/**
 * The sync half of the status surface, as data — the popup renders one line, the options page a
 * table. Both come from this projection so the two surfaces can never disagree.
 */
export function syncLineParts(prefs: PublicPrefs, lang?: Lang): SyncLineParts {
  const sync = prefs.sync;
  // `lastError` is deliberately dropped: the worker supplies it, and a handler's own sentence is
  // exactly the kind of outside string the UI never renders. A failed outcome gets a fixed one.
  return {
    outcome: syncOutcomeLabel(sync.lastOutcome, lang),
    lastSyncAt: sync.lastSyncAt ?? '',
    pending: sync.pending,
    conflicts: sync.conflicts,
    // The code goes through the guidance table, which has a safe fallback for anything it does not know —
    // a junk value can therefore never render as nothing.
    failure: sync.lastFailureCode ? errorGuidance(sync.lastFailureCode as ErrorCode) : null,
  };
}

export function syncLine(prefs: PublicPrefs, lang?: Lang): string {
  const parts = syncLineParts(prefs, lang);
  const out = [parts.lastSyncAt.length > 0 ? parts.lastSyncAt : t('options.sync.never', null, lang)];
  if (parts.pending > 0) out.push(t('status.pending', { count: parts.pending }, lang));
  if (parts.conflicts > 0) out.push(t('status.conflicts', { count: parts.conflicts }, lang));
  // Why the last run failed, in the user's own language and from our own table — the one thing the status row
  // never said before (F5/W6). The action is wired next to it by the surface that has somewhere to send them.
  if (parts.failure !== null) out.push(t(parts.failure.titleKey, null, lang));
  return out.join(' · ');
}

/**
 * Turning a failure *code* into "what happened and what to do about it" (F5 / SC-R3-03).
 *
 * The worker's own error sentence is deliberately never rendered — it is an outside string, and a handler
 * message is exactly the kind of thing that could carry a path or a token. A code cannot: it is a member of a
 * closed union, so this table is the only place a failure becomes language, and it is fully translated.
 *
 * `target` is what makes the guidance actionable rather than decorative: the UI can wire "retry" to another
 * sync, "unlock" to the vault prompt, "storage"/"companion" to the right settings section — without inventing
 * behaviour of its own.
 */
export type FailureTarget = 'storage' | 'sync' | 'unlock' | 'retry' | 'companion' | 'none';

export interface ErrorGuidance {
  /** i18n key for the human-readable cause. */
  titleKey: string;
  /** i18n key for the single action that fixes it. */
  actionKey: string;
  target: FailureTarget;
}

/** Exhaustive by construction: every member of the `ErrorCode` union has a row, checked by a test. */
export const ERROR_GUIDANCE: Record<ErrorCode, ErrorGuidance> = {
  auth: { titleKey: 'error.auth', actionKey: 'guidance.auth.action', target: 'storage' },
  scope: { titleKey: 'error.scope', actionKey: 'guidance.scope.action', target: 'storage' },
  notFound: { titleKey: 'error.notFound', actionKey: 'guidance.notFound.action', target: 'sync' },
  conflict: { titleKey: 'error.conflict', actionKey: 'guidance.conflict.action', target: 'sync' },
  rateLimited: { titleKey: 'error.rateLimited', actionKey: 'guidance.rateLimited.action', target: 'retry' },
  timeout: { titleKey: 'error.timeout', actionKey: 'guidance.timeout.action', target: 'retry' },
  network: { titleKey: 'error.network', actionKey: 'guidance.network.action', target: 'retry' },
  locked: { titleKey: 'error.locked', actionKey: 'guidance.locked.action', target: 'unlock' },
  needVault: { titleKey: 'error.needVault', actionKey: 'guidance.needVault.action', target: 'unlock' },
  wrongPassphrase: { titleKey: 'error.wrongPassphrase', actionKey: 'guidance.wrongPassphrase.action', target: 'unlock' },
  passphraseTooShort: { titleKey: 'error.passphraseTooShort', actionKey: 'guidance.passphraseTooShort.action', target: 'unlock' },
  badJson: { titleKey: 'error.badJson', actionKey: 'guidance.badJson.action', target: 'retry' },
  emptyResponse: { titleKey: 'error.emptyResponse', actionKey: 'guidance.emptyResponse.action', target: 'retry' },
  parse: { titleKey: 'error.parse', actionKey: 'guidance.parse.action', target: 'retry' },
  publicRepo: { titleKey: 'error.publicRepo', actionKey: 'guidance.publicRepo.action', target: 'storage' },
  notConfigured: { titleKey: 'error.notConfigured', actionKey: 'guidance.notConfigured.action', target: 'storage' },
  validation: { titleKey: 'error.validation', actionKey: 'guidance.validation.action', target: 'sync' },
  nativeUnavailable: { titleKey: 'error.nativeUnavailable', actionKey: 'guidance.nativeUnavailable.action', target: 'companion' },
  protocolMismatch: { titleKey: 'error.protocolMismatch', actionKey: 'guidance.protocolMismatch.action', target: 'companion' },
  gitFailed: { titleKey: 'error.gitFailed', actionKey: 'guidance.gitFailed.action', target: 'sync' },
  syncConflict: { titleKey: 'error.syncConflict', actionKey: 'guidance.syncConflict.action', target: 'sync' },
  indexUnavailable: { titleKey: 'error.indexUnavailable', actionKey: 'guidance.indexUnavailable.action', target: 'sync' },
  // Not a storage problem to fix by editing a field: the answer is 'start an empty repository'.
  tierLocked: { titleKey: 'error.tierLocked', actionKey: 'guidance.tierLocked.action', target: 'storage' },
  needToken: { titleKey: 'error.needToken', actionKey: 'guidance.needToken.action', target: 'storage' },
  commitTooLarge: { titleKey: 'error.commitTooLarge', actionKey: 'guidance.commitTooLarge.action', target: 'retry' },
  deleteUnsupported: { titleKey: 'error.deleteUnsupported', actionKey: 'guidance.deleteUnsupported.action', target: 'storage' },
  unknown: { titleKey: 'error.unknown', actionKey: 'guidance.unknown.action', target: 'retry' },
};

/** Guidance for a code, with a safe fallback so an unknown code can never render as nothing at all. */
export function errorGuidance(code: ErrorCode): ErrorGuidance {
  return ERROR_GUIDANCE[code] ?? { titleKey: 'error.unknown', actionKey: 'guidance.unknown.action', target: 'retry' };
}

/** True when a probe result demands the red public-repository warning in the UI. */
export function isPublicRepoWarning(probe: StoreProbe | null): boolean {
  return probe?.visibility === 'public';
}

/**
 * Whether the storage section may be saved.
 *
 * A TYPED token is enough. `settings.github` probes with the candidate before it persists anything, so a
 * bad token fails visibly in the same request; requiring a successful probe first was a deadlock — the
 * probe needs a stored token, and storing one is exactly what the button was refusing to do. The public
 * repository acknowledgement still gates unconditionally.
 */
export function canSaveStorageSection(
  probe: StoreProbe | null,
  acknowledged: boolean,
  /** A token is typed into the form right now. */
  typedToken = false,
): boolean {
  if (probe && probe.visibility === 'public') return acknowledged;
  if (typedToken) return true;
  if (!probe) return false;
  return probe.canPush;
}
