import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings } from './settings-store';

/**
 * The capture switch has to survive the round trip that stores it.
 *
 * The owner turns capture off and the in-page bubble keeps appearing, so the suspicion is that the write is
 * dropped somewhere between the payload and the stored settings - exactly how the trust toggle behaved. These
 * two pure functions are that somewhere.
 */
describe('the capture switch survives a write (F8 UNIT)', () => {
  it('TC-F8-U09 keeps enabled:false through merge and normalise', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { enabled: false });
    expect(merged.enabled).toBe(false);
    expect(normalizeSettings(merged).enabled).toBe(false);
    // And it comes back on.
    expect(mergeSettings({ ...DEFAULT_SETTINGS, enabled: false }, { enabled: true }).enabled).toBe(true);
  });

  it('TC-F8-U10 does not invent the switch when a payload omits it', () => {
    const merged = mergeSettings({ ...DEFAULT_SETTINGS, enabled: false }, { securityMode: 'transparent' });
    expect(merged.enabled).toBe(false);
  });
});
