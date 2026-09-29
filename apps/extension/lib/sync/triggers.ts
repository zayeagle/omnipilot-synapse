/**
 * When a sync runs, and what happens when two triggers collide.
 *
 * The interesting part is not the list of triggers — it is the **coalescing rule**: a capture during a
 * slow pull must not start a second sync (two concurrent reconciliations of the same dirty set would
 * race on the commit), and it must not be dropped either (the capture would sit unpushed until the
 * next alarm). So exactly one reason is remembered while a sync is in flight, and it is run once when
 * the current one finishes; further bursts collapse into that single pending reason.
 */

import type { SyncPolicy, SyncReason } from '../messages';

export const SYNC_ALARM_NAME = 'omnipilot-sync';

/** The slice of `browser.alarms` this module uses — injected so the whole thing is testable. */
export interface AlarmApi {
  create(name: string, info: { periodInMinutes: number }): void | Promise<void>;
  clear(name: string): void | Promise<boolean>;
}

export interface SyncTriggerOptions {
  /** The work to perform for one reason. */
  run: (reason: SyncReason) => Promise<unknown>;
  /**
   * Read the current policy lazily: the user can change it while the worker is alive.
   *
   * Optional so a caller that always passes the policy to {@link SyncTriggers.schedule} explicitly (and
   * never schedules from an alarm) does not have to invent a reader.
   */
  policy?: () => Promise<SyncPolicy> | SyncPolicy;
  alarms?: AlarmApi;
  logger?: (message: string) => void;
}

export interface SyncTriggerState {
  inFlight: boolean;
  /** The reason waiting for the current run to finish, or `null`. At most one. */
  queued: SyncReason | null;
  runs: number;
}

export class SyncTriggers {
  /** At most one waiting reason — that is the whole coalescing rule. `null` means "nothing waiting". */
  private queued: SyncReason | null = null;
  private current: Promise<void> | null = null;
  private runs = 0;

  constructor(private readonly options: SyncTriggerOptions) {}

  /** Cheap, side-effect-free snapshot for the status row and for tests. */
  state(): SyncTriggerState {
    return { inFlight: this.current !== null, queued: this.queued, runs: this.runs };
  }

  /**
   * Ask for a sync.
   *
   * Returns when the *current* run finishes (so a caller that awaits it sees a settled world), which
   * may be the run that was already in flight rather than a new one. A caller that must not block — the
   * alarm handler, the capture path — fires it with `void`.
   */
  async trigger(reason: SyncReason): Promise<void> {
    if (this.current) {
      // First one wins: a burst of five captures is one follow-up sync, not five.
      if (this.queued === null) this.queued = reason;
      this.options.logger?.(`sync: ${reason} coalesced into the in-flight run`);
      return this.current;
    }
    this.current = this.drain(reason);
    try {
      await this.current;
    } finally {
      this.current = null;
    }
  }

  /** Run one reason, then whatever single reason accumulated while it ran. */
  private async drain(reason: SyncReason): Promise<void> {
    let next: SyncReason | undefined = reason;
    while (next !== undefined) {
      this.runs += 1;
      try {
        await this.options.run(next);
      } catch (error) {
        // A failed sync must not wedge the trigger: the reason is dropped (the dirty set is still on
        // disk, so the next trigger re-pushes it) and the error surfaces in the caller's log.
        this.options.logger?.(
          `sync: ${next} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      next = this.takeQueued();
    }
  }

  /** Take the single waiting reason, if any. */
  private takeQueued(): SyncReason | undefined {
    const next = this.queued ?? undefined;
    this.queued = null;
    return next;
  }

  /**
   * Bring the periodic alarm in line with the policy: `0` minutes means "no automatic pull", which
   * must actually *clear* any existing alarm rather than being ignored.
   */
  async schedule(policy?: SyncPolicy): Promise<number> {
    const resolved = policy ?? (this.options.policy ? await this.options.policy() : null);
    const alarms = this.options.alarms;
    if (resolved === null || !alarms) return resolved?.intervalMinutes ?? 0;
    if (resolved.intervalMinutes <= 0) {
      await alarms.clear(SYNC_ALARM_NAME);
      return 0;
    }
    await alarms.create(SYNC_ALARM_NAME, { periodInMinutes: resolved.intervalMinutes });
    return resolved.intervalMinutes;
  }

  /** Stop the periodic trigger. Called when sync is turned off or the vault is locked. */
  async stop(): Promise<void> {
    this.queued = null;
    await this.options.alarms?.clear(SYNC_ALARM_NAME);
  }

  /** True when a trigger should run at all under the current policy. */
  static allows(policy: SyncPolicy, reason: SyncReason): boolean {
    if (reason === 'manual' || reason === 'unlock') return true;
    if (reason === 'startup') return policy.onStartup;
    if (reason === 'capture') return policy.onCapture;
    return policy.intervalMinutes > 0;
  }
}
