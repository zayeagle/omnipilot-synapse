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
## Archived 2026-09-30 - req-2026-09-30-synapse-auth-tier-integrity
---
version: 6
previous_version: 5
artifact: 08-spec.md
requirement_id: req-2026-09-30-synapse-auth-tier-integrity
history_ref: 08-spec-history.md
---

# Spec (delta) — 授权模式与档位契约的完整性

上游：`docs/product/00-design-principles.md`。本次是**修复型需求**：不改产品理念，只改正两处"实现与已声明契约不一致"的地方。

## R7 授权模式必须是完整的（不再"半通"）

**判据**：用户在 `存储 → 授权方式` 里选定的模式，必须能完成产品对外承诺的**全部**操作；否则该模式不得被报告为"已配置"。

- **SC-R7-01**：在「SSH + companion 可用 + **没有** PAT」的配置下，`capture.request`（含 `distill: true`）成功，内容经 companion 写入本地克隆并提交。
- **SC-R7-02**：同一配置下，`inbox.list` / `cards.list` / `card.decide` / `review.due` / `conflict.resolve` / `store.probe` 全部可用（不再返回 `notConfigured`）。
- **SC-R7-03**：状态面不得说谎 —— 若某模式下存在不可用的操作，`isConfigured` 与状态行必须反映这一点（"已配置"与"全部操作失败"不得同时出现）。

## R8 仓库记录的档位优先于本机设置

- **SC-R8-01**：当 `.omnipilot/config.json` 记录 `security_mode: vault` 时，即使本机 `settings.securityMode` 是 `transparent`，写入也必须经 vault codec —— **明文不得落盘**（不降级原则）。
- **SC-R8-02**：本机设置与仓库记录相反时，以**仓库记录**为准（读取与写入方向一致，不得出现"读得懂、写回去变了样"）。
- **SC-R8-03**：用户切换档位时，仓库已有内容 → 拒绝切换并给出可读原因 + 一个可执行动作；仓库为空 → 切换并写入 `config.json`。

## 约束（不可协商）

- 零新运行时依赖；零新出网路径。
- vault 永不降级为明文；锁定时拒绝操作。
- 新增 message type（本需求**不新增**，复用 `settings.security`）必须进 `SECRET_BEARING_TYPES` + 限流预算。
- 新文案双语齐备；基线不下降：extension UNIT ≥600 / INT ≥117 / E2E ≥19；companion UNIT ≥48 / SYS ≥8。
- 不执行 git commit / git push。
