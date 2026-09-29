import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { keyList, ping } from '../src/git.js';
import { createHandler } from '../src/main.js';
import { ERROR_MESSAGES, PROTOCOL_VERSION } from '../src/protocol.js';

let root = '';
let keyDir = '';

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-bridge-git-')));
  keyDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-bridge-keys-')));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(keyDir, { recursive: true, force: true });
});

describe('dispatcher', () => {
  it('TC-F2-U07 an unknown op returns unknownOp and the handler stays usable', async () => {
    const handler = createHandler({ repoRoot: root });

    const rejected = await handler({
      v: PROTOCOL_VERSION,
      id: 'u07-bad',
      op: 'shell.exec',
      cwd: root,
      args: { cmd: 'rm -rf /' },
    });
    expect(rejected).toEqual({
      v: PROTOCOL_VERSION,
      id: 'u07-bad',
      ok: false,
      code: 'unknownOp',
      message: ERROR_MESSAGES.unknownOp,
    });

    // Same handler instance, no reset in between: a bad request must not poison the bridge.
    const stillAlive = await handler({ v: PROTOCOL_VERSION, id: 'u07-ping', op: 'ping' });
    expect(stillAlive.ok).toBe(true);
    if (!stillAlive.ok) throw new Error('expected ping to succeed');
    expect(stillAlive.id).toBe('u07-ping');
    expect(stillAlive.data).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
  });

  it('TC-F2-U09 keyList returns refs only, never key bodies', async () => {
    const rsaBody = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ-secret-material user@example';
    fs.writeFileSync(path.join(keyDir, 'id_rsa.pub'), `${rsaBody}\n`);
    fs.writeFileSync(path.join(keyDir, 'id_ed25519.pub'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5-bytes\n');
    // Present but not a key: must not be listed, and must not be read either.
    fs.writeFileSync(path.join(keyDir, 'known_hosts'), 'github.com ssh-ed25519 AAAAsecret\n');
    fs.writeFileSync(path.join(keyDir, 'config'), 'Host *\n  IdentityFile ~/.ssh/id_rsa\n');

    const data = await keyList(keyDir);

    expect(data.keys.map((key) => key.ref)).toEqual(['id_ed25519', 'id_rsa']);
    expect(data.keys).toEqual([
      { ref: 'id_ed25519', type: 'ed25519' },
      { ref: 'id_rsa', type: 'rsa' },
    ]);

    const serialised = JSON.stringify(data);
    expect(serialised).not.toContain('ssh-rsa AAAA');
    expect(serialised).not.toContain('AAAAB3NzaC1yc2E');
    expect(serialised).not.toContain('user@example');
    expect(serialised).not.toContain('IdentityFile');
  });

  it('a ping succeeds without a repository and reports the git version', async () => {
    const direct = await ping();
    expect(direct.protocolVersion).toBe(1);
    expect(typeof direct.gitVersion).toBe('string');
    expect(direct.gitVersion).toMatch(/^git version \d+\.\d+/);
    expect(direct.platform).toBe(process.platform);
    expect(direct.node).toBe(process.version);

    // No `cwd` at all: ping is the one op that must not need one.
    const handler = createHandler({ repoRoot: root });
    const response = await handler({ v: PROTOCOL_VERSION, id: 'ping-1', op: 'ping' });
    expect(response).toMatchObject({
      v: PROTOCOL_VERSION,
      id: 'ping-1',
      ok: true,
      data: { protocolVersion: 1 },
    });
    if (!response.ok) throw new Error('expected ping to succeed');
    expect(response.data).toMatchObject({ gitVersion: expect.stringMatching(/^git version /) });
  });
});
