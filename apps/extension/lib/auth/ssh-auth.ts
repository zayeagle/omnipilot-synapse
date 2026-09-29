/**
 * SSH authorization — the companion-backed mode.
 *
 * This class holds **nothing secret**. It knows a host, a user, a key *reference* and a local clone
 * path, and it delegates every operation to the companion process, which uses the user's own `git`
 * and `ssh` (so their agent, `~/.ssh/config` and `known_hosts` apply). The extension never reads,
 * stores or transmits key material — that is structural here, not a convention: there is no field to
 * put a key in.
 *
 * The consequence a user must understand (and the UI states it): SSH mode needs a **local clone** of
 * the knowledge repository, because `git` needs a working tree. Token mode has no such requirement.
 */

import { VaultLockedError } from '../security/key-session';
import { NotConfiguredError } from '../store/errors';
import type { StoreProbe } from '../store/types';
import { NativeError, type NativeClient } from '../native/client';
import {
  asGitProbe,
  asRepoInfo,
  type GitProbeData,
  type RepoInfoData,
} from '../native/protocol';
import type { SecurityMode } from '../messages';
import {
  sshRemoteUrl,
  type AuthContext,
  type AuthDescriptor,
  type SshBackedAuth,
} from './types';

/** The companion's answer for one repository, normalised into the store's shape. */
export function probeFromCompanion(info: GitProbeData, repoFullName: string): StoreProbe {
  return {
    kind: 'github',
    repoFullName,
    // The companion reports nothing about visibility; SSH access is not evidence of privacy.
    visibility: 'unknown',
    defaultBranch: info.branch,
    canPush: info.reachable,
    canWrite: info.reachable,
    checkedAt: new Date().toISOString(),
  };
}

export class SshAuth implements SshBackedAuth {
  readonly mode = 'ssh' as const;

  constructor(
    private readonly context: AuthContext,
    private readonly native: NativeClient,
  ) {}

  private get ssh() {
    return this.context.snapshot.ssh;
  }

  describe(): AuthDescriptor {
    const github = this.context.snapshot.github;
    return {
      mode: 'ssh',
      label: 'ssh key',
      remote:
        github.owner && github.repo
          ? sshRemoteUrl(this.ssh.host, this.ssh.user, github.owner, github.repo)
          : null,
      branch: github.branch,
      detail: this.ssh.repoRoot || 'no local clone configured',
    };
  }

  securityMode(): SecurityMode {
    return this.context.snapshot.securityMode;
  }

  /** Every failure here is explained in terms the UI can act on. */
  async assertReady(): Promise<void> {
    const github = this.context.snapshot.github;
    if (!this.ssh.repoRoot) {
      throw new NotConfiguredError(
        'auth: SSH mode needs a local clone of the repository (set the repository path)',
      );
    }
    if (!github.owner || !github.repo || !github.branch) {
      throw new NotConfiguredError('auth: owner, repository and branch are required');
    }
    if (this.context.snapshot.securityMode === 'vault') {
      const envelope = await this.context.settings.getEnvelope();
      if (!envelope) throw new NotConfiguredError('auth: vault mode needs a configured passphrase');
      if (!this.context.session?.isUnlocked()) {
        throw new VaultLockedError('auth: unlock the vault before syncing an encrypted store');
      }
    }

    const availability = await this.native.availability();
    if (availability === 'missing') {
      throw new NativeError('nativeUnavailable', 'auth: the companion process is not installed');
    }
    if (availability === 'mismatch') {
      throw new NativeError('protocolMismatch', 'auth: the companion needs an upgrade');
    }
  }

  /** Repository state straight from the companion, with `reachable` reflecting the remote. */
  async info(): Promise<RepoInfoData> {
    await this.assertReady();
    const raw = await this.native.send('repo.info', { cwd: this.ssh.repoRoot });
    const info = asRepoInfo(raw);
    if (!info) throw new NativeError('internal', 'auth: the companion returned an unusable repo.info');
    return info;
  }

  async probe(): Promise<StoreProbe> {
    const github = this.context.snapshot.github;
    await this.assertReady();
    const raw = await this.native.send('git.probe', { cwd: this.ssh.repoRoot });
    const info = asGitProbe(raw);
    if (!info) throw new NativeError('internal', 'auth: the companion returned an unusable git.probe');
    return {
      ...probeFromCompanion(info, `${github.owner}/${github.repo}`),
      checkedAt: new Date(this.context.now?.() ?? Date.now()).toISOString(),
    };
  }

  /**
   * The companion *is* the transport: there is no REST store to build for this mode. Kept as an
   * explicit method (rather than a null field) so the sync engine must ask for it deliberately.
   */
  async createTransport(): Promise<{ native: NativeClient; repoRoot: string; branch: string }> {
    await this.assertReady();
    return {
      native: this.native,
      repoRoot: this.ssh.repoRoot,
      branch: this.context.snapshot.github.branch,
    };
  }
}
