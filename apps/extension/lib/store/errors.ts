/**
 * Classified storage errors.
 *
 * Every HTTP outcome is mapped onto one of these before it leaves the adapter, so the router, the
 * UI and the tests all speak one vocabulary, and no raw provider/HTTP message (which may echo a
 * credential) ever reaches the user.
 */

import type { ErrorCode } from '../messages';

export type StoreErrorName =
  | 'NotConfiguredError'
  | 'CommitTooLargeError'
  | 'AuthError'
  | 'ScopeError'
  | 'NotFoundError'
  | 'ConflictError'
  | 'PublicRepoError'
  | 'RateLimitError'
  | 'ServerError'
  | 'NetworkError'
  | 'TimeoutError'
  | 'UnexpectedError';

export class StoreError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly hint?: string;

  constructor(
    name: StoreErrorName,
    code: ErrorCode,
    message: string,
    options: { status?: number; hint?: string } = {},
  ) {
    super(message);
    this.name = name;
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.hint !== undefined) this.hint = options.hint;
  }
}

export class NotConfiguredError extends StoreError {
  constructor(message = 'storage: repository is not configured') {
    super('NotConfiguredError', 'notConfigured', message);
  }
}

/**
 * One commit would carry more files than the guard allows.
 *
 * Its own code on purpose: this used to surface as notConfigured, so a fully configured store reported
 * that storage was not configured whenever one page's search shards outnumbered the cap. That sent
 * everyone looking at the wrong setting.
 */
export class CommitTooLargeError extends StoreError {
  constructor(public readonly fileCount: number, limit: number) {
    super(
      'CommitTooLargeError',
      'commitTooLarge',
      'storage: refusing a commit with ' + fileCount + ' files (limit ' + limit + ')',
    );
  }
}

export class AuthError extends StoreError {
  constructor(message = 'storage: credential rejected', status?: number) {
    super('AuthError', 'auth', message, { status });
  }
}

export class ScopeError extends StoreError {
  constructor(message = 'storage: token lacks Contents write permission') {
    super('ScopeError', 'scope', message, {
      status: 403,
      hint: 'Fine-grained token with Contents: Read and write on this repository',
    });
  }
}

export class NotFoundError extends StoreError {
  constructor(message = 'storage: repository, branch or path not found') {
    super('NotFoundError', 'notFound', message, { status: 404 });
  }
}

export class ConflictError extends StoreError {
  constructor(message = 'storage: the branch moved while committing') {
    super('ConflictError', 'conflict', message, { status: 409 });
  }
}

export class PublicRepoError extends StoreError {
  constructor(message = 'storage: writing to a public repository is blocked') {
    super('PublicRepoError', 'publicRepo', message);
  }
}

export class RateLimitError extends StoreError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs = 0, message = 'storage: rate limited') {
    super('RateLimitError', 'rateLimited', message, { status: 429 });
    this.retryAfterMs = retryAfterMs;
  }
}

export class ServerError extends StoreError {
  constructor(status: number, message = 'storage: upstream server error') {
    super('ServerError', 'network', message, { status });
  }
}

export class NetworkError extends StoreError {
  constructor(message = 'storage: network request failed') {
    super('NetworkError', 'network', message);
  }
}

export class TimeoutError extends StoreError {
  constructor(message = 'storage: request timed out') {
    super('TimeoutError', 'timeout', message);
  }
}

export function isStoreError(error: unknown): error is StoreError {
  return error instanceof StoreError;
}

/**
 * Map an HTTP status (with its parsed body, when available) onto a classified error.
 * The body is used only to distinguish scope from authentication — never surfaced verbatim.
 */
export function classifyHttpStatus(status: number, body?: unknown): StoreError {
  const message = extractMessage(body);
  if (status === 401) return new AuthError('storage: the token is invalid or expired', status);
  if (status === 403) {
    if (/rate limit/iu.test(message)) {
      return new RateLimitError(60_000, 'storage: GitHub rate limit reached');
    }
    return new ScopeError();
  }
  if (status === 404) return new NotFoundError();
  if (status === 409 || status === 422) return new ConflictError();
  if (status === 429) return new RateLimitError(60_000);
  if (status >= 500) return new ServerError(status);
  return new StoreError('UnexpectedError', 'unknown', `storage: unexpected status ${status}`, {
    status,
  });
}

function extractMessage(body: unknown): string {
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null) {
    const candidate = (body as { message?: unknown }).message;
    if (typeof candidate === 'string') return candidate;
  }
  return '';
}
