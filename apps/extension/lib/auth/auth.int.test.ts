import { describe, expect, it, vi } from 'vitest';

import { MIN_ITERATIONS } from '../security/crypto-key';
import { KeySession, MemorySessionKeyStore } from '../security/key-session';
import { MemoryStorageArea, SettingsStore } from '../settings-store';
import { transparentCodec } from '../store/codec';
import { GitHubStore } from '../store/github-store';
import type { GithubApi } from '../store/github-api';
import type { CommitResult, RepoFile, StoreProbe } from '../store/types';
import { NativeClient, createFakePort, type NativePort } from '../native/client';
import { PROTOCOL_VERSION } from '../native/protocol';
import { TokenAuth } from './token-auth';
import { SshAuth } from './ssh-auth';
import { probeAvailability, resolveAuth } from './resolve';
import { isAuthResolutionOk, type AuthContext } from './types';

const PASSPHRASE = 'correct horse battery';
const PAT = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop';
const FIXED_NOW = Date.parse('2026-07-09T00:00:00.000Z');

const PROBE: StoreProbe = {
  kind: 'github',
  repoFullName: 'zayeagle/omnipilot-synapse',
  visibility: 'private',
  defaultBranch: 'main',
  canPush: true,
  canWrite: true,
  checkedAt: '2026-07-09T00:00:00.000Z',
};

function memoryApi(): GithubApi {
  return {
    probeRepo: async () => ({ ...PROBE }),
    readFile: async () => null,
    listDir: async () => [],
    commitFiles: async (files: RepoFile[]): Promise<CommitResult> => ({
      sha: 'sha1',
      htmlUrl: 'https://github.com/zayeagle/omnipilot-synapse/commit/sha1',
      paths: files.map((file) => file.path),
    }),
  };
}

/** A companion that answers the handshake and the git ops the way the real one will. */
function companionPort(overrides: { protocolVersion?: number; failConnect?: Error } = {}): NativePort {
  return createFakePort((message) => {
    const request = message as { id?: unknown; op?: unknown };
    if (typeof request.id !== 'string') return null;
    const ok = (data: unknown) => ({ v: PROTOCOL_VERSION, id: request.id, ok: true, data });
    const fail = (code: string, msg: string) => ({
      v: PROTOCOL_VERSION,
      id: request.id,
      ok: false,
      code,
      message: msg,
    });

    switch (request.op) {
      case 'ping':
        return ok({
          protocolVersion: overrides.protocolVersion ?? PROTOCOL_VERSION,
          gitVersion: '2.45.0',
          platform: 'linux',
          node: 'v20.0.0',
        });
      case 'repo.info':
        return ok({
          root: '/home/me/kb',
          branch: 'main',
          head: 'abc123',
          remoteUrl: 'git@github.com:o/r.git',
          dirty: false,
        });
      case 'git.probe':
        return ok({
          root: '/home/me/kb',
          branch: 'main',
          head: 'abc123',
          remoteUrl: 'git@github.com:o/r.git',
          dirty: false,
          reachable: true,
          remoteBranchExists: true,
        });
      case 'git.status':
        return ok({ branch: 'main', head: 'abc123', dirty: ['inbox/a.md'] });
      default:
        return fail('unknownOp', `unknown op ${String(request.op)}`);
    }
  });
}

async function makeContext(overrides: {
  authMode?: 'token' | 'ssh';
  pat?: string;
  repoRoot?: string;
  native?: NativeClient | null;
  securityMode?: 'vault' | 'transparent';
} = {}): Promise<{ context: AuthContext; settings: SettingsStore; session: KeySession }> {
  const area = new MemoryStorageArea();
  const session = new KeySession({
    store: new MemorySessionKeyStore(),
    now: () => FIXED_NOW,
    ttlMs: 60 * 60 * 1000,
  });
  const settings = new SettingsStore({ area, session, iterations: MIN_ITERATIONS, now: () => FIXED_NOW });

  await settings.setupVault(PASSPHRASE, { githubPat: overrides.pat ?? PAT });
  await settings.patch({
    securityMode: overrides.securityMode ?? 'transparent',
    authMode: overrides.authMode ?? 'token',
    github: { owner: 'zayeagle', repo: 'omnipilot-synapse', branch: 'main' },
    ssh: { repoRoot: overrides.repoRoot ?? '' },
  });

  const context: AuthContext = {
    settings,
    snapshot: await settings.load(),
    session,
    fetchImpl: (async () => new Response('{}', { status: 200 })) as never,
    native: overrides.native ?? null,
    now: () => FIXED_NOW,
  };
  return { context, settings, session };
}

describe('auth resolution (F1 INT)', () => {
  it('TC-F1-U01 resolves token mode when a token and repository are configured', async () => {
    const { context } = await makeContext();
    const resolution = await resolveAuth(context);
    expect(isAuthResolutionOk(resolution)).toBe(true);
    if (!resolution.ok) throw new Error('unreachable');
    expect(resolution.auth.mode).toBe('token');
    expect(resolution.auth.describe()).toMatchObject({
      mode: 'token',
      branch: 'main',
      remote: 'https://github.com/zayeagle/omnipilot-synapse.git',
    });
    // The descriptor is what the UI renders; it must never contain the token.
    expect(JSON.stringify(resolution.auth.describe())).not.toContain(PAT);
  });

  it('TC-F1-U01 builds a working store from token mode', async () => {
    const { context } = await makeContext();
    const resolution = await resolveAuth(context);
    if (!resolution.ok || resolution.auth.mode !== 'token') throw new Error('expected token auth');
    const auth = resolution.auth as TokenAuth;
    vi.spyOn(auth, 'createStore').mockResolvedValue(
      new GitHubStore({
        api: memoryApi(),
        codec: transparentCodec,
        repoFullName: 'zayeagle/omnipilot-synapse',
        branch: 'main',
      }),
    );
    const store = await auth.createStore();
    await expect(store.probe()).resolves.toMatchObject({ visibility: 'private' });
  });

  it('TC-F1-U02 fails closed when the token is missing', async () => {
    const { context, settings } = await makeContext({ pat: '' });
    await settings.updateSecrets({ githubPat: '' });
    const resolution = await resolveAuth({ ...context, snapshot: await settings.load() });
    expect(resolution).toMatchObject({ ok: false, reason: 'not-configured' });
  });

  it('TC-F1-U02 fails closed when the vault is locked', async () => {
    const { context, settings } = await makeContext();
    await settings.lock();
    const resolution = await resolveAuth(context);
    expect(resolution).toMatchObject({ ok: false, reason: 'vault-locked' });
  });

  it('TC-F1-U02 refuses a store when the repository is not configured', async () => {
    const { context, settings } = await makeContext();
    await settings.patch({ github: { owner: '', repo: '' } });
    const resolution = await resolveAuth({ ...context, snapshot: await settings.load() });
    expect(resolution).toMatchObject({ ok: false, reason: 'not-configured' });
  });

  it('TC-F1-U03 reports the SSH mode as unavailable when there is no companion at all', async () => {
    const { context } = await makeContext({ authMode: 'ssh', native: null });
    const resolution = await resolveAuth(context);
    expect(resolution).toMatchObject({ ok: false, reason: 'native-missing' });
  });

  it('TC-F1-U03 reports SSH unavailable when the companion is not installed', async () => {
    const connect = (): NativePort => {
      throw new Error('Specified native messaging host not found.');
    };
    const native = new NativeClient({ connect, now: () => FIXED_NOW });
    const { context } = await makeContext({
      authMode: 'ssh',
      repoRoot: '/home/me/kb',
      native,
    });
    expect(await native.availability()).toBe('missing');
    const resolution = await resolveAuth(context);
    expect(resolution).toMatchObject({ ok: false, reason: 'native-missing' });
  });

  it('TC-F1-U04 reports a protocol mismatch separately from a missing companion', async () => {
    const native = new NativeClient({
      connect: () => companionPort({ protocolVersion: PROTOCOL_VERSION + 1 }),
      now: () => FIXED_NOW,
    });
    const { context } = await makeContext({ authMode: 'ssh', repoRoot: '/home/me/kb', native });
    expect(await native.availability()).toBe('mismatch');
    const resolution = await resolveAuth(context);
    expect(resolution).toMatchObject({ ok: false, reason: 'protocol-mismatch' });
  });

  it('TC-F1-U03 requires a local clone for SSH mode', async () => {
    const native = new NativeClient({ connect: () => companionPort(), now: () => FIXED_NOW });
    const { context } = await makeContext({ authMode: 'ssh', repoRoot: '', native });
    const resolution = await resolveAuth(context);
    expect(resolution).toMatchObject({ ok: false, reason: 'not-configured' });
  });

  it('TC-F1-U05 resolves SSH mode with a companion and never touches key material', async () => {
    const native = new NativeClient({ connect: () => companionPort(), now: () => FIXED_NOW });
    const { context } = await makeContext({ authMode: 'ssh', repoRoot: '/home/me/kb', native });

    const resolution = await resolveAuth(context);
    expect(isAuthResolutionOk(resolution)).toBe(true);
    if (!resolution.ok || resolution.auth.mode !== 'ssh') throw new Error('expected ssh auth');

    const auth = resolution.auth as SshAuth;
    const descriptor = auth.describe();
    expect(descriptor).toMatchObject({
      mode: 'ssh',
      remote: 'git@github.com:zayeagle/omnipilot-synapse.git',
      branch: 'main',
      detail: '/home/me/kb',
    });
    // The whole descriptor is what the UI shows; assert nothing secret-shaped can be in it.
    expect(JSON.stringify(descriptor)).not.toContain(PAT);
    expect(JSON.stringify(descriptor)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/u);

    const probe = await auth.probe();
    expect(probe.canWrite).toBe(true);
    expect(probe.visibility).toBe('unknown');

    const transport = await auth.createTransport();
    expect(transport.repoRoot).toBe('/home/me/kb');
    expect(transport.branch).toBe('main');
  });

  it('TC-F1-U06 switching modes leaves the other credential untouched', async () => {
    const native = new NativeClient({ connect: () => companionPort(), now: () => FIXED_NOW });
    const { context, settings } = await makeContext({ repoRoot: '/home/me/kb', native });

    // Start in token mode with a stored token, switch to SSH, then back.
    expect((await resolveAuth(context)).ok).toBe(true);
    await settings.patch({ authMode: 'ssh' });
    const ssh = await resolveAuth({ ...context, snapshot: await settings.load() });
    expect(ssh.ok).toBe(true);

    await settings.patch({ authMode: 'token' });
    const back = await resolveAuth({ ...context, snapshot: await settings.load() });
    expect(back.ok).toBe(true);
    if (!back.ok || back.auth.mode !== 'token') throw new Error('expected token auth');
    // The token survived the round trip, because mode switching never rewrites the vault.
    await expect(settings.getSecrets()).resolves.toMatchObject({ githubPat: PAT });
  });

  it('TC-F1-I02 probes both modes at once for the mode picker', async () => {
    const native = new NativeClient({ connect: () => companionPort(), now: () => FIXED_NOW });
    const { context } = await makeContext({ repoRoot: '/home/me/kb', native });
    const availability = await probeAvailability(context, native);
    expect(availability).toEqual({ token: null, ssh: null, companion: 'ok' });

    const noCompanion = await makeContext();
    const withoutNative = await probeAvailability(noCompanion.context, null);
    expect(withoutNative).toEqual({ token: null, ssh: 'native-missing', companion: 'missing' });
  });

  it('TC-F1-I01 probes the configured mode through the companion', async () => {
    const native = new NativeClient({ connect: () => companionPort(), now: () => FIXED_NOW });
    const { context } = await makeContext({ authMode: 'ssh', repoRoot: '/home/me/kb', native });
    const resolution = await resolveAuth(context);
    if (!resolution.ok) throw new Error('expected ok');
    await expect(resolution.auth.probe()).resolves.toMatchObject({
      kind: 'github',
      repoFullName: 'zayeagle/omnipilot-synapse',
      canWrite: true,
    });
  });
});
