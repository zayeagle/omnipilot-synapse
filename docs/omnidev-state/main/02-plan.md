# Plan - req-2026-10-10-synapse-index-locality

Feature: **F17 索引分裂修复** · 复杂度 M · autopilot（剩余硬门：Phase 3 `pre_dev`、Phase 4 `test_gate_fail`）

## Task Groups
| Group | Tasks | Gate |
|-------|-------|------|
| G1 写路径回到本机 | T1, T2, T3 | Phase 3 `pre_dev`（M 硬门）→ Dev |
| G2 读取不再吞结果 | T4, T5 | `change_impact` |
| G3 一次性迁移 | T6, T7 | `change_impact` |
| G4 收口 | T8, T9, T10, T11 | Phase 3 退场安全审计 → Phase 4 |

## G1 — 写路径回到本机

- [x] **T1** [extension] `shardProvider` / `cardShards` 改持有本机索引 store，仓库提交不再携带 `search/**` · feature: F17 · outputs: `lib/background/handlers.ts`, `entrypoints/background.ts` · depends: - · verify: `npx vitest run lib/capture/service.int.test.ts`
- [x] **T2** [extension] `buildSearchIndex` 去掉仓库分片分支（`remoteShards`/`drain`）；归档与真删除也在本机索引上 `remove` · feature: F17 · outputs: `lib/background/handlers.ts`, `lib/search/index.ts`, `lib/sources/archive.ts` · depends: T1 · verify: `npx tsc --noEmit && npm test`
- [x] **T3** [extension] 索引与记录同源：写路径 `upsert` + 刷新 `builtFrom`；捕获提交写 sync cache；拉取后纯本机 `rebuild` · feature: F17 · outputs: `lib/background/handlers.ts`, `lib/sync/engine.ts`, `lib/sync/cache.ts` · depends: T1,T2 · verify: INT TC-F17-I01/I02

## G2 — 读取不再吞结果

- [x] **T4** [extension] `readShards`：只在列表确实列出东西时用它过滤；空列表按「无法回答」处理 · feature: F17 · outputs: `lib/search/index.ts` · depends: - · verify: UNIT TC-F17-U01/U02
- [x] **T5** [extension] 陈旧 / 缺失一律 `needsRebuild` / `indexMissing`，不再回落读仓库；复用既有面板渲染，不改 UI 结构 · feature: F17 · outputs: `lib/background/handlers.ts` · depends: T3 · verify: INT TC-F17-I02 + UNIT TC-F17-U04

## G3 — 一次性迁移

- [x] **T6** [extension] 同步在**本机索引可用之后**删除仓库既有 `search/**`（一次提交 `sha: null`），同步结果报出删除条数；不可用时不删 · feature: F17 · outputs: `lib/sync/engine.ts`, `lib/background/handlers.ts`, `lib/sync/shard-store.ts` · depends: T3 · verify: INT TC-F17-I03/I04
- [x] **T7** [extension] SSH / 伴生路径的 `deleteUnsupported` 如实报错 + 双语文案（含替代动作：切 Token 模式） · feature: F17 · outputs: `lib/i18n.ts`, `lib/sync/engine.ts` · depends: T6 · verify: i18n parity + INT TC-F17-I05

## G4 — 收口

- [x] **T8** [extension] 断言翻转（A6）：既有「仓库里有 `search/`」的用例改为「仓库没有、本机可查」，并更新 E2E 规格（本需求不运行） · feature: F17 · outputs: `lib/sync/engine.test.ts`, `lib/capture/service.int.test.ts`, `lib/background/handlers.int.test.ts`, `e2e/*` · depends: T1-T7 · verify: `npm test && npm run test:int`
- [x] **T9** [extension] 实测对照：改前 / 改后的「仓库文件数、捕获后检索命中、重建耗时」，写入 03-progress · feature: F17 · outputs: `03-progress.md` · depends: T8 · verify: 人工复核
- [x] **T10** [extension] B.22 安全审计：索引不再进仓库 ⇒ vault 明文分片问题根除的复核；迁移删除的不可逆性论证与失败可见 · feature: F17 · outputs: `07-security-audit.md` · depends: T8 · verify: PASS
- [x] **T11** [extension] 文档同步：04-design / 05-test-plan / 03-progress / session-log + 00-project-context 教训条目 · feature: F17 · outputs: `docs/omnidev-state/**` · depends: T9,T10 · verify: `npm run test:reg`

## Traceability
| Task | Feature | TC-IDs | SC |
|------|---------|--------|----|
| T1, T2, T3 | F17 | U06, I01, I02 | F17-01（捕获即索引） |
| T4, T5 | F17 | U01, U02, U03, U04, U05 | F17-02（陈旧可读）、F17-03（空列表不吞） |
| T6, T7 | F17 | I03, I04, I05 | F17-04（迁移只删派生数据） |
| T8 | F17 | U01-U06, I01-I05 | 全部 |
| T9, T10, T11 | F17 | - | - |

## Open Backlog（沿用，未静默丢弃）

1. **SSH 模式不能删除文件**：伴生进程写入原语只支持新增 / 覆盖 ⇒ 真删除与本次 `search/**` 迁移在 SSH 下都只能拒绝并提示。补齐需给 `apps/git-bridge` 增加删除操作（协议 + 测试）。
2. **本地文件导入**（md / pdf / txt）仍未实现，属独立需求。
3. **紧凑编码（C）与后台延迟索引（D）**：F16 已判定收益随索引落地本机而下降，留作后续可选优化。
4. **`search/` 目录列表按 HEAD 缓存**：迁移完成后该问题自然消失（仓库不再有 `search/`）。
5. **多设备首次检索需各自本机构建**：目前由用户点「重建索引」；产品化（进度提示 / 自动触发）未做。
