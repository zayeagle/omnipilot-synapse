import { describe, expect, it } from 'vitest';

import { hostOfEndpoint } from '../providers';
import { trustedHostsOf } from './format';

/**
 * The trust acknowledgement round trip.
 *
 * The bug these pin: the tick was SAVED into ai.trustedHosts but never read back, so the box rendered
 * unticked after every load, the save stayed blocked for a custom endpoint, and the user ticked it again
 * forever. A stored value with no render path is not stored as far as the user is concerned.
 */
describe('trusted endpoints render (F5 UNIT)', () => {
  it('TC-F5-U07 reads the stored acknowledgements, and ignores junk', () => {
    expect(trustedHostsOf({ ai: { trustedHosts: ['ai-kas.kso.net'] } })).toEqual(['ai-kas.kso.net']);
    expect(trustedHostsOf({ ai: { trustedHosts: ['ai-kas.kso.net', '', 7] } })).toEqual(['ai-kas.kso.net']);
    expect(trustedHostsOf({ ai: {} })).toEqual([]);
    expect(trustedHostsOf({})).toEqual([]);
    expect(trustedHostsOf(null)).toEqual([]);
  });

  it('TC-F5-U08 compares by host, so a path or a query never breaks the match', () => {
    expect(hostOfEndpoint('https://ai-kas.kso.net/codeplan/v1')).toBe('ai-kas.kso.net');
    expect(hostOfEndpoint('  https://AI-Kas.kso.net/v1?x=1  ')).toBe('ai-kas.kso.net');
    expect(hostOfEndpoint('')).toBe('');
    expect(hostOfEndpoint(null)).toBe('');
    expect(hostOfEndpoint('not a url')).toBe('');
  });
});
