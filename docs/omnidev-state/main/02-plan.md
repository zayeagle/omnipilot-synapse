---
version: 5
previous_version: 4
artifact: 02-plan.md
requirement_id: req-2026-09-29-synapse-workflow-elegance
complexity: L
total_tasks: 39
groups: 11
last_updated: 2026-09-29T18:30:00+08:00
history_ref: 02-plan-history.md
---

# Plan: 理念入文档 · 全量审计 · 统一优化

**Build order**: 文档层 → 审计 → P0（提案闭环 → 冲突决策面）→ P1（失败可读化 → SSH 引导）→ P2（本地主动性 → 首启选择）→ 收口。
每组结束跑该组测试 + 增量 B.22 复核；每个任务必须写明 `verify:` 命令。

| Group | Theme | Pkg | Tasks | Depends |
|-------|-------|-----|-------|---------|
| G0 | 设计理念与门禁（R1） | repo | T0.1–T0.4 | — |
| G1 | 全量功能审计（R2） | repo | T1.1–T1.4 | G0 |
| G2 | 提案闭环（P0-1） | extension | T2.1–T2.7 | G0 |
| G3 | 冲突决策面（P0-2） | extension | T3.1–T3.5 | G2（契约范式） |
| G4 | 失败可读化（P1-1） | extension | T4.1–T4.4 | — |
| G5 | SSH 克隆引导（P1-2） | extension | T5.1–T5.3 | — |
| G6 | 本地主动性（P2-1） | extension | T6.1–T6.4 | G2 |
| G7 | 首启层级选择（P2-2） | extension | T7.1–T7.3 | — |
| G8 | 收口与回归 | both | T8.1–T8.3 | all |

## G0 — 设计理念与门禁（R1，`[pkg:repo]`）

- [x] **T0.1** 写 `docs/product/00-design-principles.md`（理念 → W1–W6 判据 + 判定问题 + 反例 → 每 Feature 必答四问 → CR 条目） · verify: 人工复核 + T0.4
- [x] **T0.2** 写 `AGENTS.md`（非协商规则 + 指向判据文档），并在 `README.md` 增一句立场 · verify: T0.4
- [x] **T0.3** `00-project-context.md` § Architecture Patterns 增"理念与判据"一条；确认 `04-design.md` 必答节已就位（本次已作为范式写入） · verify: 人工复核
- [x] **T0.4** 文档契约测试 `apps/extension/lib/tooling/design-docs.test.ts`（TC-DOC-U01/U02） · verify: `npx vitest run lib/tooling`

## G1 — 全量功能审计（R2）

- [x] **T1.1** 枚举三张表（`REQUEST_TYPES` 26 项 / CKF 4 类记录 / 工作流 6 阶段） · verify: 覆盖计数断言（T1.4）
- [x] **T1.2** 逐项证据矩阵（`file:line` + 判据编号 + 结论） · verify: 至少 40 条带证据的判定
- [x] **T1.3** 四类问题清单（死代码 / 未创建记录类型 / 无出口状态 / 静默失败）+ 优先级与验证方式 · verify: 每项都有 P 级与验证命令
- [x] **T1.4** 审计契约测试（TC-DOC-U03/U04） · verify: `npx vitest run lib/tooling`

## G2 — 提案闭环（P0-1）`[pkg:extension]`

- [x] **T2.1** 契约：`cards.list` / `card.decide` 加入 `REQUEST_TYPES` + payload 类型 + 校验器 + `SECRET_BEARING_TYPES` + i18n 键 · verify: UNIT `lib/messages.test.ts`
- [x] **T2.2** codec：卡片路径依 `status` 推导（pending → `cards/pending/`，confirmed → `cards/`），保持 vault 加解密不变 · verify: UNIT `lib/store/codec.test.ts`
- [x] **T2.3** 决策逻辑（纯 + 提交）：accept / edit / discard 的文件集计算与一次提交 · verify: UNIT `lib/cards/decide.test.ts`
- [x] **T2.4** handlers：`cards.list` / `card.decide` 接线（限流 + 错误映射 + vault 锁定拒绝） · verify: INT `lib/background`
- [x] **T2.5** popup"待处理"区（标题/摘要/要点/来源 + 三动作 + 空态） · verify: UNIT `lib/ui/render.test.ts` + E2E TC-P3-E01
- [x] **T2.6** accept 后写 `review/state.json`（ReviewState 首次产出） · verify: INT TC-P3-I02
- [ ] **T2.7** 测试补全（TC-P3-U01…U04 / I01–I04 / E01） · verify: `npx vitest run` + `npx playwright test e2e/cards.spec.ts`

## G3 — 冲突决策面（P0-2）

- [x] **T3.1** `sync.status` 扩展冲突摘要（双方时间/体积/可读性） · verify: UNIT TC-P4-U01
- [x] **T3.2** `conflict.resolve` 三种动作的文件集与归档路径（`archive/conflicts/**`） · verify: UNIT TC-P4-U02
- [x] **T3.3** handler + `syncState.conflicts` 清理 + shards 刷新 · verify: INT TC-P4-I01/I02
- [x] **T3.4** 同步页签冲突行 UI（摘要 + 三选一 + 执行后回到无冲突） · verify: E2E TC-P4-E01
- [ ] **T3.5** 测试补全 · verify: `npx vitest run` + `npx playwright test e2e/sync.spec.ts`

## G4 — 失败可读化（P1-1）

- [x] **T4.1** `errorGuidance(code)`（穷尽 `ErrorCode`）+ 双语键 · verify: UNIT TC-P5-U01/U03
- [x] **T4.2** `StatusLine.lastFailure`（无原文/路径/内容） · verify: UNIT TC-P5-U02
- [ ] **T4.3** 状态行渲染"最近失败 + 去处理/重试" · verify: INT TC-P5-I01 + E2E 回归
- [ ] **T4.4** 测试补全 · verify: `npx vitest run`

## G5 — SSH 克隆引导（P1-2）

- [x] **T5.1** `cloneCommand` / `repoRootError` 纯函数 · verify: UNIT TC-P6-U01/U02
- [ ] **T5.2** options SSH 区块展示命令 + 一键复制 + 路径校验 · verify: UNIT `lib/ui/auth-form.test.ts` + `npm run build`
- [ ] **T5.3** 测试补全 · verify: `npx vitest run lib/ui`

## G6 — 本地主动性（P2-1）

- [x] **T6.1** `lib/local/insights.ts`（`recallHint` / `suggestTopic` / `dueForReview`，纯函数、零出网） · verify: UNIT TC-P7-U01…U03
- [x] **T6.2** 复习队列呈现（popup 待处理区"今天该复习 N 条"） · verify: UNIT `lib/ui/render.test.ts`
- [x] **T6.3** 捕获命中提示（不阻塞捕获） · verify: INT TC-P7-I01
- [ ] **T6.4** 测试补全 · verify: `npx vitest run`

## G7 — 首启层级选择（P2-2）

- [ ] **T7.1** 首启状态判定 + 选择写入 store config（不静默默认） · verify: UNIT TC-P8-U01/U02
- [ ] **T7.2** options 首启一步 UI（各配一句人话后果） · verify: UNIT `lib/ui/format.test.ts`
- [ ] **T7.3** E2E 首启强制选择 · verify: E2E TC-P8-E01

## G8 — 收口与回归

- [ ] **T8.1** 全量回归（extension UNIT/INT/E2E/SMK/REG + companion UNIT/SYS）+ build + `assert:content` · verify: 见 05-test-plan 追溯表
- [ ] **T8.2** B.22 安全审计增量复核（3 个新 request type + 2 个新归档路径 + StatusLine 投影）并更新 `07-security-audit.md` · verify: PASS
- [ ] **T8.3** 文档同步（`README.md` / `00-project-context.md` / `03-progress.md` / plan 勾选）+ 记录 Open backlog · verify: 人工复核

## Mid-Phase Gates（B.15）

| Gate | Trigger | Rule |
|------|---------|------|
| `pre_dev` | G0 之前 | L 复杂度：硬门，autopilot 已确认（`/od auto`） |
| `change_impact` | 每组结束 | autopilot 下自动确认，除非偏离 `04-design.md` |
| 安全审计 | Phase 3 退场 | B.22：新 request type 属新攻击面，必须 PASS |

## Open backlog（明确延后，不在本次交付）

1. **P1-3 检索增强**（本地词项扩展 / 本地向量；默认关、零出网）——需要独立设计与评测方法。
2. **生成式 AI 主动性**（AI 生成复习问题、跨笔记关联）——涉及出网与隐私取舍，需单独 spec。
3. **多设备协同**（同一账号多端并发编辑的冲突前置避免）——本次只把冲突变成"一次决定"，未消除冲突本身。
4. **`apps/miniprogram`**（微信小程序端）——既有 deferred 项。

## Notes

- 三个新 request type 全部扩展页面可发（`SECRET_BEARING_TYPES`）并落在最紧的限流预算里；这是 A2（blocking 假设）的验证方式。
- 归档路径（`archive/**`）不进入 `NOTES.md` 目录，避免污染"可读目录"，但文件仍在仓库、可检索到路径。
- 任何对既有断言的修改必须在 `03-progress.md` 记录理由（A6）。

---

## Revision 5 — 新增任务（理念细化后）

| Group | Theme | Tasks | 依赖 |
|-------|-------|-------|------|
| G9 | 连接 / 输出 / 应用（本地优先） | T9.1–T9.6 | G2（卡片决定）· G6（本地规则） |
| G10 | E4/E5 记忆与抑制 | T10.1–T10.3 | G9 |

- [ ] **T9.1** `lib/local/links.ts`：相关记录计算 + **理由**生成（共享标签/词项/主题） · verify: UNIT TC-P9-U01
- [ ] **T9.2** CKF 增 `related_ids` + codec/索引兼容（旧记录仍可解析） · verify: UNIT `lib/core/ckf.test.ts` + `lib/store/codec.test.ts`
- [ ] **T9.3** 契约 `link.suggest` / `link.decide`（校验：id 归属、动作枚举） · verify: UNIT `lib/messages.test.ts`
- [ ] **T9.4** `note.export` / `note.mark`（引用/大纲/片段 + 使用痕迹） · verify: UNIT TC-P9-U04/U05
- [ ] **T9.5** popup"待处理"三段式（卡片 / 相关建议 / 今日复习）+ 复制动作 · verify: UNIT `lib/ui/render.test.ts` + E2E TC-P9-E01
- [ ] **T9.6** handlers 接线（7 个新类型全部进 SECRET_BEARING + 限流） · verify: INT `lib/background`
- [ ] **T10.1** `lib/local/preferences.ts`（抑制集 / 主题偏好 / 已接受链接；只写 `storage.local`） · verify: UNIT TC-P9-U03/U06 + INT TC-P9-I01
- [ ] **T10.2** 建议路径接入偏好（建议前过滤、拒绝后记录） · verify: UNIT + INT TC-P9-I02
- [ ] **T10.3** CR 清单自查：E4/E5 是否真的生效（拒绝两次不再出现；纠正被下次采用） · verify: E2E TC-P9-E01

**因此本次任务总数：30 → 39；新增 request type：3 → 7。** 若容量不足，优先保 P0（G2/G3）与参考旅程（G9/G10），
其余可整体延后 —— 该取舍在 2026-09-29T19:00:00+08:00 由用户确认（见 session-log）。

### 进度快照（2026-09-29）

已完成（勾选）：G0 全部 · G1 全部 · T2.1–T2.6 · T3.1–T3.4 · T4.1（表 + 双语键 + 状态行渲染）· T5.1 · T6.1。
尚无勾选者见上方列表——它们正是下一轮的入口，没有任何一项被静默丢弃。

**本轮新增两条待办（由实现过程中发现的重复与缺口而来）**：

1. **合并错误字典**：「describeError」（lib/ui/format.ts，UI 用）与 「ERROR_GUIDANCE」（lib/status.ts，投影用）职责重叠——**两张表描述同一件事迟早分叉**，应合并为一处并从另一处派生。
2. **G10 读侧契约**：新增 review.due（无 payload）→ 读 review/state.json → 复用 lib/local/insights.ts 的到期规则 → popup 显示「今天该复习 N 条」。数据源（写入方）与规则（形状已对齐）均已就绪，缺的只是这一跳。


### T4.3 执行计划（已勘明依赖方向与副作用，供下一轮直接照做）

**目标**：把两张错误表合并为一处真相，并把失败**动作**接到界面。

1. **依赖方向已勘明**：`lib/ui/format.ts` → `lib/status.ts` 是**无环**的（status.ts 只依赖 i18n 与类型，不反向依赖 format.ts）。因此让 `describeError` **从 `ERROR_GUIDANCE` 派生** message/hint 是安全的，方向正确。
2. **已知副作用（必须在同一次提交里处理）**：`lib/ui/format.test.ts` 里针对 `describeError` 的期望文本会随派生而改变——**这些断言必须一起更新**，否则会留下「代码改了、测试说旧话」`的假绿。执行时应先读该测试文件里 `describeError` 相关段落，再改实现。
3. **动作接线**：`syncLineParts.failure` 已含 `target`（`storage | sync | unlock | retry | companion | none`）。popup 的状态行旁加一个按钮：
   `retry` → 直接调 `sync.now`；`unlock` → 聚焦口令输入；`storage`/`companion` → 打开 options 对应页签；`none` → 不给按钮（不给无用的按钮也是一种诚实）。
4. **完成判据**：状态行既显示原因也给出唯一动作；`describeError` 与 `ERROR_GUIDANCE` 不再各自定义同一件事（可加一条测试断言两者对同一码给出同一键）。

**为什么本轮只写计划不动手**：这一改动会波及既有断言，而我当前的会话余量不足以「先读测试、再改实现、再验证」走完一轮。**半改留下的红灯比不改进更糟**——这条纪律本次已多次执行，此处继续。

