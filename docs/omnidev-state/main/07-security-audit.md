---
requirement_id: req-2026-10-10-synapse-index-locality
iteration: 1
status: PASS
blocking_open: 0
git_tip: working tree (uncommitted — repository rule: the owner commits)
audited_at: 2026-10-12T15:30:00+08:00
---

# Security Audit — req-2026-10-10-synapse-index-locality（F17 索引分裂修复）

**Scope**: `lib/background/handlers.ts` · `lib/sync/engine.ts` · `lib/search/index.ts` · `entrypoints/background.ts` ·
`entrypoints/options/main.ts` · `lib/i18n.ts`。Checklist-only（本仓库没有配置 SAST / secret scanner）。

## Summary
- Result: **PASS with warnings** —— 无未决 CRITICAL/HIGH；一条 MEDIUM 明确接受并进入 backlog。
- 本次改动是**净安全收益**：vault 档位下「记录密文、索引明文」这条 F16 记录的实质降级，现在从仓库里彻底消失
  （写入路径搬到本机 + 迁移删掉旧分片）。

## Findings
| ID | Sev | File | Issue | Disposition |
|----|-----|------|-------|-------------|
| S6-01 | MEDIUM | `lib/search/local-store.ts` | 本机索引（`omnipilot-search` IndexedDB）里的词项倒排是**明文**，而记录缓存（`SyncCache`）是用 vault sealer 密封的。显式口令模式下，不持有口令也能从本地浏览器存储读到笔记词表。 | **接受**（理由见 Notes 2）；转 `02-plan.md` Open Backlog：用 session sealer 密封本机分片 |
| S4-01 | LOW | `lib/background/handlers.ts`（迁移） | 删除路径由仓库返回的目录名拼接而成。 | **本迭代已修**：含 `/`、`\`、等于 `.`/`..` 或为空的名字一律拒绝，不参与拼接 |
| S3-01 | INFO | `lib/background/handlers.ts`（`search.rebuild`） | 迁移会删除用户仓库里的文件。 | 需要已配置凭据 + 已解锁 vault（两个入口都经 `buildAuthContext`）；删除范围限定在 `<prefix>/search/` |

## Checks
| ID | Result | Evidence |
|----|--------|----------|
| S1 Secrets | pass | 新代码不读取、不记录、不提交任何凭据；分片载荷是倒排词项，不是秘密。`npm run assert:content` OK |
| S2 Injection | pass | 未新增 shell / SQL / 模板 / HTML 路径；唯一由输入拼出的新字符串是同步提交信息里的**条数**（不是路径、不是笔记内容） |
| S3 AuthN/AuthZ | pass | 未新增 message type、未新增端点、未新增特权原语；`search.rebuild` / `search.query` 沿用既有门槛 |
| S4 Dangerous APIs | pass（S4-01 已修） | 无 eval / exec / 反序列化；只有 `store.commitFiles([], msg, deleted)` 且路径受限于分片目录 |
| S5 Crypto/transport | pass | 未改加密与 TLS；vault 信封 / KDF 路径未被触碰 |
| S6 Data exposure | MEDIUM accepted | 见 S6-01 |
| S7 Dependencies | pass | 未新增依赖（`package.json` 未改动） |
| S8 SAST | n/a | 仓库未配置 SAST；checklist-only + `npm run assert:content` |

## Notes
1. **仓库不再收到任何明文索引材料。** vault 档位下记录正文本来就是密文，而由正文派生的倒排（`search/*.json`）不是 ——
   这正是 F16 记为「实质降级为部分明文」的那一条。写入路径搬到本机后索引一个字节都不进仓库，`search.rebuild` 还会把
   旧版本留下的清掉。证据：INT **TC-F17-I01**（capture 后 `repositoryShards=0`，同一次查询命中 1）、
   **TC-F17-I03**（2 个旧分片被删除，`left=0`，检索仍命中）。
2. **S6-01 为什么接受而不在本需求修**：(a) 索引是派生数据，和笔记、浏览器 profile 在同一台机器上；(b) 保险库锁定时检索
   **拒绝服务** —— 进入索引的每条路径（`resolveRepo` → `buildAuthContext`）都要读密钥，锁定状态答不出任何东西；
   (c) 默认的 keyless 档位根本没有口令可保护，密封只是换个地方放同一把钥匙 —— 该暴露只存在于**显式口令**模式。
   要修就是写入时逐分片密封、读取时开封，改变索引的写入成本与失败模式，属**安全模型变更**，应独立成一个需求而不是
   夹带在 bug 修复里。已记入 `02-plan.md` Open Backlog，不会被静默丢弃。

## Tools
`npx tsc --noEmit` = 0 · `npm test` = 645 · `npm run test:int` = 139 · `npm run test:reg` = 416 ·
`npm run build` = 0（451.33 kB）· `npm run assert:content` = OK · companion `test:bridge` = 48 · `test:sys` = 8

## Decision
- **passed**（S4-01 已修；S6-01 接受并进入 backlog）
