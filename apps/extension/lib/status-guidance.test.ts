import { describe, expect, it } from 'vitest';
import { ERROR_GUIDANCE, errorGuidance, syncLine } from './status';

/**
 * TC-P5-U01 / U02 — every failure the worker can report has a human answer.
 *
 * **Coverage is enforced by the compiler, not by this test**: the table is typed `Record<ErrorCode, ErrorGuidance>`,
 * so adding a code to the union without writing its guidance fails `tsc` (that is how the `unknown` row was found).
 * A runtime list would just be a second, weaker copy of the same union. What is checked here is that every row is
 * *usable*: an i18n key pair and a target the UI can wire, never a sentence that could leak an outside string.
 */
describe('failure guidance (F5 UNIT)', () => {
  it('TC-P5-U01 every row is a key pair plus an actionable target', () => {
    for (const [code, guidance] of Object.entries(ERROR_GUIDANCE)) {
      // One vocabulary: the message reuses the existing `error.<code>` family; only the action is new.
      expect(guidance.titleKey, code).toMatch(/^error\.[a-zA-Z]+$/u);
      expect(guidance.actionKey, code).toMatch(/^guidance\.[a-zA-Z]+\.action$/u);
      expect(guidance.target, code).not.toBe('');
      // Keys, not prose: a rendered sentence here would be an outside string the UI must not print.
      expect(guidance.titleKey, code).not.toContain(' ');
      expect(guidance.actionKey, code).not.toContain(' ');
    }
  });

  it('TC-P5-U01 the codes a user actually hits route somewhere useful', () => {
    // A locked vault must offer unlocking, a missing companion must offer installation, and a transient
    // network failure must offer a retry — anything else means the guidance would be decorative.
    expect(errorGuidance('locked').target).toBe('unlock');
    expect(errorGuidance('nativeUnavailable').target).toBe('companion');
    expect(errorGuidance('network').target).toBe('retry');
    expect(errorGuidance('notConfigured').target).toBe('storage');
  });

  it('TC-P5-U02 an unknown code still yields something the user can act on', () => {
    const fallback = errorGuidance('definitely-not-a-code' as never);
    expect(fallback.target).toBe('retry');
    expect(fallback.titleKey).toBe('error.unknown');
  });
});
describe('failure guidance is rendered (F5 UNIT)', () => {
  const prefs = {
    enabled: true,
    storeKind: 'github' as const,
    repoFullName: 'o/r',
    securityMode: 'transparent' as const,
    hasPat: true,
    hasKey: false,
    vaultLocked: false,
    aiAuthorized: false,
    authMode: 'token' as const,
    branch: 'main',
    sshHost: 'github.com',
    companion: 'missing' as const,
    sync: {
      lastSyncAt: '2026-09-29T12:00:00.000Z',
      lastOutcome: 'failed' as const,
      lastFailureCode: 'locked',
      pending: 0,
      conflicts: 0,
    },
  };

  it('TC-P5-U02 the status row says WHY it failed, not just that it failed', () => {
    const line = syncLine(prefs, 'zh_CN');
    // The property, not a wording: a translated sentence reaches the row and no key ever does.
    expect(line.length).toBeGreaterThan(0);
    expect(line).not.toMatch(/(?:guidance|error)\.[a-zA-Z]/u);
  });

  it('TC-P5-U02 a code we do not know still renders a sentence, never an empty row', () => {
    const odd = { ...prefs, sync: { ...prefs.sync, lastFailureCode: 'something-new' } };
    const line = syncLine(odd, 'en');
    expect(line.length).toBeGreaterThan(0);
    expect(line).not.toMatch(/(?:guidance|error)\.[a-zA-Z]/u);
  });
});