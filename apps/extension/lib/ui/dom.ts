/**
 * Tiny DOM builders shared by the popup and the options page.
 *
 * House rules, borrowed from `lib/dom/bubble.ts`:
 * - nodes are created with `document.createElement` and filled with `textContent` only; there is no
 *   `innerHTML` anywhere, so neither a page title nor a repository path can ever become markup;
 * - every label passed in here is an i18n KEY, translated while the node is built — the callers
 *   never hand over a raw sentence.
 */

import { t, type Lang } from '../i18n';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined && className.length > 0) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function button(label: string, className?: string): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  return node;
}

export function datalist(id: string, values: readonly string[]): HTMLDataListElement {
  const list = el('datalist');
  list.id = id;
  for (const value of values) {
    const option = el('option');
    option.value = value;
    list.appendChild(option);
  }
  return list;
}

export interface TextFieldOptions {
  type?: 'text' | 'password' | 'number' | 'url';
  placeholder?: string;
  value?: string;
  maxLength?: number;
  listId?: string;
  lang?: Lang;
}

export interface TextField {
  root: HTMLDivElement;
  input: HTMLInputElement;
}

/** A labelled input. `type: 'password'` is how a credential field is always rendered. */
export function textField(labelKey: string, options: TextFieldOptions = {}): TextField {
  const root = el('div', 'field');
  const label = el('label', 'field-label');
  const input = el('input', 'control');
  input.type = options.type ?? 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  if (options.placeholder !== undefined) input.placeholder = options.placeholder;
  if (options.value !== undefined) input.value = options.value;
  if (options.maxLength !== undefined) input.maxLength = options.maxLength;
  if (options.listId !== undefined) input.setAttribute('list', options.listId);
  label.append(el('span', 'field-text', t(labelKey, null, options.lang)), input);
  root.appendChild(label);
  return { root, input };
}

export interface CheckboxField {
  root: HTMLLabelElement;
  input: HTMLInputElement;
}

export function checkboxField(labelKey: string, checked = false, lang?: Lang): CheckboxField {
  const root = el('label', 'checkbox');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  root.append(input, el('span', undefined, t(labelKey, null, lang)));
  return { root, input };
}

export interface SelectField {
  root: HTMLDivElement;
  select: HTMLSelectElement;
}

export function selectField(
  labelKey: string,
  options: readonly { value: string; label: string }[],
  selected?: string,
  lang?: Lang,
): SelectField {
  const root = el('div', 'field');
  const label = el('label', 'field-label');
  const select = el('select', 'control');
  for (const option of options) {
    const node = el('option', undefined, option.label);
    node.value = option.value;
    select.appendChild(node);
  }
  if (selected !== undefined) select.value = selected;
  label.append(el('span', 'field-text', t(labelKey, null, lang)), select);
  root.appendChild(label);
  return { root, select };
}

export interface Card {
  root: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
}

/** One options section: a heading, a body the wiring fills in, and a footer with its save button. */
export function card(titleKey: string, lang?: Lang): Card {
  const root = el('section', 'card');
  const title = el('h2', 'card-title', t(titleKey, null, lang));
  const body = el('div', 'card-body');
  const footer = el('div', 'card-footer');
  root.append(title, body, footer);
  return { root, body, footer };
}

export function toastArea(): HTMLDivElement {
  const root = el('div', 'toast');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.hidden = true;
  return root;
}

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastLink {
  href: string;
  label: string;
  onOpen(href: string): void;
}

export interface ToastController {
  element: HTMLElement;
  show(message: string, kind?: ToastKind, link?: ToastLink): void;
  hide(): void;
}

export const TOAST_VISIBLE_MS = 5_000;

/**
 * The page-level toast area: one message, optionally one follow-up link. The link is a button, not
 * an anchor, so opening a commit URL always goes through the extension's own `tabs.create` path and
 * never through a same-window navigation of an options page.
 */
export function createToastController(root: HTMLElement, visibleMs = TOAST_VISIBLE_MS): ToastController {
  let handle: ReturnType<typeof setTimeout> | null = null;

  function hide(): void {
    root.hidden = true;
    root.textContent = '';
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  }

  function show(message: string, kind: ToastKind = 'info', link?: ToastLink): void {
    hide();
    root.dataset['kind'] = kind;
    root.appendChild(el('span', undefined, message));
    if (link) {
      const open = button(link.label, 'link');
      open.addEventListener('click', () => link.onOpen(link.href));
      root.appendChild(open);
    }
    root.hidden = false;
    handle = setTimeout(hide, visibleMs);
  }

  return { element: root, show, hide };
}
