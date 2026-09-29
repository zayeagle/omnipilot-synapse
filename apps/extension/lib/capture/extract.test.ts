import { describe, expect, it } from 'vitest';

import { urlKey } from '../core/dedup';
import { MAX_TITLE_CHARS, extractPage, extractSelection } from './extract';

const LONG_PROSE =
  'Spaced repetition is a learning technique that schedules reviews at expanding intervals. ' +
  'Each successful recall pushes the next review further into the future, which lowers the number ' +
  'of repetitions needed to keep a fact retrievable over years rather than days. ' +
  'It is usually paired with active recall, because recognising an answer is easier than ' +
  'producing it, and only production strengthens retrieval strength.';

/** Parse an HTML string into a real document (happy-dom is forced for `lib/capture/**`). */
function page(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function metaDoc(head: string, body = '<p>Body text.</p>'): Document {
  return page(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`);
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`fixture is missing "${selector}"`);
  return element as T;
}

function navMarkup(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `<a href="/nav/${index}">Nav link ${index}</a>`,
  ).join(' ');
}

/** The global document is the only one happy-dom gives a live `Selection`. */
function currentSelection(): Selection {
  const selection = document.getSelection() ?? window.getSelection();
  if (!selection) throw new Error('this environment exposes no Selection');
  return selection;
}

function selectContents(element: Element): Selection {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = currentSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe('extractPage — container selection (F1 UNIT)', () => {
  const ARTICLE_HTML = `<!doctype html>
    <html lang="en">
      <head>
        <title>Fallback title</title>
        <meta property="og:title" content="  深入理解   间隔重复  ">
        <link rel="canonical" href="/posts/spaced-repetition?utm_source=newsletter&amp;id=7#intro">
      </head>
      <body>
        <nav>${navMarkup(40)}</nav>
        <article>
          <h1>Spaced repetition</h1>
          <p>Spaced repetition schedules reviews at expanding intervals.</p>
          <p>Each successful recall pushes the next review further into the future.</p>
        </article>
        <footer>Copyright 2024 Example</footer>
      </body>
    </html>`;

  it('TC-F1-U01 extracts the article, its title and its URL, and never the navigation', () => {
    const captured = extractPage(page(ARTICLE_HTML), {
      href: 'https://www.example.com/blog/post?utm_medium=social',
    });

    expect(captured.title).toBe('深入理解 间隔重复');
    expect(captured.url).toBe(
      'https://www.example.com/posts/spaced-repetition?utm_source=newsletter&id=7#intro',
    );
    expect(captured.text).toContain('expanding intervals');
    expect(captured.text).toContain('Each successful recall pushes the next review');
    expect(captured.text).not.toContain('Nav link');
    expect(captured.text).not.toContain('Copyright');
    expect(captured.lang).toBe('en');
    expect(captured.extraction).toBe('full');
  });

  it('TC-F1-U01 prefers the article over the main wrapper that encloses it', () => {
    const doc = page(`<!doctype html><html><body>
      <main>
        <p>Wrapper chrome.</p>
        <article><p>Real article prose, long enough to be the clear winner here.</p></article>
      </main>
    </body></html>`);

    const captured = extractPage(doc, { href: 'https://example.com/a' });
    expect(captured.text).toContain('Real article prose');
    expect(captured.text).not.toContain('Wrapper chrome');
  });

  it('TC-F1-U01 separates paragraphs with a blank line and collapses cosmetic whitespace', () => {
    const doc = page(`<!doctype html><html><body><article>
      <p>First   paragraph
         with a wrapped line.</p>
      <p>Second\u00a0paragraph.</p>
    </article></body></html>`);

    expect(extractPage(doc, { href: 'https://example.com/p' }).text).toBe(
      'First paragraph with a wrapped line.\n\nSecond paragraph.',
    );
  });

  it('TC-F1-U02 falls back to <main> when there is no <article>, without throwing', () => {
    const doc = page(`<!doctype html><html><head><title>Main only</title></head><body>
      <header><a href="/">Home</a></header>
      <main>
        <p>Main paragraph one.</p>
        <p>Main paragraph two.</p>
      </main>
      <footer>Footer boilerplate</footer>
    </body></html>`);

    expect(() => extractPage(doc, { href: 'https://example.com/main' })).not.toThrow();
    const captured = extractPage(doc, { href: 'https://example.com/main' });
    expect(captured.text).toContain('Main paragraph one');
    expect(captured.text).toContain('Main paragraph two');
    expect(captured.text).not.toContain('Footer boilerplate');
    expect(captured.extraction).toBe('full');
  });

  it('TC-F1-U02 falls back to <body> and still drops nav link farms', () => {
    const doc = page(`<!doctype html><html><head><title>Body only</title></head><body>
      <nav><ul>${Array.from(
        { length: 30 },
        (_, index) => `<li><a href="/n/${index}">Nav link ${index}</a></li>`,
      ).join('')}</ul></nav>
      <div><p>${LONG_PROSE}</p><p>${LONG_PROSE}</p></div>
    </body></html>`);

    const captured = extractPage(doc, { href: 'https://example.com/body' });
    expect(captured.text).toContain('schedules reviews at expanding intervals');
    expect(captured.text).not.toContain('Nav link');
  });

  it('TC-F1-U02 does not throw on an empty or structureless document', () => {
    const empty = page('<!doctype html><html></html>');
    expect(() => extractPage(empty, { href: 'https://example.com/empty' })).not.toThrow();
    expect(extractPage(empty, { href: 'https://example.com/empty' }).text).toBe('');

    const bare = page('<!doctype html><p>No body markup at all.</p>');
    expect(extractPage(bare, { href: 'https://example.com/bare' }).text).toBe(
      'No body markup at all.',
    );
  });

  it('TC-F1-U03 reports title-only for a whitespace-only page', () => {
    const doc = page(
      `<!doctype html><html><head><title>Whitespace only</title></head>` +
        `<body>   <div> \u00a0\u3000 </div> <p>  \n  </p> <span></span> </body></html>`,
    );

    const captured = extractPage(doc, { href: 'https://example.com/blank' });
    expect(captured.title).toBe('Whitespace only');
    expect(captured.text).toBe('');
    expect(captured.extraction).toBe('title-only');
    expect(captured.url).toBe('https://example.com/blank');
  });
});

describe('extractPage — URL resolution (F1 UNIT)', () => {
  it('TC-F1-U05 resolves a relative canonical link into the normalised page URL', () => {
    const doc = page(`<!doctype html><html><head>
      <link rel="canonical" href="/posts/spaced-repetition?utm_source=newsletter&amp;id=7#intro">
    </head><body><p>Body.</p></body></html>`);

    const captured = extractPage(doc, {
      href: 'https://www.example.com/blog/index.html?utm_medium=social',
    });
    expect(captured.url).toBe(
      'https://www.example.com/posts/spaced-repetition?utm_source=newsletter&id=7#intro',
    );
    // Tracking params are stripped and the fragment dropped by the url key, not by extraction.
    expect(urlKey(captured.url)).toBe('https://example.com/posts/spaced-repetition?id=7');
  });

  it('TC-F1-U05 prefers an absolute canonical link over the location', () => {
    const doc = page(`<!doctype html><html><head>
      <link rel="canonical" href="https://cdn.example.net/clean-post">
    </head><body><p>Body.</p></body></html>`);

    const captured = extractPage(doc, { href: 'https://example.com/dirty?utm_source=x#frag' });
    expect(captured.url).toBe('https://cdn.example.net/clean-post');
    expect(urlKey(captured.url)).toBe('https://cdn.example.net/clean-post');
  });

  it('TC-F1-U05 falls back to loc.href, then doc.location, then an empty string', () => {
    const plain = page('<!doctype html><html><body><p>Body.</p></body></html>');
    expect(extractPage(plain, { href: 'https://example.com/page?utm_source=x#frag' }).url).toBe(
      'https://example.com/page?utm_source=x#frag',
    );
    expect(urlKey(extractPage(plain, { href: 'https://example.com/page?utm_source=x#frag' }).url)).toBe(
      'https://example.com/page',
    );

    const located = page('<!doctype html><html><body><p>Body.</p></body></html>');
    Object.defineProperty(located, 'location', {
      value: { href: 'https://doc.example/from-location' },
      configurable: true,
    });
    expect(extractPage(located).url).toBe('https://doc.example/from-location');

    const detached = page('<!doctype html><html><body><p>Body.</p></body></html>');
    Object.defineProperty(detached, 'location', {
      value: { href: 'about:blank' },
      configurable: true,
    });
    expect(extractPage(detached).url).toBe('');
  });

  it('TC-F1-U05 ignores a canonical link that is not an http(s) URL', () => {
    const doc = page(`<!doctype html><html><head>
      <link rel="canonical" href="javascript:alert(1)">
    </head><body><p>Body.</p></body></html>`);

    expect(extractPage(doc, { href: 'https://example.com/kept' }).url).toBe(
      'https://example.com/kept',
    );
  });
});

describe('extractPage — metadata (F1 UNIT)', () => {
  it('TC-F1-U01 prefers og:title over twitter:title, <title> and the first <h1>', () => {
    const doc = metaDoc(
      `<title>Plain title</title>` +
        `<meta property="og:title" content="  Open   Graph title  ">` +
        `<meta name="twitter:title" content="Twitter title">`,
      '<h1>Heading title</h1><p>Body.</p>',
    );
    expect(extractPage(doc).title).toBe('Open Graph title');
  });

  it('TC-F1-U01 falls back through twitter:title, <title>, <h1> and finally nothing', () => {
    const twitter = metaDoc('<meta name="twitter:title" content="Twitter title">');
    expect(extractPage(twitter).title).toBe('Twitter title');

    const plain = metaDoc('<title>Plain   title</title>');
    expect(extractPage(plain).title).toBe('Plain title');

    const heading = metaDoc('', '<h1>Heading   title</h1><p>Body.</p>');
    expect(extractPage(heading).title).toBe('Heading title');

    expect(extractPage(metaDoc('')).title).toBe('');
  });

  it('TC-F1-U01 caps a runaway title', () => {
    const doc = metaDoc(
      `<meta property="og:title" content="${'t'.repeat(MAX_TITLE_CHARS + 40)}">`,
    );
    expect(extractPage(doc).title).toHaveLength(MAX_TITLE_CHARS);
  });

  it('TC-F1-U01 extracts byline, lang and publishedAt from their documented sources', () => {
    const doc = page(`<!doctype html><html lang="zh-CN"><head>
      <meta name="author" content="  Ada   Lovelace ">
      <meta property="article:published_time" content="2024-05-01T10:00:00Z">
    </head><body><article><p>正文。</p></article></body></html>`);

    const captured = extractPage(doc, { href: 'https://example.com/zh' });
    expect(captured.byline).toBe('Ada Lovelace');
    expect(captured.lang).toBe('zh-CN');
    expect(captured.publishedAt).toBe('2024-05-01T10:00:00Z');
    expect(captured.text).toBe('正文。');
  });

  it('TC-F1-U01 falls back for byline, lang and publishedAt', () => {
    const rel = page('<!doctype html><html><body><a rel="author" href="/a">Grace  Hopper</a><p>x</p></body></html>');
    expect(extractPage(rel).byline).toBe('Grace Hopper');

    const itemprop = page('<!doctype html><html><body><span itemprop="author">Alan  Turing</span><p>x</p></body></html>');
    expect(extractPage(itemprop).byline).toBe('Alan Turing');

    const byline = page('<!doctype html><html><body><div class="byline">By  Someone</div><p>x</p></body></html>');
    expect(extractPage(byline).byline).toBe('By Someone');

    const locale = page('<!doctype html><html><head><meta property="og:locale" content="zh_CN"></head><body><p>x</p></body></html>');
    expect(extractPage(locale).lang).toBe('zh_CN');

    const time = page('<!doctype html><html><body><time datetime="2023-01-02T03:04:05Z">2 Jan</time><p>x</p></body></html>');
    expect(extractPage(time).publishedAt).toBe('2023-01-02T03:04:05Z');
  });

  it('TC-F1-U01 omits optional metadata instead of inventing empty values', () => {
    const captured = extractPage(metaDoc('', '<p>Body.</p>'), { href: 'https://example.com/x' });
    expect(captured.byline).toBeUndefined();
    expect(captured.publishedAt).toBeUndefined();
  });
});

describe('extractSelection (F1 UNIT)', () => {
  it('TC-F1-U04 returns the selected text plus its containing paragraph as context', () => {
    document.body.innerHTML =
      '<article><p>Intro sentence. <b>Selected words</b> trailing sentence.</p></article>';

    const selection = selectContents(requireElement(document, 'b'));
    const captured = extractSelection(selection, document);

    expect(captured.text).toBe('Selected words');
    expect(captured.context).toBe('Intro sentence. Selected words trailing sentence.');
  });

  it('TC-F1-U04 falls back to the enclosing block when there is no paragraph', () => {
    document.body.innerHTML = '<div>Loose   text in a div</div>';

    const captured = extractSelection(selectContents(requireElement(document, 'div')), document);
    expect(captured.text).toBe('Loose text in a div');
    expect(captured.context).toBe('Loose text in a div');
  });

  it('TC-F1-U04 returns an empty result for a null, collapsed or blank selection', () => {
    document.body.innerHTML = '<p>Alpha beta gamma</p>';

    expect(extractSelection(null, document)).toEqual({ text: '', context: '' });

    const empty = currentSelection();
    empty.removeAllRanges();
    expect(extractSelection(empty, document)).toEqual({ text: '', context: '' });

    const paragraph = requireElement(document, 'p');
    const textNode = paragraph.firstChild ?? paragraph;
    const collapsed = document.createRange();
    collapsed.setStart(textNode, 0);
    collapsed.setEnd(textNode, 0);
    const selection = currentSelection();
    selection.removeAllRanges();
    selection.addRange(collapsed);
    expect(selection.isCollapsed).toBe(true);
    expect(extractSelection(selection, document)).toEqual({ text: '', context: '' });
  });

  it('TC-F1-U04 ignores a whitespace-only selection and a foreign document', () => {
    document.body.innerHTML = '<p>   </p>';
    expect(extractSelection(selectContents(requireElement(document, 'p')), document)).toEqual({
      text: '',
      context: '',
    });

    document.body.innerHTML = '<p>Home page</p>';
    const selection = selectContents(requireElement(document, 'p'));
    const foreign = page('<!doctype html><html><body><p>Other document</p></body></html>');
    expect(extractSelection(selection, foreign)).toEqual({ text: 'Home page', context: '' });
  });
});
