import { describe, expect, it, vi } from 'vitest';

import { MessageRouter, createRouterOptions, errorCodeOf, limiterKeyFor } from './router';
import { MessageError, ok, type ExtensionRequest } from '../messages';
import { VaultLockedError } from '../security/key-session';
import { WrongPassphraseError } from '../security/crypto-key';
import { KeyedRateLimiter } from '../security/rate-limit';
import {
  AuthError,
  ConflictError,
  NotFoundError,
  PublicRepoError,
  RateLimitError,
  ScopeError,
  TimeoutError,
  classifyHttpStatus,
} from '../store/errors';

const PAGE = { tab: { id: 7, url: 'https://evil.test/' }, url: 'https://evil.test/' };
const OPTIONS = { url: 'chrome-extension://abc/options.html' };

function makeRouter(handlers: Parameters<typeof createRouterOptions>[0], secrets: string[] = []) {
  return new MessageRouter(
    createRouterOptions(handlers, {
      secrets: async () => secrets,
      logger: () => undefined,
    }),
  );
}

describe('message router boundary (F4 INT)', () => {
  it('TC-F4-I01 rejects credential requests from a content-script sender before the handler runs', async () => {
    const setGithub = vi.fn(async () => ok({ saved: true }));
    const distill = vi.fn(async () => ok({ distilled: true }));
    const router = makeRouter({ 'settings.github': setGithub, 'distill.request': distill });

    const githubResponse = await router.handle(
      { type: 'settings.github', payload: { owner: 'o', repo: 'r', branch: 'main' } },
      PAGE,
    );
    const distillResponse = await router.handle(
      { type: 'distill.request', payload: { sourceId: 's1', sourcePath: 'p' } },
      PAGE,
    );

    expect(githubResponse.ok).toBe(false);
    expect(distillResponse.ok).toBe(false);
    // The whole point: no handler side effect, no credential touched, no fetch attempted.
    expect(setGithub).not.toHaveBeenCalled();
    expect(distill).not.toHaveBeenCalled();
  });

  it('TC-F4-I01 allows the two page-context requests the content script needs', async () => {
    const prefs = vi.fn(async () => ok({ enabled: true }));
    const capture = vi.fn(async () => ok({ path: 'inbox/2026/07/x.md' }));
    const router = makeRouter({ 'prefs.get': prefs, 'capture.request': capture });

    expect((await router.handle({ type: 'prefs.get' }, PAGE)).ok).toBe(true);
    expect(
      (
        await router.handle(
          { type: 'capture.request', payload: { mode: 'page', url: 'https://a.test', title: 'T' } },
          PAGE,
        )
      ).ok,
    ).toBe(true);
    expect(prefs).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('TC-F4-I01 lets an extension page reach every handler', async () => {
    const reset = vi.fn(async () => ok({ reset: true }));
    const router = makeRouter({ 'settings.reset': reset });
    expect((await router.handle({ type: 'settings.reset' }, OPTIONS)).ok).toBe(true);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('TC-F4-I01 reports unknown and unregistered requests without running anything', async () => {
    const router = makeRouter({});
    const unknown = await router.handle({ type: 'admin.nuke' }, OPTIONS);
    expect(unknown).toEqual({ ok: false, error: 'unknown request type', code: 'validation' });

    const unregistered = await router.handle({ type: 'inbox.list' }, OPTIONS);
    expect(unregistered.ok).toBe(false);
    expect(unregistered.ok === false && unregistered.code).toBe('validation');
    expect(unregistered.ok === false && unregistered.error).toContain('inbox.list');
  });

  it('TC-F4-I01 maps domain errors onto protocol error codes', async () => {
    const router = makeRouter({
      'vault.unlock': async () => {
        throw new WrongPassphraseError();
      },
      'inbox.list': async () => {
        throw new VaultLockedError();
      },
      'status.get': async () => {
        throw new MessageError('bad payload', 'validation');
      },
      'ai.ledger': async () => {
        throw new Error('plain boom');
      },
    });

    const wrongPass = await router.handle({ type: 'vault.unlock', payload: { passphrase: 'x' } }, OPTIONS);
    expect(wrongPass.ok === false && wrongPass.code).toBe('wrongPassphrase');

    const locked = await router.handle({ type: 'inbox.list' }, OPTIONS);
    expect(locked.ok === false && locked.code).toBe('locked');

    const validation = await router.handle({ type: 'status.get' }, OPTIONS);
    expect(validation.ok === false && validation.code).toBe('validation');

    const unknown = await router.handle({ type: 'ai.ledger' }, OPTIONS);
    expect(unknown.ok === false && unknown.code).toBe('unknown');
  });

  it('TC-F4-I01 scrubs secrets out of surfaced handler failures', async () => {
    const secret = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop';
    const router = makeRouter(
      {
        'store.probe': async () => {
          throw new Error(`401 Unauthorized for ${secret}`);
        },
      },
      [secret],
    );
    const response = await router.handle({ type: 'store.probe' }, OPTIONS);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.error).not.toContain(secret);
    expect(response.ok === false && response.error).toContain('[REDACTED]');
  });

  it('TC-F4-I01 rate limits per tab and recovers', async () => {
    let clock = 0;
    const limiter = () => new KeyedRateLimiter({ perKeyMax: 2, globalMax: 100, windowMs: 60_000, now: () => clock });
    const router = new MessageRouter(
      createRouterOptions(
        { 'settings.reset': async () => ok({}) },
        { limiters: { ai: limiter(), github: limiter(), vault: limiter() } },
      ),
    );

    expect((await router.handle({ type: 'settings.reset' }, OPTIONS)).ok).toBe(true);
    expect((await router.handle({ type: 'settings.reset' }, OPTIONS)).ok).toBe(true);
    const blocked = await router.handle({ type: 'settings.reset' }, OPTIONS);
    expect(blocked.ok === false && blocked.code).toBe('rateLimited');
    expect(blocked.ok === false && blocked.error).toContain('retry in 60s');

    clock = 60_000;
    expect((await router.handle({ type: 'settings.reset' }, OPTIONS)).ok).toBe(true);
  });

  it('TC-F4-I01 budgets requests per traffic class', () => {
    expect(limiterKeyFor('distill.request')).toBe('ai');
    expect(limiterKeyFor('capture.request')).toBe('github');
    expect(limiterKeyFor('store.probe')).toBe('github');
    expect(limiterKeyFor('vault.unlock')).toBe('vault');
    expect(limiterKeyFor('settings.github')).toBe('vault');
  });

  it('TC-F4-I01 classifies declared error codes and store errors', () => {
    const named = (name: string) => Object.assign(new Error('x'), { name });
    // No declared code → fall back to the error name for the two special cases.
    expect(errorCodeOf(named('EmptyResponseError'))).toBe('emptyResponse');
    expect(errorCodeOf(named('DistillParseError'))).toBe('badJson');
    expect(errorCodeOf(named('CkfError'))).toBe('parse');
    expect(errorCodeOf(named('Whatever'))).toBe('unknown');
    expect(errorCodeOf(null)).toBe('unknown');
    expect(errorCodeOf(undefined)).toBe('unknown');

    // Classified errors declare their own protocol code.
    expect(errorCodeOf(new AuthError())).toBe('auth');
    expect(errorCodeOf(new ScopeError())).toBe('scope');
    expect(errorCodeOf(new NotFoundError())).toBe('notFound');
    expect(errorCodeOf(new ConflictError())).toBe('conflict');
    expect(errorCodeOf(new PublicRepoError())).toBe('publicRepo');
    expect(errorCodeOf(new TimeoutError())).toBe('timeout');
    expect(errorCodeOf(new RateLimitError(1000))).toBe('rateLimited');
    expect(errorCodeOf(classifyHttpStatus(401))).toBe('auth');
    expect(errorCodeOf(classifyHttpStatus(403))).toBe('scope');
    expect(errorCodeOf(classifyHttpStatus(503))).toBe('network');
  });
});
