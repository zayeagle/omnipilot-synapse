/**
 * Options page — the five consent surfaces: 模型 · 存储 · 安全 · AI 授权 · 数据.
 *
 * Same contract as the popup: this file only builds nodes and sends one message per user action, and
 * every decision (what is valid, what is blocked, what a row may show) lives in `lib/ui/format.ts`.
 *
 * The two rules the security model depends on, expressed as code:
 * - a credential field is `<input type="password">`, is NEVER prefilled from storage, and is emptied
 *   as soon as it has been handed to the worker — the placeholder says "leave empty to keep";
 * - the page never imports the settings store, the vault or the crypto layer; it is a pure message
 *   client, so a secret only ever exists inside the worker.
 */

import { browser } from 'wxt/browser';

import { detectLang, t, type Lang } from '../../lib/i18n';
import {
  isExtensionResponse,
  type ExtensionRequest,
  type ExtensionResponse,
  type GithubSettingsPayload,
  type ProviderSettingsPayload,
  type SecurityMode,
  type SyncPolicyPayload,
} from '../../lib/messages';
import type { CompanionState } from '../../lib/public-prefs';
import {
  authFormOf,
  authModeDisabled,
  authModeOptions,
  cloneGuidance,
  companionStatusText,
  hasSshFormErrors,
  sshFormOf,
  sshSaveDisabled,
  validateBranch,
  validateSshForm,
  type AuthForm,
  type AuthModeAvailability,
} from '../../lib/ui/auth-form';
import { parseInnerPath, parseRepoAddress, repoAddressOf } from '../../lib/ui/repo-address';
import { requiresTrustAck } from '../../lib/providers';
import { isPublicRepoWarning, visibilityLabel } from '../../lib/status';
import type { StoreProbe } from '../../lib/store/types';
import {
  button,
  card,
  checkboxField,
  clear,
  createToastController,
  datalist,
  el,
  selectField,
  textField,
  toastArea,
  type Card,
} from '../../lib/ui/dom';
import {
  DEFAULT_AUTO_LOCK_MINUTES,
  MAX_AUTO_LOCK_MINUTES,
  MIN_AUTO_LOCK_MINUTES,
  branchCheck,
  branchCheckNotice,
  clampAutoLockMinutes,
  conflictChoiceLabel,
  conflictRows,
  type ConflictRow,
  defaultSettingsForm,
  describeError,
  emptyVaultInfo,
  exportJson,
  formToGithubPayload,
  formToProviderPayload,
  formToSecurityPayload,
  githubFormOf,
  hostPermissionPattern,
  isSafeExternalUrl,
  ledgerRows,
  modelSuggestions,
  normalizeStatusPayload,
  normalizeStoreProbe,
  normalizeSyncResult,
  normalizeSyncStatus,
  passphraseTooShort,
  providerDefaultBaseUrl,
  providerFormOf,
  providerOptions,
  needsTierChoice,
  saveStorageDisabled,
  storageSaveBlocked,
  tierChoiceOptions,
  searchResultRows,
  secretsPresence,
  settingsToForm,
  syncPolicyPayload,
  transparentModeNeedsConfirm,
  validateProviderForm,
  type BranchNotice,
  type LedgerRow,
  type SearchResultRow,
  type SettingsForm,
  type SyncStatusView,
  type VaultInfo,
} from '../../lib/ui/format';

const LANG: Lang = detectLang(typeof navigator === 'undefined' ? null : navigator.language);
const LEDGER_LIMIT = 20;
const MODEL_LIST_ID = 'omnipilot-model-suggestions';

type TabId = 'providers' | 'store' | 'sync' | 'security' | 'ai' | 'data';

/** One round trip with a hard guard on the reply — the worker may not have a handler yet. */
async function send<T = unknown>(request: ExtensionRequest): Promise<ExtensionResponse<T>> {
  try {
    const raw: unknown = await browser.runtime.sendMessage(request);
    if (!isExtensionResponse(raw)) return { ok: false, error: 'unexpected reply', code: 'unknown' };
    return raw as ExtensionResponse<T>;
  } catch {
    return { ok: false, error: 'message failed', code: 'unknown' };
  }
}

function main(): void {
  document.title = t('options.title', null, LANG);
  const app = document.getElementById('app');
  if (!app) return;

  /* ------------------------------- page state ------------------------------ */

  const form: SettingsForm = defaultSettingsForm();
  let probe: StoreProbe | null = null;
  let vault: VaultInfo = emptyVaultInfo();
  let hasPat = false;
  let hasKey = false;
  let companion: CompanionState = 'missing';
  let branchNoticeView: BranchNotice | null = null;
  let syncStatus: SyncStatusView = normalizeSyncStatus(null);
  let searchQuery = '';
  let searchBusy = false;

  const toastRoot = toastArea();
  const toast = createToastController(toastRoot);

  function toastError(message: string): void {
    toast.show(message, 'error');
  }

  /** Never render a handler/server sentence: classify the code and show the fixed translation. */
  function showErrorCode(code: unknown): void {
    const described = describeError(code, LANG);
    toastError(
      described.hint === null ? described.message : `${described.message} — ${described.hint}`,
    );
  }

  function toastSaved(): void {
    toast.show(t('options.saved', null, LANG), 'success');
  }

  /* --------------------------------- chrome -------------------------------- */

  const header = el('header');
  header.append(
    el('h1', undefined, t('options.title', null, LANG)),
    el('p', 'tagline', t('app.tagline', null, LANG)),
  );

  const nav = el('nav', 'tabs');
  const content = el('div', 'content');

  const sections: Array<{ id: TabId; button: HTMLButtonElement; card: Card }> = [];
  function addTab(id: TabId, titleKey: string): Card {
    const tabButton = button(t(titleKey, null, LANG));
    tabButton.setAttribute('role', 'tab');
    tabButton.setAttribute('aria-selected', 'false');
    const section = card(titleKey, LANG);
    section.root.hidden = true;
    tabButton.addEventListener('click', () => activate(id));
    nav.appendChild(tabButton);
    content.appendChild(section.root);
    sections.push({ id, button: tabButton, card: section });
    return section;
  }

  function activate(id: TabId): void {
    for (const entry of sections) {
      const on = entry.id === id;
      entry.card.root.hidden = !on;
      entry.button.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    // 同步 is the one surface that shows state the worker changes on its own — a background sync can
    // record a conflict while this page sits open — so opening it re-reads instead of re-rendering
    // whatever happened to be true at load. Without this the decision surface can show "0 conflicts"
    // while the worker is holding one, which is the same class of lie as the old "never synced" row.
    if (id === 'sync') void reloadSyncStatus();
  }

  /* ------------------------------- 模型 section ----------------------------- */

  const providerCard = addTab('providers', 'options.tab.providers');
  const providerSelect = selectField('options.provider', providerOptions(), undefined, LANG);
  const modelList = datalist(MODEL_LIST_ID, []);
  const modelInput = textField('options.model', { listId: MODEL_LIST_ID, maxLength: 120, lang: LANG });
  const apiKeyInput = textField('options.apiKey', {
    type: 'password',
    // The stored key is never re-rendered: this placeholder is the whole "keep it" affordance.
    placeholder: t('options.apiKeyKeep', null, LANG),
    maxLength: 4_096,
    lang: LANG,
  });
  const apiKeyStored = el('p', 'hint', t('options.apiKeyStored', null, LANG));
  const baseUrlInput = textField('options.baseUrl', { maxLength: 2_048, lang: LANG });
  const trustCheckbox = checkboxField('options.trust', false, LANG);
  const trustHint = el('p', 'hint', t('options.trustHint', null, LANG));
  const trustBlock = el('div', 'card-body');
  trustBlock.append(trustCheckbox.root, trustHint);
  const permissionHint = el('p', 'hint', t('options.permissionHint', null, LANG));
  const providerMessage = el('p', 'hint');
  providerMessage.dataset['kind'] = 'error';
  const saveProviderButton = button(t('options.save', null, LANG), 'primary');
  providerCard.body.append(
    providerSelect.root,
    modelInput.root,
    modelList,
    apiKeyInput.root,
    apiKeyStored,
    baseUrlInput.root,
    trustBlock,
    permissionHint,
    providerMessage,
  );
  providerCard.footer.append(saveProviderButton);

  /* ------------------------------- 存储 section ----------------------------- */

  const storeCard = addTab('store', 'options.tab.store');
  const patInput = textField('options.store.pat', {
    type: 'password',
    placeholder: t('options.apiKeyKeep', null, LANG),
    maxLength: 4_096,
    lang: LANG,
  });
  const patStored = el('p', 'hint', t('options.apiKeyStored', null, LANG));
  /*
   * Two things a person actually knows — the repository's address, and the folder inside it — plus the
   * token. Owner, repository and branch are derived from the address; the form used to ask for GitHub's
   * own vocabulary, in five unlabelled boxes.
   */
  const repoAddressControl = fieldWithError('options.store.repoAddress', { maxLength: 300 });
  const repoAddressHint = el('p', 'hint', t('options.store.repoAddress.hint', null, LANG));
  const repoAddressField = el('div');
  repoAddressField.append(repoAddressControl.root, repoAddressHint);
  const innerPathControl = fieldWithError('options.store.innerPath', { maxLength: 500 });
  const innerPathHint = el('p', 'hint', t('options.store.innerPath.hint', null, LANG));
  const innerPathField = el('div');
  innerPathField.append(innerPathControl.root, innerPathHint);

  // Everything GitHub-shaped that the defaults already answer. Collapsed rather than removed: the branch
  // stays selectable and the API base stays available for a self-hosted instance.
  const branchInput = textField('options.store.branch', { maxLength: 200, lang: LANG });
  const apiBaseInput = textField('options.store.apiBase', {
    maxLength: 2_048,
    placeholder: 'https://api.github.com',
    lang: LANG,
  });

  /* Authorization mode: the picker, the SSH block and the companion hint (F5). */
  const authModeSelect = selectField('options.auth.mode', [], undefined, LANG);
  const authModeHint = el('p', 'hint', t('options.auth.mode.hint', null, LANG));
  const companionStatus = el('p', 'badge');
  const companionInstallHint = el('p', 'hint', t('options.auth.companion.installHint', null, LANG));
  const localCloneNotice = el('p', 'warning', t('options.auth.ssh.localCloneNotice', null, LANG));
  const sshKeyHint = el('p', 'hint', t('options.auth.ssh.keyHint', null, LANG));
  const sshRepoRootHint = el('p', 'hint', t('options.auth.ssh.repoRootHint', null, LANG));
  /* The prerequisite, made copy-pasteable: the exact command for THIS remote (T5.2). */
  const cloneTitle = el('h4', 'card-title', t('options.auth.ssh.clone.title', null, LANG));
  const cloneHint = el('p', 'hint', t('options.auth.ssh.clone.hint', null, LANG));
  const cloneCommandNode = el('code', 'command');
  const cloneCopyButton = button(t('options.auth.ssh.clone.copy', null, LANG), 'link');
  const cloneRow = el('div', 'row');
  cloneRow.append(cloneCommandNode, cloneCopyButton);
  const cloneBlock = el('div', 'card-body');
  cloneBlock.append(cloneTitle, cloneHint, cloneRow);
  const sshTestButton = button(t('options.auth.ssh.testConnection', null, LANG));
  const sshGrid = el('div', 'grid');
  /** One SSH input plus the inline field message the validator fills in. */
  function fieldWithError(labelKey: string, options: { maxLength: number }): { root: HTMLElement; input: HTMLInputElement; error: HTMLElement } {
    const field = textField(labelKey, { maxLength: options.maxLength, lang: LANG });
    const error = el('p', 'hint');
    error.dataset['kind'] = 'error';
    error.hidden = true;
    field.root.append(error);
    return { root: field.root, input: field.input, error };
  }
  const sshHostControl = fieldWithError('options.auth.ssh.host', { maxLength: 200 });
  const sshUserControl = fieldWithError('options.auth.ssh.user', { maxLength: 100 });
  const sshKeyControl = fieldWithError('options.auth.ssh.keyRef', { maxLength: 120 });
  const sshRepoRootControl = fieldWithError('options.auth.ssh.repoRoot', { maxLength: 500 });
  sshGrid.append(sshHostControl.root, sshUserControl.root, sshKeyControl.root, sshRepoRootControl.root);
  /**
   * Host, user and key reference are almost never changed, so they stay out of the way — but a stored
   * non-default value keeps them visible (see `renderStore`), which is what stops an existing
   * configuration from being stranded behind a hidden control.
   */
  const sshDefaultsHint = el('p', 'hint', t('options.auth.ssh.defaults', null, LANG));
  const sshBlock = el('div', 'card-body');
  sshBlock.append(
    el('h3', 'card-title', t('options.auth.ssh.title', null, LANG)),
    localCloneNotice,
    cloneBlock,
    sshGrid,
    sshDefaultsHint,
    sshKeyHint,
    sshRepoRootHint,
    sshTestButton,
  );
  const authModeField = el('div');
  authModeField.append(authModeSelect.root, authModeHint, companionStatus, companionInstallHint);

  const branchCheckButton = button(t('options.branch.check', null, LANG));
  const branchNoticeNode = el('p', 'hint');
  const createBranchButton = button(t('options.branch.create', null, LANG));
  const branchRow = el('div', 'row');
  branchRow.append(branchCheckButton, createBranchButton);
  branchNoticeNode.hidden = true;
  createBranchButton.hidden = true;

  const advancedBody = el('div', 'card-body');
  advancedBody.append(
    el('p', 'hint', t('options.store.advanced.hint', null, LANG)),
    branchInput.root,
    branchRow,
    branchNoticeNode,
    apiBaseInput.root,
    authModeField,
    sshBlock,
  );
  const advanced = el('details', 'advanced');
  advanced.append(el('summary', undefined, t('options.store.advanced', null, LANG)), advancedBody);

  /*
   * First run: the content tier is a decision, not a default (T7). The question is asked once, here,
   * because this card is what creates the repository; the 安全 page keeps the live control afterwards.
   */
  let tierPicked = false;
  const tierTitle = el('h3', 'card-title', t('options.store.tier.title', null, LANG));
  const tierHint = el('p', 'hint', t('options.store.tier.hint', null, LANG));
  const tierChoices = el('div', 'grid');
  for (const option of tierChoiceOptions(LANG)) {
    const label = el('label', 'row');
    const input = el('input');
    input.type = 'radio';
    input.name = 'omnipilot-content-tier';
    input.value = option.value;
    const text = el('span');
    text.append(el('strong', undefined, option.label), el('span', 'hint', option.consequence));
    label.append(input, text);
    input.addEventListener('change', () => {
      // One value, one live control: this step answers the question the 安全 page owns.
      modeSelect.select.value = option.value;
      tierPicked = true;
      renderStore();
    });
    tierChoices.appendChild(label);
  }
  const tierSummary = el('p', 'hint');
  const tierBlock = el('div', 'card-body');
  tierBlock.append(tierTitle, tierHint, tierChoices);
  tierSummary.hidden = true;

  const visibilityBadge = el('p', 'badge');
  const probeButton = button(t('options.testConnection', null, LANG));
  const probeHint = el('p', 'hint', t('options.store.probeHint', null, LANG));
  const publicWarning = el('p', 'warning', t('options.store.publicWarning', null, LANG));
  const ackCheckbox = checkboxField('options.store.acknowledge', false, LANG);
  const ackBlock = el('div');
  ackBlock.append(ackCheckbox.root);
  const scopeHint = el('p', 'hint', t('options.store.scopeHint', null, LANG));
  const storeMessage = el('p', 'hint');
  storeMessage.dataset['kind'] = 'error';
  const saveStoreButton = button(t('options.save', null, LANG), 'primary');
  storeCard.body.append(
    tierBlock,
    tierSummary,
    patInput.root,
    patStored,
    scopeHint,
    repoAddressField,
    innerPathField,
    advanced,
    visibilityBadge,
    probeButton,
    probeHint,
    publicWarning,
    ackBlock,
    storeMessage,
  );
  storeCard.footer.append(saveStoreButton);

  /* ---------------------------- 同步与检索 section --------------------------- */

  const syncCard = addTab('sync', 'options.tab.sync');
  const syncOutcomeBadge = el('p', 'badge');
  const syncDetail = el('p', 'hint');
  const syncStatusGrid = el('div', 'grid');
  syncStatusGrid.append(syncOutcomeBadge, syncDetail);
  // Not `primary`: the card's one primary action is its save (the sync policy).
  const syncNowButton = button(t('options.sync.now', null, LANG));
  const syncMessage = el('p', 'hint');
  syncMessage.dataset['kind'] = 'error';
  const conflictTitle = el('h3', 'card-title', t('options.sync.conflicts.title', null, LANG));
  const conflictEmpty = el('p', 'hint', t('options.sync.conflicts.empty', null, LANG));
  const conflictList = el('div', 'card-body');
  const conflictHint = el('p', 'hint', t('options.sync.conflict.actionPending', null, LANG));
  const conflictsBlock = el('div', 'card-body');
  conflictsBlock.append(conflictTitle, conflictEmpty, conflictList, conflictHint);

  const syncPolicyTitle = el('h3', 'card-title', t('options.sync.policy.title', null, LANG));
  const syncIntervalInput = textField('options.sync.policy.interval', {
    type: 'number',
    value: '30',
    lang: LANG,
  });
  syncIntervalInput.input.min = '0';
  syncIntervalInput.input.max = '1440';
  const syncOnStartup = checkboxField('options.sync.policy.onStartup', true, LANG);
  const syncOnCapture = checkboxField('options.sync.policy.onCapture', true, LANG);
  const syncPullOnly = checkboxField('options.sync.policy.pullOnly', false, LANG);
  const syncPolicyMessage = el('p', 'hint');
  syncPolicyMessage.dataset['kind'] = 'error';
  const saveSyncPolicyButton = button(t('options.sync.policy.save', null, LANG), 'primary');
  const syncPolicyBlock = el('div', 'card-body');
  syncPolicyBlock.append(
    syncPolicyTitle,
    syncIntervalInput.root,
    syncOnStartup.root,
    syncOnCapture.root,
    syncPullOnly.root,
    syncPolicyMessage,
  );

  const searchInput = textField('options.search.title', {
    placeholder: t('options.search.placeholder', null, LANG),
    maxLength: 200,
    lang: LANG,
  });
  const searchButton = button(t('options.search.button', null, LANG));
  const searchRow = el('div', 'row');
  searchRow.append(searchInput.root, searchButton);
  const rebuildButton = button(t('options.search.rebuild', null, LANG));
  const searchMessage = el('p', 'hint');
  const searchList = el('ul', 'inbox');
  const searchBlock = el('div', 'card-body');
  searchBlock.append(searchRow, rebuildButton, searchMessage, searchList);

  // The four policy controls are refinements, not decisions: collapsed, the tab is status + conflicts +
  // search, which is what the tab is for. The save button stays in the footer and works while collapsed.
  const syncAdvanced = el('details', 'advanced');
  syncAdvanced.append(
    el('summary', undefined, t('options.store.advanced', null, LANG)),
    syncPolicyBlock,
  );
  syncCard.body.append(syncStatusGrid, syncNowButton, syncMessage, conflictsBlock, syncAdvanced, searchBlock);
  syncCard.footer.append(saveSyncPolicyButton);

  /* ------------------------------- 安全 section ----------------------------- */

  const securityCard = addTab('security', 'options.tab.security');
  const modeSelect = selectField(
    'options.security.mode',
    [
      { value: 'vault', label: t('options.security.mode.vault', null, LANG) },
      { value: 'transparent', label: t('options.security.mode.transparent', null, LANG) },
    ],
    'vault',
    LANG,
  );
  const transparentHint = el('p', 'hint', t('options.security.transparentHint', null, LANG));
  const transparentConfirm = checkboxField('options.security.transparentConfirm', false, LANG);
  const transparentBlock = el('div', 'card-body');
  transparentBlock.append(transparentHint, transparentConfirm.root);
  const autoLockInput = textField('options.security.autoLock', {
    type: 'number',
    value: String(DEFAULT_AUTO_LOCK_MINUTES),
    lang: LANG,
  });
  autoLockInput.input.min = String(MIN_AUTO_LOCK_MINUTES);
  autoLockInput.input.max = String(MAX_AUTO_LOCK_MINUTES);
  const vaultHint = el('p', 'hint', t('options.security.vaultHint', null, LANG));
  const vaultStatus = el('p', 'badge');
  const passphraseInput = textField('options.security.passphrase', {
    type: 'password',
    maxLength: 256,
    lang: LANG,
  });
  const setupVaultButton = button(t('options.security.setPassphrase', null, LANG));
  const unlockVaultButton = button(t('options.security.unlock', null, LANG));
  const lockVaultButton = button(t('options.security.lock', null, LANG));
  const vaultRow = el('div', 'row');
  vaultRow.append(setupVaultButton, unlockVaultButton, lockVaultButton);
  const securityMessage = el('p', 'hint');
  securityMessage.dataset['kind'] = 'error';
  const saveSecurityButton = button(t('options.save', null, LANG), 'primary');
  securityCard.body.append(
    modeSelect.root,
    transparentBlock,
    autoLockInput.root,
    vaultHint,
    vaultStatus,
    passphraseInput.root,
    vaultRow,
    securityMessage,
  );
  securityCard.footer.append(saveSecurityButton);

  /* ----------------------------- AI 授权 section ---------------------------- */

  const aiCard = addTab('ai', 'options.tab.ai');
  const aiAuthorize = checkboxField('options.ai.authorize', false, LANG);
  const aiAuthorizeHint = el('p', 'hint', t('options.ai.authorizeHint', null, LANG));
  const aiScopeHint = el('p', 'hint', t('options.ai.scopeHint', null, LANG));
  const ledgerHint = el('p', 'hint', t('options.ai.ledgerHint', null, LANG));
  const ledgerHead = el('thead');
  const ledgerHeadRow = el('tr');
  for (const key of ['options.ai.col.provider', 'options.ai.col.model', 'options.ai.col.at', 'options.ai.col.ok']) {
    ledgerHeadRow.appendChild(el('th', undefined, t(key, null, LANG)));
  }
  ledgerHead.appendChild(ledgerHeadRow);
  const ledgerBody = el('tbody');
  const ledgerTable = el('table', 'ledger');
  ledgerTable.append(ledgerHead, ledgerBody);
  const ledgerEmpty = el('p', 'hint', t('options.ai.ledgerEmpty', null, LANG));
  const clearLedgerButton = button(t('options.ai.clearLedger', null, LANG), 'danger');
  aiCard.body.append(aiAuthorize.root, aiAuthorizeHint, aiScopeHint, ledgerHint, ledgerEmpty, ledgerTable);
  aiCard.footer.append(clearLedgerButton);

  /* ------------------------------- 数据 section ----------------------------- */

  const dataCard = addTab('data', 'options.tab.data');
  const exportButton = button(t('options.data.export', null, LANG));
  const exportHint = el('p', 'hint', t('options.data.exportHint', null, LANG));
  const exportPre = el('pre', 'export');
  const copyButton = button(t('options.data.copy', null, LANG));
  const resetButton = button(t('options.data.reset', null, LANG), 'danger');
  const resetBox = el('div', 'warning');
  const resetQuestion = el('p', undefined, t('options.data.resetConfirm', null, LANG));
  const resetConfirmButton = button(t('options.data.resetConfirmYes', null, LANG), 'danger');
  const resetCancelButton = button(t('options.cancel', null, LANG));
  const resetRow = el('div', 'row');
  resetRow.append(resetConfirmButton, resetCancelButton);
  resetBox.append(resetQuestion, resetRow);
  dataCard.body.append(exportButton, exportHint, exportPre, copyButton, resetButton, resetBox);

  app.append(header, nav, content, toastRoot);

  /* --------------------------------- helpers ------------------------------- */

  function syncForm(): void {
    form.providerId = providerSelect.select.value;
    form.model = modelInput.input.value.trim();
    form.baseUrl = baseUrlInput.input.value.trim();
    // The address is the source of truth for owner/repository — and for the branch when it names one.
    // An address that cannot be parsed leaves the stored values untouched, so a half-typed field can
    // never silently point the next probe at the previous repository.
    const address = parseRepoAddress(repoAddressControl.input.value);
    if (address.ok) {
      form.owner = address.value.owner;
      form.repo = address.value.repo;
      // Written back into the (advanced) field so the override is visible rather than implied.
      if (address.value.branch !== undefined) branchInput.input.value = address.value.branch;
    }
    form.branch = branchInput.input.value.trim() || 'main';
    const inner = parseInnerPath(innerPathControl.input.value);
    form.pathPrefix = inner.ok ? inner.value : innerPathControl.input.value.trim();
    form.apiBase = apiBaseInput.input.value.trim();
    form.publicRepoAcknowledged = ackCheckbox.input.checked;
    form.securityMode = modeSelect.select.value === 'transparent' ? 'transparent' : 'vault';
    form.autoLockMinutes = clampAutoLockMinutes(autoLockInput.input.value);
    form.aiAuthorized = aiAuthorize.input.checked;
    // The picker is rebuilt on every render, so an OLDER entity is left untouched rather than
    // cleared: a blank input means "not edited here", never "erase this".
    form.authMode = authModeSelect.select.value === 'ssh' ? 'ssh' : 'token';
    form.ssh = {
      host: sshHostControl.input.value || form.ssh.host,
      user: sshUserControl.input.value || form.ssh.user,
      keyRef: sshKeyControl.input.value || form.ssh.keyRef,
      repoRoot: sshRepoRootControl.input.value,
    };
  }

  /** Both storage fields parse — the gate the probe and the save share. */
  function fieldsReadable(): boolean {
    return (
      parseRepoAddress(repoAddressControl.input.value).ok &&
      parseInnerPath(innerPathControl.input.value).ok
    );
  }

  /** The form's SSH block, as the validators take it. */
  function currentSshForm(): ReturnType<typeof sshFormOf> {
    syncForm();
    return sshFormOf({
      mode: form.authMode,
      branch: form.branch,
      ssh: form.ssh,
      syncPolicy: {},
    } as AuthForm);
  }

  function availability(): AuthModeAvailability {
    return { companion, hasPat };
  }

  /** Rebuild the mode picker from the availability we know, preserving the selected value. */
  function renderAuthModes(): void {
    // On the first render the picker is empty, so the stored mode is what it must show; afterwards
    // the live selection wins, because that is what the user is looking at.
    const selected = authModeSelect.select.value || form.authMode;
    clear(authModeSelect.select);
    for (const option of authModeOptions(availability(), LANG)) {
      const node = el('option', undefined, option.label);
      node.value = option.value;
      node.disabled = !option.enabled;
      if (!option.enabled && option.reasonKey.length > 0) node.title = t(option.reasonKey, null, LANG);
      authModeSelect.select.appendChild(node);
    }
    authModeSelect.select.value = selected;
    if (authModeSelect.select.value !== selected) authModeSelect.select.value = 'token';
  }

  function currentGithubPayload(): GithubSettingsPayload {
    syncForm();
    return formToGithubPayload(githubFormOf(form, patInput.input.value));
  }

  function clearTypedSecret(input: HTMLInputElement, kind: 'pat' | 'key'): void {
    if (input.value.length === 0) return;
    input.value = '';
    if (kind === 'pat') hasPat = true;
    else hasKey = true;
  }

  /* -------------------------------- rendering ------------------------------ */

  function renderProvider(): void {
    syncForm();
    const providerId = providerSelect.select.value;
    clear(modelList);
    for (const suggestion of modelSuggestions(providerId)) {
      const option = el('option');
      option.value = suggestion;
      modelList.appendChild(option);
    }
    const defaultBaseUrl = providerDefaultBaseUrl(providerId);
    baseUrlInput.input.placeholder = defaultBaseUrl;
    const needsTrust = requiresTrustAck(baseUrlInput.input.value.trim());
    trustBlock.hidden = !needsTrust;
    permissionHint.hidden = !needsTrust;
    apiKeyStored.hidden = !hasKey;

    const validation = validateProviderForm(
      formToProviderPayload(providerFormOf(form, apiKeyInput.input.value, trustCheckbox.input.checked)),
      trustCheckbox.input.checked,
    );
    saveProviderButton.disabled = !validation.ok;
    providerMessage.hidden = validation.ok;
    providerMessage.textContent = validation.ok ? '' : t(validation.messageKey, null, LANG);
  }

  function renderStore(): void {
    syncForm();
    // "Leave empty to keep the stored key" is a lie when there is no stored key — and that lie is how a
    // repository ends up looking configured while every capture fails with notConfigured.
    patStored.hidden = false;
    patStored.textContent = hasPat ? t('options.apiKeyStored', null, LANG) : t('options.store.patMissing', null, LANG);
    patStored.dataset['kind'] = hasPat ? 'ok' : 'error';
    patInput.input.placeholder = hasPat ? t('options.apiKeyKeep', null, LANG) : t('options.store.patNeeded', null, LANG);
    const publicWarningVisible = isPublicRepoWarning(probe);
    publicWarning.hidden = !publicWarningVisible;
    ackBlock.hidden = !publicWarningVisible;

    /* authorization mode: the picker reflects availability, the SSH block only when it is chosen */
    const sshSelected = form.authMode === 'ssh';
    sshBlock.hidden = !sshSelected;
    const sshErrors = validateSshForm(currentSshForm(), LANG);
    for (const [control, message] of [
      [sshHostControl, sshErrors.host],
      [sshUserControl, sshErrors.user],
      [sshKeyControl, sshErrors.keyRef],
      [sshRepoRootControl, sshErrors.repoRoot],
    ] as const) {
      control.input.disabled = !sshSelected;
      control.error.hidden = !sshSelected || message.length === 0;
      control.error.textContent = sshSelected ? message : '';
    }
    // The three fields nobody changes are shown only when they are NOT the defaults: hiding a value the
    // user actually set would be the worst of both worlds.
    const sshCustom =
      form.ssh.host !== 'github.com' || form.ssh.user !== 'git' || form.ssh.keyRef !== 'default';
    sshHostControl.root.hidden = !sshCustom;
    sshUserControl.root.hidden = !sshCustom;
    sshKeyControl.root.hidden = !sshCustom;
    sshDefaultsHint.hidden = sshCustom;
    // The clone command is rebuilt from what the form currently says, so the user can type the
    // repository and the path in either order and always copy a command that matches the screen.
    const guidance = cloneGuidance(
      {
        host: form.ssh.host,
        user: form.ssh.user,
        owner: form.owner,
        repo: form.repo,
        repoRoot: form.ssh.repoRoot,
      },
      LANG,
    );
    cloneBlock.hidden = !sshSelected;
    cloneCommandNode.textContent = guidance.command;
    cloneRow.hidden = guidance.command.length === 0;
    cloneHint.hidden = guidance.command.length > 0;

    // A stored ssh choice with no companion stays selected-but-disabled, so the hint explains why
    // instead of the page silently reverting the user's choice.
    if (authModeDisabled(form.authMode, availability())) {
      authModeSelect.select.disabled = true;
      authModeSelect.select.title = companionStatusText(companion, LANG);
    } else {
      authModeSelect.select.disabled = false;
      authModeSelect.select.title = '';
    }
    companionStatus.textContent = companionStatusText(companion, LANG);
    companionStatus.dataset['kind'] = companion === 'ok' ? 'private' : 'unknown';
    companionInstallHint.hidden = companion === 'ok';

    const branchError = validateBranch(form.branch, LANG);
    branchCheckButton.disabled = branchError.length > 0;
    if (branchError.length > 0) {
      branchNoticeNode.hidden = false;
      branchNoticeNode.textContent = branchError;
      branchNoticeNode.dataset['kind'] = 'error';
      createBranchButton.hidden = true;
    } else if (branchNoticeView === null) {
      branchNoticeNode.hidden = true;
      branchNoticeNode.textContent = '';
      createBranchButton.hidden = true;
    } else {
      branchNoticeNode.hidden = false;
      branchNoticeNode.textContent = branchNoticeView.message;
      const creatable = branchNoticeView.action === 'create';
      createBranchButton.hidden = !creatable;
      branchNoticeNode.dataset['kind'] = branchNoticeView.kind === 'ok' ? 'ok' : 'error';
    }

    visibilityBadge.dataset['kind'] = probe ? probe.visibility : 'unknown';
    visibilityBadge.textContent = `${t('options.store.visibility', null, LANG)}: ${visibilityLabel(
      probe ? probe.visibility : 'unknown',
    )}`;

    // The question is only settled once it has been saved; a click unlocks the save but leaves the
    // step on screen, so the user still sees what they are agreeing to.
    const tierUnanswered = needsTierChoice({ chosen: form.contentTierChosen });
    const tierBlocksSave = needsTierChoice({ chosen: form.contentTierChosen || tierPicked });
    tierBlock.hidden = !tierUnanswered;
    tierSummary.hidden = tierUnanswered;
    if (!tierUnanswered) {
      const settled = tierChoiceOptions(LANG).find((option) => option.value === form.securityMode);
      tierSummary.textContent = t(
        'options.store.tier.chosen',
        { mode: settled ? settled.label : form.securityMode },
        LANG,
      );
    }
    // Field-level truth first: an address that cannot be parsed says so where the user is looking, and it
    // blocks the save instead of quietly probing the repository that is still stored.
    const address = parseRepoAddress(repoAddressControl.input.value);
    const inner = parseInnerPath(innerPathControl.input.value);
    repoAddressControl.error.hidden = address.ok;
    repoAddressControl.error.textContent = address.ok ? '' : t(address.messageKey, null, LANG);
    innerPathControl.error.hidden = inner.ok;
    innerPathControl.error.textContent = inner.ok ? '' : t(inner.messageKey, null, LANG);
    const invalidMessage = address.ok ? (inner.ok ? '' : innerPathControl.error.textContent) : repoAddressControl.error.textContent;

    const typedToken = patInput.input.value.trim().length > 0;
    // The token lives in the vault, so a locked vault cannot accept one. Saying it here is the difference
    // between a disabled button with a reason and a save that fails on a round trip with `locked`.
    const tokenNeedsUnlock = typedToken && form.authMode === 'token' && !vault.unlocked;

    saveStoreButton.disabled =
      (invalidMessage?.length ?? 0) > 0 ||
      tokenNeedsUnlock ||
      saveStorageDisabled(probe, ackCheckbox.input.checked, typedToken) ||
      tierBlocksSave;
    const hint =
      (invalidMessage?.length ?? 0) > 0
        ? invalidMessage ?? ''
        : tokenNeedsUnlock
          ? t('options.store.patNeedsUnlock', null, LANG)
          : storageSaveBlocked(probe, ackCheckbox.input.checked, tierBlocksSave, LANG);
    storeMessage.hidden = hint.length === 0;
    storeMessage.textContent = hint;
  }

  function renderSecurity(): void {
    syncForm();
    const mode = modeSelect.select.value === 'transparent' ? 'transparent' : 'vault';
    transparentBlock.hidden = mode !== 'transparent';

    const parts: string[] = [
      vault.configured
        ? t('options.security.vaultConfigured', null, LANG)
        : t('options.security.vaultNotConfigured', null, LANG),
    ];
    if (vault.configured) {
      parts.push(vault.unlocked ? t('status.unlocked', null, LANG) : t('status.locked', null, LANG));
    }
    if (vault.unlocked && vault.remainingMs > 0) {
      parts.push(
        t(
          'options.security.remaining',
          { minutes: Math.max(1, Math.round(vault.remainingMs / 60_000)) },
          LANG,
        ),
      );
    }
    vaultStatus.textContent = parts.join(' · ');
    vaultStatus.dataset['kind'] = vault.unlocked ? 'private' : 'unknown';

    const blocked = transparentModeNeedsConfirm(mode, transparentConfirm.input.checked);
    saveSecurityButton.disabled = blocked;
    securityMessage.hidden = !blocked;
    securityMessage.textContent = blocked ? t('options.security.confirmRequired', null, LANG) : '';

    unlockVaultButton.disabled = !vault.configured;
    lockVaultButton.disabled = !vault.unlocked;
  }

  function renderLedger(rows: LedgerRow[]): void {
    clear(ledgerBody);
    const empty = rows.length === 0;
    ledgerEmpty.hidden = !empty;
    ledgerTable.hidden = empty;
    for (const row of rows) {
      const tr = el('tr');
      for (const cell of [
        row.provider,
        row.model,
        row.at,
        row.ok ? t('options.ai.ok', null, LANG) : t('options.ai.failed', null, LANG),
      ]) {
        tr.appendChild(el('td', undefined, cell.length > 0 ? cell : '—'));
      }
      ledgerBody.appendChild(tr);
    }
  }

  function renderSync(): void {
    syncOutcomeBadge.textContent = t(`options.sync.outcome.${syncStatus.outcome}`, null, LANG);
    syncOutcomeBadge.dataset['kind'] = syncStatus.outcome === 'failed' ? 'public' : 'private';
    const detail = [
      `${t('options.sync.lastSync', null, LANG)}: ${
        syncStatus.lastSyncAt.length > 0 ? syncStatus.lastSyncAt : t('options.sync.never', null, LANG)
      }`,
      `${t('options.sync.pending', null, LANG)}: ${syncStatus.pending}`,
      `${t('options.sync.conflicts', null, LANG)}: ${syncStatus.conflicts.length}`,
    ];
    if (syncStatus.head.length > 0) {
      detail.push(`${t('options.sync.head', null, LANG)}: ${syncStatus.head.slice(0, 8)}`);
    }
    syncDetail.textContent = detail.join(' · ');

    clear(conflictList);
    const rows = conflictRows(syncStatus.conflicts, LANG);
    conflictEmpty.hidden = rows.length > 0;
    for (const row of rows) {
      const item = el('div', 'row');
      item.append(el('span', 'inbox-title', row.path));
      // Name the sibling: the decision is only concrete if the user can see WHICH file holds their
      // version. Without it the three buttons ask them to trust a convention instead of a path.
      if (row.conflictPath.length > 0) {
        item.append(
          el('span', 'hint', t('options.sync.conflict.sibling', { path: row.conflictPath }, LANG)),
        );
      }
      // No resolution message type exists yet, so each action arms a sync rather than pretending to
      // resolve: the handler keeps both versions and the hint next to the buttons says so.
      for (const choice of ['mine', 'theirs', 'both'] as const) {
        const action = button(conflictChoiceLabel(choice, LANG), 'link');
        action.addEventListener('click', () => void resolveConflict(choice, row));
        item.append(action);
      }
      conflictList.appendChild(item);
    }

    rebuildButton.disabled = searchBusy;
    searchButton.disabled = searchBusy;
    syncNowButton.disabled = searchBusy || syncStatus.outcome === 'busy';
  }

  function renderSearch(rows: SearchResultRow[], needsRebuild: boolean): void {
    clear(searchList);
    searchMessage.hidden = rows.length > 0;
    searchMessage.dataset['kind'] = needsRebuild ? 'error' : 'info';
    if (needsRebuild) searchMessage.textContent = t('options.search.needsRebuild', null, LANG);
    else if (searchQuery.length === 0) searchMessage.textContent = t('options.search.emptyQuery', null, LANG);
    else searchMessage.textContent = t('options.search.empty', null, LANG);

    if (rows.length === 0) return;
    if (!needsRebuild) searchMessage.hidden = true;
    for (const row of rows) {
      const item = el('li');
      const title = el('span', 'inbox-title', row.title);
      title.title = row.title;
      const meta = el('span', 'inbox-meta', [row.path, row.snippet].filter((part) => part.length > 0).join(' · '));
      const open = button(t('options.search.open', null, LANG), 'link');
      open.disabled = row.url.length === 0;
      open.addEventListener('click', () => void openExternal(row.url));
      item.append(title, meta, open);
      searchList.appendChild(item);
    }
  }

  function applyFormToInputs(): void {
    providerSelect.select.value = form.providerId;
    if (providerSelect.select.value !== form.providerId) {
      // A stored id that is no longer in the catalogue is treated the way `resolveProvider` would.
      providerSelect.select.value = 'custom';
    }
    modelInput.input.value = form.model;
    baseUrlInput.input.value = form.baseUrl;
    apiKeyInput.input.value = '';
    repoAddressControl.input.value = repoAddressOf(form.owner, form.repo);
    innerPathControl.input.value = form.pathPrefix;
    branchInput.input.value = form.branch;
    apiBaseInput.input.value = form.apiBase;
    patInput.input.value = '';
    modeSelect.select.value = form.securityMode;
    autoLockInput.input.value = String(clampAutoLockMinutes(form.autoLockMinutes));
    transparentConfirm.input.checked = false;
    ackCheckbox.input.checked = form.publicRepoAcknowledged;
    aiAuthorize.input.checked = form.aiAuthorized;
    /*
     * The SSH block is stored settings too. Without this the local clone path the user saved is
     * invisible — and `syncForm` would then read the blank field back as "no path" (T5.2).
     */
    sshHostControl.input.value = form.ssh.host;
    sshUserControl.input.value = form.ssh.user;
    sshKeyControl.input.value = form.ssh.keyRef;
    sshRepoRootControl.input.value = form.ssh.repoRoot;
    // The picker's options already exist (paintDefaults builds them), so the stored mode can be
    // selected here; `renderAuthModes` then rebuilds without losing it.
    authModeSelect.select.value = form.authMode;
  }

  /* -------------------------------- providers ------------------------------ */

  async function ensureHostPermission(pattern: string): Promise<boolean> {
    try {
      if (await browser.permissions.contains({ origins: [pattern] })) return true;
      return await browser.permissions.request({ origins: [pattern] });
    } catch {
      return false;
    }
  }

  async function saveProviderSection(): Promise<void> {
    syncForm();
    const payload = formToProviderPayload(
      providerFormOf(form, apiKeyInput.input.value, trustCheckbox.input.checked),
    );
    const validation = validateProviderForm(payload, trustCheckbox.input.checked);
    if (!validation.ok) {
      renderProvider();
      return;
    }
    // A custom endpoint is outside the shipped catalogue: ask for it at the moment of saving.
    const endpoint = payload.baseUrl ?? providerDefaultBaseUrl(payload.providerId);
    const pattern = hostPermissionPattern(endpoint);
    if (requiresTrustAck(endpoint) && pattern !== null) {
      const granted = await ensureHostPermission(pattern);
      if (!granted) {
        toastError(t('options.permissionDenied', null, LANG));
        return;
      }
    }
    const response = await send({ type: 'settings.provider', payload });
    if (!response.ok) {
      showErrorCode(response.code);
      return;
    }
    clearTypedSecret(apiKeyInput.input, 'key');
    renderProvider();
    toastSaved();
  }

  /* --------------------------------- storage ------------------------------- */

  async function probeStore(): Promise<void> {
    syncForm();
    // Testing an address we cannot read would test the PREVIOUS repository while the field shows the new
    // one — the exact 'plausible-looking lie' this form was rebuilt to remove.
    if (!fieldsReadable()) {
      renderStore();
      return;
    }
    const payload = currentGithubPayload();
    if (payload.owner.length === 0 || payload.repo.length === 0 || payload.branch.length === 0) {
      showErrorCode('validation');
      return;
    }
    probeButton.disabled = true;
    probeButton.textContent = t('options.testing', null, LANG);
    // `store.probe` reads the STORED configuration, so testing means saving first — the hint says so.
    const saved = await send({ type: 'settings.github', payload });
    if (!saved.ok) {
      probe = null;
      showErrorCode(saved.code);
    } else {
      clearTypedSecret(patInput.input, 'pat');
      form.publicRepoAcknowledged = ackCheckbox.input.checked;
      const probed = await send({ type: 'store.probe' });
      if (probed.ok) {
        probe = normalizeStoreProbe(probed.data);
        toast.show(t('options.testConnection', null, LANG), 'success');
      } else {
        probe = null;
        showErrorCode(probed.code);
      }
    }
    probeButton.disabled = false;
    probeButton.textContent = t('options.testConnection', null, LANG);
    renderStore();
  }

  async function saveStorageSection(): Promise<void> {
    syncForm();
    if (!fieldsReadable()) {
      renderStore();
      return;
    }
    // The tier gate the button reflects, re-checked here: a disabled button is an affordance, not a
    // boundary, and the answer is what makes this repository's contents predictable.
    if (needsTierChoice({ chosen: form.contentTierChosen || tierPicked })) {
      renderStore();
      return;
    }
    if (saveStorageDisabled(probe, ackCheckbox.input.checked, patInput.input.value.trim().length > 0)) {
      renderStore();
      return;
    }
    // The mode picker lives in this card, so its two refusals live here too: an unavailable companion
    // or an incomplete SSH block stops the save rather than being stored and failing at the first sync.
    if (authModeDisabled(form.authMode, availability())) {
      showErrorCode('nativeUnavailable');
      return;
    }
    if (form.authMode === 'ssh' && hasSshFormErrors(validateSshForm(currentSshForm(), LANG))) {
      renderStore();
      return;
    }
    const payload = currentGithubPayload();
    const response = await send({ type: 'settings.github', payload });
    if (!response.ok) {
      showErrorCode(response.code);
      return;
    }
    clearTypedSecret(patInput.input, 'pat');
    // The picker answers the mode and the tier step answers the tier: ONE request for both, because two
    // `settings.security` round trips in the same save trip the router's rate limiter — and two calls
    // carrying one decision are two calls that can disagree.
    const stored = await send({
      type: 'settings.security',
      payload: { authMode: form.authMode, securityMode: form.securityMode, contentTierChosen: true },
    });
    if (!stored.ok) {
      showErrorCode(stored.code);
      return;
    }
    form.contentTierChosen = true;
    tierPicked = true;
    renderStore();
    toastSaved();
  }

  /* --------------------------------- auth ---------------------------------- */

  /**
   * Store the chosen authorization mode.
   *
   * The request is `settings.security` with an `authMode` field. That field is NOT in the current
   * `SecuritySettingsPayload`, so it is sent as a plain payload: the worker ignores an unknown key
   * until its validator learns it, and this helper is the single place that changes when it does.
   * (No new message type was invented — the router's contract is untouched.)
   */
  async function storeAuthMode(mode: 'token' | 'ssh'): Promise<ExtensionResponse<unknown>> {
    return send({ type: 'settings.security', payload: { authMode: mode } } as ExtensionRequest);
  }

  /** Save the branch (and any stored config) so a probe actually tests what the user typed. */
  async function persistBranchForProbe(): Promise<boolean> {
    syncForm();
    const branchError = validateBranch(form.branch, LANG);
    if (branchError.length > 0) {
      showErrorCode('validation');
      return false;
    }
    if (form.owner.length === 0 || form.repo.length === 0) {
      showErrorCode('notConfigured');
      return false;
    }
    const saved = await send({ type: 'settings.github', payload: currentGithubPayload() });
    if (!saved.ok) {
      showErrorCode(saved.code);
      return false;
    }
    clearTypedSecret(patInput.input, 'pat');
    return true;
  }

  async function checkBranch(): Promise<void> {
    if (!(await persistBranchForProbe())) return;
    branchCheckButton.disabled = true;
    branchCheckButton.textContent = t('options.branch.checking', null, LANG);
    // `auth.probe` answers for the *selected* mode: token mode reports the branch the REST API
    // resolved, SSH mode asks the companion about the remote.
    const probed = await send<unknown>({ type: 'auth.probe' });
    branchCheckButton.textContent = t('options.branch.check', null, LANG);
    branchCheckButton.disabled = false;
    if (!probed.ok) {
      branchNoticeView = null;
      showErrorCode(probed.code);
      renderStore();
      return;
    }
    probe = normalizeStoreProbe(probed.data) ?? probe;
    branchNoticeView = branchCheckNotice(branchCheck(probed.data, form.branch), LANG);
    renderStore();
  }

  async function createBranch(): Promise<void> {
    if (!(await persistBranchForProbe())) return;
    toast.show(t('options.branch.created', null, LANG), 'info');
  }

  async function testSshConnection(): Promise<void> {
    syncForm();
    if (sshSaveDisabled(currentSshForm())) {
      renderStore();
      return;
    }
    // The probe resolves the *stored* mode, so testing SSH means storing the selection first.
    const stored = await storeAuthMode('ssh');
    if (!stored.ok) {
      showErrorCode(stored.code);
      return;
    }
    sshTestButton.disabled = true;
    sshTestButton.textContent = t('options.testing', null, LANG);
    const probed = await send<unknown>({ type: 'auth.probe' });
    sshTestButton.textContent = t('options.auth.ssh.testConnection', null, LANG);
    sshTestButton.disabled = false;
    if (!probed.ok) {
      probe = null;
      showErrorCode(probed.code);
    } else {
      probe = normalizeStoreProbe(probed.data);
      const view = branchCheckNotice(branchCheck(probed.data, form.branch), LANG);
      branchNoticeView = view;
      toast.show(view.message, view.kind === 'ok' ? 'success' : 'info');
    }
    renderStore();
  }


  /**
   * Hand the user the clone command. A refused clipboard is not a failure of the feature — the
   * command stays on screen and selectable — but it must not pass for success either.
   */
  async function copyCloneCommand(): Promise<void> {
    const command = cloneCommandNode.textContent ?? '';
    if (command.length === 0) return;
    try {
      await navigator.clipboard.writeText(command);
      toast.show(t('options.auth.ssh.clone.copied', null, LANG), 'success');
    } catch {
      toastError(t('options.auth.ssh.clone.copyFailed', null, LANG));
    }
  }

  /* ----------------------------------- sync -------------------------------- */

  /** Open a URL in a new tab, and only ever an https one. */
  async function openExternal(href: string): Promise<void> {
    if (!isSafeExternalUrl(href)) return;
    await browser.tabs.create({ url: href });
  }

  async function reloadSyncStatus(): Promise<void> {
    const response = await send<unknown>({ type: 'sync.status' });
    if (!response.ok) {
      syncStatus = normalizeSyncStatus(null);
      renderSync();
      showErrorCode(response.code);
      return;
    }
    syncStatus = normalizeSyncStatus(response.data);
    renderSync();
  }

  async function syncNow(): Promise<void> {
    syncNowButton.disabled = true;
    syncNowButton.textContent = t('options.sync.syncing', null, LANG);
    const response = await send<unknown>({ type: 'sync.now', payload: { reason: 'manual' } });
    syncNowButton.textContent = t('options.sync.now', null, LANG);
    if (!response.ok) {
      showErrorCode(response.code);
      await reloadSyncStatus();
      return;
    }
    const result = normalizeSyncResult(response.data);
    toast.show(
      `${t('options.sync.done', null, LANG)} — ${t(`options.sync.outcome.${result.outcome}`, null, LANG)}`,
      'success',
    );
    await reloadSyncStatus();
  }

  /**
   * Resolve one conflict — the decision the engine deliberately left to the human.
   *
   * The winner takes the original path and the loser is archived (never deleted), in one commit. If the reply
   * did not name the conflicting copy we must not invent a path: a decision about a file we cannot point at
   * would be a lie, so we say so and re-sync to find it.
   */
  async function resolveConflict(choice: 'mine' | 'theirs' | 'both', row: ConflictRow): Promise<void> {
    const action = choice === 'mine' ? 'keep-mine' : choice === 'theirs' ? 'keep-remote' : 'keep-both';
    if (row.conflictPath.length === 0) {
      syncMessage.hidden = false;
      syncMessage.dataset['kind'] = 'error';
      syncMessage.textContent = t('options.sync.conflict.unknownSibling', null, LANG);
      await syncNow();
      return;
    }
    const response = await send({
      type: 'conflict.resolve',
      payload: { path: row.path, conflictPath: row.conflictPath, action },
    });
    if (!response.ok) {
      syncMessage.hidden = false;
      syncMessage.dataset['kind'] = 'error';
      // Fixed translations only: the handler's own sentence is never rendered (same rule as the status row).
      const described = describeError(response.code, LANG);
      syncMessage.textContent =
        described.hint === null ? described.message : `${described.message} — ${described.hint}`;
      return;
    }
    syncMessage.hidden = false;
    syncMessage.dataset['kind'] = 'ok';
    syncMessage.textContent = t('options.sync.conflict.done', null, LANG);
    // Re-read the status so the resolved path disappears from the list and the counts follow.
    const status = await send<unknown>({ type: 'sync.status' });
    syncStatus = status.ok ? normalizeSyncStatus(status.data) : normalizeSyncStatus(null);
    renderSync();
  }

  async function saveSyncPolicy(): Promise<void> {
    const payload: SyncPolicyPayload | null = syncPolicyPayload({
      intervalMinutes: syncIntervalInput.input.value,
      onStartup: syncOnStartup.input.checked,
      onCapture: syncOnCapture.input.checked,
      pullOnly: syncPullOnly.input.checked,
    });
    if (!payload) {
      syncPolicyMessage.hidden = false;
      syncPolicyMessage.dataset['kind'] = 'error';
      syncPolicyMessage.textContent = t('options.sync.policy.invalid', null, LANG);
      return;
    }
    syncPolicyMessage.hidden = true;
    const response = await send({ type: 'sync.policy', payload });
    if (!response.ok) {
      showErrorCode(response.code);
      return;
    }
    toast.show(t('options.sync.policy.saved', null, LANG), 'success');
  }

  async function runSearch(): Promise<void> {
    searchQuery = searchInput.input.value.trim();
    if (searchQuery.length === 0) {
      renderSearch([], false);
      return;
    }
    searchBusy = true;
    searchButton.disabled = true;
    searchButton.textContent = t('options.search.searching', null, LANG);
    const response = await send<unknown>({ type: 'search.query', payload: { text: searchQuery } });
    searchButton.disabled = false;
    searchButton.textContent = t('options.search.button', null, LANG);
    searchBusy = false;
    if (!response.ok) {
      renderSearch([], response.code === 'indexUnavailable');
      showErrorCode(response.code);
      return;
    }
    const view = searchResultRows(response.data, {
      repoFullName: form.owner && form.repo ? `${form.owner}/${form.repo}` : '',
      branch: form.branch,
      limit: 10,
    });
    renderSearch(view.rows, view.needsRebuild);
  }

  async function rebuildIndex(): Promise<void> {
    rebuildButton.disabled = true;
    rebuildButton.textContent = t('options.search.rebuilding', null, LANG);
    const response = await send({ type: 'search.rebuild' });
    rebuildButton.textContent = t('options.search.rebuild', null, LANG);
    rebuildButton.disabled = false;
    if (!response.ok) {
      showErrorCode(response.code);
      return;
    }
    toast.show(t('options.search.rebuilt', null, LANG), 'success');
    if (searchQuery.length > 0) await runSearch();
  }

  /* --------------------------------- security ------------------------------ */

  function securityError(messageKey: string): void {
    securityMessage.hidden = false;
    securityMessage.textContent = t(messageKey, null, LANG);
  }

  async function setupVault(): Promise<void> {
    const passphrase = passphraseInput.input.value;
    if (passphraseTooShort(passphrase)) {
      securityError('error.passphraseTooShort');
      return;
    }
    // Any credential the user just typed in another section goes straight into the new vault.
    const secrets: { githubPat?: string; providerKey?: string } = {};
    if (patInput.input.value.length > 0) secrets.githubPat = patInput.input.value.trim();
    if (apiKeyInput.input.value.length > 0) secrets.providerKey = apiKeyInput.input.value.trim();
    const payload =
      Object.keys(secrets).length > 0 ? { passphrase, secrets } : { passphrase };
    const response = await send({ type: 'vault.setup', payload });
    if (!response.ok) {
      showErrorCode(response.code);
      return;
    }
    passphraseInput.input.value = '';
    if (secrets.githubPat !== undefined) {
      patInput.input.value = '';
      hasPat = true;
    }
    if (secrets.providerKey !== undefined) {
      apiKeyInput.input.value = '';
      hasKey = true;
    }
    securityMessage.hidden = true;
    await refreshVault();
    toastSaved();
  }

  async function unlockVault(): Promise<void> {
    const passphrase = passphraseInput.input.value;
    if (passphrase.length === 0) {
      securityError('error.wrongPassphrase');
      return;
    }
    const response = await send({ type: 'vault.unlock', payload: { passphrase } });
    if (!response.ok) {
      showErrorCode(response.code);
      return;
    }
    passphraseInput.input.value = '';
    securityMessage.hidden = true;
    await refreshVault();
    toastSaved();
  }

  async function lockVault(): Promise<void> {
    const response = await send({ type: 'vault.lock' });
    if (!response.ok) {
      showErrorCode(response.code);
      return;
    }
    await refreshVault();
  }

  async function saveSecuritySection(): Promise<void> {
    syncForm();
    if (transparentModeNeedsConfirm(form.securityMode, transparentConfirm.input.checked)) {
      renderSecurity();
      return;
    }
    const response = await send({ type: 'settings.security', payload: formToSecurityPayload(form) });
    if (!response.ok) {
      showErrorCode(response.code);
      return;
    }
    renderSecurity();
    toastSaved();
  }

  /* ----------------------------------- ai ---------------------------------- */

  async function reloadLedger(): Promise<void> {
    const response = await send<unknown>({ type: 'ai.ledger', payload: { limit: LEDGER_LIMIT } });
    if (!response.ok) {
      renderLedger([]);
      showErrorCode(response.code);
      return;
    }
    renderLedger(ledgerRows(response.data));
  }

  async function toggleAiAuthorization(): Promise<void> {
    const next = aiAuthorize.input.checked;
    aiAuthorize.input.disabled = true;
    const response = await send({ type: 'settings.security', payload: { aiAuthorized: next } });
    aiAuthorize.input.disabled = false;
    if (!response.ok) {
      aiAuthorize.input.checked = !next;
      showErrorCode(response.code);
      return;
    }
    form.aiAuthorized = next;
    toast.show(
      next ? t('options.ai.authorized', null, LANG) : t('options.ai.authorize', null, LANG),
      'success',
    );
  }

  async function clearLedger(): Promise<void> {
    const response = await send({ type: 'ai.ledger.clear' });
    if (!response.ok) {
      showErrorCode(response.code);
      return;
    }
    await reloadLedger();
    toast.show(t('options.ai.ledgerCleared', null, LANG), 'success');
  }

  /* ---------------------------------- data --------------------------------- */

  async function exportConfiguration(): Promise<void> {
    const response = await send<unknown>({ type: 'settings.export' });
    if (!response.ok) {
      showErrorCode(response.code);
      return;
    }
    const text = exportJson(response.data);
    exportPre.textContent = text;
    exportPre.hidden = text.length === 0;
    copyButton.hidden = text.length === 0;
    if (text.length > 0) {
      toast.show(t('options.data.exportHint', null, LANG), 'info');
    }
  }

  async function copyExport(): Promise<void> {
    try {
      await navigator.clipboard.writeText(exportPre.textContent ?? '');
      toast.show(t('options.data.copied', null, LANG), 'success');
    } catch {
      // Clipboard access can be refused; the JSON stays on screen to be selected by hand.
      toastError(t('options.data.copyFailed', null, LANG));
    }
  }

  async function resetEverything(): Promise<void> {
    const response = await send({ type: 'settings.reset' });
    resetBox.hidden = true;
    if (!response.ok) {
      showErrorCode(response.code);
      return;
    }
    toast.show(t('options.data.resetDone', null, LANG), 'success');
    await loadAll();
  }

  /* --------------------------------- loading ------------------------------- */

  async function refreshVault(): Promise<void> {
    const response = await send<unknown>({ type: 'vault.status' });
    vault = response.ok ? normalizeStatusPayload({ vault: response.data }).vault : emptyVaultInfo();
    if (!response.ok) showErrorCode(response.code);
    renderSecurity();
  }

  async function loadAll(): Promise<void> {
    const [exported, status] = await Promise.all([
      send<unknown>({ type: 'settings.export' }),
      send<unknown>({ type: 'status.get' }),
    ]);

    if (exported.ok) {
      Object.assign(form, settingsToForm(exported.data));
      const presence = secretsPresence(exported.data);
      hasPat = presence.githubPat;
      hasKey = presence.providerKey;
    } else {
      showErrorCode(exported.code);
    }

    if (status.ok) {
      const normalized = normalizeStatusPayload(status.data);
      vault = normalized.vault;
      probe = normalized.probe;
      hasPat = hasPat || normalized.prefs.hasPat;
      hasKey = hasKey || normalized.prefs.hasKey;
      companion = normalized.prefs.companion;
    } else {
      showErrorCode(status.code);
    }

    applyFormToInputs();
    renderProvider();
    renderAuthModes();
    renderStore();
    renderSecurity();
    renderSync();
    renderSearch([], false);
    await reloadLedger();
    await reloadSyncStatus();
  }

  /* --------------------------------- wiring -------------------------------- */

  providerSelect.select.addEventListener('change', () => {
    // Switching provider drops a stale custom URL rather than carrying it into the new one.
    baseUrlInput.input.value = '';
    trustCheckbox.input.checked = false;
    renderProvider();
  });
  for (const control of [modelInput.input, baseUrlInput.input, apiKeyInput.input]) {
    control.addEventListener('input', () => renderProvider());
  }
  trustCheckbox.input.addEventListener('change', () => renderProvider());
  saveProviderButton.addEventListener('click', () => void saveProviderSection());

  for (const control of [
    repoAddressControl.input,
    innerPathControl.input,
    branchInput.input,
    apiBaseInput.input,
  ]) {
    control.addEventListener('input', () => renderStore());
  }
  ackCheckbox.input.addEventListener('change', () => renderStore());
  probeButton.addEventListener('click', () => void probeStore());
  saveStoreButton.addEventListener('click', () => void saveStorageSection());
  authModeSelect.select.addEventListener('change', () => {
    branchNoticeView = null;
    renderStore();
  });
  for (const input of [
    sshHostControl.input,
    sshUserControl.input,
    sshKeyControl.input,
    sshRepoRootControl.input,
  ]) {
    input.addEventListener('input', () => renderStore());
  }
  cloneCopyButton.addEventListener('click', () => void copyCloneCommand());
  sshTestButton.addEventListener('click', () => void testSshConnection());
  branchCheckButton.addEventListener('click', () => void checkBranch());
  createBranchButton.addEventListener('click', () => void createBranch());

  syncNowButton.addEventListener('click', () => void syncNow());
  for (const input of [syncIntervalInput.input, syncOnStartup.input, syncOnCapture.input, syncPullOnly.input]) {
    input.addEventListener('input', () => {
      syncPolicyMessage.hidden = true;
    });
  }
  saveSyncPolicyButton.addEventListener('click', () => void saveSyncPolicy());
  searchButton.addEventListener('click', () => void runSearch());
  searchInput.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void runSearch();
  });
  rebuildButton.addEventListener('click', () => void rebuildIndex());

  modeSelect.select.addEventListener('change', () => {
    transparentConfirm.input.checked = false;
    renderSecurity();
  });
  transparentConfirm.input.addEventListener('change', () => renderSecurity());
  autoLockInput.input.addEventListener('input', () => renderSecurity());
  setupVaultButton.addEventListener('click', () => void setupVault());
  unlockVaultButton.addEventListener('click', () => void unlockVault());
  lockVaultButton.addEventListener('click', () => void lockVault());
  saveSecurityButton.addEventListener('click', () => void saveSecuritySection());

  aiAuthorize.input.addEventListener('change', () => void toggleAiAuthorization());
  clearLedgerButton.addEventListener('click', () => void clearLedger());

  exportButton.addEventListener('click', () => void exportConfiguration());
  copyButton.addEventListener('click', () => void copyExport());
  resetButton.addEventListener('click', () => {
    resetBox.hidden = false;
  });
  resetCancelButton.addEventListener('click', () => {
    resetBox.hidden = true;
  });
  resetConfirmButton.addEventListener('click', () => void resetEverything());

  /* ---------------------------------- start -------------------------------- */

  /** First paint, before any message: nothing may look "already verified" while we have no answer. */
  function paintDefaults(): void {
    exportPre.hidden = true;
    copyButton.hidden = true;
    resetBox.hidden = true;
    apiKeyStored.hidden = true;
    patStored.hidden = true;
    providerMessage.hidden = true;
    securityMessage.hidden = true;
    syncMessage.hidden = true;
    syncPolicyMessage.hidden = true;
    syncOutcomeBadge.dataset['kind'] = 'unknown';
    syncOutcomeBadge.textContent = t('options.sync.outcome.never', null, LANG);
    sshBlock.hidden = true;
    cloneBlock.hidden = true;
    tierBlock.hidden = true;
    tierSummary.hidden = true;
    branchNoticeNode.hidden = true;
    createBranchButton.hidden = true;
    companionStatus.textContent = companionStatusText(companion, LANG);
    companionStatus.dataset['kind'] = 'unknown';
    searchMessage.textContent = t('options.search.emptyQuery', null, LANG);
    clear(searchList);
    renderAuthModes();
    transparentBlock.hidden = true;
    transparentConfirm.input.checked = false;
    publicWarning.hidden = true;
    ackBlock.hidden = true;
    storeMessage.hidden = true;
    vaultStatus.textContent = t('options.security.vaultNotConfigured', null, LANG);
    vaultStatus.dataset['kind'] = 'unknown';
    visibilityBadge.dataset['kind'] = 'unknown';
    visibilityBadge.textContent = `${t('options.store.visibility', null, LANG)}: ${visibilityLabel(
      'unknown',
    )}`;
    renderLedger([]);
  }

  paintDefaults();
  activate('providers');
  void loadAll();
}

main();
