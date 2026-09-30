/**
 * Background service worker — the trust boundary.
 *
 * Everything sensitive lives here and only here: the vault session, the storage adapter, the model
 * client and the message router. This file is deliberately just wiring; all behaviour lives in
 * `lib/background/**` where it can be tested in Node.
 */

import { browser } from 'wxt/browser';
import { storage } from 'wxt/storage';

import {
  createHandlers,
  performSync,
  resolveStore,
  shardProvider,
  type BackgroundContext,
} from '../lib/background/handlers';
import { MessageRouter, createRouterOptions } from '../lib/background/router';
import { CaptureService } from '../lib/capture/service';
import { detectLang, t } from '../lib/i18n';
import { PAGE_CLIP_MESSAGE, type SenderLike } from '../lib/messages';
import { NativeClient, type NativePort } from '../lib/native/client';
import { AiLedger, CaptureQueue } from '../lib/queues';
import { SyncCache, createBestBackend } from '../lib/sync/cache';
import { SYNC_ALARM_NAME, SyncTriggers } from '../lib/sync/triggers';
import { DEFAULT_TTL_MS, KeySession, type SessionKeyStore } from '../lib/security/key-session';
import { STORAGE_KEYS, SettingsStore, type StorageAreaLike } from '../lib/settings-store';

const CLIP_PAGE_MENU_ID = 'synapse-clip-page';
const CLIP_SELECTION_MENU_ID = 'synapse-clip-selection';
const CLIP_PAGE_COMMAND = 'clip-page';
const CLIP_SELECTION_COMMAND = 'clip-selection';

export default defineBackground(() => {
  const lang = detectLang(browser.i18n?.getUILanguage?.() ?? undefined);
  const area = createStorageArea();
  const session = new KeySession({ store: createSessionStore(), ttlMs: DEFAULT_TTL_MS });
  const settings = new SettingsStore({ area, session, crypto: globalThis.crypto });
  const queue = new CaptureQueue(area);
  const ledger = new AiLedger(area);
  const native = createNativeClient();
  // One cache for the worker's lifetime: it holds the dirty set, and two instances would each think
  // they owned it.
  const syncCache = new SyncCache(
    createBestBackend((globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null).backend,
  );
  const triggers = createSyncTriggers();

  const context: BackgroundContext = {
    settings,
    // Recorded in `.omnipilot/config.json` so the repository says which client wrote it last.
    clientVersion: browser.runtime.getManifest().version,
    queue,
    ledger,
    session,
    native,
    syncCache,
    triggers,
    fetchImpl: (url, init) => fetch(url, init as RequestInit),
    activeTab: async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab) return null;
      return tab.id === undefined ? { url: tab.url } : { id: tab.id, url: tab.url };
    },
    pageClip: async (tabId, distill) => {
      try {
        const accepted = await browser.tabs.sendMessage(tabId, {
          type: PAGE_CLIP_MESSAGE,
          distill,
        });
        return accepted !== false;
      } catch {
        // No content script in that tab (chrome:// pages, the Web Store, a PDF viewer…).
        return false;
      }
    },
  };

  const router = new MessageRouter(
    createRouterOptions(createHandlers(context), {
      secrets: async () => {
        const secrets = await settings.peekSecrets();
        return secrets ? [secrets.githubPat, secrets.providerKey] : [];
      },
      logger: (message, detail) => {
        // Never log content: only the failure category and an already-scrubbed message.
        console.warn(`[synapse] ${message}${detail ? ` :: ${detail}` : ''}`);
      },
    }),
  );

  browser.runtime.onMessage.addListener((message: unknown, sender: unknown) => {
    // Returning a promise keeps the channel open for the async reply.
    return router.handle(message, (sender ?? null) as SenderLike | null);
  });
  const clipActiveTab = async (distill: boolean): Promise<void> => {
    const tab = await context.activeTab?.();
    if (!tab || typeof tab.id !== 'number') return;
    await context.pageClip?.(tab.id, distill);
  };

  /**
   * Top-level listener registration must be BOTH synchronous and crash-free.
   *
   * MV3 requires event listeners to be added during the worker's initial evaluation, and a throw
   * anywhere in that evaluation makes Chrome treat the worker as failed — after which it silently
   * stops dispatching `runtime.onMessage` to it, with no visible error. Every optional API is
   * therefore guarded, and the browser-level listener registration is wrapped.
   */
  try {
    browser.contextMenus?.onClicked.addListener((info) => {
      if (info.menuItemId === CLIP_PAGE_MENU_ID) void clipActiveTab(false);
      if (info.menuItemId === CLIP_SELECTION_MENU_ID) void clipActiveTab(false);
    });
  } catch {
    // contextMenus unavailable — the popup and the in-page bubble still work.
  }

  try {
    // The periodic pull. `SyncTriggers` decides whether the reason is allowed to run, so this listener
    // stays a one-liner that cannot itself wedge the worker.
    browser.alarms?.onAlarm.addListener((alarm) => {
      if (alarm.name === SYNC_ALARM_NAME) void triggers.trigger('alarm');
    });
  } catch {
    // alarms unavailable — manual sync still works.
  }

  try {
    browser.commands?.onCommand.addListener((command) => {
      if (command === CLIP_PAGE_COMMAND) void clipActiveTab(false);
      if (command === CLIP_SELECTION_COMMAND) void clipActiveTab(false);
    });
  } catch {
    // commands unavailable — keyboard shortcuts are a convenience, not a requirement.
  }

  /**
   * The native-messaging client, when this platform has one.
   *
   * `connectNative` is optional by design (Firefox without the host, and every test harness), and an
   * unguarded reference here would throw during the worker's initial evaluation — which Chrome treats
   * as a failed worker that silently stops receiving messages.
   */
  function createNativeClient(): NativeClient | null {
    try {
      const connectNative = browser.runtime?.connectNative;
      if (typeof connectNative !== 'function') return null;
      return new NativeClient({
        connect: (hostName) =>
          connectNative.call(browser.runtime, hostName) as unknown as NativePort,
      });
    } catch {
      return null;
    }
  }

  /** The trigger object owns the coalescing rule; this only supplies the alarm binding. */
  function createSyncTriggers(): SyncTriggers {
    const alarms = (() => {
      try {
        return browser.alarms ?? null;
      } catch {
        return null;
      }
    })();
    return new SyncTriggers({
      run: async (reason) => {
        await performSync(context, reason);
      },
      policy: async () => (await settings.load()).syncPolicy,
      ...(alarms
        ? {
            alarms: {
              create: (name, info) => {
                alarms.create(name, info);
              },
              clear: (name) => alarms.clear(name),
            },
          }
        : {}),
      logger: (message) => console.warn(`[synapse] ${message}`),
    });
  }

  const refresh = async (): Promise<void> => {
    const settingsSnapshot = await settings.load();
    // Honour the user's auto-lock choice for the session already under way.
    session.setTtl(settingsSnapshot.autoLockMinutes * 60_000);
    await settings.refreshPublicPrefs(settingsSnapshot);
  };

  const bootstrap = async (): Promise<void> => {
    await refresh();

    // Keep the periodic alarm in step with the stored policy, then run the startup pull if the user
    // asked for one. Both are best-effort: a failure here must not stop the rest of startup.
    try {
      const snapshot = await settings.load();
      await triggers.schedule(snapshot.syncPolicy);
      if (snapshot.syncPolicy.onStartup && session.isUnlocked()) {
        void triggers.trigger('startup');
      }
    } catch (error) {
      console.warn(`[synapse] startup sync skipped :: ${String(error)}`);
    }

    // Menus are recreated idempotently; a failure here must not abort the rest of startup.
    try {
      await browser.contextMenus?.removeAll();
      browser.contextMenus?.create({
        id: CLIP_PAGE_MENU_ID,
        title: t('popup.clipPage', null, lang),
        contexts: ['page', 'frame'],
      });
      browser.contextMenus?.create({
        id: CLIP_SELECTION_MENU_ID,
        title: t('popup.clipSelection', null, lang),
        contexts: ['selection'],
      });
    } catch {
      // Menu ids already taken, or the API is unavailable: the popup and bubble still work.
    }

    // A stored session key survives a worker recycle within its TTL. The vault still starts locked
    // after a browser restart, because `storage.session` does not outlive it.
    await session.restore();

    // Replay anything captured while the network (or the vault) was unavailable. A locked vault is
    // not an error here — the queue simply waits for the next unlock.
    if (session.isUnlocked()) {
      try {
        // The replay path commits too, so it needs the same single-commit shard wiring as the handler.
        const store = await resolveStore(context);
        const snapshot = await settings.load();
        const service = new CaptureService({
          store,
          queue,
          shards: shardProvider(store, snapshot.github.pathPrefix || null),
        });
        await service.flushQueue();
      } catch {
        // Still offline, still unconfigured, or still locked: leave the queue intact.
      }
    }
  };

  browser.runtime.onInstalled?.addListener(() => void bootstrap());
  browser.runtime.onStartup?.addListener(() => void bootstrap());
  void bootstrap();
});

/** WXT's storage API is typed over prefixed keys; our keys all come from `STORAGE_KEYS`. */
type StorageKey = `local:${string}` | `session:${string}` | `sync:${string}` | `managed:${string}`;

const STORAGE_PREFIXES = ['local:', 'session:', 'sync:', 'managed:'];

/**
 * Narrow a runtime key to the prefixed form WXT expects.
 *
 * Guards rather than blindly casting: a key without an area prefix would otherwise be silently
 * written to the wrong area (or throw somewhere far less obvious).
 */
export function asStorageKey(key: string): StorageKey {
  if (!STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    throw new Error(`storage: key "${key}" is missing an area prefix`);
  }
  return key as StorageKey;
}

/** Adapt WXT's storage API to the narrow `StorageAreaLike` the stores expect. */
export function createStorageArea(): StorageAreaLike {
  return {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) {
        const value = await storage.getItem<unknown>(asStorageKey(key));
        if (value !== null && value !== undefined) out[key] = value;
      }
      return out;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        await storage.setItem(asStorageKey(key), value);
      }
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        await storage.removeItem(asStorageKey(key));
      }
    },
  };
}

/** `storage.session` is memory-backed and cleared when the browser exits — exactly right for a key. */
export function createSessionStore(): SessionKeyStore {
  return {
    async read() {
      const snapshot = await storage.getItem<{ rawKeyB64: string; unlockedAt: number } | null>(
        asStorageKey(STORAGE_KEYS.sessionKey),
      );
      return snapshot ?? null;
    },
    async write(snapshot) {
      await storage.setItem(asStorageKey(STORAGE_KEYS.sessionKey), snapshot);
    },
    async clear() {
      await storage.removeItem(asStorageKey(STORAGE_KEYS.sessionKey));
    },
  };
}
