/**
 * Secret scrubbing.
 *
 * Every user-visible error, every log line and every value that could round-trip back into a page
 * passes through here first. Two passes: exact configured secrets (longest first, so a secret that
 * contains another secret is fully removed), then shape-based patterns for credentials that were
 * never configured — for example a key echoed back by a provider's error body.
 */

export const REDACTED = '[REDACTED]';

/** Anything shorter is not treated as a secret; replacing it would shred normal text. */
export const MIN_SECRET_LENGTH = 6;

export const MAX_ERROR_LENGTH = 500;

export interface SecretSource {
  githubPat?: string | null;
  providerKey?: string | null;
  passphrase?: string | null;
  extra?: ReadonlyArray<string | null | undefined>;
}

export const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /github_pat_[A-Za-z0-9_]{3,}/gu,
  /gh[pousr]_[A-Za-z0-9]{3,}/gu,
  /sk-[A-Za-z0-9_-]{3,}/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  /x-api-key["'\s:=]+[A-Za-z0-9._-]{8,}/giu,
];

/** Collect every configured credential, de-duplicated and in longest-first order. */
export function collectSecrets(source: SecretSource | null | undefined): string[] {
  if (!source) return [];
  const candidates: Array<string | null | undefined> = [
    source.githubPat,
    source.providerKey,
    source.passphrase,
    ...(source.extra ?? []),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length >= MIN_SECRET_LENGTH) {
      seen.add(candidate);
    }
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

export function scrub(text: string, secrets?: Iterable<string | null | undefined> | null): string {
  let output = text;
  const list: string[] = [];
  for (const secret of secrets ?? []) {
    if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) list.push(secret);
  }
  list.sort((a, b) => b.length - a.length);
  for (const secret of list) {
    if (output.includes(secret)) output = output.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === 'string') return candidate;
    try {
      return JSON.stringify(error);
    } catch {
      return 'unserializable error';
    }
  }
  return String(error);
}

/** Message-only, scrubbed, length-capped — safe for UI, logs and storage. */
export function scrubError(
  error: unknown,
  secrets?: Iterable<string | null | undefined> | null,
): string {
  const raw = messageOf(error);
  const cleaned = scrub(raw, secrets).replace(/\s+/gu, ' ').trim();
  return cleaned.length > MAX_ERROR_LENGTH ? `${cleaned.slice(0, MAX_ERROR_LENGTH)}…` : cleaned;
}
