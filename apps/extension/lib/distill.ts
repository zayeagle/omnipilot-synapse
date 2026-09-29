/**
 * Distillation: turn a captured SourceItem into a *proposed* KnowledgeCard.
 *
 * Two hard rules from the requirements shape this module:
 * - §4.2 "AI 只提案" — the output is always a `pending` card; user text is never rewritten;
 * - §6.2 "AI 外发最小权限" — the prompt carries only the item the user selected, and the module is
 *   pure, so the caller owns authorization, the ledger and the network.
 *
 * Pure module: no fetch, no clock, no crypto. Everything context-dependent is injected.
 */

import {
  CkfError,
  newKnowledgeCard,
  parseKnowledgeCard,
  type KnowledgeCard,
  type SourceItem,
} from './core/ckf';

export const MAX_POINTS = 12;
export const MIN_POINTS = 3;
export const MAX_POINT_CHARS = 300;
export const MAX_SUMMARY_CHARS = 400;
export const MAX_LIST_ITEMS = 6;
export const DEFAULT_PROMPT_BODY_CHARS = 8_000;

export class DistillParseError extends Error {
  readonly code = 'badJson';

  constructor(message: string) {
    super(message);
    this.name = 'DistillParseError';
  }
}

export interface DistillMessage {
  role: 'system' | 'user';
  content: string;
}

export interface DistillContext {
  sourceId: string;
  sourcePath: string;
  provider: string;
  model: string;
  /** Injected so the produced card is deterministic in tests. */
  at?: string;
}

export interface ParsedDistill {
  card: KnowledgeCard;
  warnings: string[];
}

const SYSTEM_PROMPT = [
  'You distil a captured source into one structured knowledge card.',
  'Reply with a single JSON object and nothing else — no prose, no markdown fence.',
  'All fields are required unless marked optional.',
  'Schema:',
  '{',
  '  "title": string,            // short, specific, no clickbait',
  '  "summary": string,          // one sentence, <= 140 characters',
  '  "points": string[],         // 3-7 self-contained takeaways, each <= 200 characters',
  '  "scenarios": string[],      // optional: when this knowledge applies',
  '  "counter_examples": string[], // optional: boundaries, exceptions, counterexamples',
  '  "tags": string[]            // optional: 1-5 short topical tags',
  '}',
  'Write the values in the same language as the source text.',
  'Do not invent facts that are not supported by the source.',
].join('\n');

function clip(text: string, maxChars: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  return `${characters.slice(0, maxChars).join('')}…`;
}

/** The prompt is deliberately narrow: only the selected item, truncated, plus its metadata. */
export function buildDistillPrompt(
  item: SourceItem,
  options: { maxBodyChars?: number } = {},
): DistillMessage[] {
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_PROMPT_BODY_CHARS;
  const metadata = [
    `url: ${item.url}`,
    item.title ? `title: ${item.title}` : null,
    item.byline ? `byline: ${item.byline}` : null,
    item.lang ? `lang: ${item.lang}` : null,
    item.excerpt_of ? `excerpt_of: ${item.excerpt_of}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const body = clip(item.body, maxBodyChars);
  const note = item.truncated === true ? '\n(source body was truncated when captured)' : '';

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Source metadata:\n${metadata}\n\nSource text:\n${body}${note}`,
    },
  ];
}

/** Strip a ```json fence (or any fence) if the model added one. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/u.exec(trimmed);
  return fence?.[1]?.trim() ?? trimmed;
}

/**
 * Find the first balanced JSON object in `text`, ignoring braces inside strings.
 * Models sometimes wrap the answer in prose; this recovers the object without a regex guess.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i] as string;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const WRAPPER_KEYS = ['card', 'result', 'data', 'knowledge_card', 'output'];

function unwrapCardObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DistillParseError('distill: the model did not return a JSON object');
  }
  const raw = value as Record<string, unknown>;
  for (const key of WRAPPER_KEYS) {
    const inner = raw[key];
    if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
      const innerRaw = inner as Record<string, unknown>;
      // Only unwrap when the wrapper does not itself look like a card.
      if (!('points' in raw) && 'points' in innerRaw) return innerRaw;
    }
  }
  return raw;
}

function normalizeStringList(value: unknown, field: string, maxItems: number, maxChars: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new CkfError(field, 'must be an array of strings');
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') throw new CkfError(field, 'must contain only strings');
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    out.push(clip(trimmed, maxChars));
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Parse and validate a model reply into a pending card.
 *
 * Anything that does not satisfy the schema is rejected outright (SC-F7-03) — a half-parsed card is
 * worse than no card, because it would silently enter the knowledge base with invented structure.
 */
export function parseDistillResult(text: string, context: DistillContext): ParsedDistill {
  const warnings: string[] = [];
  const unfenced = stripCodeFence(text);
  const json = extractJsonObject(unfenced);
  if (json === null) {
    throw new DistillParseError('distill: no JSON object found in the model reply');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DistillParseError('distill: the model reply was not valid JSON');
  }

  const raw = unwrapCardObject(parsed);

  const title = typeof raw['title'] === 'string' ? raw['title'].trim() : '';
  if (title.length === 0) {
    throw new DistillParseError('distill: field "title" is required');
  }
  const summary = typeof raw['summary'] === 'string' ? clip(raw['summary'].trim(), MAX_SUMMARY_CHARS) : '';

  let points: string[];
  let scenarios: string[];
  let counterExamples: string[];
  let tags: string[];
  try {
    points = normalizeStringList(raw['points'], 'points', MAX_POINTS, MAX_POINT_CHARS);
    scenarios = normalizeStringList(raw['scenarios'], 'scenarios', MAX_LIST_ITEMS, MAX_POINT_CHARS);
    counterExamples = normalizeStringList(
      raw['counter_examples'],
      'counter_examples',
      MAX_LIST_ITEMS,
      MAX_POINT_CHARS,
    );
    tags = normalizeStringList(raw['tags'], 'tags', 5, 40);
  } catch (error) {
    if (error instanceof CkfError) {
      throw new DistillParseError(`distill: ${error.message}`);
    }
    throw error;
  }

  const rawPoints = Array.isArray(raw['points']) ? raw['points'] : [];
  if (rawPoints.length > MAX_POINTS) {
    warnings.push(`points capped at ${MAX_POINTS} (model returned ${rawPoints.length})`);
  }
  if (points.length < MIN_POINTS) {
    warnings.push(`only ${points.length} point(s) returned; ${MIN_POINTS}+ recommended`);
  }
  if (points.length === 0) {
    throw new DistillParseError('distill: field "points" must contain at least one point');
  }

  const card = newKnowledgeCard({
    // Deterministic id: re-distilling the same source updates the same pending card instead of
    // littering the repository with near-identical proposals.
    id: `${context.sourceId}-c`,
    source_id: context.sourceId,
    title: clip(title, 160),
    summary,
    points,
    evidence_paths: [context.sourcePath],
    tags,
    status: 'pending',
    distilled_by: {
      provider: context.provider,
      model: context.model,
      at: context.at ?? new Date().toISOString(),
    },
  });
  if (scenarios.length > 0) card.scenarios = scenarios;
  if (counterExamples.length > 0) card.counter_examples = counterExamples;

  // Belt and braces: the card must survive the same validation used when reading it back.
  parseKnowledgeCard(card, { requireStatus: true });

  return { card, warnings };
}
