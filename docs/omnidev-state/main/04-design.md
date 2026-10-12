# Design

## Feature F17: 索引分裂修复（把 F16「索引只存本机」执行完整）

> F16 的决策与动机（索引为何不该进仓库）已归档到 `04-design-history.md`（Archived 2026-10-12）；本文件只写这次要改的部分。
> 上游：`docs/product/00-design-principles.md`（必答四问）。涉及 AI 的 E1–E5：**n/a**（不改任何 AI 路径）。

### Business Context
- Related: F16（决策已做，实现只完成读路径与重建）· F1 捕获 · F6 提交/索引/分片 · F8 就绪度 · 检索面板
- Impact: worker 的捕获 / 提炼 / 卡片写路径 · 同步（拉取后的索引维护）· 检索候选读取 · 一次性仓库迁移 · 「重建索引」结果

### Problem（实测，不是推断）：索引被劈成两半
| 环节 | 今天的行为 | 代码位置 |
|------|-----------|---------|
| 捕获 / 提炼 / 卡片 | 分片写**仓库**并随记录提交 | `shardProvider()` → `createRemoteShardStore`；`capture/service.ts` `shardsFor` |
| 重建索引 | 分片写**本机** IndexedDB | `search.rebuild` → `buildSearchIndex(..., local.store)` |
| 检索查询 | 读**本机**索引 | `search.query` → `localIndex(context)` |
| 索引新鲜度 | 签名取自 sync cache，而 cache 只在**拉取**时写 | `search.query` 的 `signatureOf`＋`sync/engine.ts` 里唯一的 `cache.put` |

两个症状同源：① 捕获不改缓存签名 ⇒ `shouldUseLocalIndex` 仍为 true ⇒ 查询继续读**不含新记录**的本机索引 ⇒「没有匹配结果」；
② 捕获的分片照旧进仓库 ⇒ 仓库 `search/` 持续增长。
独立缺陷：`search/index.ts` 的 `readShards()` 在 `listShards()` 返回**空数组**时把它当作「分片都不存在」，
候选被过滤成空集、一个分片都不读 ⇒ 0 命中（`02-plan` 记的「已修」在代码里不存在 —— 文档腐化，本文件已纠正）。

### Implementation Logic
1. **写只有一个家**：`shardProvider` / `cardShards` 改持有 `localIndex(context).store`；仓库提交里不再出现 `search/**`。
   `buildSearchIndex` 去掉仓库分片分支（`remoteShards` / `drain`）；`createRemoteShardStore` 只留给迁移列举待删路径。
2. **索引与记录同源（不变量）**：凡改变记录的路径都在**同一次操作**里更新本机索引并刷新 `builtFrom` 签名 ——
   捕获 / 提炼 / 卡片（`upsert`）· 归档 / 真删除（`remove`）· 拉取后（`rebuild`，纯本机、无网络）；
   捕获提交同时把记录写进 sync cache，让 cache 真正代表「仓库里有哪些记录」。
3. **陈旧不静默、不回落**：`shouldUseLocalIndex` 为假时不再回落读仓库（那里已无分片），返回 `needsRebuild: true`
   —— 可读原因 + 既有「重建索引」动作；索引缺失仍是 `indexMissing`。
4. **写侧的空列表不再造成损坏**：`readShards` 只在列表**确实列出了东西**时才用它过滤；空列表按「无法回答」处理，直接读
   候选。这条是**写路径的正确性** —— 把空列表当成「分片都不存在」，会让一次写入用只含自己词项的版本覆盖已有分片，静默丢掉
   其他记录的倒排。它不是「查询 0 命中」的成因：0 命中来自上面的分叉（查询读本机、写入去仓库）。
5. **一次性迁移（只删派生数据）**：由 **`search.rebuild`** 执行。重建完成的那一刻本机索引一定可用，早删会出现「仓库和本机
   都没有索引」的空窗；迁移也不做后台自动删除（不可逆动作默认不执行，且要有一次明确的用户动作）。删除仓库既有
   `search/**`（一次提交，`sha: null`），在重建结果里报出条数；无法删除时如实上报原因与替代（切 Token 模式），不假装
   删成功。删除路径由仓库返回的目录名拼接，因此先拒绝含 `/`、`\`、`.`/`..` 的名字（B.22 S4-01）。

### Edge Cases
- Happy: 捕获后立刻检索命中，且仓库提交里没有 `search/**` | Err1: 索引缺失 → `indexMissing` + 「去设置重建」 | Err2: 索引陈旧 → `needsRebuild` + 重建动作
- Boundary: 新仓库、`search/` 不存在 → 查询返回空结果，而**不是** `needsRebuild` | 迁移遇 SSH → 明确拒绝、保留旧文件，记录与检索不受影响
- 删派生数据的依据：`search/**` 全可由记录重建（`search/index.ts` 头部即写明），故不违反「可逆」；记录一个不动

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| 本机索引（IndexedDB） | 成为唯一索引存放处 | 既有 `@built` 签名键沿用 |
| 仓库 `search/**` | 迁移时删除 | 派生数据；记录不变；SSH 下报告限制 |
| sync cache | 写路径也维护 | 不新增 message type、不进新限流桶 |

### 工作流与协作四问
1. **用户做什么**：捕获、检索、重建 —— 操作与今天一致；区别是**捕获后立刻搜得到**、仓库不再增长。
2. **协作者看到什么**：仓库里只有记录；换设备各自在本机构建一次索引。
3. **失败时**：缺失 / 陈旧都有可读原因 + 重建按钮；SSH 删不掉旧分片时说明限制与替代。
4. **出口**：任何索引故障都不是死路，重建按钮始终可用，且重建是纯本机操作。

### 代价与风险（接受）
- 索引不再随仓库走：每台设备首次检索前需一次本机构建（无网络，毫秒到秒级）。
- 「忘了更新索引」的症状是搜不到刚写的东西而不是崩溃 ⇒ 每条写路径都用 INT 用例钉住。
- 迁移删的是仓库文件（派生数据，git 历史可追回），但仍显式报数。
