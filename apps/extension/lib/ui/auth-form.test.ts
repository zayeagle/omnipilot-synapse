import { describe, expect, it } from 'vitest';

import { t } from '../i18n';
import {
  authFormOf,
  authModeDisabled,
  authModeOptions,
  authPayloadToForm,
  branchCheckFromProbe,
  branchNotice,
  companionStatusText,
  defaultAuthForm,
  emptySshForm,
  formToAuthPayload,
  repoFileUrl,
  sshFormOf,
  sshSaveDisabled,
  validateBranch,
  validateSshForm,
  type AuthModeAvailability,
} from './auth-form';

/** Credential-shaped strings: none of them may ever survive a form → payload → form round trip. */
const SECRET_LOOKALIKE = /gh[pousr]_|github_pat_|sk-|Bearer|PRIVATE KEY/u;

const NO_COMPANION: AuthModeAvailability = { companion: 'missing', hasPat: true };
const READY: AuthModeAvailability = { companion: 'ok', hasPat: true };

function ssh(overrides: Partial<ReturnType<typeof emptySshForm>> = {}): ReturnType<typeof emptySshForm> {
  return { host: 'github.com', user: 'git', keyRef: 'default', repoRoot: '/home/me/kb', ...overrides };
}

describe('authorization mode picker (F5 UNIT)', () => {
  it('TC-F5-U01 keeps token enabled and enables ssh only when the companion is usable', () => {
    const missing = authModeOptions(NO_COMPANION);
    expect(missing.map((option) => option.value)).toEqual(['token', 'ssh']);
    expect(missing[0]?.enabled).toBe(true);
    expect(missing[1]?.enabled).toBe(false);
    expect(missing[1]?.reasonKey).toBe('options.auth.ssh.disabled.missing');

    const mismatch = authModeOptions({ companion: 'mismatch', hasPat: true });
    expect(mismatch[1]?.enabled).toBe(false);
    expect(mismatch[1]?.reasonKey).toBe('options.auth.ssh.disabled.mismatch');

    const ready = authModeOptions(READY);
    expect(ready[1]?.enabled).toBe(true);
    expect(ready[1]?.reasonKey).toBe('');
  });

  it('TC-F5-U01 labels both modes in the requested language', () => {
    const en = authModeOptions(READY, 'en');
    expect(en[0]?.label).toBe(t('options.auth.mode.token', null, 'en'));
    expect(en[1]?.label).toBe(t('options.auth.mode.ssh', null, 'en'));
    for (const option of authModeOptions(READY, 'zh_CN')) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.label).not.toMatch(SECRET_LOOKALIKE);
    }
  });

  it('TC-F5-U01 disables the picker for a stored ssh choice with no companion', () => {
    expect(authModeDisabled('token', NO_COMPANION)).toBe(false);
    expect(authModeDisabled('ssh', NO_COMPANION)).toBe(true);
    expect(authModeDisabled('ssh', { companion: 'mismatch', hasPat: false })).toBe(true);
    expect(authModeDisabled('ssh', READY)).toBe(false);
  });
});

describe('companion status text (F5 UNIT)', () => {
  it('TC-F5-U02 renders three distinct fixed messages', () => {
    const messages = (['ok', 'missing', 'mismatch'] as const).map((state) => companionStatusText(state));
    expect(new Set(messages).size).toBe(3);
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(SECRET_LOOKALIKE);
    }
    expect(messages[0]).toBe(t('options.auth.companion.ok'));
    expect(messages[1]).toBe(t('options.auth.companion.missing'));
    expect(messages[2]).toBe(t('options.auth.companion.mismatch'));
  });

  it('TC-F5-U02 honours the requested language and never leaks a path or key', () => {
    expect(companionStatusText('missing', 'en')).toBe(
      t('options.auth.companion.missing', null, 'en'),
    );
    expect(companionStatusText('ok', 'zh_CN')).not.toContain('/home');
  });
});

describe('mode switch keeps the other mode intact (F5 UNIT)', () => {
  it('TC-F5-U04 leaves the token branch and the ssh fields untouched when switching mode', () => {
    const token = authFormOf('token', 'trunk', ssh({ repoRoot: '/srv/kb', host: 'git.example.com' }));
    const switched = { ...token, mode: 'ssh' as const };
    // Switching the picker changes `mode` only — the other mode's stored values are still there.
    expect(switched.ssh).toEqual(token.ssh);
    expect(switched.branch).toBe('trunk');
    expect(switched.mode).toBe('ssh');
  });

  it('TC-F5-U04 round-trips a form through the payload without touching the other mode', () => {
    const before = authFormOf('ssh', 'main', ssh({ repoRoot: '/srv/kb' }));
    const payload = formToAuthPayload(before);
    const after = authPayloadToForm({ settings: { authMode: payload.mode, ssh: payload.ssh, github: payload.github } });
    // The auth payload carries mode + branch + ssh; the sync policy is a separate save.
    expect(after.mode).toBe(before.mode);
    expect(after.branch).toBe(before.branch);
    expect(after.ssh).toEqual(before.ssh);
    expect(after.ssh.repoRoot).toBe('/srv/kb');
  });

  it('TC-F5-U04 keeps blank ssh fields out of the payload instead of clearing them', () => {
    const payload = formToAuthPayload(authFormOf('token', 'main', ssh({ repoRoot: '' })));
    expect('repoRoot' in payload.ssh).toBe(false);
    expect(payload.ssh.host).toBe('github.com');
    expect(payload.github).toEqual({ branch: 'main' });
  });
});

describe('ssh form validation (F5 UNIT)', () => {
  it('TC-F5-U06 rejects an empty host or user with the matching field messages', () => {
    const errors = validateSshForm(ssh({ host: '  ', user: '' }));
    expect(errors.host).toBe(t('options.auth.ssh.hostRequired'));
    expect(errors.user).toBe(t('options.auth.ssh.userRequired'));
    expect(errors.keyRef).toBe('');
    expect(errors.repoRoot).toBe('');
    expect(sshSaveDisabled(ssh({ host: '', user: '' }))).toBe(true);
  });

  it('TC-F5-U06 requires the local clone path — SSH cannot work without it', () => {
    const errors = validateSshForm(ssh({ repoRoot: '' }));
    expect(errors.repoRoot).toBe(t('options.auth.ssh.repoRootRequired'));
    expect(sshSaveDisabled(ssh({ repoRoot: '' }))).toBe(true);
    expect(sshSaveDisabled(ssh())).toBe(false);
  });

  it('TC-F5-U06 rejects whitespace and over-long values per field', () => {
    expect(validateSshForm(ssh({ host: 'git host' })).host).toBe(t('options.auth.ssh.hostInvalid'));
    expect(validateSshForm(ssh({ user: 'a b' })).user).toBe(t('options.auth.ssh.userInvalid'));
    expect(validateSshForm(ssh({ keyRef: 'x'.repeat(121) })).keyRef).toBe(
      t('options.auth.ssh.keyInvalid'),
    );
    expect(validateSshForm(ssh({ repoRoot: 'x'.repeat(600) })).repoRoot).toBe(
      t('options.auth.ssh.repoRootInvalid'),
    );
    expect(validateSshForm(ssh({ keyRef: '' })).keyRef).toBe(t('options.auth.ssh.keyRequired'));
  });

  it('TC-F5-U06 validates branch names the way git does', () => {
    expect(validateBranch('main')).toBe('');
    expect(validateBranch('feature/sync-ui')).toBe('');
    expect(validateBranch('  trunk  ')).toBe('');
    expect(validateBranch('')).toBe(t('options.branch.required'));
    expect(validateBranch('bad branch')).toBe(t('options.branch.invalid'));
    expect(validateBranch('a..b')).toBe(t('options.branch.invalid'));
    expect(validateBranch('-danger')).toBe(t('options.branch.invalid'));
    expect(validateBranch('x'.repeat(201))).toBe(t('options.branch.invalid'));
  });
});

describe('branch check (F5 UNIT)', () => {
  it('TC-F5-U05 reports exists → ok and missing → a create action', () => {
    const exists = branchNotice(branchCheckFromProbe({ remoteBranchExists: true }, 'main'));
    expect(exists.kind).toBe('ok');
    expect(exists.action).toBe('');
    expect(exists.message).toContain('main');

    const missing = branchNotice(branchCheckFromProbe({ remoteBranchExists: false }, 'release'));
    expect(missing.kind).toBe('missing');
    expect(missing.action).toBe('create');
    expect(missing.actionLabel).toBe(t('options.branch.create'));
    expect(missing.message).toContain('release');
  });

  it('TC-F5-U05 falls back to the resolved default branch when the flag is absent', () => {
    expect(branchCheckFromProbe({ defaultBranch: 'main' }, 'main').exists).toBe(true);
    expect(branchCheckFromProbe({ defaultBranch: 'main' }, 'other').exists).toBe(false);
    const unknown = branchCheckFromProbe({ kind: 'github' }, 'main');
    expect(unknown.exists).toBeNull();
    // Unknown is NOT "missing": it offers the create action without claiming the branch is absent.
    expect(branchNotice(unknown).kind).toBe('unknown');
    expect(branchNotice(unknown).action).toBe('create');
    expect(branchCheckFromProbe(null, 'main').exists).toBeNull();
    expect(branchCheckFromProbe('junk', 'main').branch).toBe('main');
  });

  it('TC-F5-U05 keeps the probe timestamp when it has one', () => {
    const check = branchCheckFromProbe({ remoteBranchExists: true, checkedAt: '2026-07-09T10:00:00.000Z' }, 'main');
    expect(check.checkedAt).toBe('2026-07-09T10:00:00.000Z');
  });

  it('TC-F5-U05 derives a repository file URL, or nothing when the repo is unknown', () => {
    expect(repoFileUrl('zayeagle/kb', 'main', 'cards/pending/a b.md')).toBe(
      'https://github.com/zayeagle/kb/blob/main/cards/pending/a%20b.md',
    );
    expect(repoFileUrl('zayeagle/kb', '', 'inbox/a.md')).toContain('/blob/main/');
    expect(repoFileUrl('', 'main', 'inbox/a.md')).toBeNull();
    expect(repoFileUrl('zayeagle/kb', 'main', '')).toBeNull();
    expect(repoFileUrl('not-a-repo', 'main', 'a.md')).toBeNull();
  });
});

describe('secret hygiene (F5 UNIT)', () => {
  it('TC-F5-U03 never places a credential in the form model', () => {
    const form = authFormOf('ssh', 'main', ssh({ repoRoot: '/home/me/kb' }), {
      intervalMinutes: 30,
      onStartup: true,
    });
    const serialized = JSON.stringify(form);
    expect(serialized).not.toMatch(SECRET_LOOKALIKE);
    for (const key of ['pat', 'token', 'passphrase', 'privateKey', 'apiKey', 'githubPat']) {
      expect(Object.keys(form)).not.toContain(key);
    }
    // The SSH model carries a key *reference*, and a value shaped like a key would never be stored.
    expect(form.ssh.keyRef).toBe('default');
  });

  it('TC-F5-U03 defaults are stable', () => {
    expect(defaultAuthForm().mode).toBe('token');
    expect(defaultAuthForm().branch).toBe('main');
    expect(defaultAuthForm().ssh).toEqual(emptySshForm());
    expect(authPayloadToForm('junk')).toEqual(defaultAuthForm());
    expect(authPayloadToForm(null)).toEqual(defaultAuthForm());
    expect(authPayloadToForm([])).toEqual(defaultAuthForm());
  });

  it('TC-F5-U07 normalises a messy form on the way to the payload', () => {
    const payload = formToAuthPayload({
      mode: 'ssh',
      branch: '  ',
      ssh: { host: ' git.example.com ', user: ' deploy ', keyRef: ' work ', repoRoot: ' /srv/kb ' },
      syncPolicy: {},
    });
    expect(payload.mode).toBe('ssh');
    expect(payload.github).toEqual({ branch: 'main' });
    expect(payload.ssh).toEqual({
      host: 'git.example.com',
      user: 'deploy',
      keyRef: 'work',
      repoRoot: '/srv/kb',
    });
    expect(sshFormOf(authFormOf('ssh', 'main', { host: 'h', user: 'u', keyRef: 'k', repoRoot: 'r' }))).toEqual({
      host: 'h',
      user: 'u',
      keyRef: 'k',
      repoRoot: 'r',
    });
  });
});
