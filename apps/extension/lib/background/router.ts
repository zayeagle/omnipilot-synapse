/**
 * The single inbound-message funnel for the background worker.
 *
 * Every message passes through, in order: sender authorization → payload sanitisation is the
 * handler's job → rate limiting → dispatch → scrubbed error mapping. Keeping this in one place is
 * what makes TC-F4-I01 meaningful: a page-context sender is rejected here, before any handler that
 * could touch a credential ever runs.
 */

import {
  MessageError,
  assertRequestAllowed,
  fail,
  ok,
  type ErrorCode,
  type ExtensionRequest,
  type ExtensionResponse,
  type RequestType,
  type SenderLike,
} from '../messages';
import { scrubError } from '../security/redact';
import { VaultLockedError } from '../security/key-session';
import { WrongPassphraseError } from '../security/crypto-key';
import { KeyedRateLimiter } from '../security/rate-limit';

export type Handler = (request: ExtensionRequest, sender: SenderLike | null) => Promise<ExtensionResponse>;

export type HandlerMap = Partial<Record<RequestType, Handler>>;

export interface RouterLimiters {
  ai: KeyedRateLimiter;
  github: KeyedRateLimiter;
  vault: KeyedRateLimiter;
}

export interface MessageRouterOptions {
  handlers: HandlerMap;
  limiters: RouterLimiters;
  /** Configured credentials, used to scrub anything that could echo a secret back. */
  secrets?: () => Promise<ReadonlyArray<string | null | undefined>>;
  logger?: (message: string, detail?: string) => void;
}

/**
 * Which budget a request spends.
 *
 * Split by what the request TOUCHES, not by which surface sends it: credential and vault traffic is
 * deliberately the tightest budget there is, while repository reads and writes share a generous one.
 * The old split put every unlisted type on `vault` — so a single popup open (status, Inbox, proposals,
 * review queue, sync status) spent five or six of twelve and the next action came back `rateLimited`.
 * A real popup has no tab id either, so those requests also share one bucket for the whole profile.
 */
const CREDENTIAL_TYPES: ReadonlySet<RequestType> = new Set<RequestType>([
  'settings.github',
  'settings.provider',
  'settings.security',
  'settings.export',
  'settings.reset',
  'vault.setup',
  'vault.unlock',
  'vault.lock',
]);

export function limiterKeyFor(type: RequestType): keyof RouterLimiters {
  if (type === 'distill.request') return 'ai';
  if (CREDENTIAL_TYPES.has(type)) return 'vault';
  return 'github';
}

export function errorCodeOf(error: unknown): ErrorCode {
  if (error instanceof VaultLockedError) return 'locked';
  if (error instanceof WrongPassphraseError) return 'wrongPassphrase';
  if (error instanceof MessageError) return error.code;
  // Classified errors (storage, AI, distill) declare their own protocol code.
  const declared = (error as { code?: unknown } | null)?.code;
  if (typeof declared === 'string' && ERROR_CODES.has(declared as ErrorCode)) {
    return declared as ErrorCode;
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof name === 'string') {
    if (name === 'EmptyResponseError') return 'emptyResponse';
    if (name === 'DistillParseError') return 'badJson';
    if (name === 'CkfError') return 'parse';
  }
  return 'unknown';
}

/**
 * Every declared code, as a table rather than a hand-kept list.
 *
 * A code that is in `ErrorCode` but missing from this set is silently rewritten to `unknown` — which
 * throws away exactly the guidance the status surface was built to show. Deriving the runtime set from
 * a `Record<ErrorCode, true>` makes the compiler refuse an incomplete table, so the two can never drift
 * (found by audit: `nativeUnavailable`, `protocolMismatch`, `gitFailed`, `syncConflict`,
 * `indexUnavailable` were all missing).
 */
const ERROR_CODE_TABLE: Record<ErrorCode, true> = {
  auth: true,
  scope: true,
  notFound: true,
  conflict: true,
  rateLimited: true,
  timeout: true,
  network: true,
  locked: true,
  needVault: true,
  wrongPassphrase: true,
  passphraseTooShort: true,
  badJson: true,
  emptyResponse: true,
  publicRepo: true,
  notConfigured: true,
  disabled: true,
  parse: true,
  validation: true,
  nativeUnavailable: true,
  protocolMismatch: true,
  gitFailed: true,
  syncConflict: true,
  indexUnavailable: true,
  tierLocked: true,
  needToken: true,
  commitTooLarge: true,
  deleteUnsupported: true,
  unknown: true,
};

const ERROR_CODES: ReadonlySet<ErrorCode> = new Set(
  Object.keys(ERROR_CODE_TABLE) as ErrorCode[],
);

export class MessageRouter {
  private readonly handlers: HandlerMap;
  private readonly limiters: RouterLimiters;
  private readonly secrets: () => Promise<ReadonlyArray<string | null | undefined>>;
  private readonly logger: (message: string, detail?: string) => void;

  constructor(options: MessageRouterOptions) {
    this.handlers = options.handlers;
    this.limiters = options.limiters;
    this.secrets = options.secrets ?? (async () => []);
    this.logger = options.logger ?? (() => undefined);
  }

  private async safeMessage(error: unknown): Promise<string> {
    return scrubError(error, await this.secrets());
  }

  private bucketKey(sender: SenderLike | null | undefined): string {
    const tabId = sender?.tab?.id;
    return typeof tabId === 'number' ? `tab:${tabId}` : 'internal';
  }

  async handle(request: unknown, sender?: SenderLike | null): Promise<ExtensionResponse> {
    let type: RequestType;
    try {
      type = assertRequestAllowed(request, sender);
    } catch (error) {
      const code = errorCodeOf(error);
      this.logger('message rejected', `${code}`);
      return fail(await this.safeMessage(error), code);
    }

    const decision = this.limiters[limiterKeyFor(type)].check(this.bucketKey(sender));
    if (!decision.allowed) {
      const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      return fail(`rate limited (retry in ${seconds}s)`, 'rateLimited');
    }

    const handler = this.handlers[type];
    if (!handler) return fail(`no handler registered for ${type}`, 'validation');

    try {
      return await handler(request as ExtensionRequest, sender ?? null);
    } catch (error) {
      const code = errorCodeOf(error);
      const message = await this.safeMessage(error);
      this.logger(`handler failed: ${type}`, message);
      return fail(message, code);
    }
  }
}

export function createRouterOptions(
  handlers: HandlerMap,
  overrides: Partial<Omit<MessageRouterOptions, 'handlers'>> = {},
): MessageRouterOptions {
  const now = Date.now;
  return {
    handlers,
    limiters: {
      ai: new KeyedRateLimiter({ perKeyMax: 30, globalMax: 90, windowMs: 60_000, now }),
      github: new KeyedRateLimiter({ perKeyMax: 60, globalMax: 180, windowMs: 60_000, now }),
      vault: new KeyedRateLimiter({ perKeyMax: 12, globalMax: 30, windowMs: 60_000, now }),
    },
    ...overrides,
  };
}

export { ok };
