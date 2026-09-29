---
version: 5
previous_version: 4
artifact: 08-spec.md
spec_mode: auto
requirement_id: req-2026-09-29-synapse-workflow-elegance
supersedes: req-2026-07-09-synapse-git-sync (v3 archived); v4 superseded by the refined philosophy (user, 2026-09-29)
---

# Spec Delta: 设计理念入文档 · 全量功能审计 · 统一优化

## ADDED

### R1: The philosophy is two axes, and both are judgeable
The product SHALL state its philosophy as two axes — depth of understanding of the user's knowledge workflow
(捕获 → 暂存 → 整理 → 连接 → 提炼 → 复习 → 输出 → 应用) and elegance of AI–human collaboration
(介入时机 / 建议而非命令 / 可解释可控制 / 学习偏好 / 错误可纠正) — and SHALL gate design and review on them.

#### Scenario: SC-R1-01 the two axes are written and enforceable
- **WHEN** a reader opens the principles document or `AGENTS.md`
- **THEN** they find the eight workflow stages each with its promise and its deliberate restraint, the five
  collaboration traits each with a decidable test and a counter-example, the per-feature four questions, and a
  code-review checklist — with the README pointing at it
#### Scenario: SC-R1-02 every feature answers the four questions
- **WHEN** a feature is designed
- **THEN** its design section states which workflow stage it serves, who decides, where the artefact goes and how
  it is undone, and what the user sees when it fails; an AI feature additionally self-checks all five traits

### R2: Every implemented feature is audited against both axes (unchanged from v4)
#### Scenario: SC-R2-01 the audit enumerates the real surface, each conclusion with `file:line`
#### Scenario: SC-R2-02 dead code, unproduced record types, states without an exit and silent failures are listed separately

### R3: The audit's P0/P1 findings are fixed in the same requirement (unchanged from v4)
#### Scenario: SC-R3-01 an AI proposal has a decision surface (cards.list / card.decide)
#### Scenario: SC-R3-02 a conflict is a decision, not a stray file (conflict.resolve)
#### Scenario: SC-R3-03 a background failure tells the user what to do
#### Scenario: SC-R3-04 SSH mode explains its prerequisite (one copyable command)

### R5: The remaining workflow stages are served, locally first
连接（connect）、输出（output）与 应用（apply）SHALL be served by local, explainable, refusable actions.

#### Scenario: SC-R5-01 connection is suggested with a reason and refused freely
- **WHEN** a stored record shares terms, tags or a topic with another record
- **THEN** the product proposes the link **with the reason it is proposing it** (shared tag, shared term, same topic),
  the user accepts or refuses in one action, an accepted link is stored on the record, and a refused link is
  remembered so the same proposal is not repeated
#### Scenario: SC-R5-02 output is one action, no editor
- **WHEN** the user wants to use what they stored
- **THEN** they can obtain a citation, a topic outline or a snippet as Markdown for the clipboard in one action;
  the product does not become an editor
#### Scenario: SC-R5-03 application is recorded, not inferred
- **WHEN** the user marks a note as used or verified
- **THEN** the fact and its date are recorded locally, shown back to the user, and never invented by the system

### R6: Suggestions remember what the user rejected, and corrections are remembered (E4/E5)

#### Scenario: SC-R6-01 a refusal suppresses the same suggestion
- **WHEN** the user refuses a suggested link, tag or topic twice
- **THEN** the same suggestion is not shown again, and the suppression is stored locally (never in the repository)
#### Scenario: SC-R6-02 a correction becomes a preference
- **WHEN** the user edits a card's topic or tags
- **THEN** the edit is recorded as a preference so the next suggestion for similar content matches the user's own
  classification rather than repeating the original guess

## MODIFIED

### R4: Nothing automated may fail invisibly
The status projection SHALL carry a translated, actionable cause; the raw error text SHALL remain inside the worker.
#### Scenario: SC-R4-01 the projection stays secret-free (code + translated title + action target only)

## Constraints (binding on every fix)

- No new runtime dependency in either package; no new network egress.
- Local intelligence first: 连接/偏好/复习/输出 all computed locally with zero egress.
- New message types are extension-page only (`SECRET_BEARING_TYPES`) and rate-limited.
- Vault mode never downgrades to plaintext; a locked vault refuses instead of caching ciphertext.
- User preferences (E4/E5) are stored **locally only** — they never enter the repository.
- The regression baseline (543 UNIT / 111 INT / 8 SYS / 12 E2E) must not go red.
