/**
 * The floating window's memory.
 *
 * Reloading the extension revokes its pages, and the window we opened is a plain browser window, so it is
 * left showing the new tab page while the id we recorded still points at it. Recording that id is what
 * makes the repair possible - and it has to live in `local` storage, because an extension reload clears
 * `session` storage, which is exactly when the repair is needed.
 */

import { browser } from 'wxt/browser';

export const FLOATING_WINDOW_KEY = 'omnipilot.floatingWindowId';
export const FLOATING_WINDOW_URL = '/popup.html?mode=window';

/** Remember which window we opened. Bookkeeping only: a failure here must never fail the window itself. */
export async function rememberFloatingWindowId(id: number): Promise<void> {
  try {
    await browser.storage.local.set({ [FLOATING_WINDOW_KEY]: id });
  } catch {
    // Nothing to do: the window is open either way.
  }
}

export async function readFloatingWindowId(): Promise<number | null> {
  try {
    const stored = await browser.storage.local.get(FLOATING_WINDOW_KEY);
    const id = stored[FLOATING_WINDOW_KEY];
    return typeof id === 'number' && Number.isInteger(id) ? id : null;
  } catch {
    return null;
  }
}

/** Focus the window we opened, repairing its page if the extension was reloaded under it. */
export async function focusOrRepairFloatingWindow(id: number): Promise<boolean> {
  const url = browser.runtime.getURL(FLOATING_WINDOW_URL);
  const target = await browser.windows.get(id, { populate: true });
  const tab = target.tabs?.[0];
  if (typeof tab?.id !== 'number') return false;
  // `windows.update` cannot navigate; its tab can. That navigation IS the repair.
  if (tab.url !== url) await browser.tabs.update(tab.id, { url });
  await browser.windows.update(id, { focused: true });
  return true;
}

/** Called at worker start: an extension reload must not leave the console showing a foreign page. */
export async function repairFloatingWindow(): Promise<void> {
  const id = await readFloatingWindowId();
  if (id === null) return;
  try {
    await focusOrRepairFloatingWindow(id);
  } catch {
    // Closed by hand, or gone: nothing to repair, and nothing to report.
  }
}
