import { describe, expect, it } from 'vitest';

import {
  DEFAULT_API_BASE,
  DEFAULT_SETTINGS,
  MAX_AUTO_LOCK_MINUTES,
  MIN_AUTO_LOCK_MINUTES,
  clampAutoLock,
  mergeSettings,
  normalizeSettings,
  parseSecrets,
  repoFullName,
  toPublicPrefs,
  type ExtensionSettings,
  type VaultStatus,
} from './settings-store';

const UNLOCKED: VaultStatus = { configured: true, unlocked: true, unlockPolicy: 'strict', expiresAt: 1, remainingMs: 1 };
const LOCKED: VaultStatus = { configured: true, unlocked: false, unlockPolicy: 'strict', expiresAt: null, remainingMs: 0 };

const SECRETS = {
  githubPat: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
  providerKey: 'sk-abcdefghijklmnopqrstuvwxyz',
};

describe('toPublicPrefs (F8 UNIT)', () => {
  it('TC-F8-U01 never carries a secret value', () => {
    const prefs = toPublicPrefs(DEFAULT_SETTINGS, SECRETS, UNLOCKED);
    const serialized = JSON.stringify(prefs);
    expect(serialized).not.toContain(SECRETS.githubPat);
    expect(serialized).not.toContain(SECRETS.providerKey);
    expect(serialized).not.toContain('sk-');
    for (const key of Object.keys(prefs)) {
      expect([
        'enabled',
        'storeKind',
        'repoFullName',
        'securityMode',
        'hasPat',
        'hasKey',
        'vaultLocked',
        'aiAuthorized',
        'authMode',
        'branch',
        'sshHost',
        'companion',
        'sync',
      ]).toContain(key);
    }
    // `sync` carries counts and a timestamp only — assert it structurally, not just by key name.
    expect(Object.keys(prefs.sync).sort()).toEqual([
      'conflicts',
    'lastFailureCode',
      'lastOutcome',
      'lastSyncAt',
      'pending',
    ]);
  });

  it('TC-F8-U01 reports presence as booleans only', () => {
    expect(toPublicPrefs(DEFAULT_SETTINGS, SECRETS, UNLOCKED)).toMatchObject({
      hasPat: true,
      hasKey: true,
      vaultLocked: false,
      storeKind: 'github',
      securityMode: 'transparent',
    });
    expect(toPublicPrefs(DEFAULT_SETTINGS, null, LOCKED)).toMatchObject({
      hasPat: false,
      hasKey: false,
      vaultLocked: true,
    });
    expect(toPublicPrefs(DEFAULT_SETTINGS, { githubPat: '', providerKey: '' }, LOCKED)).toMatchObject({
      hasPat: false,
      hasKey: false,
    });
  });

  it('TC-F8-U01 derives the repository label without leaking the prefix', () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      github: { owner: 'zayeagle', repo: 'omnipilot-synapse', pathPrefix: 'private/kb' },
    });
    expect(toPublicPrefs(settings, null, LOCKED).repoFullName).toBe('zayeagle/omnipilot-synapse');
    expect(repoFullName({ owner: '', repo: 'r' })).toBe('');
    expect(repoFullName({ owner: 'o', repo: '' })).toBe('');
  });
});

describe('normalizeSettings (F8 UNIT)', () => {
  it('TC-F8-U01 returns defaults for junk input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('TC-F8-U01 coerces corrupt fields instead of throwing', () => {
    const normalized = normalizeSettings({
      enabled: 'yes',
      aiAuthorized: 1,
      securityMode: 'plaintext',
      autoLockMinutes: -5,
      github: { owner: 7, repo: null, branch: 3, apiBase: '' },
      ai: { providerId: 9, trustedHosts: ['a', 5, null] },
    });
    expect(normalized.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(normalized.aiAuthorized).toBe(false);
    expect(normalized.securityMode).toBe('vault');
    expect(normalized.autoLockMinutes).toBe(MIN_AUTO_LOCK_MINUTES);
    expect(normalized.github.owner).toBe('');
    expect(normalized.github.branch).toBe(DEFAULT_SETTINGS.github.branch);
    expect(normalized.github.apiBase).toBe(DEFAULT_API_BASE);
    expect(normalized.ai.providerId).toBe(DEFAULT_SETTINGS.ai.providerId);
    expect(normalized.ai.trustedHosts).toEqual(['a']);
  });

  it('TC-F8-U01 preserves valid stored values and always forces schema version 1', () => {
    const normalized = normalizeSettings({
      schemaVersion: 99,
      securityMode: 'transparent',
      autoLockMinutes: 45,
      github: { owner: 'o', repo: 'r', branch: 'kb', publicRepoAcknowledged: true },
    });
    expect(normalized.schemaVersion).toBe(1);
    expect(normalized.securityMode).toBe('transparent');
    expect(normalized.autoLockMinutes).toBe(45);
    expect(normalized.storeKind).toBe('github');
    expect(normalized.github.publicRepoAcknowledged).toBe(true);
  });
});

describe('mergeSettings (F8 UNIT)', () => {
  it('TC-F8-U01 merges nested config without mutating the input', () => {
    const base: ExtensionSettings = normalizeSettings(DEFAULT_SETTINGS);
    const merged = mergeSettings(base, {
      enabled: false,
      github: { owner: 'zayeagle', repo: 'kb' },
      ai: { providerId: 'anthropic', model: 'claude-3-5-haiku-latest', trustedHosts: ['api.anthropic.com'] },
    });
    expect(base.github.owner).toBe('');
    expect(base.ai.trustedHosts).toEqual([]);
    expect(merged.enabled).toBe(false);
    expect(merged.github.owner).toBe('zayeagle');
    expect(merged.github.branch).toBe('main');
    expect(merged.ai.providerId).toBe('anthropic');
    expect(merged.ai.trustedHosts).toEqual(['api.anthropic.com']);
  });

  it('TC-F8-U01 clamps auto-lock during merge', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { autoLockMinutes: 100_000 }).autoLockMinutes).toBe(
      MAX_AUTO_LOCK_MINUTES,
    );
    expect(mergeSettings(DEFAULT_SETTINGS, { autoLockMinutes: 0 }).autoLockMinutes).toBe(
      MIN_AUTO_LOCK_MINUTES,
    );
    expect(clampAutoLock(Number.NaN)).toBe(DEFAULT_SETTINGS.autoLockMinutes);
  });
});

describe('parseSecrets (F8 UNIT)', () => {
  it('TC-F8-U01 returns empty secrets for junk and reads valid fields', () => {
    expect(parseSecrets(null)).toEqual({ githubPat: '', providerKey: '' });
    expect(parseSecrets({ githubPat: 'p', providerKey: 'k' })).toEqual({ githubPat: 'p', providerKey: 'k' });
    expect(parseSecrets({ githubPat: 5 })).toEqual({ githubPat: '', providerKey: '' });
  });
});
