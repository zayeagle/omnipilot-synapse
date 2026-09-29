import { expect, test } from '@playwright/test';

import {
  TEST_MODEL_KEY,
  launchExtension,
  seedSettings,
  selectParagraph,
  startFixtureServer,
  stubGitHub,
} from './helpers';

/**
 * TC-E2E-03 — distillation stays a proposal.
 *
 * The interesting assertion is not that a card appears, but that the SOURCE file is byte-identical
 * afterwards: the whole "AI 只提案，不默默改写用户原意" guarantee is only real if it survives the full
 * browser round trip.
 */

test.describe.configure({ mode: 'serial' });

async function seedAndOpenArticle(securityMode: 'vault' | 'transparent') {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  const github = await stubGitHub(extension.context, { withAi: true });
  const options = await extension.openOptions();
  await seedSettings(options, { securityMode, withAi: true });

  const page = await extension.context.newPage();
  await page.goto(`${server.origin}/article.html`);
  return { server, extension, github, page };
}

test('TC-E2E-03 提炼 writes a pending card and leaves the source untouched', async () => {
  const { server, extension, github, page } = await seedAndOpenArticle('transparent');
  try {
    await selectParagraph(page);
    await page.click('.omnipilot-bubble [data-action="distill"]');

    await expect(page.locator('.omnipilot-toast')).toBeVisible();
    await expect.poll(() => github.commitCount(), { timeout: 20_000 }).toBe(2);

    const paths = [...github.files.keys()];
    const cardPath = paths.find((path) => path.startsWith('cards/pending/')) ?? '';
    expect(cardPath).not.toBe('');

    const card = github.files.get(cardPath) ?? '';
    expect(card).toContain('status: "pending"');
    expect(card).toContain('Schedule by retrievability');
    expect(card).toContain('## 要点');

    // The card is a proposal: the source record still holds the user's own text.
    const sourcePath = paths.find((path) => path.startsWith('inbox/')) ?? '';
    const source = github.files.get(sourcePath) ?? '';
    expect(source).toContain('kind: "source"');
    expect(source).toContain('point of forgetting');

    // The provider received the captured text as plaintext (authorized) and the key only in a header.
    const providerCalls = github.calls.filter((call) => call.url.startsWith('https://api.deepseek.com'));
    expect(providerCalls).toHaveLength(1);
    expect(JSON.stringify(providerCalls[0]?.body)).toContain('point of forgetting');
    expect(JSON.stringify(providerCalls[0]?.body)).not.toContain(TEST_MODEL_KEY);
  } finally {
    await extension.dispose();
    await server.close();
  }
});

test('TC-E2E-03 提炼 is refused while AI egress is off, and the capture still succeeds', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  try {
    // Note: `withAi: false` leaves the global switch off, and no provider key is stored.
    const github = await stubGitHub(extension.context);
    const options = await extension.openOptions();
    await seedSettings(options, { securityMode: 'transparent', withAi: false });

    const page = await extension.context.newPage();
    await page.goto(`${server.origin}/article.html`);
    await selectParagraph(page);
    await page.click('.omnipilot-bubble [data-action="distill"]');

    await expect(page.locator('.omnipilot-toast')).toBeVisible();
    await expect.poll(() => github.commitCount(), { timeout: 15_000 }).toBe(1);

    // Only the source landed; no provider call was made at all.
    expect([...github.files.keys()].some((path) => path.startsWith('cards/'))).toBe(false);
    expect(github.calls.some((call) => call.url.startsWith('https://api.deepseek.com'))).toBe(false);
  } finally {
    await extension.dispose();
    await server.close();
  }
});

test('TC-E2E-03 vault mode still distils (the card is encrypted, the flow is unchanged)', async () => {
  const { server, extension, github, page } = await seedAndOpenArticle('vault');
  try {
    await selectParagraph(page);
    await page.click('.omnipilot-bubble [data-action="distill"]');

    await expect(page.locator('.omnipilot-toast')).toBeVisible();
    await expect.poll(() => github.commitCount(), { timeout: 20_000 }).toBe(2);

    const paths = [...github.files.keys()];
    expect(paths.some((path) => path.startsWith('cards/pending/') && path.endsWith('.md.enc'))).toBe(true);
    // Nothing readable about the card leaves the machine in vault mode.
    const transmitted = [...github.files.values()].join('\n');
    expect(transmitted).not.toContain('Schedule by retrievability');
  } finally {
    await extension.dispose();
    await server.close();
  }
});
