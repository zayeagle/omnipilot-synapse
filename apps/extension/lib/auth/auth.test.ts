import { describe, expect, it } from 'vitest';

import { NativeError } from '../native/client';
import { NotConfiguredError } from '../store/errors';
import { VaultLockedError } from '../security/key-session';
import { describePlan, planMerge } from '../sync/reconcile';
import { probeFromCompanion } from './ssh-auth';
import { httpsRemoteUrl, sshRemoteUrl } from './types';
import { reasonFor, reasonKey } from './resolve';

describe('auth resolution helpers (F1 UNIT)', () => {
  it('TC-F1-U03 reports an absent companion as native-missing, not as an error', () => {
    expect(reasonFor(new NativeError('nativeUnavailable', 'x'))).toBe('native-missing');
  });

  it('TC-F1-U04 reports a version mismatch distinctly so the UI can say "upgrade"', () => {
    expect(reasonFor(new NativeError('protocolMismatch', 'x'))).toBe('protocol-mismatch');
    expect(reasonKey('protocol-mismatch')).toBe('auth.unavailable.protocol-mismatch');
  });

  it('TC-F1-U08 reports a missing git binary distinctly from a missing companion', () => {
    expect(reasonFor(new NativeError('gitMissing', 'x'))).toBe('git-missing');
    expect(reasonFor(new NativeError('gitFailed', 'x'))).toBe('not-configured');
  });

  it('TC-F1-U02 maps configuration and lock failures to their own reasons', () => {
    expect(reasonFor(new NotConfiguredError())).toBe('not-configured');
    expect(reasonFor(new VaultLockedError())).toBe('vault-locked');
  });

  it('TC-F1-U03 does not disguise a programming error as an unavailable mode', () => {
    // A real bug must surface, not be reported to the user as "install the companion".
    expect(reasonFor(new TypeError('undefined is not a function'))).toBeNull();
    expect(reasonFor('a string')).toBeNull();
  });

  it('TC-F1-U07 describes both modes without ever containing a credential', () => {
    expect(sshRemoteUrl('github.com', 'git', 'zayeagle', 'omnipilot-synapse')).toBe(
      'git@github.com:zayeagle/omnipilot-synapse.git',
    );
    expect(httpsRemoteUrl('zayeagle', 'omnipilot-synapse')).toBe(
      'https://github.com/zayeagle/omnipilot-synapse.git',
    );
  });

  it('TC-F1-U05 never claims SSH visibility it cannot know', () => {
    const probe = probeFromCompanion(
      {
        root: '/home/me/kb',
        branch: 'main',
        head: 'abc123',
        remoteUrl: 'git@github.com:o/r.git',
        dirty: false,
        reachable: true,
        remoteBranchExists: true,
      },
      'o/r',
    );
    // SSH access is not evidence that a repository is private, so visibility stays unknown and the
    // public-repo guard keeps its existing, conservative behaviour.
    expect(probe.visibility).toBe('unknown');
    expect(probe.canWrite).toBe(true);
    expect(probe.defaultBranch).toBe('main');
  });

  it('TC-F1-U05 refuses to write when the companion reports an unreachable remote', () => {
    const probe = probeFromCompanion(
      {
        root: '/home/me/kb',
        branch: 'main',
        head: null,
        remoteUrl: null,
        dirty: false,
        reachable: false,
        remoteBranchExists: false,
      },
      'o/r',
    );
    expect(probe.canWrite).toBe(false);
    expect(probe.canPush).toBe(false);
  });
});

describe('sync plan summary (F3 UNIT)', () => {
  it('TC-F3-U01 renders a content-free one-line summary', () => {
    const plan = planMerge({
      local: [{ path: 'inbox/a.md', kind: 'added' }],
      remote: [{ path: 'inbox/b.md', kind: 'modified' }],
      now: () => Date.UTC(2026, 6, 9, 14, 30),
    });
    const summary = describePlan(plan);
    expect(summary).toBe('pull=1 push=1 drop=0 resurrect=0 conflicts=0');
    expect(summary).not.toContain('inbox');
  });
});
