import { describe, expect, it } from 'vitest';

import { newSourceItem } from './ckf';
import { docToSourceItem, sourceItemToDoc } from './document';

/**
 * F15 - user text must never become metadata.
 *
 * A note title is free text and lands in the frontmatter, so if scalars were interpolated raw, a title
 * carrying a newline plus "kind: card" would forge fields, change the record's identity or break the
 * document. encodeScalar writes every string as a JSON double-quoted scalar (valid YAML, escaped), which
 * makes that structurally impossible - this pins it so simplifying the writer cannot undo it.
 */
describe('frontmatter injection (F15 UNIT)', () => {
  it('TC-F15-U01 hostile text round-trips as data and cannot forge a field', () => {
    const hostile = 'title\nkind: card\n---\nid: forged';
    const item = newSourceItem({
      id: 'src00001',
      url: 'https://example.com/x',
      title: hostile,
      body: hostile,
      tags: ['a: b', '"quoted"', '---'],
      capturedAt: new Date(0),
    });

    const doc = sourceItemToDoc(item);
    // The scalar is quoted, so the injected line is text rather than a second kind.
    expect(doc).toContain('kind: "source"');

    const back = docToSourceItem(doc);
    expect(back.kind).toBe('source');
    expect(back.id).toBe('src00001');
    expect(back.title).toBe(hostile);
    expect(back.tags).toEqual(['a: b', '"quoted"', '---']);
    expect(back.body).toBe(hostile);
  });
});
