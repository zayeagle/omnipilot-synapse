import { expect, test, type Page } from '@playwright/test';

import {
  TEST_DRIFT_MARKER,
  captureSource,
  dictText,
  launchExtension,
  localPathsFromCache,
  pageLang,
  seedSettings,
  sendToExtension,
  retextRemoteRecord,
  soleManifestItem,
  startFixtureServer,
  stubGitHub,
  testBodyOf,
  type GitHubStub,
} from './helpers';

/**
 * TC-E2E-01 / TC-E2E-04 / TC-E2E-05 — the sync engine, end to end.
 *
 * These specs drive `sync.now` through the real message router, so every assertion below is about
 * what a real service worker actually did against a repository it believes is GitHub: the manifest
 * read, the diff, the pull, the conflict copy and the single commit.
 *
 * The specs drive the message API rather than the popup, because sync has no UI of its own — the
 * popup only reshapes the very same report.
 */

test.describe.configure({ mode: 'serial' });

interface SyncReportView {
  outcome: string;
  pulled: number;
  pushed: number;
  removed: number;
  conflicts: string[];
  pending: number;
}

/** `sync.now` returns the report in `data.report`; the prefs ride along for the status row. */
async function runSync(page: Page, reason = 'manual'): Promise<SyncReportView> {
  const reply = await sendToExtension(page, 'sync.now', { reason });
  if (!reply.ok) throw new Error('sync failed: ' + JSON.stringify(reply));
  return (reply.data as { report: SyncReportView }).report;
}

/**
 * Make a real local edit to a record the cache already holds, and mark it pending.
 *
 * There is no note-editing UI in this requirement, so the "the user changed it locally" half of a
 * conflict has to be simulated. It is simulated at the only place the engine can observe it — the
 * cache the worker owns (`chrome.storage.local`-independent IndexedDB at the extension origin, so
 * the page and the service worker see one database) — which keeps the remote half of the scenario
 * a genuine commit through the stub. The worker reads the cache per request, so a write here is
 * visible to the very next sync.
 */
async function editCachedRecordLocally(
  page: Page,
  path: string,
  edit: { title: string; body: string; capturedAt: string },
): Promise<void> {
  const outcome = await page.evaluate(
    async (input: { path: string; title: string; body: string; capturedAt: string }) => {
      const open = (globalThis as unknown as {
        indexedDB: { open: (name: string, version: number) => IDBOpenDBRequest };
      }).indexedDB.open('omnipilot-sync', 1);
      const ready = new Promise<IDBDatabase>((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const db = await ready;
      const read = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
        const request = db
          .transaction('records', 'readonly')
          .objectStore('records')
          .get(input.path);
        request.onsuccess = () => resolve(request.result as Record<string, unknown> | undefined);
        request.onerror = () => reject(request.error);
      });
      if (!read) return { edited: false as const };
      const record = { ...(read['record'] as Record<string, unknown>) };
      record['title'] = input.title;
      record['body'] = input.body;
      record['captured_at'] = input.capturedAt;
      const next = { ...read, record, updatedAt: input.capturedAt };
      await new Promise<void>((resolve, reject) => {
        const request = db
          .transaction('records', 'readwrite')
          .objectStore('records')
          .put(next);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const request = db
          .transaction('dirty', 'readwrite')
          .objectStore('dirty')
          .put(true, 'dirty:' + input.path);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      return { edited: true as const };
    },
    { path, ...edit },
  );
  if (!outcome.edited) throw new Error('no cached record at ' + path + ' to edit locally');
}

test('TC-E2E-01 a change made in the repository while the extension was idle is pulled on the next sync', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    const github = await stubGitHub(extension.context);
    const options = await extension.openOptions();
    // Readable mode: these specs are about reconciliation, not about the vault codec, and plaintext
    // records are what lets an assertion read the committed document.
    await seedSettings(options, { securityMode: 'transparent' });

    // 1. Capture one note directly into the repository (the cache knows nothing about it yet).
    await captureSource(options, {
      url: `${server.origin}/article.html`,
      title: 'Spaced repetition',
      text: 'Reviewing material near the point of forgetting',
    });

    // 2. First sync: an empty cache sees the whole repository as remote drift and pulls it.
    const baseline = await runSync(options);
    expect(baseline.outcome).toBe('pulled');
    expect(baseline.pulled).toBe(1);
    expect(baseline.pushed).toBe(0);

    // 3. Somebody changes the repository while the extension sits idle. The edit is a real commit
    //    through the stub, so the manifest the worker reads is one a Git host could really serve.
    const edited = soleManifestItem(github);
    const path = edited.path;
    const remoteBody = TEST_DRIFT_MARKER + ' — rewritten on another machine.';
    retextRemoteRecord(github, path, remoteBody, '2099-01-01T00:00:00.000Z');

    // 4. The next sync is the one that notices: the local cache never saw that version.
    const drift = await runSync(options);
    expect(drift.outcome).toBe('pulled');
    expect(drift.pulled).toBe(1);
    expect(drift.pushed).toBe(0);

    // The cache is where "pulled" becomes observable to the rest of the product: the synced note is
    // now local, and the search index built from it answers for the text that only ever existed in
    // the repository.
    expect(await localPathsFromCache(options, github)).toEqual([path]);
    const rebuilt = await sendToExtension(options, 'search.rebuild');
    expect(rebuilt.ok).toBe(true);
    const found = await sendToExtension(options, 'search.query', { text: 'rewritten', limit: 10 });
    expect(found.ok).toBe(true);
    const hits = (found.data as { hits: Array<{ path: string }> }).hits;
    expect(hits.map((candidate) => candidate.path)).toContain(path);
  } finally {
    await extension.dispose();
    await server.close();
  }
});

test('TC-E2E-04 an immediately repeated sync is up to date and creates no second commit', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    const github = await stubGitHub(extension.context);
    const options = await extension.openOptions();
    await seedSettings(options, { securityMode: 'transparent' });

    await captureSource(options, {
      url: `${server.origin}/article.html`,
      title: 'Spaced repetition',
      text: 'Reviewing material near the point of forgetting',
    });

    const first = await runSync(options);
    expect(first.pulled).toBe(1);
    const afterFirst = github.commitCount();

    // Nothing changed anywhere: the second run must recognise its own head and stop.
    const second = await runSync(options);
    expect(second.outcome).toBe('upToDate');
    expect(second.pulled).toBe(0);
    expect(second.pushed).toBe(0);
    expect(second.pending).toBe(0);
    // "No commit" is the assertion that matters: an `upToDate` that still wrote would be a no-op
    // only in name.
    expect(github.commitCount()).toBe(afterFirst);
  } finally {
    await extension.dispose();
    await server.close();
  }
});

test('TC-E2E-05 the same note changed on both sides keeps both versions in the repository', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    const github = await stubGitHub(extension.context);
    const options = await extension.openOptions();
    await seedSettings(options, { securityMode: 'transparent' });

    await captureSource(options, {
      url: `${server.origin}/article.html`,
      title: 'Spaced repetition',
      text: 'Reviewing material near the point of forgetting',
    });
    await runSync(options);

    // Local edit: the cache now holds a version the repository has never seen, and the path is dirty.
    const item = soleManifestItem(github);
    const path = item.path;
    const localBody = 'my own rewrite that must not be lost';
    await editCachedRecordLocally(options, path, {
      title: 'My own rewrite',
      body: localBody,
      capturedAt: '2099-01-02T00:00:00.000Z',
    });

    // Remote edit of the *same* path: a real commit (new body, new `content_key`, new timestamp).
    const remoteBody = 'the remote rewrite that keeps the path';
    retextRemoteRecord(github, path, remoteBody, '2099-01-01T00:00:00.000Z');

    const report = await runSync(options);
    expect(report.outcome).toBe('conflict');
    expect(report.conflicts).toEqual([path]);
    expect(report.pulled).toBe(1);
    expect(report.pushed).toBe(1);

    const paths = [...github.files.keys()];
    const conflictPath = paths.find((candidate) => candidate.includes('.conflict-')) ?? '';
    // The copy keeps the stem and the extension: it has to be a sibling a human can find.
    expect(conflictPath).toMatch(new RegExp('^inbox/\\d{4}/\\d{2}/[^/]+\\.conflict-\\d{12}\\.md$', 'u'));
    expect(conflictPath.replace(/\.conflict-\d{12}/u, '')).toBe(path);
    // Both versions survive: the remote keeps the original path, ours lives beside it.
    // Compared as bodies: both documents carry the same frontmatter, so the *text* is the evidence.
    expect(testBodyOf(github.files.get(path) ?? '')).toBe(remoteBody);
    expect(testBodyOf(github.files.get(conflictPath) ?? '')).toBe(localBody);
    // The original still holds the remote version, not ours.
    expect(testBodyOf(github.files.get(path) ?? '')).not.toContain(localBody);

    const status = await sendToExtension(options, 'sync.status');
    const state = (status.data as { state: { lastOutcome: string; conflicts: string[] } }).state;
    expect(state.lastOutcome).toBe('conflict');
    expect(state.conflicts).toEqual([path]);
  } finally {
    await extension.dispose();
    await server.close();
  }
});
/* ------------------------------------------------------------------ *
 * TC-P4-E01 — resolving a conflict, three ways (F4)
 * ------------------------------------------------------------------ */

interface ConflictFixture {
  server: Awaited<ReturnType<typeof startFixtureServer>>;
  extension: Awaited<ReturnType<typeof launchExtension>>;
  github: GitHubStub;
  options: Page;
  /** The original path — the remote version holds it until the user decides. */
  path: string;
  /** Our version's sibling, written by the engine beside the original. */
  conflictPath: string;
  localBody: string;
  remoteBody: string;
}

/**
 * Produce a real conflict — one note changed in the cache AND committed differently to the repository.
 *
 * The same shape as TC-E2E-05 above, because a resolution surface can only be tested against a conflict
 * the engine actually recorded. Seeding happens in its own tab: the router's credential budget is 12
 * requests per tab per minute, and a spec that both seeds and decides spends it twice.
 */
async function createConflict(): Promise<ConflictFixture> {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  const github = await stubGitHub(extension.context);
  const seedTab = await extension.openOptions();
  await seedSettings(seedTab, { securityMode: 'transparent' });
  await seedTab.close();

  const options = await extension.openOptions();
  await captureSource(options, {
    url: server.origin + '/article.html',
    title: 'Spaced repetition',
    text: TEST_DRIFT_MARKER,
  });
  await runSync(options);

  const path = soleManifestItem(github).path;
  const localBody = 'my own rewrite that must not be lost';
  const remoteBody = 'the remote rewrite that keeps the path';
  await editCachedRecordLocally(options, path, {
    title: 'My own rewrite',
    body: localBody,
    capturedAt: '2099-01-02T00:00:00.000Z',
  });
  retextRemoteRecord(github, path, remoteBody, '2099-01-01T00:00:00.000Z');

  const report = await runSync(options);
  if (report.outcome !== 'conflict') {
    throw new Error('expected a conflicted sync, got ' + report.outcome);
  }
  const conflictPath =
    [...github.files.keys()].find((candidate) => candidate.includes('.conflict-')) ?? '';
  if (conflictPath.length === 0) throw new Error('the engine recorded no conflict sibling');
  return { server, extension, github, options, path, conflictPath, localBody, remoteBody };
}

/**
 * Open the 同步 tab and return the page's language.
 *
 * The tab re-reads the status when it is activated, because a background sync can record a conflict while
 * the page sits open — without that, this spec would be asserting on a screen that cannot be right.
 */
async function openSyncTab(options: Page): Promise<string> {
  const lang = await pageLang(options);
  await options.getByRole('tab', { name: dictText(lang, 'options.tab.sync'), exact: true }).click();
  return lang;
}

test('TC-P4-E01 keep-mine puts our version back at the original path and archives the remote one', async () => {
  const fixture = await createConflict();
  const { server, extension, github, options, path, conflictPath, localBody, remoteBody } = fixture;
  try {
    const lang = await openSyncTab(options);
    const card = options.locator('section.card', {
      hasText: dictText(lang, 'options.sync.conflicts.title'),
    });

    // The conflict is listed with both paths, and the three resolutions are all offered.
    await expect(card).toContainText(path);
    await expect(card).toContainText(conflictPath);
    for (const key of [
      'options.sync.conflict.keepMine',
      'options.sync.conflict.keepTheirs',
      'options.sync.conflict.keepBoth',
    ]) {
      await expect(card.getByRole('button', { name: dictText(lang, key), exact: true })).toBeVisible();
    }

    await card
      .getByRole('button', { name: dictText(lang, 'options.sync.conflict.keepMine'), exact: true })
      .click();
    // The decision lands immediately: the row leaves the list rather than waiting for another sync.
    await expect(
      card.getByRole('button', { name: dictText(lang, 'options.sync.conflict.keepMine'), exact: true }),
    ).toHaveCount(0, { timeout: 15_000 });
    await expect(card).toContainText(dictText(lang, 'options.sync.conflicts.empty'));
    console.log('DIAG path=' + testBodyOf(github.files.get(path) ?? 'MISSING'));
    console.log('DIAG archive=' + testBodyOf(github.files.get('archive/conflicts/' + path) ?? 'MISSING'));
    console.log('DIAG sibling=' + (github.files.get(conflictPath) ?? 'MISSING').slice(0, 60));

    // Ours is back at the original path, and theirs was archived — not deleted, not overwritten.
    expect(testBodyOf(github.files.get(path) ?? '')).toContain(localBody);
    expect(testBodyOf(github.files.get('archive/conflicts/' + path) ?? '')).toContain(remoteBody);
    // The sibling is a signpost now, and it says where the content went.
    expect(github.files.get(conflictPath) ?? '').toContain('<!-- omnipilot:tombstone -->');
  } finally {
    await extension.dispose();
    await server.close();
  }
});

test('TC-P4-E01 keep-both decides without writing and leaves both versions in the repository', async () => {
  const fixture = await createConflict();
  const { server, extension, github, options, path, conflictPath, localBody, remoteBody } = fixture;
  try {
    const commitsBefore = github.commitCount();
    const lang = await openSyncTab(options);
    const card = options.locator('section.card', {
      hasText: dictText(lang, 'options.sync.conflicts.title'),
    });
    await expect(card).toContainText(path);

    await card
      .getByRole('button', { name: dictText(lang, 'options.sync.conflict.keepBoth'), exact: true })
      .click();
    await expect(card).toContainText(dictText(lang, 'options.sync.conflicts.empty'), { timeout: 15_000 });

    // Choosing 'both' decides without touching the repository — the one action a locked vault can take.
    expect(github.commitCount()).toBe(commitsBefore);
    expect(testBodyOf(github.files.get(path) ?? '')).toContain(remoteBody);
    expect(testBodyOf(github.files.get(conflictPath) ?? '')).toContain(localBody);
  } finally {
    await extension.dispose();
    await server.close();
  }
});
