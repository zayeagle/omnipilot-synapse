import { expect, test } from '@playwright/test';

import { newSourceItem } from '../lib/core/ckf';
import { createTransparentCodec } from '../lib/store/codec';

import {
  launchExtension,
  seedSettings,
  sendToExtension,
  startFixtureServer,
  stubGitHub,
} from './helpers';

/**
 * TC-E2E-08 - the owner's data path, in a real browser.
 *
 * His captures happened earlier, so the text comes back through a pull rather than a capture in this run, and
 * the text is Chinese. That is the whole difference between this spec and TC-E2E-03, and it is the case he
 * reports as "search finds nothing while the inbox shows the note".
 */
test.describe.configure({ mode: 'serial' });

test('TC-E2E-08 finds a Chinese record that was pulled from the repository', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    const github = await stubGitHub(extension.context);
    const options = await extension.openOptions();
    await seedSettings(options, { securityMode: 'transparent' });

    // A Chinese source already in the repository, with its manifest entry - exactly what a pull has to read.
    const codec = createTransparentCodec({});
    const item = newSourceItem({
      id: 'src00009',
      url: server.origin + '/cn.html',
      title: '能力可以提升信任',
      body: '能力可以提升我们对自己直觉的信任',
      capturedAt: new Date(0),
    });
    const encoded = await codec.encodeRecord(item);
    github.files.set(encoded.path, encoded.content);
    github.files.set('index.json', JSON.stringify({ schema: 1, items: { [item.id]: encoded.index } }));

    const synced = await sendToExtension(options, 'sync.now', { reason: 'manual' });
    expect(synced.ok).toBe(true);
    const rebuilt = await sendToExtension(options, 'search.rebuild');
    expect(rebuilt.ok).toBe(true);
    const found = await sendToExtension(options, 'search.query', { text: '能力' });
    expect(found.ok).toBe(true);

    const hits = (found.data as { hits?: Array<{ path: string; snippet: string }> }).hits ?? [];
    console.log('E2E-CN ' + JSON.stringify({
      recordPath: encoded.path,
      rebuilt: rebuilt.data,
      hits: hits.length,
      firstPath: hits[0]?.path ?? null,
      snippet: hits[0]?.snippet ?? null,
    }));

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBe(encoded.path);
  } finally {
    await extension.dispose();
    await server.close();
  }
});
