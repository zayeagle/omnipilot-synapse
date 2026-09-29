import { describe, expect, it } from 'vitest';
import type { SyncPolicy, SyncReason } from '../messages';
import { SYNC_ALARM_NAME, SyncTriggers } from './triggers';

/**
 * TC-F3-U09, TC-F3-I06 — the trigger rules.
 *
 * Two behaviours matter and both are easy to get wrong: a capture during a slow pull must not start a
 * second concurrent reconciliation, and it must not be silently dropped either. The alarm is asserted
 * too, because "interval 0" has to actually clear a scheduled alarm rather than be ignored.
 */

const POLICY: SyncPolicy = { intervalMinutes: 30, onStartup: true, onCapture: true, pullOnly: false };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SyncTriggers (F3 UNIT)', () => {
  it('TC-F3-U09 a burst during a run collapses into exactly one follow-up run', async () => {
    const gate = deferred();
    const seen: SyncReason[] = [];
    const triggers = new SyncTriggers({
      run: async (reason) => {
        seen.push(reason);
        if (seen.length === 1) await gate.promise;
      },
    });

    // `void`: a coalesced trigger resolves with the *in-flight* run, and this test deliberately keeps
    // that run blocked until the burst has arrived.
    const first = triggers.trigger('startup');
    void triggers.trigger('capture');
    void triggers.trigger('alarm');
    await Promise.resolve();
    expect(triggers.state().inFlight).toBe(true);
    expect(triggers.state().queued).toBe('capture');

    gate.resolve();
    await first;

    // The reason that arrived first while running is the one that runs; the second is coalesced away.
    expect(seen).toEqual(['startup', 'capture']);
    expect(triggers.state()).toMatchObject({ inFlight: false, queued: null, runs: 2 });
  });

  it('TC-F3-U09 a failing run does not wedge the trigger', async () => {
    const failures: string[] = [];
    let calls = 0;
    const triggers = new SyncTriggers({
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error('offline');
      },
      logger: (message) => failures.push(message),
    });

    await triggers.trigger('manual');
    await triggers.trigger('manual');

    expect(calls).toBe(2);
    expect(failures.join(' ')).toContain('offline');
  });

  it('TC-F3-I06 the alarm follows the policy, including clearing it at interval 0', async () => {
    const created: Array<{ name: string; periodInMinutes: number }> = [];
    const cleared: string[] = [];
    const triggers = new SyncTriggers({
      run: async () => undefined,
      policy: () => POLICY,
      alarms: {
        create: (name, info) => void created.push({ name, ...info }),
        clear: (name) => {
          cleared.push(name);
        },
      },
    });

    expect(await triggers.schedule()).toBe(30);
    expect(created).toEqual([{ name: SYNC_ALARM_NAME, periodInMinutes: 30 }]);

    expect(await triggers.schedule({ ...POLICY, intervalMinutes: 0 })).toBe(0);
    expect(cleared).toEqual([SYNC_ALARM_NAME]);

    await triggers.stop();
    expect(cleared).toEqual([SYNC_ALARM_NAME, SYNC_ALARM_NAME]);
  });

  it('TC-F3-I06 policy gates which reasons are allowed to run', () => {
    expect(SyncTriggers.allows(POLICY, 'manual')).toBe(true);
    expect(SyncTriggers.allows(POLICY, 'unlock')).toBe(true);
    expect(SyncTriggers.allows(POLICY, 'startup')).toBe(true);
    expect(SyncTriggers.allows(POLICY, 'capture')).toBe(true);
    expect(SyncTriggers.allows(POLICY, 'alarm')).toBe(true);

    const quiet: SyncPolicy = { intervalMinutes: 0, onStartup: false, onCapture: false, pullOnly: false };
    expect(SyncTriggers.allows(quiet, 'startup')).toBe(false);
    expect(SyncTriggers.allows(quiet, 'capture')).toBe(false);
    expect(SyncTriggers.allows(quiet, 'alarm')).toBe(false);
    // Manual and unlock are never suppressed: the user asked, or the vault just became readable.
    expect(SyncTriggers.allows(quiet, 'manual')).toBe(true);
    expect(SyncTriggers.allows(quiet, 'unlock')).toBe(true);
  });
});
