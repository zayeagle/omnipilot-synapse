import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import {
  authFormOf,
  cloneCommand,
  cloneGuidance,
  repoRootError,
  repoRootProblemText,
  sshRemoteUrlFor,
  validateSshForm,
} from './auth-form';

/**
 * TC-P6-U01/U02 — the SSH prerequisite, made copy-pasteable.
 *
 * The value of these helpers is that the user never has to work out the command or guess why the companion
 * rejected a path. So the assertions are about the exact string they will paste, and about which mistakes are
 * caught here rather than in a terminal.
 */
describe('SSH clone guidance (F6 UNIT)', () => {
  it('TC-P6-U01 builds the command for the user\'s own remote', () => {
    expect(cloneCommand('git@github.com:zayeagle/omnipilot-synapse.git', '/home/me/synapse')).toBe(
      'git clone git@github.com:zayeagle/omnipilot-synapse.git /home/me/synapse',
    );
    // A space in the path must survive a paste into a shell.
    expect(cloneCommand('git@github.com:o/r.git', 'C:\\My Notes\\synapse')).toBe(
      'git clone git@github.com:o/r.git "C:\\My Notes\\synapse"',
    );
    // No half-built commands: both halves are required.
    expect(cloneCommand('', '/tmp/x')).toBe('');
    expect(cloneCommand('git@github.com:o/r.git', '   ')).toBe('');
  });

  it('TC-P6-U02 catches the two path mistakes that fail confusingly later', () => {
    expect(repoRootError('')).toBe('empty');
    // Relative paths resolve against the *companion's* cwd, not the user's shell.
    expect(repoRootError('synapse')).toBe('not-absolute');
    expect(repoRootError('~/synapse')).toBeNull();
    expect(repoRootError('/home/me/synapse')).toBeNull();
    expect(repoRootError('C:\\Users\\me\\synapse')).toBeNull();
    expect(repoRootError('/home/../etc')).toBe('has-parent');
  });

  it('TC-P6-U03 names the remedy for each path mistake, never the key', () => {
    expect(repoRootProblemText(null)).toBe('');
    for (const problem of ['empty', 'not-absolute', 'has-parent'] as const) {
      const text = repoRootProblemText(problem);
      expect(text.length).toBeGreaterThan(0);
      // A rendered key name would be "translated" into something no user can act on.
      expect(text).not.toContain('options.auth.ssh');
    }
    expect(repoRootProblemText('not-absolute')).toBe(t('options.auth.ssh.repoRootNotAbsolute'));
    expect(repoRootProblemText('has-parent')).toBe(t('options.auth.ssh.repoRootHasParent'));
  });

  it('TC-P6-U04 refuses to build a command for an unnamed repository', () => {
    expect(sshRemoteUrlFor('github.com', 'git', 'zayeagle', 'omnipilot-synapse')).toBe(
      'git@github.com:zayeagle/omnipilot-synapse.git',
    );
    // The motivating mistake: interpolating empty halves yields git@github.com:/.git, which looks runnable.
    expect(sshRemoteUrlFor('github.com', 'git', '', '')).toBe('');
    expect(sshRemoteUrlFor('', 'git', 'o', 'r')).toBe('');

    const unnamed = cloneGuidance({
      host: 'github.com',
      user: 'git',
      owner: '',
      repo: '',
      repoRoot: '/kb',
    });
    expect(unnamed.command).toBe('');

    const ready = cloneGuidance({
      host: 'github.com',
      user: 'git',
      owner: 'o',
      repo: 'r',
      repoRoot: '/kb',
    });
    expect(ready.command).toBe('git clone git@github.com:o/r.git /kb');
    expect(ready.problem).toBeNull();
    expect(ready.problemText).toBe('');
  });

  it('TC-P6-U05 the field validator reaches the same verdict as the clone block', () => {
    // Saving a path the companion would refuse is exactly the failure this prevents.
    expect(validateSshForm(authFormOf('ssh', 'main', { repoRoot: 'synapse' }).ssh).repoRoot).toBe(
      t('options.auth.ssh.repoRootNotAbsolute'),
    );
    expect(validateSshForm(authFormOf('ssh', 'main', { repoRoot: '/home/../etc' }).ssh).repoRoot).toBe(
      t('options.auth.ssh.repoRootHasParent'),
    );
    expect(validateSshForm(authFormOf('ssh', 'main', { repoRoot: '/home/me/kb' }).ssh).repoRoot).toBe(
      '',
    );
  });
});
