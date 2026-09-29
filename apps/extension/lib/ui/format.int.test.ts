import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  fail,
  isExtensionResponse,
  ok,
  type ExtensionResponse,
  type GithubSettingsPayload,
} from '../messages';
import { DEFAULT_PUBLIC_PREFS, type PublicPrefs } from '../public-prefs';
import type { RepoVisibility, StoreProbe } from '../store/types';
import {
  formToGithubPayload,
  githubFormOf,
  normalizeStatusPayload,
  saveStorageDisabled,
  settingsToForm,
  statusPanel,
  storageSaveHint,
} from './format';

/**
 * TC-F8-I01 — the settings-save → status round trip, at the message boundary.
 *
 * The worker does not exist yet (it is being written in parallel), so the test drives a small
 * in-test stub through a mocked `runtime.sendMessage`. What makes this an integration test rather
 * than a unit test is that every assertion crosses the message boundary: a real payload is built by
 * `lib/ui/format.ts`, serialised, routed and read back through `status.get`.
 *
 * The load-bearing claim is the last one: from the moment the token is in the vault, NO message the
 * options page sends or receives ever carries it again — the form is populated from the export
 * projection, and an untouched key field is omitted rather than echoed.
 */

const STORED_PAT = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop';
const STORED_KEY = 'sk-abcdefghijklmnopqrstuvwxyz';
const NEW_PAT = 'github_pat_11ZYXWVUT0987654321_ponmlkjihgfedcba';
const SECRETS = [STORED_PAT, STORED_KEY, NEW_PAT];

interface WorkerState {
  owner: string;
  repo: string;
  branch: string;
  pathPrefix: string;
  apiBase: string;
  publicRepoAcknowledged: boolean;
  visibility: RepoVisibility;
  canPush: boolean;
  unlocked: boolean;
  secrets: { githubPat: string; providerKey: string };
}

interface Transcript {
  state: WorkerState;
  requests: Array<{ type: string; payload: unknown }>;
  responses: Array<{ type: string; response: unknown }>;
  route(message: unknown): Promise<ExtensionResponse>;
}

function createWorkerStub(overrides: Partial<WorkerState> = {}): Transcript {
  const state: WorkerState = {
    owner: 'zayeagle',
    repo: 'old-kb',
    branch: 'main',
    pathPrefix: '',
    apiBase: 'https://api.github.com',
    publicRepoAcknowledged: false,
    visibility: 'public',
    canPush: true,
    unlocked: true,
    secrets: { githubPat: STORED_PAT, providerKey: STORED_KEY },
    ...overrides,
  };
  const requests: Transcript['requests'] = [];
  const responses: Transcript['responses'] = [];

  function prefs(): PublicPrefs {
    return {
      ...DEFAULT_PUBLIC_PREFS,
      repoFullName: state.owner && state.repo ? `${state.owner}/${state.repo}` : '',
      securityMode: 'vault',
      hasPat: state.secrets.githubPat.length > 0,
      hasKey: state.secrets.providerKey.length > 0,
      vaultLocked: !state.unlocked,
    };
  }

  function probe(): StoreProbe {
    const acknowledged = state.publicRepoAcknowledged;
    const canWrite = state.canPush && (state.visibility !== 'public' || acknowledged);
    const result: StoreProbe = {
      kind: 'github',
      repoFullName: `${state.owner}/${state.repo}`,
      visibility: state.visibility,
      defaultBranch: state.branch,
      canPush: state.canPush,
      canWrite,
      checkedAt: '2026-07-09T10:00:00.000Z',
    };
    if (state.visibility === 'public' && !acknowledged) result.warning = 'public-repo';
    return result;
  }

  async function route(message: unknown): Promise<ExtensionResponse> {
    if (typeof message !== 'object' || message === null) return fail('bad request', 'validation');
    const request = message as { type?: unknown; payload?: unknown };
    const type = typeof request.type === 'string' ? request.type : '';
    requests.push({ type, payload: request.payload });

    switch (type) {
      case 'settings.github': {
        const payload = (request.payload ?? {}) as GithubSettingsPayload;
        const pat = typeof payload.pat === 'string' ? payload.pat : '';
        state.owner = typeof payload.owner === 'string' ? payload.owner : state.owner;
        state.repo = typeof payload.repo === 'string' ? payload.repo : state.repo;
        state.branch = typeof payload.branch === 'string' ? payload.branch : state.branch;
        state.pathPrefix = typeof payload.pathPrefix === 'string' ? payload.pathPrefix : state.pathPrefix;
        if (typeof payload.apiBase === 'string' && payload.apiBase.length > 0) {
          state.apiBase = payload.apiBase;
        }
        state.publicRepoAcknowledged = payload.publicRepoAcknowledged === true;
        // "Omitted means keep" — the vault keeps the stored token when the field was untouched.
        if (pat.length > 0) state.secrets.githubPat = pat;
        return ok(prefs());
      }
      case 'status.get':
        return ok({ prefs: prefs(), probe: probe(), vault: vaultStatus() });
      case 'settings.export':
        return ok({
          exportedAt: '2026-07-09T00:00:00.000Z',
          settings: {
            enabled: true,
            aiAuthorized: false,
            securityMode: 'vault',
            autoLockMinutes: 30,
            github: {
              owner: state.owner,
              repo: state.repo,
              branch: state.branch,
              pathPrefix: state.pathPrefix,
              apiBase: state.apiBase,
              publicRepoAcknowledged: state.publicRepoAcknowledged,
            },
            ai: { providerId: 'openai', model: 'gpt-4o-mini', baseUrl: '' },
          },
          secretsPresent: {
            githubPat: state.secrets.githubPat.length > 0,
            providerKey: state.secrets.providerKey.length > 0,
          },
        });
      default:
        return fail(`no handler registered for ${type}`, 'validation');
    }
  }

  function vaultStatus(): { configured: boolean; unlocked: boolean; expiresAt: number | null; remainingMs: number } {
    return {
      configured: true,
      unlocked: state.unlocked,
      expiresAt: state.unlocked ? 1_800_000_000_000 : null,
      remainingMs: state.unlocked ? 600_000 : 0,
    };
  }

  return { state, requests, responses, route };
}

type SendMessage = (message: { type: string; payload?: unknown }) => Promise<unknown>;

function createBoundary(stub: Transcript): {
  send: (type: string, payload?: unknown) => Promise<ExtensionResponse>;
  sendMessage: Mock<SendMessage>;
} {
  const sendMessage = vi.fn<SendMessage>(async (message: { type: string; payload?: unknown }) => {
    const response = await stub.route(message);
    stub.responses.push({ type: message.type, response });
    return response;
  });
  const send = async (type: string, payload?: unknown): Promise<ExtensionResponse> => {
    const raw: unknown = await sendMessage(payload === undefined ? { type } : { type, payload });
    if (!isExtensionResponse(raw)) throw new Error(`worker replied with a non-response for ${type}`);
    return raw;
  };
  return { send, sendMessage };
}

function expectNoSecret(serialized: string): void {
  for (const secret of SECRETS) expect(serialized).not.toContain(secret);
  expect(serialized).not.toMatch(/github_pat_|sk-/u);
}

describe('settings save → status boundary (F8 INT)', () => {
  it('TC-F8-I01 reflects the saved repo and visibility without echoing the stored token', async () => {
    const stub = createWorkerStub();
    const { send, sendMessage } = createBoundary(stub);

    // 1. The options page populates the 存储 form from the export projection.
    const exported = await send('settings.export');
    expect(exported.ok).toBe(true);
    const form = settingsToForm(exported.ok ? exported.data : null);
    expect(form.owner).toBe('zayeagle');
    expect(form.repo).toBe('old-kb');
    expect(form.branch).toBe('main');
    // The export reports presence, never a value.
    expect(JSON.stringify(form)).not.toContain(STORED_PAT);

    // 2. The user edits the repository and saves. The key field was never refilled, so it is omitted.
    const nextForm = { ...form, repo: 'kb', pathPrefix: 'private/kb' };
    const payload = formToGithubPayload(githubFormOf(nextForm, ''));
    expect('pat' in payload).toBe(false);
    expect(payload.apiBase).toBe('https://api.github.com');
    expect(JSON.stringify(payload)).not.toMatch(/github_pat_|sk-/u);

    const saved = await send('settings.github', payload);
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error('settings.github failed');
    expect((saved.data as PublicPrefs).repoFullName).toBe('zayeagle/kb');

    // 3. Read the status back: the repo, the visibility and the still-present token are reflected.
    const status = await send('status.get');
    expect(status.ok).toBe(true);
    const normalized = normalizeStatusPayload(status.ok ? status.data : null);
    expect(normalized.prefs.repoFullName).toBe('zayeagle/kb');
    // Presence survived a save that never carried the token.
    expect(normalized.prefs.hasPat).toBe(true);
    expect(normalized.prefs.vaultLocked).toBe(false);
    expect(normalized.probe?.repoFullName).toBe('zayeagle/kb');
    expect(normalized.probe?.visibility).toBe('public');

    // 4. The popup surface derived from that reply.
    const panel = statusPanel(status.ok ? status.data : null);
    expect(panel.rows.repo).toBe('zayeagle/kb');
    expect(panel.publicWarning).toBe(true);
    expect(panel.visibility).toBe('public');
    expect(panel.canClip).toBe(false);
    expect(normalized.probe).not.toBeNull();
    if (normalized.probe) {
      expect(saveStorageDisabled(normalized.probe, false)).toBe(true);
      expect(storageSaveHint(normalized.probe, false).length).toBeGreaterThan(0);
      expect(saveStorageDisabled(normalized.probe, true)).toBe(false);
    }

    // 5. Not one byte of the transcript carries a credential.
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expectNoSecret(JSON.stringify(stub.requests));
    expectNoSecret(JSON.stringify(stub.responses));
  });

  it('TC-F8-I01 sends a typed token exactly once and never in a projection', async () => {
    const stub = createWorkerStub({ visibility: 'private', repo: 'kb' });
    const { send } = createBoundary(stub);

    const saved = await send(
      'settings.github',
      formToGithubPayload({
        owner: 'zayeagle',
        repo: 'kb',
        branch: 'main',
        pathPrefix: '',
        pat: NEW_PAT,
        apiBase: '',
        publicRepoAcknowledged: false,
      }),
    );
    expect(saved.ok).toBe(true);
    expect(stub.state.secrets.githubPat).toBe(NEW_PAT);

    const status = await send('status.get');
    expect(status.ok).toBe(true);

    const withToken = stub.requests.filter((entry) => JSON.stringify(entry).includes(NEW_PAT));
    expect(withToken).toHaveLength(1);
    expect(withToken[0]?.type).toBe('settings.github');
    // The write is the only place it may appear — every other request and reply is secret-free.
    expectNoSecret(
      JSON.stringify([...stub.requests.filter((entry) => entry.type !== 'settings.github'), ...stub.responses]),
    );
    // The projection only ever says "a token exists".
    expect(normalizeStatusPayload(status.ok ? status.data : null).prefs.hasPat).toBe(true);
  });

  it('TC-F8-I01 unblocks saving once a public repository is acknowledged', async () => {
    const stub = createWorkerStub();
    const { send, sendMessage } = createBoundary(stub);

    const before = await send('status.get');
    const blocked = normalizeStatusPayload(before.ok ? before.data : null);
    expect(blocked.probe?.canWrite).toBe(false);
    expect(blocked.probe?.warning).toBe('public-repo');

    // The acknowledgement travels with the save and is the only thing that changes.
    const payload = formToGithubPayload({
      owner: 'zayeagle',
      repo: 'kb',
      branch: 'main',
      pathPrefix: '',
      pat: '',
      apiBase: '',
      publicRepoAcknowledged: true,
    });
    expect(payload.publicRepoAcknowledged).toBe(true);
    expect((await send('settings.github', payload)).ok).toBe(true);

    const after = await send('status.get');
    expect(after.ok).toBe(true);
    const panel = statusPanel(after.ok ? after.data : null);
    expect(panel.publicWarning).toBe(true);
    expect(panel.canClip).toBe(true);
    expect(normalizeStatusPayload(after.ok ? after.data : null).probe?.canWrite).toBe(true);

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expectNoSecret(JSON.stringify(stub.responses));
  });

  it('TC-F8-I01 reports a rejected save through the error classifier, not a raw message', async () => {
    const stub = createWorkerStub();
    const { send } = createBoundary(stub);
    // A section that was never probed cannot be saved, and the hint says what to do.
    expect(saveStorageDisabled(null, true)).toBe(true);
    expect(storageSaveHint(null, true).length).toBeGreaterThan(0);
    // An unknown request type is answered with a typed failure the UI can classify.
    const response = await send('settings.nope');
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected a failure');
    expect(response.code).toBe('validation');
    expect(JSON.stringify(response)).not.toContain(STORED_PAT);
  });
});
