/**
 * The capture feedback toast.
 *
 * Deliberately the ONLY way the content script reports an outcome: it shows a translated message and
 * optionally a link the user can open. It never renders server text, a path from the repository, or
 * an error string that could contain a URL with a token in it.
 */

import { el, injectOverlayStyles, OVERLAY_CSS } from './bubble';
import type { Lang } from '../i18n';

export type ToastKind = 'info' | 'success' | 'error';

export const TOAST_VISIBLE_MS = 4_000;
export const TOAST_ERROR_VISIBLE_MS = 7_000;

export interface ToastOptions {
  doc: Document;
  lang?: Lang;
  /** Injected so tests do not need timers. */
  setTimeoutImpl?: (handler: () => void, timeout: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

export interface Toast {
  readonly element: HTMLElement;
  show(message: string, kind?: ToastKind, link?: { href: string; label: string }): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
}

export function createToast(options: ToastOptions): Toast {
  const { doc, setTimeoutImpl, clearTimeoutImpl } = options;
  injectOverlayStyles(doc, OVERLAY_CSS);

  const root = el(doc, 'div', 'omnipilot-toast');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.hidden = true;

  let handle: unknown = null;
  /*
   * Real timers unless a test injects fakes. The injected pair used to BE the mechanism, which meant the
   * toast only ever auto-dismissed under test: in production it stayed on the page for good, covering
   * the content the user was reading. A seam decides nothing on its own.
   */
  const schedule =
    setTimeoutImpl ?? ((handler: () => void, ms: number) => globalThis.setTimeout(handler, ms));
  const cancel = clearTimeoutImpl ?? ((value: unknown) => globalThis.clearTimeout(value as number));

  function hide(): void {
    root.hidden = true;
    root.textContent = '';
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
  }

  function show(message: string, kind: ToastKind = 'info', link?: { href: string; label: string }): void {
    hide();
    root.textContent = message;
    root.dataset['kind'] = kind;
    if (link) {
      const anchor = el(doc, 'a', undefined, ` ${link.label}`);
      // Only ever an https URL built by the worker from the commit response.
      if (/^https:\/\//u.test(link.href)) {
        anchor.setAttribute('href', link.href);
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
        root.appendChild(anchor);
      }
    }
    root.hidden = false;
    const timeout = kind === 'error' ? TOAST_ERROR_VISIBLE_MS : TOAST_VISIBLE_MS;
    handle = schedule(() => hide(), timeout);
  }

  // Clicking it dismisses early: an error the user has already read should not have to be waited out.
  // Bound once, not per `show`, so repeated messages cannot pile up listeners.
  root.addEventListener('click', () => hide());

  (doc.body ?? doc.documentElement).appendChild(root);

  return {
    element: root,
    show,
    hide,
    isVisible: () => root.hidden === false,
    destroy: () => {
      hide();
      root.remove();
    },
  };
}
