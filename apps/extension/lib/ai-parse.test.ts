import { describe, expect, it } from 'vitest';

import {
  BadJsonError,
  EmptyResponseError,
  MAX_REPLY_CHARS,
  MAX_UNWRAP_DEPTH,
  capReply,
  extractAssistantText,
  parseChatCompletion,
} from './ai-parse';

const openaiReply = { choices: [{ message: { role: 'assistant', content: 'nested ok' } }] };

function caught(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

describe('parseChatCompletion — nested bodies (F5 UNIT)', () => {
  it('TC-F5-U03 unwraps data.result.output.response down to the payload', () => {
    expect(parseChatCompletion({ data: { result: { output: { response: openaiReply } } } })).toBe(
      'nested ok',
    );
    expect(MAX_UNWRAP_DEPTH).toBe(4);
  });

  it('TC-F5-U03 unwraps shallower nests and double-encoded JSON strings', () => {
    expect(parseChatCompletion({ data: { result: openaiReply } })).toBe('nested ok');
    expect(parseChatCompletion({ data: JSON.stringify(openaiReply) })).toBe('nested ok');
    expect(parseChatCompletion(JSON.stringify({ result: openaiReply }))).toBe('nested ok');
  });

  it('TC-F5-U03 gives up beyond four wrapper levels instead of recursing forever', () => {
    const tooDeep = { data: { result: { output: { response: { payload: openaiReply } } } } };
    expect(caught(() => parseChatCompletion(tooDeep))).toBeInstanceOf(EmptyResponseError);
  });

  it('TC-F5-U03 finds the reply in every shape it has been observed in', () => {
    expect(extractAssistantText({ choices: [{ message: { content: 'message' } }] })).toBe('message');
    expect(extractAssistantText({ choices: [{ text: 'legacy' }] })).toBe('legacy');
    expect(extractAssistantText({ content: [{ type: 'text', text: 'anthropic' }] })).toBe(
      'anthropic',
    );
    expect(extractAssistantText({ text: 'plain field' })).toBe('plain field');
    expect(extractAssistantText({ output_text: 'responses api' })).toBe('responses api');
    expect(
      extractAssistantText({ choices: [{ message: { content: [{ type: 'text', text: 'parts' }] } }] }),
    ).toBe('parts');

    expect(extractAssistantText({ choices: [] })).toBeNull();
    expect(extractAssistantText({ nothing: true })).toBeNull();
    expect(extractAssistantText('   ')).toBeNull();
  });
});

describe('parseChatCompletion — streams (F5 UNIT)', () => {
  it('TC-F5-U04 merges SSE data: chunks into one contiguous reply', () => {
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"lo "}}]}',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    expect(parseChatCompletion(sse)).toBe('Hello world');
  });

  it('TC-F5-U04 merges NDJSON lines and a JSON array of chunks', () => {
    const ndjson = [
      '{"choices":[{"message":{"content":"Evi"}}]}',
      '{"choices":[{"message":{"content":"dence"}}]}',
    ].join('\n');
    expect(parseChatCompletion(ndjson)).toBe('Evidence');

    expect(
      parseChatCompletion([
        { choices: [{ delta: { content: 'aa' } }] },
        { choices: [{ delta: { content: 'bb' } }] },
      ]),
    ).toBe('aabb');
  });

  it('TC-F5-U04 merges Anthropic-style streaming events', () => {
    const anthropicSse = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"an"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"thropic"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
    ].join('\n');
    expect(parseChatCompletion(anthropicSse)).toBe('anthropic');
  });
});

describe('parseChatCompletion — degenerate bodies (F5 UNIT)', () => {
  it('TC-F5-U05 throws a typed EmptyResponseError for empty choices, without crashing', () => {
    const error = caught(() => parseChatCompletion({ choices: [] }));
    expect(error).toBeInstanceOf(EmptyResponseError);
    expect((error as EmptyResponseError).code).toBe('emptyResponse');
    expect((error as EmptyResponseError).name).toBe('EmptyResponseError');
  });

  it('TC-F5-U05 treats empty text, empty content arrays and blank bodies as empty', () => {
    const empty = [
      { choices: [{ message: { role: 'assistant', content: '' } }] },
      { choices: [{ message: {} }] },
      { choices: [{ text: '   ' }] },
      { content: [] },
      { nothing: true },
      {},
      [],
      null,
      undefined,
      '',
      '   ',
      'data: [DONE]',
    ];
    for (const body of empty) {
      expect(caught(() => parseChatCompletion(body)), JSON.stringify(body) ?? 'undefined').toBeInstanceOf(
        EmptyResponseError,
      );
    }
  });

  it('TC-F5-U05 refuses HTML and broken JSON instead of storing them as a reply', () => {
    for (const body of ['<html><body>504 Gateway Timeout</body></html>', '{"choices":[', '[1,2']) {
      expect(caught(() => parseChatCompletion(body)), body).toBeInstanceOf(BadJsonError);
    }
    expect((caught(() => parseChatCompletion('<html>')) as BadJsonError).code).toBe('badJson');
  });

  it('TC-F5-U05 caps a runaway reply at 8 KB', () => {
    expect(MAX_REPLY_CHARS).toBe(8 * 1024);
    const huge = parseChatCompletion({ choices: [{ message: { content: 'x'.repeat(50_000) } }] });
    expect(huge).toHaveLength(MAX_REPLY_CHARS);
    expect(capReply('short')).toBe('short');
    expect(capReply('y'.repeat(MAX_REPLY_CHARS + 1))).toHaveLength(MAX_REPLY_CHARS);
  });

  it('TC-F5-U05 keeps a plain-text body, BOM included, as the reply', () => {
    expect(parseChatCompletion('\uFEFFplain text reply')).toBe('plain text reply');
    expect(parseChatCompletion('line one\nline two')).toBe('line one\nline two');
  });
});
