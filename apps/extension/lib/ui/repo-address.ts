/**
 * The two things a person actually knows about their knowledge repository: its address, and the
 * directory inside it. Everything the worker needs — owner, repository, branch — is derived here.
 *
 * Pure and browser-free so the page and the tests drive the same rules. Errors are message KEYS, not
 * sentences: this module is not allowed to decide what language the user reads.
 */

export type RepoAddressError =
  | 'options.store.repoAddress.required'
  | 'options.store.repoAddress.invalid'
  | 'options.store.repoAddress.host';

export type InnerPathError = 'options.store.innerPath.invalid';

export interface ParsedRepoAddress {
  owner: string;
  repo: string;
  /** Only present when the address named one (`/tree/<branch>`); otherwise the field's value stands. */
  branch?: string;
}

export type RepoAddressResult =
  | { ok: true; value: ParsedRepoAddress }
  | { ok: false; messageKey: RepoAddressError };

/** GitHub's own rules are looser than this; these are the characters that survive a URL and a path. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
/** Folder names inside the repository: no dots, so a pasted domain cannot pass for a directory. */
const INNER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

function stripGitSuffix(repo: string): string {
  return repo.toLowerCase().endsWith('.git') ? repo.slice(0, -4) : repo;
}

function fromShorthand(owner: string, repo: string, branch?: string): RepoAddressResult {
  const cleanRepo = stripGitSuffix(repo);
  if (!SEGMENT.test(owner) || !SEGMENT.test(cleanRepo) || cleanRepo === '.' || cleanRepo === '..') {
    return { ok: false, messageKey: 'options.store.repoAddress.invalid' };
  }
  if (branch !== undefined && branch.length > 0 && !BRANCH.test(branch)) {
    return { ok: false, messageKey: 'options.store.repoAddress.invalid' };
  }
  return branch !== undefined && branch.length > 0
    ? { ok: true, value: { owner, repo: cleanRepo, branch } }
    : { ok: true, value: { owner, repo: cleanRepo } };
}

/**
 * `https://github.com/owner/repo[/tree/branch]` · `git@github.com:owner/repo.git` · `owner/repo`.
 *
 * A host other than `github.com` is refused rather than silently ignored: the API base is a separate
 * (advanced) setting, and quietly talking to a different host than the one the user pasted is exactly
 * the kind of plausible-looking mistake this form was rebuilt to stop.
 */
export function parseRepoAddress(input: string): RepoAddressResult {
  const raw = input.trim();
  if (raw.length === 0) return { ok: false, messageKey: 'options.store.repoAddress.required' };
  if (/\s/u.test(raw)) return { ok: false, messageKey: 'options.store.repoAddress.invalid' };

  // `git@github.com:owner/repo.git` — the form a `git clone` URL takes.
  const scp = /^git@([^:]+):(.+)$/u.exec(raw);
  if (scp) {
    if ((scp[1] ?? '').toLowerCase() !== 'github.com') {
      return { ok: false, messageKey: 'options.store.repoAddress.host' };
    }
    const parts = (scp[2] ?? '').split('/').filter((part) => part.length > 0);
    // A clone URL never carries a branch, so a third segment means this is not one.
    if (parts.length !== 2) return { ok: false, messageKey: 'options.store.repoAddress.invalid' };
    return fromShorthand(parts[0] as string, parts[1] as string);
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, messageKey: 'options.store.repoAddress.invalid' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, messageKey: 'options.store.repoAddress.invalid' };
    }
    if (url.hostname.toLowerCase() !== 'github.com') {
      return { ok: false, messageKey: 'options.store.repoAddress.host' };
    }
    const parts = url.pathname.split('/').filter((part) => part.length > 0);
    if (parts.length < 2) return { ok: false, messageKey: 'options.store.repoAddress.invalid' };
    const [owner, repo, marker, ...rest] = parts;
    if (marker !== undefined && marker !== 'tree') {
      return { ok: false, messageKey: 'options.store.repoAddress.invalid' };
    }
    const branch = marker === 'tree' ? rest.join('/') : undefined;
    return fromShorthand(owner as string, repo as string, branch);
  }

  const parts = raw.split('/').filter((part) => part.length > 0);
  if (parts.length !== 2) return { ok: false, messageKey: 'options.store.repoAddress.invalid' };
  return fromShorthand(parts[0] as string, parts[1] as string);
}

/** The canonical address to show for a stored configuration. */
export function repoAddressOf(owner: string, repo: string): string {
  return owner.length > 0 && repo.length > 0 ? `https://github.com/${owner}/${repo}` : '';
}

/**
 * The optional directory inside the repository.
 *
 * This field used to accept `https://github.com/owner/repo/` and then quietly turn every path into
 * `https:/github.com/owner/repo/inbox/...` — an input that validates but means something else. A colon,
 * a doubled slash or a backslash is now refused with a message that says what to write instead.
 */
export function parseInnerPath(input: string): { ok: true; value: string } | { ok: false; messageKey: InnerPathError } {
  const raw = input.trim();
  if (raw.length === 0) return { ok: true, value: '' };
  if (/[:\\]/u.test(raw) || raw.includes('//')) {
    return { ok: false, messageKey: 'options.store.innerPath.invalid' };
  }
  const segments = raw.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return { ok: true, value: '' };
  for (const segment of segments) {
    // A predictable character set, deliberately without a dot: it keeps `github.com/owner` (a domain
    // pasted into the wrong field) and `../../etc` out, and the message says what is allowed instead.
    if (!INNER_SEGMENT.test(segment)) {
      return { ok: false, messageKey: 'options.store.innerPath.invalid' };
    }
  }
  return { ok: true, value: segments.join('/') };
}
