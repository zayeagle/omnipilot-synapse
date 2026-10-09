/**
 * Duplicate detection keys.
 *
 * PURE MODULE — deliberately dependency-free and non-cryptographic.
 *
 * Why not SHA-256? The `content_hash` is committed next to the content (and, in vault mode, next to
 * the ciphertext). A cryptographic digest of the plaintext would let anyone holding the repository
 * test whether a guessed text is in the vault. A cheap non-cryptographic fingerprint is enough for
 * "have I captured this already?" while leaking strictly less.
 */

const FNV_OFFSET_A = 0x811c9dc5;
const FNV_OFFSET_B = 0x7f4a7c15;
const FNV_PRIME = 0x01000193;

function fnv32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * 32-bit FNV-1a over the input's UTF-16 code units — the same function {@link contentKey} is built on,
 * exported for callers that need a stable bucket index rather than a fingerprint (the search shards).
 *
 * It names files, so it must be identical on every machine: no locale data, no platform hash, no
 * randomness. Non-cryptographic on purpose, exactly like the fingerprint above.
 */
export function stableHash32(input: string): number {
  return fnv32(input, FNV_OFFSET_A);
}

/** Collapse whitespace and case so cosmetic differences do not read as new content. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\s\u3000]+/gu, ' ')
    .trim()
    .toLowerCase();
}

/** 16-hex-char fingerprint of normalized content. Stable across sessions and adapters. */
export function contentKey(body: string): string {
  const normalized = normalizeText(body);
  return hex8(fnv32(normalized, FNV_OFFSET_A)) + hex8(fnv32(normalized, FNV_OFFSET_B));
}

const TRACKING_PARAMS = [
  /^utm_/u,
  /^ga_/u,
  /^mc_/u,
  /^pk_/u,
  /^ref$/u,
  /^ref_src$/u,
  /^referrer$/u,
  /^source$/u,
  /^spm$/u,
  /^from$/u,
  /^share_/u,
  /^fbclid$/u,
  /^gclid$/u,
  /^yclid$/u,
  /^igshid$/u,
  /^mkt_tok$/u,
  /^_hsenc$/u,
  /^_hsmi$/u,
  /^vero_id$/u,
  /^oly_/u,
];

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACKING_PARAMS.some((pattern) => pattern.test(lower));
}

/**
 * Canonical key for a URL: lowercase host, drop the fragment, drop tracking parameters, keep the
 * remaining parameters sorted, and ignore a trailing slash (except at the root).
 *
 * Falls back to the trimmed raw string when the input is not a parseable absolute URL.
 */
export function urlKey(rawUrl: string): string {
  const fallback = rawUrl.trim();
  let url: URL;
  try {
    url = new URL(fallback);
  } catch {
    return fallback.toLowerCase();
  }

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/^www\./u, '');
  url.hash = '';

  const keep: Array<[string, string]> = [];
  url.searchParams.forEach((value, name) => {
    if (!isTrackingParam(name)) keep.push([name, value]);
  });
  keep.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  const search = keep.length
    ? `?${keep.map(([name, value]) => `${name}=${value}`).join('&')}`
    : '';
  let pathname = url.pathname.replace(/\/{2,}/gu, '/');
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/u, '');

  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname}${port}${pathname}${search}`;
}

const SHINGLE_SIZE = 5;
const NEAR_DUPLICATE_THRESHOLD = 0.9;
const COMPARISON_BYTES = 2048;

/**
 * Tokenise into latin words and individual CJK characters, so a near-duplicate check works for both
 * English and Chinese pages without a tokenizer dependency.
 */
export function tokenize(input: string): string[] {
  const normalized = normalizeText(input).slice(0, COMPARISON_BYTES);
  const matches = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+/gu);
  return matches ?? [];
}

export function shingles(input: string, size = SHINGLE_SIZE): Set<string> {
  const tokens = tokenize(input);
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < size) {
    out.add(tokens.join(' '));
    return out;
  }
  for (let i = 0; i + size <= tokens.length; i += 1) {
    out.add(tokens.slice(i, i + size).join(' '));
  }
  return out;
}

/** Jaccard similarity of the 5-gram shingle sets, over the first 2 KB of each input. */
export function similarity(a: string, b: string): number {
  const left = shingles(a);
  const right = shingles(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const shingle of left) {
    if (right.has(shingle)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export function isNearDuplicate(a: string, b: string, threshold = NEAR_DUPLICATE_THRESHOLD): boolean {
  if (contentKey(a) === contentKey(b)) return true;
  return similarity(a, b) >= threshold;
}
