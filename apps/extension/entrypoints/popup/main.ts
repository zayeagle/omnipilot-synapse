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
import { focusOrRepairFloatingWindow, readFloatingWindowId, rememberFloatingWindowId } from '../../lib/ui/floating-window';
import {
  describeError,
  distillPayloadFor,
  inboxRows,
  isSafeExternalUrl,
  normalizeStatusPayload,
  normalizeSyncResult,
  normalizeSyncStatus,
  searchResultRows,
  noteCapturePayload,
  statusPanel,
  type InboxRow,
  type SearchResultRow,
} from '../../lib/ui/format';
import { noticeFor, type NoticeState } from '../../lib/ui/notice';
import { canReadRepository, errorGuidance } from '../../lib/status';
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
/*
 * How many Inbox rows are rendered. It was 3 back when the lists shared one scroll with the composer and
 * the status block, so a long list pushed everything else off screen. The lists have their own tab and
 * their own scrolling pane now, so the Inbox can afford a real page of recent notes instead of three -
 * three made the Inbox useless exactly when it mattered (once you have more than three notes).
 */
const INBOX_LIMIT = 20;

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


async function openExternal(href: string): Promise<void> {
  if (!isSafeExternalUrl(href)) return;
  await browser.tabs.create({ url: href });
}

/* ---------------------------------- the page ------------------------------- */

/**
 * Icons, drawn inline: no asset, no dependency, and the stroke follows the button colour. One shell, so
 * another icon costs three lines instead of a dozen attribute setters.
 */
function svgIcon(children: SVGElement[]): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.append(...children);
  return svg;
}

/** The gear: Settings. */
function gearIcon(): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const circle = document.createElementNS(NS, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '3');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z');
  return svgIcon([circle, path]);
}

/** The pop-out: the same console in a real, draggable window. */
function popoutIcon(): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const box = document.createElementNS(NS, 'path');
  box.setAttribute('d', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6');
  const corner = document.createElementNS(NS, 'polyline');
  corner.setAttribute('points', '15 3 21 3 21 9');
  const arrow = document.createElementNS(NS, 'line');
  arrow.setAttribute('x1', '10');
  arrow.setAttribute('y1', '14');
  arrow.setAttribute('x2', '21');
  arrow.setAttribute('y2', '3');
  return svgIcon([box, corner, arrow]);
}

function main(): void {
  document.title = t('app.name', null, LANG);
  const app = document.getElementById('app');
  if (!app) return;

  /* header */
  const header = el('header');
  const headerText = el('div', 'header-text');
  headerText.append(
    el('h1', undefined, t('app.name', null, LANG)),
    el('p', 'tagline', t('app.tagline', null, LANG)),
  );
  // Settings belongs in the corner people look for it, as an icon: it is a destination, not an action.
  const settingsButton = button('', 'icon');
  settingsButton.setAttribute('aria-label', t('popup.openOptions', null, LANG));
  settingsButton.title = t('popup.openOptions', null, LANG);
  settingsButton.appendChild(gearIcon());
  const WINDOW_MODE = new URLSearchParams(location.search).get('mode') === 'window';
  if (WINDOW_MODE) {
    document.body.dataset['mode'] = 'window';
    // The window's own title bar carries the product name; repeating it inside is noise, and the space it
    // takes belongs to the content.
    headerText.hidden = true;
  }

  // Both destinations sit in the corner people look for them, at the same weight: window, then settings.
  // The window action hides itself inside the window it would open.
  const detachButton = button('', 'icon');
  detachButton.setAttribute('aria-label', t('popup.detach', null, LANG));
  detachButton.title = t('popup.detach', null, LANG);
  detachButton.appendChild(popoutIcon());
  detachButton.addEventListener('click', () => void openFloatingWindow());
  detachButton.hidden = WINDOW_MODE;

  header.append(headerText, el('span', 'spacer'), detachButton, settingsButton);

  /* master switch */
  const switchLabel = el('label', 'switch');
  const enabledInput = el('input');
  enabledInput.type = 'checkbox';
  switchLabel.append(enabledInput, el('span', undefined, t('popup.masterSwitch', null, LANG)));
  const refreshButton = button(t('popup.refresh', null, LANG));
  const switchRow = el('div', 'row');
  switchRow.append(switchLabel, el('span', 'spacer'), refreshButton);
  if (WINDOW_MODE) {
    // No title bar duplication and no orphaned icon row: in a window the gear joins the switch row, where
    // the other one-off actions already are.
    header.hidden = true;
    switchRow.appendChild(settingsButton);
  }

  /*
   * One action lives here: 记笔记. Clipping is a page-level gesture (select text -> the bubble), so the
   * panel does not need two clip buttons that only work when a tab happens to allow injection.
   */
  /*
   * 写笔记 is the panel's opening surface, not something to unlock first: an input that is already there
   * needs no click, and a button whose only job was to reveal it was one control too many.
   */
  const notePanel = el('section', 'compose');
  const noteTitleInput = el('input', 'control');
  noteTitleInput.type = 'text';
  noteTitleInput.placeholder = t('popup.noteTitle', null, LANG);
  const noteTextArea = el('textarea', 'control');
  noteTextArea.rows = 6;
  noteTextArea.placeholder = t('popup.noteBody', null, LANG);
  const noteSaveButton = button(t('popup.noteSave', null, LANG), 'primary');
  noteSaveButton.title = t('popup.noteSaveHint', null, LANG);
  // The composer's action belongs at the end of the form, not floating under the first field.
  const noteButtons = el('div', 'row');
  noteButtons.append(el('span', 'spacer'), noteSaveButton);
  notePanel.append(
    el('h2', undefined, t('popup.writeNote', null, LANG)),
    noteTitleInput,
    noteTextArea,
    noteButtons,
  );
  // Visible from the start: the composer IS the panel's first line, not a state to enter.

  /* readiness notice */
  const notice = el('p', 'notice');
  notice.dataset['kind'] = 'blocked';
  /** Shown INSTEAD of the data sections while they cannot be read: one line, one action. */
  /*
   * A blocked surface owes the user a reason AND the action that clears it. The sentence alone was a dead
   * end: the state this popup hits most often - a locked vault - had no button anywhere on screen.
   */
  const blockedHint = el('div', 'blocked');
  blockedHint.hidden = true;
  const blockedText = el('p', 'hint', t('popup.blockedHint', null, LANG));
  const unlockButton = button(t('popup.goUnlock', null, LANG));
  unlockButton.hidden = true;
  unlockButton.addEventListener('click', () => {
    void browser.tabs.create({ url: browser.runtime.getURL('/options.html#security') });
  });
  blockedHint.append(blockedText, unlockButton);

  /* status rows */
  const statusList = el('dl', 'status');
  const statusValues = new Map<keyof StatusLine, HTMLElement>();
  for (const row of STATUS_ROWS) {
    const value = el('dd', undefined, '—');
    statusValues.set(row.key, value);
    statusList.append(el('dt', undefined, t(row.labelKey, null, LANG)), value);
  }
  // Reference material, not the answer to "can I clip?": the rows are one tap away, and the line that
  // matters (readiness + sync) stays visible.
  const statusDetails = el('details', 'more');
  statusDetails.append(el('summary', undefined, t('popup.details', null, LANG)), statusList);

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

  /* search: a pane of its own now, not a permanent block above the lists */
  const searchPane = el('section');
  searchPane.append(searchSection);

  /* inbox */
  const inboxSection = el('section');
  const inboxList = el('ul', 'inbox');
  inboxSection.append(el('h2', undefined, t('popup.inbox', null, LANG)), inboxList);

  /* sync: the outcome and the one button that acts on it, behind a tab */
  const syncPane = el('section');
  syncPane.append(syncRow);

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
    pendingResult,
    pendingHint,
  );
  // The review queue is its own pane: it used to share a scroll with the proposals and the Inbox.
  const dueSection = el('section');
  dueSection.append(dueTitle, dueList);

  /*
   * 收件箱 / 待处理 / 复习 as tabs. They are three different questions ("what did I save?", "what does the
   * AI propose?", "what is due?") that were stacked in one scroll and competed for attention.
   */
  const listTabBar = el('nav', 'tabs list-tabs');
  const listPanes: Array<{ id: string; button: HTMLButtonElement; nodes: HTMLElement[] }> = [];

  function selectListTab(id: string): void {
    for (const pane of listPanes) {
      const on = pane.id === id;
      pane.button.setAttribute('aria-selected', on ? 'true' : 'false');
      for (const node of pane.nodes) node.hidden = !on;
    }
  }

  function addListTab(id: string, labelKey: string, nodes: HTMLElement[]): void {
    const tab = button(t(labelKey, null, LANG));
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.addEventListener('click', () => selectListTab(id));
    listTabBar.appendChild(tab);
    listTabButtons.set(id, tab);
    listPanes.push({ id, button: tab, nodes });
  }

  const listTabButtons = new Map<string, HTMLButtonElement>();
  addListTab('inbox', 'popup.inbox', [inboxSection]);
  addListTab('pending', 'popup.pending', [pendingSection]);
  addListTab('review', 'popup.tab.review', [dueSection]);
  addListTab('search', 'popup.tab.search', [searchPane]);
  addListTab('sync', 'popup.tab.sync', [syncPane]);
  selectListTab('inbox');

  /** Disable a tab whose data cannot be read right now (the reason is in the notice above). */
  function setTabAvailable(id: string, available: boolean): void {
    const tab = listTabButtons.get(id);
    if (tab) tab.disabled = !available;
  }

  /** Everything the tabs switch between; hidden as a whole while nothing can be read. */
  const listPanesRoot = el('div', 'panes');
  listPanesRoot.append(inboxSection, pendingSection, dueSection, searchPane, syncPane);

  /*
   * 浮动窗口: a toolbar popup cannot be dragged — it is anchored to the toolbar button and closes the
   * moment focus leaves. A real window can be moved, and it stays until its own close button is used,
   * which is the behaviour asked for. The same page renders in both, so there is one console, not two.
   */
  async function openFloatingWindow(): Promise<void> {
    const url = browser.runtime.getURL('/popup.html?mode=window');
    const existing = await readFloatingWindowId();
    if (existing !== null) {
      try {
        // Reuse the window we opened before, repairing its page if the extension was reloaded under it.
        if (await focusOrRepairFloatingWindow(existing)) {
          window.close();
          return;
        }
      } catch {
        // Gone (closed by hand, or the id is stale): fall through and make a new one.
      }
    }
    const created = await browser.windows.create({ url, type: 'popup', width: 460, height: 720 });
    if (typeof created?.id === 'number') {
      await rememberFloatingWindowId(created.id);
    }
    // The toolbar popup has handed over; leaving it open would show two consoles at once.
    window.close();
  }



  /* toast */
  const toastRoot = toastArea();
  const toast = createToastController(toastRoot);

  app.append(
    header,
    switchRow,
    // Status before actions: the line answers can I capture, and it belongs where it is read first.
    notice,
    blockedHint,
    notePanel,
    statusDetails,
    listTabBar,
    listPanesRoot,
    toastRoot,
  );

  /* --------------------------------- state -------------------------------- */

  let canClip = false;
  /**
   * Whether the repository can be WRITTEN to, which is what a note needs. Deliberately not `canClip`: that
   * also carries the 启用捕获 master switch, and writing a note is not a capture - being unable to save one
   * because automatic capture is off was the button simply not working.
   */
  let canWrite = false;
  let canSync = false;
  let busy = false;
  let searchBusy = false;
  /** One card per request: a second decision waits for the first commit. */
  let deciding = false;
  /** Latest `sync.status` projection; the status reply carries counts but not the full list. */
  let syncView = normalizeSyncStatus(null);
  /** The public preferences from the last `status.get`, for the search result URLs. */
  let lastPrefs = normalizeStatusPayload(null).prefs;

  /** Opening the composer is the whole of the action row's state now: there is one action. */

  /**
   * The readiness line as `renderStatus` last left it. `setBusy` overlays the in-flight state on top
   * of this and hands it back untouched, so a blocked reason is never lost behind a spinner.
   */
  let readinessNotice: NoticeState = { text: '', kind: 'blocked' };

  /** Paint the status line from the readiness line plus the in-flight state. */
  function paintNotice(): void {
    const shown = noticeFor(readinessNotice, busy, t('popup.working', null, LANG));
    notice.textContent = shown.text;
    notice.dataset['kind'] = shown.kind;
  }

  function setBusy(next: boolean): void {
    busy = next;
    // The in-flight state belongs to the status line, never to a button caption: a button that renames
    // itself reads as a different button, and the line below it keeps its stale "Ready to clip".
    paintNotice();
    noteSaveButton.disabled = next || !canWrite;
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
    canWrite = false;
    enabledInput.disabled = true;
    for (const value of statusValues.values()) {
      value.textContent = '—';
      delete value.dataset['kind'];
    }
    // A status read that failed is a failure, not progress: this used to say "Working…" and the
    // popup then claimed to be busy for as long as it stayed unreadable.
    readinessNotice = { text: t('popup.statusUnavailable', null, LANG), kind: 'blocked' };
    paintNotice();
    canSync = false;
    syncOutcomeText.textContent = t('options.sync.outcome.never', null, LANG);
    syncOutcomeText.dataset['kind'] = 'unknown';
    syncCountsText.textContent = '';
    // Nothing can be read while the status call itself fails, so the sections go with it.
    for (const id of ['inbox', 'pending', 'review', 'search']) setTabAvailable(id, false);
    listPanesRoot.hidden = true;
    blockedHint.hidden = false;
    unlockButton.hidden = true;
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
    // A blocked surface must not stack dead ends: the Inbox, the proposals and the review queue all read
    // the repository, so they follow the state they depend on instead of each reporting its own failure.
    const readable = canReadRepository(status.prefs);
    /*
     * With capture ON, `canClip` is already the right gate (readiness, the public-repo acknowledgement and the
     * switch itself - which is on). With capture OFF, only readiness matters: writing a note is not a capture,
     * and being unable to save one because automatic capture is off was the button simply not working. The one
     * residual case (capture off AND an unacknowledged public repo) is answered by the worker with a readable
     * refusal, which the status line already knows how to render.
     */
    canWrite = status.prefs.enabled === false ? readable : canClip;
    // The tabs stay visible so it is clear what is there, but nothing is switchable until it can be read,
    // and the pane area goes away entirely - one line explains why, instead of four empty panes.
    for (const id of ['inbox', 'pending', 'review', 'search']) setTabAvailable(id, readable);
    listPanesRoot.hidden = !readable;
    blockedHint.hidden = readable;
    // Only a locked vault gets the button: it is the one blocked state the user can clear unaided.
    unlockButton.hidden = readable || !status.prefs.vaultLocked;
    renderSyncPanel();
    readinessNotice = {
      text: panel.canClip
        ? panel.notice
        : // `readinessLabel` and the notice are often the same sentence; only show it when it adds.
          panel.readinessLabel === panel.notice
          ? panel.notice
          : `${panel.readinessLabel} — ${panel.notice}`,
      kind: panel.canClip ? 'ok' : 'blocked',
    };
    paintNotice();
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

  function renderSearch(rows: SearchResultRow[], needsRebuild: boolean, indexMissing = false): void {
    clear(searchList);
    searchMessage.hidden = rows.length > 0;
    searchMessage.dataset['kind'] = needsRebuild ? 'error' : 'info';
    if (needsRebuild && rows.length === 0) {
      searchMessage.textContent = t('popup.searchNeedsRebuild', null, LANG);
    } else if (indexMissing && rows.length === 0) {
      // True and actionable: nothing has been indexed yet, and the rebuild is one click away in settings.
      searchMessage.textContent = t('search.indexMissing', null, LANG);
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
      // Not empty: an Inbox that could not be read is a different fact, and saying empty would send the
      // user looking for a capture that may well be there.
      inboxList.appendChild(el('li', 'empty', t('popup.inboxUnavailable', null, LANG)));
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
    // A note has no page to open, so the button is not offered at all - a dead button invites a click
    // and then explains nothing. A note written next to a page keeps that page's URL and the button.
    const open = button(t('popup.openItem', null, LANG), 'link');
    open.hidden = !isSafeExternalUrl(row.url);
    open.addEventListener('click', () => void openExternal(row.url));

    // 删除 is what the user asks for; what it does is archive (the repository cannot delete, by design),
    // and the toast says so rather than leaving them to wonder whether the note is gone for good.
    const archive = button(t('popup.archiveNote', null, LANG), 'link');
    archive.addEventListener('click', () => void archiveRow(row, archive));
    /*
     * Deleting is irreversible, so the button arms before it acts: the first click asks, the second one
     * within a few seconds does it. A modal would be worse in a 400px popup, and a single click on a
     * permanent action is exactly the accident this avoids.
     */
    const remove = button(t('popup.deleteNote', null, LANG), 'link');
    let armed = false;
    let disarm: ReturnType<typeof setTimeout> | null = null;
    remove.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        remove.textContent = t('popup.deleteConfirm', null, LANG);
        disarm = setTimeout(() => {
          armed = false;
          remove.textContent = t('popup.deleteNote', null, LANG);
        }, 5_000);
        return;
      }
      if (disarm !== null) clearTimeout(disarm);
      void deleteRow(row, remove);
    });

    const rowActions = el('div', 'inbox-actions');
    rowActions.append(distill, open, archive, remove);
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


  /**
   * Manual entry: compose a note and send it down the SAME capture path as a clip, so the commit, the
   * index, the search shards and the vault policy all behave identically.
   */
  async function saveNote(): Promise<void> {
    if (busy || !canWrite) return;
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const payload = noteCapturePayload(noteTitleInput.value, noteTextArea.value, tabs[0]?.url);
    if (!payload) {
      // An empty note never becomes a round trip, and never a failed capture the user has to read.
      toast.show(t('popup.noteEmpty', null, LANG), 'info');
      return;
    }
    setBusy(true);
    try {
      const response = await send<CaptureResultData>({ type: 'capture.request', payload });
      reportCapture(response);
      // Cleared only after the worker answered: a transient failure queues the note, and wiping the text
      // would suggest it was lost.
      noteTitleInput.value = '';
      noteTextArea.value = '';
      await refreshInbox();
    } finally {
      setBusy(false);
    }
  }

  // Writing does not want a mouse: Ctrl/Cmd+Enter saves, which is what the tooltip on the button says.
  noteTextArea.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void saveNote();
    }
  });
  noteSaveButton.addEventListener('click', () => void saveNote());

  /** Archive (never delete) a note: it leaves the Inbox, and the body stays recoverable under archive/. */
  async function archiveRow(row: InboxRow, trigger: HTMLButtonElement): Promise<void> {
    if (busy) return;
    trigger.disabled = true;
    setBusy(true);
    try {
      const response = await send<unknown>({ type: 'source.archive', payload: { id: row.id, path: row.path } });
      if (!response.ok) {
        showError(response.code);
        return;
      }
      toast.show(t('popup.noteArchived', null, LANG), 'success');
      await refreshInbox();
    } finally {
      trigger.disabled = false;
      setBusy(false);
    }
  }

  /** Delete a note for good: gone from the repository, not archived. The popup asks first. */
  async function deleteRow(row: InboxRow, trigger: HTMLButtonElement): Promise<void> {
    if (busy) return;
    trigger.disabled = true;
    setBusy(true);
    try {
      const response = await send<unknown>({ type: 'source.delete', payload: { id: row.id, path: row.path } });
      if (!response.ok) {
        showError(response.code);
        return;
      }
      toast.show(t('popup.noteDeleted', null, LANG), 'success');
      await refreshInbox();
    } finally {
      trigger.disabled = false;
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
    setBusy(true);
    try {
      const response = await send<DistillResultData>({ type: 'distill.request', payload });
      if (!response.ok) {
        showError(response.code);
        return;
      }
      toastWithCommit(t('popup.distillDone', null, LANG), 'success', response.data?.commitUrl);
    } finally {
      trigger.disabled = false;
      setBusy(false);
    }
  }

  async function syncNow(): Promise<void> {
    if (busy || !canSync) return;
    setBusy(true);
    try {
      const response = await send<unknown>({ type: 'sync.now', payload: { reason: 'manual' } });
      if (!response.ok) {
        showError(response.code);
        await refresh();
        return;
      }
      const result = normalizeSyncResult(response.data);
      toast.show(t(`options.sync.outcome.${result.outcome}`, null, LANG), 'success');
      await refresh();
    } finally {
      setBusy(false);
    }
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
    renderSearch(view.rows, view.needsRebuild, view.indexMissing);
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

  settingsButton.addEventListener('click', () => void browser.runtime.openOptionsPage());

  renderUnavailable();
  void refresh();
}

main();
