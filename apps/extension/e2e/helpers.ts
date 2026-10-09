/**
 * E2E helpers: a local fixture server, an extension-loading browser context, settings seeding and a
 * recording GitHub stub.
 *
 * Everything here exists so the specs read as user journeys rather than browser plumbing.
 */

import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type BrowserContext, type Page } from '@playwright/test';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = join(HERE, '..', '.output', 'chrome-mv3');

export const TEST_PASSPHRASE = 'correct horse battery';
export const TEST_PAT = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop';
export const TEST_MODEL_KEY = 'sk-e2e-model-key-abcdefghijklmnop';
export const TEST_BODY_MARKER = 'reviewing material near the point of forgetting';
/** A second, independent body: the sync specs need two records that can never dedup into one. */
export const TEST_DRIFT_MARKER = 'a retrieval drill on the forgetting curve';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** Serve `e2e/fixtures` over http://127.0.0.1 — content scripts do not run on file:// URLs. */
export async function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const requested = (request.url ?? '/').split('?')[0] ?? '/';
    const name = requested === '/' ? '/article.html' : requested;
    try {
      const body = readFileSync(join(HERE, 'fixtures', name.replace(/^\//u, '')));
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(name)] ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface LaunchedExtension {
  context: BrowserContext;
  extensionId: string;
  /** Open the options page — the only extension page that can drive privileged requests in a test. */
  openOptions: () => Promise<Page>;
  dispose: () => Promise<void>;
}

/** Launch a persistent Chromium with the built extension loaded. Requires `npm run build` first. */
export async function launchExtension(options: { headed?: boolean } = {}): Promise<LaunchedExtension> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    /**
     * Playwright's default Chromium args include flags that suppress extension machinery
     * (`--disable-extensions`, `--disable-component-extensions-with-background-pages`) and a blanket
     * `--disable-features=…` list. With them in place the extension loads and its service worker
     * runs, but the browser never dispatches `runtime.onMessage` to it. Dropping them is what makes
     * extension E2E possible at all.
     */
    ignoreDefaultArgs: [
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
    ],
    // Extension E2E runs headed: Playwright's own extension guidance recommends it.
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;

  return {
    context,
    extensionId,
    openOptions: async () => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);
      return page;
    },
    dispose: () => context.close(),
  };
}

/**
 * Open the popup page itself.
 *
 * The popup is a real extension page at the extension origin, and the pending/review sections the
 * decision surface renders from are built exactly there — `options.html` does not carry them. Opening
 * it directly is the only way to assert on what a user sees when they click the toolbar icon.
 */
export async function openPopup(extension: LaunchedExtension): Promise<Page> {
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.extensionId}/popup.html`);
  return page;
}

export interface SeedOptions {
  /** `vault` (default) or `transparent`. */
  securityMode?: 'vault' | 'transparent';
  /** Also authorize AI egress and store a provider key. */
  withAi?: boolean;
  publicRepoAcknowledged?: boolean;
  /**
   * Also record a local clone path for SSH.
   *
   * Without it the SSH picker reports "not configured" before it ever asks about the companion, so a
   * spec that wants to observe the *companion-missing* degradation has to clear that first hurdle —
   * exactly as the options form does when the user fills it in.
   */
  withSshClone?: boolean;
  /**
   * Leave the content-tier question unanswered, so a spec can observe the first-run gate (T7).
   * Every other spec seeds it as answered, because answering it is not what they are about.
   */
  tierUnchosen?: boolean;
}

/**
 * Seed configuration through the extension's own message API.
 *
 * Deliberately not done by writing `chrome.storage` directly: going through `vault.setup` and
 * `settings.github` exercises the same handlers the options page uses, and proves the vault really
 * encrypts what it stores.
 */
export async function seedSettings(options: Page, seed: SeedOptions = {}): Promise<void> {
  const result = await options.evaluate(
    async (config: {
      passphrase: string;
      pat: string;
      mode: string;
      withAi: boolean;
      modelKey: string;
      acknowledged: boolean;
      tierChosen: boolean;
    }) => {
      const send = (type: string, payload?: unknown): Promise<unknown> =>
        // Available on every extension page in MV3.
        chrome.runtime.sendMessage({ type, payload });

      const setup = (await send('vault.setup', { passphrase: config.passphrase })) as { ok: boolean };
      if (!setup.ok) return { step: 'vault.setup', response: setup };

      const github = (await send('settings.github', {
        owner: 'zayeagle',
        repo: 'omnipilot-synapse',
        branch: 'main',
        pat: config.pat,
        publicRepoAcknowledged: config.acknowledged,
      })) as { ok: boolean; error?: string };
      if (!github.ok) return { step: 'settings.github', response: github };

      const security = (await send('settings.security', {
        securityMode: config.mode,
        aiAuthorized: config.withAi,
        contentTierChosen: config.tierChosen,
      })) as { ok: boolean };
      if (!security.ok) return { step: 'settings.security', response: security };

      if (config.withAi) {
        const provider = (await send('settings.provider', {
          providerId: 'deepseek',
          model: 'deepseek-chat',
          apiKey: config.modelKey,
        })) as { ok: boolean; error?: string };
        if (!provider.ok) return { step: 'settings.provider', response: provider };
      }
      return { step: 'done' };
    },
    {
      passphrase: TEST_PASSPHRASE,
      pat: TEST_PAT,
      mode: seed.securityMode ?? 'vault',
      withAi: seed.withAi ?? false,
      modelKey: TEST_MODEL_KEY,
      acknowledged: seed.publicRepoAcknowledged ?? false,
      tierChosen: seed.tierUnchosen !== true,
    },
  );

  if (result.step !== 'done') {
    throw new Error(`seeding failed at ${result.step}: ${JSON.stringify(result.response)}`);
  }

  if (seed.withSshClone ?? false) await seedSshClone(options);
}

/**
 * Record a local clone path for SSH mode. Skipped by `settings.github`/`settings.security`, which do
 * not carry `ssh`, so it goes where the options page puts it: `chrome.storage.local.settings`.
 */
async function seedSshClone(options: Page): Promise<void> {
  await options.evaluate(async () => {
    const runtime = (globalThis as unknown as {
      chrome: {
        storage: {
          local: {
            get: (key: string) => Promise<Record<string, unknown>>;
            set: (items: Record<string, unknown>) => Promise<void>;
          };
        };
      };
    }).chrome.storage.local;
    const stored = await runtime.get('settings');
    const settings = (stored['settings'] as Record<string, unknown> | undefined) ?? {};
    const ssh = { ...((settings['ssh'] as Record<string, unknown> | undefined) ?? {}) };
    ssh['repoRoot'] = 'C:\\work\\omnipilot-synapse';
    await runtime.set({ settings: { ...settings, ssh } });
  });
}

export interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

export interface GitHubStub {
  calls: RecordedCall[];
  files: Map<string, string>;
  commitCount: () => number;
}

/**
 * Intercept GitHub and the model provider.
 *
 * The GitHub stub is stateful: blobs are kept, the tree maps them to paths, and a commit applies the
 * tree — which is what lets a spec assert on what the repository would actually contain.
 */
export async function stubGitHub(
  context: BrowserContext,
  options: {
    private?: boolean;
    withAi?: boolean;
    /**
     * Hold every GitHub answer open for this long (ms).
     *
     * A spec that asserts on the popup's in-flight state needs the state to last longer than one
     * round trip, which on a local stub is otherwise a race it cannot win.
     */
    delayMs?: number;
  } = {},
): Promise<GitHubStub> {
  const calls: RecordedCall[] = [];
  const blobBySha = new Map<string, string>();
  const files = new Map<string, string>();
  let commits = 0;
  let pendingTree: Array<{ path: string; sha: string }> = [];

  await context.route('https://api.github.com/**', async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const url = request.url();
    let body: unknown;
    try {
      body = request.postDataJSON();
    } catch {
      body = undefined;
    }
    calls.push({ method, url, body });

    if (options.delayMs !== undefined && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }

    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

    if (method === 'GET' && /\/repos\/[^/]+\/[^/]+$/u.test(url)) {
      return json({
        full_name: 'zayeagle/omnipilot-synapse',
        private: options.private ?? true,
        default_branch: 'main',
        permissions: { push: true },
      });
    }
    if (method === 'GET' && url.includes('/contents/')) {
      const path = decodeURIComponent(url.split('/contents/')[1]?.split('?')[0] ?? '');
      const content = files.get(path);
      if (content !== undefined) {
        return json({
          type: 'file',
          path,
          sha: `sha-${path}`,
          encoding: 'base64',
          content: Buffer.from(content, 'utf8').toString('base64'),
        });
      }
      // GitHub answers a directory path with a JSON array, not a 404. The search index lists the
      // shard directory through exactly this call, so without it a query would always look empty.
      const prefix = path.length === 0 ? '' : `${path}/`;
      const children = [...files.entries()]
        .filter(([candidate]) => candidate.startsWith(prefix) && candidate !== path)
        .map(([candidate]) => candidate.slice(prefix.length).split('/')[0] ?? '')
        .filter((name) => name.length > 0);
      const unique = [...new Set(children)].sort();
      if (unique.length > 0) {
        return json(
          unique.map((name) => {
            const childPath = `${prefix}${name}`;
            const isFile = files.has(childPath);
            return {
              name,
              path: childPath,
              sha: `sha-${childPath}`,
              type: isFile ? 'file' : 'dir',
            };
          }),
        );
      }
      return json({ message: 'Not Found' }, 404);
    }
    if (method === 'GET' && url.includes('/git/ref/heads/')) return json({ object: { sha: 'headsha' } });
    if (method === 'GET' && url.includes('/git/commits/headsha')) return json({ tree: { sha: 'basetree' } });
    if (method === 'POST' && url.endsWith('/git/blobs')) {
      const sha = `blob${blobBySha.size + 1}`;
      blobBySha.set(sha, String((body as { content?: string }).content ?? ''));
      return json({ sha });
    }
    if (method === 'POST' && url.endsWith('/git/trees')) {
      pendingTree = (body as { tree?: Array<{ path: string; sha: string }> }).tree ?? [];
      return json({ sha: 'treesha' });
    }
    if (method === 'POST' && url.endsWith('/git/commits')) {
      for (const entry of pendingTree) {
        const content = blobBySha.get(entry.sha);
        if (content !== undefined) files.set(entry.path, content);
      }
      commits += 1;
      return json({
        sha: `commit${commits}`,
        html_url: `https://github.com/zayeagle/omnipilot-synapse/commit/commit${commits}`,
      });
    }
    if (method === 'PATCH' && url.includes('/git/refs/heads/')) return json({ object: { sha: 'commit1' } });
    return json({ message: `unhandled ${method} ${url}` }, 500);
  });

  if (options.withAi ?? false) {
    await context.route('https://api.deepseek.com/**', async (route) => {
      const request = route.request();
      calls.push({
        method: request.method(),
        url: request.url(),
        body: (() => {
          try {
            return request.postDataJSON();
          } catch {
            return undefined;
          }
        })(),
      });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: 'Spaced repetition scheduling',
                  summary: 'Review near the forgetting point.',
                  points: ['Schedule by retrievability', 'Rate honestly', 'Shorten after a miss'],
                }),
              },
            },
          ],
        }),
      });
    });
  }

  return { calls, files, commitCount: () => commits };
}

/** Select a paragraph in the page and surface the content script's bubble. */
export async function selectParagraph(page: Page, selector = '#first'): Promise<string> {
  const text = await page.evaluate((target: string) => {
    const element = document.querySelector(target);
    if (!element) throw new Error(`no element matching ${target}`);
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    // The content script listens for real selection events.
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return range.toString();
  }, selector);
  await page.waitForSelector('.omnipilot-bubble:not([hidden])', { timeout: 10_000 });
  return text;
}

/** All file contents the stub repository would hold, concatenated. */
export function repositoryText(stub: GitHubStub): string {
  return [...stub.files.entries()].map(([path, content]) => `${path}\n${content}`).join('\n---\n');
}

/* ------------------------------------------------------------------ *
 * Sync / search driving helpers
 * ------------------------------------------------------------------ */

/** One `{ type, payload }` round trip through the service worker's router. */
export interface ExtensionReply {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

/**
 * Send one request to the worker and get its reply.
 *
 * Deliberately the message API rather than the popup/options UI: sync, search and auth have no UI
 * contract of their own, and driving them through the router keeps these specs valid while the
 * pages themselves are still being edited.
 */
export function sendToExtension(page: Page, type: string, payload?: unknown): Promise<ExtensionReply> {
  return page.evaluate(
    async (message: { type: string; payload: unknown }) => {
      const send = (globalThis as unknown as {
        chrome: { runtime: { sendMessage: (value: unknown) => Promise<unknown> } };
      }).chrome.runtime.sendMessage;
      return (await send(message)) as { ok: boolean; data?: unknown; error?: string; code?: string };
    },
    { type, payload },
  );
}

/** A typed view of an `index.json` entry — only the fields these specs read or patch. */
export interface StubIndexItem {
  id: string;
  kind: string;
  path: string;
  url_key?: string;
  content_key?: string;
  created_at: string;
  updated_at: string;
}

/** Parse the stub's `index.json`; an absent or unreadable manifest reads as empty. */
export function stubIndex(stub: GitHubStub): { schema: number; items: Record<string, StubIndexItem> } {
  const text = stub.files.get('index.json');
  if (text === undefined) return { schema: 1, items: {} };
  try {
    return JSON.parse(text) as { schema: number; items: Record<string, StubIndexItem> };
  } catch {
    return { schema: 1, items: {} };
  }
}

/** The single non-manifest record currently sitting in the remote manifest. */
export function soleManifestItem(stub: GitHubStub): StubIndexItem {
  const items = Object.values(stubIndex(stub).items).filter((item) => item.path !== 'index.json');
  if (items.length !== 1) {
    throw new Error('expected exactly one record in the remote manifest, got ' + items.length);
  }
  return items[0] as StubIndexItem;
}

/**
 * Simulate "someone edited this note in the repository" while the extension was idle.
 *
 * Patches the file AND its manifest row together: the engine detects drift by diffing `index.json`,
 * so a file-only edit would never be seen and a manifest-only edit would be a metadata touch-up. A
 * fresh `content_key` is recorded because that fingerprint — not the timestamp — is what tells the
 * manifest diff that the bytes moved.
 */
export function updateRemoteRecord(
  stub: GitHubStub,
  path: string,
  content: string,
  stamp: string,
): StubIndexItem {
  stub.files.set(path, content);
  const parsed = stubIndex(stub);
  const item = Object.values(parsed.items).find((entry) => entry.path === path);
  if (!item) throw new Error('no manifest entry for ' + path);
  // Deterministic and content-derived rather than random: the manifest diff compares these keys,
  // so a re-run with identical bytes must keep reading as "unchanged".
  const updated: StubIndexItem = {
    ...item,
    content_key: `ck:${content.length}:${stamp}`,
    updated_at: stamp,
  };
  parsed.items[item.id] = updated;
  stub.files.set('index.json', JSON.stringify(parsed, null, 2) + '\n');
  return updated;
}

/** The paths the local cache holds that are also present in the remote manifest. */
export async function localPathsFromCache(page: Page, stub: GitHubStub): Promise<string[]> {
  const remotePaths = [...stub.files.keys()].filter((path) => path !== 'index.json');
  return page.evaluate(async (paths: string[]) => {
    const open = (globalThis as unknown as {
      indexedDB: { open: (name: string, version: number) => IDBOpenDBRequest };
    }).indexedDB.open('omnipilot-sync', 1);
    const ask = (store: string, mode: IDBTransactionMode, action: (s: IDBObjectStore) => IDBRequest<unknown>) =>
      new Promise<unknown>((resolve, reject) => {
        open.onsuccess = () => {
          const transaction = open.result.transaction(store, mode);
          const pending = action(transaction.objectStore(store));
          pending.onsuccess = () => resolve(pending.result);
          pending.onerror = () => reject(pending.error);
        };
        open.onerror = () => reject(open.error);
      });
    const all = (await ask('records', 'readonly', (s) => s.getAll())) as Array<{ path?: string }>;
    return all
      .map((entry) => entry.path)
      .filter((value): value is string => typeof value === 'string' && paths.includes(value));
  }, remotePaths);
}

/** A capture message exactly as the popup/content script sends it — no UI involved. */
export async function captureSource(
  page: Page,
  source: { url: string; title: string; text: string },
): Promise<string> {
  const reply = await sendToExtension(page, 'capture.request', {
    mode: 'selection',
    url: source.url,
    title: source.title,
    selection: source.text,
  });
  if (!reply.ok) throw new Error('capture failed: ' + JSON.stringify(reply));
  const data = reply.data as { path?: string };
  if (!data.path) throw new Error('capture returned no path: ' + JSON.stringify(reply));
  return data.path;
}

/**
 * Rewrite a captured record's body in the repository, keeping its frontmatter intact.
 *
 * Going through the captured bytes rather than hand-writing the document is what makes the edit
 * credible: `parseSourceItem` demands a full, valid frontmatter (id, channel, content_hash, …), so a
 * fixture that invents one would fail the decoder instead of testing the sync.
 */
export function retextRemoteRecord(
  stub: GitHubStub,
  path: string,
  body: string,
  stamp: string,
): StubIndexItem {
  const document = stub.files.get(path);
  if (document === undefined) throw new Error('no remote file at ' + path);
  return updateRemoteRecord(stub, path, replaceBody(document, body), stamp);
}

/** Swap the body of a frontmatter document, leaving every frontmatter line untouched. */
function replaceBody(document: string, body: string): string {
  // `encodeDoc` puts the body directly after the closing delimiter with no blank line, so the
  // trailing newline is optional here.
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/u.exec(document);
  if (!match) throw new Error('remote file has no frontmatter');
  const frontmatter = match[0].replace(/\r\n/gu, '\n');
  return frontmatter + body.trim() + '\n';
}

/** The body (the human-visible part) of a frontmatter document, normalised to one line. */
export function testBodyOf(document: string): string {
  return document.split('---').slice(2).join('---').replace(/\s+/gu, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * i18n-backed label helpers
 * ------------------------------------------------------------------ */

export type SpecLang = 'en' | 'zh_CN';

/**
 * The two flat dictionaries from `lib/i18n.ts`, as plain maps.
 *
 * Specs must assert on the *shipped* text, never on English invented in the spec. The dictionaries are
 * a data-only module (flat `'key': 'value'` literals, no interpolation), so they can be read and
 * evaluated here instead of importing production code into the harness. A spec that simply assumed a
 * language would pass on one machine and fail on another, which is why the key is always looked up in
 * both and the page's own language picks the one the assertion uses.
 */
let dictionaries: Record<SpecLang, Record<string, string>> | null = null;

/**
 * A minimal property scan over one flat `{ 'key': 'value', … }` literal.
 *
 * The dictionaries are plain string maps, so a tiny scanner is enough — and it is deliberately not a
 * general JS parser: keys and values must be quoted string literals, which the i18n module's parity
 * test already guarantees. It exists so a spec can assert on the SHIPPED text in the page's own
 * language without importing production code into the harness.
 */
function parseFlatDictionary(literal: string): Record<string, string> {
  const table: Record<string, string> = {};
  let index = 0;
  const skipTrivia = (): void => {
    for (;;) {
      while (index < literal.length && /\s/u.test(literal[index] ?? '')) index += 1;
      if (literal[index] === '/' && literal[index + 1] === '/') {
        while (index < literal.length && literal[index] !== '\n') index += 1;
        continue;
      }
      if (literal[index] === '/' && literal[index + 1] === '*') {
        index += 2;
        while (index < literal.length && !(literal[index] === '*' && literal[index + 1] === '/')) index += 1;
        index += 2;
        continue;
      }
      return;
    }
  };
  const readString = (): string => {
    const quote = literal[index];
    index += 1;
    let out = '';
    while (index < literal.length && literal[index] !== quote) {
      const character = literal[index];
      if (character === '\\') {
        const next = literal[index + 1] ?? '';
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        index += 2;
        continue;
      }
      out += character;
      index += 1;
    }
    index += 1;
    return out;
  };
  skipTrivia();
  if (literal[index] === '{') index += 1;
  for (;;) {
    skipTrivia();
    if (index >= literal.length || literal[index] === '}') break;
    const quote = literal[index];
    if (quote !== '\'' && quote !== '"') throw new Error('helpers: dictionary keys must be quoted');
    const key = readString();
    skipTrivia();
    if (literal[index] !== ':') throw new Error('helpers: expected : after ' + key);
    index += 1;
    skipTrivia();
    const valueQuote = literal[index];
    if (valueQuote !== '\'' && valueQuote !== '"') {
      throw new Error('helpers: expected a string value for ' + key);
    }
    table[key] = readString();
    skipTrivia();
    if (literal[index] === ',') index += 1;
  }
  return table;
}

export function dicts(): Record<SpecLang, Record<string, string>> {
  if (dictionaries !== null) return dictionaries;
  const source = readFileSync(join(HERE, '..', 'lib', 'i18n.ts'), 'utf8');
  const next = {} as Record<SpecLang, Record<string, string>>;
  for (const lang of ['en', 'zh_CN'] as const) {
    const marker = 'export const ' + lang + ': Dict = {';
    const start = source.indexOf(marker);
    if (start < 0) throw new Error('helpers: could not find the ' + lang + ' dictionary');
    const from = start + marker.length - 1;
    let depth = 0;
    let end = -1;
    for (let cursor = from; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          end = cursor + 1;
          break;
        }
      }
    }
    if (end < 0) throw new Error('helpers: the ' + lang + ' dictionary is not closed');
    next[lang] = parseFlatDictionary(source.slice(from, end));
  }
  dictionaries = next;
  return next;
}

/** Shipped text for a key in the locale the *page* resolved, which is the text a user actually sees. */
export function dictText(lang: SpecLang, key: string): string {
  const table = dicts()[lang];
  const text = table[key];
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`helpers: no ${lang} text for ${key}`);
  }
  return text;
}

/** The UI language of a page — the same `navigator.language` the entrypoints feed to `detectLang`. */
export async function pageLang(page: Page): Promise<SpecLang> {
  const locale = await page.evaluate(() => navigator.language);
  const normalized = String(locale ?? '').toLowerCase().replace('-', '_');
  if (normalized.startsWith('zh')) return 'zh_CN';
  if (normalized.startsWith('en')) return 'en';
  // `detectLang` falls back to Chinese for anything it does not recognise.
  return 'zh_CN';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** A key's text as a regex matching *either* shipped translation — the house style for text assertions. */
export function eitherText(key: string): RegExp {
  const { en: english, zh_CN: chinese } = dicts();
  const escape = (value: string): string => value.replace(/[{][a-z_]+[}]/gu, '\u0000').split('\u0000').map(escapeRegExp).join('[\\s\\S]*');
  const alternatives = [english[key], chinese[key]]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => `(?:${escape(value)})`);
  if (alternatives.length === 0) throw new Error(`helpers: no text for ${key} in either dictionary`);
  return new RegExp(alternatives.join('|'), 'u');
}
