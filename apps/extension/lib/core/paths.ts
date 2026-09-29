/**
 * Ids, slugs and repository path builders.
 *
 * PURE MODULE. Paths are part of the on-disk contract with the knowledge repository, so they are
 * built here once and reused by every adapter instead of being assembled ad hoc.
 */

/** Crockford-style base32: no `i`, `l`, `o`, `u` — avoids ids that read like words or typos. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const TIME_CHARS = 5;
const SEQ_CHARS = 3;
const TIME_MOD = ALPHABET.length ** TIME_CHARS; // 33 554 432 ms ≈ 9.3 h, then it wraps
const SEQ_MOD = ALPHABET.length ** SEQ_CHARS; // 32 768 ids per millisecond bucket

let sequence = Math.floor(Math.random() * SEQ_MOD);

function encode(value: number, length: number): string {
  let remaining = Math.max(0, Math.floor(value)) % ALPHABET.length ** length;
  const out = new Array<string>(length);
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = ALPHABET[remaining % ALPHABET.length] as string;
    remaining = Math.floor(remaining / ALPHABET.length);
  }
  return out.join('');
}

/**
 * 8-character, time-sortable, collision-free-within-a-process record id.
 *
 * 5 chars of millisecond time + 3 chars of a monotonic sequence. Sorting ids lexicographically
 * therefore sorts by capture time, which keeps directory listings chronological without reading
 * file contents.
 *
 * @param now injected clock — tests pass a fake one.
 */
export function newId(now: () => number = Date.now): string {
  sequence = (sequence + 1) % SEQ_MOD;
  const time = Math.floor(now()) % TIME_MOD;
  return encode(time, TIME_CHARS) + encode(sequence, SEQ_CHARS);
}

/** Test seam: make the sequence deterministic. Not used by production code. */
export function resetIdSequence(start = 0): void {
  sequence = ((start % SEQ_MOD) + SEQ_MOD) % SEQ_MOD;
}

/**
 * Filesystem-safe slug: keeps letters and digits (including CJK), folds everything else to `-`.
 * Emoji, punctuation, path separators and Windows-reserved characters are all removed.
 */
export function slugify(input: string, maxLength = 60): string {
  const folded = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, '-')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const trimmed = Array.from(folded).slice(0, maxLength).join('').replace(/-+$/u, '');
  return trimmed.length > 0 ? trimmed : 'item';
}

/** Join path segments, collapsing duplicate and leading/trailing slashes. */
export function joinPath(...parts: Array<string | undefined | null>): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('/')
    .replace(/\/{2,}/gu, '/')
    .replace(/^\/+|\/+$/gu, '');
}

/** Normalise a user-supplied repository prefix (`/notes/`, `notes`) to `notes`. */
export function normalizePrefix(prefix?: string | null): string {
  if (!prefix) return '';
  return joinPath(
    ...prefix
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  );
}

function utcParts(isoTimestamp: string): { year: string; month: string } {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`paths: invalid timestamp "${isoTimestamp}"`);
  }
  return {
    year: String(date.getUTCFullYear()).padStart(4, '0'),
    month: String(date.getUTCMonth() + 1).padStart(2, '0'),
  };
}

export interface PathableSource {
  id: string;
  title: string;
  captured_at: string;
}

/** `[prefix/]inbox/YYYY/MM/<slug>-<id>.md` — the Inbox is date-partitioned (Q6). */
export function sourceItemPath(item: PathableSource, prefix?: string | null): string {
  const { year, month } = utcParts(item.captured_at);
  return joinPath(
    normalizePrefix(prefix),
    'inbox',
    year,
    month,
    `${slugify(item.title)}-${item.id}.md`,
  );
}

export interface PathableCard {
  id: string;
  title: string;
  status: 'pending' | 'confirmed';
}

/** `[prefix/]cards/pending/<slug>-<id>.md` or `[prefix/]cards/<slug>-<id>.md` once confirmed. */
export function cardPath(card: PathableCard, prefix?: string | null): string {
  const fileName = `${slugify(card.title)}-${card.id}.md`;
  return card.status === 'pending'
    ? joinPath(normalizePrefix(prefix), 'cards', 'pending', fileName)
    : joinPath(normalizePrefix(prefix), 'cards', fileName);
}

export function topicPath(topic: { name: string }, prefix?: string | null): string {
  return joinPath(normalizePrefix(prefix), 'topics', `${slugify(topic.name)}.md`);
}

export function indexPath(prefix?: string | null): string {
  return joinPath(normalizePrefix(prefix), 'index.json');
}

export function reviewStatePath(prefix?: string | null): string {
  return joinPath(normalizePrefix(prefix), 'review', 'state.json');
}

export function storeConfigPath(prefix?: string | null): string {
  return joinPath(normalizePrefix(prefix), '.omnipilot', 'config.json');
}
