/**
 * Content script — the only code that runs inside a web page.
 *
 * It is deliberately thin and untrusted: it may read the page, extract text and ask the worker to
 * capture it. It never imports `settings-store`, `crypto-key`, `ai-client` or `github-api`, and it
 * only ever learns about credentials indirectly, through the `local:publicPrefs` projection
 * (`scripts/assert-content-no-secrets.mjs` fails the build if that ever changes).
 */

import { storage } from 'wxt/storage';

import { extractPage, extractSelection } from '../lib/capture/extract';
import { createBubble } from '../lib/dom/bubble';
import { createToast } from '../lib/dom/toast';
import { detectLang, t, type Lang } from '../lib/i18n';
import {
  PAGE_CLIP_MESSAGE,
  errorKeyFor,
  type CaptureRequestPayload,
  type CaptureResultData,
  type ExtensionResponse,
} from '../lib/messages';
import {
  DEFAULT_PUBLIC_PREFS,
  PUBLIC_PREFS_KEY,
  normalizePublicPrefs,
  type PublicPrefs,
} from '../lib/public-prefs';

/** The worker asks the page to clip itself, because only the page can read its own DOM. */
const MIN_SELECTION_CHARS = 2;

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main() {
    void start();
  },
});

async function readPrefs(): Promise<PublicPrefs> {
  try {
    return normalizePublicPrefs(await storage.getItem<unknown>(PUBLIC_PREFS_KEY));
  } catch {
    return { ...DEFAULT_PUBLIC_PREFS };
  }
}

function selectionInPage(): { text: string; rect: DOMRect; context: string } | null {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? '';
  if (!selection || selection.rangeCount === 0 || text.length < MIN_SELECTION_CHARS) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { text, rect, context: extractSelection(selection, document).context };
}

export function buildSelectionPayload(
  doc: Document,
  selection: { text: string; context: string },
  distill: boolean,
): CaptureRequestPayload {
  const payload: CaptureRequestPayload = {
    mode: 'selection',
    url: doc.location?.href ?? '',
    title: doc.title || selection.text.slice(0, 80),
    selection: selection.text,
    ...(selection.context ? { byline: selection.context.slice(0, 200) } : {}),
    ...(doc.documentElement.lang ? { lang: doc.documentElement.lang } : {}),
    ...(distill ? { distill: true } : {}),
  };
  return payload;
}

export function buildPagePayload(doc: Document, distill: boolean): CaptureRequestPayload {
  const page = extractPage(doc);
  return {
    mode: 'page',
    url: page.url,
    title: page.title,
    body: page.text,
    ...(page.byline ? { byline: page.byline } : {}),
    ...(page.lang ? { lang: page.lang } : {}),
    ...(distill ? { distill: true } : {}),
  };
}

async function start(): Promise<void> {
  let prefs = await readPrefs();
  if (!prefs.enabled) return;

  const lang: Lang = detectLang(navigator.language);
  const toast = createToast({ doc: document, lang });

  const sendCapture = async (
    payload: CaptureRequestPayload,
  ): Promise<ExtensionResponse<CaptureResultData>> =>
    (await browser.runtime.sendMessage({
      type: 'capture.request',
      payload,
    })) as ExtensionResponse<CaptureResultData>;

  const refuseIfNotReady = (): boolean => {
    if (prefs.repoFullName.length === 0 || !prefs.hasPat) {
      toast.show(t('popup.needSetup', null, lang), 'error');
      return true;
    }
    if (prefs.securityMode === 'vault' && prefs.vaultLocked) {
      toast.show(t('popup.needUnlock', null, lang), 'error');
      return true;
    }
    return false;
  };

  const report = (response: ExtensionResponse<CaptureResultData>, wantedDistill: boolean): void => {
    if (!response.ok) {
      toast.show(t(errorKeyFor(response.code), null, lang), 'error');
      return;
    }
    const data = response.data;
    const link = { href: data.commitUrl, label: t('popup.openItem', null, lang) };

    if (data.duplicate) {
      toast.show(t('popup.duplicate', null, lang), 'info', link);
      return;
    }
    if (wantedDistill && data.distill) {
      toast.show(t('popup.distill', null, lang), 'success', link);
      return;
    }
    if (wantedDistill && data.distillSkipped !== undefined) {
      // The capture succeeded, but egress is not authorized — say so instead of pretending.
      toast.show(t('options.ai.authorizeHint', null, lang), 'info', link);
      return;
    }
    toast.show(t('popup.saved', null, lang), 'success', link);
  };

  const clipSelection = async (distill: boolean): Promise<void> => {
    bubble.hide();
    if (refuseIfNotReady()) return;
    const current = selectionInPage();
    if (!current) return;
    report(await sendCapture(buildSelectionPayload(document, current, distill)), distill);
  };

  const bubble = createBubble({
    doc: document,
    lang,
    actions: {
      onClip: () => void clipSelection(false),
      onDistill: () => void clipSelection(true),
      onClose: () => undefined,
    },
  });

  const maybeShowBubble = async (): Promise<void> => {
    /*
     * The switch is re-read at the moment of the selection, not only when this script was injected: a page that
     * loaded while capture was on kept showing its bubble after the owner turned capture off, because nothing
     * told the script. The projection is local, so this costs no round trip and makes the switch immediate.
     */
    try {
      prefs = await readPrefs();
    } catch {
      // Cannot read the switch: stay quiet rather than offer an action that may be forbidden.
      bubble.hide();
      return;
    }
    if (!prefs.enabled) {
      bubble.hide();
      return;
    }
    const current = selectionInPage();
    if (!current) {
      bubble.hide();
      return;
    }
    bubble.showAt(current.rect);
  };

  const onSelectionSettled = (): void => void maybeShowBubble();
  document.addEventListener('mouseup', onSelectionSettled, true);
  document.addEventListener('keyup', onSelectionSettled, true);
  document.addEventListener(
    'mousedown',
    (event) => {
      if (!bubble.element.contains(event.target as Node)) bubble.hide();
    },
    true,
  );
  document.addEventListener('scroll', () => bubble.hide(), { passive: true, capture: true });

  // Only the extension itself can send this; page scripts cannot reach a content script's runtime.
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return undefined;
    const request = message as { type?: unknown; distill?: unknown };
    if (request.type !== PAGE_CLIP_MESSAGE) return undefined;

    const wantedDistill = request.distill === true;
    if (refuseIfNotReady()) return Promise.resolve(false);
    return sendCapture(buildPagePayload(document, wantedDistill)).then((response) => {
      report(response, wantedDistill);
      return response.ok;
    });
  });

  // Keep the master switch live without asking the worker for preferences on every interaction.
  storage.watch<unknown>(PUBLIC_PREFS_KEY, (next) => {
    prefs = normalizePublicPrefs(next);
    if (!prefs.enabled) bubble.hide();
  });
}
