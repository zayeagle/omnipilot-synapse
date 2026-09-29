import { describe, expect, it } from 'vitest';

import {
  LIMITS,
  MessageError,
  assertRequestAllowed,
  errorKeyFor,
  fail,
  isAcceptableEndpoint,
  isContentScriptAllowed,
  isExtensionPageSender,
  isExtensionRequest,
  isExtensionResponse,
  ok,
  requiresExtensionPageSender,
  validateCaptureRequest,
  validateDistillRequest,
  validateGithubSettings,
  validateLimit,
  validatePassphrase,
  validateProviderSettings,
  validateSecuritySettings,
} from './messages';

const PAGE_SENDER = { tab: { url: 'https://evil.test/' }, url: 'https://evil.test/' };
const EXTENSION_SENDER = { url: 'chrome-extension://abcdefghijklmnop/popup.html' };
const OPTIONS_SENDER = { url: 'moz-extension://abc/options.html' };

describe('request gating (F4 UNIT)', () => {
  it('TC-F4-U07 recognises known request types only', () => {
    expect(isExtensionRequest({ type: 'capture.request' })).toBe(true);
    expect(isExtensionRequest({ type: 'settings.github' })).toBe(true);
    expect(isExtensionRequest({ type: 'admin.nuke' })).toBe(false);
    expect(isExtensionRequest({})).toBe(false);
    expect(isExtensionRequest(null)).toBe(false);
    expect(isExtensionRequest('capture.request')).toBe(false);
  });

  it('TC-F4-U07 identifies an extension page sender', () => {
    expect(isExtensionPageSender(EXTENSION_SENDER)).toBe(true);
    expect(isExtensionPageSender(OPTIONS_SENDER)).toBe(true);
    expect(isExtensionPageSender(undefined)).toBe(true);
    expect(isExtensionPageSender({})).toBe(true);
    expect(isExtensionPageSender(PAGE_SENDER)).toBe(false);
    expect(isExtensionPageSender({ tab: { url: 'https://evil.test' } })).toBe(false);
  });

  it('TC-F4-U07 lets a page context send only public preferences and a capture', () => {
    expect(isContentScriptAllowed('prefs.get')).toBe(true);
    expect(isContentScriptAllowed('capture.request')).toBe(true);
    expect(isContentScriptAllowed('inbox.list')).toBe(false);
    expect(isContentScriptAllowed('settings.github')).toBe(false);
    expect(assertRequestAllowed({ type: 'prefs.get' }, PAGE_SENDER)).toBe('prefs.get');
    expect(assertRequestAllowed({ type: 'capture.request' }, PAGE_SENDER)).toBe('capture.request');
  });

  it('TC-F4-U07 rejects credential-touching requests from a page context', () => {
    for (const type of [
      'settings.github',
      'settings.provider',
      'settings.export',
      'settings.reset',
      'vault.setup',
      'vault.unlock',
      'vault.lock',
      'store.probe',
      'distill.request',
    ] as const) {
      expect(requiresExtensionPageSender(type)).toBe(true);
      expect(() => assertRequestAllowed({ type }, PAGE_SENDER)).toThrow(MessageError);
    }
  });

  it('TC-F4-U07 also rejects non-allow-listed read requests from a page context', () => {
    expect(() => assertRequestAllowed({ type: 'inbox.list' }, PAGE_SENDER)).toThrow(/not allowed/u);
    expect(() => assertRequestAllowed({ type: 'ai.ledger' }, PAGE_SENDER)).toThrow(MessageError);
  });

  it('TC-F4-U07 allows everything from an extension page and rejects unknown types', () => {
    expect(assertRequestAllowed({ type: 'vault.unlock' }, EXTENSION_SENDER)).toBe('vault.unlock');
    expect(assertRequestAllowed({ type: 'settings.reset' }, undefined)).toBe('settings.reset');
    expect(() => assertRequestAllowed({ type: 'nope' }, EXTENSION_SENDER)).toThrow(MessageError);
    try {
      assertRequestAllowed({ type: 'nope' }, EXTENSION_SENDER);
    } catch (error) {
      expect((error as MessageError).code).toBe('validation');
    }
  });
});

describe('response helpers (F4 UNIT)', () => {
  it('TC-F4-U07 builds and detects responses', () => {
    expect(ok({ a: 1 })).toEqual({ ok: true, data: { a: 1 } });
    expect(fail('nope', 'auth')).toEqual({ ok: false, error: 'nope', code: 'auth' });
    expect(isExtensionResponse(ok(1))).toBe(true);
    expect(isExtensionResponse(fail('x'))).toBe(true);
    expect(isExtensionResponse({ nope: true })).toBe(false);
    expect(errorKeyFor('publicRepo')).toBe('error.publicRepo');
  });
});

describe('capture validation (F4 UNIT)', () => {
  const valid = { mode: 'page', url: 'https://example.com', title: 'T', body: 'body' };

  it('TC-F4-U07 accepts a well-formed page capture', () => {
    expect(validateCaptureRequest(valid)).toEqual(valid);
  });

  it('TC-F4-U07 rejects malformed captures', () => {
    expect(() => validateCaptureRequest(null)).toThrow(MessageError);
    expect(() => validateCaptureRequest({ ...valid, mode: 'psychic' })).toThrow(/mode/u);
    expect(() => validateCaptureRequest({ ...valid, url: 42 })).toThrow(/url/u);
    expect(() => validateCaptureRequest({ ...valid, url: '' })).toThrow(/url/u);
    expect(() => validateCaptureRequest({ ...valid, url: 'x'.repeat(LIMITS.urlChars + 1) })).toThrow(
      /url/u,
    );
    expect(() => validateCaptureRequest({ ...valid, body: 'x'.repeat(LIMITS.bodyChars + 1) })).toThrow(
      /body/u,
    );
  });

  it('TC-F4-U07 requires a selection for a selection capture', () => {
    expect(() => validateCaptureRequest({ mode: 'selection', url: 'u', title: 't' })).toThrow(
      /selection/u,
    );
    expect(() => validateCaptureRequest({ mode: 'selection', url: 'u', title: 't', selection: '' })).toThrow(
      /selection/u,
    );
    expect(
      validateCaptureRequest({ mode: 'selection', url: 'u', title: 't', selection: 'quoted text' }),
    ).toMatchObject({ mode: 'selection', selection: 'quoted text' });
  });

  it('TC-F4-U07 allows an empty title but drops empty optional strings to undefined', () => {
    const parsed = validateCaptureRequest({ ...valid, title: '', byline: '', lang: '' });
    expect(parsed.title).toBe('');
    expect(parsed.byline).toBe('');
    expect(parsed.lang).toBe('');
  });
});

describe('settings validation (F4 UNIT)', () => {
  it('TC-F4-U07 validates a passphrase payload', () => {
    expect(validatePassphrase({ passphrase: 'correct horse' })).toBe('correct horse');
    expect(() => validatePassphrase({})).toThrow(/passphrase/u);
    expect(() => validatePassphrase({ passphrase: 'x'.repeat(LIMITS.passphraseChars + 1) })).toThrow(
      /passphrase/u,
    );
  });

  it('TC-F4-U07 validates provider settings and endpoint safety', () => {
    expect(
      validateProviderSettings({ providerId: 'deepseek', model: 'deepseek-chat' }),
    ).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' });
    expect(
      validateProviderSettings({
        providerId: 'custom',
        model: 'm',
        baseUrl: 'https://llm.internal/v1',
        trustAcknowledged: true,
      }),
    ).toMatchObject({ baseUrl: 'https://llm.internal/v1', trustAcknowledged: true });

    expect(() => validateProviderSettings({ providerId: 'x', model: 'm', baseUrl: 'http://llm.test/v1' })).toThrow(
      /https/u,
    );
    expect(() => validateProviderSettings({ providerId: 'x', model: 'm', baseUrl: 'not a url' })).toThrow(
      MessageError,
    );
    expect(() =>
      validateProviderSettings({ providerId: 'x', model: 'm', baseUrl: 'https://a', trustAcknowledged: 'yes' }),
    ).toThrow(/boolean/u);
    expect(() => validateProviderSettings({ providerId: '', model: 'm' })).toThrow(/providerId/u);
  });

  it('TC-F4-U07 accepts loopback endpoints for local stubs', () => {
    expect(isAcceptableEndpoint('https://api.github.com')).toBe(true);
    expect(isAcceptableEndpoint('http://127.0.0.1:8080')).toBe(true);
    expect(isAcceptableEndpoint('http://localhost:3000')).toBe(true);
    expect(isAcceptableEndpoint('http://api.github.com')).toBe(false);
    expect(isAcceptableEndpoint('ftp://api.github.com')).toBe(false);
    expect(isAcceptableEndpoint('javascript:alert(1)')).toBe(false);
  });

  it('TC-F4-U07 validates GitHub settings and rejects traversal in the path prefix', () => {
    expect(
      validateGithubSettings({ owner: 'zayeagle', repo: 'omnipilot-synapse', branch: 'main' }),
    ).toEqual({ owner: 'zayeagle', repo: 'omnipilot-synapse', branch: 'main' });

    expect(() => validateGithubSettings({ owner: 'a b', repo: 'r', branch: 'main' })).toThrow(/whitespace/u);
    expect(() => validateGithubSettings({ owner: 'o', repo: 'r/x', branch: 'main' })).toThrow(/slashes/u);
    expect(() =>
      validateGithubSettings({ owner: 'o', repo: 'r', branch: 'main', pathPrefix: '../../etc' }),
    ).toThrow(/"\.\." segments/u);
    expect(
      validateGithubSettings({ owner: 'o', repo: 'r', branch: 'main', pathPrefix: '/notes/2026/' })
        .pathPrefix,
    ).toBe('/notes/2026/');
  });

  it('TC-F4-U07 validates and clamps security settings', () => {
    expect(validateSecuritySettings({})).toEqual({});
    expect(
      validateSecuritySettings({ enabled: false, aiAuthorized: true, securityMode: 'transparent', autoLockMinutes: 15 }),
    ).toEqual({ enabled: false, aiAuthorized: true, securityMode: 'transparent', autoLockMinutes: 15 });
    expect(validateSecuritySettings({ autoLockMinutes: 10_000 }).autoLockMinutes).toBe(720);
    expect(validateSecuritySettings({ autoLockMinutes: 0.2 }).autoLockMinutes).toBe(1);
    expect(() => validateSecuritySettings({ securityMode: 'plain' })).toThrow(/securityMode/u);
    expect(() => validateSecuritySettings({ autoLockMinutes: -3 })).toThrow(/autoLockMinutes/u);
    expect(() => validateSecuritySettings({ enabled: 'yes' })).toThrow(/enabled/u);
    // F5: the auth mode is a security choice, so it rides on this payload rather than a second message.
    expect(validateSecuritySettings({ authMode: 'ssh' })).toEqual({ authMode: 'ssh' });
    expect(() => validateSecuritySettings({ authMode: 'kerberos' })).toThrow(/authMode/u);
  });

  it('TC-F4-U07 validates a distill request and list limits', () => {
    expect(validateDistillRequest({ sourceId: 'abcd1234', sourcePath: 'inbox/2026/07/x.md' })).toEqual({
      sourceId: 'abcd1234',
      sourcePath: 'inbox/2026/07/x.md',
    });
    expect(() => validateDistillRequest({ sourceId: 'abcd1234' })).toThrow(/sourcePath/u);
    expect(validateLimit(undefined, 5, LIMITS.inboxLimit)).toBe(5);
    expect(validateLimit({ limit: 3 }, 5, LIMITS.inboxLimit)).toBe(3);
    expect(validateLimit({ limit: 9999 }, 5, LIMITS.inboxLimit)).toBe(LIMITS.inboxLimit);
    expect(() => validateLimit({ limit: 0 }, 5, 10)).toThrow(/limit/u);
  });
});
