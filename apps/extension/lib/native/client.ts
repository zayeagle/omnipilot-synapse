/**
 * Native-messaging client for the companion process.
 *
 * The browser API is injected (`connect`) rather than imported, so the whole lifecycle — handshake,
 * request/response correlation, timeouts, reconnect — is testable in Node with a fake duplex port,
 * and so this module never hard-codes `chrome.runtime`.
 *
 * Failure philosophy: every path here reports *why* it cannot work (`missing`, `mismatch`, a specific
 * error code) instead of throwing an opaque error at a caller. The UI can then say "install the
 * companion" rather than "something went wrong", and token mode keeps working untouched.
 */

import {
  PROTOCOL_VERSION,
  buildRequest,
  checkHandshake,
  parseNativeResponse,
  type NativeErrorCode,
  type NativeOp,
  type PingData,
} from './protocol';

/** The slice of a `runtime.Port` this client uses. */
export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export type ConnectNative = (hostName: string) => NativePort;

export type NativeAvailability = 'ok' | 'missing' | 'mismatch';

export const DEFAULT_HOST_NAME = 'com.omnipilot.synapse.git_bridge';
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/** Git operations that legitimately take a long time (a fetch over SSH, a push). */
const SLOW_OPS: ReadonlySet<NativeOp> = new Set<NativeOp>(['git.fetch', 'git.push', 'git.commit']);

export class NativeError extends Error {
  readonly code: NativeErrorCode | 'nativeUnavailable' | 'protocolMismatch';

  constructor(code: NativeError['code'], message: string) {
    super(message);
    this.name = 'NativeError';
    this.code = code;
  }
}

export interface NativeClientOptions {
  connect: ConnectNative;
  hostName?: string;
  /** Injected clock so tests never wait on real timers. */
  now?: () => number;
  requestTimeoutMs?: number;
  gitTimeoutMs?: number;
  /** Injected scheduler so a timeout can be driven deterministically in tests. */
  schedule?: (handler: () => void, ms: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: NativeError) => void;
  timer: unknown;
}

export class NativeClient {
  private readonly options: Required<
    Pick<NativeClientOptions, 'hostName' | 'requestTimeoutMs' | 'gitTimeoutMs'>
  > &
    NativeClientOptions;
  private port: NativePort | null = null;
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;
  private availabilityCache: { state: NativeAvailability; ping: PingData | null } | null = null;
  private connecting: Promise<NativeAvailability> | null = null;

  constructor(options: NativeClientOptions) {
    this.options = {
      hostName: options.hostName ?? DEFAULT_HOST_NAME,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      gitTimeoutMs: options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      ...options,
    };
  }

  /** Cheap, cached answer for the UI: is the companion usable right now? */
  async availability(force = false): Promise<NativeAvailability> {
    if (!force && this.availabilityCache) return this.availabilityCache.state;
    const state = await this.handshake();
    return state;
  }

  async ping(force = false): Promise<PingData | null> {
    if (!force && this.availabilityCache) return this.availabilityCache.ping;
    await this.handshake();
    return this.availabilityCache?.ping ?? null;
  }

  private async handshake(): Promise<NativeAvailability> {
    if (this.connecting) return this.connecting;
    this.connecting = (async (): Promise<NativeAvailability> => {
      try {
        const data = await this.dispatch('ping', { timeoutMs: this.options.requestTimeoutMs });
        const { compatible } = checkHandshake(data);
        this.availabilityCache = {
          state: compatible ? 'ok' : 'mismatch',
          ping: compatible ? (data as PingData) : null,
        };
        return this.availabilityCache.state;
      } catch (error) {
        // A failed handshake clears the cache so the next call retries rather than remembering a
        // transient failure for the whole session.
        this.availabilityCache = { state: 'missing', ping: null };
        if (error instanceof NativeError && error.code === 'protocolMismatch') {
          this.availabilityCache = { state: 'mismatch', ping: null };
          return 'mismatch';
        }
        return 'missing';
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  /**
   * Send one op. Opens the port lazily; a `ping` handshake is performed first by `availability()`.
   */
  async send<T = unknown>(
    op: NativeOp,
    options: { cwd?: string; args?: Record<string, unknown>; timeoutMs?: number } = {},
  ): Promise<T> {
    if (op !== 'ping' && this.availabilityCache?.state === 'mismatch') {
      throw new NativeError(
        'protocolMismatch',
        `native: the companion speaks protocol ${this.availabilityCache.ping?.protocolVersion ?? '?'}, this extension speaks ${PROTOCOL_VERSION}`,
      );
    }
    const data = await this.dispatch(op, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.args !== undefined ? { args: options.args } : {}),
      timeoutMs: options.timeoutMs ?? (SLOW_OPS.has(op) ? this.options.gitTimeoutMs : this.options.requestTimeoutMs),
    });
    return data as T;
  }

  private ensurePort(): NativePort {
    if (this.port) return this.port;
    let port: NativePort;
    try {
      port = this.options.connect(this.options.hostName);
    } catch (error) {
      throw new NativeError(
        'nativeUnavailable',
        `native: could not connect to "${this.options.hostName}" (${error instanceof Error ? error.message : 'unknown'})`,
      );
    }
    port.onMessage.addListener((message) => this.onMessage(message));
    port.onDisconnect.addListener(() => this.onDisconnect());
    this.port = port;
    return port;
  }

  private onMessage(message: unknown): void {
    const parsed = parseNativeResponse(message);
    const id = typeof message === 'object' && message !== null ? (message as { id?: unknown }).id : undefined;
    if (typeof id !== 'string') return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.clearTimer(entry.timer);
    if (parsed.ok) entry.resolve(parsed.data);
    else entry.reject(new NativeError(parsed.code, parsed.message));
  }

  private onDisconnect(): void {
    const port = this.port;
    this.port = null;
    // Anything in flight can never be answered now; fail it rather than leaking the promise.
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      this.clearTimer(entry.timer);
      entry.reject(new NativeError('nativeUnavailable', 'native: the companion disconnected'));
    }
    // A dropped port invalidates the cached availability.
    this.availabilityCache = null;
    void port;
  }

  private clearTimer(handle: unknown): void {
    if (handle !== undefined && this.options.cancelSchedule) this.options.cancelSchedule(handle);
  }

  private dispatch(
    op: NativeOp,
    options: { cwd?: string; args?: Record<string, unknown>; timeoutMs: number },
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let port: NativePort;
      try {
        port = this.ensurePort();
      } catch (error) {
        reject(error);
        return;
      }

      this.sequence += 1;
      const id = `r${this.sequence}`;
      const request = buildRequest(op, {
        id,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.args !== undefined ? { args: options.args } : {}),
      });

      const schedule = this.options.schedule ?? ((handler: () => void, ms: number) => setTimeout(handler, ms));
      const timer = schedule(() => {
        this.pending.delete(id);
        reject(new NativeError('timeout', `native: "${op}" did not answer within ${options.timeoutMs} ms`));
      }, options.timeoutMs);

      this.pending.set(id, {
        resolve: (data) => {
          if (op === 'ping') {
            const { compatible } = checkHandshake(data);
            if (!compatible) {
              reject(
                new NativeError(
                  'protocolMismatch',
                  `native: the companion speaks a different protocol version`,
                ),
              );
              return;
            }
          }
          resolve(data);
        },
        reject,
        timer,
      });

      try {
        port.postMessage(request);
      } catch (error) {
        this.pending.delete(id);
        this.clearTimer(timer);
        reject(
          new NativeError(
            'nativeUnavailable',
            `native: could not send "${op}" (${error instanceof Error ? error.message : 'unknown'})`,
          ),
        );
      }
    });
  }

  /** Close the port; the next `send` reopens it. */
  disconnect(): void {
    if (!this.port) return;
    const port = this.port;
    this.port = null;
    try {
      port.disconnect();
    } catch {
      // Already gone.
    }
    this.availabilityCache = null;
  }

  /** Test/DI seam: how many requests are in flight. */
  inFlight(): number {
    return this.pending.size;
  }
}

/** A purely in-process port, used by tests and by the E2E harness. */
export function createFakePort(
  respond: (message: unknown) => unknown | null,
): NativePort & { sent: unknown[]; emit(message: unknown): void } {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const sent: unknown[] = [];
  return {
    sent,
    postMessage(message) {
      sent.push(message);
      const reply = respond(message);
      if (reply !== null) {
        // Answer on a later turn, exactly like a real port.
        queueMicrotask(() => {
          for (const listener of messageListeners) listener(reply);
        });
      }
    },
    disconnect() {
      for (const listener of disconnectListeners) listener();
    },
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
    emit(message) {
      for (const listener of messageListeners) listener(message);
    },
  };
}
