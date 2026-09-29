/**
 * Record ⇄ Markdown document mapping.
 *
 * PURE MODULE. One place decides which CKF field lives in the frontmatter and which lives in the
 * body, so every adapter (transparent Markdown, vault envelope, a future SQL adapter) agrees.
 *
 * Conventions
 * - SourceItem: metadata in the frontmatter, the captured text is the body (never duplicated).
 * - KnowledgeCard / Topic / ReviewState: fully structured records, so the frontmatter is the single
 *   source of truth and the body is a rendered reading view for a transparent repository.
 */

import {
  CkfError,
  parseKnowledgeCard,
  parseReviewState,
  parseSourceItem,
  parseTopic,
  type CkfRecord,
  type KnowledgeCard,
  type ReviewState,
  type SourceItem,
  type Topic,
} from './ckf';
import { decodeDoc, encodeDoc, type Frontmatter } from './markdown';

function bulletList(items: ReadonlyArray<string>): string {
  return items.map((item) => `- ${item}`).join('\n');
}

/* ----------------------------- SourceItem ----------------------------- */

export function sourceItemToDoc(item: SourceItem): string {
  const frontmatter: Frontmatter = {
    id: item.id,
    kind: 'source',
    channel: item.channel,
    url: item.url,
    title: item.title,
    captured_at: item.captured_at,
    content_hash: item.content_hash,
    tags: item.tags,
    byline: item.byline,
    lang: item.lang,
    excerpt_of: item.excerpt_of,
    truncated: item.truncated,
    original_bytes: item.original_bytes,
    extraction: item.extraction,
  };
  return encodeDoc(frontmatter, item.body);
}

export function docToSourceItem(text: string): SourceItem {
  const { frontmatter, body } = decodeDoc(text);
  return parseSourceItem({ ...frontmatter, body });
}

/* ---------------------------- KnowledgeCard --------------------------- */

export function cardToDoc(card: KnowledgeCard): string {
  const frontmatter: Frontmatter = {
    id: card.id,
    kind: 'card',
    source_id: card.source_id,
    title: card.title,
    summary: card.summary,
    points: card.points,
    scenarios: card.scenarios,
    counter_examples: card.counter_examples,
    tags: card.tags,
    topic_id: card.topic_id,
    status: card.status,
    evidence_paths: card.evidence_paths,
    distilled_by: card.distilled_by
      ? {
          provider: card.distilled_by.provider,
          model: card.distilled_by.model,
          at: card.distilled_by.at,
        }
      : undefined,
  };

  const sections: string[] = [`# ${card.title}`, '', card.summary, '', '## 要点', bulletList(card.points)];
  if (card.scenarios?.length) sections.push('', '## 适用场景', bulletList(card.scenarios));
  if (card.counter_examples?.length) {
    sections.push('', '## 反例 / 边界', bulletList(card.counter_examples));
  }
  sections.push(
    '',
    '---',
    '',
    `来源: ${card.source_id} · 证据: ${card.evidence_paths.join(', ') || '—'} · 状态: ${card.status}`,
  );

  return encodeDoc(frontmatter, `${sections.join('\n')}\n`);
}

export function docToCard(text: string): KnowledgeCard {
  const { frontmatter } = decodeDoc(text);
  return parseKnowledgeCard(frontmatter, { requireStatus: true });
}

/* -------------------------------- Topic ------------------------------- */

export function topicToDoc(topic: Topic): string {
  const frontmatter: Frontmatter = {
    id: topic.id,
    kind: 'topic',
    name: topic.name,
    path: topic.path,
    parent_id: topic.parent_id,
  };
  return encodeDoc(frontmatter, `# ${topic.name}\n\n路径: ${topic.path}\n`);
}

export function docToTopic(text: string): Topic {
  const { frontmatter } = decodeDoc(text);
  return parseTopic(frontmatter);
}

/* ----------------------------- ReviewState ---------------------------- */

export function reviewStateToDoc(state: ReviewState): string {
  const frontmatter: Frontmatter = {
    id: state.id,
    kind: 'review',
    stability: state.stability,
    retrievability: state.retrievability,
    last_reviewed_at: state.last_reviewed_at,
    next_review_at: state.next_review_at,
    self_rating: state.self_rating,
    use_count: state.use_count,
  };
  return encodeDoc(frontmatter, `# 复习状态 ${state.id}\n`);
}

export function docToReviewState(text: string): ReviewState {
  const { frontmatter } = decodeDoc(text);
  return parseReviewState(frontmatter);
}

/* ------------------------------ Dispatch ------------------------------ */

export function recordToDoc(record: CkfRecord): string {
  switch (record.kind) {
    case 'source':
      return sourceItemToDoc(record);
    case 'card':
      return cardToDoc(record);
    case 'topic':
      return topicToDoc(record);
    case 'review':
      return reviewStateToDoc(record);
    default:
      throw new CkfError('kind', 'is not a known record kind');
  }
}

export function docToRecord(text: string): CkfRecord {
  const { frontmatter } = decodeDoc(text);
  switch (frontmatter['kind']) {
    case 'source':
      return docToSourceItem(text);
    case 'card':
      return docToCard(text);
    case 'topic':
      return docToTopic(text);
    case 'review':
      return docToReviewState(text);
    default:
      throw new CkfError('kind', 'must be one of source | card | topic | review');
  }
}
