/**
 * The single place the extension talks to a model provider.
 *
 * Two auth styles cover every provider in the catalog, so a new provider is a row in
 * `lib/providers.ts` and never a branch here. Three rules shape this module:
 *
 * 1. `fetch` is always injected — the worker passes the global one, tests pass a stub, and no test
 *    can accidentally reach the network;
 * 2. every failure leaves as a *classified* error carrying a `code: ErrorCode`, which is what
 *    `lib/background/router.ts#errorCodeOf` turns into the user-facing message, so a raw provider
 *    body or an API key can never reach the user;
 * 3. nothing is retried blindly: one backoff retry for 429/5xx, never for any other 4xx.
 */

import { LIMITS, type ErrorCode } from './messages';
import { scrubError } from './security/redact';
import {
  BadJsonError,
  EmptyResponseError,
  capReply,
  parseChatCompletion,
} from './ai-parse';
import {
  isValidBaseUrl,
  resolveProvider,
  type ProviderId,
  type ProviderSpec,
} from './providers';

// Re-exported so a caller (F7 distill, the options "test connection" button) has one import for the
// whole AI failure vocabulary. The parse errors stay declared in `ai-parse.ts` on purpose: importing
// the client from the parser would be a cycle, while importing the parser from the client is not.
export { BadJsonError, EmptyResponseError } from './ai-parse';

/** 15 s per attempt (design §F5). */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** "one retry on 429/5xx with backoff". */
export const DEFAULT_MAX_RETRIES = 1;

export const DEFAULT_RETRY_BASE_DELAY_MS = 500;

export const ANTHROPIC_VERSION = '2023-06-01';

/** The Messages API requires an explicit cap; distillation output is small. */
const ANTHROPIC_MAX_TOKENS = 2_048;

/** A non-JSON body is kept for debugging only, and never unbounded. */
const MAX_RAW_CHARS = 64 * 1024;

/** Hard ceiling on a caller-supplied timeout, so a stored setting cannot hang the worker. */
const MAX_TIMEOUT_MS = 120_000;

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Structural subset of `RequestInit` — a real `fetch` and a test stub both satisfy it. */
export interface FetchRequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Structural subset of `Response`; `ok`/`status` are optional so a minimal stub still works. */
export interface FetchResponseLike {
  status?: number;
  ok?: boolean;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchRequestInitLike) => Promise<FetchResponseLike>;

export interface ChatOptions {
  fetchImpl: FetchLike;
  /** Either a full catalog entry or a provider id; `providerId` is the shorter spelling. */
  provider?: ProviderSpec | ProviderId | string | null;
  providerId?: string | null;
  apiKey?: string;
  /** Overrides the catalog endpoint; required for `custom`. */
  baseUrl?: string;
  /** Overrides the catalog default model; required for `custom`. */
  model?: string;
  messages: readonly ChatMessage[];
  timeoutMs?: number;
  maxRetries?: number;
  /** Backoff base; a seam so unit tests never sleep on the wall clock. */
  retryBaseDelayMs?: number;
  signal?: AbortSignal | null;
}

export interface ChatResult {
  /** Bounded, scrubbed-safe assistant text — the only field that should be stored. */
  text: string;
  /** Parsed response body when it was JSON, else the (bounded) raw text. */
  raw: unknown;
  provider: ProviderId;
  model: string;
}

export type AiErrorName =
  | 'AiValidationError'
  | 'AiAuthError'
  | 'AiScopeError'
  | 'AiRateLimitError'
  | 'AiTimeoutError'
  | 'AiNetworkError'
  | 'AiUnknownError';

export class AiError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  /** Scrubbed provider detail, for the options page — never rendered as the primary message. */
  readonly hint?: string;
  /** Whether the client's retry policy may send this request again. */
  readonly retryable: boolean;

  constructor(
    name: AiErrorName,
    code: ErrorCode,
    message: string,
    options: { status?: number; hint?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = name;
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.hint !== undefined) this.hint = options.hint;
    this.retryable = options.retryable ?? false;
  }
}

export class AiValidationError extends AiError {
  constructor(message: string, hint?: string) {
    super('AiValidationError', 'validation', message, hint === undefined ? {} : { hint });
  }
}

export class AiAuthError extends AiError {
  constructor(status = 401, hint?: string) {
    super('AiAuthError', 'auth', 'ai: the credential was rejected', {
      status,
      ...(hint === undefined ? {} : { hint }),
    });
  }
}

export class AiScopeError extends AiError {
  constructor(status = 403, hint?: string) {
    super('AiScopeError', 'scope', 'ai: the credential is not allowed to use this model', {
      status,
      ...(hint === undefined ? {} : { hint }),
      retryable: false,
    });
  }
}

export class AiRateLimitError extends AiError {
  constructor(status = 429, hint?: string) {
    super('AiRateLimitError', 'rateLimited', 'ai: the provider is rate limiting this key', {
      status,
      ...(hint === undefined ? {} : { hint }),
      retryable: true,
    });
  }
}

export class AiTimeoutError extends AiError {
  constructor(message = 'ai: the request timed out') {
    super('AiTimeoutError', 'timeout', message);
  }
}

export class AiNetworkError extends AiError {
  constructor(message = 'ai: the request failed before a response arrived', options: { status?: number; hint?: string; retryable?: boolean } = {}) {
    super('AiNetworkError', 'network', message, options);
  }
}

export class AiUnknownError extends AiError {
  constructor(status?: number, hint?: string) {
    super('AiUnknownError', 'unknown', 'ai: the provider returned an unexpected response', {
      ...(status === undefined ? {} : { status }),
      ...(hint === undefined ? {} : { hint }),
    });
  }
}

const AI_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'auth',
  'scope',
  'rateLimited',
  'timeout',
  'network',
  'emptyResponse',
  'badJson',
  'validation',
  'unknown',
]);

/**
 * True for anything the AI layer classifies — including the parser's own errors, which carry a
 * `code` but are not an `AiError` subclass (see the note in `ai-parse.ts`).
 */
export function isAiError(error: unknown): boolean {
  if (error instanceof AiError) return true;
  if (error instanceof EmptyResponseError || error instanceof BadJsonError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && AI_CODES.has(code as ErrorCode);
}

/* --------------------------------- request --------------------------------- */

interface RequestPlan {
  url: string;
  init: FetchRequestInitLike;
}

function endpointUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/u, '');
  // Tolerate a user pasting the full endpoint instead of the base URL.
  return trimmed.endsWith(path) ? trimmed : `${trimmed}${path}`;
}

/** Anthropic takes the system prompt as a top-level field, not as a message. */
function hoistSystem(messages: readonly ChatMessage[]): {
  system?: string;
  rest: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemParts: string[] = [];
  const rest: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of messages) {
    if (message.role === 'system') systemParts.push(message.content);
    else rest.push({ role: message.role, content: message.content });
  }
  return systemParts.length > 0 ? { system: systemParts.join('\n\n'), rest } : { rest };
}

function buildRequest(
  spec: ProviderSpec,
  input: { baseUrl: string; apiKey: string; model: string; messages: readonly ChatMessage[] },
): RequestPlan {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (spec.authStyle === 'anthropic') {
    headers['x-api-key'] = input.apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    const { system, rest } = hoistSystem(input.messages);
    if (rest.length === 0) {
      throw new AiValidationError('ai: the Anthropic API needs at least one user message');
    }
    const body: Record<string, unknown> = {
      model: input.model,
      temperature: 0.2,
      stream: false,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      messages: rest,
    };
    if (system !== undefined) body['system'] = system;
    return {
      url: endpointUrl(input.baseUrl, '/messages'),
      init: { method: 'POST', headers, body: JSON.stringify(body) },
    };
  }

  headers['Authorization'] = `Bearer ${input.apiKey}`;
  return {
    url: endpointUrl(input.baseUrl, '/chat/completions'),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: input.model,
        temperature: 0.2,
        stream: false,
        messages: input.messages,
      }),
    },
  };
}

/* ---------------------------------- errors --------------------------------- */

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Pull a human-readable message out of an error body, without trusting its shape. */
function pickMessage(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value;
  if (depth > 3 || typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const message = pickMessage(entry, depth + 1);
      if (message !== undefined) return message;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'error_description', 'detail', 'msg']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
    if (candidate !== null && typeof candidate === 'object') {
      const nested = pickMessage(candidate, depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/**
 * The provider's own explanation, scrubbed of the API key and of anything key-shaped, then capped.
 * It is a *hint*: the classified message stays fixed so an echo of the key can never be rendered.
 */
function scrubbedDetail(bodyText: string, secrets: readonly string[]): string | undefined {
  if (bodyText.trim().length === 0) return undefined;
  const parsed = ((): unknown => {
    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      return undefined;
    }
  })();
  const raw = parsed === undefined ? bodyText : (pickMessage(parsed) ?? bodyText);
  const cleaned = scrubError(raw, secrets);
  return cleaned.length === 0 ? undefined : cleaned;
}

function classifyStatus(status: number, hint: string | undefined): AiError {
  if (status === 401) return new AiAuthError(status, hint);
  if (status === 403) return new AiScopeError(status, hint);
  if (status === 429) return new AiRateLimitError(status, hint);
  if (status >= 500) return new AiNetworkError('ai: the provider reported a server error', {
    status,
    ...(hint === undefined ? {} : { hint }),
    retryable: true,
  });
  return new AiUnknownError(status, hint);
}

/* --------------------------------- attempts -------------------------------- */

interface AttemptOutcome {
  text: string;
  raw: unknown;
}

async function readText(
  response: FetchResponseLike,
  secrets: readonly string[],
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new AiNetworkError(scrubError(error, secrets));
  }
}

async function runAttempt(input: {
  fetchImpl: FetchLike;
  plan: RequestPlan;
  timeoutMs: number;
  signal?: AbortSignal | null;
  secrets: readonly string[];
}): Promise<AttemptOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  const forwardAbort = (): void => controller.abort();
  const external = input.signal ?? null;
  if (external) {
    if (external.aborted) forwardAbort();
    else external.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    let response: FetchResponseLike;
    try {
      response = await input.fetchImpl(input.plan.url, {
        ...input.plan.init,
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) throw new AiTimeoutError();
      if (external?.aborted === true || isAbortError(error)) {
        throw new AiTimeoutError('ai: the request was cancelled');
      }
      throw new AiNetworkError(scrubError(error, input.secrets));
    }

    const bodyText = await readText(response, input.secrets);
    const status =
      typeof response.status === 'number' ? response.status : response.ok === false ? 0 : 200;
    const ok = response.ok ?? (status >= 200 && status < 300);
    if (!ok) throw classifyStatus(status, scrubbedDetail(bodyText, input.secrets));

    const text = parseChatCompletion(bodyText);
    const raw = ((): unknown => {
      try {
        return JSON.parse(bodyText) as unknown;
      } catch {
        return bodyText.length > MAX_RAW_CHARS ? bodyText.slice(0, MAX_RAW_CHARS) : bodyText;
      }
    })();
    return { text, raw };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', forwardAbort);
  }
}

function positiveNumber(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.floor(value));
}

/** `maxRetries: 0` is meaningful ("do not retry"), so it gets its own clamp. */
function retryCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_MAX_RETRIES;
  }
  return Math.min(5, Math.floor(value));
}

/** `retryBaseDelayMs: 0` is meaningful (retry immediately), so it gets its own clamp too. */
function retryBase(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_RETRY_BASE_DELAY_MS;
  }
  return Math.min(4_000, Math.floor(value));
}

function retryDelayMs(attempt: number, base: number): number {
  return Math.min(4_000, base * 2 ** (attempt - 1));
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* ----------------------------------- chat ---------------------------------- */

function normalizeMessages(messages: readonly ChatMessage[] | undefined): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AiValidationError('ai: at least one message is required');
  }
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) {
      throw new AiValidationError('ai: every message must be an object');
    }
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new AiValidationError('ai: message role must be system, user or assistant');
    }
    if (typeof content !== 'string' || content.length === 0) {
      throw new AiValidationError('ai: message content must be a non-empty string');
    }
    out.push({ role, content });
  }
  return out;
}

function resolveSpec(options: ChatOptions): ProviderSpec {
  if (options.provider !== null && typeof options.provider === 'object') return options.provider;
  const id = typeof options.provider === 'string' ? options.provider : options.providerId;
  return resolveProvider(id ?? null);
}

/**
 * Send one chat request and return the assistant text.
 *
 * Pre-flight problems (missing key/model/URL, malformed messages) throw `AiValidationError` before
 * any network call, so a misconfigured settings record cannot leak a request.
 */
export async function chat(options: ChatOptions): Promise<ChatResult> {
  if (typeof options?.fetchImpl !== 'function') {
    throw new AiValidationError('ai: an injected fetch implementation is required');
  }

  const spec = resolveSpec(options);
  const messages = normalizeMessages(options.messages);

  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  if (apiKey.length === 0) throw new AiValidationError('ai: an API key is required');
  if (apiKey.length > LIMITS.apiKeyChars) {
    throw new AiValidationError(`ai: the API key exceeds ${LIMITS.apiKeyChars} characters`);
  }

  const configuredBase = typeof options.baseUrl === 'string' ? options.baseUrl.trim() : '';
  const baseUrl = configuredBase.length > 0 ? configuredBase : spec.baseUrl;
  if (baseUrl.length === 0) throw new AiValidationError('ai: this provider needs a base URL');
  if (!isValidBaseUrl(baseUrl)) {
    throw new AiValidationError(
      'ai: the base URL must be a valid https endpoint (http is allowed for loopback only)',
    );
  }

  const configuredModel = typeof options.model === 'string' ? options.model.trim() : '';
  const model = configuredModel.length > 0 ? configuredModel : spec.defaultModel;
  if (model.length === 0) throw new AiValidationError('ai: this provider needs a model id');
  if (model.length > LIMITS.modelChars) {
    throw new AiValidationError(`ai: the model id exceeds ${LIMITS.modelChars} characters`);
  }

  const plan = buildRequest(spec, { baseUrl, apiKey, model, messages });
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxRetries = retryCount(options.maxRetries);
  const retryBaseDelayMs = retryBase(options.retryBaseDelayMs);
  const secrets = [apiKey];

  let attempt = 0;
  for (;;) {
    try {
      const outcome = await runAttempt({
        fetchImpl: options.fetchImpl,
        plan,
        timeoutMs,
        signal: options.signal ?? null,
        secrets,
      });
      return { text: capReply(outcome.text), raw: outcome.raw, provider: spec.id, model };
    } catch (error) {
      // Parse failures (EmptyResponseError/BadJsonError) are already classified and final; the
      // explicit filter below only rewrites transport failures, which is why nothing is swallowed.
      if (error instanceof EmptyResponseError || error instanceof BadJsonError) throw error;
      const classified =
        error instanceof AiError
          ? error
          : new AiNetworkError(scrubError(error, secrets));
      if (!classified.retryable || attempt >= maxRetries) throw classified;
      attempt += 1;
      await delay(retryDelayMs(attempt, retryBaseDelayMs));
      if (options.signal?.aborted === true) {
        throw new AiTimeoutError('ai: the request was cancelled');
      }
    }
  }
}
