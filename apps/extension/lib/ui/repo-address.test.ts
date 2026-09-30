import { describe, expect, it } from 'vitest';

import { parseInnerPath, parseRepoAddress, repoAddressOf } from './repo-address';

/**
 * TC-ST-U01…U04 — the two fields the storage form is allowed to ask for.
 *
 * The rules are asserted on the *inputs a person actually pastes*: a repository URL from the browser,
 * a `git clone` URL, and the shorthand from a colleague's message. The refusals matter as much as the
 * acceptances — the form used to accept `https://github.com/owner/repo/` as a path prefix and then
 * write the whole knowledge base under a directory named `https:`.
 */
describe('repository address (storage form)', () => {
  it('TC-ST-U01 accepts the addresses a person actually has', () => {
    const accepted: Array<[string, string, string]> = [
      ['https://github.com/zayeagle/notes', 'zayeagle', 'notes'],
      ['https://github.com/zayeagle/notes/', 'zayeagle', 'notes'],
      ['http://github.com/zayeagle/notes', 'zayeagle', 'notes'],
      ['https://github.com/zayeagle/notes.git', 'zayeagle', 'notes'],
      ['git@github.com:zayeagle/notes.git', 'zayeagle', 'notes'],
      ['zayeagle/notes', 'zayeagle', 'notes'],
      ['  zayeagle/notes  ', 'zayeagle', 'notes'],
    ];
    for (const [input, owner, repo] of accepted) {
      const parsed = parseRepoAddress(input);
      expect(parsed.ok, input).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.owner, input).toBe(owner);
      expect(parsed.value.repo, input).toBe(repo);
    }
  });

  it('TC-ST-U02 reads the branch out of a tree URL, and only out of one', () => {
    const withBranch = parseRepoAddress('https://github.com/zayeagle/notes/tree/release/2.x');
    expect(withBranch.ok && withBranch.value.branch).toBe('release/2.x');
    // No branch named: the field's own value stands.
    const without = parseRepoAddress('https://github.com/zayeagle/notes');
    expect(without.ok && without.value.branch).toBeUndefined();
  });

  it('TC-ST-U03 refuses what it cannot honour, with a reason the page can translate', () => {
    const required = parseRepoAddress('   ');
    expect(required.ok).toBe(false);
    expect(required.ok === false && required.messageKey).toBe('options.store.repoAddress.required');

    const host = parseRepoAddress('https://gitlab.com/zayeagle/notes');
    expect(host.ok === false && host.messageKey).toBe('options.store.repoAddress.host');

    for (const input of [
      'https://github.com/zayeagle',
      'https://github.com/zayeagle/',
      'https://github.com/zayeagle/notes/inbox/2026',
      'zayeagle',
      'zayeagle/no tes',
      'https://github.com/../notes',
    ]) {
      const parsed = parseRepoAddress(input);
      expect(parsed.ok, input).toBe(false);
      expect(parsed.ok === false && parsed.messageKey, input).toBe('options.store.repoAddress.invalid');
    }
  });

  it('TC-ST-U04 round-trips a stored configuration back into the field', () => {
    expect(repoAddressOf('zayeagle', 'notes')).toBe('https://github.com/zayeagle/notes');
    expect(repoAddressOf('', 'notes')).toBe('');
    const reparsed = parseRepoAddress(repoAddressOf('zayeagle', 'notes'));
    expect(reparsed.ok && reparsed.value).toEqual({ owner: 'zayeagle', repo: 'notes' });
  });
});

describe('inner path (storage form)', () => {
  it('TC-ST-U05 an empty value means the repository root, and a directory normalises', () => {
    expect(parseInnerPath('')).toEqual({ ok: true, value: '' });
    expect(parseInnerPath('   ')).toEqual({ ok: true, value: '' });
    expect(parseInnerPath('kb')).toEqual({ ok: true, value: 'kb' });
    expect(parseInnerPath('/kb/')).toEqual({ ok: true, value: 'kb' });
    expect(parseInnerPath('kb/notes')).toEqual({ ok: true, value: 'kb/notes' });
  });

  it('TC-ST-U06 refuses a URL here — the mistake that produced a directory named "https:"', () => {
    for (const input of [
      'https://github.com/zayeagle/',
      'https://github.com/zayeagle/notes',
      'github.com/zayeagle',
      'kb//notes',
      'kb\\notes',
      '../etc',
      'kb/../etc',
      'kb/./notes',
    ]) {
      const parsed = parseInnerPath(input);
      expect(parsed.ok, input).toBe(false);
      expect(parsed.ok === false && parsed.messageKey, input).toBe('options.store.innerPath.invalid');
    }
  });
});
