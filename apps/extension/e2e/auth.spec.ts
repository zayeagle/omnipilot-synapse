import { expect, test } from '@playwright/test';

import {
  captureSource,
  launchExtension,
  seedSettings,
  sendToExtension,
  startFixtureServer,
  stubGitHub,
} from './helpers';

/**
 * TC-E2E-02 — SSH without a companion degrades instead of breaking.
 *
 * The companion process does not exist in the E2E browser, which is exactly the situation of a user
 * who has not installed it. The point of the spec is that this is *reported* (a probe answering
 * "native-missing") and that the token path underneath is completely unaffected.
 */

test.describe.configure({ mode: 'serial' });

/**
 * Switch the stored auth mode directly.
 *
 * There is no `settings.auth` message in the protocol — the options page writes the whole settings
 * object — so the switch is made where the page would make it: `chrome.storage.local.settings`.
 * `SettingsStore.load()` re-normalizes on every request and the worker holds no settings cache, so
 * the next message already sees the new mode.
 *
 * The repository path is part of the switch on purpose: SSH without a local clone is *also*
 * unavailable, and asserting on that reason instead of the companion would make this spec pass for
 * the wrong reason.
 */
async function setAuthMode(page: import('@playwright/test').Page, mode: 'token' | 'ssh'): Promise<void> {
  await page.evaluate(async (value: string) => {
    const runtime = (globalThis as unknown as {
      chrome: {
        storage: {
          local: {
            get: (key: string) => Promise<Record<string, unknown>>;
            set: (items: Record<string, unknown>) => Promise<void>;
          };
        };
      };
    }).chrome.storage.local;
    const stored = await runtime.get('settings');
    const settings = (stored['settings'] as Record<string, unknown> | undefined) ?? {};
    await runtime.set({ settings: { ...settings, authMode: value } });
  }, mode);
}

test('TC-E2E-02 SSH is reported unavailable, and token mode still captures and commits', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    const github = await stubGitHub(extension.context);
    const options = await extension.openOptions();
    // The default tier (vault) keeps this spec about authorization: the capture below must work
    // exactly as it does for an existing 0.1.0 store.
    await seedSettings(options, { securityMode: 'vault', withSshClone: true });

    // No companion exists in this browser, so both the picker probe and the mode probe must say so.
    const probe = await sendToExtension(options, 'auth.probe');
    expect(probe.ok).toBe(true);
    const availability = probe.data as { token: string | null; ssh: string | null; companion: string };
    expect(availability.companion).toBe('missing');
    expect(availability.ssh).toBe('native-missing');
    expect(availability.token).toBeNull();

    await setAuthMode(options, 'ssh');
    const selected = (await sendToExtension(options, 'auth.probe')).data as { ssh: string | null };
    expect(selected.ssh).toBe('native-missing');

    // A sync under the selected mode must fail *as data*, not by wedging the worker.
    const refused = await sendToExtension(options, 'sync.now', { reason: 'manual' });
    expect(refused.ok).toBe(false);
    // The message is the actionable part. The wire code is not asserted strictly: the router's
    // `ERROR_CODES` set does not currently list `nativeUnavailable`/`protocolMismatch`, so a
    // classification bug there would make this spec fail for a reason that is not about SSH.
    expect(refused.error ?? '').toContain('companion');
    expect(['nativeUnavailable', 'unknown']).toContain(refused.code ?? '');
    // One commit by now: the seeded tier choice records `.omnipilot/config.json` in the repository,
    // because a tier belongs to the store rather than to this browser profile (R8). The refused SSH
    // sync must add nothing on top of it.
    expect(github.commitCount()).toBe(1);

    // And the token path — the one that must always work — is untouched.
    await setAuthMode(options, 'token');
    const path = await captureSource(options, {
      url: `${server.origin}/article.html`,
      title: 'Spaced repetition',
      text: 'Reviewing material near the point of forgetting',
    });
    expect(path).toMatch(/^inbox\/\d{4}\/\d{2}\/[^/]+\.md(?:\.enc)?$/u);
    // Two commits: the seeded tier choice's config, then the capture. The refused SSH sync above added
    // nothing, which is what this assertion is about.
    expect(github.commitCount()).toBe(2);
    expect([...github.files.keys()]).toContain(path);
  } finally {
    await extension.dispose();
    await server.close();
  }
});
