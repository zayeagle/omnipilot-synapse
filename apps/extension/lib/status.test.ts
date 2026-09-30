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
  canReadRepository,
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
    // A transparent repository still needs the vault: what is locked away is the TOKEN, not the content.
    // (This used to expect ready — it encoded the bug that told a configured user to configure storage.)
    expect(captureReadiness({ prefs: { ...READY_PREFS, vaultLocked: true }, probe: null })).toBe('vault-locked');
  });

  it('TC-F8-U06 tells an SSH user to install the companion, not to configure storage', () => {
    const ssh: PublicPrefs = { ...READY_PREFS, authMode: 'ssh', hasPat: false, companion: 'missing' };
    expect(captureReadiness({ prefs: ssh, probe: null })).toBe('companion-missing');
    // The companion IS the credential in SSH mode, so the absence of a PAT must not block it (R7).
    expect(captureReadiness({ prefs: { ...ssh, companion: 'ok' }, probe: null })).toBe('ready');
    // A locked vault still blocks it when the CONTENT tier is the encrypted one.
    const vaultSsh: PublicPrefs = { ...ssh, companion: 'ok', securityMode: 'vault', vaultLocked: true };
    expect(captureReadiness({ prefs: vaultSsh, probe: null })).toBe('vault-locked');
  });

  it('TC-F8-U07 reading needs a credential, and a locked vault is what hides it (R7/R8)', () => {
    expect(canReadRepository(READY_PREFS)).toBe(true);
    // The Inbox, the proposals and the review queue all read the repository, so the vault gates them too.
    expect(canReadRepository({ ...READY_PREFS, vaultLocked: true })).toBe(false);
    expect(canReadRepository({ ...READY_PREFS, repoFullName: '' })).toBe(false);
    expect(canReadRepository({ ...READY_PREFS, hasPat: false })).toBe(false);
    // SSH reads through the companion, with no PAT and (in transparent mode) no vault key at all.
    const ssh: PublicPrefs = { ...READY_PREFS, authMode: 'ssh', hasPat: false, companion: 'ok' };
    expect(canReadRepository(ssh)).toBe(true);
    expect(canReadRepository({ ...ssh, vaultLocked: true })).toBe(true);
    expect(canReadRepository({ ...ssh, companion: 'missing' })).toBe(false);
    expect(canReadRepository({ ...ssh, securityMode: 'vault', vaultLocked: true })).toBe(false);
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
