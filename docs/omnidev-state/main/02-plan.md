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
- 本地文件导入（md/pdf/txt）仍是需求里未实现的输入通道，属独立需求，本需求不做。
- 从右键菜单直接「存为笔记」需要能程序化打开 popup（MV3 仅 Chrome 127+ 支持），暂不做。

- **SSH 模式不能删除文件**：伴生进程的写入操作只能新增/覆盖，因此真删除目前仅在 Token（REST）模式可用；SSH 下以 `deleteUnsupported` 明确拒绝并提示「切到 Token 模式，或改用归档」。要补齐需给伴生进程增加一个删除操作（apps/git-bridge 协议 + 测试），本次未做。
- **分片扇出已改为有界桶（本次已修）**：`shardKey` 从「词的前 2 个字符」改成 `b00…bff` 的 256 个哈希桶，一次提交被常数封顶，中文页面不再撞 `MAX_COMMIT_FILES`（实测 681 字：548 个文件 → 226 个；120 字：204 → 142），blob 并发同时提到 12，满桶约 258 个文件 ≈ 2 秒。查询侧不再靠前缀找分片，改为按桶读。

  随之而来的两条**未做**事项，需要单独排期：
  - **存量仓库必须跑一次 `search.rebuild`**：键空间变了，旧的分片文件既不是坏数据也不会再被查询命中，所以 `query` 现在把「出现了非本版本的键」判为 `needsRebuild`（把静默丢结果变成可见、可操作的状态）。设置页的「重建索引」按钮就是迁移入口，它会写入新桶并顺手删掉旧文件。**这一步需要在发布说明里写清楚**，否则老用户升级后搜索会显示「需要重建」。
  - **单个分片文件会随 KB 长大而顶到 1MB 读取上限**：`readFile` 走 `/contents/`，超过 1MB 的文件 GitHub 只返回空 content，读取会退化成「分片损坏 → 需要重建」。桶数固定 256 意味着总索引被切成 256 份，笔记量到几千篇量级时单文件就可能过线；英文的旧前缀方案在更大规模上也有同样的隐患，分桶只是把这个拐点提前了。要彻底解决需要自适应桶数或改走 blob API 读取，属独立需求。
- **每次剪藏都会探测仓库**（`GitHubStore.assertWritable` → `probeRepo`）：这是一个刻意的取舍——仓库被改成 public 之后必须立刻停止写入，缓存探测会留出最长一个 TTL 的窗口。本次保留了它，没有用缓存换掉这一趟请求。