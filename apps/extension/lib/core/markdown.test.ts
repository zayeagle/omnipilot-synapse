import { describe, expect, it } from 'vitest';

import { newKnowledgeCard, newSourceItem } from './ckf';
import { docToCard, docToRecord, docToSourceItem, recordToDoc, sourceItemToDoc } from './document';
import { decodeDoc, encodeDoc } from './markdown';

describe('markdown frontmatter (F2 UNIT)', () => {
  it('TC-F2-U01 round trips a full source item', () => {
    const item = newSourceItem({
      url: 'https://example.com/article',
      title: 'Example article',
      body: 'The body.',
      byline: 'Ada',
      lang: 'en',
      tags: ['reading', 'ai'],
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const restored = docToSourceItem(sourceItemToDoc(item));
    expect(restored).toEqual(item);
  });

  it('TC-F2-U01 round trips every optional field', () => {
    const item = newSourceItem({
      url: 'https://example.com/article',
      title: 'T',
      body: 'B',
      excerpt_of: 'https://example.com/article',
      truncated: true,
      original_bytes: 700_000,
      extraction: 'title-only',
      tags: [],
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    expect(docToSourceItem(sourceItemToDoc(item))).toEqual(item);
  });

  it('TC-F2-U02 keeps a body containing delimiters, quotes, emoji and CJK intact', () => {
    const body = [
      '---',
      'this line is a delimiter',
      '"quoted" and \'single\' and \\ backslash',
      '😀 🎉 emoji',
      '中文标题与正文',
      '---',
      'trailing ---',
      '',
      'tab\tinside',
    ].join('\n');
    const document = encodeDoc({ id: 'x1', kind: 'source', tags: [] }, body);
    const decoded = decodeDoc(document);
    expect(decoded.body).toBe(body);
    expect(decoded.frontmatter['id']).toBe('x1');
  });

  it('TC-F2-U02 writes a CJK title with emoji as a valid quoted scalar', () => {
    const item = newSourceItem({
      url: 'https://example.com/中文',
      title: '中文标题 😀 "test"',
      body: '正文',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const restored = docToSourceItem(sourceItemToDoc(item));
    expect(restored.title).toBe('中文标题 😀 "test"');
    expect(restored.url).toBe('https://example.com/中文');
  });

  it('TC-F2-U01/U02 handles empty and delimiter-only bodies', () => {
    for (const body of ['', '---', '\n---\n', 'line1\nline2']) {
      expect(decodeDoc(encodeDoc({ id: 'a' }, body)).body).toBe(body);
    }
  });

  it('TC-F2-U01 treats a document without frontmatter as a body-only document', () => {
    const decoded = decodeDoc('# Just markdown\n\nno frontmatter here');
    expect(decoded.frontmatter).toEqual({});
    expect(decoded.body).toBe('# Just markdown\n\nno frontmatter here');
  });

  it('TC-F2-U01 tolerates an unterminated frontmatter block', () => {
    const decoded = decodeDoc('---\nid: "x"\nbody without closing');
    expect(decoded.frontmatter).toEqual({});
    expect(decoded.body).toContain('body without closing');
  });

  it('TC-F2-U01 encodes arrays, numbers, booleans and nested blocks', () => {
    const document = encodeDoc(
      {
        tags: ['a', 'b'],
        use_count: 3,
        retrievability: 0.25,
        truncated: false,
        skipped: undefined,
        distilled_by: { provider: 'openai', model: 'gpt-4o-mini', at: '2026-07-09T00:00:00.000Z' },
      },
      'body',
    );
    const { frontmatter, body } = decodeDoc(document);
    expect(frontmatter['tags']).toEqual(['a', 'b']);
    expect(frontmatter['use_count']).toBe(3);
    expect(frontmatter['retrievability']).toBe(0.25);
    expect(frontmatter['truncated']).toBe(false);
    expect(frontmatter['skipped']).toBeUndefined();
    expect(frontmatter['distilled_by']).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      at: '2026-07-09T00:00:00.000Z',
    });
    expect(body).toBe('body');
  });

  it('TC-F2-U01 strips a BOM before parsing', () => {
    const document = `\uFEFF${encodeDoc({ id: 'x' }, 'body')}`;
    expect(decodeDoc(document).frontmatter['id']).toBe('x');
  });
});

describe('record documents (F2 UNIT)', () => {
  it('TC-F2-U01 round trips a knowledge card through a rendered body', () => {
    const card = newKnowledgeCard({
      source_id: 's1',
      title: 'Spaced repetition',
      summary: 'Reviewing near the forgetting point is most efficient.',
      points: ['Schedule by retrievability', 'Rate each review honestly'],
      scenarios: ['Daily review queue'],
      counter_examples: ['Cramming before an exam'],
      tags: ['learning'],
      evidence_paths: ['inbox/2026/07/x-s1.md'],
      distilled_by: { provider: 'deepseek', model: 'deepseek-chat', at: '2026-07-09T00:00:00.000Z' },
    });
    const restored = docToCard(recordToDoc(card));
    expect(restored).toEqual(card);
  });

  it('TC-F2-U01 dispatches records by their kind field', () => {
    const item = newSourceItem({ url: 'u', title: 'T', body: 'B' });
    expect(docToRecord(recordToDoc(item))).toEqual(item);
  });

  it('TC-F2-U01 renders a human-readable card body in transparent mode', () => {
    const card = newKnowledgeCard({
      source_id: 's1',
      title: 'T',
      summary: 'S',
      points: ['p1'],
      evidence_paths: ['p'],
    });
    const text = recordToDoc(card);
    expect(text).toContain('## 要点');
    expect(text).toContain('- p1');
    expect(text).toContain('来源: s1');
  });
});
