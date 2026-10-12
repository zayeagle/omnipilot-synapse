---
test_strategy_profile: frontend-M
layers_required: [unit, integration, smoke, regression]
e2e_tool: playwright
e2e_required: false
integration_required: true
e2e_waiver: user instruction 2026-09-30, do not run the browser suite; manual acceptance instead
---

## Test Strategy Summary
| Layer | Required | Tool | Command | TC Count |
|-------|----------|------|---------|----------|
| UNIT | yes | vitest | npm test | 6 |
| INT | yes | vitest | npm run test:int | 5 |
| E2E | WAIVED | playwright | npx playwright test | 0 |
| SMK | yes | manual | - | 1 |
| REG | yes | vitest | npm run test:reg | 1 |

## F17 - UNIT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|-------|------|--------|-------|----------|------|
| TC-F17-U01 | UNIT | Error | `readShards` | `listShards() → []` | 空列表不当「都不存在」，仍读候选分片 | in-memory store |
| TC-F17-U02 | UNIT | Boundary | `readShards` | 列表长度 = `DIRECTORY_LISTING_CEILING` | 不用列表过滤，按候选读 | in-memory store |
| TC-F17-U03 | UNIT | Happy | `shouldUseLocalIndex` | shards>0 且签名一致 | true | none |
| TC-F17-U04 | UNIT | Error | `shouldUseLocalIndex` | `builtFrom ≠ current` | false，且调用方据此报 `needsRebuild`，**不**回落仓库 | none |
| TC-F17-U05 | UNIT | Happy | `signatureOf` | 记录顺序不同 | 同一签名 | none |
| TC-F17-U06 | UNIT | Happy | 写路径选择的产物 | 一次捕获 | 返回的 RepoFile 里没有任何 `search/**` | fake store |

## F17 - INT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|-------|------|--------|-------|----------|------|
| TC-F17-I01 | INT | Happy | `capture.request` → 立刻 `search.query` | 正文含「能力」的中文笔记 | 命中 ≥1；提交里**没有** `search/**` | fake GitHub |
| TC-F17-I02 | INT | Error→Happy | 另一台机器（记录在、本机索引无） | 复制仓库文件到新 worker → 查询 → 重建 → 查询 | 先 `indexMissing`（非 `needsRebuild`）、0 命中；重建后命中 ≥1 | fake GitHub |
| TC-F17-I03 | INT | Happy | 迁移（`search.rebuild`） | 仓库里放回旧 `search/c02.json`、`c1c.json` → 重建 | 旧分片被删除提交（`cleaned`>0、`left`=0）；检索仍命中 | fake GitHub |
| TC-F17-I04 | INT | Happy | 拉取后索引自动跟上 | 仓库新增一条中文记录 → `sync.now` → `search.query` | 命中该条，无需手工重建（TC-F16-I08 覆盖） | fake GitHub |
| TC-F17-I05 | INT | Failure | SSH 路径迁移 | 仓库有 `search/**`、SSH 模式 | `deleteUnsupported` 如实上报（结果里带 `cleanupSkipped`），记录与本地检索不受影响 | fake native |

> 命名：原 TC-F16-I01 / I03 的**前提**（索引在仓库）随写路径改动消失，已分别改写为 TC-F17-I01（捕获即索引）与
> TC-F17-I02（换设备的真实场景）；原 TC-F16-I02 的「仓库里有分片」断言翻转为「没有」。

## E2E Flows
| TC-ID | Layer | Flow | Steps | Expected |
|-------|-------|------|-------|----------|
| (waived) | E2E | 捕获后检索 | 捕获一条含「能力」的笔记 → 打开检索页签 → 搜「能力」 | 命中该条；仓库里不再出现 `search/` —— 刷新扩展后由用户手工验收 |

> 既有 TC-E2E-03 / 08 / 09 里「仓库有分片」的断言必须翻转为「本机可查、仓库无分片」（A6），但本需求**不运行**浏览器套件（沿用 waiver）。

## Smoke Suite
| TC-ID | Source-TC | Layer | Critical Path |
|-------|-----------|-------|---------------|
| TC-F17-S01 | TC-F17-I01 | SMK | 捕获一条 → 立刻在检索页签搜到；仓库不新增 `search/` |

## Regression Suite
| TC-ID | Layer | Module | Package | Type |
|-------|-------|--------|---------|------|
| TC-F17-R01 | REG | lib/search, lib/sync, lib/capture, lib/background | extension | 既有检索 / 同步 / 捕获用例全绿，基线不降 |
