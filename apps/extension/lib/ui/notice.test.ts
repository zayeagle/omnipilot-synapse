import { describe, expect, it } from 'vitest';

import { noticeFor } from './notice';

const READY = { text: 'Ready to clip', kind: 'ok' as const };

describe('noticeFor (UNIT)', () => {
  it('shows the in-flight line while busy and gives the readiness line back afterwards', () => {
    expect(noticeFor(READY, true, 'Working…')).toEqual({ text: 'Working…', kind: 'working' });
    expect(noticeFor(READY, false, 'Working…')).toEqual(READY);
  });

  it('returns the readiness state by identity when idle, so a blocked kind survives', () => {
    const blocked = { text: 'Capture is turned off', kind: 'blocked' as const };
    expect(noticeFor(blocked, false, 'Working…')).toBe(blocked);
    expect(noticeFor(blocked, true, 'Working…').kind).toBe('working');
  });
});
