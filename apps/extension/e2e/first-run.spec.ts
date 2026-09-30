import { expect, test } from '@playwright/test';

import {
  dictText,
  eitherText,
  launchExtension,
  pageLang,
  seedSettings,
  sendToExtension,
  startFixtureServer,
  stubGitHub,
} from './helpers';

/**
 * TC-P8-E01 — the content tier is a question, not a default (T7).
 *
 * The product used to decide for the user and only mention it afterwards. This spec is what proves the
 * decision moved in front of the save: the question is on screen, 保存 is refused until it is answered,
 * and the answer ends up in the repository so every client reads the same one.
 *
 * Seeding happens in its own tab on purpose. The router budget for credential traffic is 12 requests per
 * tab per minute, and one page load spends about five of them: seeding from the tab that then saves, or
 * reloading it, pushes a legitimate save into `rateLimited`. A fresh tab keeps the spec honest — it still
 * exercises the real button in a real page.
 */
test('TC-P8-E01 the storage save is refused until the tier is answered, and the answer reaches the repository', async () => {
  const server = await startFixtureServer();
  const extension = await launchExtension();
  const github = await stubGitHub(extension.context);
  const seedTab = await extension.openOptions();
  try {
    // The only spec that leaves the question unanswered; every other one seeds it as answered.
    await seedSettings(seedTab, { securityMode: 'transparent', tierUnchosen: true });
    await seedTab.close();

    const options = await extension.openOptions();
    const lang = await pageLang(options);
    await options
      .getByRole('tab', { name: dictText(lang, 'options.tab.store'), exact: true })
      .click();

    const storeCard = options.locator('section.card').nth(1);
    const save = storeCard.locator('button.primary');
    const tierTitle = storeCard.getByText(dictText(lang, 'options.store.tier.title'), { exact: true });

    // Unanswered: the question is on screen, the save is refused, and the reason is the question itself.
    await expect(tierTitle).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(storeCard).toContainText(dictText(lang, 'options.store.tier.blocked'));

    // Answering is the only thing standing in the way: the page already probed this repository while it
    // loaded (`status.get` does that once a token exists), so the save opens the moment the question is
    // answered — which is what makes this spec about the tier and not about the probe.
    await storeCard.locator('input[type="radio"]').first().check();
    await expect(save).toBeEnabled({ timeout: 15_000 });

    // Saving answers the question: the step collapses into the one-line summary a settled page shows.
    await save.click();
    await expect(tierTitle).toBeHidden({ timeout: 15_000 });
    await expect(storeCard).toContainText(eitherText('options.store.tier.chosen'));

    // And the repository learns the same answer with its first content write.
    await sendToExtension(options, 'capture.request', {
      mode: 'selection',
      url: server.origin + '/article.html',
      title: 'A note captured after the tier was chosen',
      selection: 'a captured selection that carries the store config with it',
    });
    await expect.poll(() => github.files.has('.omnipilot/config.json'), { timeout: 20_000 }).toBe(true);
    const config = JSON.parse(github.files.get('.omnipilot/config.json') ?? '{}') as {
      security_mode?: string;
      branch?: string;
    };
    expect(config.security_mode).toBe('transparent');
    expect(config.branch).toBe('main');
  } finally {
    await extension.dispose();
    await server.close();
  }
});
