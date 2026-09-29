import { describe, expect, it } from 'vitest';
import { cloneCommand, repoRootError } from './auth-form';

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
});
