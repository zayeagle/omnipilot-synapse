import { describe, expect, it } from 'vitest';

import { mergeDocuments, type SearchDocument } from './postings';

/**
 * F4 - a hit has to be described by a document, so the table has to be complete.
 *
 * A record the cache holds without usable text (an older capture, a partial write) has postings and no
 * document, and `search()` drops a hit it cannot describe: the note matched and was then hidden, which is
 * exactly "search finds nothing while the inbox still shows the note". The manifest fills those gaps.
 */
describe('document table merge (F4 UNIT)', () => {
  const cached: SearchDocument = {
    id: 'src00001',
    kind: 'source',
    path: 'inbox/2026/10/a.md',
    title: 'A real title',
    fields: { title: ['a real title'], body: ['some body'] },
    updated_at: '2026-10-10T00:00:00.000Z',
  };

  it('TC-F4-U06 keeps the cached document, title and snippet included', () => {
    const merged = mergeDocuments([cached], [{ id: 'src00001', kind: 'source', path: 'elsewhere.md' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe('A real title');
    expect(merged[0]?.fields.body).toEqual(['some body']);
  });

  it('TC-F4-U07 fills a record the cache cannot describe, so its hits are not hidden', () => {
    const merged = mergeDocuments(
      [{ ...cached, fields: {} }],
      [{ id: 'src00001', kind: 'source', path: 'inbox/2026/10/a.md', updated_at: '2026-10-01T00:00:00.000Z' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.path).toBe('inbox/2026/10/a.md');
    expect(merged[0]?.updated_at).toBe('2026-10-10T00:00:00.000Z');

    const gap = mergeDocuments([], [{ id: 'src00002', kind: 'source', path: 'inbox/2026/10/b.md' }]);
    expect(gap.map((document) => document.id)).toEqual(['src00002']);
    expect(gap[0]?.title).toBe('');
  });
});
