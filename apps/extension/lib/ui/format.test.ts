import { describe, expect, it } from 'vitest';

import { t } from '../i18n';
import { MIN_PASSPHRASE_LENGTH } from '../security/crypto-key';
import {
  DEFAULT_SETTINGS,
  MAX_AUTO_LOCK_MINUTES as STORE_MAX_AUTO_LOCK,
  MIN_AUTO_LOCK_MINUTES as STORE_MIN_AUTO_LOCK,
} from '../settings-store';
import type { StoreProbe } from '../store/types';
import {
  DEFAULT_AUTO_LOCK_MINUTES,
  MAX_AUTO_LOCK_MINUTES,
  MIN_AUTO_LOCK_MINUTES,
  MIN_PASSPHRASE_CHARS,
  branchCheck,
  branchCheckNotice,
  clampAutoLockMinutes,
  conflictChoiceLabel,
  conflictRows,
  describeError,
  distillPayloadFor,
  emptyStatusPayload,
  errorText,
  exportJson,
  firstInjectionResult,
  formatTimestamp,
  formToGithubPayload,
  formToProviderPayload,
  formToSecurityPayload,
  githubFormOf,
  hostPermissionPattern,
  httpStatusToErrorCode,
  inboxRows,
  isSafeExternalUrl,
  ledgerRows,
  maskSecret,
  modelSuggestions,
  normalizeErrorCode,
  normalizeStatusPayload,
  normalizeSyncResult,
  normalizeSyncStatus,
  normalizeVaultInfo,
  passphraseTooShort,
  providerDefaultBaseUrl,
  providerFormOf,
  providerLabel,
  providerOptions,
  repoFullNameOf,
  safeText,
  saveProviderDisabled,
  saveStorageDisabled,
  searchResultRows,
  secretsPresence,
  selectionCapturePayload,
  settingsToForm,
  statusPanel,
  storageSaveHint,
  syncPolicyPayload,
  transparentModeNeedsConfirm,
  validateProviderForm,
} from './format';

/** Credential-shaped strings: none of them may ever appear in a rendered surface. */
const SECRET_LOOKALIKE = /gh[pousr]_|github_pat_|sk-|Bearer/u;

function probe(overrides: Partial<StoreProbe> = {}): StoreProbe {
  return {
    kind: 'github',
    repoFullName: 'zayeagle/kb',
    visibility: 'private',
    defaultBranch: 'main',
    canPush: true,
    canWrite: true,
    checkedAt: '2026-07-09T10:00:00.000Z',
    ...overrides,
  };
}

function statusOf(prefs: Record<string, unknown>, storeProbe: StoreProbe | null): unknown {
  return {
    prefs: {
      enabled: true,
      storeKind: 'github',
      repoFullName: 'zayeagle/kb',
      securityMode: 'vault',
      hasPat: true,
      hasKey: true,
      vaultLocked: false,
      aiAuthorized: false,
      ...prefs,
    },
    probe: storeProbe,
    vault: { configured: true, unlocked: true, expiresAt: 1, remainingMs: 60_000 },
  };
}

describe('error classifier (F8 UNIT)', () => {
  it('TC-F8-U04 maps 401/403/404/409/422 onto distinct fixed messages', () => {
    const statuses = [401, 403, 404, 409, 422];
    const messages = statuses.map((status) => describeError(status, 'en').message);
    expect(new Set(messages).size).toBe(statuses.length);
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
      // Fixed sentences, never a raw server string.
      expect(message).not.toMatch(/^\d{3}/u);
      expect(message).not.toMatch(SECRET_LOOKALIKE);
    }
    expect(messages[0]).toBe(t('error.auth', null, 'en'));
    expect(messages[1]).toBe(t('error.scope', null, 'en'));
    expect(messages[2]).toBe(t('error.notFound', null, 'en'));
    expect(messages[4]).toBe(t('error.validation', null, 'en'));
  });

  it('TC-F8-U04 attaches the Contents-write scope hint on 403 only', () => {
    const forbidden = describeError(403, 'en');
    expect(forbidden.code).toBe('scope');
    expect(forbidden.hint).toBe(t('options.store.scopeHint', null, 'en'));
    expect(forbidden.hint).toContain('Contents: Read and write');
    expect(describeError(404, 'en').hint).toBeNull();
    // The Chinese surface carries the same hint, from the same key.
    expect(describeError(403, 'zh_CN').hint).toBe(t('options.store.scopeHint', null, 'zh_CN'));
  });

  it('TC-F8-U04 maps HTTP statuses onto protocol codes', () => {
    expect(httpStatusToErrorCode(400)).toBe('validation');
    expect(httpStatusToErrorCode(401)).toBe('auth');
    expect(httpStatusToErrorCode(403)).toBe('scope');
    expect(httpStatusToErrorCode(404)).toBe('notFound');
    expect(httpStatusToErrorCode(409)).toBe('conflict');
    expect(httpStatusToErrorCode(422)).toBe('validation');
    expect(httpStatusToErrorCode(429)).toBe('rateLimited');
    expect(httpStatusToErrorCode(503)).toBe('network');
    expect(httpStatusToErrorCode(204)).toBe('unknown');
  });

  it('TC-F8-U04 normalises codes, errors and junk without throwing', () => {
    expect(normalizeErrorCode('auth')).toBe('auth');
    expect(normalizeErrorCode({ code: 'locked' })).toBe('locked');
    expect(normalizeErrorCode({ status: 403 })).toBe('scope');
    expect(normalizeErrorCode({ code: 'not-a-code' })).toBe('unknown');
    expect(normalizeErrorCode(new Error('boom'))).toBe('unknown');
    for (const junk of [null, undefined, '', 0, Number.NaN, [], {}, true, 'nope']) {
      expect(normalizeErrorCode(junk)).toBe('unknown');
      expect(describeError(junk).message).toBe(t('error.unknown', null, 'zh_CN'));
      expect(errorText(junk)).toBe(t('error.unknown', null, 'zh_CN'));
      expect(describeError(junk).message.length).toBeGreaterThan(0);
    }
  });

  it('TC-F8-U04 routes the actionable codes to a next step', () => {
    expect(describeError('notConfigured', 'en').hint).toBe(t('popup.needSetup', null, 'en'));
    expect(describeError('locked', 'en').hint).toBe(t('popup.needUnlock', null, 'en'));
    expect(describeError('publicRepo', 'en').hint).toBe(
      t('options.store.publicWarning', null, 'en'),
    );
    expect(describeError('timeout', 'en').hint).toBeNull();
  });
});

describe('status view model (F8 UNIT)', () => {
  it('TC-F8-U02 renders every status row from a status.get reply', () => {
    // The row labels come from `lib/status.ts`, which renders the default UI language; the notice
    // is this module's own string and therefore honours the requested language.
    const panel = statusPanel(statusOf({}, probe()));
    expect(panel.rows.store).toBe('github');
    expect(panel.rows.repo).toBe('zayeagle/kb');
    expect(panel.rows.mode).toBe(t('options.security.mode.vault'));
    expect(panel.rows.vault).toBe(t('status.unlocked'));
    expect(panel.rows.ai).toBe(t('status.aiOff'));
    expect(panel.visibility).toBe('private');
    expect(panel.publicWarning).toBe(false);
    expect(panel.canClip).toBe(true);
    expect(panel.notice).toBe(t('popup.ready'));
    expect(statusPanel(statusOf({}, probe()), 'en').notice).toBe(t('popup.ready', null, 'en'));
  });

  it('TC-F8-U02 never places a credential-shaped substring in the panel', () => {
    const panel = statusPanel(statusOf({ aiAuthorized: true }, probe()));
    const serialized = JSON.stringify(panel);
    expect(serialized).not.toMatch(SECRET_LOOKALIKE);
    // "token" may appear only as the authorization MODE name, never as a credential value.
    expect(serialized).not.toMatch(/(access|api|github|pat|bearer)[ _-]?token/iu);
    expect(serialized).not.toMatch(/"token"\s*:\s*"[^"]{8,}"/iu);
    expect(serialized.toLowerCase()).not.toContain('passphrase');
    expect(panel.rows.ai).toBe(t('status.aiOn'));
  });

  it('TC-F8-U02 disables clipping with an explanation for each blocking state', () => {
    const cases: Array<[string, unknown, string]> = [
      ['disabled', statusOf({ enabled: false }, null), t('popup.notice.disabled', null, 'en')],
      ['not configured', statusOf({ hasPat: false }, null), t('popup.needSetup', null, 'en')],
      ['vault locked', statusOf({ vaultLocked: true }, null), t('popup.needUnlock', null, 'en')],
      [
        'public repo',
        statusOf({}, probe({ visibility: 'public', canWrite: false, warning: 'public-repo' })),
        t('error.publicRepo', null, 'en'),
      ],
    ];
    for (const [label, status, expected] of cases) {
      const panel = statusPanel(status, 'en');
      expect(panel.canClip, label).toBe(false);
      expect(panel.notice, label).toBe(expected);
      expect(panel.readinessLabel.length, label).toBeGreaterThan(0);
    }
  });

  it('TC-F8-U02 surfaces the public-repo warning and its label from the probe', () => {
    const panel = statusPanel(statusOf({}, probe({ visibility: 'public', canWrite: false })), 'zh_CN');
    expect(panel.publicWarning).toBe(true);
    expect(panel.visibilityLabel).toBe(t('options.store.visibility.public', null, 'zh_CN'));
    expect(panel.canClip).toBe(false);
  });

  it('TC-F8-U02 falls back to a safe status for junk and fails closed on a public probe', () => {
    const fallback = statusPanel(null);
    expect(fallback.rows.repo).toBe(t('status.unconfigured', null, 'zh_CN'));
    expect(fallback.canClip).toBe(false);
    expect(fallback.visibility).toBe('unknown');

    const normalized = normalizeStatusPayload({
      prefs: 'nope',
      probe: { repoFullName: 'o/r', visibility: 'public', canPush: true },
      vault: { configured: 'yes', remainingMs: -5 },
    });
    expect(normalized.prefs.repoFullName).toBe('');
    expect(normalized.probe?.canWrite).toBe(false);
    expect(normalized.vault.configured).toBe(false);
    expect(normalized.vault.remainingMs).toBe(0);
    expect(emptyStatusPayload().probe).toBeNull();
    expect(normalizeVaultInfo(42).configured).toBe(false);
    expect(normalizeStatusPayload({}).probe).toBeNull();
  });
});

describe('secret-free projections (F8 UNIT)', () => {
  it('TC-F8-U01 masks a stored secret without revealing value or length', () => {
    expect(maskSecret('ghp_0123456789abcdefghij')).toBe('••••••••');
    expect(maskSecret('sk-0123456789')).toBe(maskSecret('x'));
    expect(maskSecret('ghp_0123456789abcdefghij')).not.toContain('ghp');
    expect(maskSecret('')).toBe('');
    expect(maskSecret(null)).toBe('');
    expect(maskSecret(undefined)).toBe('');
    expect(maskSecret(12345)).toBe('');
  });

  it('TC-F8-U01 reads secret presence as booleans only', () => {
    expect(secretsPresence({ secretsPresent: { githubPat: true, providerKey: false } })).toEqual({
      githubPat: true,
      providerKey: false,
    });
    expect(secretsPresence({ hasPat: true, hasKey: true })).toEqual({
      githubPat: true,
      providerKey: true,
    });
    expect(secretsPresence({ githubPat: 'ghp_realsecret' })).toEqual({
      githubPat: false,
      providerKey: false,
    });
    expect(secretsPresence(null)).toEqual({ githubPat: false, providerKey: false });
  });

  it('TC-F8-U01 whitelists the AI ledger rows down to four fields', () => {
    const rows = ledgerRows([
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        at: '2026-07-09T12:34:56.789Z',
        ok: true,
        content: 'PRIVATE PAGE BODY',
        prompt: 'PRIVATE PAGE BODY',
      },
      { providerId: 'deepseek', model: 'deepseek-chat', at: 'nonsense', ok: 'yes' },
      'junk',
      null,
    ]);
    expect(rows).toEqual([
      { provider: 'openai', model: 'gpt-4o-mini', at: '2026-07-09 12:34 UTC', ok: true },
      { provider: 'deepseek', model: 'deepseek-chat', at: '', ok: false },
    ]);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE PAGE BODY');
    expect(Object.keys(rows[0] ?? {})).toEqual(['provider', 'model', 'at', 'ok']);
    expect(ledgerRows('nope')).toEqual([]);
    expect(ledgerRows(undefined)).toEqual([]);
  });

  it('TC-F8-U01 caps, cleans and sanitises the Inbox rows', () => {
    const entries = Array.from({ length: 9 }, (_unused, index) => ({
      id: `id${index}`,
      path: `inbox/2026/07/p${index}.md`,
      title: `Title ${index}\u0000`,
      url: index === 1 ? 'javascript:alert(1)' : `https://github.com/o/r/commit/${index}`,
      capturedAt: '2026-07-09T12:34:56.789Z',
    }));
    const rows = inboxRows(entries, 5);
    expect(rows).toHaveLength(5);
    expect(rows[0]?.title).toBe('Title 0');
    expect(rows[0]?.url).toBe('https://github.com/o/r/commit/0');
    expect(rows[1]?.url).toBe('');
    expect(inboxRows(entries, 0)).toEqual([]);
    expect(inboxRows('nope')).toEqual([]);
    expect(inboxRows([{ title: 'orphan' }])).toEqual([]);
    expect(inboxRows([{ id: 'a' }])[0]).toMatchObject({ id: 'a', path: '', title: 'a' });
  });

  it('TC-F8-U01 renders the exported configuration as copyable JSON', () => {
    const text = exportJson({ settings: { github: { owner: 'o' } }, secretsPresent: { githubPat: true } });
    expect(text).toContain('"secretsPresent"');
    expect(text.split('\n').length).toBeGreaterThan(1);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(exportJson(cyclic)).toBe('');
  });

  it('TC-F8-U01 never copies a stored credential into the settings form', () => {
    const form = settingsToForm({
      exportedAt: '2026-07-09T00:00:00.000Z',
      settings: {
        enabled: false,
        aiAuthorized: true,
        securityMode: 'transparent',
        autoLockMinutes: 45,
        github: {
          owner: 'zayeagle',
          repo: 'kb',
          branch: 'trunk',
          pathPrefix: 'private/kb',
          apiBase: 'https://api.github.com',
          publicRepoAcknowledged: true,
        },
        ai: { providerId: 'anthropic', model: 'claude-3-5-haiku-latest', baseUrl: '' },
        authMode: 'ssh',
        ssh: { host: 'git.example.com', user: 'deploy', keyRef: 'work', repoRoot: '/srv/kb' },
      },
      vault: { configured: true, unlocked: false, expiresAt: null, remainingMs: 0 },
      secretsPresent: { githubPat: true, providerKey: true },
    });
    expect(form).toEqual({
      enabled: false,
      aiAuthorized: true,
      securityMode: 'transparent',
      autoLockMinutes: 45,
      owner: 'zayeagle',
      repo: 'kb',
      branch: 'trunk',
      pathPrefix: 'private/kb',
      apiBase: 'https://api.github.com',
      providerId: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      baseUrl: '',
      publicRepoAcknowledged: true,
      authMode: 'ssh',
      ssh: { host: 'git.example.com', user: 'deploy', keyRef: 'work', repoRoot: '/srv/kb' },
    });
    for (const key of ['pat', 'apiKey', 'githubPat', 'providerKey']) {
      expect(Object.keys(form)).not.toContain(key);
    }
    expect(JSON.stringify(form)).not.toMatch(SECRET_LOOKALIKE);
  });

  it('TC-F8-U01 tolerates a bare settings object and junk input', () => {
    const bare = settingsToForm({ github: { owner: 'o', repo: 'r' } });
    expect(bare.owner).toBe('o');
    expect(bare.repo).toBe('r');
    expect(bare.branch).toBe('main');
    expect(bare.providerId).toBe('openai');

    const junk = settingsToForm('nope');
    expect(junk.owner).toBe('');
    expect(junk.branch).toBe('main');
    expect(junk.securityMode).toBe('vault');
    expect(junk.autoLockMinutes).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    // The auth defaults are safe: token mode and an empty local-clone path.
    expect(junk.authMode).toBe('token');
    expect(junk.ssh.host).toBe('github.com');
    expect(junk.ssh.repoRoot).toBe('');
    expect(settingsToForm({ authMode: 'ssh', ssh: { host: '  ', repoRoot: 7 } }).ssh.host).toBe(
      'github.com',
    );
    expect(settingsToForm(null).providerId).toBe('openai');
    expect(settingsToForm({ github: { repo: 7 }, ai: { providerId: '  ' } }).providerId).toBe('openai');
  });
});

describe('save gates and acknowledgements (F8 UNIT)', () => {
  it('TC-F8-U03 blocks the storage section until the probe exists and allows it', () => {
    expect(saveStorageDisabled(null, true)).toBe(true);
    expect(saveStorageDisabled(probe(), false)).toBe(false);
    expect(saveStorageDisabled(probe(), true)).toBe(false);
  });

  it('TC-F8-U03 blocks the storage section on a public repo until acknowledged', () => {
    const publicProbe = probe({ visibility: 'public', canWrite: false, warning: 'public-repo' });
    expect(saveStorageDisabled(publicProbe, false)).toBe(true);
    expect(saveStorageDisabled(publicProbe, true)).toBe(false);
    expect(storageSaveHint(publicProbe, false, 'en')).toBe(t('options.store.ackBlocked', null, 'en'));
    expect(storageSaveHint(publicProbe, true, 'en')).toBe('');
  });

  it('TC-F8-U03 explains every reason the storage save is unavailable', () => {
    expect(storageSaveHint(null, true, 'en')).toBe(t('options.store.testFirst', null, 'en'));
    expect(storageSaveHint(probe({ canPush: false }), true, 'en')).toBe(
      t('options.store.noPush', null, 'en'),
    );
    expect(storageSaveHint(probe(), false, 'en')).toBe('');
  });

  it('TC-F8-U03 requires an explicit trust acknowledgement for a custom endpoint', () => {
    const custom = { providerId: 'custom', model: 'llama-3', baseUrl: 'https://llm.example.com/v1' };
    expect(validateProviderForm(custom, false)).toEqual({
      ok: false,
      issue: 'trust',
      messageKey: 'options.provider.trustRequired',
    });
    expect(saveProviderDisabled(custom, false)).toBe(true);
    expect(saveProviderDisabled(custom, true)).toBe(false);
    // A shipped catalogue host never needs the acknowledgement.
    const catalog = { providerId: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' };
    expect(validateProviderForm(catalog, false).ok).toBe(true);
    expect(saveProviderDisabled(catalog, false)).toBe(false);
  });

  it('TC-F8-U03 refuses to save an invalid, insecure or incomplete provider form', () => {
    expect(validateProviderForm({ providerId: 'openai', model: '   ' }, false)).toEqual({
      ok: false,
      issue: 'model',
      messageKey: 'options.provider.modelRequired',
    });
    expect(validateProviderForm({ providerId: 'custom', model: 'm' }, true)).toEqual({
      ok: false,
      issue: 'base-url',
      messageKey: 'options.provider.baseUrlRequired',
    });
    expect(
      validateProviderForm({ providerId: 'openai', model: 'm', baseUrl: 'http://10.0.0.5/v1' }, true),
    ).toEqual({ ok: false, issue: 'base-url', messageKey: 'options.error.baseUrlInvalid' });
    expect(
      validateProviderForm({ providerId: 'openai', model: 'm', baseUrl: 'not-a-url' }, true).ok,
    ).toBe(false);
    // Loopback http is deliberately allowed (local stubs and bridges).
    expect(
      validateProviderForm({ providerId: 'openai', model: 'm', baseUrl: 'http://127.0.0.1:11434/v1' }, true)
        .ok,
    ).toBe(true);
  });

  it('TC-F8-U03 requires a confirmation before transparent mode', () => {
    expect(transparentModeNeedsConfirm('transparent', false)).toBe(true);
    expect(transparentModeNeedsConfirm('transparent', true)).toBe(false);
    expect(transparentModeNeedsConfirm('vault', false)).toBe(false);
  });
});

describe('provider + vault form helpers (F8 UNIT)', () => {
  it('TC-F8-U03 lists the shipped providers and their model suggestions', () => {
    expect(providerOptions().map((option) => option.value)).toEqual([
      'openai',
      'deepseek',
      'anthropic',
      'openrouter',
      'iflytek',
      'custom',
    ]);
    for (const option of providerOptions()) expect(option.label.length).toBeGreaterThan(0);
    expect(modelSuggestions('anthropic')).toContain('claude-3-5-haiku-latest');
    expect(modelSuggestions('custom')).toEqual([]);
    expect(modelSuggestions('nope')).toEqual([]);
    expect(providerLabel('openai')).toBe('OpenAI');
    expect(providerDefaultBaseUrl('custom')).toBe('');
    expect(providerDefaultBaseUrl('deepseek')).toContain('https://');
  });

  it('TC-F8-U03 derives the runtime host permission for a custom endpoint', () => {
    expect(hostPermissionPattern('https://llm.example.com/v1')).toBe('https://llm.example.com/*');
    expect(hostPermissionPattern('  https://llm.example.com:8443/v1  ')).toBe(
      'https://llm.example.com:8443/*',
    );
    expect(hostPermissionPattern('http://localhost:11434/v1')).toBe('http://localhost:11434/*');
    expect(hostPermissionPattern('not-a-url')).toBeNull();
    expect(hostPermissionPattern('ftp://example.com')).toBeNull();
    expect(hostPermissionPattern('')).toBeNull();
    expect(hostPermissionPattern(null)).toBeNull();
  });

  it('TC-F8-U01 omits blank secrets from the write payloads', () => {
    const github = githubFormOf(settingsToForm({}), '');
    const payload = formToGithubPayload(github);
    expect(payload).toEqual({
      owner: '',
      repo: '',
      branch: 'main',
      pathPrefix: '',
      publicRepoAcknowledged: false,
    });
    expect('pat' in payload).toBe(false);
    expect(payload).not.toHaveProperty('apiBase');

    const typed = formToGithubPayload({
      owner: '  zayeagle ',
      repo: ' kb ',
      branch: '',
      pathPrefix: '',
      pat: ' ghp_token ',
      apiBase: 'https://api.github.com',
      publicRepoAcknowledged: true,
    });
    expect(typed.owner).toBe('zayeagle');
    expect(typed.repo).toBe('kb');
    expect(typed.branch).toBe('main');
    expect(typed.pathPrefix).toBe('');
    expect(typed.pat).toBe('ghp_token');
    expect(typed.apiBase).toBe('https://api.github.com');
    expect(typed.publicRepoAcknowledged).toBe(true);
  });

  it('TC-F8-U01 omits a blank API key and only acks a custom endpoint', () => {
    const kept = formToProviderPayload(providerFormOf(settingsToForm({}), '', false));
    expect('apiKey' in kept).toBe(false);
    expect(kept.baseUrl).toBeUndefined();
    expect(kept.trustAcknowledged).toBeUndefined();

    const saved = formToProviderPayload({
      providerId: 'custom',
      model: ' llama-3 ',
      baseUrl: ' https://llm.example.com/v1 ',
      apiKey: ' sk-new ',
      trustAcknowledged: true,
    });
    expect(saved).toEqual({
      providerId: 'custom',
      model: 'llama-3',
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'sk-new',
      trustAcknowledged: true,
    });
  });

  it('TC-F8-U01 clamps auto-lock and maps the security payload', () => {
    expect(clampAutoLockMinutes(45)).toBe(45);
    expect(clampAutoLockMinutes('15')).toBe(15);
    expect(clampAutoLockMinutes(0)).toBe(MIN_AUTO_LOCK_MINUTES);
    expect(clampAutoLockMinutes(100_000)).toBe(MAX_AUTO_LOCK_MINUTES);
    expect(clampAutoLockMinutes(Number.NaN)).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    // Keep the UI in lockstep with the worker's own bounds.
    expect(MIN_AUTO_LOCK_MINUTES).toBe(STORE_MIN_AUTO_LOCK);
    expect(MAX_AUTO_LOCK_MINUTES).toBe(STORE_MAX_AUTO_LOCK);
    expect(DEFAULT_AUTO_LOCK_MINUTES).toBe(DEFAULT_SETTINGS.autoLockMinutes);
    expect(MIN_PASSPHRASE_CHARS).toBe(MIN_PASSPHRASE_LENGTH);

    const payload = formToSecurityPayload({
      ...settingsToForm({}),
      securityMode: 'transparent',
      autoLockMinutes: 9999,
      aiAuthorized: true,
    });
    expect(payload).toEqual({
      enabled: true,
      aiAuthorized: true,
      securityMode: 'transparent',
      autoLockMinutes: MAX_AUTO_LOCK_MINUTES,
    });
  });

  it('TC-F8-U03 flags a short or missing vault passphrase', () => {
    expect(passphraseTooShort('1234567')).toBe(true);
    expect(passphraseTooShort('12345678')).toBe(false);
    expect(passphraseTooShort('')).toBe(true);
    expect(passphraseTooShort(null)).toBe(true);
    expect(passphraseTooShort(undefined)).toBe(true);
  });
});

describe('capture payload builders (F8 UNIT)', () => {
  it('TC-F8-U01 builds a selection capture payload or nothing at all', () => {
    const payload = selectionCapturePayload(
      'https://example.com/post',
      'A post',
      '  selected text  ',
      'zh-CN',
    );
    expect(payload).toEqual({
      mode: 'selection',
      url: 'https://example.com/post',
      title: 'A post',
      selection: 'selected text',
      lang: 'zh-CN',
    });
    expect(selectionCapturePayload('https://example.com', '', '   ', 'en')).toBeNull();
    expect(selectionCapturePayload('https://example.com', '', 'x')).toEqual({
      mode: 'selection',
      url: 'https://example.com',
      title: 'x',
      selection: 'x',
    });
  });

  it('TC-F8-U01 builds a distill payload only for an actionable Inbox row', () => {
    expect(distillPayloadFor('abc123', 'inbox/2026/07/abc123.md')).toEqual({
      sourceId: 'abc123',
      sourcePath: 'inbox/2026/07/abc123.md',
    });
    expect(distillPayloadFor('', 'inbox/a.md')).toBeNull();
    expect(distillPayloadFor('abc', '')).toBeNull();
    expect(distillPayloadFor(null, null)).toBeNull();
    expect(distillPayloadFor('x'.repeat(80), 'inbox/a.md')?.sourceId.length).toBe(32);
  });

  it('TC-F8-U01 normalises the injected-script return shape', () => {
    expect(firstInjectionResult([{ result: 'selected', frameId: 0, documentId: 'd' }])).toBe('selected');
    expect(firstInjectionResult({ result: 'selected' })).toBe('selected');
    expect(firstInjectionResult([])).toBeUndefined();
    expect(firstInjectionResult([{}])).toBeUndefined();
    expect(firstInjectionResult('nope')).toBeUndefined();
    expect(firstInjectionResult(null)).toBeUndefined();
  });
});

describe('small formatting helpers (F8 UNIT)', () => {
  it('TC-F8-U02 strips control characters and caps every displayed string', () => {
    expect(safeText('  hello  ')).toBe('hello');
    expect(safeText('a\u0000b\nc')).toBe('a b c');
    expect(safeText('x'.repeat(50), 10)).toHaveLength(10);
    expect(safeText('x'.repeat(50), 10).endsWith('…')).toBe(true);
    expect(safeText(42)).toBe('');
    expect(safeText('anything', 0)).toBe('');
  });

  it('TC-F8-U02 formats timestamps deterministically in UTC', () => {
    expect(formatTimestamp('2026-07-09T12:34:56.789Z')).toBe('2026-07-09 12:34 UTC');
    expect(formatTimestamp(Date.UTC(2026, 6, 9, 12, 34, 56))).toBe('2026-07-09 12:34 UTC');
    expect(formatTimestamp('nonsense')).toBe('');
    expect(formatTimestamp(null)).toBe('');
    expect(formatTimestamp({})).toBe('');
    expect(formatTimestamp(Number.NaN)).toBe('');
  });

  it('TC-F8-U02 only opens https URLs in a new tab', () => {
    expect(isSafeExternalUrl('https://github.com/o/r/commit/1')).toBe(true);
    expect(isSafeExternalUrl(' http://github.com/o/r ')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('')).toBe(false);
    expect(isSafeExternalUrl(7)).toBe(false);
  });

  it('TC-F8-U02 derives the repository label from the form', () => {
    expect(repoFullNameOf('zayeagle', 'kb')).toBe('zayeagle/kb');
    expect(repoFullNameOf('zayeagle', '')).toBe('');
    expect(repoFullNameOf('', 'kb')).toBe('');
    expect(repoFullNameOf(null, null)).toBe('');
  });
});

describe('sync + search projections (F5 UNIT)', () => {
  it('TC-F5-U03 reads the sync state and never echoes a raw handler error', () => {
    const view = normalizeSyncStatus({
      head: 'abc123',
      lastSyncAt: '2026-07-09T12:34:56.789Z',
      lastOutcome: 'pulled',
      pending: 3,
      conflicts: ['cards/a.md', 'cards/b.md', 7, ''],
      lastError: 'fatal: not a git repository',
    });
    expect(view.head).toBe('abc123');
    expect(view.lastSyncAt).toBe('2026-07-09 12:34 UTC');
    expect(view.outcome).toBe('pulled');
    expect(view.pending).toBe(3);
    expect(view.conflicts.map((entry) => entry.path)).toEqual(['cards/a.md', 'cards/b.md']);
    expect(JSON.stringify(view)).not.toContain('not a git repository');
    expect(JSON.stringify(view)).not.toMatch(SECRET_LOOKALIKE);
  });

  it('TC-F5-U03 degrades a junk sync reply to "never synced" without throwing', () => {
    for (const junk of [null, undefined, 'nope', 42, []]) {
      const view = normalizeSyncStatus(junk);
      expect(view.outcome).toBe('never');
      expect(view.pending).toBe(0);
      expect(view.conflicts).toEqual([]);
    }
    // An unknown outcome is never rendered as-is.
    expect(normalizeSyncStatus({ lastOutcome: 'kaboom' }).outcome).toBe('never');
    expect(normalizeSyncStatus({ sync: { lastOutcome: 'upToDate' } }).outcome).toBe('upToDate');
    expect(normalizeSyncStatus({ pending: -4 }).pending).toBe(0);
    expect(normalizeSyncStatus({ conflicts: 'a.md' }).conflicts).toEqual([]);
  });

  it('TC-F5-U03 surfaces a sync run result with only counts', () => {
    const run = normalizeSyncResult({ outcome: 'pulled', pulled: 2, pushed: 0, conflicts: ['a.md'] });
    expect(run.outcome).toBe('pulled');
    expect(run.pulled).toBe(2);
    expect(run.conflicts).toBe(1);
    expect(run.upToDate).toBe(false);
    expect(normalizeSyncResult({ outcome: 'upToDate' }).upToDate).toBe(true);
    expect(normalizeSyncResult('nonsense').outcome).toBe('failed');
    expect(normalizeSyncResult(undefined).pulled).toBe(0);
  });

  it('TC-F5-U03 offers all three resolutions for every conflict path', () => {
    // The sibling path and readability travel with the row: without them the surface can only ask for another
    // sync, which is exactly the dead end this projection used to leave the user in.
    const rows = conflictRows([
      { path: 'cards/a.md', conflictPath: 'cards/a.conflict-1.md', readable: true },
      { path: 'cards/b.md', conflictPath: '', readable: false },
    ]);
    expect(rows.map((row) => row.path)).toEqual(['cards/a.md', 'cards/b.md']);
    expect(rows[0]?.conflictPath).toBe('cards/a.conflict-1.md');
    expect(rows[0]?.readable).toBe(true);
    // A reply that did not name the sibling must not have one invented for it.
    expect(rows[1]?.conflictPath).toBe('');
    expect(Object.keys(rows[0] ?? {})).toEqual([
      'path',
      'conflictPath',
      'readable',
      'keepMine',
      'keepTheirs',
      'keepBoth',
    ]);
    expect(rows[0]?.keepMine).toBe(t('options.sync.conflict.keepMine'));
    expect(rows[0]?.keepTheirs).toBe(t('options.sync.conflict.keepTheirs'));
    expect(rows[0]?.keepBoth).toBe(t('options.sync.conflict.keepBoth'));
    expect(conflictRows([], 'en')).toEqual([]);
    expect(conflictChoiceLabel('mine', 'en')).toBe(t('options.sync.conflict.keepMine', null, 'en'));
    expect(conflictChoiceLabel('theirs', 'en')).toBe(t('options.sync.conflict.keepTheirs', null, 'en'));
    expect(conflictChoiceLabel('both', 'en')).toBe(t('options.sync.conflict.keepBoth', null, 'en'));
  });

  it('TC-F5-U04 clamps the sync policy and refuses an unusable interval', () => {
    const payload = syncPolicyPayload({
      intervalMinutes: '45',
      onStartup: true,
      onCapture: false,
      pullOnly: true,
    });
    expect(payload).toEqual({
      intervalMinutes: 45,
      onStartup: true,
      onCapture: false,
      pullOnly: true,
    });
    expect(syncPolicyPayload({ intervalMinutes: 0, onStartup: false, onCapture: false, pullOnly: false })?.intervalMinutes).toBe(0);
    expect(syncPolicyPayload({ intervalMinutes: 'abc', onStartup: false, onCapture: false, pullOnly: false })).toBeNull();
    expect(syncPolicyPayload({ intervalMinutes: -1, onStartup: false, onCapture: false, pullOnly: false })).toBeNull();
    expect(syncPolicyPayload({ intervalMinutes: 99999, onStartup: false, onCapture: false, pullOnly: false })).toBeNull();
  });

  it('TC-F5-U05 projects the branch check through the options form', () => {
    const check = branchCheck({ remoteBranchExists: true }, 'main');
    expect(check.exists).toBe(true);
    const notice = branchCheckNotice(check);
    expect(notice.kind).toBe('ok');
    expect(notice.action).toBe('');
    const missing = branchCheckNotice(branchCheck({ remoteBranchExists: false }, 'release'));
    expect(missing.action).toBe('create');
    expect(missing.actionLabel).toBe(t('options.branch.create'));
  });

  it('TC-F5-U03 whitelists search hits and derives the repository URL itself', () => {
    const view = searchResultRows(
      {
        needsRebuild: false,
        results: [
          {
            id: 'id1',
            path: 'cards/pending/a b.md',
            title: 'A note',
            snippet: 'a snippet with the phrase',
            score: 0.9,
            content: 'PRIVATE BODY',
            url: 'javascript:alert(1)',
          },
          { id: '', path: '', title: '', snippet: '' },
          'junk',
        ],
      },
      { repoFullName: 'zayeagle/kb', branch: 'main' },
    );
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]?.title).toBe('A note');
    expect(view.rows[0]?.url).toBe('https://github.com/zayeagle/kb/blob/main/cards/pending/a%20b.md');
    expect(JSON.stringify(view)).not.toContain('PRIVATE BODY');
    expect(JSON.stringify(view)).not.toContain('javascript:');
    expect(Object.keys(view.rows[0] ?? {})).toEqual(['id', 'path', 'title', 'snippet', 'url']);
  });

  it('TC-F5-U03 accepts a bare hit array, caps the list and drops control characters', () => {
    const bare = searchResultRows(
      Array.from({ length: 20 }, (_unused, index) => ({
        id: `id${index}`,
        path: `inbox/p${index}.md`,
        title: `T${index}\u0000`,
        snippet: 's',
      })),
      { limit: 8 },
    );
    expect(bare.rows).toHaveLength(8);
    expect(bare.rows[0]?.title).toBe('T0');
    expect(searchResultRows(null).rows).toEqual([]);
    expect(searchResultRows('nope').rows).toEqual([]);
    expect(searchResultRows({ needsRebuild: true }).needsRebuild).toBe(true);
    expect(searchResultRows({ needs_rebuild: true }).needsRebuild).toBe(true);
  });

  it('TC-F5-U03 renders the auth and sync rows in the status panel without secrets', () => {
    const panel = statusPanel(
      statusOf(
        {
          authMode: 'ssh',
          branch: 'trunk',
          companion: 'ok',
          sshHost: 'git.example.com',
          sync: { lastSyncAt: '2026-07-09T12:00:00.000Z', lastOutcome: 'pulled', pending: 2, conflicts: 1 },
        },
        probe(),
      ),
      'en',
    );
    expect(panel.auth).toBe(`${t('status.auth.ssh', null, 'en')} · trunk`);
    expect(panel.rows.auth).toBe(panel.auth);
    // `PublicPrefs` carries the ISO instant; the row renders the stored UTC form unchanged.
    expect(panel.sync).toContain('2026-07-09T12:00:00.000Z');
    expect(panel.sync).toContain(t('status.pending', { count: 2 }, 'en'));
    expect(panel.sync).toContain(t('status.conflicts', { count: 1 }, 'en'));
    expect(panel.branch).toBe('trunk');
    expect(panel.authMode).toBe('ssh');
    expect(panel.companion).toBe('ok');
    expect(panel.lastOutcome).toBe(t('options.sync.outcome.pulled', null, 'en'));
    expect(panel.canSync).toBe(true);
    // The SSH host is part of the projection but NOT of any rendered row.
    expect(JSON.stringify({ auth: panel.auth, sync: panel.sync })).not.toContain('git.example.com');
    expect(JSON.stringify(panel)).not.toMatch(SECRET_LOOKALIKE);
  });

  it('TC-F5-U03 shows "never" for a status reply that has no sync block at all', () => {
    const panel = statusPanel(statusOf({}, probe()), 'en');
    expect(panel.sync).toBe(t('options.sync.never', null, 'en'));
    expect(panel.auth).toBe(`${t('status.auth.token', null, 'en')} · main`);
    expect(panel.lastOutcome).toBe(t('options.sync.outcome.never', null, 'en'));
  });
});
