---
version: 6
previous_version: 5
artifact: 02-plan.md
requirement_id: req-2026-09-30-synapse-auth-tier-integrity
complexity: M
total_tasks: 11
groups: 3
history_ref: 02-plan-history.md
---

# Plan — 授权模式与档位契约的完整性（P0 + P1）

**Build order**：G0 授权模式门面（P0）→ G1 档位契约（P1）→ G2 收口。每组结束跑该组测试 + 增量 B.22 复核；每项都写明 `verify:`。

| Group | Theme | Pkg | Tasks | Depends |
|-------|-------|-----|-------|---------|
| G0 | 授权模式无关的仓库门面（R7 / F10） | extension | T0.1–T0.4 | — |
| G1 | 档位以仓库记录为准（R8 / F11） | extension | T1.1–T1.4 | G0 |
| G2 | 收口与回归 | repo | T2.1–T2.3 | all |

## G0 — 授权模式无关的仓库门面 `[pkg:extension]`

- [x] **T0.1** `lib/store/repo-store.ts`：`RepoStore` 接口 + `createRepoStore()`（复用 `parseIndex`/`mergeIndex`/`indexToFile`，不从零实现索引） · verify: UNIT TC-R7-U01
- [x] **T0.2** `handlers.resolveStore` 改走 `resolveAuth`（token / SSH 同形）；`resolveSyncRemote` 与它共用一次 auth 解析 · verify: INT TC-R7-I01
- [x] **T0.3** 服务与 handler 的类型收口到 `RepoStore`（`CaptureService` / `DistillService` / 卡片 / 复习 / 冲突） · verify: `npx tsc --noEmit`
- [x] **T0.4** 状态面诚实化：`isConfigured` 与实际可用能力一致 · verify: UNIT TC-R7-U02 + INT TC-R7-I02

## G1 — 档位以仓库记录为准 `[pkg:extension]`

- [x] **T1.1** `resolveStore` / `resolveSyncRemote` 用 `loadStoreConfig` 决定 codec mode（仓库记录优先，新仓库回落到本机设置） · verify: UNIT TC-R8-U01
- [x] **T1.2** 捕获落盘验证：记录 vault + 本机 transparent → 写入仍为密文 · verify: INT TC-R8-I01
- [x] **T1.3** `settings.security` 的档位变更走 `switchTier` 守卫：有内容即拒绝并可读，空仓库写入 `config.json` · verify: INT TC-R8-I02
- [x] **T1.4** 双语文案：切换被拒的原因 + 一个可执行动作 · verify: i18n parity + UNIT

## G2 — 收口与回归

- [x] **T2.1** 全量回归（extension UNIT/INT/E2E + build + `assert:content`；companion UNIT/SYS） · verify: 05-test-plan 追溯表
- [x] **T2.2** B.22 增量复核（iteration 5）：新的 store 门面是否扩大写原语；档位解析是否引入降级路径 · verify: PASS
- [x] **T2.3** 文档同步（README / 00-project-context / 03-progress / 审计 / 本计划勾选） · verify: 人工复核

## Open backlog（明确延后）

1. `switchTier` 的**迁移**（有内容时真正换档位并重编码）—— 需要一次全量重写事务，本次只做"拒绝 + 说清"。
2. SSH 下的目录/索引缓存（`listDir` 每次走 git）—— 性能问题，非正确性。
3. `store.tier` 独立 message type —— 本次复用 `settings.security`；若将来档位需要独立审计流水再拆分。

## Mid-Phase Gates（B.15）

| Gate | Trigger | Rule |
|------|---------|------|
| `pre_dev` | G0 之前 | M 复杂度：硬门，需确认 |
| `change_impact` | 每组结束 | 偏离本设计时需确认 |
| 安全审计 | Phase 3 退场 | B.22：`resolveStore` 是新的模式分叉点，必须 PASS |
