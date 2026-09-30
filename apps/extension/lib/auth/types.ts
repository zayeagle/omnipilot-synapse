/**
 * The authorization abstraction the storage layer sees.
 *
 * There are exactly two ways to reach the user's repository, and everything above this layer is
 * written against `GitAuth`:
 *
 * - **token** — the extension's own HTTPS client against the GitHub REST API, with a PAT from the vault;
 * - **ssh** — the companion process running the user's own `git`/`ssh` against a local clone.
 *
 * The contract deliberately exposes *availability* as data (`AuthResolution`) rather than throwing:
 * a missing companion is a normal, expected state (most users will never install it), and the UI must
 * be able to say "SSH needs the companion, here is how" while token mode keeps working.
 */

import type { SecurityMode } from '../messages';
import type { NativeClient } from '../native/client';
import type { RepoInfoData } from '../native/protocol';
import type { CryptoProvider } from '../security/crypto-key';
import type { KeySession } from '../security/key-session';
import type { ExtensionSettings, SettingsStore } from '../settings-store';
import type { FetchLike } from '../store/github-api';
import type { GitHubStore } from '../store/github-store';
import type { StoreProbe } from '../store/types';

export type AuthMode = 'token' | 'ssh';

/** Why a mode cannot be used right now — a fixed set, so the UI can translate each one. */
export type AuthUnavailableReason =
  | 'not-configured'
  | 'native-missing'
  | 'protocol-mismatch'
  | 'git-missing'
  | 'vault-locked';

export interface AuthDescriptor {
  mode: AuthMode;
  /** Short label for status rows and logs — never contains a credential. */
  label: string;
  /** Remote the operations target, when it can be described without a credential. */
  remote: string | null;
  /** e.g. `main` for the branch in use. */
  branch: string;
  /** Free-form, non-secret detail for the UI (e.g. the local clone path). */
  detail: string;
}

export interface GitAuth {
  readonly mode: AuthMode;
  describe(): AuthDescriptor;
  /** Throws a classified error when the mode cannot run. */
  assertReady(): Promise<void>;
  /** Repository metadata (visibility / push rights / branch existence). */
  probe(): Promise<StoreProbe>;
  /** The security tier in force for this store. */
  securityMode(): SecurityMode;
}

/**
 * The two modes have genuinely different transports, so they are different types rather than one
 * interface with a method that throws for half its implementations. The sync engine switches on
 * `mode`, and the compiler makes sure it handles both.
 */
export interface TokenBackedAuth extends GitAuth {
  readonly mode: 'token';
  /**
   * The REST store. `mode` overrides the content tier for this call: the repository's own record wins
   * over the local setting, and the store cannot exist without knowing which codec it speaks (R8).
   */
  createStore(mode?: SecurityMode): Promise<GitHubStore>;
}

export interface SshBackedAuth extends GitAuth {
  readonly mode: 'ssh';
  /** Repository state as the companion sees it (branch, head, dirtiness). */
  info(): Promise<RepoInfoData>;
  createTransport(): Promise<{ native: NativeClient; repoRoot: string; branch: string }>;
}

export type ResolvedAuth = TokenBackedAuth | SshBackedAuth;

export type AuthResolution =
  | { ok: true; auth: ResolvedAuth }
  | { ok: false; reason: AuthUnavailableReason; message: string };

export interface AuthContext {
  settings: SettingsStore;
  /**
   * Settings loaded once by `resolveAuth`.
   *
   * Held as a snapshot so `describe()` and `securityMode()` can stay synchronous (the UI calls them
   * while rendering) without re-reading storage, and so one resolution sees one consistent config.
   */
  snapshot: ExtensionSettings;
  session: KeySession | null;
  fetchImpl: FetchLike;
  /** `null` when the harness has no native messaging at all (tests, and Firefox without a host). */
  native: NativeClient | null;
  crypto?: CryptoProvider;
  now?: () => number;
}

/** `git@github.com:owner/repo.git` — the URL a user would recognise. */
export function sshRemoteUrl(host: string, user: string, owner: string, repo: string): string {
  return `git@${host}:${owner}/${repo}.git`;
}

export function httpsRemoteUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

export function isAuthResolutionOk(
  resolution: AuthResolution,
): resolution is { ok: true; auth: ResolvedAuth } {
  return resolution.ok;
}
