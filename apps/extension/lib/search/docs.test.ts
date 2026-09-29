import { describe, expect, it } from 'vitest';

import { newKnowledgeCard, newSourceItem, type CkfRecord, type ReviewState, type Topic } from '../core/ckf';
import { DEFAULT_MAX_INBOX, catalogueHash, notesPath, renderNotesIndex } from './docs';

const JAN = (day: number): Date => new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`);

const topicMl: Topic = { id: 't-ml', kind: 'topic', name: '间隔重复', path: 'topics/间隔重复.md' };
const topicGarden: Topic = { id: 't-garden', kind: 'topic', name: 'Gardening', path: 'topics/gardening.md' };

const source1 = newSourceItem({
  id: 's1',
  url: 'https://example.com/one',
  title: 'Incremental reading',
  body: 'A long body about reading.',
  tags: ['reading'],
  capturedAt: JAN(5),
});
const source2 = newSourceItem({
  id: 's2',
  url: 'https://example.com/two',
  title: 'Raised beds',
  body: 'A long body about soil.',
  capturedAt: JAN(6),
});
const source3 = newSourceItem({
  id: 's3',
  url: 'https://example.com/three',
  title: 'Third post',
  body: 'Not distilled yet.',
  capturedAt: JAN(7),
});

const card1 = newKnowledgeCard({
  id: 'c1',
  source_id: 's1',
  title: 'Spaced repetition',
  summary: 'Review at growing intervals.',
  points: ['Intervals grow'],
  evidence_paths: ['inbox/2026/01/incremental-reading-s1.md'],
  topic_id: 't-ml',
  status: 'pending',
  distilled_by: { provider: 'fake', model: 'fake-1', at: JAN(10).toISOString() },
});
const card2 = newKnowledgeCard({
  id: 'c2',
  source_id: 's2',
  title: 'Gardening basics',
  summary: 'Soil first.',
  points: ['Compost'],
  evidence_paths: ['inbox/2026/01/raised-beds-s2.md'],
  status: 'confirmed',
  distilled_by: { provider: 'fake', model: 'fake-1', at: JAN(9).toISOString() },
});

const review: ReviewState = {
  id: 'r1',
  kind: 'review',
  stability: 1,
  retrievability: 0.5,
  next_review_at: JAN(20).toISOString(),
  use_count: 0,
};

const records: CkfRecord[] = [source1, source2, source3, card1, card2, topicMl, topicGarden, review];

describe('renderNotesIndex (F4 UNIT)', () => {
  it('TC-F4-U11 renders the layout, topics with counts, recent cards and the inbox backlog', () => {
    const md = renderNotesIndex({ records });

    expect(md).toContain('# Knowledge catalogue');
    expect(md).toContain('3 source(s), 2 card(s), 2 topic(s)');
    expect(md).toContain('| `search/` |');
    expect(md).toContain('| `index.json` |');

    // Topics: one card each for the tagged topic and the untagged bucket, none for Gardening.
    expect(md).toContain('## Topics');
    expect(md).toContain('| (no topic) | 1 |');
    expect(md).toContain('| [间隔重复](topics/间隔重复.md) | 1 |');
    expect(md).toContain('| [Gardening](topics/gardening.md) | 0 |');

    // Most recent card first, with its date and topic.
    expect(md).toContain('## Recent cards (2)');
    expect(md.indexOf('spaced-repetition-c1.md')).toBeLessThan(
      md.indexOf('gardening-basics-c2.md'),
    );
    expect(md).toContain(
      '- [Spaced repetition](cards/pending/spaced-repetition-c1.md) · 2026-01-10 · 间隔重复',
    );

    // Only the source that has not been distilled is backlog.
    expect(md).toContain('## Inbox backlog (1)');
    expect(md).toContain('- [Third post](inbox/2026/01/third-post-s3.md) · 2026-01-07');
    expect(md).not.toContain('incremental-reading-s1.md)');
  });

  it('TC-F4-U11 hashes the catalogue stably, whatever order the records arrive in', () => {
    const first = catalogueHash({ records });
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(catalogueHash({ records: [...records] })).toBe(first);
    expect(catalogueHash({ records: [...records].reverse() })).toBe(first);
    expect(renderNotesIndex({ records })).toBe(renderNotesIndex({ records: [...records].reverse() }));
    // Rendering twice cannot drift: the catalogue carries no wall-clock line.
    expect(renderNotesIndex({ records })).toBe(renderNotesIndex({ records }));
  });

  it('TC-F4-U11 changes the hash when a card is added', () => {
    const before = catalogueHash({ records });
    const added = newKnowledgeCard({
      id: 'c3',
      source_id: 's3',
      title: 'Composting',
      summary: 'Greens and browns.',
      points: ['Layer it'],
      evidence_paths: ['inbox/2026/01/third-post-s3.md'],
      distilled_by: { provider: 'fake', model: 'fake-1', at: JAN(11).toISOString() },
    });

    const after = catalogueHash({ records: [...records, added] });
    expect(after).not.toBe(before);
    expect(renderNotesIndex({ records: [...records, added] })).toContain('## Inbox backlog (0)');
  });

  it('TC-F4-U11 ignores input changes that do not change the catalogue', () => {
    // Review state is scheduling metadata: it is not part of the readable catalogue, so the guard
    // must not turn it into a commit.
    const withReview: CkfRecord[] = [...records, { ...review, id: 'r2' }];
    expect(catalogueHash({ records: withReview })).toBe(catalogueHash({ records }));
  });

  it('TC-F4-U11 links every entry under the repository prefix', () => {
    const md = renderNotesIndex({ records, prefix: '/notes/' });

    expect(md).toContain('| `notes/search/` |');
    expect(md).toContain('](notes/cards/pending/spaced-repetition-c1.md)');
    expect(md).toContain('](notes/inbox/2026/01/third-post-s3.md)');
    expect(md).toContain('](notes/topics/间隔重复.md)');
    expect(notesPath('notes/')).toBe('notes/NOTES.md');
    expect(notesPath()).toBe('NOTES.md');
    expect(notesPath(null)).toBe('NOTES.md');
  });

  it('TC-F4-U11 renders an empty catalogue without records', () => {
    const md = renderNotesIndex({ records: [] });
    expect(md).toContain('0 source(s), 0 card(s), 0 topic(s)');
    expect(md).toContain('_No topics yet._');
    expect(md).toContain('_No cards yet');
    expect(md).toContain('_Inbox is empty');
    expect(catalogueHash({ records: [] })).toBe(catalogueHash({ records: [review] }));
  });

  it('TC-F4-U11 escapes markdown in titles and summarises a long backlog', () => {
    const tricky = newSourceItem({
      id: 's9',
      url: 'https://example.com/tricky',
      title: 'A [bracket] | pipe `tick`',
      body: 'Body.',
      capturedAt: JAN(8),
    });
    expect(renderNotesIndex({ records: [tricky] })).toContain(
      '- [A \\[bracket\\] \\| pipe \\`tick\\`](inbox/2026/01/a-bracket-pipe-tick-s9.md) · 2026-01-08',
    );

    const many: CkfRecord[] = Array.from({ length: DEFAULT_MAX_INBOX + 3 }, (_, index) =>
      newSourceItem({
        id: `s-${String(index).padStart(2, '0')}`,
        url: `https://example.com/${index}`,
        title: `Post ${index}`,
        body: 'Body.',
        capturedAt: JAN(1),
      }),
    );
    const md = renderNotesIndex({ records: many, maxInbox: 2, maxRecentCards: 1 });
    expect(md).toContain(`## Inbox backlog (${DEFAULT_MAX_INBOX + 3})`);
    expect(md).toContain(`- … and ${DEFAULT_MAX_INBOX + 1} more`);
    expect(md).toContain('## Recent cards (0)');
  });
});
