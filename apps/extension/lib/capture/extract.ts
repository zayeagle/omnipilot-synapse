/**
 * Page and selection extraction — F1 step 2 (page) and step 5 (selection).
 *
 * A DOM module, but every DOM access arrives as a parameter (`doc`, `loc`, `selection`) instead of
 * reaching for globals: that keeps it exercisable under happy-dom, reviewable without a browser, and
 * safe to call on a document other than the current one.
 *
 * Why score candidates instead of `querySelector('article') ?? body`? Real pages keep the body text
 * in an unmarked `<div>` and wrap it in link farms. Scoring lets chrome (nav/footer/aside/link lists)
 * lose on merit rather than on markup luck, and it stays deterministic, which makes it testable.
 *
 * No Readability/cheerio dependency: these heuristics are small enough to explain, and anything
 * imported here ships in the content-script bundle.
 */

import { normalizeWhitespace } from './normalize';

export interface ExtractedPage {
  title: string;
  url: string;
  text: string;
  byline?: string;
  lang?: string;
  publishedAt?: string;
  extraction: 'full' | 'title-only';
}

export interface ExtractedSelection {
  text: string;
  context: string;
}

/** Title cap — mirrors `LIMITS.titleChars`; kept local so extraction needs no protocol import. */
export const MAX_TITLE_CHARS = 500;
const MAX_BYLINE_CHARS = 500;
const MAX_LANG_CHARS = 35;

/** Paragraph-ish elements: prose lives in these, so their text length is the content signal. */
const BLOCK_SELECTOR = 'p, li, blockquote, pre, dd, dt, figcaption, td, th, h2, h3, h4, h5, h6';

/** Chrome. Text inside these must not make its enclosing container look content-rich. */
const PENALISED_SELECTOR =
  'nav, header, footer, aside, form, .sidebar, #comments, [aria-hidden="true"]';

/** Candidate content containers, most specific first — the index doubles as the preference rank. */
const CANDIDATE_SELECTOR = 'article, main, [role="main"], body';const BODY_RANK = 3;

/**
 * An enclosing wrapper only competes with the specific container inside it while it adds no real
 * content: `<main><article>…</article><p>share this</p></main>` must still resolve to `<article>`.
 */
const CONTAINER_COMPETITIVE_RATIO = 0.5;

/** Above this link-text ratio a block is navigation dressed up as prose. */
const LINK_DENSITY_THRESHOLD = 0.5;

/** Nearest block used as the selection's `context`. */
const CONTEXT_SELECTOR = 'p, li, blockquote, pre, dd, dt, figcaption, td, th';
const CONTEXT_FALLBACK_SELECTOR = 'article, main, section, div';

/* ------------------------------------------------------------------ *
 * Small DOM helpers
 * ------------------------------------------------------------------ */

/**
 * Text of one paragraph/title/byline: a block is a single line, so source-level line wrapping is
 * cosmetic and must not leak into the stored body.
 */
function lineText(element: Element): string {
  return normalizeWhitespace(element.textContent ?? '').replace(/\n+/gu, ' ');
}

/** Text of an element that keeps its paragraph breaks — used for containers without block children. */
function looseText(element: Element): string {
  return normalizeWhitespace(element.textContent ?? '');
}

/** Cap by code points, so a cap can never split a surrogate pair. */
function cap(value: string, maxChars: number): string {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('');
}

function firstNonEmpty(values: ReadonlyArray<string>): string {
  for (const value of values) {
    if (value !== '') return value;
  }
  return '';
}

/** `og:`/`twitter:` metadata may be declared with either `property` or `name`. */
function metaValue(doc: Document, key: string): string {
  const element = doc.querySelector(`meta[property="${key}"], meta[name="${key}"]`);
  return normalizeWhitespace(element?.getAttribute('content') ?? '');
}

/** Absolute http(s) URL, or `''` when the value is relative and `base` cannot resolve it. */
function absoluteUrl(value: string, base: string): string {
  const candidate = value.trim();
  if (candidate === '') return '';
  try {
    const url = new URL(candidate, base === '' ? undefined : base);
    // A canonical link may legitimately point at another scheme; we only store web pages.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}

/** `loc.href` → `doc.location.href` → `''`. `about:blank` is a detached document, not a page URL. */
function baseHref(doc: Document, loc?: { href?: string }): string {
  const candidates: string[] = [];
  if (loc?.href) candidates.push(loc.href);
  const location = doc.location;
  if (location && typeof location.href === 'string') candidates.push(location.href);
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed !== '' && !trimmed.startsWith('about:')) return trimmed;
  }
  return '';
}

/** True when `element` sits inside a chrome region that is itself inside `container`. */
function isInsidePenalisedRegion(element: Element, container: Element): boolean {
  for (let node = element.parentElement; node !== null && node !== container; node = node.parentElement) {
    if (node.matches(PENALISED_SELECTOR)) return true;
  }
  return false;
}

function linkDensity(element: Element, textLength: number): number {
  if (textLength === 0) return 0;
  let linkLength = 0;
  for (const link of element.querySelectorAll('a')) {
    linkLength += lineText(link).length;
  }
  return linkLength / textLength;
}

interface Block {
  text: string;
}

/**
 * Paragraph-ish descendants of `container`, outermost-only (a `<li><p>` would otherwise be counted
 * twice) and without chrome or link farms.
 */
function collectBlocks(container: Element): Block[] {
  const blocks: Block[] = [];
  for (const element of container.querySelectorAll(BLOCK_SELECTOR)) {
    const enclosing = element.parentElement?.closest(BLOCK_SELECTOR) ?? null;
    if (enclosing !== null && container.contains(enclosing)) continue;
    if (isInsidePenalisedRegion(element, container)) continue;
    const text = lineText(element);
    if (text === '') continue;
    if (linkDensity(element, text.length) > LINK_DENSITY_THRESHOLD) continue;
    blocks.push({ text });
  }
  return blocks;
}

interface Scored {
  element: Element;
  rank: number;
  score: number;
  text: string;
}

/**
 * `text` is what a capture would store from this container; `score` is what elects the container.
 * Paragraph breaks survive as `\n\n` so a captured body still reads as prose.
 */
function scoreContainer(element: Element): Scored {
  const blocks = collectBlocks(element);
  const text =
    blocks.length > 0
      ? blocks.map((block) => block.text).join('\n\n')
      : // A container holding prose directly (no `<p>` at all) still counts as content.
        looseText(element);

  let penalty = 0;
  for (const region of element.querySelectorAll(PENALISED_SELECTOR)) {
    const enclosing = region.parentElement?.closest(PENALISED_SELECTOR) ?? null;
    if (enclosing !== null && element.contains(enclosing)) continue;
    // An enclosing <body> always contains the article, so without this penalty it would win every
    // election by construction; chrome text is exactly what must not count as content.
    penalty += lineText(region).length;
  }

  return { element, rank: rankOf(element), score: Math.max(0, text.length - penalty), text };
}

function rankOf(element: Element): number {
  if (element.matches('article')) return 0;
  if (element.matches('main')) return 1;
  if (element.matches('[role="main"]')) return 2;
  return BODY_RANK;
}

/**
 * Deterministic container election:
 * 1. containers with no content text drop out;
 * 2. `body` never outranks a scoring `article`/`main` — it is the fallback of last resort;
 * 3. among the survivors, the most specific container wins as long as it contributed at least
 *    `CONTAINER_COMPETITIVE_RATIO` of the best score, so a wrapper that really carries the content
 *    still wins;
 * 4. remaining ties break in document order (`querySelectorAll` order).
 */
function selectContainer(doc: Document): { element: Element | null; text: string } {
  const candidates: Scored[] = [];
  for (const element of doc.querySelectorAll(CANDIDATE_SELECTOR)) {
    candidates.push(scoreContainer(element));
  }

  const withText = candidates.filter((candidate) => candidate.score > 0);
  if (withText.length === 0) {
    const fallback = candidates.find((candidate) => candidate.rank === BODY_RANK) ?? candidates[0];
    // Empty text is a legitimate outcome, not an error (SC-F1-03): the caller stores title-only.
    return { element: fallback?.element ?? null, text: '' };
  }

  const specific = withText.filter((candidate) => candidate.rank < BODY_RANK);
  const pool = specific.length > 0 ? specific : withText;

  let best = pool[0];
  if (!best) return { element: null, text: '' };
  for (const candidate of pool) {
    if (candidate.score > best.score) best = candidate;
  }

  const competitive = pool.filter(
    (candidate) => candidate.score >= best.score * CONTAINER_COMPETITIVE_RATIO,
  );
  let winner = competitive[0];
  if (!winner) return { element: best.element, text: best.text };
  for (const candidate of competitive) {
    if (candidate.rank < winner.rank) winner = candidate;
  }
  return { element: winner.element, text: winner.text };
}

/* ------------------------------------------------------------------ *
 * Metadata harvest
 * ------------------------------------------------------------------ */

function pageTitle(doc: Document): string {
  const titleElement = doc.querySelector('title');
  const heading = doc.querySelector('h1');
  return cap(
    firstNonEmpty([
      metaValue(doc, 'og:title'),
      metaValue(doc, 'twitter:title'),
      titleElement ? lineText(titleElement) : '',
      heading ? lineText(heading) : '',
    ]),
    MAX_TITLE_CHARS,
  );
}

function pageByline(doc: Document): string {
  const relAuthor = doc.querySelector('[rel="author"]');
  const itempropAuthor = doc.querySelector('[itemprop="author"]');
  const bylineClass = doc.querySelector('.byline');
  return cap(
    firstNonEmpty([
      metaValue(doc, 'author'),
      relAuthor ? lineText(relAuthor) : '',
      itempropAuthor ? lineText(itempropAuthor) : '',
      bylineClass ? lineText(bylineClass) : '',
    ]),
    MAX_BYLINE_CHARS,
  );
}

function pageLang(doc: Document): string {
  const fromHtml = normalizeWhitespace(doc.documentElement?.getAttribute('lang') ?? '');
  return cap(firstNonEmpty([fromHtml, metaValue(doc, 'og:locale')]), MAX_LANG_CHARS);
}

function pagePublishedAt(doc: Document): string {
  const fromMeta = metaValue(doc, 'article:published_time');
  if (fromMeta !== '') return fromMeta;
  return normalizeWhitespace(doc.querySelector('time[datetime]')?.getAttribute('datetime') ?? '');
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Extract the readable part of `doc`.
 *
 * Never throws: a page whose container yields no text is reported as `title-only` with an empty
 * body (SC-F1-03), which is a storeable record rather than a failure.
 */
export function extractPage(doc: Document, loc?: { href?: string }): ExtractedPage {
  const base = baseHref(doc, loc);
  const canonical = absoluteUrl(
    doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '',
    base,
  );

  const text = normalizeWhitespace(selectContainer(doc).text);
  const page: ExtractedPage = {
    title: pageTitle(doc),
    url: canonical !== '' ? canonical : base,
    text,
    extraction: text === '' ? 'title-only' : 'full',
  };

  const byline = pageByline(doc);
  if (byline !== '') page.byline = byline;
  const lang = pageLang(doc);
  if (lang !== '') page.lang = lang;
  const publishedAt = pagePublishedAt(doc);
  if (publishedAt !== '') page.publishedAt = publishedAt;
  return page;
}

function elementForNode(node: Node | null): Element | null {
  if (!node) return null;
  if (node.nodeType === 1) return node as Element;
  return node.parentElement;
}

/** The block the selection started in, so a captured excerpt keeps its surrounding sentence. */
function selectionContext(selection: Selection, doc: Document): string {
  const anchor =
    selection.anchorNode ??
    (selection.rangeCount > 0 ? selection.getRangeAt(0).startContainer : null);
  const start = elementForNode(anchor);
  // A selection from another document has no context in this one.
  if (!start || !doc.contains(start)) return '';
  const block = start.closest(CONTEXT_SELECTOR) ?? start.closest(CONTEXT_FALLBACK_SELECTOR) ?? start;
  return looseText(block);
}

/** Selected text plus the paragraph it came from. Blank or absent selection → empty result. */
export function extractSelection(selection: Selection | null, doc: Document): ExtractedSelection {
  if (!selection || selection.isCollapsed) return { text: '', context: '' };
  const text = normalizeWhitespace(selection.toString());
  if (text === '') return { text: '', context: '' };
  return { text, context: selectionContext(selection, doc) };
}
