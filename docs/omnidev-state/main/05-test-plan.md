---
version: 5
previous_version: 4
artifact: 05-test-plan.md
requirement_id: req-2026-09-30-synapse-auth-tier-integrity
history_ref: 05-test-plan-history.md
---

# Test Plan (delta) — R7 / R8

层次：UNIT 起步，跨模块（auth × store × handlers）加 INT；**本需求不加 E2E**（SSH 需要真实 companion 进程，浏览器内无法驱动；既有 19 条 E2E 作为回归基线）。

| TC-ID | 层 | 断言 |
|-------|----|------|
| TC-R7-U01 | UNIT | `createRepoStore` 与 `GitHubStore` 对同一批操作行为一致：`readIndex`/`readRecord`/`commitRecord`/`findExisting`/`fileUrl` |
| TC-R7-U02 | UNIT | `isConfigured` 与真实能力一致：SSH + companion ok 时为 true，且此配置下不再有 store 操作返回 `notConfigured` |
| TC-R7-I01 | INT | SSH 配置（fake native、**无 PAT**）下 `capture.request` 成功，且确实经 `git.write`/`git.commit`/`git.push` |
| TC-R7-I02 | INT | 同一配置下 `cards.list` / `review.due` / `store.probe` 可用（SC-R7-02） |
| TC-R8-U01 | UNIT | 记录 `vault` + 本机 `transparent` → 解析出的 mode 是 `vault`（SC-R8-01/02） |
| TC-R8-I01 | INT | 仓库记录 vault、本机设置 transparent → 捕获落盘为 `.enc`，仓库里不出现明文正文 |
| TC-R8-I02 | INT | 有内容时切换档位被拒（`TierMigrationRequiredError` → 可读失败码），空仓库时切换并写入 `config.json` |
| TC-REG-AUTH-01 | REG | 既有 19 E2E + 117 INT + 600 UNIT 全绿（零回归） |

**SMK**：`npm run build && npm run assert:content`（内容包仍无密钥 / native 符号）。
