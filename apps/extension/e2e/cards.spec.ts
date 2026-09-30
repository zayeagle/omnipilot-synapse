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
 * TC-P3-E01 — the proposal decision surface, in a real browser (F3 / SC-R3-01).
 *
 * A distilled card is written to `cards/pending/` by the worker; everything after that is the human's.
 * This spec is what proves the three buttons a user actually clicks are wired to the real
 * `card.decide` handler: accepting moves the card into `cards/` and creates `review/state.json`,
 * discarding archives it under `archive/cards/` without deleting anything.
 *
 * Controls are located through the DOM the popup builds (`ul.pending li.pending-card`) and matched on
 * the shipped i18n dictionaries, so the spec fails on a missing string rather than on English invented
 * here.
 */

test.describe.configure({ mode: 'serial' });

const CARD_TITLE = 'Spaced repetition scheduling';

interface Seeded {
  server: Awaited<ReturnType<typeof startFixtureServer>>;
  extension: Awaited<ReturnType<typeof launchExtension>>;
  github: GitHubStub;
  options: Page;
}

/** Boot a transparent store with AI egress authorized and a recording stub provider. */
async function seedAndOpenAiStore(): Promise<Seeded> {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  const github = await stubGitHub(extension.context, { withAi: true });
  const options = await extension.openOptions();
  await seedSettings(options, { securityMode: 'transparent', withAi: true });
  return { server, extension, github, options };
}

/**
 * Capture one source and distil it in the same round trip — the path the popup's 提炼 button takes
 * (`capture.request` with `distill: true`), so the card this spec decides about is one production wrote.
 */
async function captureAndDistill(options: Page, origin: string): Promise<void> {
  const reply = await sendToExtension(options, 'capture.request', {
    mode: 'selection',
    url: origin + '/article.html',
    title: 'Spaced repetition',
    selection: 'Reviewing material near the point of forgetting',
    distill: true,
  });
  if (!reply.ok) throw new Error('capture+distill failed: ' + JSON.stringify(reply));
}

/** Every pending card the stub repository holds — the observable half of a decision. */
function pendingCardPaths(stub: GitHubStub): string[] {
  return [...stub.files.keys()].filter((path) => path.startsWith('cards/pending/'));
}

/** Wait for the stub's commit counter to reach `count`; the commits are the deterministic signal. */
async function waitForCommit(stub: GitHubStub, count: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (stub.commitCount() < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(stub.commitCount(), 'the worker committed').toBeGreaterThanOrEqual(count);
}

/**
 * Open the popup window and wait until it has answered its first round of reads.
 *
 * The window is a real extension page: the pending list is built from a `refresh()` that resolves after
 * `load`, so the spec waits for that first paint to be quiet before asserting on it.
 */
async function openPopupAndSettle(extension: Seeded['extension']): Promise<Page> {
  const popup = await extension.context.newPage();
  const loaded = popup.waitForEvent('load');
  await popup.goto('chrome-extension://' + extension.extensionId + '/popup.html');
  await loaded;
  await popup.waitForLoadState('networkidle');
  return popup;
}

test('TC-P3-E01 accepting a proposal card moves it out of cards/pending/ and creates review/state.json', async () => {
  const { server, extension, github, options } = await seedAndOpenAiStore();
  try {
    await captureAndDistill(options, server.origin);

    // Source commit + card commit: the proposal exists before the popup is ever opened.
    await waitForCommit(github, 2);
    const pendingPath = pendingCardPaths(github)[0];
    expect(pendingPath, 'the distilled card landed in cards/pending/').toBeTruthy();
    expect(pendingPath).toMatch(/^cards\/pending\/[^/]+\.md$/u);

    const popup = await openPopupAndSettle(extension);
    const lang = await pageLang(popup);
    const pendingCard = popup.locator('ul.pending li.pending-card');

    // A pending card is listed, with the content the AI proposed and its evidence path.
    await expect(pendingCard).toHaveCount(1);
    await expect(pendingCard.first()).toContainText(CARD_TITLE);
    await expect(pendingCard.first()).toContainText('Schedule by retrievability');
    await expect(pendingCard.first()).toContainText('inbox/');
    // 接受 / 改写 / 丢弃（归档） are three peers in the shipped language — none is preselected.
    await expect(
      pendingCard.first().getByRole('button', { name: dictText(lang, 'popup.cardAccept'), exact: true }),
    ).toBeVisible();
    await expect(
      pendingCard.first().getByRole('button', { name: dictText(lang, 'popup.cardEdit'), exact: true }),
    ).toBeVisible();
    await expect(
      pendingCard.first().getByRole('button', { name: dictText(lang, 'popup.cardDiscard'), exact: true }),
    ).toBeVisible();

    await pendingCard
      .first()
      .getByRole('button', { name: dictText(lang, 'popup.cardAccept'), exact: true })
      .click();
    await waitForCommit(github, 3);

    // The card left cards/pending/ for cards/: same slug and id, different segment.
    const fileName = pendingPath.split('/').pop() ?? '';
    const confirmedPath = 'cards/' + fileName;
    expect([...github.files.keys()]).toContain(confirmedPath);
    expect(github.files.get(confirmedPath) ?? '').toContain('status: "confirmed"');

    // review/state.json is what makes an accepted card reviewable — it is born with the accept.
    const reviewState = github.files.get('review/state.json');
    expect(reviewState, 'accepting created review/state.json').toBeTruthy();
    const parsed = JSON.parse(reviewState ?? '{}') as { items?: Record<string, { id?: string }> };
    const reviewIds = Object.keys(parsed.items ?? {});
    expect(reviewIds).toHaveLength(1);
    expect(github.files.get(confirmedPath) ?? '').toContain(reviewIds[0] ?? 'no-id');

    // The decision surface re-read the list rather than patching it: the card is gone from it.
    await expect(popup.locator('ul.pending li.pending-card')).toHaveCount(0);
    await expect(popup.locator('ul.pending')).toContainText(eitherText('popup.pendingEmpty'));
    // And it says what happened, naming the repository path the worker reported.
    await expect(popup.locator('.pending-result')).toContainText(eitherText('popup.cardAccepted'));
    await expect(popup.locator('.pending-result')).toContainText(confirmedPath);
  } finally {
    await extension.dispose();
    await server.close();
  }
});

test('TC-P3-E01 discarding a proposal card archives it under archive/cards/ instead of deleting it', async () => {
  const { server, extension, github, options } = await seedAndOpenAiStore();
  try {
    await captureAndDistill(options, server.origin);
    await waitForCommit(github, 2);

    const pendingPath = pendingCardPaths(github)[0];
    expect(pendingPath).toBeTruthy();
    const before = github.files.get(pendingPath) ?? '';
    expect(before).toContain(CARD_TITLE);

    const popup = await openPopupAndSettle(extension);
    const pendingCard = popup.locator('ul.pending li.pending-card');
    await expect(pendingCard).toHaveCount(1);

    const lang = await pageLang(popup);
    await pendingCard
      .first()
      .getByRole('button', { name: dictText(lang, 'popup.cardDiscard'), exact: true })
      .click();
    await waitForCommit(github, 3);

    // Archived, not deleted: the body is byte-identical under archive/cards/ and a tombstone marks the
    // place it came from.
    const archivedPath = 'archive/cards/' + pendingPath;
    expect(github.files.get(archivedPath)).toBe(before);
    const tombstone = github.files.get(pendingPath) ?? '';
    expect(tombstone).toContain('<!-- omnipilot:tombstone -->');
    expect(tombstone).not.toBe(before);

    await expect(popup.locator('ul.pending li.pending-card')).toHaveCount(0);
    await expect(popup.locator('.pending-result')).toContainText(eitherText('popup.cardDiscarded'));
    await expect(popup.locator('.pending-result')).toContainText(archivedPath);
  } finally {
    await extension.dispose();
    await server.close();
  }
});
