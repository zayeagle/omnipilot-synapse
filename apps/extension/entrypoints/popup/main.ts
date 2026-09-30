/**
 * Popup console — the "剪藏 ≤ 2 步" surface.
 *
 * The whole file is wiring: it builds nodes, sends one message per user action, and hands every
 * decision to `lib/ui/format.ts` (which is pure and unit-tested). Two rules it never breaks:
 * - the popup talks to the worker only through `runtime.sendMessage`; it never imports the settings
 *   store, the vault or the crypto layer, so a page context can never grow one on our behalf;
 * - everything the user reads is `textContent` from an i18n key — the only outside strings that
 *   reach a node are a page title, a repository path and a commit URL, all length-capped and all
 *   rendered as text.
 */

import { browser } from 'wxt/browser';

import { detectLang, t, type Lang } from '../../lib/i18n';
import {
  isExtensionResponse,
  type CardDecisionAction,
  type CardPatch,
  type CaptureRequestPayload,
  type CaptureResultData,
  type DistillRequestPayload,
  type DistillResultData,
  type ExtensionRequest,
  type ExtensionResponse,
  type ErrorCode,
} from '../../lib/messages';
import type { StatusLine } from '../../lib/status';
import {
  button,
  clear,
  createToastController,
  el,
  toastArea,
} from '../../lib/ui/dom';
import {
  describeError,
  distillPayloadFor,
  firstInjectionResult,
  inboxRows,
  isSafeExternalUrl,
  normalizeStatusPayload,
  normalizeSyncResult,
  normalizeSyncStatus,
  searchResultRows,
  selectionCapturePayload,
  statusPanel,
  type InboxRow,
  type SearchResultRow,
} from '../../lib/ui/format';
import { errorGuidance } from '../../lib/status';
import {
  cardPatchFor,
  decisionResult,
  pendingCardRows,
  PENDING_LIMIT,
  type CardDecisionResult,
  type PendingCardRow,
} from './pending';
import { dueRows } from './due';

const LANG: Lang = detectLang(typeof navigator === 'undefined' ? null : navigator.language);
const INBOX_LIMIT = 5;

const STATUS_ROWS: ReadonlyArray<{ key: keyof StatusLine; labelKey: string }> = [
  { key: 'store', labelKey: 'status.store' },
  { key: 'repo', labelKey: 'status.repo' },
  { key: 'mode', labelKey: 'status.mode' },
  { key: 'vault', labelKey: 'status.vault' },
  { key: 'ai', labelKey: 'status.ai' },
  // F5: the authorization mode + branch, and the sync state, are first-class status rows.
  { key: 'auth', labelKey: 'status.auth' },
  { key: 'sync', labelKey: 'status.sync' },
];

/* ------------------------------- worker bridge ----------------------------- */

/**
 * One round trip, with a hard guard on the reply: the worker is written in parallel, so an
 * unexpected shape must degrade to an error toast rather than a thrown exception.
 */
async function send<T = unknown>(request: ExtensionRequest): Promise<ExtensionResponse<T>> {
  try {
    const raw: unknown = await browser.runtime.sendMessage(request);
    if (!isExtensionResponse(raw)) return { ok: false, error: 'unexpected reply', code: 'unknown' };
    return raw as ExtensionResponse<T>;
  } catch {
    return { ok: false, error: 'message failed', code: 'unknown' };
  }
}

/** Read the selection out of the active tab. Serialised into the page, so it closes over nothing. */
function readPageSelection(): { text: string; lang: string } {
  const selection = window.getSelection();
  return {
    text: selection ? selection.toString() : '',
    lang: document.documentElement ? document.documentElement.lang : '',
  };
}

async function openExternal(href: string): Promise<void> {
  if (!isSafeExternalUrl(href)) return;
  await browser.tabs.create({ url: href });
}

/* ---------------------------------- the page ------------------------------- */

function main(): void {
  document.title = t('app.name', null, LANG);
  const app = document.getElementById('app');
  if (!app) return;

  /* header */
  const header = el('header');
  header.append(
    el('h1', undefined, t('app.name', null, LANG)),
    el('p', 'tagline', t('app.tagline', null, LANG)),
  );

  /* master switch */
  const switchLabel = el('label', 'switch');
  const enabledInput = el('input');
  enabledInput.type = 'checkbox';
  switchLabel.append(enabledInput, el('span', undefined, t('popup.masterSwitch', null, LANG)));
  const refreshButton = button(t('popup.refresh', null, LANG));
  const switchRow = el('div', 'row');
  switchRow.append(switchLabel, el('span', 'spacer'), refreshButton);

  /* clip actions */
  const clipPageButton = button(t('popup.clipPage', null, LANG), 'primary');
  const clipSelectionButton = button(t('popup.clipSelection', null, LANG));
  const actions = el('div', 'row');
  actions.append(clipPageButton, clipSelectionButton);

  /* readiness notice */
  const notice = el('p', 'notice');
  notice.dataset['kind'] = 'blocked';

  /* status rows */
  const statusList = el('dl', 'status');
  const statusValues = new Map<keyof StatusLine, HTMLElement>();
  for (const row of STATUS_ROWS) {
    const value = el('dd', undefined, '—');
    statusValues.set(row.key, value);
    statusList.append(el('dt', undefined, t(row.labelKey, null, LANG)), value);
  }

  /* sync row: the outcome plus the two counts the public projection carries (no content) */
  const syncOutcomeText = el('span', 'badge', t('options.sync.outcome.never', null, LANG));
  const syncCountsText = el('span', 'inbox-meta', '');
  const syncNowButton = button(t('popup.syncNow', null, LANG));
  // Only shown when the last failure has an action; a button that does nothing is worse than no button.
  const syncFixButton = button('', 'link');
  syncFixButton.hidden = true;
  const syncRow = el('div', 'row');
  syncRow.append(
    el('span', 'field-text', t('popup.sync', null, LANG)),
    syncOutcomeText,
    syncCountsText,
    syncFixButton,
    el('span', 'spacer'),
    syncNowButton,
  );

  /* search: one box, one button, a whitelisted result list */
  const searchSection = el('section');
  const searchInput = el('input', 'control');
  searchInput.type = 'search';
  searchInput.spellcheck = false;
  searchInput.autocomplete = 'off';
  searchInput.placeholder = t('popup.searchPlaceholder', null, LANG);
  const searchButton = button(t('options.search.button', null, LANG));
  const searchBox = el('div', 'row');
  searchBox.append(searchInput, searchButton);
  const searchMessage = el('p', 'hint');
  const searchList = el('ul', 'inbox');
  searchSection.append(
    el('h2', undefined, t('popup.search', null, LANG)),
    searchBox,
    searchMessage,
    searchList,
  );

  /* inbox */
  const inboxSection = el('section');
  const inboxList = el('ul', 'inbox');
  inboxSection.append(el('h2', undefined, t('popup.inbox', null, LANG)), inboxList);

  /* 待处理 — the AI's proposals. Loaded from `cards.list` on open and after a decision, never on its own. */
  const pendingSection = el('section');
  const pendingList = el('ul', 'pending');
  const dueTitle = el('h2', undefined, t('popup.dueNone', null, LANG));
  const dueList = el('ul', 'due');
  const pendingResult = el('p', 'pending-result');
  // 丢弃 is the one action whose consequence is not obvious, so the explanation is always on screen,
  // not hidden behind a tooltip the reader may never hover.
  const pendingHint = el('p', 'pending-hint', t('popup.cardDiscardHint', null, LANG));
  pendingSection.append(
    el('h2', undefined, t('popup.pending', null, LANG)),
    pendingList,
    dueTitle,
    dueList,
    pendingResult,
    pendingHint,
  );

  /* footer */
  const settingsButton = button(t('popup.openOptions', null, LANG));
  const footer = el('div', 'row');
  footer.append(settingsButton);

  /* toast */
  const toastRoot = toastArea();
  const toast = createToastController(toastRoot);

  app.append(
    header,
    switchRow,
    actions,
    notice,
    statusList,
    syncRow,
    searchSection,
    inboxSection,
    pendingSection,
    footer,
    toastRoot,
  );

  /* --------------------------------- state -------------------------------- */

  let canClip = false;
  let canSync = false;
  let busy = false;
  let searchBusy = false;
  /** One card per request: a second decision waits for the first commit. */
  let deciding = false;
  /** Latest `sync.status` projection; the status reply carries counts but not the full list. */
  let syncView = normalizeSyncStatus(null);
  /** The public preferences from the last `status.get`, for the search result URLs. */
  let lastPrefs = normalizeStatusPayload(null).prefs;

  function setBusy(next: boolean): void {
    busy = next;
    clipPageButton.textContent = next ? t('popup.working', null, LANG) : t('popup.clipPage', null, LANG);
    clipPageButton.disabled = next || !canClip;
    clipSelectionButton.disabled = next || !canClip;
    refreshButton.disabled = next;
    syncNowButton.disabled = next || !canSync;
    searchButton.disabled = next || searchBusy;
  }

  function showError(code: unknown): void {
    const described = describeError(code, LANG);
    toast.show(
      described.hint === null ? described.message : `${described.message} — ${described.hint}`,
      'error',
    );
  }

  function toastWithCommit(message: string, kind: 'info' | 'success', commitUrl: unknown): void {
    if (isSafeExternalUrl(commitUrl)) {
      toast.show(message, kind, {
        href: String(commitUrl),
        label: t('popup.openItem', null, LANG),
        onOpen: (href) => void openExternal(href),
      });
      return;
    }
    toast.show(message, kind);
  }

  /* -------------------------------- rendering ------------------------------ */

  function renderUnavailable(): void {
    canClip = false;
    enabledInput.disabled = true;
    for (const value of statusValues.values()) {
      value.textContent = '—';
      delete value.dataset['kind'];
    }
    notice.textContent = t('popup.working', null, LANG);
    notice.dataset['kind'] = 'blocked';
    canSync = false;
    syncOutcomeText.textContent = t('options.sync.outcome.never', null, LANG);
    syncOutcomeText.dataset['kind'] = 'unknown';
    syncCountsText.textContent = '';
    setBusy(busy);
  }

  function renderStatus(response: ExtensionResponse<unknown>): void {
    if (!response.ok) {
      renderUnavailable();
      showError(response.code);
      return;
    }
    const status = normalizeStatusPayload(response.data);
    const panel = statusPanel(response.data, LANG);
    lastPrefs = status.prefs;

    enabledInput.disabled = false;
    enabledInput.checked = status.prefs.enabled;
    for (const row of STATUS_ROWS) {
      const node = statusValues.get(row.key);
      if (node) node.textContent = panel.rows[row.key];
    }

    canClip = panel.canClip;
    canSync = panel.canSync;
    renderSyncPanel();
    notice.dataset['kind'] = panel.canClip ? 'ok' : 'blocked';
    if (panel.canClip) {
      notice.textContent = panel.notice;
    } else {
      // `readinessLabel` and the notice are often the same sentence; only show it when it adds.
      notice.textContent =
        panel.readinessLabel === panel.notice
          ? panel.notice
          : `${panel.readinessLabel} — ${panel.notice}`;
    }
    setBusy(busy);
  }

  /**
   * The popup's sync row.
   *
   * The fixity rule applies here too: the outcome is one of the eight fixed sentences and the counts
   * are integers, so nothing the worker stores can appear in this row.
   */
  function renderSyncPanel(): void {
    syncOutcomeText.textContent = t(`options.sync.outcome.${syncView.outcome}`, null, LANG);
    syncOutcomeText.dataset['kind'] = canSync ? 'private' : 'unknown';
    const counts: string[] = [];
    if (syncView.lastSyncAt.length > 0) counts.push(syncView.lastSyncAt);
    if (syncView.pending > 0) counts.push(t('status.pending', { count: syncView.pending }, LANG));
    if (syncView.conflicts.length > 0) {
      counts.push(t('status.conflicts', { count: syncView.conflicts.length }, LANG));
    }
    syncCountsText.textContent = counts.join(' · ');
    // The cause in the user's own language, plus the single action that fixes it (T4.3). The worker's own
    // error sentence is never rendered — the table turns a closed code into a fixed sentence.
    const guidance = syncView.failureCode ? errorGuidance(syncView.failureCode as ErrorCode) : null;
    syncFixButton.hidden = guidance === null || guidance.target === 'none';
    if (guidance !== null) {
      syncFixButton.textContent = t(guidance.actionKey, null, LANG);
      syncFixButton.dataset['target'] = guidance.target;
    }
  }

  /** Fold a `sync.status` reply into the row; a failed read degrades to "never synced". */
  syncFixButton.addEventListener('click', () => {
    const target = syncFixButton.dataset['target'];
    // `unlock` lives in the options page (the popup has no passphrase field), so it opens the same place
    // `storage` and `companion` do rather than pretending to be a vault prompt.
    if (target === 'storage' || target === 'companion' || target === 'unlock') {
      void browser.runtime.openOptionsPage();
      return;
    }
    // Anything else is a retry, and reusing the existing button keeps one sync entry point.
    syncNowButton.click();
  });

  function applySyncStatus(response: ExtensionResponse<unknown>): void {
    syncView = response.ok ? normalizeSyncStatus(response.data) : normalizeSyncStatus(null);
    renderSyncPanel();
  }

  function renderSearch(rows: SearchResultRow[], needsRebuild: boolean): void {
    clear(searchList);
    searchMessage.hidden = rows.length > 0;
    searchMessage.dataset['kind'] = needsRebuild ? 'error' : 'info';
    if (needsRebuild && rows.length === 0) {
      searchMessage.textContent = t('popup.searchNeedsRebuild', null, LANG);
    } else {
      searchMessage.textContent = t('popup.searchEmpty', null, LANG);
    }
    for (const row of rows) {
      const item = el('li');
      const title = el('span', 'inbox-title', row.title);
      title.title = row.title;
      const meta = el('span', 'inbox-meta', row.snippet || row.path);
      const open = button(t('popup.openItem', null, LANG), 'link');
      open.disabled = row.url.length === 0;
      open.addEventListener('click', () => void openExternal(row.url));
      const rowActions = el('div', 'inbox-actions');
      rowActions.append(open);
      item.append(title, meta, rowActions);
      searchList.appendChild(item);
    }
  }

  function renderInbox(response: ExtensionResponse<unknown>): void {
    clear(inboxList);
    if (!response.ok) {
      showError(response.code);
      inboxList.appendChild(el('li', 'empty', t('popup.inboxEmpty', null, LANG)));
      return;
    }
    const rows = inboxRows(response.data, INBOX_LIMIT);
    if (rows.length === 0) {
      inboxList.appendChild(el('li', 'empty', t('popup.inboxEmpty', null, LANG)));
      return;
    }
    for (const row of rows) inboxList.appendChild(inboxItem(row));
  }

  function inboxItem(row: InboxRow): HTMLLIElement {
    const item = el('li');
    const title = el('span', 'inbox-title', row.title);
    title.title = row.title;
    const meta = el('span', 'inbox-meta', [row.capturedAt, row.path].filter((part) => part.length > 0).join(' · '));

    const distill = button(t('popup.distill', null, LANG), 'link');
    distill.addEventListener('click', () => void distillRow(row, distill));
    const open = button(t('popup.openItem', null, LANG), 'link');
    open.disabled = row.url.length === 0;
    open.addEventListener('click', () => void openExternal(row.url));

    const rowActions = el('div', 'inbox-actions');
    rowActions.append(distill, open);
    item.append(title, meta, rowActions);
    return item;
  }

  /* ------------------------------ 待处理 (F3) ------------------------------ */

  /**
   * The last thing that happened in this section.
   *
   * It is state, not a side effect of rendering: a decision re-reads the list, and the answer the human just
   * caused has to survive that re-render. Only a user-initiated 刷新 clears it.
   */
  let pendingMessage: { text: string; kind: 'info' | 'success' | 'error' } | null = null;

  function paintPendingResult(): void {
    pendingResult.textContent = pendingMessage === null ? '' : pendingMessage.text;
    if (pendingMessage === null) delete pendingResult.dataset['kind'];
    else pendingResult.dataset['kind'] = pendingMessage.kind;
  }

  function showPendingResult(message: string, kind: 'info' | 'success' | 'error'): void {
    pendingMessage = { text: message, kind };
    paintPendingResult();
  }

  function renderPending(response: ExtensionResponse<unknown>): void {
    clear(pendingList);
    // The result line is deliberately not cleared here — it belongs to the decision, not to the list.
    if (!response.ok) {
      // A list we could not read is NOT an empty list: claiming "nothing pending" would hide the failure (W6).
      pendingHint.hidden = true;
      const described = describeError(response.code, LANG);
      showPendingResult(
        described.hint === null ? described.message : `${described.message} — ${described.hint}`,
        'error',
      );
      return;
    }
    const rows = pendingCardRows(response.data, PENDING_LIMIT);
    // The archive explanation is only worth its line when there is something that could be discarded.
    pendingHint.hidden = rows.length === 0;
    if (rows.length === 0) {
      pendingList.appendChild(el('li', 'empty', t('popup.pendingEmpty', null, LANG)));
      return;
    }
    for (const row of rows) pendingList.appendChild(pendingItem(row));
  }

  /**
   * What the user is about to forget — the one thing the product should say without being asked, and the reason
   * `review/state.json` exists at all. Rendered from the same projection the tests cover (`dueRows`), so the
   * arithmetic stays out of the DOM code.
   */
  function renderDue(response: ExtensionResponse<unknown>): void {
    clear(dueList);
    const rows = dueRows(response.ok ? response.data : null);
    // A failed read must not read as "nothing to review" — that would be the silent-failure mistake again (W6).
    dueTitle.textContent = !response.ok
      ? t('popup.dueUnavailable', null, LANG)
      : rows.length === 0
        ? t('popup.dueNone', null, LANG)
        : t('popup.due', { count: rows.length }, LANG);
    for (const row of rows) {
      const item = el('li', 'due-item');
      item.append(el('span', 'inbox-title', row.label.length > 0 ? row.label : row.id));
      item.append(
        el(
          'span',
          'inbox-meta',
          row.overdueDays > 0
            ? t('popup.dueOverdue', { days: row.overdueDays }, LANG)
            : t('popup.dueToday', null, LANG),
        ),
      );
      dueList.appendChild(item);
    }
  }

  async function refreshPending(): Promise<void> {
    renderPending(await send<unknown>({ type: 'cards.list', payload: { limit: PENDING_LIMIT } }));
  }

  /**
   * One proposal, three suggestions and no pre-selected answer: 接受 / 改写 / 丢弃 are styled as peers, because
   * nudging one of them would be the AI deciding rather than proposing (E2).
   */
  function pendingItem(row: PendingCardRow): HTMLLIElement {
    const item = el('li', 'pending-card');
    if (row.unreadable) {
      // The proposal exists but its body could not be read (locked vault, corrupt record). It is shown as
      // exactly that — and without buttons, because every decision would have to read the very file we could not.
      item.append(
        el('span', 'inbox-title', t('popup.pendingUnreadable', null, LANG)),
        el('span', 'inbox-meta pending-note', t('popup.pendingUnreadableHint', null, LANG)),
        el('span', 'inbox-meta card-source', row.path),
      );
      return item;
    }

    const titled = row.title.length > 0;
    const title = el('span', 'inbox-title', titled ? row.title : t('popup.cardUntitled', null, LANG));
    title.title = titled ? row.title : row.path;
    item.appendChild(title);

    if (row.summary.length > 0) item.appendChild(el('span', 'card-summary', row.summary));
    if (row.points.length > 0) {
      const points = el('ul', 'points');
      for (const point of row.points) points.appendChild(el('li', undefined, point));
      item.appendChild(points);
    }
    if (row.hiddenPoints > 0) {
      item.appendChild(el('span', 'inbox-meta', t('popup.cardMorePoints', { count: row.hiddenPoints }, LANG)));
    }
    if (row.tags.length > 0) item.appendChild(el('span', 'card-tags', row.tags.join(' · ')));
    if (row.source.length > 0) {
      // `evidence_paths[0]` is a repository path and stays text: the popup invents no URL scheme for it.
      item.appendChild(el('span', 'inbox-meta card-source', t('popup.cardSource', { path: row.source }, LANG)));
    }
    if (row.createdAt.length > 0) item.appendChild(el('span', 'inbox-meta', row.createdAt));

    const actions = el('div', 'inbox-actions');
    const accept = button(t('popup.cardAccept', null, LANG));
    const rewrite = button(t('popup.cardEdit', null, LANG));
    const discard = button(t('popup.cardDiscard', null, LANG));
    discard.title = t('popup.cardDiscardHint', null, LANG);
    accept.addEventListener('click', () => void decide(row, 'accept'));
    discard.addEventListener('click', () => void decide(row, 'discard'));
    rewrite.addEventListener('click', () => openRewrite(item, actions, row));
    actions.append(accept, rewrite, discard);
    item.appendChild(actions);
    return item;
  }

  /** 改写 reveals the two fields a human may correct; it saves nothing until 保存 is pressed. */
  function openRewrite(item: HTMLLIElement, actions: HTMLElement, row: PendingCardRow): void {
    const form = el('div', 'card-edit');

    const titleField = el('label', 'card-edit-field');
    const titleInput = el('input', 'control');
    titleInput.type = 'text';
    titleInput.maxLength = 2000;
    titleInput.value = row.title;
    titleField.append(el('span', 'field-text', t('popup.cardEditTitle', null, LANG)), titleInput);

    const summaryField = el('label', 'card-edit-field');
    const summaryInput = el('textarea', 'control');
    summaryInput.rows = 3;
    summaryInput.maxLength = 2000;
    summaryInput.value = row.summary;
    summaryField.append(el('span', 'field-text', t('popup.cardEditSummary', null, LANG)), summaryInput);

    const save = button(t('popup.cardEditSave', null, LANG));
    const cancel = button(t('popup.cardEditCancel', null, LANG));
    const formActions = el('div', 'inbox-actions');
    formActions.append(save, cancel);
    form.append(titleField, summaryField, formActions);

    cancel.addEventListener('click', () => form.replaceWith(actions));
    save.addEventListener('click', () => {
      const patch = cardPatchFor(row, titleInput.value, summaryInput.value);
      if (patch === null) {
        // Nothing changed, so nothing is committed — and the form stays open in case the human is mid-edit.
        showPendingResult(t('popup.cardEditNoChange', null, LANG), 'info');
        return;
      }
      void decide(row, 'edit', patch, save);
    });
    // The form replaces the buttons, but no `focus()` call follows: an explicit click may reveal fields,
    // it may not move the caret out from under the reader (E1).
    actions.replaceWith(form);
  }

  /** What to say after a decision; the paths come from the worker, never from a guess. */
  function decisionLine(
    row: PendingCardRow,
    action: CardDecisionAction,
    result: CardDecisionResult,
  ): string {
    if (action === 'accept') return t('popup.cardAccepted', { path: result.path || row.path }, LANG);
    if (action === 'edit') return t('popup.cardEdited', { path: result.path || row.path }, LANG);
    return t('popup.cardDiscarded', { path: result.archivedPath || 'archive/cards' }, LANG);
  }

  async function decide(
    row: PendingCardRow,
    action: CardDecisionAction,
    patch?: CardPatch,
    trigger?: HTMLButtonElement,
  ): Promise<void> {
    if (deciding) return;
    deciding = true;
    if (trigger) trigger.disabled = true;
    const response = await send<unknown>({
      type: 'card.decide',
      payload: { id: row.id, path: row.path, action, ...(patch !== undefined ? { patch } : {}) },
    });
    deciding = false;
    if (trigger) trigger.disabled = false;
    if (!response.ok) {
      // The worker scrubs its errors already; `describeError` turns the code into a fixed sentence plus what
      // to do about it, so neither a path nor a message from the handler can reach the row (W6).
      const described = describeError(response.code, LANG);
      showPendingResult(
        described.hint === null ? described.message : `${described.message} — ${described.hint}`,
        'error',
      );
      return;
    }
    showPendingResult(decisionLine(row, action, decisionResult(response.data)), 'success');
    // Re-read rather than trusting the local row: the worker may have moved the card somewhere else.
    await refreshPending();
  }

  /* --------------------------------- actions ------------------------------- */

  async function refresh(): Promise<void> {
    setBusy(true);
    // A full re-read is the user asking "where does it stand now", so the previous outcome line goes with it.
    pendingMessage = null;
    paintPendingResult();
    const [statusResponse, inboxResponse, syncResponse, pendingResponse] = await Promise.all([
      send<unknown>({ type: 'status.get' }),
      send<unknown>({ type: 'inbox.list', payload: { limit: INBOX_LIMIT } }),
      send<unknown>({ type: 'sync.status' }),
      send<unknown>({ type: 'cards.list', payload: { limit: PENDING_LIMIT } }),
      // The review queue needs no network of its own and no unlock (the schedule is cleartext), so asking here
      // costs nothing and avoids a timer that would nag (E1).
      (async () => renderDue(await send<unknown>({ type: 'review.due' })))(),
    ]);
    renderStatus(statusResponse);
    renderInbox(inboxResponse);
    // A worker without the sync handler (or a locked vault) must not break the console.
    applySyncStatus(syncResponse);
    renderPending(pendingResponse);
    setBusy(false);
  }

  async function refreshInbox(): Promise<void> {
    renderInbox(await send<unknown>({ type: 'inbox.list', payload: { limit: INBOX_LIMIT } }));
  }

  function reportCapture(response: ExtensionResponse<CaptureResultData>): void {
    if (!response.ok) {
      showError(response.code);
      return;
    }
    // The worker is written in parallel: never assume a field exists.
    const raw: unknown = response.data;
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const duplicate = record['duplicate'] === true;
    toastWithCommit(
      duplicate ? t('popup.duplicate', null, LANG) : t('popup.saved', null, LANG),
      duplicate ? 'info' : 'success',
      record['commitUrl'],
    );
  }

  async function clipPage(): Promise<void> {
    if (busy || !canClip) return;
    setBusy(true);
    const response = await send<CaptureResultData>({ type: 'capture.page', payload: {} });
    reportCapture(response);
    await refreshInbox();
    setBusy(false);
  }

  async function clipSelection(): Promise<void> {
    if (busy || !canClip) return;
    setBusy(true);
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      const tabId = tab?.id;
      if (typeof tabId !== 'number') {
        toast.show(t('popup.selectionUnavailable', null, LANG), 'error');
        return;
      }

      const injected: unknown = await browser.scripting.executeScript({
        target: { tabId },
        func: readPageSelection,
      });
      const picked = firstInjectionResult(injected);
      const fields = typeof picked === 'object' && picked !== null ? (picked as Record<string, unknown>) : {};
      const pickedLang = fields['lang'];
      const payload: CaptureRequestPayload | null = selectionCapturePayload(
        tab?.url ?? '',
        tab?.title ?? '',
        fields['text'],
        typeof pickedLang === 'string' ? pickedLang : undefined,
      );
      if (!payload) {
        toast.show(t('popup.needSelection', null, LANG), 'info');
        return;
      }
      const response = await send<CaptureResultData>({ type: 'capture.request', payload });
      reportCapture(response);
      await refreshInbox();
    } catch {
      // No host access (chrome://, the web store, a PDF viewer…) — the in-page bubble still works.
      toast.show(t('popup.selectionUnavailable', null, LANG), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function distillRow(row: InboxRow, trigger: HTMLButtonElement): Promise<void> {
    const payload: DistillRequestPayload | null = distillPayloadFor(row.id, row.path);
    if (!payload) {
      showError('validation');
      return;
    }
    trigger.disabled = true;
    trigger.textContent = t('popup.working', null, LANG);
    const response = await send<DistillResultData>({ type: 'distill.request', payload });
    trigger.disabled = false;
    trigger.textContent = t('popup.distill', null, LANG);
    if (!response.ok) {
      showError(response.code);
      return;
    }
    toastWithCommit(t('popup.distillDone', null, LANG), 'success', response.data?.commitUrl);
  }

  async function syncNow(): Promise<void> {
    if (busy || !canSync) return;
    syncNowButton.disabled = true;
    syncNowButton.textContent = t('popup.working', null, LANG);
    const response = await send<unknown>({ type: 'sync.now', payload: { reason: 'manual' } });
    syncNowButton.textContent = t('popup.syncNow', null, LANG);
    if (!response.ok) {
      showError(response.code);
      await refresh();
      return;
    }
    const result = normalizeSyncResult(response.data);
    toast.show(t(`options.sync.outcome.${result.outcome}`, null, LANG), 'success');
    await refresh();
  }

  async function search(): Promise<void> {
    if (searchBusy) return;
    const text = searchInput.value.trim();
    if (text.length === 0) {
      renderSearch([], false);
      return;
    }
    searchBusy = true;
    setBusy(busy);
    const response = await send<unknown>({ type: 'search.query', payload: { text } });
    searchBusy = false;
    setBusy(busy);
    if (!response.ok) {
      renderSearch([], response.code === 'indexUnavailable');
      showError(response.code);
      return;
    }
    const prefs = lastPrefs;
    const view = searchResultRows(response.data, {
      repoFullName: prefs.repoFullName,
      branch: prefs.branch,
      limit: 5,
    });
    renderSearch(view.rows, view.needsRebuild);
  }

  async function toggleEnabled(): Promise<void> {
    const next = enabledInput.checked;
    enabledInput.disabled = true;
    const response = await send<unknown>({ type: 'settings.security', payload: { enabled: next } });
    if (!response.ok) {
      enabledInput.checked = !next;
      showError(response.code);
    }
    await refresh();
  }

  enabledInput.addEventListener('change', () => void toggleEnabled());
  refreshButton.addEventListener('click', () => void refresh());
  syncNowButton.addEventListener('click', () => void syncNow());
  searchButton.addEventListener('click', () => void search());
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void search();
  });
  clipPageButton.addEventListener('click', () => void clipPage());
  clipSelectionButton.addEventListener('click', () => void clipSelection());
  settingsButton.addEventListener('click', () => void browser.runtime.openOptionsPage());

  renderUnavailable();
  void refresh();
}

main();
