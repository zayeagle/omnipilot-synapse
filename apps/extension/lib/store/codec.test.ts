import { describe, expect, it } from 'vitest';

import { CkfError, newKnowledgeCard, newSourceItem, type CkfRecord, type ReviewState, type SourceItem, type Topic } from '../core/ckf';
import { recordToDoc } from '../core/document';
import { decodeDoc } from '../core/markdown';
import { reviewStatePath } from '../core/paths';
import {
  CodecError,
  TRANSPARENT_EXTENSION,
  VAULT_EXTENSION,
  createTransparentCodec,
  isCkfDocument,
  isPlainMarkdownPath,
  isRecordKind,
  isVaultPath,
  recordContentPath,
  transparentCodec,
} from './codec';
import { isVaultFile } from './vault-codec';

const BODY = 'the quick brown fox jumps over the lazy dog — 机密正文';
const TITLE = 'Vault round trip 笔记';
const URL = 'https://example.com/posts/one?utm_source=newsletter&b=2#frag';

function makeItem(): SourceItem {
  return newSourceItem({
    id: 'src00001',
    url: URL,
    title: TITLE,
    body: BODY,
    tags: ['architecture', '笔记'],
    byline: 'A. Author',
    lang: 'zh-CN',
    capturedAt: new Date('2026-01-05T08:30:00.000Z'),
  });
}

describe('transparent codec (F3 UNIT)', () => {
  it('TC-F3-U05 writes plain Markdown with frontmatter and no encryption', async () => {
    const item = makeItem();
    const text = await transparentCodec.encode(item);

    expect(text.startsWith('---\n')).toBe(true);
    const { frontmatter, body } = decodeDoc(text);
    expect(frontmatter['kind']).toBe('source');
    expect(frontmatter['id']).toBe(item.id);
    expect(frontmatter['title']).toBe(TITLE);
    expect(frontmatter['url']).toBe(URL);
    expect(body).toBe(BODY);

    // No envelope vocabulary anywhere: this tier is readable on github.com.
    expect(text).not.toContain('cipher_b64');
    expect(text).not.toContain('PBKDF2-SHA256');
    expect(isVaultFile(text)).toBe(false);
    expect(() => JSON.parse(text) as unknown).toThrow();

    expect(transparentCodec.mode).toBe('transparent');
    expect(transparentCodec.extension).toBe(TRANSPARENT_EXTENSION);
    await expect(transparentCodec.decode(text)).resolves.toEqual(item);
  });

  it('TC-F3-U05 claims plain Markdown files and declines everything else', () => {
    const text = recordToDoc(makeItem());

    expect(transparentCodec.matches('inbox/2026/01/note.md', text)).toBe(true);
    expect(transparentCodec.matches('inbox/2026/01/note.md.enc', text)).toBe(false);
    expect(transparentCodec.matches('index.json', '{"schema":1,"items":{}}')).toBe(false);
    expect(transparentCodec.matches('.omnipilot/config.json', '{"security_mode":"vault"}')).toBe(
      false,
    );
    expect(transparentCodec.matches('inbox/2026/01/note.md', 'plain prose, no frontmatter')).toBe(
      false,
    );

    expect(isCkfDocument(text)).toBe(true);
    expect(isCkfDocument(text.replace('kind: "source"', 'kind: "mystery"'))).toBe(false);
    expect(isPlainMarkdownPath('.hidden.md')).toBe(true);
    expect(isPlainMarkdownPath('a.md.enc')).toBe(false);
    expect(isVaultPath('a.md.enc')).toBe(true);
    expect(isVaultPath('a.md')).toBe(false);
    expect(isRecordKind('source')).toBe(true);
    expect(isRecordKind('nope')).toBe(false);
  });

  it('TC-F3-U05 raises a typed error for content that is not a record', async () => {
    await expect(transparentCodec.decode('just prose')).rejects.toThrow(CkfError);
    await expect(transparentCodec.decode('---\nkind: "mystery"\n---\nbody')).rejects.toThrow(
      CkfError,
    );
  });

  it('TC-F3-U05 derives F2 paths and a minimal index entry for the commit', async () => {
    const codec = createTransparentCodec({
      prefix: 'knowledge',
      now: () => Date.parse('2026-01-05T08:30:00.000Z'),
    });
    const item = makeItem();
    const encoded = await codec.encodeRecord(item);

    expect(encoded.path).toBe('knowledge/inbox/2026/01/vault-round-trip-笔记-src00001.md');
    expect(encoded.content).toContain(BODY);
    expect(Object.keys(encoded.index).sort()).toEqual([
      'content_key',
      'created_at',
      'id',
      'kind',
      'path',
      'updated_at',
      'url_key',
    ]);
    expect(encoded.index.id).toBe(item.id);
    expect(encoded.index.kind).toBe('source');
    expect(encoded.index.path).toBe(encoded.path);
    expect(encoded.index.created_at).toBe(item.captured_at);
    expect(encoded.index.updated_at).toBe(item.captured_at);
    // The dedup key is canonical (tracking parameters and fragment dropped), not the raw URL.
    expect(encoded.index.url_key).toBe('https://example.com/posts/one?b=2');
    expect(encoded.index.content_key).toBe(item.content_hash);

    const index = JSON.stringify(encoded.index);
    expect(index).not.toContain(BODY);
    expect(index).not.toContain(URL);
    expect(index).not.toContain('utm_source');
    expect(index).not.toContain(TITLE);
  });

  it('TC-F3-U05 keeps review state and topics out of the content path rules', async () => {
    const card = newKnowledgeCard({
      id: 'crd00001',
      source_id: 'src00001',
      title: 'Card title',
      summary: 'summary',
      points: ['point'],
      evidence_paths: ['inbox/2026/01/x.md'],
      distilled_by: { provider: 'openai', model: 'gpt', at: '2026-01-06T00:00:00.000Z' },
    });
    const topic: Topic = { id: 'tpc00001', kind: 'topic', name: 'Architecture', path: 'architecture' };
    const review: ReviewState = {
      id: 'rvw00001',
      kind: 'review',
      stability: 1,
      retrievability: 2,
      next_review_at: '2026-02-01T00:00:00.000Z',
      use_count: 0,
    };

    expect(recordContentPath(card, VAULT_EXTENSION)).toBe('cards/pending/card-title-crd00001.md.enc');
    expect(recordContentPath(card, TRANSPARENT_EXTENSION)).toBe('cards/pending/card-title-crd00001.md');
    expect(recordContentPath(topic, VAULT_EXTENSION)).toBe('topics/architecture.md.enc');
    // `review/state.json` always stays cleartext, so it never passes through a codec.
    expect(() => recordContentPath(review, TRANSPARENT_EXTENSION)).toThrow(CodecError);
    expect(reviewStatePath()).toBe('review/state.json');

    // A card carries no URL, so its index entry has no dedup keys at all.
    const encoded = await transparentCodec.encodeRecord(card);
    expect(Object.keys(encoded.index).sort()).toEqual([
      'created_at',
      'id',
      'kind',
      'path',
      'updated_at',
    ]);
    expect(encoded.index.created_at).toBe('2026-01-06T00:00:00.000Z');
  });

  it('TC-F3-U05 round-trips every record kind through the shared document mapping', async () => {
    const records: CkfRecord[] = [
      makeItem(),
      newKnowledgeCard({
        id: 'crd00002',
        source_id: 'src00001',
        title: 'Card title',
        summary: 'summary',
        points: ['point one', 'point two'],
        evidence_paths: ['inbox/2026/01/x.md'],
        tags: ['t'],
        status: 'confirmed',
      }),
      { id: 'tpc00002', kind: 'topic', name: '主题', path: 'topic-path' },
    ];
    for (const record of records) {
      await expect(transparentCodec.decode(await transparentCodec.encode(record))).resolves.toEqual(
        record,
      );
    }
  });
});
