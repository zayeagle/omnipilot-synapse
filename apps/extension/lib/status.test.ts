import { describe, expect, it } from 'vitest';

import { DEFAULT_PUBLIC_PREFS, type PublicPrefs } from './public-prefs';
import {
  authLine,
  authModeLabel,
  canSaveStorageSection,
  captureReadiness,
  companionLabel,
  isPublicRepoWarning,
  readinessLabel,
  statusLine,
  syncLine,
  syncLineParts,
  syncOutcomeLabel,
  visibilityLabel,
} from './status';
import type { StoreProbe } from './store/types';

const READY_PREFS: PublicPrefs = {
  ...DEFAULT_PUBLIC_PREFS,
  enabled: true,
  repoFullName: 'zayeagle/omnipilot-synapse',
  securityMode: 'transparent',
  hasPat: true,
  hasKey: true,
  vaultLocked: false,
  aiAuthorized: false,
};

function probe(overrides: Partial<StoreProbe> = {}): StoreProbe {
  return {
    kind: 'github',
    repoFullName: 'zayeagle/omnipilot-synapse',
    visibility: 'private',
    defaultBranch: 'main',
    canPush: true,
    canWrite: true,
    checkedAt: '2026-07-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('capture readiness (F8 UNIT)', () => {
  it('TC-F8-U02 reports the most blocking reason first', () => {
    expect(captureReadiness({ prefs: READY_PREFS, probe: null })).toBe('ready');
    expect(captureReadiness({ prefs: { ...READY_PREFS, enabled: false }, probe: null })).toBe('disabled');
    expect(captureReadiness({ prefs: { ...READY_PREFS, hasPat: false }, probe: null })).toBe(
      'not-configured',
    );
    expect(captureReadiness({ prefs: { ...READY_PREFS, repoFullName: '' }, probe: null })).toBe(
      'not-configured',
    );
  });

  it('TC-F8-U03 blocks a vault-mode capture until the vault is unlocked', () => {
    const vaultPrefs: PublicPrefs = { ...READY_PREFS, securityMode: 'vault', vaultLocked: true };
    expect(captureReadiness({ prefs: vaultPrefs, probe: null })).toBe('vault-locked');
    expect(captureReadiness({ prefs: { ...vaultPrefs, vaultLocked: false }, probe: null })).toBe('ready');
    // Transparent mode does not need the vault at all.
    expect(captureReadiness({ prefs: { ...READY_PREFS, vaultLocked: true }, probe: null })).toBe('ready');
  });

  it('TC-F8-U03 blocks a public repository that has not been acknowledged', () => {
    const publicProbe = probe({ visibility: 'public', canWrite: false, warning: 'public-repo' });
    expect(captureReadiness({ prefs: READY_PREFS, probe: publicProbe })).toBe('public-repo-blocked');
    expect(captureReadiness({ prefs: READY_PREFS, probe: probe({ canWrite: true }) })).toBe('ready');
    expect(captureReadiness({ prefs: READY_PREFS, probe: publicProbe })).toBe('public-repo-blocked');
  });

  it('TC-F8-U02 labels every readiness state without leaking anything', () => {
    for (const readiness of [
      'ready',
      'disabled',
      'not-configured',
      'vault-locked',
      'public-repo-blocked',
    ] as const) {
      const label = readinessLabel(readiness);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/gh[pousr]_|sk-|token/iu);
    }
  });
});

describe('status line (F8 UNIT)', () => {
  it('TC-F8-U02 renders store, repo, mode, vault and AI state', () => {
    const line = statusLine({ prefs: READY_PREFS, probe: null });
    expect(line.store).toBe('github');
    expect(line.repo).toBe('zayeagle/omnipilot-synapse');
    expect(line.mode).toContain('透明仓');
    expect(line.vault).toBe('已解锁');
    expect(line.ai).toBe('关闭');
  });

  it('TC-F8-U02 shows "not configured" instead of an empty repository', () => {
    const line = statusLine({ prefs: { ...DEFAULT_PUBLIC_PREFS, repoFullName: '' }, probe: null });
    expect(line.repo).toBe('未配置');
    expect(line.vault).toBe('已锁定');
  });

  it('TC-F8-U02 never contains a credential-shaped substring', () => {
    const line = statusLine({
      prefs: { ...READY_PREFS, repoFullName: 'o/r', aiAuthorized: true },
      probe: probe(),
    });
    const serialized = JSON.stringify(line);
    expect(serialized).not.toMatch(/gh[pousr]_|sk-|github_pat_|Bearer/u);
    expect(line.ai).toBe('已授权');
  });
});

describe('visibility surfaces (F8 UNIT)', () => {
  it('TC-F8-U03 raises the public warning only for a public repository', () => {
    expect(isPublicRepoWarning(probe({ visibility: 'public' }))).toBe(true);
    expect(isPublicRepoWarning(probe({ visibility: 'private' }))).toBe(false);
    expect(isPublicRepoWarning(probe({ visibility: 'internal' }))).toBe(false);
    expect(isPublicRepoWarning(null)).toBe(false);
  });

  it('TC-F8-U03 blocks saving storage settings until a public repo is acknowledged', () => {
    const publicProbe = probe({ visibility: 'public', canWrite: false });
    expect(canSaveStorageSection(publicProbe, false)).toBe(false);
    expect(canSaveStorageSection(publicProbe, true)).toBe(true);
    expect(canSaveStorageSection(probe(), false)).toBe(true);
    expect(canSaveStorageSection(probe({ canPush: false }), true)).toBe(false);
    expect(canSaveStorageSection(null, true)).toBe(false);
  });

  it('TC-F8-U03 labels every visibility value', () => {
    expect(visibilityLabel('private')).toBe('私有');
    expect(visibilityLabel('public')).toBe('公开');
    expect(visibilityLabel('internal')).toBe('内部');
    expect(visibilityLabel('unknown')).toBe('未知');
  });
});

describe('auth + sync status surface (F5 UNIT)', () => {
  it('TC-F5-U03 renders the authorization mode, the branch and the sync counts', () => {
    const prefs: PublicPrefs = {
      ...READY_PREFS,
      authMode: 'ssh',
      branch: 'trunk',
      sync: { lastSyncAt: '2026-07-09T12:00:00.000Z', lastOutcome: 'pulled', pending: 3, conflicts: 1, lastFailureCode: null },
    };
    const line = statusLine({ prefs, probe: null });
    expect(line.auth).toBe('SSH · trunk');
    expect(line.sync).toBe('2026-07-09T12:00:00.000Z · 3 待上传 · 1 冲突');
    expect(authLine({ ...prefs, branch: '' })).toBe('SSH');
    expect(authModeLabel('token')).toBe('令牌');
    expect(authModeLabel('ssh')).toBe('SSH');
    expect(syncOutcomeLabel('failed', 'en')).toBe('Last sync failed');
    expect(companionLabel('missing', 'en')).toBe('Companion not installed — SSH mode is unavailable');
    expect(syncLineParts(prefs).pending).toBe(3);
  });

  it('TC-F5-U03 shows "never" for an unsynced store and never a credential', () => {
    expect(syncLine(READY_PREFS)).toBe('从未');
    const serialized = JSON.stringify(statusLine({ prefs: { ...READY_PREFS, repoFullName: 'o/r' }, probe: null }));
    expect(serialized).not.toMatch(/gh[pousr]_|sk-|github_pat_|Bearer/u);
    expect(serialized.toLowerCase()).not.toContain('passphrase');
  });

  it('TC-F5-U03 labels the companion states without leaking a path or a key', () => {
    for (const state of ['ok', 'missing', 'mismatch'] as const) {
      const label = companionLabel(state);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/gh[pousr]_|sk-|github_pat_|Bearer|\/home|PRIVATE/u);
    }
  });
});
