/**
 * Tolerant parsing of a chat-completion HTTP body.
 *
 * PURE MODULE: no fetch, no browser APIs — every provider quirk is reproduced from a fixture in
 * `ai-parse.test.ts`. Providers are only *mostly* OpenAI-shaped: gateways wrap the payload in
 * `data`/`result`/`output`/`response`, double-encode it as a JSON string, stream it as SSE `data:`
 * chunks or as NDJSON. One tolerant reader means the client has no per-provider parsing branch.
 *
 * The two failure modes are typed here (not in the client) because this is the module that detects
 * them: `EmptyResponseError` when nothing usable was in the body, `BadJsonError` when the body
 * claimed to be JSON but was not. Both carry the protocol `code`, which is what
 * `lib/background/router.ts` resolves into the user-facing message; they deliberately do not extend
 * the client's `AiError`, because a value-level import the other way would be a cycle.
 */

import type { ErrorCode } from './messages';

/** A runaway reply must not be able to bloat storage — the same cap the UI shows. */
export const MAX_REPLY_CHARS = 8 * 1024;

/** How many wrapper levels (`data.result.output.response…`) are unwrapped before giving up. */
export const MAX_UNWRAP_DEPTH = 4;

export class EmptyResponseError extends Error {
  readonly code: ErrorCode = 'emptyResponse';

  constructor(message = 'ai: the model returned no usable content') {
    super(message);
    this.name = 'EmptyResponseError';
  }
}

export class BadJsonError extends Error {
  readonly code: ErrorCode = 'badJson';

  constructor(message = 'ai: the response body was not valid JSON') {
    super(message);
    this.name = 'BadJsonError';
  }
}

/** Wrapper keys seen in the wild, in the order they are unwrapped. */
const WRAPPER_KEYS = ['data', 'result', 'output', 'response'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `JSON.parse` that answers `undefined` instead of throwing. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A JSON string body may carry the payload; `JSON.parse` of a string yields a string. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

function trimOrNull(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Join non-null fragments, answering `null` when there was nothing at all. */
function mergeTexts(values: ReadonlyArray<string | null>): string | null {
  let found = false;
  let out = '';
  for (const value of values) {
    if (value === null) continue;
    found = true;
    out += value;
  }
  return found ? out : null;
}

/**
 * Whitespace-preserving reader for one field. `''` means "a text field exists but is empty" while
 * `null` means "no text field here at all"; the stream merger needs that distinction to keep a
 * token like `" world"` intact.
 */
function contentToText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    // OpenAI content parts: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }].
    return mergeTexts(value.map((part) => contentToText(part)));
  }
  if (isRecord(value)) {
    const text = value['text'];
    if (typeof text === 'string') return text;
    const content = value['content'];
    if (typeof content === 'string') return content;
  }
  return null;
}

/**
 * Streaming delta, either OpenAI's (`{ content: 'tok' }`) or Anthropic's
 * (`{ type: 'text_delta', text: 'tok' }`). Whitespace is preserved: `' world'` is a real token.
 */
function deltaText(delta: unknown): string | null {
  if (!isRecord(delta)) return null;
  const content = contentToText(delta['content']);
  if (content !== null && !isBlank(content)) return content;
  const text = delta['text'];
  if (typeof text === 'string' && !isBlank(text)) return text;
  return null;
}

/**
 * All the shapes an assistant reply has been observed in, most specific first:
 * `choices[0].message.content` → `choices[0].delta.content` (SSE) → `choices[0].text`
 * (legacy completions) → `content[].text` (Anthropic Messages) → `text` → `output_text`
 * (Responses API) → `output[].content[].text`.
 */
function extractRaw(parsed: unknown): string | null {
  if (typeof parsed === 'string') return parsed;

  if (Array.isArray(parsed)) {
    return mergeTexts(parsed.map((entry) => extractRaw(entry)));
  }

  if (!isRecord(parsed)) return null;

  const choices = parsed['choices'];
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isRecord(choice)) {
        const direct = trimOrNull(contentToText(choice));
        if (direct !== null) return direct;
        continue;
      }
      const message = choice['message'];
      if (isRecord(message)) {
        const text = trimOrNull(contentToText(message['content']));
        if (text !== null) return text;
      }
      const fromDelta = deltaText(choice['delta']);
      if (fromDelta !== null) return fromDelta;
      const choiceText = choice['text'];
      if (typeof choiceText === 'string' && !isBlank(choiceText)) return choiceText;
    }
  }

  // Anthropic streams deltas at the top level, without a `choices` array.
  const topDelta = deltaText(parsed['delta']);
  if (topDelta !== null) return topDelta;

  const content = contentToText(parsed['content']);
  if (content !== null && !isBlank(content)) return content;

  const text = parsed['text'];
  if (typeof text === 'string' && !isBlank(text)) return text;

  const outputText = parsed['output_text'];
  if (typeof outputText === 'string' && !isBlank(outputText)) return outputText;

  const output = parsed['output'];
  if (Array.isArray(output)) {
    const merged = mergeTexts(
      output.map((entry) => (isRecord(entry) ? contentToText(entry['content']) : contentToText(entry))),
    );
    if (merged !== null && !isBlank(merged)) return merged;
  }

  return null;
}

/** Public reader: trimmed, or `null` when the body carried no usable text. */
export function extractAssistantText(parsed: unknown): string | null {
  return trimOrNull(extractRaw(parsed));
}

/** First wrapper value present, so `{ data: { result: … } }` unwraps one level at a time. */
function unwrap(value: unknown): { value: unknown } | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of WRAPPER_KEYS) {
    const nested = value[key];
    if (nested === undefined || nested === null) continue;
    if (typeof nested === 'object' || typeof nested === 'string') return { value: nested };
  }
  return undefined;
}

/** Merge an array of stream records/chunks, tolerating one wrapper level on each element. */
function mergeArray(values: readonly unknown[], depth: number): string | null {
  let found = false;
  let out = '';
  for (const entry of values) {
    let text = extractRaw(entry);
    if (text === null && Array.isArray(entry)) text = mergeArray(entry, depth);
    if (text === null && depth < MAX_UNWRAP_DEPTH) {
      const wrapped = unwrap(entry);
      if (wrapped !== undefined) {
        text = Array.isArray(wrapped.value)
          ? mergeArray(wrapped.value, depth + 1)
          : extractRaw(wrapped.value);
      }
    }
    if (text === null) continue;
    found = true;
    out += text;
  }
  return found ? out : null;
}

interface StreamMerge {
  /** True when at least one line looked like a structured chunk (JSON, `data:` or `[DONE]`). */
  found: boolean;
  text: string;
}

/** SSE (`data: {…}` + `[DONE]`) and NDJSON (`{…}\n{…}`) are the same problem: merge every chunk. */
function mergeStream(body: string): StreamMerge {
  let found = false;
  let out = '';
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let payload = line;
    if (payload.startsWith('data:')) {
      found = true;
      payload = payload.slice(5).trim();
    } else if (payload.startsWith(':')) {
      found = true; // SSE comment/keep-alive
      continue;
    } else if (/^(?:event|id|retry):/u.test(payload)) {
      continue;
    }

    if (payload === '[DONE]') {
      found = true;
      continue;
    }
    if (payload.length === 0) continue;

    const parsed = parseJson(payload);
    if (parsed === undefined) continue; // not a chunk: ignore inside stream mode
    found = true;
    const text = extractRaw(parsed);
    if (text !== null) out += text;
  }
  return { found, text: out };
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function walkText(text: string, depth: number): string {
  const body = stripBom(text);
  if (isBlank(body)) throw new EmptyResponseError();

  // A whole response that is itself JSON (the normal case) — recurse so nested wrappers unwrap.
  const direct = parseJson(body.trim());
  if (direct !== undefined) return walk(direct, depth);

  const stream = mergeStream(body);
  if (stream.found) {
    const merged = stream.text.trim();
    if (merged.length === 0) throw new EmptyResponseError();
    return merged;
  }

  if (looksLikeJson(body) || body.trimStart().startsWith('<')) {
    // JSON that does not parse, or an HTML page from a proxy: never treat it as model output.
    throw new BadJsonError();
  }
  return body.trim();
}

/** Unified walk over strings, arrays and records. Throws when the level yields nothing usable. */
function walk(value: unknown, depth: number): string {
  if (typeof value === 'string') return walkText(value, depth);

  if (Array.isArray(value)) {
    const merged = mergeArray(value, depth);
    const trimmed = trimOrNull(merged);
    if (trimmed !== null) return trimmed;
    throw new EmptyResponseError();
  }

  const extracted = trimOrNull(extractRaw(value));
  if (extracted !== null) return extracted;

  if (depth >= MAX_UNWRAP_DEPTH) throw new EmptyResponseError();
  const nested = unwrap(value);
  if (nested !== undefined) return walk(nested.value, depth + 1);
  throw new EmptyResponseError();
}

/** Truncate a reply to what may be stored. */
export function capReply(text: string): string {
  return text.length > MAX_REPLY_CHARS ? text.slice(0, MAX_REPLY_CHARS) : text;
}

/**
 * Read the assistant text out of anything a provider sent on a 2xx: an already-parsed object, a raw
 * JSON string, an SSE/NDJSON stream or a plain-text body.
 *
 * @throws EmptyResponseError when there is no usable text (including empty `choices`).
 * @throws BadJsonError when the body looks like JSON (or HTML) but cannot be read as such.
 */
export function parseChatCompletion(body: unknown): string {
  return capReply(walk(body, 0));
}
