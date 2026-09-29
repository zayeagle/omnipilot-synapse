/**
 * Token authorization — the 0.1.0 path, unchanged in behaviour but now behind `GitAuth`.
 *
 * This is the mode that must always work: no companion, no local clone, no extra setup. If anything
 * here ever becomes harder than it was before this requirement, that is a regression.
 */

import { VaultLockedError } from '../security/key-session';
import type { SecurityMode } from '../messages';
import { NotConfiguredError } from '../store/errors';
import { createGitHubStore, type GitHubStore } from '../store/github-store';
import { vaultKdfFromEnvelope } from '../store/vault-codec';
import type { StoreProbe } from '../store/types';
import {
  httpsRemoteUrl,
  type AuthContext,
  type AuthDescriptor,
  type TokenBackedAuth,
} from './types';

export class TokenAuth implements TokenBackedAuth {
  readonly mode = 'token' as const;
  private store: GitHubStore | null = null;

  constructor(private readonly context: AuthContext) {}

  describe(): AuthDescriptor {
    const github = this.context.snapshot.github;
    return {
      mode: 'token',
      label: 'access token',
      remote: github.owner && github.repo ? httpsRemoteUrl(github.owner, github.repo) : null,
      branch: github.branch,
      detail: github.apiBase,
    };
  }

  securityMode(): SecurityMode {
    return this.context.snapshot.securityMode;
  }

  async assertReady(): Promise<void> {
    const settings = this.context.snapshot;
    if (!settings.github.owner || !settings.github.repo || !settings.github.branch) {
      throw new NotConfiguredError('auth: owner, repository and branch are required');
    }
    // `getSecrets` throws `VaultLockedError` when the vault is locked — the correct, fail-closed
    // behaviour: there is no path that reads a token without an unlocked vault.
    const secrets = await this.context.settings.getSecrets();
    if (!secrets.githubPat) {
      throw new NotConfiguredError('auth: a GitHub access token is required for token mode');
    }
    if (settings.securityMode === 'vault') {
      const envelope = await this.context.settings.getEnvelope();
      if (!envelope) throw new NotConfiguredError('auth: vault mode needs a configured passphrase');
    }
  }

  async createStore(): Promise<GitHubStore> {
    if (this.store) return this.store;
    const settings = this.context.snapshot;
    if (!settings.github.owner || !settings.github.repo || !settings.github.branch) {
      throw new NotConfiguredError('auth: owner, repository and branch are required');
    }
    const secrets = await this.context.settings.getSecrets();
    if (!secrets.githubPat) {
      throw new NotConfiguredError('auth: a GitHub access token is required for token mode');
    }

    const envelope = await this.context.settings.getEnvelope();
    const kdf = envelope ? vaultKdfFromEnvelope(envelope) : null;
    if (settings.securityMode === 'vault' && !kdf) {
      // Fail closed rather than silently writing plaintext into an encrypted store.
      throw new VaultLockedError('auth: vault mode needs the store KDF parameters');
    }

    this.store = createGitHubStore({
      owner: settings.github.owner,
      repo: settings.github.repo,
      branch: settings.github.branch,
      apiBase: settings.github.apiBase,
      token: secrets.githubPat,
      securityMode: settings.securityMode,
      prefix: settings.github.pathPrefix,
      publicRepoAcknowledged: settings.github.publicRepoAcknowledged,
      session: this.context.session,
      kdf,
      fetchImpl: this.context.fetchImpl,
      ...(this.context.crypto ? { crypto: this.context.crypto } : {}),
      ...(this.context.now ? { now: this.context.now } : {}),
    });
    return this.store;
  }

  async probe(): Promise<StoreProbe> {
    return (await this.createStore()).probe();
  }

  /** Invalidate the memoised store after a settings change. */
  reset(): void {
    this.store = null;
  }
}
