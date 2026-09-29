/**
 * In-page UI primitives for the content script.
 *
 * These run inside an untrusted page, so they follow three rules:
 * - everything is namespaced under `omnipilot-` and mounted in a shadow-free but isolated overlay
 *   host with a very high z-index and `all: initial`-style resets, so a hostile page's CSS cannot
 *   turn the bubble into a clickjacking surface;
 * - the modules never read settings, tokens or storage — they only render and call back;
 * - all text comes from `lib/i18n.ts`, never from page content, so a page cannot inject markup
 *   through a label.
 */

import { t, type Lang } from '../i18n';

export const OVERLAY_STYLE_ID = 'omnipilot-overlay-style';

export interface DomRectLike {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

export const BUBBLE_OFFSET_PX = 8;
export const VIEWPORT_MARGIN_PX = 8;

/** `textContent` only — never `innerHTML` — so page content can never become markup. */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Inject the overlay stylesheet once per document. */
export function injectOverlayStyles(doc: Document, css: string): void {
  if (doc.getElementById(OVERLAY_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = OVERLAY_STYLE_ID;
  style.textContent = css;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export const OVERLAY_CSS = `
.omnipilot-bubble {
  position: fixed;
  z-index: 2147483647;
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 4px;
  border-radius: 10px;
  background: #111827;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
  font: 13px/1.2 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #f9fafb;
  user-select: none;
}
.omnipilot-bubble[hidden] { display: none; }
.omnipilot-bubble button {
  all: unset;
  cursor: pointer;
  padding: 5px 10px;
  border-radius: 7px;
  color: #f9fafb;
  white-space: nowrap;
}
.omnipilot-bubble button:hover { background: #1f6feb; }
.omnipilot-bubble button[data-action="close"] { padding: 5px 8px; color: #9ca3af; }
.omnipilot-toast {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483647;
  max-width: 320px;
  padding: 10px 14px;
  border-radius: 10px;
  background: #111827;
  color: #f9fafb;
  font: 13px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
}
.omnipilot-toast[hidden] { display: none; }
.omnipilot-toast[data-kind="error"] { background: #7f1d1d; }
.omnipilot-toast[data-kind="success"] { background: #14532d; }
`;

export interface BubbleActions {
  onClip(): void;
  onDistill(): void;
  onClose(): void;
}

export interface BubbleOptions {
  doc: Document;
  actions: BubbleActions;
  lang?: Lang;
}

export interface Bubble {
  readonly element: HTMLElement;
  showAt(rect: DomRectLike): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
}

/**
 * The selection bubble: 剪藏 / 提炼 / 关闭.
 *
 * Positioning is clamped to the viewport so a selection near the right or bottom edge cannot push
 * the bubble off-screen (a classic way to make an extension feel broken).
 */
export function createBubble(options: BubbleOptions): Bubble {
  const { doc, actions, lang } = options;
  injectOverlayStyles(doc, OVERLAY_CSS);

  const root = el(doc, 'div', 'omnipilot-bubble');
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', t('app.name', null, lang));
  root.hidden = true;

  const clip = el(doc, 'button', undefined, t('bubble.clip', null, lang));
  clip.dataset['action'] = 'clip';
  const distill = el(doc, 'button', undefined, t('bubble.distill', null, lang));
  distill.dataset['action'] = 'distill';
  const close = el(doc, 'button', undefined, '×');
  close.dataset['action'] = 'close';
  close.setAttribute('aria-label', t('bubble.close', null, lang));
  root.append(clip, distill, close);

  // `mousedown` is prevented so the page selection survives the click that triggers the action.
  const stopSelectionLoss = (event: Event): void => event.preventDefault();
  const onClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const action = target?.dataset?.['action'];
    if (action === 'clip') actions.onClip();
    else if (action === 'distill') actions.onDistill();
    else if (action === 'close') {
      hide();
      actions.onClose();
    }
  };

  root.addEventListener('mousedown', stopSelectionLoss);
  root.addEventListener('click', onClick);

  function hide(): void {
    root.hidden = true;
  }

  function showAt(rect: DomRectLike): void {
    root.hidden = false;
    // Place below the selection when there is room, otherwise above it.
    const estimatedHeight = 34;
    const below = rect.bottom + BUBBLE_OFFSET_PX;
    const useAbove = below + estimatedHeight > (doc.defaultView?.innerHeight ?? Number.MAX_SAFE_INTEGER);
    const top = useAbove ? Math.max(VIEWPORT_MARGIN_PX, rect.top - estimatedHeight) : below;

    const viewportWidth = doc.defaultView?.innerWidth ?? Number.MAX_SAFE_INTEGER;
    const estimatedWidth = 190;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN_PX, rect.left),
      Math.max(VIEWPORT_MARGIN_PX, viewportWidth - estimatedWidth - VIEWPORT_MARGIN_PX),
    );

    root.style.top = `${Math.round(top)}px`;
    root.style.left = `${Math.round(left)}px`;
  }

  (doc.body ?? doc.documentElement).appendChild(root);

  return {
    element: root,
    showAt,
    hide,
    isVisible: () => root.hidden === false,
    destroy: () => {
      root.removeEventListener('mousedown', stopSelectionLoss);
      root.removeEventListener('click', onClick);
      root.remove();
    },
  };
}
