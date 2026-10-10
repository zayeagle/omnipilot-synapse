import { describe, expect, it } from 'vitest';

import { normalizeSyncResult } from './format';

/**
 * F14 — a reply that is not understood is not a failure.
 *
 * `sync.now` answers `{ report, prefs }`. Reading the outcome at the top level matched nothing, and the
 * fallback was `failed`, so the owner saw "last sync failed" after every attempt while the sync row said it
 * had never run. These cases pin the unwrapping and, more importantly, that an unknown shape stays unknown.
 */
describe('normalizeSyncResult (F14 UNIT)', () => {
  it('TC-F14-U01 reads the report out of the message reply', () => {
    const view = normalizeSyncResult({ report: { outcome: 'upToDate', pulled: 0, pushed: 0 }, prefs: {} });
    expect(view.outcome).toBe('upToDate');
    expect(view.upToDate).toBe(true);
  });

  it('TC-F14-U02 an unrecognised reply is unknown, never a failure', () => {
    expect(normalizeSyncResult({}).outcome).toBe('');
    expect(normalizeSyncResult(null).outcome).toBe('');
    expect(normalizeSyncResult({ report: { outcome: 'nonsense' } }).outcome).toBe('');
    // A bare report is still accepted, so both shapes keep working.
    expect(normalizeSyncResult({ outcome: 'pulled', pulled: 2 }).outcome).toBe('pulled');
  });
});
