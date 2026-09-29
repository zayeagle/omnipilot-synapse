import { expect, test } from '@playwright/test';

import {
  TEST_BODY_MARKER,
  TEST_PASSPHRASE,
  TEST_PAT,
  launchExtension,
  repositoryText,
  seedSettings,
  selectParagraph,
  startFixtureServer,
  stubGitHub,
} from './helpers';

/**
 * TC-E2E-01 / TC-E2E-02 — the real capture path in a real browser.
 *
 * These are the only tests that prove the pieces work together: the content script's bubble, the
 * message router, the vault, the codec and the GitHub commit sequence. GitHub is stubbed, but
 * everything up to the HTTP request is production code.
 */

test.describe.configure({ mode: 'serial' });

test('TC-E2E-01 vault mode clips a selection without ever exposing it to the host', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    const github = await stubGitHub(extension.context);
    const options = await extension.openOptions();
    await seedSettings(options, { securityMode: 'vault' });

    const page = await extension.context.newPage();
    await page.goto(`${server.origin}/article.html`);
    const selected = await selectParagraph(page);
    expect(selected).toContain('point of forgetting');

    await page.click('.omnipilot-bubble [data-action="clip"]');
    await expect(page.locator('.omnipilot-toast')).toBeVisible();
    // The UI follows the browser locale, so assert on the state marker and accept either language.
    await expect(page.locator('.omnipilot-toast')).toHaveAttribute('data-kind', 'success');
    await expect(page.locator('.omnipilot-toast')).toContainText(/Saved to Inbox|已入收件箱/u);
    await expect.poll(() => github.commitCount(), { timeout: 15_000 }).toBeGreaterThan(0);

    // The commit holds an encrypted record plus the index, and nothing else.
    const paths = [...github.files.keys()];
    expect(paths.some((path) => path.endsWith('.md.enc'))).toBe(true);
    expect(paths).toContain('index.json');

    // Nothing that left the browser reveals the selection, the title or the token.
    const transmitted = `${repositoryText(github)}\n${JSON.stringify(github.calls)}`;
    expect(transmitted).not.toContain('point of forgetting');
    expect(transmitted).not.toContain('Spaced repetition for people');
    expect(transmitted).not.toContain(TEST_PAT);
    expect(transmitted).not.toContain(TEST_PASSPHRASE);

    // The record path is opaque: an id, not a title slug.
    const recordPath = paths.find((path) => path.endsWith('.md.enc')) ?? '';
    expect(recordPath).toMatch(/^inbox\/\d{4}\/\d{2}\/[0-9a-z]{8}\.md\.enc$/u);
  } finally {
    await extension.dispose();
    await server.close();
  }
});

test('TC-E2E-02 transparent mode writes readable Markdown with the excerpt source', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    const github = await stubGitHub(extension.context);
    const options = await extension.openOptions();
    await seedSettings(options, { securityMode: 'transparent' });

    const page = await extension.context.newPage();
    await page.goto(`${server.origin}/article.html`);
    const selected = await selectParagraph(page);

    await page.click('.omnipilot-bubble [data-action="clip"]');
    await expect(page.locator('.omnipilot-toast')).toBeVisible();
    await expect.poll(() => github.commitCount(), { timeout: 15_000 }).toBeGreaterThan(0);

    const paths = [...github.files.keys()];
    const recordPath = paths.find((path) => /^inbox\/\d{4}\/\d{2}\/.+\.md$/u.test(path)) ?? '';
    expect(recordPath).not.toBe('');
    // Transparent mode keeps the readable slug, which is the trade-off the user opted into.
    expect(recordPath).toContain('spaced-repetition');

    const document = github.files.get(recordPath) ?? '';
    expect(document).toContain('kind: "source"');
    expect(document).toContain(`excerpt_of: "${server.origin}/article.html"`);
    // The stored body is whitespace-normalised, so compare against a collapsed selection.
    const collapsed = selected.replace(/\s+/gu, ' ').trim();
    expect(document).toContain(collapsed.slice(0, 40));
    expect(document).toContain('Reviewing material near the point of forgetting');
    // The selection capture must not swallow the whole page.
    expect(document).not.toContain('Fixture footer text');
    expect(TEST_BODY_MARKER).toBeTruthy();

    // The index carries identifiers and dedup keys only — never the body.
    const index = github.files.get('index.json') ?? '';
    expect(index).toContain('"kind": "source"');
    expect(index).not.toContain('point of forgetting');
  } finally {
    await extension.dispose();
    await server.close();
  }
});

test('TC-E2E-01 clipping the same selection twice does not write a second commit', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    const github = await stubGitHub(extension.context);
    const options = await extension.openOptions();
    await seedSettings(options, { securityMode: 'transparent' });

    const page = await extension.context.newPage();
    await page.goto(`${server.origin}/article.html`);

    await selectParagraph(page);
    await page.click('.omnipilot-bubble [data-action="clip"]');
    await expect.poll(() => github.commitCount(), { timeout: 15_000 }).toBe(1);

    await selectParagraph(page);
    await page.click('.omnipilot-bubble [data-action="clip"]');
    // The toast switches to the "already captured" message and the repository is untouched.
    await expect(page.locator('.omnipilot-toast')).toHaveAttribute('data-kind', 'info');
    await expect(page.locator('.omnipilot-toast')).toContainText(/Already in Inbox|已在收件箱/u);
    expect(github.commitCount()).toBe(1);
  } finally {
    await extension.dispose();
    await server.close();
  }
});
