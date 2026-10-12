---
requirement_id: req-2026-10-10-synapse-index-locality
status: PASS
e2e: WAIVED (user instruction 2026-09-30; manual acceptance instead)
executed_at: 2026-10-12T15:50:00+08:00
---

# Test Report — req-2026-10-10-synapse-index-locality（F17 索引分裂修复）

## Phase 4 Test Execution Plan
Profile: **frontend-M** · layers: UNIT ✅ · INT ✅ · E2E **WAIVED** · SMK ✅(手工) · REG ✅
Commands: `npx tsc --noEmit` · `npm test` · `npm run test:int` · `npm run test:reg` · `npm run build` · `npm run assert:content`
Blocking: UNIT + INT（e2e_required=false，沿用豁免）

## Results

| Layer | Command | Result | Gate |
|-------|---------|--------|------|
| types | `npx tsc --noEmit` | 0 errors | ✅ |
| UNIT | `npm test` | **645 / 645** · 69 files | ✅（基线 645，不降） |
| INT | `npm run test:int` | **139 / 139** · 13 files | ✅（基线 139，不降） |
| REG | `npm run test:reg` | **416 / 416** | ✅（基线 416，不降） |
| build | `npm run build` | 0 · 451.41 kB | ✅ |
| content | `npm run assert:content` | OK（内容包无密钥 / native 符号） | ✅ |
| companion UNIT | `npm run test:bridge` | 48 / 48 | ✅（未改动，基线 48） |
| companion SYS | `npm run test:sys` | 8 / 8 | ✅（未改动，基线 8） |
| E2E | `npx playwright test` | **未运行** | ⚠️ WAIVED |

## F17 — INT（executed）

| TC-ID | Layer | Result | Evidence |
|-------|-------|--------|----------|
| TC-F17-I01 | INT | ✅ | `F17 capture {"hits":1,"indexMissing":false,"repositoryShards":0}` · `F17 rebuild {"ok":true,"hits":1}` |
| TC-F17-I02 | INT | ✅ | `MISSING-INDEX {"indexMissing":true,"rebuilt":true,"hits":1,"needsRebuild":false}` |
| TC-F17-I03 | INT | ✅ | `F17 migration {"ok":true,"cleaned":2,"cleanupSkipped":null,"left":0}` |
| TC-F17-I04 | INT | ✅ | TC-F16-I08（拉取中文记录 → 重建 → 命中）保持绿色 |
| TC-F17-I05 | INT | ⚠️ 覆盖不足 | SSH 的 `deleteUnsupported` 由 **UNIT**（transport 契约）与 `remote-deleted.test.ts` 覆盖；本需求没有用 fake native 驱动一次完整 SSH 迁移（见 Gap） |

## F17 — UNIT（executed）

| TC-ID | Layer | Result | Note |
|-------|-------|--------|------|
| TC-F17-U01/U02 | UNIT | ✅ | `index.int.test.ts TC-F4-I04`：空列表不再吃掉候选；列表非空时仍按存在的分片读 |
| TC-F17-U03/U04/U05 | UNIT | ✅ | `local-index-decision.test.ts` + `local-store.test.ts`（签名、陈旧判定、`@built` 键） |
| TC-F17-U06 | UNIT | ✅ | `engine.test.ts TC-F3-U09`：提交里没有 `search/**`，而本机 `listShardKeys()>0` |

## Smoke（手工，仍欠）

`TC-F17-S01`：刷新扩展 → 写一条含「能力」的笔记 → 保存 → **不点重建**直接搜「能力」应命中；同时确认 GitHub 该次提交里
没有 `search/`；再点一次「重建索引」，旧分片应被清理并提示条数。

## Gaps（不静默丢弃）

1. **E2E 未运行**（沿用业主 2026-09-30 的豁免）：4 个 E2E 规格（search / search-chinese / search-prefixed / sync）已按新真相
   更新断言（不再断言仓库有分片，改为「没有」），但**没有在真实浏览器里执行**。风险：Chromium 的 IndexedDB 行为与
   handler 的接线（`localIndex` 记忆化、MV3 worker 回收后重开数据库）只在 INT 的内存后端下验证过。→ 手工验收 + 下一次
   允许跑 E2E 时必须跑这套。
2. **TC-F17-I05（SSH 迁移）**：只由传输层 UNIT 覆盖，没有端到端的 fake-native 用例；SSH 用户的实际结果是「旧分片留在仓库
   里 + 提示切 Token 模式」。→ Open Backlog。
3. **S6-01（MEDIUM，安全）**：本机索引明文，接受并记入 backlog（见 `07-security-audit.md`）。

## Decision
- **PASS**（UNIT/INT/REG/build/content 全绿；E2E 按既有豁免记 Gap，未假装跑过）
