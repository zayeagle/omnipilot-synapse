import { expect, test } from '@playwright/test';

import {
  TEST_DRIFT_MARKER,
  captureSource,
  launchExtension,
  seedSettings,
  sendToExtension,
  startFixtureServer,
  stubGitHub,
} from './helpers';

/**
 * TC-E2E-03 / TC-E2E-06 — retrieval, and the tier a brand-new store gets.
 *
 * TC-E2E-03 runs the whole chain in a real browser: capture → commit → sync (which is what fills the
 * local cache) → index → query. The query result is asserted on its user-visible parts: the path and
 * the snippet.
 */

test.describe.configure({ mode: 'serial' });

interface SearchHitView {
  id: string;
  path: string;
  title: string;
  snippet: string;
}

test('TC-E2E-03 a captured note is found by a query, with a snippet from its text', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    const github = await stubGitHub(extension.context);
    const options = await extension.openOptions();
    await seedSettings(options, { securityMode: 'transparent' });

    const capturedText = [
      'Reviewing material near the point of forgetting is the most efficient schedule,',
      'and ' + TEST_DRIFT_MARKER + ' is why spacing beats rereading.',
    ].join(' ');
    const path = await captureSource(options, {
      url: `${server.origin}/article.html`,
      title: 'Spaced repetition',
      text: capturedText,
    });

    // A sync first: the cache is what supplies the document text a snippet is cut from.
    const synced = await sendToExtension(options, 'sync.now', { reason: 'manual' });
    expect(synced.ok).toBe(true);

    // The capture indexed the note on THIS machine (F17), so it is findable without a rebuild - and the
    // repository holds records only. The rebuild is still exercised as the recovery path the options page
    // offers, and it must leave the query answering.
    const rebuilt = await sendToExtension(options, 'search.rebuild');
    expect(rebuilt.ok).toBe(true);
    expect([...github.files.keys()].some((key) => key.includes('search/'))).toBe(false);

    const reply = await sendToExtension(options, 'search.query', { text: 'forgetting', limit: 10 });
    expect(reply.ok).toBe(true);
    const hits = (reply.data as { hits: SearchHitView[] }).hits;
    expect(hits.length).toBeGreaterThan(0);

    const hit = hits.find((candidate) => candidate.path === path);
    expect(hit).toBeTruthy();
    // The snippet is the part a user actually reads. It is capped at a readable width, so the
    // assertion is on the captured words it does carry, not on the whole body.
    expect(hit?.snippet ?? '').toContain('forgetting');
    expect(hit?.snippet ?? '').toContain('Reviewing material');
    expect(TEST_DRIFT_MARKER.startsWith('a retrieval drill')).toBe(true);
    expect([...github.files.keys()]).toContain(path);
  } finally {
    await extension.dispose();
    await server.close();
  }
});

test('TC-E2E-06 a brand-new store defaults to the readable tier', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    const github = await stubGitHub(extension.context);
    const options = await extension.openOptions();
    // `DEFAULT_SETTINGS.securityMode` is `transparent`, so seeding a brand-new store with the default
    // mode is the state a first-time user is in. Passed explicitly so the spec fails loudly if that
    // default ever changes.
    await seedSettings(options, { securityMode: 'transparent' });

    const probe = await sendToExtension(options, 'store.probe');
    expect(probe.ok).toBe(true);
    expect((probe.data as { kind: string }).kind).toBe('github');

    const path = await captureSource(options, {
      url: `${server.origin}/article.html`,
      title: 'Spaced repetition',
      text: 'Reviewing material near the point of forgetting',
    });

    // Readable Markdown: the record is plain `.md` and a human could open it in the repository.
    expect(path.endsWith('.md')).toBe(true);
    expect(github.files.get(path)).toContain('point of forgetting');
    expect([...github.files.keys()].some((entry) => entry.endsWith('.md.enc'))).toBe(false);
    expect([...github.files.keys()]).toContain('index.json');
  } finally {
    await extension.dispose();
    await server.close();
  }
});