import { describe, expect, it } from 'vitest';
import {
  ALLOWED_OPS,
  PROTOCOL_VERSION,
  asGitLs,
  asGitShow,
  buildRequest,
  checkHandshake,
  isAllowedOp,
  nativeCodeToErrorCode,
  parseNativeResponse,
} from './protocol';

/**
 * TC-F2-U10 / TC-F2-I02 — the extension-side half of the companion contract.
 *
 * Two rules are asserted here rather than assumed: no op leaves the extension unless it is on the
 * allow-list (so a compromised page cannot turn the companion into a command runner), and an
 * unrecognised response is `internal` rather than `undefined` (a silent undefined would read as
 * "the git operation succeeded and returned nothing", the worst possible failure mode).
 */

describe('native protocol mirror (F2 UNIT)', () => {
  it('TC-F2-U10 the allow-list is exactly the ops the companion implements', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect([...ALLOWED_OPS]).toEqual([
      'ping',
      'repo.info',
      'git.probe',
      'git.status',
      'git.fetch',
      'git.show',
      'git.ls',
      'git.write',
      'git.commit',
      'git.push',
      'key.list',
    ]);
    expect(isAllowedOp('git.show')).toBe(true);
    expect(isAllowedOp('shell.exec')).toBe(false);
    expect(isAllowedOp(undefined)).toBe(false);
  });

  it('TC-F2-I02 refuses to build a request for an op outside the allow-list', () => {
    expect(() => buildRequest('git.show', { id: 'r1' })).not.toThrow();
    expect(() =>
      buildRequest('shell.exec' as never, { id: 'r2' }),
    ).toThrow(/refusing to send op/);
    expect(buildRequest('git.status', { id: 'r3', cwd: '/clone' })).toEqual({
      v: 1,
      id: 'r3',
      op: 'git.status',
      cwd: '/clone',
    });
  });

  it('TC-F2-I02 an unrecognised response is internal, never undefined', () => {
    expect(parseNativeResponse({ ok: true, data: { any: 'thing' } })).toEqual({
      ok: true,
      data: { any: 'thing' },
    });
    expect(parseNativeResponse({ ok: false, code: 'notFound', message: 'gone' })).toEqual({
      ok: false,
      code: 'notFound',
      message: 'gone',
    });
    expect(parseNativeResponse({ ok: false, code: 'made-up', message: '' })).toEqual({
      ok: false,
      code: 'internal',
      message: 'native: internal',
    });
    expect(parseNativeResponse('nope')).toEqual({
      ok: false,
      code: 'internal',
      message: 'native: response was not an object',
    });
  });

  it('TC-F2-I02 the handshake distinguishes compatible from mismatched peers', () => {
    expect(checkHandshake({ protocolVersion: 1 }).compatible).toBe(true);
    expect(checkHandshake({ protocolVersion: 2 })).toEqual({
      compatible: false,
      data: { protocolVersion: 2, gitVersion: 'unknown', platform: 'unknown', node: 'unknown' },
    });
    expect(checkHandshake(null).compatible).toBe(false);
  });

  it('TC-F2-I02 git.show and git.ls narrows drop unusable input', () => {
    expect(asGitShow({ rev: 'origin/main', path: 'a.md', content: '', bytes: 0 })).toEqual({
      rev: 'origin/main',
      path: 'a.md',
      content: '',
      bytes: 0,
    });
    expect(asGitShow({ rev: 'origin/main', path: 'a.md' })).toBeNull();

    const ls = asGitLs({
      rev: 'origin/main',
      dir: 'inbox',
      entries: [
        { path: 'inbox/a.md', type: 'blob', sha: 'abc', size: 3 },
        { path: '', type: 'blob', sha: 'abc' },
        'garbage',
        { path: 'inbox/sub', type: 'tree', sha: 'def' },
      ],
    });
    expect(ls?.entries).toEqual([
      { path: 'inbox/a.md', type: 'blob', sha: 'abc', size: 3 },
      { path: 'inbox/sub', type: 'tree', sha: 'def', size: 0 },
    ]);
  });

  it('TC-F2-I02 companion failures map onto the extension error vocabulary', () => {
    expect(nativeCodeToErrorCode('notFound')).toBe('notFound');
    expect(nativeCodeToErrorCode('nonFastForward')).toBe('conflict');
    expect(nativeCodeToErrorCode('pathOutsideRoot')).toBe('auth');
    expect(nativeCodeToErrorCode('gitFailed')).toBe('gitFailed');
    expect(nativeCodeToErrorCode('gitMissing')).toBe('notConfigured');
    expect(nativeCodeToErrorCode('timeout')).toBe('timeout');
    expect(nativeCodeToErrorCode('badRequest')).toBe('validation');
    expect(nativeCodeToErrorCode('internal')).toBe('nativeUnavailable');
  });
});
