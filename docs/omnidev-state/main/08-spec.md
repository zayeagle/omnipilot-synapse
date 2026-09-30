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
