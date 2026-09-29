/**
 * F5 integration: the *catalog* drives the *client*, and the trust rule agrees with both.
 *
 * The unit tests check one provider each; this file proves the whole chain holds for every row of
 * blueprint §5 — the same table the options page renders, the same table the worker resolves stored
 * settings against — with the network stubbed out.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { ANTHROPIC_VERSION, chat, type FetchLike, type FetchRequestInitLike } from './ai-client';
import {
  PROVIDERS,
  inferProviderId,
  isValidBaseUrl,
  providerById,
  requiresTrustAck,
  resolveProvider,
  type AuthStyle,
  type ProviderId,
} from './providers';

const API_KEY = 'integration-provider-key-1234567890';
const CUSTOM_BASE = 'https://my-llm.example.com/v1';
const USER_MESSAGE = { role: 'user', content: 'Distill this note' } as const;

/** Blueprint §5, transcribed: endpoint, auth style and default model per provider id. */
const EXPECTED: Record<ProviderId, { baseUrl: string; authStyle: AuthStyle; defaultModel: string }> =
  {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      authStyle: 'bearer',
      defaultModel: 'gpt-4o-mini',
    },
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      authStyle: 'bearer',
      defaultModel: 'deepseek-chat',
    },
    anthropic: {
      baseUrl: 'https://api.anthropic.com/v1',
      authStyle: 'anthropic',
      defaultModel: 'claude-3-5-haiku-latest',
    },
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      authStyle: 'bearer',
      defaultModel: 'openai/gpt-4o-mini',
    },
    iflytek: {
      baseUrl: 'https://spark-api-open.xf-yun.com/v1',
      authStyle: 'bearer',
      defaultModel: 'generalv3.5',
    },
    custom: { baseUrl: '', authStyle: 'bearer', defaultModel: '' },
  };

const OPENAI_FIXTURE = {
  choices: [{ message: { role: 'assistant', content: 'Hello from the model' } }],
};
const ANTHROPIC_FIXTURE = {
  content: [{ type: 'text', text: 'Hello from Claude' }],
};

function headerOf(init: FetchRequestInitLike, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function stubFor(authStyle: AuthStyle): FetchLike {
  const fixture = authStyle === 'anthropic' ? ANTHROPIC_FIXTURE : OPENAI_FIXTURE;
  return async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify(fixture),
  });
}

function callOf(stub: Mock<FetchLike>): [string, FetchRequestInitLike] {
  const call = stub.mock.calls[0];
  if (!call) throw new Error('fetch was never called');
  return call;
}

describe('provider catalog → client → trust rule (F5 INT)', () => {
  it('TC-F5-I01 ships exactly the six blueprint providers with their documented endpoints', () => {
    expect(PROVIDERS.map((spec) => spec.id)).toEqual([
      'openai',
      'deepseek',
      'anthropic',
      'openrouter',
      'iflytek',
      'custom',
    ]);
    for (const spec of PROVIDERS) {
      const expected = EXPECTED[spec.id];
      expect(spec.baseUrl, spec.id).toBe(expected.baseUrl);
      expect(spec.authStyle, spec.id).toBe(expected.authStyle);
      expect(spec.defaultModel, spec.id).toBe(expected.defaultModel);
      expect(spec.label.length, spec.id).toBeGreaterThan(0);
      expect(Array.isArray(spec.models), spec.id).toBe(true);
      // A catalog provider's model list must offer its own default, or the UI could not preselect it.
      if (spec.defaultModel.length > 0) expect(spec.models, spec.id).toContain(spec.defaultModel);
      expect(resolveProvider(spec.id).label, spec.id).toBe(spec.label);
      expect(providerById[spec.id].id, spec.id).toBe(spec.id);
    }
  });

  it('TC-F5-I01 drives every provider through chat() with the stubbed fetch', async () => {
    for (const spec of PROVIDERS) {
      const anthropic = spec.authStyle === 'anthropic';
      const stub = vi.fn<FetchLike>(stubFor(spec.authStyle));
      const baseUrl = spec.id === 'custom' ? CUSTOM_BASE : spec.baseUrl;
      const model = spec.id === 'custom' ? 'my-model' : undefined;

      const result = await chat({
        fetchImpl: stub,
        providerId: spec.id,
        apiKey: API_KEY,
        ...(model === undefined ? {} : { model }),
        ...(spec.id === 'custom' ? { baseUrl } : {}),
        messages: [{ role: 'system', content: 'Be terse.' }, USER_MESSAGE],
      });

      const [url, init] = callOf(stub);
      expect(url, spec.id).toBe(`${baseUrl}${anthropic ? '/messages' : '/chat/completions'}`);
      expect(init.method, spec.id).toBe('POST');
      expect(headerOf(init, 'content-type'), spec.id).toBe('application/json');

      if (anthropic) {
        expect(headerOf(init, 'x-api-key'), spec.id).toBe(API_KEY);
        expect(headerOf(init, 'anthropic-version'), spec.id).toBe(ANTHROPIC_VERSION);
        expect(headerOf(init, 'authorization'), spec.id).toBeUndefined();
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body['system'], spec.id).toBe('Be terse.');
        expect(body['messages'], spec.id).toEqual([USER_MESSAGE]);
      } else {
        expect(headerOf(init, 'authorization'), spec.id).toBe(`Bearer ${API_KEY}`);
        expect(headerOf(init, 'x-api-key'), spec.id).toBeUndefined();
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body['messages'], spec.id).toEqual([
          { role: 'system', content: 'Be terse.' },
          USER_MESSAGE,
        ]);
      }

      const expectedModel = model ?? spec.defaultModel;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body['model'], spec.id).toBe(expectedModel);
      expect(result.text, spec.id).toBe(
        anthropic ? 'Hello from Claude' : 'Hello from the model',
      );
      expect(result.provider, spec.id).toBe(spec.id);
      expect(result.model, spec.id).toBe(expectedModel);
      expect(stub, spec.id).toHaveBeenCalledTimes(1);
    }
  });

  it('TC-F5-I01 requires a trust ack for a custom host and not for a catalog host', () => {
    for (const spec of PROVIDERS) {
      if (spec.baseUrl.length === 0) continue;
      expect(isValidBaseUrl(spec.baseUrl), spec.id).toBe(true);
      expect(requiresTrustAck(spec.baseUrl), spec.id).toBe(false);
      expect(inferProviderId(spec.baseUrl), spec.id).toBe(spec.id);
    }

    expect(isValidBaseUrl(CUSTOM_BASE)).toBe(true);
    expect(requiresTrustAck(CUSTOM_BASE)).toBe(true);
    expect(inferProviderId(CUSTOM_BASE)).toBe('custom');
    // The trust rule follows the host, not the selected provider id.
    expect(requiresTrustAck('https://api.openai.com/v1')).toBe(false);
    expect(requiresTrustAck('https://api.openai.com.evil.test/v1')).toBe(true);
    // `custom` has no shipped endpoint at all, so a URL is mandatory before anything is sent.
    expect(PROVIDERS.find((spec) => spec.id === 'custom')?.baseUrl).toBe('');
    expect(providerById.custom.requiresTrustAck).toBe(true);
  });

  it('TC-F5-I01 routes a catalog provider at a custom host to that host, still bearer', async () => {
    const stub = vi.fn<FetchLike>(stubFor('bearer'));
    const result = await chat({
      fetchImpl: stub,
      providerId: 'openai',
      apiKey: API_KEY,
      baseUrl: `${CUSTOM_BASE}/`,
      model: 'openai/gpt-4o-mini',
      messages: [USER_MESSAGE],
    });

    const [url, init] = callOf(stub);
    expect(url).toBe('https://my-llm.example.com/v1/chat/completions');
    expect(headerOf(init, 'authorization')).toBe(`Bearer ${API_KEY}`);
    expect(result.text).toBe('Hello from the model');
    expect(requiresTrustAck(url)).toBe(true);
  });
});
