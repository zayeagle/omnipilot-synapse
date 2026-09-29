/**
 * TC-DOC-U01…U04 — the philosophy and the audit are deliverables, so they get a test.
 *
 * A document nobody checks rots: six months from now the criteria could lose a row, the audit could stop
 * covering a message type, and nothing would notice. These assertions are deliberately **structural**
 * (does the row exist, is every message type enumerated, is there a `file:line` evidence trail) rather than
 * textual, so the documents can be rewritten freely but cannot quietly become decoration.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REQUEST_TYPES } from '../messages';

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), 'utf8');

const PRINCIPLES = 'docs/product/00-design-principles.md';
const AUDIT = 'docs/audits/00-functional-audit.md';

const WORKFLOW_STAGES = ['捕获', '暂存', '整理', '连接', '提炼', '复习', '输出', '应用'];
const RECORD_KINDS = ['SourceItem', 'KnowledgeCard', 'Topic', 'ReviewState'];
const PLANNED_TYPES = [
  'cards.list',
  'card.decide',
  'conflict.resolve',
  'link.suggest',
  'link.decide',
  'note.export',
  'note.mark',
];

describe('design documents contract (R1/R2)', () => {
  it('TC-DOC-U01 the principles document states both axes as decidable criteria', () => {
    const text = repoFile(PRINCIPLES);

    // Axis 1: every workflow stage is named.
    for (const stage of WORKFLOW_STAGES) expect(text).toContain(stage);
    // Axis 2: every collaboration trait has its own row.
    for (const trait of ['E1', 'E2', 'E3', 'E4', 'E5']) expect(text).toContain(trait);
    // Cross-cutting gates survive.
    for (const w of ['W1', 'W2', 'W3', 'W4', 'W5', 'W6']) expect(text).toContain(w);

    // The per-feature questions and the review gate are present and actually itemised.
    expect(text).toContain('必答四问');
    expect(text).toContain('CR 门禁');
    const checklist = text.split('\n').filter((line) => line.trimStart().startsWith('- [ ]'));
    expect(checklist.length).toBeGreaterThanOrEqual(8);
    // Counter-examples are what keep the criteria honest — the document must carry them.
    expect(text).toContain('反例');
  });

  it('TC-DOC-U02 the gate is reachable from the agent entry point and the README', () => {
    expect(repoFile('AGENTS.md')).toContain(PRINCIPLES);
    expect(repoFile('README.md')).toContain(PRINCIPLES);
  });

  it('TC-DOC-U03 the audit enumerates the real surface with evidence', () => {
    const text = repoFile(AUDIT);

    // Every message type the product exposes must be judged by name.
    for (const type of REQUEST_TYPES) expect(text, `missing message type: ${type}`).toContain(type);
    // Every record kind in the canonical model.
    for (const kind of RECORD_KINDS) expect(text, `missing record kind: ${kind}`).toContain(kind);
    // Every workflow stage.
    for (const stage of WORKFLOW_STAGES) expect(text).toContain(stage);
    // The seven types this requirement plans to add are named too, so the plan and the audit cannot drift.
    for (const type of PLANNED_TYPES) expect(text).toContain(type);

    // Evidence, not opinion: at least 25 `path:line` references.
    const evidence = text.match(/[\w./-]+\.(?:ts|md|json):\d+/g) ?? [];
    expect(evidence.length).toBeGreaterThanOrEqual(25);
  });

  it('TC-DOC-U04 the audit separates the four failure modes and rates every finding', () => {
    const text = repoFile(AUDIT);

    for (const heading of ['死代码', '未被创建的记录类型', '无出口状态', '静默失败']) {
      expect(text, `missing section: ${heading}`).toContain(heading);
    }
    // Priorities are explicit, and every problem row carries a way to prove it was fixed.
    for (const priority of ['P0', 'P1', 'P2']) expect(text).toContain(priority);
    expect(text).toContain('修完如何验证');
  });
});
