import { describe, expect, it } from 'vitest';

import { DEFAULT_PUBLIC_PREFS, isConfigured, normalizePublicPrefs } from './public-prefs';

describe('public prefs projection (F8 UNIT)', () => {
  it('TC-F8-U01 returns safe defaults for junk input', () => {
    expect(normalizePublicPrefs(null)).toEqual(DEFAULT_PUBLIC_PREFS);
    expect(normalizePublicPrefs('nope')).toEqual(DEFAULT_PUBLIC_PREFS);
    expect(normalizePublicPrefs({})).toMatchObject({ vaultLocked: true, hasPat: false, hasKey: false });
  });

  it('TC-F8-U01 coerces each field and ignores anything unexpected', () => {
    const prefs = normalizePublicPrefs({
      enabled: false,
      repoFullName: 'zayeagle/omnipilot-synapse',
      securityMode: 'transparent',
      hasPat: true,
      hasKey: 1,
      vaultLocked: false,
      aiAuthorized: true,
      githubPat: 'leaked-token-value',
      secretVault: { cipher_b64: 'x' },
    });
    expect(prefs).toEqual({
      enabled: false,
      storeKind: 'github',
      repoFullName: 'zayeagle/omnipilot-synapse',
      securityMode: 'transparent',
      hasPat: true,
      hasKey: false,
      vaultLocked: false,
      aiAuthorized: true,
      authMode: 'token',
      branch: 'main',
      sshHost: 'github.com',
      companion: 'missing',
      sync: { lastSyncAt: null, lastOutcome: 'never', pending: 0, conflicts: 0, lastFailureCode: null },
    });
    expect(Object.keys(prefs)).toHaveLength(13);
    expect(JSON.stringify(prefs)).not.toContain('leaked-token-value');
  });

  it('TC-F8-U01 coerces the auth, branch and sync fields added by the git-sync requirement', () => {
    const prefs = normalizePublicPrefs({
      authMode: 'ssh',
      branch: 'notes',
      sshHost: 'ghe.internal',
      companion: 'ok',
      sync: { lastSyncAt: '2026-07-09T00:00:00.000Z', lastOutcome: 'pulled', pending: 3, conflicts: 1, lastFailureCode: null },
    });
    expect(prefs).toMatchObject({
      authMode: 'ssh',
      branch: 'notes',
      sshHost: 'ghe.internal',
      companion: 'ok',
      sync: { lastSyncAt: '2026-07-09T00:00:00.000Z', lastOutcome: 'pulled', pending: 3, conflicts: 1, lastFailureCode: null },
    });

    // Unknown values fall back rather than propagating something the UI cannot render.
    const junk = normalizePublicPrefs({
      authMode: 'kerberos',
      branch: '',
      companion: 'maybe',
      sync: { lastOutcome: 'exploded', pending: -5, conflicts: 'lots' },
    });
    expect(junk).toMatchObject({
      authMode: 'token',
      branch: 'main',
      companion: 'missing',
      sync: { lastOutcome: 'never', pending: 0, conflicts: 0, lastFailureCode: null },
    });
  });

  it('TC-F8-U01 only treats a repo + token as configured', () => {
    expect(isConfigured({ ...DEFAULT_PUBLIC_PREFS, repoFullName: 'o/r', hasPat: true })).toBe(true);
    expect(isConfigured({ ...DEFAULT_PUBLIC_PREFS, repoFullName: 'o/r', hasPat: false })).toBe(false);
    expect(isConfigured({ ...DEFAULT_PUBLIC_PREFS, repoFullName: '', hasPat: true })).toBe(false);
  });
});
