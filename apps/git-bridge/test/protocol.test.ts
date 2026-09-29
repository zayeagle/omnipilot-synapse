import { describe, expect, it } from 'vitest';
import {
  ALLOWED_OPS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  parseRequest,
  type NativeRequest,
} from '../src/protocol.js';

function lengthPrefix(bytes: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes, 0);
  return header;
}

function frameOf(body: Buffer): Buffer {
  return Buffer.concat([lengthPrefix(body.length), body]);
}

/** A syntactically valid JSON payload of exactly `size` bytes. */
function jsonOfSize(size: number): Buffer {
  const prefix = '{"v":1,"pad":"';
  const suffix = '"}';
  const fill = 'x'.repeat(size - prefix.length - suffix.length);
  return Buffer.from(`${prefix}${fill}${suffix}`, 'utf8');
}

describe('native messaging framing', () => {
  it('TC-F2-U01 a valid frame decodes to the request', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    // 8 original ops + the 3 content-channel ops added 2026-09-29 (F2).
    expect(ALLOWED_OPS).toHaveLength(11);
    expect(ALLOWED_OPS).toEqual([
      'ping',
      'repo.info',
      'git.probe',
      'git.status',
      'git.fetch',
      'git.show',
      'git.ls',
      'git.write',
      'git.commit',
      'git.push',
      'key.list',
    ]);

    const request: NativeRequest = {
      v: 1,
      id: 'r-1',
      op: 'git.status',
      cwd: 'C:/work/repo',
      args: { note: 'ticket F2' },
    };
    const frame = encodeFrame(request);

    // 4-byte little-endian length prefix, then the payload.
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
    expect(frame.subarray(4).toString('utf8')).toBe(JSON.stringify(request));

    const decoded = decodeFrame(frame);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error('expected a decoded frame');
    expect(decoded.consumed).toBe(frame.length);
    expect(decoded.value).toEqual(request);

    const parsed = parseRequest(decoded.value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected a parsed request');
    expect(parsed.request).toEqual(request);
  });

  it('TC-F2-U02 a frame exactly at the cap is accepted and one byte over is frameTooLarge', () => {
    const atCap = jsonOfSize(MAX_FRAME_BYTES);
    expect(atCap.length).toBe(MAX_FRAME_BYTES);
    const frame = frameOf(atCap);
    expect(frame.length).toBe(MAX_FRAME_BYTES + 4);

    const decoded = decodeFrame(frame);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error('expected the cap-sized frame to decode');
    expect(decoded.consumed).toBe(MAX_FRAME_BYTES + 4);

    const overCap = decodeFrame(frameOf(jsonOfSize(MAX_FRAME_BYTES + 1)));
    expect(overCap).toMatchObject({ ok: false, code: 'frameTooLarge' });

    // The declared length is judged before the payload is read, so an oversize frame is rejected
    // without ever buffering it.
    const headerOnly = decodeFrame(lengthPrefix(MAX_FRAME_BYTES + 1));
    expect(headerOnly).toMatchObject({ ok: false, code: 'frameTooLarge' });
  });

  it('TC-F2-U10 a truncated length prefix is a clean badRequest with no throw', () => {
    expect(() => decodeFrame(Buffer.alloc(0))).not.toThrow();
    expect(decodeFrame(Buffer.alloc(0))).toMatchObject({ ok: false, code: 'badRequest', needed: 4 });

    const twoBytes = Buffer.from([0x40, 0x00]);
    expect(() => decodeFrame(twoBytes)).not.toThrow();
    expect(decodeFrame(twoBytes)).toMatchObject({ ok: false, code: 'badRequest', needed: 4 });

    // A complete prefix whose payload has not arrived yet: badRequest, and `needed` tells the reader
    // to keep buffering rather than to give up on the stream.
    const truncated = Buffer.concat([lengthPrefix(100), Buffer.from('{"v":1', 'utf8')]);
    expect(decodeFrame(truncated)).toMatchObject({ ok: false, code: 'badRequest', needed: 104 });

    // A complete frame that is not JSON is dropped, not thrown.
    const garbage = frameOf(Buffer.from('not json at all', 'utf8'));
    expect(decodeFrame(garbage)).toMatchObject({ ok: false, code: 'badRequest', needed: garbage.length });
  });
});
