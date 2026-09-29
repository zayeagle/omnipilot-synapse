/**
 * Body normalisation and the 512 KB cap — F1 step 5.
 *
 * Pure module with no DOM, storage or `Buffer` dependency: the extension runs in a browser and a
 * content script may not have Node built-ins, so `TextEncoder` is the one UTF-8 primitive shared by
 * every context. It is also the single place where an extraction result becomes a CKF `SourceItem`,
 * so the cap, the `truncated` flag and `original_bytes` can never disagree with each other.
 */

import {
  newSourceItem,
  type ExtractionQuality,
  type SourceChannel,
  type SourceItem,
} from '../core/ckf';

/** 512 KB of UTF-8 body text. Beyond this the stored body is cut and marked `truncated`. */
export const MAX_BODY_BYTES = 512 * 1024;

const encoder = new TextEncoder();

/** UTF-8 width of a code point, without allocating an encoder buffer per character. */
function utf8Width(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** UTF-8 byte length of `text`. */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Collapse cosmetic whitespace while keeping the prose shape: runs of horizontal whitespace become
 * one space, every run of blank lines becomes a single paragraph break (`\n\n`), and the result is
 * trimmed. Non-breaking and ideographic spaces count as whitespace — news sites emit them freely.
 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

/**
 * Cut `text` to at most `maxBytes` of UTF-8, on a code point boundary.
 *
 * The cut is measured while walking code points rather than by slicing bytes, so a multi-byte
 * character or a surrogate pair is never split — a half-encoded emoji would otherwise be persisted
 * as a replacement character and silently corrupt the body. `originalBytes` always reports the size
 * of the input, not of the cut, so the store can tell how much was dropped.
 */
export function truncateBody(text: string, maxBytes: number = MAX_BODY_BYTES): TruncateResult {
  const originalBytes = byteLength(text);
  if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes };
  if (maxBytes <= 0) return { text: '', truncated: true, originalBytes };

  let bytes = 0;
  let cutAt = 0; // index in UTF-16 code units, always on a code point boundary
  for (const char of text) {
    const width = utf8Width(char.codePointAt(0) ?? 0);
    if (bytes + width > maxBytes) break;
    bytes += width;
    cutAt += char.length;
  }

  // A cut mid-sentence can leave a dangling space; a stored body never ends in whitespace.
  return { text: text.slice(0, cutAt).replace(/\s+$/u, ''), truncated: true, originalBytes };
}

export interface BuildSourceItemOptions {
  /** Override the 512 KB cap (tests and callers with their own budget). */
  maxBodyBytes?: number;
  /** Tags are assigned by the caller, never guessed from the page. Defaults to `[]`. */
  tags?: string[];
}

export interface BuildSourceItemInput {
  url: string;
  title: string;
  /** Extracted page body or selected text; whitespace is normalised and the cap applied here. */
  text: string;
  byline?: string;
  lang?: string;
  /** `extractPage` reports this; when absent it is derived from the (capped) body. */
  extraction?: ExtractionQuality;
  /** Page URL a selection was taken from — its presence marks the record as an excerpt. */
  excerptOf?: string;
  channel?: SourceChannel;
  capturedAt?: Date;
  id?: string;
}

/**
 * The one conversion from an extraction result to a stored `SourceItem`.
 *
 * Pure: same input → same `content_hash` and same body, which is what lets the capture service
 * recognise a repeated capture as a duplicate (SC-F1-03) instead of writing a second file.
 */
export function buildSourceItem(
  input: BuildSourceItemInput,
  options: BuildSourceItemOptions = {},
): SourceItem {
  const normalized = normalizeWhitespace(input.text);
  const { text, truncated, originalBytes } = truncateBody(
    normalized,
    options.maxBodyBytes ?? MAX_BODY_BYTES,
  );

  return newSourceItem({
    url: input.url,
    title: input.title,
    body: text,
    tags: options.tags ?? [],
    channel: input.channel,
    byline: input.byline,
    lang: input.lang,
    excerpt_of: input.excerptOf,
    truncated,
    original_bytes: originalBytes,
    extraction: input.extraction ?? (text === '' ? 'title-only' : 'full'),
    capturedAt: input.capturedAt,
    id: input.id,
  });
}
