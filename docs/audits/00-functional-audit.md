# 功能实现审计 — omnipilot-synapse（req-2026-09-29-synapse-workflow-elegance）

> 审计基线：判据 `docs/product/00-design-principles.md`（两轴：工作流 8 阶段 × 协作 5 特质 + W1–W6 横切判据）。
> 方法：枚举**真实对外面**（全部 message type）、**真实数据面**（CKF 四类记录）、**真实工作流面**（8 阶段），
> 逐项给 `file:line` 证据与判据编号；结论只有五种：OK / 断裂 / 死代码 / 无出口 / 静默失败。
> 扫描时间：2026-09-29 · 分支 main · 版本 0.2.0（未提交）

## 1. 枚举基线 A：全部 message type（对外面，26 项）

来源 `apps/extension/lib/messages.ts:12-38`（`REQUEST_TYPES`）。"可发"= 是否仅扩展页面可发（`SECRET_BEARING_TYPES`）。

| # | type | 可发 | 出口 / 归宿 | 结论 | 判据 | 证据 |
|---|------|------|-------------|------|------|------|
| 1 | `prefs.get` | 任何页面 | — | OK | W2 | `messages.ts:13`（`CONTENT_SCRIPT_ALLOWED_TYPES` 含它） |
| 2 | `status.get` | 扩展页 | — | OK | W2 | `messages.ts:14` |
| 3 | `inbox.list` | 扩展页 | 收件箱列表 | **断裂**：只列 `kind:'source'`，待确认卡片无法列出 | W2 | `github-store.ts:233-240` |
| 4 | `capture.request` | 任何页面 | 一次原子提交 | OK（W1 达标：一键、无表单） | W1 | `capture/service.ts:102-140` |
| 5 | `capture.page` | 扩展页 | 同上 | OK | W1 | `messages.ts:214` |
| 6 | `distill.request` | 扩展页 | 写 `cards/pending/` | **无出口**：产出后产品内无人能决定 | W2/W3/E2/E5 | `distill-service.ts:150` + 无 cards 类请求 |
| 7 | `store.probe` | 扩展页 | — | OK | W6 | `handlers.ts:243` |
| 8 | `auth.probe` | 扩展页 | 可用性原因 → i18n | OK | W6 | `auth/resolve.ts:88-108` |
| 9 | `native.status` | 扩展页 | companion 状态 | OK | W6 | `handlers.ts`（native.status 分支） |
| 10 | `sync.now` | 扩展页 | 一次提交 / 拉取 | OK（但冲突无决策面，见 §4.3） | W4 | `sync/engine.ts`（`runSync`） |
| 11 | `sync.status` | 扩展页 | 状态投影 | **静默失败**：`lastError` 是原始文本，UI 刻意不渲染 → 用户只见"失败" | W6 | `sync/cache.ts:37` + `status.ts` |
| 12 | `sync.policy` | 扩展页 | 写设置 + alarm | OK | W1 | `handlers.ts`（sync.policy 分支） |
| 13 | `search.query` | 扩展页 | 命中列表 | OK（关键词 + CJK bigram；**模糊回忆不可命中**） | W5（部分） | `search/query.ts` |
| 14 | `search.rebuild` | 扩展页 | 提交 shards | OK | W4 | `handlers.ts`（search.rebuild 分支） |
| 15 | `settings.provider` | 扩展页 | — | OK | — | `messages.ts:225` |
| 16 | `settings.github` | 扩展页 | — | OK | — | `handlers.ts:273` |
| 17 | `settings.security` | 扩展页 | — | OK（现含 authMode） | — | `handlers.ts`（settings.security 分支） |
| 18 | `settings.export` | 扩展页 | — | OK | — | `handlers.ts:312` |
| 19 | `settings.reset` | 扩展页 | — | OK | — | `handlers.ts:314` |
| 20 | `vault.setup` | 扩展页 | — | OK | — | `messages.ts` |
| 21 | `vault.unlock` | 扩展页 | — | OK | — | `messages.ts` |
| 22 | `vault.lock` | 扩展页 | — | OK | — | `messages.ts` |
| 23 | `vault.status` | 扩展页 | — | OK | — | `messages.ts` |
| 24 | `ai.ledger` | 扩展页 | 账本列表 | OK（可查可清） | W2 | `handlers.ts:346` |
| 25 | `ai.ledger.clear` | 扩展页 | — | OK | — | `handlers.ts:352` |
| 26 | `store.probe`（与 #7 同源，计一次） | — | — | — | — | — |

**计划新增（本次实现，8 项，已实现 4）**：`cards.list` · `card.decide` · `conflict.resolve` · `review.due` · `link.suggest` · `link.decide` · `note.export` · `note.mark`。

## 2. 枚举基线 B：CKF 四类记录（数据面）

来源 `apps/extension/lib/core/ckf.ts:29 / :54 / :70 / :80`（`SourceItem / KnowledgeCard / Topic / ReviewState`）。

| 记录 | 生产路径是否创建 | 是否被渲染 / 读取 | 结论 | 证据 |
|------|------------------|-------------------|------|------|
| `SourceItem` (source) | ✅ 捕获路径 | ✅ 收件箱 / 搜索 | OK | `capture/service.ts:84` |
| `KnowledgeCard` (card) | ✅ 提炼路径（写 `cards/pending/`） | ⚠️ 仅越权：`listPendingCards` 无生产调用者 | **无出口 + 死代码** | `distill-service.ts:150` · `github-store.ts:253` · 唯一调用 `github-store.test.ts:227` |
| `Topic` (topic) | ❌ 从未被任何生产路径创建 | ✅ 目录 / 搜索会读 | **死类型** | `kind: 'topic'` 仅见于 `ckf.ts:270`、`document.ts:108`、`postings.ts:197` 与测试 |
| `ReviewState` (review) | ❌ 从未被创建 | ⚠️ 只有路径与渲染支持 | **死类型** | `paths.ts:127` · `codec.ts:128`、`:168`（明确拒绝编码）· `ckf.ts:283` 与测试 |

**结论**：数据模型定义了完整工作流（4 类记录），生产代码只产出 2 类；`Topic` / `ReviewState` 已悬空三个版本周期。

## 3. 枚举基线 C：工作流 8 阶段（体验面）

| 阶段 | 现状 | 结论 | 判据 | 证据 |
|------|------|------|------|------|
| 捕获 | 页面气泡 / 右键 / popup 一键入库，无表单 | ✅ OK | W1 | `capture/service.ts` · `dom/bubble.ts` |
| 暂存 | 收件箱可见、可列 | ✅ OK | W2 | `handlers.ts:165` |
| 整理 | 无主题概念、无归属动作 | **断裂** | W2 | 无 topic 类请求 |
| 连接 | 无任何"相关笔记"能力 | **空缺** | W2/W5 | 全仓无 related / link 概念（本次 R5 才引入） |
| 提炼 | AI 结构化提案（结论 / 要点 / 场景 / 反例） | ⚠️ 有产出无决定点 | W3/E2/E5 | `distill.ts` + §1 第 6 行 |
| 复习 | 无提醒、无自评、无间隔计算 | **空缺 + 死类型** | W2 | §2 的 `ReviewState` |
| 输出 | 无引用 / 大纲 / 片段导出 | **空缺** | W5 | 无导出类请求 |
| 应用 | 无"用过 / 验证过"痕迹 | **空缺** | — | 无对应字段与请求 |

## 4. 四类问题清单（含优先级与验证方式）

### 4.1 死代码

| # | 对象 | 证据 | 优先级 | 修完如何验证 |
|---|------|------|--------|--------------|
| D1 | `GitHubStore.listPendingCards` | `github-store.ts:253`；唯一调用在测试 | **P0** | 由 `cards.list` 经 handler 调用（TC-P3-I04） |
| D2 | `Topic` / `ReviewState` 的类型与渲染路径 | §2 | **P0** | 由 G9/G10 首次真正产出（TC-P9-E01） |
| D3 | `review/state.json` 不走 codec | `codec.ts:128` | P2（有意如此） | 记录为"有意不支持"，不改 |

### 4.2 从未被创建的记录类型

| # | 对象 | 证据 | 优先级 |
|---|------|------|--------|
| U1 | `Topic` | §2 | **P0**（G9 归属建议 + 确认后创建） |
| U2 | `ReviewState` | §2 | **P0**（G10 复习队列 + 自评写回） |

### 4.3 无出口状态

| # | 状态 | 证据 | 优先级 | 修完如何验证 |
|---|------|------|--------|--------------|
| N1 | 待确认卡片 `cards/pending/` | §1 第 6 行 | **P0** | G2 的 `card.decide`（TC-P3-E01） |
| N2 | 冲突副本 `.conflict-<stamp>.md` | `reconcile.ts:55-66`；UI 三按钮只重跑 `sync.now` | **P0** | G3 的 `conflict.resolve`（TC-P4-E01） |
| N3 | 收件箱条目无"归档 / 丢弃"出口 | `inbox.list` 只读 | P1（本次不修，入 backlog） | — |

### 4.4 静默失败路径

| # | 路径 | 证据 | 优先级 | 修完如何验证 |
|---|------|------|--------|--------------|
| S1 | 同步失败只投影 `lastOutcome`，原始 `lastError` 不进 UI | `sync/cache.ts:37` + `status.ts` | **P1** | G4 的 `errorGuidance`（TC-P5-U01/U02/I01） |
| S2 | 索引缺失 / 损坏 → 仅 `needsRebuild` 标记 | `search/query.ts` | P1 | G4 指引显式包含"重建索引"动作 |
| S3 | 建议类功能无"拒绝记忆"（E4 缺失） | 全仓无本地偏好存储 | **P1** | G10（TC-P9-U03） |

## 5. 两轴判定汇总

| 轴 | 覆盖情况 |
|----|----------|
| 工作流 8 阶段 | 4 个 OK 或部分（捕获 / 暂存 / 提炼 / 检索），4 个断裂或空缺（整理 / 连接 / 复习 / 输出 / 应用） |
| 协作 5 特质 | E1 基本达标（AI 只在显式触发时工作）· E2 部分（只提案但无决定点）· E3 部分（账本在，无"为什么这样建议"）· **E4 完全缺失** · **E5 部分缺失**（可丢弃、不可改正、更不记忆） |
| W1–W6 | W1 ✅ · W2 ❌（两处无出口）· W3 ⚠️（有提案无决定）· W4 ⚠️（冲突是噪音）· W5 ⚠️（仅关键词）· W6 ❌（静默失败） |

## 6. 审计结论

产品在"捕获"这一端做得好（零压力、一键、原子提交、安全优先），但在"从信息到知识"的后半程几乎是空的：
**数据模型写满了工作流，体验只实现了一半。** 本次修复清单 = §4 的 P0/P1 项 + 新增 连接 / 输出 / 应用 三阶段（G9）
与 E4/E5 记忆（G10）；P2 与明确延后项见 `02-plan.md` 的 Open backlog。

## 7. 复审 — 本次修复后的状态（2026-09-29）

审计不是一次性文件：每条结论都要能追溯到"现在是否还成立"。以下是 §4 各条在本轮实现之后的状态，均带实现文件与验证用例。

| 原条目 | 现状态 | 实现 | 证据 |
|--------|--------|------|------|
| **N1** 待确认卡片无出口 | **已修复** | `lib/cards/decide.ts`（accept 迁址 / edit 只改白名单四字段 / discard **归档不删除**）+ handlers `cards.list`/`card.decide` + popup「待处理」区 | TC-P3-U01…U04 · TC-P3-I01/I03 · popup 挂载 6 项 |
| **N2** 冲突副本无决策面 | **已修复** | `lib/sync/conflict.ts` 三种出口 + `conflict.resolve` handler + `sync.status` 的 `conflicts[]` 摘要；**`keep-both` 不读不写**，因此是 vault 锁定时唯一可用出口 | TC-P4-U01/U02 · TC-P4-I02 |
| **D1** `listPendingCards` 死代码 | **已消除** | 由 `cards.list` 在 handler 内直接过滤 pending 段取代 | TC-P3-I01 |
| **S1** 同步失败只给结果词 | **已修复（原因）+ 动作数据就绪** | `ERROR_GUIDANCE`（**穷尽性由** `Record<ErrorCode, …>` **编译期保证**）+ 两本字典 46 键 + `performSync` 记录 `lastErrorCode`（记录后**继续抛出**） | TC-P5-U01/U02/U03 |
| **S3** 建议类无"拒绝记忆"（E4） | **未修复**（G10 计划内） | 待建 `lib/local/preferences.ts`（**只写 `storage.local`**）；`cards.list` 尚无偏好字段 | — |
| **U1** `Topic` 从未被创建 | **未修复**（G9 计划内） | 归属建议 + 确认后创建 | — |
| **U2** `ReviewState` 从未被创建 | **未修复**（G10 计划内，与 T2.6 合并） | accept 时首次写入 `review/state.json` | — |

### 7.1 两轴判定更新

| 轴 | 本次后 |
|----|--------|
| W2 归宿可见 | **两处"无出口状态"已消除**（N1/N2）；`Topic`/`ReviewState` 的产出仍待 G9/G10 |
| W3 决策权在人 | 提案与冲突都已有必须由人按下的决定点；`card.decide` 的 patch 白名单确保人只改内容、不改身份 |
| W4 可逆与可理解 | 迁址/丢弃/冲突败者一律**归档 + 路标**（`lib/core/tombstone.ts`），不删除；归档件不进可读目录但仍可取回 |
| W6 静默失败 | **部分修复**：码已穷尽、已双语、已被记录；**尚差**投影到 `publicPrefs` 与状态行渲染（T4.2/T4.3） |
| E4/E5 记忆 | 仍未实现（G10）；这是当前与理念差距最大的一项 |

### 7.2 新增对外面（本次）

7 个新 message type：`cards.list` · `card.decide` · `conflict.resolve`（已实现）· `link.suggest` · `link.decide` · `note.export` · `note.mark`（G9 计划）· `review.due`（复习队列读取，已实现）。
已实现者全部进 `SECRET_BEARING_TYPES`（仅扩展页面可发）并落在最紧的限流预算内；参数一律白名单校验（`card.decide` 的 patch、`conflict.resolve` 的路径与动作枚举）。**B.22 将在 G8 对这批新攻击面逐项复核**。


### 7.3 复审补充（2026-09-29）

- **S3（E4/E5 无记忆）→ 机制已落地、接线待做**：`lib/local/preferences.ts`（拒绝两次即抑制、接受即清除、纠正按词项记为用户自己的规则；并列时仍不出主意）+ 4 项用例；其中一条是**硬约束测试**——该模块 **import 为空**，因此私人偏好在结构上**没有任何路径**可以进入仓库。
- **U1/U2 仍是本次最欠的两项**：`Topic` 与 `ReviewState` 至今没有被任何生产路径创建；G9 的归属建议与 G10 的复习队列（含 T2.6）是关闭它们的地方，而 `lib/local/insights.ts`（recallHint / suggestTopic / dueForReview，已带测试）正是这两步的现成基底。


### 7.4 复审补充（2026-09-29，收敛）

**S1（静默失败）现在的准确状态是「原因已修复、动作待接」**，此前写作「部分修复」已不够精确：

- **已到位**：失败**码**从 `performSync` 的 catch 记录（记录后仍抛出）→ `PublicSyncState.lastFailureCode` → `syncLineParts.failure` → **状态行已渲染翻译后的原因**；码→文案由 `ERROR_GUIDANCE` 穷尽覆盖（编译期保证）并有双语键与渲染用例。
- **尚缺**：把 `failure.target` 接到动作（retry/unlock/storage/companion；`none` 不给按钮）——即 T4.3 的后半，并同时把 `describeError` 与 `ERROR_GUIDANCE` 合并为单一字典。
- **顺带修掉的一个真缺陷（第 13 轮）**：`PublicPrefs.sync` 从未被任何调用方填充，界面因此**永远显示「从未同步」**——比「缺一个字段」更严重的一类问题：**界面在不该确定的地方斩钉截铁**。

**结论更新**：审计 §4 的 P0 两条（N1/N2）已闭合；P1 的 S1 原因侧已闭合、动作侧待做；**S3（E4/E5 记忆）机制已落地、接线待做**；U1（`Topic`）仍未被创建——它是 G9 的目标，也是这份审计里最后一条真正的「数据模型里有、工作流里没有」。

