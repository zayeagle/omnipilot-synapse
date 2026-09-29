/**
 * Distillation orchestration — the only place plaintext content leaves the device.
 *
 * Three gates run before a single byte is sent (§6.2, SC-F7-02):
 * 1. global AI egress must be authorized;
 * 2. the specific item must be authorized in the ledger (or explicitly allowed for this session);
 * 3. a non-default endpoint must be on the user's trusted-host list.
 *
 * The result is always a `pending` card committed alongside the index; the source file is read but
 * never written, so "AI 只提案" holds structurally rather than by convention.
 */

import { chat, type ChatMessage, type FetchLike } from './ai-client';
import { buildDistillPrompt, parseDistillResult } from './distill';
import {
  MessageError,
  type DistillRequestPayload,
  type DistillSkipReason,
  type ErrorCode,
} from './messages';
import { resolveProvider, type ProviderSpec } from './providers';
import type { AiLedger } from './queues';
import { scrub, scrubError } from './security/redact';
import type { ExtensionSettings, SecretPayload } from './settings-store';
import type { CkfRecord } from './core/ckf';
import type { GitHubStore } from './store/github-store';
import type { RepoFile } from './store/types';

export interface DistillOutcome {
  cardPath: string;
  commitUrl: string;
  warnings: string[];
}

export type DistillResult = { skipped: DistillSkipReason } | DistillOutcome;

export function isDistillSkipped(result: DistillResult): result is { skipped: DistillSkipReason } {
  return 'skipped' in result;
}

export interface DistillServiceOptions {
  store: GitHubStore;
  ledger: AiLedger;
  settings: ExtensionSettings;
  secrets: SecretPayload;
  fetchImpl: FetchLike;
  now?: () => number;
  /** Ids the user allowed for the rest of this browsing session. */
  sessionAllowed?: Set<string>;
  /** Search shards to commit with the card (see `CaptureServiceOptions.shards`). */
  shards?: (record: CkfRecord) => Promise<readonly RepoFile[]>;
}

/** Host of a base URL, or `''` when it is not parseable. */
export function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}

/**
 * Defence in depth for SC-F5-02: the options page asks for a trust acknowledgement, but the worker
 * re-checks it, so a compromised page cannot reach an unacknowledged endpoint even if the UI were
 * bypassed.
 */
export function assertEndpointTrusted(
  provider: ProviderSpec,
  baseUrl: string,
  trustedHosts: ReadonlyArray<string>,
): void {
  if (!baseUrl) return;
  if (baseUrl === provider.baseUrl) return;
  const host = endpointHost(baseUrl);
  if (!host) throw new MessageError('ai: the configured base URL is not a valid URL');
  if (!trustedHosts.includes(host)) {
    throw new MessageError(`ai: the endpoint ${host} has not been trusted by the user`, 'auth');
  }
}

export class DistillService {
  private readonly store: GitHubStore;
  private readonly ledger: AiLedger;
  private readonly settings: ExtensionSettings;
  private readonly secrets: SecretPayload;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sessionAllowed: Set<string>;
  private readonly shards?: (record: CkfRecord) => Promise<readonly RepoFile[]>;

  constructor(options: DistillServiceOptions) {
    this.store = options.store;
    this.ledger = options.ledger;
    this.settings = options.settings;
    this.secrets = options.secrets;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? Date.now;
    this.sessionAllowed = options.sessionAllowed ?? new Set<string>();
    if (options.shards) this.shards = options.shards;
  }

  /** Best-effort, exactly as in `CaptureService`: a missing shard is rebuildable, a lost card is not. */
  private async shardsFor(record: CkfRecord): Promise<readonly RepoFile[]> {
    if (!this.shards) return [];
    try {
      return await this.shards(record);
    } catch {
      return [];
    }
  }

  /** Gates 1–4. Returns the skip reason, or `null` when the request may proceed. */
  async preflight(payload: DistillRequestPayload): Promise<DistillSkipReason | null> {
    if (!this.settings.aiAuthorized) return 'not-authorized';
    if (!this.settings.ai.model) return 'no-provider-model';
    if (!this.secrets.providerKey) return 'no-provider-key';
    if (this.sessionAllowed.has(payload.sourceId)) return null;
    if (payload.allowThisSession === true) {
      this.sessionAllowed.add(payload.sourceId);
      return null;
    }
    const authorized = await this.ledger.has(payload.sourceId);
    return authorized ? null : 'not-authorized';
  }

  async distill(payload: DistillRequestPayload): Promise<DistillResult> {
    const skip = await this.preflight(payload);
    if (skip !== null) return { skipped: skip };

    const provider = resolveProvider(this.settings.ai.providerId);
    const baseUrl = this.settings.ai.baseUrl || provider.baseUrl;
    const model = this.settings.ai.model;

    // Gate 3 runs before any read, so an untrusted endpoint is refused without touching the repo.
    assertEndpointTrusted(provider, baseUrl, this.settings.ai.trustedHosts);

    try {
      const record = await this.store.readRecord(payload.sourcePath);
      if (record.kind !== 'source') {
        throw new MessageError('distill: the target record is not a captured source item');
      }

      const messages: ChatMessage[] = buildDistillPrompt(record).map((message) => ({
        role: message.role,
        content: message.content,
      }));

      const reply = await chat({
        fetchImpl: this.fetchImpl,
        providerId: provider.id,
        apiKey: this.secrets.providerKey,
        baseUrl,
        model,
        messages,
      });

      const { card, warnings } = parseDistillResult(reply.text, {
        sourceId: record.id,
        sourcePath: payload.sourcePath,
        provider: provider.id,
        model,
        at: new Date(this.now()).toISOString(),
      });

      const extraFiles = await this.shardsFor(card);
      const committed = await this.store.commitRecord(card, {
        ...(extraFiles.length > 0 ? { extraFiles } : {}),
      });

      await this.ledger.append({
        source_id: record.id,
        provider: provider.id,
        model,
        ok: true,
      });

      return { cardPath: committed.path, commitUrl: committed.commit.htmlUrl, warnings };
    } catch (error) {
      // A failed attempt is recorded too: the ledger is an audit trail, not just an allow-list.
      await this.ledger.append({
        source_id: payload.sourceId,
        provider: provider.id,
        model,
        ok: false,
        ...(isCoded(error) ? { error_code: error.code } : {}),
      });
      // Re-throw the original so the router maps it to a protocol error code; the message has
      // already been made secret-free by the AI/store layers, and is scrubbed again here.
      if (error instanceof Error) {
        error.message = scrub(error.message, Object.values(this.secrets));
      }
      throw error;
    }
  }

  /** Never surface a provider payload verbatim. */
  describeError(error: unknown): string {
    return scrubError(error, Object.values(this.secrets));
  }
}

function isCoded(error: unknown): error is { code: ErrorCode } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}
