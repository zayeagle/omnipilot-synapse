# Plan - req-2026-09-30-synapse-manual-entry

Feature: **F11 手工录入（写笔记）** · 复杂度 M · autopilot

- [x] **T1** [extension] 载荷构造 + note 语义修正 · feature: F11 · outputs: lib/ui/format.ts (noteCapturePayload), lib/capture/service.ts (buildItem) · depends: - · verify: npx vitest run lib/ui/format.test.ts
- [x] **T2** [extension] popup 写笔记面板 + 样式 + 双语文案 · feature: F11 · outputs: entrypoints/popup/main.ts, entrypoints/popup/style.css, lib/i18n.ts · depends: T1 · verify: npx tsc --noEmit && npm run build
- [x] **T3** [extension] 测试（UNIT + INT）· feature: F11 · outputs: lib/ui/format.test.ts, lib/capture/service.test.ts, lib/background/handlers.int.test.ts · depends: T1,T2 · verify: npm test && npm run test:int
- [x] **T4** [extension] 安全审计 + 文档同步 · feature: F11 · outputs: 07-security-audit.md, 03-progress.md, 08-spec.md · depends: T3 · verify: npm run assert:content

## Traceability
| Task | Feature | TC-IDs | SC |
|------|---------|--------|----|
| T1 | F11 | U01-U06 | SC-F11-01..03 |
| T2 | F11 | - (surface) | SC-F11-01 |
| T3 | F11 | I01, I02, S01, R01 | SC-F11-01, 02, 04 |
| T4 | F11 | - | - |

## Task Groups
| Group | Tasks | Gate |
|-------|-------|------|
| G1 | T1, T2, T3, T4 | Pre-Dev gate (soft under autopilot) -> Dev -> Phase 3 exit security audit |

## Open Backlog

### 决策记录：索引改本机（F16，2026-10-10）

业主选定方案 B：检索索引只存本机（IndexedDB），仓库只保留记录。设计见 04-design 的 F16 一节。

实施顺序：
1. 扩 `SyncRemote.commitFiles` 支持 `deleted`（token 路径用 `sha: null`；SSH 路径 `deleteUnsupported`）。
2. 索引存储改为 IndexedDB + 固定 64 桶 + `builtForHead` 陈旧判定。
3. 迁移：删除仓库中既有 `search/**`。
4. 检索路径改读本机索引；同步后自动更新索引。
5. 测试与实测（改前/改后：捕获请求数、仓库文件数、检索与重建耗时）。

顺带解决：Open Backlog 中「vault 档位下检索分片是明文」一项随本改动**根除**（索引不再进仓库）。

### 检索修复进展（2026-10-09）

**已修（但不是根因）**：lib/search/index.ts 的候选筛选原先在列表"短于上限"时就过滤，把**空列表**当成了
"没有这些分片"，于是答不上来的 store（夹具、尚未存在的目录、静默失败的列表）会**丢掉全部候选与命中**。
现在只有列表"确实列出了东西"时才用它过滤；空列表按"无法回答"处理，直接读候选。

**根因仍未修（已复现并标记）**：S 用 it.fails 标记 TC-F16-I01。实测：捕获含「能力」的笔记后查询「能力」→
2 个请求（配置读 + search 目录列表）、**0 次分片读**、命中 0；而「能力」的分片（键 bc9）**确实存在**，
needsRebuild 为 false。因此查询在"读任何东西之前"就返回了：最可能是把候选与**内存文档表**求交，而每条消息
新建的 SearchIndex 该表为空。修法：命中只需分片里的 postings（文档表用于片段展示，应作为可选增强）。

未做：c) 用 search/manifest.json 或按 HEAD sha 缓存目录列表（当前每次查询都列一遍，库越大响应越大）；
d) 重建改为增量/可中断（当前读全库）。


### 检索的两个问题（2026-10-09 实测，P0）

用测试桩实测一次检索（存一条中文笔记后立刻搜「能力」，正文里含该词）：

    SEARCH {ok:true, needsRebuild:false, hits:0, requests:2, searchMs:2,
            kinds:{contents:2},
            urls:["/contents/.omnipilot/config.json", "/contents/search"]}

**① 命中为 0（功能 bug）**：查询只发了 2 个请求（配置读 + search 目录列表），一个分片都没读，所以候选分片集合是空的。
也就是"列表 → 候选分片 → 读取"这条链在取候选这一步就断了。用户界面症状是「索引需要重建 — 请打开设置」
（needsRebuild），它由 listShards 抛错触发，与"目录不存在"是同一个判定分支。

要修两件事：
- 区分「还没有 search/ 目录」与「分片损坏」：前者应返回空结果（新仓库不该喊需要重建），后者才是 needsRebuild。
- 修取候选这一步，让查询真的读到命中分片；修好后必须把命中断言加回 TC-F16-I01
  （诊断时我把 hits>0 的断言暂时去掉以便打印指标，这是断言弱化，必须补回）。

**② 慢的真正来源不是查询本身**（2ms / 2 请求），而是：
- 每次查询都要列一遍 search/ 目录：1 个请求，但响应随分片数增长（中文笔记分片很多，几十到几百个条目），
  知识库越大越慢，且每次查询都付。
- 用户被引导点的「重建索引」才是重路径：它读每条记录再重写分片（N 次请求）。
优化方向（按收益）：a) 用 search/manifest.json（一个小文件列出分片键）替代目录列表，每次查询 1 次小读取；
b) 或把目录列表按 HEAD sha 缓存（每次同步只列一次）；c) 重建改为可中断/增量。

- 本地文件导入（md/pdf/txt）仍是需求里未实现的输入通道，属独立需求，本需求不做。
- 从右键菜单直接「存为笔记」需要能程序化打开 popup（MV3 仅 Chrome 127+ 支持），暂不做。

- **SSH 模式不能删除文件**：伴生进程的写入操作只能新增/覆盖，因此真删除目前仅在 Token（REST）模式可用；SSH 下以 `deleteUnsupported` 明确拒绝并提示「切到 Token 模式，或改用归档」。要补齐需给伴生进程增加一个删除操作（apps/git-bridge 协议 + 测试），本次未做。
- **分片扇出已改为有界桶（本次已修）**：`shardKey` 从「词的前 2 个字符」改成 `b00…bff` 的 256 个哈希桶，一次提交被常数封顶，中文页面不再撞 `MAX_COMMIT_FILES`（实测 681 字：548 个文件 → 226 个；120 字：204 → 142），blob 并发同时提到 12，满桶约 258 个文件 ≈ 2 秒。查询侧不再靠前缀找分片，改为按桶读。

  随之而来的两条**未做**事项，需要单独排期：
  - **存量仓库必须跑一次 `search.rebuild`**：键空间变了，旧的分片文件既不是坏数据也不会再被查询命中，所以 `query` 现在把「出现了非本版本的键」判为 `needsRebuild`（把静默丢结果变成可见、可操作的状态）。设置页的「重建索引」按钮就是迁移入口，它会写入新桶并顺手删掉旧文件。**这一步需要在发布说明里写清楚**，否则老用户升级后搜索会显示「需要重建」。
  - **单个分片文件会随 KB 长大而顶到 1MB 读取上限**：`readFile` 走 `/contents/`，超过 1MB 的文件 GitHub 只返回空 content，读取会退化成「分片损坏 → 需要重建」。桶数固定 256 意味着总索引被切成 256 份，笔记量到几千篇量级时单文件就可能过线；英文的旧前缀方案在更大规模上也有同样的隐患，分桶只是把这个拐点提前了。要彻底解决需要自适应桶数或改走 blob API 读取，属独立需求。
- **每次剪藏都会探测仓库**（`GitHubStore.assertWritable` → `probeRepo`）：这是一个刻意的取舍——仓库被改成 public 之后必须立刻停止写入，缓存探测会留出最长一个 TTL 的窗口。本次保留了它，没有用缓存换掉这一趟请求。