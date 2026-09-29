import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  ANTHROPIC_VERSION,
  AiAuthError,
  AiError,
  AiNetworkError,
  AiTimeoutError,
  AiValidationError,
  DEFAULT_TIMEOUT_MS,
  chat,
  isAiError,
  type FetchLike,
  type FetchRequestInitLike,
  type FetchResponseLike,
} from './ai-client';
import { BadJsonError, EmptyResponseError } from './ai-parse';
import { errorKeyFor } from './messages';
import { t } from './i18n';

const API_KEY = 'my-custom-provider-key-9876543210';
const USER_MESSAGE = { role: 'user', content: 'Say hi' } as const;

const OPENAI_FIXTURE = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello from the model' },
      finish_reason: 'stop',
    },
  ],
};

const ANTHROPIC_FIXTURE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'Hello from Claude' }],
  stop_reason: 'end_turn',
};

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

function textResponse(body: string, status: number): FetchResponseLike {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

/** Queued responses: an `Error` value is thrown instead of returned. */
function respondWith(...responses: Array<FetchResponseLike | Error>): Mock<FetchLike> {
  const stub = vi.fn<FetchLike>();
  for (const response of responses) {
    if (response instanceof Error) stub.mockRejectedValueOnce(response);
    else stub.mockResolvedValueOnce(response);
  }
  return stub;
}

/** HTTP header names are case-insensitive; the client may send either casing. */
function headerOf(init: FetchRequestInitLike, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function bodyOf(init: FetchRequestInitLike): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function firstCall(stub: Mock<FetchLike>): [string, FetchRequestInitLike] {
  const call = stub.mock.calls[0];
  if (!call) throw new Error('fetch was never called');
  return call;
}

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

/** A fetch that never resolves until it is aborted — the timeout/abort probe. */
function hangingFetch(seen: AbortSignal[] = []): Mock<FetchLike> {
  return vi.fn<FetchLike>(
    (_url, init) =>
      new Promise<never>((_resolve, reject) => {
        const signal = init.signal;
        if (signal) seen.push(signal);
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('chat over the bearer path (F5 UNIT)', () => {
  it('TC-F5-U01 posts an OpenAI-shaped request and extracts the reply', async () => {
    const stub = respondWith(jsonResponse(OPENAI_FIXTURE));

    const result = await chat({
      fetchImpl: stub,
      providerId: 'openai',
      apiKey: API_KEY,
      messages: [{ role: 'system', content: 'Be terse.' }, USER_MESSAGE],
    });

    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = firstCall(stub);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(headerOf(init, 'authorization')).toBe(`Bearer ${API_KEY}`);
    expect(headerOf(init, 'content-type')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(bodyOf(init)).toEqual({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      stream: false,
      messages: [{ role: 'system', content: 'Be terse.' }, USER_MESSAGE],
    });

    expect(result.text).toBe('Hello from the model');
    expect(result.raw).toEqual(OPENAI_FIXTURE);
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o-mini');
  });

  it('TC-F5-U01 honours an explicit base URL/model and otherwise uses the catalog defaults', async () => {
    const stub = respondWith(jsonResponse(OPENAI_FIXTURE), jsonResponse(OPENAI_FIXTURE));

    const overridden = await chat({
      fetchImpl: stub,
      providerId: 'deepseek',
      apiKey: API_KEY,
      baseUrl: 'https://api.deepseek.com/v1/',
      model: 'deepseek-reasoner',
      messages: [USER_MESSAGE],
    });
    expect(firstCall(stub)[0]).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(overridden.model).toBe('deepseek-reasoner');
    expect(overridden.provider).toBe('deepseek');

    const defaults = await chat({
      fetchImpl: stub,
      provider: 'openrouter',
      apiKey: API_KEY,
      messages: [USER_MESSAGE],
    });
    expect(stub.mock.calls[1]?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(defaults.model).toBe('openai/gpt-4o-mini');
  });

  it('TC-F5-U01 accepts a pasted full endpoint instead of a base URL', async () => {
    const stub = respondWith(jsonResponse(OPENAI_FIXTURE));
    await chat({
      fetchImpl: stub,
      providerId: 'custom',
      apiKey: API_KEY,
      baseUrl: 'https://my-proxy.example.com/v1/chat/completions',
      model: 'local-model',
      messages: [USER_MESSAGE],
    });
    expect(firstCall(stub)[0]).toBe('https://my-proxy.example.com/v1/chat/completions');
  });
});

describe('chat over the anthropic path (F5 UNIT)', () => {
  it('TC-F5-U02 posts a Messages request with the system prompt hoisted out of messages', async () => {
    const stub = respondWith(jsonResponse(ANTHROPIC_FIXTURE));

    const result = await chat({
      fetchImpl: stub,
      providerId: 'anthropic',
      apiKey: API_KEY,
      messages: [{ role: 'system', content: 'Be terse.' }, USER_MESSAGE],
    });

    const [url, init] = firstCall(stub);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(headerOf(init, 'x-api-key')).toBe(API_KEY);
    expect(headerOf(init, 'anthropic-version')).toBe(ANTHROPIC_VERSION);
    expect(ANTHROPIC_VERSION).toBe('2023-06-01');
    expect(headerOf(init, 'authorization')).toBeUndefined();

    const body = bodyOf(init);
    expect(body['model']).toBe('claude-3-5-haiku-latest');
    expect(body['system']).toBe('Be terse.');
    expect(body['messages']).toEqual([USER_MESSAGE]);
    expect(body['temperature']).toBe(0.2);
    expect(body['max_tokens']).toBeGreaterThan(0);

    expect(result.text).toBe('Hello from Claude');
    expect(result.provider).toBe('anthropic');
  });

  it('TC-F5-U02 omits the system field when no system message was given', async () => {
    const stub = respondWith(jsonResponse(ANTHROPIC_FIXTURE));
    await chat({
      fetchImpl: stub,
      providerId: 'anthropic',
      apiKey: API_KEY,
      messages: [USER_MESSAGE],
    });
    expect('system' in bodyOf(firstCall(stub)[1])).toBe(false);
  });

  it('TC-F5-U02 refuses a system-only conversation before spending a request', async () => {
    const stub = respondWith(jsonResponse(ANTHROPIC_FIXTURE));
    const error = await rejectionOf(
      chat({
        fetchImpl: stub,
        providerId: 'anthropic',
        apiKey: API_KEY,
        messages: [{ role: 'system', content: 'You are a knowledge distiller.' }],
      }),
    );
    expect(error).toBeInstanceOf(AiValidationError);
    expect(stub).not.toHaveBeenCalled();
  });
});

describe('chat failure classification (F5 UNIT)', () => {
  it('TC-F5-U05 surfaces an empty provider reply as EmptyResponseError', async () => {
    const stub = respondWith(jsonResponse({ choices: [] }));
    const error = await rejectionOf(
      chat({ fetchImpl: stub, providerId: 'openai', apiKey: API_KEY, messages: [USER_MESSAGE] }),
    );
    expect(error).toBeInstanceOf(EmptyResponseError);
    expect(isAiError(error)).toBe(true);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('TC-F5-U05 classifies an HTML 200 body as badJson instead of storing it', async () => {
    const stub = respondWith(textResponse('<html><body>proxy error</body></html>', 200));
    const error = await rejectionOf(
      chat({ fetchImpl: stub, providerId: 'openai', apiKey: API_KEY, messages: [USER_MESSAGE] }),
    );
    expect(error).toBeInstanceOf(BadJsonError);
    expect((error as BadJsonError).code).toBe('badJson');
  });

  it('TC-F5-U07 classifies a 401 whose body echoes the key, and never leaks the key', async () => {
    const stub = respondWith(
      textResponse(
        JSON.stringify({ error: { message: `Incorrect API key provided: ${API_KEY}` } }),
        401,
      ),
    );

    const error = await rejectionOf(
      chat({ fetchImpl: stub, providerId: 'openai', apiKey: API_KEY, messages: [USER_MESSAGE] }),
    );

    expect(error).toBeInstanceOf(AiAuthError);
    expect(error).toBeInstanceOf(AiError);
    const aiError = error as AiAuthError;
    expect(aiError.code).toBe('auth');
    expect(aiError.status).toBe(401);
    expect(aiError.retryable).toBe(false);
    expect(isAiError(aiError)).toBe(true);

    expect(aiError.message).not.toContain(API_KEY);
    expect(aiError.message).not.toMatch(/api key provided/iu);
    expect(String(aiError.hint)).not.toContain(API_KEY);
    // The provider's explanation is kept for the options page, but scrubbed.
    expect(String(aiError.hint)).toContain('[REDACTED]');
    // The UI translates the code, never the raw provider message (zh_CN: 凭据无效).
    expect(t(errorKeyFor(aiError.code), null, 'zh_CN')).toBe('凭据无效');
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('TC-F5-U07 scrubs a key echoed by a transport failure', async () => {
    const stub = respondWith(new Error(`connect ECONNREFUSED while sending key ${API_KEY}`));
    const error = await rejectionOf(
      chat({ fetchImpl: stub, providerId: 'openai', apiKey: API_KEY, messages: [USER_MESSAGE] }),
    );
    expect(error).toBeInstanceOf(AiNetworkError);
    const aiError = error as AiNetworkError;
    expect(aiError.code).toBe('network');
    expect(aiError.message).not.toContain(API_KEY);
    expect(aiError.message).toContain('[REDACTED]');
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

describe('chat timeouts and aborts (F5 UNIT)', () => {
  it('TC-F5-U06 aborts a hanging request at the 15 s timeout and reports it', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const stub = hangingFetch(signals);

    const promise = chat({
      fetchImpl: stub,
      providerId: 'openai',
      apiKey: API_KEY,
      messages: [USER_MESSAGE],
    });
    const settled = rejectionOf(promise);

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 1);
    const error = await settled;

    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
    expect(error).toBeInstanceOf(AiTimeoutError);
    const aiError = error as AiTimeoutError;
    expect(aiError.code).toBe('timeout');
    expect(aiError.retryable).toBe(false);
    expect(signals[0]?.aborted).toBe(true);
    // A timeout is not a 429/5xx, so it is never retried.
    expect(stub).toHaveBeenCalledTimes(1);
    // The user sees the translated code: zh_CN 请求超时，请重试.
    expect(t(errorKeyFor('timeout'), null, 'zh_CN')).toContain('请求超时');
  });

  it('TC-F5-U06 aborts on an injected timeout without waiting for the wall clock', async () => {
    const stub = hangingFetch();
    const error = await rejectionOf(
      chat({
        fetchImpl: stub,
        providerId: 'openai',
        apiKey: API_KEY,
        timeoutMs: 20,
        messages: [USER_MESSAGE],
      }),
    );
    expect(error).toBeInstanceOf(AiTimeoutError);
    expect((error as AiTimeoutError).code).toBe('timeout');
  });

  it('TC-F5-U06 reports a caller-initiated abort as a cancellation, not a success', async () => {
    const stub = hangingFetch();
    const controller = new AbortController();
    const promise = chat({
      fetchImpl: stub,
      providerId: 'openai',
      apiKey: API_KEY,
      messages: [USER_MESSAGE],
      signal: controller.signal,
    });
    controller.abort();

    const error = await rejectionOf(promise);
    expect(error).toBeInstanceOf(AiTimeoutError);
    expect((error as AiTimeoutError).message).toContain('cancelled');
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

describe('chat pre-flight validation (F5 UNIT)', () => {
  it('TC-F5-U08 refuses an invalid base URL without calling fetch', async () => {
    const stub = respondWith(jsonResponse(OPENAI_FIXTURE));
    const invalid = ['http://api.openai.com/v1', 'ftp://api.x.com', 'not a url'];

    for (const baseUrl of invalid) {
      const error = await rejectionOf(
        chat({
          fetchImpl: stub,
          providerId: 'openai',
          apiKey: API_KEY,
          baseUrl,
          messages: [USER_MESSAGE],
        }),
      );
      expect(error, baseUrl).toBeInstanceOf(AiValidationError);
      expect((error as AiValidationError).code).toBe('validation');
    }
    // Loopback http is a valid transport for a local bridge.
    const loopback = respondWith(jsonResponse(OPENAI_FIXTURE));
    await chat({
      fetchImpl: loopback,
      providerId: 'custom',
      apiKey: API_KEY,
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'local',
      messages: [USER_MESSAGE],
    });
    expect(firstCall(loopback)[0]).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(stub).not.toHaveBeenCalled();
  });

  it('TC-F5-U11 refuses missing credentials, model, URL and messages before any fetch', async () => {
    const cases: Array<Parameters<typeof chat>[0]> = [
      { fetchImpl: respondWith(), providerId: 'openai', messages: [USER_MESSAGE] },
      { fetchImpl: respondWith(), providerId: 'openai', apiKey: '   ', messages: [USER_MESSAGE] },
      { fetchImpl: respondWith(), providerId: 'custom', apiKey: API_KEY, model: 'm', messages: [USER_MESSAGE] },
      { fetchImpl: respondWith(), providerId: 'custom', apiKey: API_KEY, baseUrl: 'https://x.example.com/v1', messages: [USER_MESSAGE] },
      { fetchImpl: respondWith(), providerId: 'openai', apiKey: API_KEY, messages: [] },
      { fetchImpl: respondWith(), providerId: 'openai', apiKey: API_KEY, messages: [{ role: 'tool', content: 'x' } as never] },
      { fetchImpl: respondWith(), providerId: 'openai', apiKey: API_KEY, messages: [{ role: 'user', content: '' }] },
    ];

    for (const options of cases) {
      const error = await rejectionOf(chat(options));
      expect(error).toBeInstanceOf(AiValidationError);
      expect(options.fetchImpl as Mock<FetchLike>).not.toHaveBeenCalled();
    }
  });

  it('TC-F5-U11 falls back to the custom provider for an unknown stored id', async () => {
    const stub = respondWith(jsonResponse(OPENAI_FIXTURE));
    const result = await chat({
      fetchImpl: stub,
      providerId: 'no-such-provider',
      apiKey: API_KEY,
      baseUrl: 'https://my-proxy.example.com/v1',
      model: 'anything',
      messages: [USER_MESSAGE],
    });
    expect(result.provider).toBe('custom');
    expect(headerOf(firstCall(stub)[1], 'authorization')).toBe(`Bearer ${API_KEY}`);
  });
});

describe('chat retry policy (F5 UNIT)', () => {
  it('TC-F5-U10 retries once after a 5xx and returns the successful second response', async () => {
    const stub = respondWith(
      textResponse('{"error":{"message":"upstream exploded"}}', 503),
      jsonResponse(OPENAI_FIXTURE),
    );

    const result = await chat({
      fetchImpl: stub,
      providerId: 'openai',
      apiKey: API_KEY,
      messages: [USER_MESSAGE],
      retryBaseDelayMs: 0,
    });

    expect(stub).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('Hello from the model');
  });

  it('TC-F5-U10 gives up after the retry budget and reports the classified 5xx', async () => {
    const stub = respondWith(textResponse('{"error":"bad gateway"}', 502), textResponse('{"error":"bad gateway"}', 502));
    const error = await rejectionOf(
      chat({
        fetchImpl: stub,
        providerId: 'openai',
        apiKey: API_KEY,
        messages: [USER_MESSAGE],
        retryBaseDelayMs: 0,
      }),
    );
    expect(error).toBeInstanceOf(AiNetworkError);
    expect((error as AiNetworkError).code).toBe('network');
    expect((error as AiNetworkError).status).toBe(502);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('TC-F5-U10 never retries a non-429 4xx', async () => {
    const stub = respondWith(textResponse('{"error":"unknown model"}', 400));
    const error = await rejectionOf(
      chat({
        fetchImpl: stub,
        providerId: 'openai',
        apiKey: API_KEY,
        messages: [USER_MESSAGE],
        retryBaseDelayMs: 0,
      }),
    );
    expect((error as AiError).code).toBe('unknown');
    expect((error as AiError).status).toBe(400);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('TC-F5-U10 retries a 429 and can be disabled with maxRetries: 0', async () => {
    const retried = respondWith(textResponse('{"error":"slow down"}', 429), jsonResponse(OPENAI_FIXTURE));
    await chat({
      fetchImpl: retried,
      providerId: 'openai',
      apiKey: API_KEY,
      messages: [USER_MESSAGE],
      retryBaseDelayMs: 0,
    });
    expect(retried).toHaveBeenCalledTimes(2);

    const noRetry = respondWith(textResponse('{"error":"slow down"}', 429), jsonResponse(OPENAI_FIXTURE));
    const error = await rejectionOf(
      chat({
        fetchImpl: noRetry,
        providerId: 'openai',
        apiKey: API_KEY,
        messages: [USER_MESSAGE],
        maxRetries: 0,
        retryBaseDelayMs: 0,
      }),
    );
    expect((error as AiError).code).toBe('rateLimited');
    expect(noRetry).toHaveBeenCalledTimes(1);
  });
});
