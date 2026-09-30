import { expect, test, type Page } from '@playwright/test';

import {
  dictText,
  eitherText,
  launchExtension,
  openPopup,
  pageLang,
  seedSettings,
  sendToExtension,
  startFixtureServer,
  stubGitHub,
  type GitHubStub,
} from './helpers';

/**
 * TC-P9-E01 — the reference journey: capture → distill → accept → the review queue.
 *
 * The promise being tested is that a captured source becomes something the user can be reminded of,
 * and that nothing in the chain is a dead end. It also covers the empty state a fresh install shows:
 * "nothing is waiting for your decision" is a sentence, not an error.
 */

test.describe.configure({ mode: 'serial' });

const CARD_TITLE = 'Spaced repetition scheduling';

async function waitForCommit(stub: GitHubStub, count: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (stub.commitCount() < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(stub.commitCount(), 'the worker committed').toBeGreaterThanOrEqual(count);
}

async function openAndSettle(extension: Awaited<ReturnType<typeof launchExtension>>): Promise<Page> {
  const popup = await openPopup(extension);
  const loaded = popup.waitForEvent('load');
  await popup.goto('chrome-extension://' + extension.extensionId + '/popup.html');
  await loaded;
  await popup.waitForLoadState('networkidle');
  return popup;
}

test('TC-P9-E01 capture, distill, accept — and the accepted item appears in the review queue', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    const github = await stubGitHub(extension.context, { withAi: true });
    const options = await extension.openOptions();
    await seedSettings(options, { securityMode: 'transparent', withAi: true });

    // 1. Capture a source and distil it — the proposal card is written, the source is untouched.
    const captured = await sendToExtension(options, 'capture.request', {
      mode: 'selection',
      url: server.origin + '/article.html',
      title: 'Spaced repetition',
      selection: 'Reviewing material near the point of forgetting',
      distill: true,
    });
    expect(captured.ok).toBe(true);
    await waitForCommit(github, 2);
    const pendingPath = [...github.files.keys()].find((path) => path.startsWith('cards/pending/')) ?? '';
    expect(pendingPath).not.toBe('');

    // 2. The popup lists the proposal and accepts it — the human decision, in the real surface.
    const popup = await openAndSettle(extension);
    const lang = await pageLang(popup);
    // The proposals live behind a tab now: three lists, one pane at a time.
    await popup.getByRole('tab', { name: dictText(lang, 'popup.pending'), exact: true }).click();
    const card = popup.locator('ul.pending li.pending-card');
    await expect(card).toHaveCount(1);
    await expect(card.first()).toContainText(CARD_TITLE);
    await card
      .first()
      .getByRole('button', { name: dictText(lang, 'popup.cardAccept'), exact: true })
      .click();
    await waitForCommit(github, 3);

    // 3. Accepting is what creates the review record — the queue cannot be an afterthought.
    expect(github.files.get('review/state.json')).toBeTruthy();

    // 4. Reopen the popup: the review queue the user sees now holds the accepted note.
    const reopened = await openAndSettle(extension);
    await expect(reopened.locator('ul.due li.due-item')).toHaveCount(1);
    await expect(reopened.locator('ul.due li.due-item').first()).toContainText('cards/');
    await expect(reopened.locator('ul.due li.due-item').first()).toContainText(
      eitherText('popup.dueToday'),
    );
  } finally {
    await extension.dispose();
    await server.close();
  }
});

test('TC-P9-E01 a fresh install with no accepted cards shows the empty state instead of an error', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    await stubGitHub(extension.context);
    const options = await extension.openOptions();
    await seedSettings(options, { securityMode: 'transparent' });

    const popup = await openAndSettle(extension);
    // Nothing pending, nothing due: two sentences, and no failure line.
    await expect(popup.locator('ul.pending')).toContainText(eitherText('popup.pendingEmpty'));
    await expect(popup.locator('ul.due li.due-item')).toHaveCount(0);
    await expect(popup.locator('ul.pending li.pending-card')).toHaveCount(0);
    await expect(popup.locator('.pending-result')).toHaveText('');
    await expect(popup.locator('.pending-hint')).toBeHidden();
    await expect(popup.locator('.toast')).toBeHidden();
    expect(server.origin.startsWith('http://127.0.0.1:')).toBe(true);
  } finally {
    await extension.dispose();
    await server.close();
  }
});
