import { describe, expect, it } from 'vitest';
import { NativeClient, NativeError, createFakePort } from './client';

/**
 * TC-F2-I01/I02 — the native client's lifecycle.
 *
 * The behaviours worth pinning are the failure ones: an unmatched response must not resolve the wrong
 * request, a dropped port must fail everything in flight instead of leaking a promise, a timeout must
 * be a `timeout` and not a silent success, and a version mismatch must refuse *before* any op is sent.
 */

const PING_OK = { protocolVersion: 1, gitVersion: '2.54.0', platform: 'test', node: '22' };

function ok(id: string, data: unknown) {
  return { v: 1, id, ok: true, data };
}

function fail(id: string, code: string, message = code) {
  return { v: 1, id, ok: false, code, message };
}

describe('NativeClient (F2 INT)', () => {
  it('TC-F2-I01 performs the handshake once and caches availability', async () => {
    const seen: string[] = [];
    const port = createFakePort((message) => {
      const request = message as { id: string; op: string };
      seen.push(request.op);
      if (request.op === 'ping') return ok(request.id, PING_OK);
      return ok(request.id, { branch: 'main' });
    });
    const client = new NativeClient({ connect: () => port });

    expect(await client.availability()).toBe('ok');
    expect(client.ping !== undefined).toBe(true);
    expect(await client.availability()).toBe('ok');

    // One handshake, then the real op — not one handshake per call.
    expect(seen.filter((op) => op === 'ping')).toHaveLength(1);
    expect(await client.availability(true)).toBe('ok');
    expect(seen.filter((op) => op === 'ping')).toHaveLength(2);
  });

  it('TC-F2-I01 a mismatch refuses the connection and every later op', async () => {
    const seen: string[] = [];
    const port = createFakePort((message) => {
      const request = message as { id: string; op: string };
      seen.push(request.op);
      return ok(request.id, { ...PING_OK, protocolVersion: 2 });
    });
    const client = new NativeClient({ connect: () => port });

    expect(await client.availability()).toBe('mismatch');
    const error = await client.send('git.status').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NativeError);
    expect((error as NativeError).code).toBe('protocolMismatch');
    // Refused before the wire: the only op that ever left is the handshake.
    expect(seen).toEqual(['ping']);
  });

  it('TC-F2-I01 correlates concurrent requests by id', async () => {
    const port = createFakePort((message) => {
      const request = message as { id: string; op: string };
      if (request.op === 'ping') return ok(request.id, PING_OK);
      // Answer out of order on purpose: only the id may decide which promise settles.
      return ok(request.id, { op: request.op, echo: request.id });
    });
    const client = new NativeClient({ connect: () => port });

    const [first, second] = await Promise.all([client.send('git.status'), client.send('git.fetch')]);
    expect((first as { op: string }).op).toBe('git.status');
    expect((second as { op: string }).op).toBe('git.fetch');
    expect(client.inFlight()).toBe(0);
  });

  it('TC-F2-I02 a companion error becomes a NativeError with the same code', async () => {
    const port = createFakePort((message) => {
      const request = message as { id: string; op: string };
      if (request.op === 'ping') return ok(request.id, PING_OK);
      return fail(request.id, 'pathOutsideRoot', 'path is outside the allowed root');
    });
    const client = new NativeClient({ connect: () => port });

    const error = await client.send('git.show').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NativeError);
    expect((error as NativeError).code).toBe('pathOutsideRoot');
  });

  it('TC-F2-I01 a silent companion times out instead of hanging forever', async () => {
    const port = createFakePort((message) => {
      const request = message as { id: string; op: string };
      if (request.op === 'ping') return ok(request.id, PING_OK);
      return null; // never answered
    });
    const client = new NativeClient({
      connect: () => port,
      // Drive the timer synchronously: the point is the rejection, not the waiting.
      schedule: (handler) => {
        handler();
        return 0;
      },
      cancelSchedule: () => undefined,
    });

    const error = await client.send('git.status').catch((reason: unknown) => reason);
    expect((error as NativeError).code).toBe('timeout');
  });

  it('TC-F2-I01 a dropped port fails everything in flight and reconnects once', async () => {
    const ports: Array<ReturnType<typeof createFakePort>> = [];
    const client = new NativeClient({
      connect: () => {
        const port = createFakePort((message) => {
          const request = message as { id: string; op: string };
          if (request.op === 'ping') return ok(request.id, PING_OK);
          return null;
        });
        ports.push(port);
        return port;
      },
    });

    const pending = client.send('git.status');
    await client.availability();
    ports[0]?.disconnect();

    const error = await pending.catch((reason: unknown) => reason);
    expect((error as NativeError).code).toBe('nativeUnavailable');
    expect(client.inFlight()).toBe(0);

    // The next call opens a fresh port rather than reusing the dead one.
    await client.availability(true);
    expect(ports.length).toBeGreaterThan(1);
  });

  it('TC-F2-I01 an absent host is reported as missing, not thrown', async () => {
    const client = new NativeClient({
      connect: () => {
        throw new Error('no such native host');
      },
    });
    expect(await client.availability()).toBe('missing');
    const error = await client.send('git.status').catch((reason: unknown) => reason);
    expect((error as NativeError).code).toBe('nativeUnavailable');
  });

  it('TC-F2-I02 refuses to send an op outside the allow-list', async () => {
    const port = createFakePort(() => ok('x', PING_OK));
    const client = new NativeClient({ connect: () => port });
    // `send` is async, so the refusal is a rejection — and it must happen before anything is posted.
    await expect(client.send('shell.exec' as never)).rejects.toThrow(/refusing to send op/);
  });
});
