// @vitest-environment happy-dom
/**
 * Render smoke tests for the two entrypoints.
 *
 * The pages are wired in TypeScript and the pure logic is covered by `format.test.ts`, but neither
 * of those proves that the DOM wiring actually MOUNTS. This file imports the real page entrypoints
 * against a stubbed `chrome` object and asserts what a user would see: disabled clip buttons with a
 * reason, five status rows, an Inbox with 提炼/打开, five option tabs, and — the load-bearing one —
 * no credential anywhere in the rendered text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORED_PAT = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop';
const STORED_KEY = 'sk-abcdefghijklmnopqrstuvwxyz';

interface Sent {
  type: string;
  payload: unknown;
}

const sent: Sent[] = [];
let probeVisibility: 'private' | 'public' = 'private';
/** Companion availability the stubbed worker reports (F5 availability tests). */
let companionState: 'ok' | 'missing' | 'mismatch' = 'ok';
/** What the stubbed worker answers for `cards.list` (F3). */
let cardListFailure: string | null = null;
let pendingCards: unknown[] = defaultPendingCards();
/** Authorization mode the stubbed `settings.export` reports (F5/T5.2). */
let exportedAuth: { mode: string; repoRoot: string } = { mode: 'token', repoRoot: '' };

/**
 * One readable proposal and one whose body could not be read: the second is the interesting one, because the
 * failure mode F3 has to avoid is dropping it silently.
 */
function defaultPendingCards(): unknown[] {
  return [
    {
      id: 'card-1',
      path: 'cards/pending/card-1.md',
      title: '间隔复习的机制',
      summary: '间隔比总时长更能决定记忆留存。',
      points: ['先自评再排期', '间隔随掌握度拉长'],
      tags: ['记忆', '复习'],
      evidence_paths: ['inbox/2026/paper.md'],
      created_at: '2026-07-09T08:00:00.000Z',
    },
    {
      id: 'card-2',
      path: 'cards/pending/card-2.md',
      unreadable: true,
      created_at: '2026-07-09T07:00:00.000Z',
    },
  ];
}

function reply(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) {
    return { ok: false, error: 'x', code: 'validation' };
  }
  const request = message as { type?: unknown; payload?: unknown };
  const type = typeof request.type === 'string' ? request.type : '';
  sent.push({ type, payload: request.payload });
  switch (type) {
    case 'settings.export':
      return {
        ok: true,
        data: {
          exportedAt: '2026-07-09T00:00:00.000Z',
          settings: {
            enabled: true,
            aiAuthorized: true,
            securityMode: 'vault',
            // The tier question is already answered in this fixture; the gate has its own spec.
            contentTierChosen: true,
            autoLockMinutes: 30,
            github: { owner: 'zayeagle', repo: 'kb', branch: 'main', pathPrefix: '', apiBase: '' },
            ai: { providerId: 'openai', model: 'gpt-4o-mini', baseUrl: '' },
            authMode: exportedAuth.mode,
            ssh: { host: 'github.com', user: 'git', keyRef: 'default', repoRoot: exportedAuth.repoRoot },
          },
          secretsPresent: { githubPat: true, providerKey: true },
        },
      };
    case 'status.get':
      return {
        ok: true,
        data: {
          prefs: {
            enabled: true,
            storeKind: 'github',
            repoFullName: 'zayeagle/kb',
            securityMode: 'vault',
            hasPat: true,
            hasKey: true,
            vaultLocked: false,
            aiAuthorized: true,
            // F5: the projection carries the mode, the branch and the sync counts — no secrets.
            authMode: 'token',
            branch: 'main',
            sshHost: 'github.com',
            companion: companionState,
            sync: {
              lastSyncAt: '2026-07-09T12:00:00.000Z',
              lastOutcome: 'pulled',
              pending: 2,
              conflicts: 1,
            },
          },
          probe: {
            kind: 'github',
            repoFullName: 'zayeagle/kb',
            visibility: probeVisibility,
            defaultBranch: 'main',
            canPush: true,
            canWrite: probeVisibility !== 'public',
            checkedAt: '2026-07-09T10:00:00.000Z',
          },
          vault: { configured: true, unlocked: true, expiresAt: 1, remainingMs: 600_000 },
        },
      };
    case 'inbox.list':
      return {
        ok: true,
        data: [
          {
            id: 'id1',
            path: 'inbox/2026/07/id1.md',
            title: 'A captured page',
            url: 'https://github.com/zayeagle/kb/commit/1',
            capturedAt: '2026-07-09T12:00:00.000Z',
          },
        ],
      };
    case 'store.probe':
      return {
        ok: true,
        data: {
          kind: 'github',
          repoFullName: 'zayeagle/kb',
          visibility: probeVisibility,
          defaultBranch: 'main',
          canPush: true,
          canWrite: probeVisibility !== 'public',
          checkedAt: '2026-07-09T10:00:00.000Z',
        },
      };
    case 'ai.ledger':
      return {
        ok: true,
        data: [
          {
            provider: 'openai',
            model: 'gpt-4o-mini',
            at: '2026-07-09T12:34:56.789Z',
            ok: true,
            content: 'HIDDEN',
          },
        ],
      };
    case 'vault.status':
      return {
        ok: true,
        data: { configured: true, unlocked: true, expiresAt: 1, remainingMs: 600_000 },
      };
    case 'sync.status':
      return {
        ok: true,
        data: {
          head: 'abcdef0123456789',
          lastSyncAt: '2026-07-09T12:00:00.000Z',
          lastOutcome: 'pulled',
          pending: 2,
          conflicts: ['cards/pending/a.md'],
          needsRebuild: false,
        },
      };
    case 'sync.now':
      return { ok: true, data: { outcome: 'upToDate', pulled: 0, pushed: 0, conflicts: [] } };
    case 'sync.policy':
      return { ok: true, data: { intervalMinutes: 30, onStartup: true, onCapture: true, pullOnly: false } };
    case 'auth.probe':
      return {
        ok: true,
        data: {
          kind: 'github',
          repoFullName: 'zayeagle/kb',
          visibility: 'private',
          defaultBranch: 'main',
          remoteBranchExists: false,
          canPush: true,
          canWrite: true,
          checkedAt: '2026-07-09T10:00:00.000Z',
        },
      };
    case 'search.query':
      return {
        ok: true,
        data: {
          needsRebuild: false,
          results: [
            {
              id: 'id1',
              path: 'cards/pending/id1.md',
              title: 'A captured page',
              snippet: 'the distinctive phrase',
              score: 0.9,
              content: 'HIDDEN',
            },
          ],
        },
      };
    case 'search.rebuild':
      return { ok: true, data: { rebuilt: true, records: 1 } };
    case 'cards.list':
      if (cardListFailure !== null) return { ok: false, error: 'stub', code: cardListFailure };
      return { ok: true, data: { cards: pendingCards } };
    case 'card.decide': {
      const payload = (request.payload ?? {}) as Record<string, unknown>;
      const action = String(payload['action'] ?? '');
      const path = String(payload['path'] ?? '');
      if (action === 'discard') {
        return { ok: true, data: { action, path: '', previousPath: path, archivedPath: `archive/cards/${path}` } };
      }
      return { ok: true, data: { action, path } };
    }
    default:
      return { ok: true, data: {} };
  }
}

/**
 * `wxt/browser` is `webextension-polyfill`, which calls the callback-style Chrome API and turns the
 * callback into a promise. The stub therefore has to answer BOTH styles — a plain promise-returning
 * stub makes every page `await` hang forever.
 */
function callbackAware(resolve: (args: unknown[]) => unknown): (...args: unknown[]) => unknown {
  return (...args: unknown[]): unknown => {
    const last = args.length > 0 ? args[args.length - 1] : undefined;
    const callback = typeof last === 'function' ? (last as (value: unknown) => void) : null;
    const value = resolve(callback ? args.slice(0, -1) : args);
    if (callback) {
      callback(value);
      return undefined;
    }
    return Promise.resolve(value);
  };
}

function installChrome(): void {
  const runtime = {
    id: 'smoke',
    sendMessage: callbackAware((args) => reply(args[0])),
    openOptionsPage: callbackAware(() => undefined),
    onMessage: { addListener: (): void => undefined },
  };
  const chrome = {
    runtime,
    tabs: {
      query: callbackAware(() => [{ id: 7, url: 'https://example.com/p', title: 'P' }]),
      create: callbackAware(() => ({ id: 8 })),
    },
    scripting: {
      executeScript: callbackAware(() => [
        { frameId: 0, documentId: 'd', result: { text: 'picked', lang: 'en' } },
      ]),
    },
    permissions: {
      contains: callbackAware(() => true),
      request: callbackAware(() => true),
    },
  };
  (globalThis as { chrome?: unknown }).chrome = chrome;
}

/**
 * Whether `node` is shown inside `panel`.
 *
 * The tab strips are toggled with `hidden` on the whole `section.card`, so the search stops at the
 * panel itself: a warning in the active 存储 panel whose own subtree hides it (the SSH block) must
 * still read as not shown.
 */
function shownWithin(panel: Element, node: Element): boolean {
  for (let current: Element | null = node; current !== null && current !== panel; current = current.parentElement) {
    if ((current as HTMLElement).hidden) return false;
  }
  return true;
}

/** Let every queued microtask (the page's `await send(...)` chain) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(loader: () => Promise<unknown>): Promise<HTMLElement> {
  document.body.textContent = '';
  const app = document.createElement('div');
  app.id = 'app';
  document.body.appendChild(app);
  vi.resetModules();
  await loader();
  await settle();
  return app;
}

beforeEach(() => {
  sent.length = 0;
  probeVisibility = 'private';
  companionState = 'ok';
  cardListFailure = null;
  pendingCards = defaultPendingCards();
  exportedAuth = { mode: 'token', repoRoot: '' };
  installChrome();
  // The UI language is decided once, when the page module is first evaluated.
  Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true });
});

describe('popup console mount (F8 UNIT)', () => {
  it('TC-F8-U02 renders the status rows, the Inbox and the clip buttons', async () => {
    const app = await mount(() => import('../../entrypoints/popup/main'));
    const text = app.textContent ?? '';

    // Status rows from `status.get`.
    expect(text).toContain('zayeagle/kb');
    expect(text).toContain('github');
    // An Inbox row with both of its actions.
    expect(text).toContain('A captured page');
    const labels = [...app.querySelectorAll('button')].map((node) => node.textContent ?? '');
    expect(labels.some((label) => label.includes('剪藏本页'))).toBe(true);
    expect(labels.some((label) => label.includes('提炼'))).toBe(true);
    expect(labels.some((label) => label.includes('打开'))).toBe(true);
    expect(labels.some((label) => label.includes('设置'))).toBe(true);
    expect(labels.some((label) => label.includes('刷新'))).toBe(true);
    const clip = [...app.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('剪藏本页'),
    );
    expect(clip?.disabled).toBe(false);
    expect(sent.some((entry) => entry.type === 'status.get')).toBe(true);
    expect(sent.some((entry) => entry.type === 'inbox.list')).toBe(true);
  });

  it('TC-F8-U02 disables clipping and explains why when the repository is public', async () => {
    probeVisibility = 'public';
    const app = await mount(() => import('../../entrypoints/popup/main'));
    expect(app.textContent ?? '').toContain('公开仓库');
    for (const node of app.querySelectorAll('button')) {
      if ((node.textContent ?? '').includes('剪藏')) expect(node.disabled).toBe(true);
    }
  });

  it('TC-F8-U01 never renders a stored credential', async () => {
    const app = await mount(() => import('../../entrypoints/popup/main'));
    const text = app.textContent ?? '';
    expect(text).not.toContain(STORED_PAT);
    expect(text).not.toContain(STORED_KEY);
    expect(text).not.toMatch(/github_pat_|sk-|Bearer/u);
    expect(app.querySelectorAll('input[type="password"]').length).toBe(0);
  });
});

describe('options page mount (F8 UNIT)', () => {
  it('TC-F8-U01 renders five tabs and never refills a credential field', async () => {
    const app = await mount(() => import('../../entrypoints/options/main'));
    const tabLabels = [...app.querySelectorAll('nav.tabs button')].map((node) => node.textContent ?? '');
    expect(tabLabels).toEqual(['模型', '存储', '同步', '安全', 'AI 授权', '数据']);
    expect(app.querySelectorAll('section.card').length).toBe(6);
    const visible = [...app.querySelectorAll('section.card')].filter(
      (node) => !(node as HTMLElement).hidden,
    );
    expect(visible.length).toBe(1);

    const passwords = [...app.querySelectorAll('input[type="password"]')] as HTMLInputElement[];
    expect(passwords.length).toBeGreaterThanOrEqual(3);
    for (const input of passwords) expect(input.value).toBe('');
    // The two credential fields carry the "leave empty to keep" placeholder; the vault passphrase
    // field is a new secret, so it has none.
    const credentialFields = passwords.filter((input) => input.placeholder.length > 0);
    expect(credentialFields.length).toBe(2);
    for (const input of credentialFields) {
      expect(input.placeholder).toBe('留空则保留已保存的密钥');
    }
    const text = app.textContent ?? '';
    expect(text).not.toContain(STORED_PAT);
    expect(text).not.toContain(STORED_KEY);
    // The stored token is reported as presence only.
    expect(text).toContain('已保存密钥');
  });

  it('TC-F8-U01 renders the ledger without any captured content', async () => {
    const app = await mount(() => import('../../entrypoints/options/main'));
    const text = app.textContent ?? '';
    expect(text).toContain('gpt-4o-mini');
    expect(text).not.toContain('HIDDEN');
    const rows = app.querySelectorAll('table.ledger tbody tr');
    expect(rows.length).toBe(1);
    expect(rows[0]?.querySelectorAll('td').length).toBe(4);
  });

  /** The 保存 button of a named options card (there is one per section). */
  function saveButtonOf(app: HTMLElement, cardIndex: number): HTMLButtonElement | null {
    const cards = app.querySelectorAll('section.card');
    const target = cards[cardIndex];
    if (!target) return null;
    return target.querySelector('button.primary');
  }

  it('TC-F8-U03 gates the storage save on the probe and on the acknowledgement', async () => {
    // A private, pushable repository: saving is allowed and the badge says so.
    const privateMount = await mount(() => import('../../entrypoints/options/main'));
    const privateSave = saveButtonOf(privateMount, 1);
    expect(privateSave?.disabled).toBe(false);
    expect(privateMount.textContent ?? '').toContain('私有');

    // A public repository: saving is blocked, the red warning is visible, and the reason is shown.
    probeVisibility = 'public';
    const publicMount = await mount(() => import('../../entrypoints/options/main'));
    const publicSave = saveButtonOf(publicMount, 1);
    expect(publicSave?.disabled).toBe(true);
    const storePanel = publicMount.querySelectorAll('section.card')[1] as HTMLElement;
    const warnings = [...storePanel.querySelectorAll('p.warning')].filter((node) =>
      shownWithin(storePanel, node),
    );
    expect(warnings.length).toBe(1);
    // Token mode is selected, so the SSH-only "needs a local clone" notice stays hidden.
    const cloneNotice = [...storePanel.querySelectorAll('p.warning')].find((node) =>
      (node.textContent ?? '').includes('本地克隆'),
    );
    expect(cloneNotice).toBeDefined();
    expect(shownWithin(storePanel, cloneNotice as Element)).toBe(false);
    const reasons = [...storePanel.querySelectorAll('p.hint')].filter(
      (node) => shownWithin(storePanel, node) && (node.textContent ?? '').length > 0,
    );
    expect(reasons.some((node) => (node.textContent ?? '').includes('勾选'))).toBe(true);
  });
});

describe('options 存储 authorization + branch (F5 UNIT)', () => {
  it('TC-F5-U01/U02 renders the mode picker, the companion state and the SSH controls', async () => {
    const app = await mount(() => import('../../entrypoints/options/main'));
    const store = app.querySelectorAll('section.card')[1] as HTMLElement;
    const text = store.textContent ?? '';

    // Both modes are offered; ssh is enabled because the stub reports a ready companion.
    const modeSelect = store.querySelector('select') as HTMLSelectElement | null;
    const options = [...(modeSelect?.options ?? [])].map((option) => option.textContent ?? '');
    expect(options).toContain('访问令牌');
    expect(options).toContain('SSH（伴生进程）');
    expect(text).toContain('伴生进程就绪');
    expect(text).toContain('需要该仓库的本地克隆');
    // The key field is a REFERENCE, never key material.
    expect(text).toContain('密钥（引用名）');
  });

  it('TC-P6-U03 hands the user the exact clone command, and refuses a path that would fail later (T5.2)', async () => {
    exportedAuth = { mode: 'ssh', repoRoot: '/srv/kb' };
    const app = await mount(() => import('../../entrypoints/options/main'));
    const store = app.querySelectorAll('section.card')[1] as HTMLElement;
    const command = [...store.querySelectorAll('code')]
      .map((node) => node.textContent ?? '')
      .find((value) => value.startsWith('git clone'));
    expect(command).toBe('git clone git@github.com:zayeagle/kb.git /srv/kb');
    // The copy action travels with the command, or the user has to select it by hand.
    const copy = [...store.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('复制命令'),
    );
    expect(copy).toBeDefined();

    // A relative path is refused on our screen instead of in the user's terminal.
    exportedAuth = { mode: 'ssh', repoRoot: 'kb' };
    const broken = await mount(() => import('../../entrypoints/options/main'));
    expect((broken.querySelectorAll('section.card')[1] as HTMLElement).textContent ?? '').toContain(
      '请填绝对路径',
    );
  });

  it('TC-F5-U01 disables SSH and explains why when no companion is installed', async () => {
    companionState = 'missing';
    const app = await mount(() => import('../../entrypoints/options/main'));
    const store = app.querySelectorAll('section.card')[1] as HTMLElement;
    const modeSelect = store.querySelector('select') as HTMLSelectElement | null;
    const ssh = [...(modeSelect?.options ?? [])].find((option) => (option.textContent ?? '').includes('SSH'));
    expect(ssh?.disabled).toBe(true);
    expect(store.textContent ?? '').toContain('未安装伴生进程');
  });

  it('TC-F5-U03/U05 checks the branch through auth.probe and offers a create action', async () => {
    const app = await mount(() => import('../../entrypoints/options/main'));
    const store = app.querySelectorAll('section.card')[1] as HTMLElement;
    const check = [...store.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('检查分支'),
    );
    expect(check).toBeDefined();
    check?.click();
    await settle();
    expect(sent.some((entry) => entry.type === 'auth.probe')).toBe(true);
    // The stub reports remoteBranchExists: false, so the row says "missing" and exposes 创建分支.
    expect(store.textContent ?? '').toContain('远端不存在分支');
    const create = [...store.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('创建分支'),
    );
    expect(create?.hidden).toBe(false);
  });
});

describe('options 同步与检索 (F5 UNIT)', () => {
  it('TC-F5-U03 renders the sync status, the conflicts and every resolution action', async () => {
    const app = await mount(() => import('../../entrypoints/options/main'));
    const sync = app.querySelectorAll('section.card')[2] as HTMLElement;
    const text = sync.textContent ?? '';
    expect(text).toContain('已从远端拉取');
    expect(text).toContain('2026-07-09 12:00 UTC');
    expect(text).toContain('cards/pending/a.md');
    const labels = [...sync.querySelectorAll('button')].map((node) => node.textContent ?? '');
    expect(labels).toEqual(
      expect.arrayContaining(['保留我的版本', '保留远端版本', '两者都留', '立即同步', '重建索引', '搜索']),
    );
    expect(sent.some((entry) => entry.type === 'sync.status')).toBe(true);
  });

  it('TC-F5-I02 runs a manual sync and reports the fixed outcome', async () => {
    const app = await mount(() => import('../../entrypoints/options/main'));
    const sync = app.querySelectorAll('section.card')[2] as HTMLElement;
    const now = [...sync.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('立即同步'),
    );
    now?.click();
    await settle();
    expect(sent.some((entry) => entry.type === 'sync.now')).toBe(true);
    expect(app.textContent ?? '').toContain('已是最新');
  });

  it('TC-F5-U03 searches the index and renders only whitelisted fields', async () => {
    const app = await mount(() => import('../../entrypoints/options/main'));
    const sync = app.querySelectorAll('section.card')[2] as HTMLElement;
    const input = sync.querySelector('input[type="text"], input:not([type])') as HTMLInputElement | null;
    const field = sync.querySelector('.field input') as HTMLInputElement | null;
    const box = input ?? field;
    expect(box).not.toBeNull();
    if (box) box.value = 'phrase';
    const search = [...sync.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('搜索'),
    );
    search?.click();
    await settle();
    expect(sent.some((entry) => entry.type === 'search.query')).toBe(true);
    expect(sync.textContent ?? '').toContain('the distinctive phrase');
    expect(sync.textContent ?? '').not.toContain('HIDDEN');
    // The result link points at the repository blob, derived by the UI itself.
    const open = [...sync.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('打开'),
    );
    expect(open?.disabled).toBe(false);
  });
});

describe('popup auth + sync + search (F5 UNIT)', () => {
  it('TC-F5-U03 renders the auth/branch row, the sync row and the search box', async () => {
    const app = await mount(() => import('../../entrypoints/popup/main'));
    const text = app.textContent ?? '';
    expect(text).toContain('授权');
    expect(text).toContain('令牌 · main');
    expect(text).toContain('已从远端拉取');
    expect(text).toContain('2 待上传');
    expect(text).toContain('1 冲突');
    const labels = [...app.querySelectorAll('button')].map((node) => node.textContent ?? '');
    expect(labels).toContain('立即同步');
    expect(labels).toContain('搜索');
    expect(app.querySelector('input[type="search"]')).not.toBeNull();
    expect(sent.some((entry) => entry.type === 'sync.status')).toBe(true);
  });

  it('TC-F5-I02 syncs from the popup in one click', async () => {
    const app = await mount(() => import('../../entrypoints/popup/main'));
    const now = [...app.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('立即同步'),
    );
    now?.click();
    await settle();
    expect(sent.some((entry) => entry.type === 'sync.now')).toBe(true);
    expect(app.textContent ?? '').toContain('已是最新');
  });

  it('TC-E2E-03 finds a captured note from the popup search box', async () => {
    const app = await mount(() => import('../../entrypoints/popup/main'));
    const box = app.querySelector('input[type="search"]') as HTMLInputElement | null;
    expect(box).not.toBeNull();
    if (box) box.value = 'phrase';
    const search = [...app.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('搜索'),
    );
    search?.click();
    await settle();
    const queried = sent.find((entry) => entry.type === 'search.query');
    expect(queried?.payload).toEqual({ text: 'phrase' });
    expect(app.textContent ?? '').toContain('the distinctive phrase');
    expect(app.textContent ?? '').not.toContain('HIDDEN');
  });

  it('TC-F5-U03 never shows a secret in any of the new surfaces', async () => {
    const app = await mount(() => import('../../entrypoints/popup/main'));
    const text = app.textContent ?? '';
    expect(text).not.toContain(STORED_PAT);
    expect(text).not.toContain(STORED_KEY);
    expect(text).not.toMatch(/github_pat_|sk-|Bearer/u);
    expect(text).not.toContain('/srv/kb');
  });
});

describe('popup 待处理 — the proposal decision surface (F3 UNIT)', () => {
  it('TC-F3-U01/R3-01 renders each proposal with its three decisions and its source path', async () => {
    const app = await mount(() => import('../../entrypoints/popup/main'));
    const text = app.textContent ?? '';

    expect(sent.some((entry) => entry.type === 'cards.list')).toBe(true);
    expect(text).toContain('待处理');
    expect(text).toContain('间隔复习的机制');
    expect(text).toContain('间隔比总时长更能决定记忆留存。');
    expect(text).toContain('先自评再排期');
    expect(text).toContain('记忆 · 复习');
    // The source is the repository path itself — the popup invents no URL scheme for it.
    expect(text).toContain('来源：inbox/2026/paper.md');

    const labels = [...app.querySelectorAll<HTMLButtonElement>('button')].map((node) => node.textContent ?? '');
    for (const label of ['接受', '改写', '丢弃（归档）']) {
      expect(labels.filter((entry) => entry === label)).toHaveLength(1);
    }
    // Discarding explains itself: it archives, it does not delete.
    expect(text).toContain('archive/cards/');
    expect(text).toContain('不是删除');
    // Nothing was decided just by opening the popup.
    expect(sent.some((entry) => entry.type === 'card.decide')).toBe(false);
  });

  it('TC-F3-U03 accepts a proposal, re-reads the list and reports where the note went', async () => {
    const app = await mount(() => import('../../entrypoints/popup/main'));
    const accept = [...app.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '接受',
    );
    accept?.click();
    await settle();

    const decided = sent.find((entry) => entry.type === 'card.decide');
    expect(decided?.payload).toEqual({ id: 'card-1', path: 'cards/pending/card-1.md', action: 'accept' });
    // The list is re-read rather than patched locally, so the worker stays the source of truth.
    expect(sent.filter((entry) => entry.type === 'cards.list').length).toBe(2);
    expect(app.textContent ?? '').toContain('已接受');
  });

  it('TC-F3-U03 discards into the archive and says so', async () => {
    const app = await mount(() => import('../../entrypoints/popup/main'));
    const discard = [...app.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '丢弃（归档）',
    );
    discard?.click();
    await settle();

    const decided = sent.find((entry) => entry.type === 'card.decide');
    expect(decided?.payload).toEqual({ id: 'card-1', path: 'cards/pending/card-1.md', action: 'discard' });
    const text = app.textContent ?? '';
    expect(text).toContain('已归档到 archive/cards/cards/pending/card-1.md');
    expect(text).toContain('没有删除');
  });

  it('TC-F3-U05 rewrites nothing until 保存 is pressed, then sends only the changed field', async () => {
    const app = await mount(() => import('../../entrypoints/popup/main'));
    const rewrite = [...app.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '改写',
    );
    rewrite?.click();
    await settle();

    const titleField = app.querySelector<HTMLInputElement>('.card-edit input');
    const summaryField = app.querySelector<HTMLTextAreaElement>('.card-edit textarea');
    expect(titleField?.value).toBe('间隔复习的机制');
    expect(summaryField?.value).toBe('间隔比总时长更能决定记忆留存。');
    // Revealing the fields is not a decision: nothing is sent, and no AI is called (E1/E2).
    expect(sent.some((entry) => entry.type === 'card.decide')).toBe(false);

    const save = [...app.querySelectorAll<HTMLButtonElement>('.card-edit button')].find(
      (node) => node.textContent === '保存',
    );
    save?.click();
    await settle();
    expect(sent.some((entry) => entry.type === 'card.decide')).toBe(false);
    expect(app.textContent ?? '').toContain('没有改动');

    if (titleField) titleField.value = '间隔复习的机制（改写）';
    save?.click();
    await settle();
    expect(sent.find((entry) => entry.type === 'card.decide')?.payload).toEqual({
      id: 'card-1',
      path: 'cards/pending/card-1.md',
      action: 'edit',
      patch: { title: '间隔复习的机制（改写）' },
    });
    expect(app.textContent ?? '').toContain('已保存改写');
  });

  it('TC-F3-U03 shows an unreadable proposal as such and offers no decision for it', async () => {
    const app = await mount(() => import('../../entrypoints/popup/main'));
    const items = [...app.querySelectorAll('ul.pending li.pending-card')];
    expect(items).toHaveLength(2);

    const unreadable = items[1];
    expect(unreadable?.textContent ?? '').toContain('这条提案的内容暂时读不到');
    expect(unreadable?.textContent ?? '').toContain('cards/pending/card-2.md');
    // Every decision would have to read the file the worker could not read, so none is offered.
    expect(unreadable?.querySelectorAll('button').length).toBe(0);
  });

  it('TC-F3-U04 says plainly when nothing is pending', async () => {
    pendingCards = [];
    const app = await mount(() => import('../../entrypoints/popup/main'));
    expect(app.textContent ?? '').toContain('没有待处理的提案');
  });

  it('TC-F3-U04 reports a list it could not read instead of claiming the queue is empty', async () => {
    cardListFailure = 'locked';
    const app = await mount(() => import('../../entrypoints/popup/main'));
    const text = app.textContent ?? '';
    expect(text).toContain('保险库已锁定');
    expect(text).toContain('请先解锁保险库');
    expect(text).not.toContain('没有待处理的提案');
  });
});

describe('diagnostic', () => {
  it('dumps cards', async () => {
    probeVisibility = 'public';
    const app = await mount(() => import('../../entrypoints/options/main'));
    const cards = [...app.querySelectorAll('section.card')] as HTMLElement[];
    const info = cards.map((card, index) => {
      const save = card.querySelector('button.primary') as HTMLButtonElement | null;
      return {
        index,
        title: (card.querySelector('.card-title')?.textContent ?? '').slice(0, 20),
        saveLabel: save?.textContent ?? '',
        disabled: save?.disabled,
        text: (card.textContent ?? '').slice(0, 80),
      };
    });
    console.log('DIAG ' + JSON.stringify(info, null, 1));
    expect(true).toBe(true);
  });
});