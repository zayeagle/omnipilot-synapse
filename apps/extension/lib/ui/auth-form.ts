/**
 * The 存储 authorization form model — pure, so both the options page and the unit tests can drive it.
 *
 * Two modes exist and they are genuinely different: `token` talks to the GitHub REST API with a PAT
 * from the vault, `ssh` drives the companion process against the user's **local clone**. Everything
 * here is a projection to or from data the worker already understands (`AuthMode`, the SSH settings
 * and `GithubSettingsPayload`); nothing in this file reads a credential or touches a browser API.
 *
 * The availability rule is the reason this is a separate module: SSH must be *visibly* disabled when
 * the companion is missing (SC-F8-02 / Err1), so the decision is data (`AuthModeAvailability`) the UI
 * renders rather than an exception the user reaches by saving a form that was never going to work.
 */

import { t, type Lang } from '../i18n';
import {
  LIMITS,
  type AuthMode,
  type GithubSettingsPayload,
  type SyncPolicyPayload,
} from '../messages';
import type { CompanionState } from '../public-prefs';

/* --------------------------------- the model ------------------------------- */

/** SSH authorization settings as the form holds them. `keyRef` is an identifier, never key material. */
export interface SshForm {
  host: string;
  user: string;
  keyRef: string;
  repoRoot: string;
}

export interface AuthForm {
  mode: AuthMode;
  /** Branch every remote operation targets. Stored with the GitHub section (single source of truth). */
  branch: string;
  ssh: SshForm;
  syncPolicy: SyncPolicyPayload;
}

/** One selectable authorization mode, with the reason it is unavailable (if it is). */
export interface AuthModeOption {
  value: AuthMode;
  label: string;
  enabled: boolean;
  /** Inline explanation shown when `enabled` is false; empty otherwise. */
  reasonKey: string;
}

/** Everything the UI can know about the companion without trying to use it. */
export interface AuthModeAvailability {
  companion: CompanionState;
  /** A stored PAT exists — token mode is worth offering only when it does. */
  hasPat: boolean;
}

/* ------------------------------ form ↔ payload ----------------------------- */

export function emptySshForm(): SshForm {
  return { host: 'github.com', user: 'git', keyRef: 'default', repoRoot: '' };
}

export function defaultAuthForm(): AuthForm {
  return {
    mode: 'token',
    branch: 'main',
    ssh: emptySshForm(),
    syncPolicy: { intervalMinutes: 30, onStartup: true, onCapture: true, pullOnly: false },
  };
}

export function authFormOf(
  mode: AuthMode,
  branch: string,
  ssh: Partial<SshForm> = {},
  syncPolicy: SyncPolicyPayload = {},
): AuthForm {
  return {
    mode: mode === 'ssh' ? 'ssh' : 'token',
    branch: branch.trim() || 'main',
    ssh: {
      host: typeof ssh.host === 'string' && ssh.host.trim().length > 0 ? ssh.host.trim() : 'github.com',
      user: typeof ssh.user === 'string' && ssh.user.trim().length > 0 ? ssh.user.trim() : 'git',
      keyRef:
        typeof ssh.keyRef === 'string' && ssh.keyRef.trim().length > 0 ? ssh.keyRef.trim() : 'default',
      repoRoot: typeof ssh.repoRoot === 'string' ? ssh.repoRoot.trim() : '',
    },
    syncPolicy: { ...syncPolicy },
  };
}

/** The SSH block of the form, trimmed and with the worker's own defaults filled in. */
export function sshFormOf(form: AuthForm): SshForm {
  return authFormOf(form.mode, form.branch, form.ssh, form.syncPolicy).ssh;
}

/**
 * Form → the two payloads a save produces.
 *
 * The branch rides on `github` (the worker already validates it there and the token transport needs
 * it); the mode and the SSH block go to `settings.security`/the settings patch the worker applies.
 * A blank SSH field is OMITTED rather than sent as `''`, so "leave it alone" stays distinct from
 * "clear it" — the same rule the credential fields follow.
 */
export function formToAuthPayload(form: AuthForm): {
  mode: AuthMode;
  github: Pick<GithubSettingsPayload, 'branch'>;
  ssh: Partial<SshForm>;
} {
  const ssh = sshFormOf(form);
  const out: Partial<SshForm> = {};
  for (const key of ['host', 'user', 'keyRef', 'repoRoot'] as const) {
    const value = ssh[key];
    if (value.length > 0) out[key] = value;
  }
  return { mode: form.mode, github: { branch: form.branch.trim() || 'main' }, ssh: out };
}

/** Inverse of {@link formToAuthPayload}, for tests and for re-hydrating a form from storage. */
export function authPayloadToForm(
  source: unknown,
  fallback: AuthForm = defaultAuthForm(),
): AuthForm {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return fallback;
  const raw = source as Record<string, unknown>;
  const nested = raw['settings'];
  const scope =
    typeof nested === 'object' && nested !== null && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : raw;
  const github =
    typeof scope['github'] === 'object' && scope['github'] !== null
      ? (scope['github'] as Record<string, unknown>)
      : {};
  const ssh =
    typeof scope['ssh'] === 'object' && scope['ssh'] !== null
      ? (scope['ssh'] as Record<string, unknown>)
      : {};
  const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
  return authFormOf(
    scope['authMode'] === 'ssh' ? 'ssh' : scope['mode'] === 'ssh' ? 'ssh' : 'token',
    asString(github['branch']) || fallback.branch,
    {
      host: asString(ssh['host']) || fallback.ssh.host,
      user: asString(ssh['user']) || fallback.ssh.user,
      keyRef: asString(ssh['keyRef']) || fallback.ssh.keyRef,
      repoRoot: asString(ssh['repoRoot']) || fallback.ssh.repoRoot,
    },
    fallback.syncPolicy,
  );
}

/* ------------------------------- availability ------------------------------ */

/**
 * `token` is always offerable (it is the fallback that keeps working with no companion); `ssh` is
 * only enabled when the companion reported `ok`. A companion that is present but out of date is
 * still unusable, which is why `mismatch` disables the mode with its own sentence.
 */
export function authModeOptions(availability: AuthModeAvailability, lang?: Lang): AuthModeOption[] {
  const sshReady = availability.companion === 'ok';
  return [
    { value: 'token', label: t('options.auth.mode.token', null, lang), enabled: true, reasonKey: '' },
    {
      value: 'ssh',
      label: t('options.auth.mode.ssh', null, lang),
      enabled: sshReady,
      reasonKey: sshReady
        ? ''
        : availability.companion === 'mismatch'
          ? 'options.auth.ssh.disabled.mismatch'
          : 'options.auth.ssh.disabled.missing',
    },
  ];
}

/** The three companion states as fixed, translated sentences (TC-F5-U02). */
export function companionStatusText(state: CompanionState, lang?: Lang): string {
  switch (state) {
    case 'ok':
      return t('options.auth.companion.ok', null, lang);
    case 'mismatch':
      return t('options.auth.companion.mismatch', null, lang);
    default:
      return t('options.auth.companion.missing', null, lang);
  }
}

/**
 * Whether the SSH option itself must be disabled in the picker.
 *
 * A stored `ssh` choice with no usable companion is shown as selected-but-disabled rather than
 * silently switched back to token mode: the user's intent is preserved and the hint says why.
 */
export function authModeDisabled(mode: AuthMode, availability: AuthModeAvailability): boolean {
  if (mode !== 'ssh') return false;
  return !authModeOptions(availability).some((option) => option.value === 'ssh' && option.enabled);
}

/* --------------------------------- validation ------------------------------ */

export interface SshFormErrors {
  host: string;
  user: string;
  keyRef: string;
  repoRoot: string;
}

export function emptySshFormErrors(): SshFormErrors {
  return { host: '', user: '', keyRef: '', repoRoot: '' };
}

export function hasSshFormErrors(errors: SshFormErrors): boolean {
  return (
    errors.host.length > 0 ||
    errors.user.length > 0 ||
    errors.keyRef.length > 0 ||
    errors.repoRoot.length > 0
  );
}

/**
 * Field-level validation for the SSH block.
 *
 * The local-clone path is REQUIRED: the companion confines every path it touches to `repoRoot`, so
 * an empty value is not "unset yet", it is "every git op will be refused". Catching it here means the
 * user reads a field message instead of a `notConfigured` error from the worker.
 */
export function validateSshForm(ssh: SshForm, lang?: Lang): SshFormErrors {
  const errors = emptySshFormErrors();
  const host = ssh.host.trim();
  const user = ssh.user.trim();
  const keyRef = ssh.keyRef.trim();
  const repoRoot = ssh.repoRoot.trim();
  if (host.length === 0) errors.host = t('options.auth.ssh.hostRequired', null, lang);
  else if (/\s/u.test(host) || host.length > 200) errors.host = t('options.auth.ssh.hostInvalid', null, lang);
  if (user.length === 0) errors.user = t('options.auth.ssh.userRequired', null, lang);
  else if (/\s/u.test(user) || user.length > 100) errors.user = t('options.auth.ssh.userInvalid', null, lang);
  if (keyRef.length === 0) errors.keyRef = t('options.auth.ssh.keyRequired', null, lang);
  else if (keyRef.length > 120) errors.keyRef = t('options.auth.ssh.keyInvalid', null, lang);
  if (repoRoot.length === 0) errors.repoRoot = t('options.auth.ssh.repoRootRequired', null, lang);
  else if (repoRoot.length > LIMITS.pathPrefixChars) {
    errors.repoRoot = t('options.auth.ssh.repoRootInvalid', null, lang);
  }
  return errors;
}

/** The SSH block may only be saved once every field validates. */
export function sshSaveDisabled(ssh: SshForm): boolean {
  return hasSshFormErrors(validateSshForm(ssh));
}

/**
 * Branch names as git actually accepts them: no whitespace, no `..`, no leading `-`, and none of
 * the ref-format metacharacters. The worker's validator only rejects whitespace, so the stricter
 * check is what stops a `git.probe` round trip the remote would reject anyway.
 */
export function validateBranch(branch: string, lang?: Lang): string {
  const value = branch.trim();
  if (value.length === 0) return t('options.branch.required', null, lang);
  if (value.length > 200) return t('options.branch.invalid', null, lang);
  if (/[\s~^:?*\[\\]/u.test(value)) return t('options.branch.invalid', null, lang);
  if (value.includes('..') || value.startsWith('-') || value.endsWith('.') || value.endsWith('/')) {
    return t('options.branch.invalid', null, lang);
  }
  return '';
}

/* ------------------------------- branch check ------------------------------ */

/**
 * The signal behind a branch check. `exists === null` means "the probe did not answer that
 * question" — deliberately distinct from `false`, so the UI never tells a user a branch is missing
 * when it simply does not know.
 */
export interface BranchCheck {
  branch: string;
  exists: boolean | null;
  checkedAt: string;
}

export interface BranchNotice {
  kind: 'unknown' | 'ok' | 'missing';
  message: string;
  /** Label for the follow-up action, or empty when there is nothing to offer. */
  action: 'create' | '';
  actionLabel: string;
}

/**
 * Turn a probe result into the branch row.
 *
 * `remoteBranchExists` is the companion's answer when it has one; `defaultBranch` is the weaker
 * token-mode signal (the REST probe reports the branch it was asked for). When neither answers, the
 * result is `unknown` — the definition of not knowing, as opposed to "missing".
 */
export function branchCheckFromProbe(probe: unknown, branch: string): BranchCheck {
  const wanted = branch.trim();
  const record =
    typeof probe === 'object' && probe !== null && !Array.isArray(probe)
      ? (probe as Record<string, unknown>)
      : null;
  const raw = record ? record['remoteBranchExists'] : undefined;
  let exists: boolean | null = typeof raw === 'boolean' ? raw : null;
  if (exists === null && record) {
    const defaultBranch = record['defaultBranch'];
    if (typeof defaultBranch === 'string' && defaultBranch.length > 0 && wanted.length > 0) {
      exists = defaultBranch === wanted;
    }
  }
  const checkedAtRaw = record ? record['checkedAt'] : undefined;
  return {
    branch: wanted,
    exists,
    // The probe's own timestamp when it has one; the UI never invents a "just checked" time.
    checkedAt: typeof checkedAtRaw === 'string' ? checkedAtRaw : '',
  };
}

export function branchNotice(check: BranchCheck, lang?: Lang): BranchNotice {
  if (check.exists === true) {
    return {
      kind: 'ok',
      message: t('options.branch.exists', { branch: check.branch }, lang),
      action: '',
      actionLabel: '',
    };
  }
  if (check.exists === false) {
    return {
      kind: 'missing',
      message: t('options.branch.missing', { branch: check.branch }, lang),
      action: 'create',
      actionLabel: t('options.branch.create', null, lang),
    };
  }
  return {
    kind: 'unknown',
    message: t('options.branch.unknown', { branch: check.branch }, lang),
    action: 'create',
    actionLabel: t('options.branch.create', null, lang),
  };
}

/**
 * A commit URL for a path, so a search result can be opened in the repository.
 * Returns `null` when the repository is unknown — the caller then renders no open action at all.
 *
 * `repoFullName` is validated by shape (one `/`) because it is interpolated into a URL the popup
 * will open; a value that is not `owner/repo` produces no link rather than a surprising one.
 */
export function repoFileUrl(repoFullName: string, branch: string, path: string): string | null {
  const repo = repoFullName.trim();
  const name = path.trim();
  if (repo.length === 0 || name.length === 0 || !repo.includes('/') || /s/u.test(repo)) return null;
  const ref = branch.trim() || 'main';
  return `https://github.com/${repo}/blob/${encodeURIComponent(ref)}/${name
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

/* ------------------------------------------------------------------ *
 * SSH needs a local clone (F6 / SC-R3-04)
 *
 * A browser extension cannot speak SSH, so the companion drives the user's own git — and git needs a working
 * tree. That prerequisite cannot be designed away, so the honest move is to hand the user the exact command for
 * *their* remote instead of a sentence saying a clone is required, and to catch a bad path before the companion
 * fails with something opaque.
 * ------------------------------------------------------------------ */

/** Quote only when needed, so the common case stays copy-pasteable exactly as typed. */
function quoteForShell(value: string): string {
  return /[\s"']/u.test(value) ? '"' + value.replace(/"/gu, '\\"') + '"' : value;
}

/**
 * The command to run before SSH mode can work.
 *
 * Returns an empty string when either half is missing: a half-built command is worse than none, because it looks
 * runnable and fails in the user's terminal rather than on our screen.
 */
export function cloneCommand(remoteUrl: string, repoRoot: string): string {
  const remote = remoteUrl.trim();
  const target = repoRoot.trim();
  if (remote.length === 0 || target.length === 0) return '';
  return 'git clone ' + quoteForShell(remote) + ' ' + quoteForShell(target);
}

export type RepoRootProblem = 'empty' | 'not-absolute' | 'has-parent' | null;

/**
 * Why a clone path is unusable, or null when it is fine.
 *
 * Deliberately does not check existence: the whole point of showing the command is that the directory does not
 * exist yet. What it does check is the two mistakes that produce a confusing failure later — a relative path
 * (which resolves against the *companion's* working directory, not the user's shell) and a parent segment.
 */
export function repoRootError(repoRoot: string): RepoRootProblem {
  const value = repoRoot.trim();
  if (value.length === 0) return 'empty';
  if (!/^(?:[A-Za-z]:[/\\]|[/\\]|~[/\\])/u.test(value)) return 'not-absolute';
  if (value.split(/[/\\]+/u).includes('..')) return 'has-parent';
  return null;
}
