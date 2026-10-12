import { expect, test } from '@playwright/test';

import { launchExtension, seedSettings, sendToExtension, startFixtureServer, stubGitHub } from './helpers';

/**
 * TC-E2E-09 - the owner's repository keeps everything under a path prefix (notes/), and every fixture until
 * now used an empty one, so the prefixed layout had never been exercised in a browser either. His file
 * demonstrably contains 能力 in both the title and the body, and the search still comes back empty for him.
 */
test('TC-E2E-09 finds a note under a path prefix by a word in its body', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    const github = await stubGitHub(extension.context);
    const options = await extension.openOptions();
    await seedSettings(options, { securityMode: 'transparent' });
    const patched = await sendToExtension(options, 'settings.github', {
      owner: 'zayeagle',
      repo: 'omnipilot-synapse',
      branch: 'main',
      pat: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      pathPrefix: 'notes',
    });
    expect(patched.ok).toBe(true);

    const captured = await sendToExtension(options, 'capture.request', {
      mode: 'note',
      url: server.origin + '/prefixed.html',
      title: '能力可以提升信任',
      selection: '能力可以提升我们对自己直觉的信任',
    });
    expect(captured.ok).toBe(true);
    const recordPath = (captured.data as { path?: string }).path ?? '';
    const layout = [...github.files.keys()].filter((key) => key.includes('index.json') || key.includes('/search/')).slice(0, 6);

    const synced = await sendToExtension(options, 'sync.now', { reason: 'manual' });
    const rebuilt = await sendToExtension(options, 'search.rebuild');
    const found = await sendToExtension(options, 'search.query', { text: '能力' });
    const hits = found.ok ? ((found.data as { hits?: Array<{ path: string }> }).hits ?? []) : [];
    console.log('E2E-PREFIX ' + JSON.stringify({
      recordPath,
      layout,
      synced: synced.ok,
      rebuilt: rebuilt.ok ? rebuilt.data : null,
      hits: hits.length,
      firstPath: hits[0]?.path ?? null,
    }));

    expect(recordPath.startsWith('notes/')).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    // A prefixed layout keeps the same rule: the index is on this machine, not under notes/search/.
    expect([...github.files.keys()].some((key) => key.includes('search/'))).toBe(false);
  } finally {
    await extension.dispose();
    await server.close();
  }
});
