import { expect, test } from '@playwright/test';

import { dictText, launchExtension, pageLang, seedSettings, stubGitHub } from './helpers';

/**
 * TC-F8-E01 / TC-F8-E02 — what the console says, and where it says it.
 *
 * E01: a request in flight is a state of the console, not of one button. The status line carries it and
 * every action keeps its own caption; renaming the button was wrong twice over — the row stopped naming
 * the action that was unavailable, and the line underneath went on claiming 可以剪藏 at the same time.
 *
 * E02: the action row is a segmented control. One entry carries the emphasis and the area below follows
 * it, instead of a fixed default painted blue while nothing was open.
 *
 * GitHub answers are held open so an in-flight window is observable instead of a race, and every
 * assertion is made against the SHIPPED text for the page's own language.
 */

async function openPopupWithStore(): Promise<
  Awaited<ReturnType<typeof launchExtension>> & { popup: import('@playwright/test').Page; lang: 'en' | 'zh_CN' }
> {
  const extension = await launchExtension();
  await stubGitHub(extension.context, { delayMs: 400 });
  const options = await extension.openOptions();
  await seedSettings(options, { securityMode: 'transparent' });

  const popup = await extension.context.newPage();
  const loaded = popup.waitForEvent('load');
  await popup.goto('chrome-extension://' + extension.extensionId + '/popup.html');
  await loaded;
  const lang = await pageLang(popup);
  return { ...extension, popup, lang };
}

test('TC-F8-E01 the in-flight state is on the status line, never on a button', async () => {
  const extension = await launchExtension();
  try {
    const github = await stubGitHub(extension.context, { delayMs: 400 });
    const options = await extension.openOptions();
    await seedSettings(options, { securityMode: 'transparent' });

    const popup = await extension.context.newPage();
    const loaded = popup.waitForEvent('load');
    await popup.goto('chrome-extension://' + extension.extensionId + '/popup.html');
    await loaded;

    const lang = await pageLang(popup);
    const notice = popup.locator('p.notice');
    const refresh = popup.getByRole('button', { name: dictText(lang, 'popup.refresh'), exact: true });

    // Settled: the line answers the one question the console exists to answer.
    await expect(notice).toHaveAttribute('data-kind', 'ok', { timeout: 20_000 });
    await expect(notice).toHaveText(dictText(lang, 'popup.ready'));

    await refresh.click();

    // Busy: the status line is the place that says so...
    await expect(notice).toHaveAttribute('data-kind', 'working');
    await expect(notice).toHaveText(dictText(lang, 'popup.working'));
    // ...and no action has taken the state as its own caption.
    await expect(
      popup.getByRole('button', { name: dictText(lang, 'popup.working'), exact: true }),
    ).toHaveCount(0);
    // A6 (2026-10-10): the clip buttons are gone - clipping a selection is a page gesture now - and the
    // composer is on screen from the start. The panel's one action is its save; the property this case pins is
    // that no action ever takes the in-flight state as its own caption.
    await expect(
      popup.getByRole('button', { name: dictText(lang, 'popup.noteSave'), exact: true }),
    ).toHaveCount(1);

    // Over: the line goes back to the readiness answer instead of staying on "处理中…".
    await expect(notice).toHaveAttribute('data-kind', 'ok', { timeout: 20_000 });
    await expect(notice).toHaveText(dictText(lang, 'popup.ready'));
    expect(github.calls.length).toBeGreaterThan(0);
  } finally {
    await extension.dispose();
  }
});

test('TC-F8-E02 the composer is on screen without a click, and its save is the one action', async () => {
  const { popup, lang, ...extension } = await openPopupWithStore();
  try {
    // A6 (2026-10-10): the owner asked for the input to be there immediately, so the 记笔记 button and its
    // cancel are gone. What is pinned is the property that replaced them: reaching the composer costs no
    // click, and the panel offers exactly one action - no clip buttons have crept back either.
    const compose = popup.locator('section.compose');
    await expect(compose).toBeVisible();
    await expect(compose.locator('textarea')).toBeVisible();
    await expect(
      popup.getByRole('button', { name: dictText(lang, 'popup.noteSave'), exact: true }),
    ).toHaveCount(1);
    await expect(
      popup.getByRole('button', { name: dictText(lang, 'popup.writeNote'), exact: true }),
    ).toHaveCount(0);
    await expect(
      popup.getByRole('button', { name: dictText(lang, 'popup.clipPage'), exact: true }),
    ).toHaveCount(0);
  } finally {
    await extension.dispose();
  }
});
