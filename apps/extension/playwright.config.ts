import { defineConfig } from '@playwright/test';

/**
 * E2E configuration.
 *
 * The extension is loaded into a persistent Chromium context (`--load-extension`), which is the only
 * way to exercise a real content script, a real service worker and the real message router together.
 * `channel: 'chromium'` selects the bundled Chromium and the new headless mode, which supports
 * extensions — a plain Chrome channel or the legacy headless mode does not.
 *
 * GitHub and the model provider are intercepted at the context level, so the suite never needs a
 * token and never touches the network.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
