import { defineConfig } from 'wxt';

/**
 * Least-privilege manifest (blueprint §5):
 * - host_permissions enumerate only the known provider hosts + GitHub.
 * - A user-supplied custom base URL needs `optional_host_permissions` granted at runtime.
 * - No `_locales`/`__MSG_*`: a plain `lib/i18n.ts` dictionary ships zh_CN + en strings instead.
 */
export default defineConfig({
  modules: [],
  manifest: {
    name: 'OmniPilot Synapse',
    description:
      'Capture web pages into your own GitHub-hosted knowledge base, with opt-in AI distillation.',
    /**
     * `nativeMessaging` is what makes the SSH mode possible at all: without it the worker cannot
     * call `connectNative`, the companion is unreachable, and the whole F2 feature degrades to
     * `nativeUnavailable`. `alarms` drives the periodic sync trigger and `unlimitedStorage` keeps
     * the decoded record cache (F3) off the quota cliff.
     */
    permissions: [
      'storage',
      'activeTab',
      'scripting',
      'contextMenus',
      'nativeMessaging',
      'alarms',
      'unlimitedStorage',
    ],
    host_permissions: [
      'https://api.github.com/*',
      'https://api.openai.com/*',
      'https://api.deepseek.com/*',
      'https://api.anthropic.com/*',
      'https://openrouter.ai/*',
      'https://spark-api-open.xf-yun.com/*',
    ],
    optional_host_permissions: ['https://*/*'],
    /**
     * Keyboard shortcuts. These MUST be declared: `browser.commands` does not exist without a
     * `commands` manifest key, and the worker registers its `onCommand` listener at top level — an
     * undefined API there throws during the worker's initial evaluation, which makes Chrome treat
     * the whole worker as failed and silently stop dispatching `runtime.onMessage` to it.
     */
    commands: {
      'clip-page': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Clip the current page into the Inbox',
      },
      'clip-selection': {
        suggested_key: { default: 'Alt+Shift+D' },
        description: 'Clip the selected text into the Inbox',
      },
    },
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      96: 'icon-96.png',
      128: 'icon-128.png',
    },
    action: {
      default_title: 'OmniPilot Synapse',
      default_icon: {
        16: 'icon-16.png',
        32: 'icon-32.png',
        48: 'icon-48.png',
      },
    },
  },
});
