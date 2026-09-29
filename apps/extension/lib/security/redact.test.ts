import { describe, expect, it } from 'vitest';

import { MAX_ERROR_LENGTH, REDACTED, collectSecrets, scrub, scrubError } from './redact';

describe('scrub (F4 UNIT)', () => {
  it('TC-F4-U03 replaces every occurrence of a configured secret', () => {
    const pat = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop';
    const message = `401 from api.github.com: bad credentials for ${pat} (token ${pat})`;
    const scrubbed = scrub(message, [pat]);
    expect(scrubbed).not.toContain(pat);
    expect(scrubbed).toContain(REDACTED);
    expect(scrubbed.match(/\[REDACTED\]/gu)).toHaveLength(2);
  });

  it('TC-F4-U03 removes the longest secret first so fragments cannot survive', () => {
    const short = 'sk-abcdef123456';
    const long = 'sk-abcdef123456-more-suffix';
    const scrubbed = scrub(`value=${long}`, [short, long]);
    expect(scrubbed).toBe(`value=${REDACTED}`);
  });

  it('TC-F4-U03 ignores candidate secrets that are too short to be real', () => {
    expect(scrub('abc de f', ['abc'])).toBe('abc de f');
    expect(collectSecrets({ githubPat: 'abc', providerKey: 'long-enough-key' })).toEqual([
      'long-enough-key',
    ]);
  });

  it('TC-F4-U04 redacts credential shapes that were never configured', () => {
    expect(scrub('body {"key":"sk-abc"}')).toBe(`body {"key":"${REDACTED}"}`);
    expect(scrub('saw ghp_abc in the log')).toBe(`saw ${REDACTED} in the log`);
    expect(scrub('github_pat_abc leaked')).toBe(`${REDACTED} leaked`);
    expect(scrub('Authorization: Bearer abcdefghijklmnop')).toBe(`Authorization: ${REDACTED}`);
    expect(scrub('x-api-key: abcdefghijklmnop')).toBe(`${REDACTED}`);
  });

  it('TC-F4-U04 leaves ordinary text untouched', () => {
    const text = 'The model returned an empty response; see the task description.';
    expect(scrub(text, ['some-configured-secret'])).toBe(text);
  });

  it('TC-F4-U04 collects, dedupes and orders configured secrets', () => {
    const secrets = collectSecrets({
      githubPat: 'pat-value-123456',
      providerKey: 'key-value-12345678',
      passphrase: 'a-very-long-passphrase',
      extra: ['key-value-12345678', null, undefined, 'x'],
    });
    expect(secrets).toEqual(['a-very-long-passphrase', 'key-value-12345678', 'pat-value-123456']);
  });
});

describe('scrubError (F4 UNIT)', () => {
  it('TC-F4-U04 extracts, scrubs and normalises an Error message', () => {
    const error = new Error(`fetch failed for ghp_abcdefghijklmnop\n  at somewhere`);
    expect(scrubError(error)).toBe(`fetch failed for ${REDACTED} at somewhere`);
  });

  it('TC-F4-U04 handles non-Error throwables', () => {
    expect(scrubError('plain string failure')).toBe('plain string failure');
    expect(scrubError({ message: 'object failure' })).toBe('object failure');
    expect(scrubError({ nope: true })).toBe('{"nope":true}');
    expect(scrubError(null)).toBe('null');
    expect(scrubError(undefined)).toBe('undefined');
  });

  it('TC-F4-U04 caps the reported length', () => {
    const scrubbed = scrubError('x'.repeat(5000));
    expect(scrubbed.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH + 1);
    expect(scrubbed.endsWith('…')).toBe(true);
  });

  it('TC-F4-U04 survives a circular object', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => scrubError(circular)).not.toThrow();
  });
});
