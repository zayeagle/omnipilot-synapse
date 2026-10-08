---
version: 5
previous_version: 4
artifact: 04-design.md
requirement_id: req-2026-09-29-synapse-workflow-elegance
design_split: false
last_updated: 2026-09-29T18:20:00+08:00
history_ref: 04-design-history.md
---

# Design — 设计理念入文档 · 全量功能审计 · 统一优化

> 每个 Feature 必须回答 **工作流与协作四问**（R1 的落地形式，本文件即范式）：
> ① 用户此刻在知识工作流的哪一步？② 这一步谁做决定（人还是 AI）？③ 决定后产物去哪、能不能撤回？
> ④ 失败时用户 3 秒内知道该做什么吗？答不出就不是一个完整的设计。

## Feature F1: 判据门禁文档

### Business Context
- **Related**: 所有 Feature；评审与 Phase 1/2 的输入
- **Impact**: 把理念从"人脑里的偏好"变成可指认的判据，否则每次都要重新争论

### Implementation Logic
1. 新增 `docs/product/00-design-principles.md`：理念表述 → 6 条判据（W1–W6，每条含"判定问题"+"当前反例"）→ 每个 Feature 必答四问 → CR 条目。
2. 判据必须**可判定**：能指着具体实现回答是/否。不可判定的表述不许进文档（如"体验要好"）。
3. 新增 `AGENTS.md`：非协商规则（安全 P0、判据门禁、证据要求、不新增依赖）+ 指向判据文档。
4. `README.md` 增一句立场并指向文档；`04-design.md` 增必答节（本文件即是）。

### 工作流与协作
① 横切全部阶段 ② 人（评审者）③ 产品是文档，可修订并留档 ④ 文档缺失/漂移由 `AGENTS.md` + CR 条目兜住

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `docs/product/00-design-principles.md` | new | 判据 + 反例 + 必答四问 + CR 清单 |
| `AGENTS.md` | new | 非协商规则；指向判据文档 |

## Feature F2: 全量功能审计

### Business Context
- **Related**: R3 的全部修复项由它产出
- **Impact**: 没有审计基线，"统一优化"就会退化成凭印象改几处

### Implementation Logic
1. 枚举基线三张表：`REQUEST_TYPES`（26 项，逐项判定可达性与出口）、CKF 4 类记录（是否被生产路径创建/渲染/更新）、
   工作流 6 阶段（Capture→Inbox→Distill→Place→Retrieve→Review，每阶段的进入/处理/离开是否存在）。
2. 每条结论一行证据：`file:line` + 判据编号（W#）+ 结论（OK / 断裂 / 死代码 / 无出口 / 静默失败）。
3. 单列四类问题（死代码、从未被创建的记录类型、无出口状态、静默失败路径），每项给 P0/P1/P2 与理由。
4. 每条修复项写明"修完如何验证"（测试 ID 或命令），使其同时成为回归清单。

### 工作流与协作
① 横切 ② 人（评审者决定优先级）③ 报告入库、带行号可复核 ④ 过期由判据门禁触发重审

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `docs/audits/00-functional-audit.md` | new | 三张枚举表 + 证据 + 四类问题 + 优先级 |

## Feature F3: 提案闭环 — 待确认卡片可见、可决定（P0-1）

### Business Context
- **Related**: F7（卡片被接受后才谈得上复习）、R2 的头号发现
- **Impact**: 现状是"AI 提案 → 一条 git 路径通知 → 人没有被给予决定的地方"，AI 协作价值链在此断掉

### Implementation Logic
1. **契约（Phase 2 冻结）**：`cards.list` `{limit?}` → `{cards:[{id,path,title,summary,points,tags,topic?,created_at}]}`；
   `card.decide` `{id,path,action:'accept'|'edit'|'discard',patch?}` → `{card?,path}`。两者进 `SECRET_BEARING_TYPES` + 限流预算。
2. **accept**：`card.status='confirmed'` → 路径改为 `cards/`（pending 时是 `cards/pending/`，由 codec 依据 status 推导）；
   同一次提交内更新 index 与 shards；成功后写 `review/state.json`（ReviewState 首次真正被创建，due = now + 1d）。
3. **edit**：白名单字段 `title/summary/points/tags` + 长度上限，重新编码到原路径（仍 pending）+ 索引 + shards，一次提交。
4. **discard**：移入 `archive/cards/<原相对路径>`，索引移除、shards 清除，一次提交 —— **归档而非删除**。
5. **vault 模式**：必须过 codec（decode → 改 → encodeRecord）；锁定时拒绝并提示解锁（同 SC-F5-04 规则），不缓存密文当明文。
6. **界面**：popup 新增"待处理"区（标题/摘要/要点/来源链接 + 接受·改写·丢弃三动作），空态明确显示"没有待处理"。

### Edge Cases
- Happy：一张 pending 卡片被接受 → 离开 pending、进入 cards/、并出现在复习队列
- Err1：卡片 id 存在但 path 不符（别处改过）→ 以 path 为准并在响应返回实际路径，不静默
- Err2：vault 锁定 → `locked`，不写任何字节
- Err3：`cards.list` 读索引失败 → 返回空列表 + 标记，不抛异常
- Boundary：100 张 pending → 分页上限；一次请求只处理一张卡片

### 工作流与协作
① Distill→Place 之间 ② **人在此决定**（AI 只提案一次）③ 产物进 `cards/` 或 `archive/cards/`，两处都可再改（各自一次提交）④ 失败映射到 F5 指引

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `REQUEST_TYPES` | +2 | `cards.list` / `card.decide` |
| `KnowledgeCard.status` | 首次真正被改写 | pending → confirmed 触发路径迁移 |
| `ReviewState` | 首次被创建 | 接受卡片时写 `review/state.json` |
| 仓库路径 | +1 | `archive/cards/**` |

## Feature F4: 冲突决策面（P0-2）

### Business Context
- **Related**: 与 F3 同类的"无出口状态"，发生在同步路径上
- **Impact**: `.conflict-<stamp>.md` 保住了数据却制造噪音；用户需要一个"一次决定"的地方

### Implementation Logic
1. `sync.status` 的 `conflicts` 扩展为每项 `{path, conflictPath, mine:{updatedAt,bytes}, theirs:{updatedAt,bytes}, readable}`；
   `readable=false` 表示 vault 未解锁（不给正文，只给可否比较）。
2. 新类型 `conflict.resolve` `{path,conflictPath,action}`（进 `SECRET_BEARING_TYPES` + 限流）：
   - `keep-mine`：本地版本写回主路径，远端版本移入 `archive/conflicts/<path>`；一次提交。
   - `keep-remote`：主路径保持远端版本，本地版本移入 `archive/conflicts/<path>`；一次提交。
   - `keep-both`：`.conflict-` 兄弟文件移入 `archive/conflicts/<path>.conflict-<stamp>`，主路径不再有噪音，两个索引项都保留。
3. 三种动作都把该 path 从 `syncState.conflicts` 移除并刷新 shards；归档件不进 `NOTES.md` 目录。
4. **界面**：同步页签冲突行给双方摘要 + 三选一；完成后回到"无冲突"。

### Edge Cases
- Happy：两侧都改过 → 决策后主路径唯一，归档件仍可找回
- Err1：vault 锁定 → 允许 `keep-both`（无需读内容），需要读内容的两项拒绝并提示解锁
- Err2：决策执行时远端又变 → 提交冲突保留 dirty，下次同步再决策（不吞）
- Boundary：同一分钟内多次冲突 → 归档名带 stamp，互不覆盖

### 工作流与协作
① 同步阶段（Retrieve/Review 之前）② **人在此决定**（默认不动，等决定）③ 胜者占主路径、败者进 `archive/conflicts/` 可再取回 ④ 失败走 F5

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `sync.status` payload | extended | `conflicts[]` 带双方摘要与可读性 |
| `REQUEST_TYPES` | +1 | `conflict.resolve` |
| 仓库路径 | +1 | `archive/conflicts/**` |

## Feature F5: 失败可读化（P1-1）

### Business Context
- **Related**: F3/F4 的错误出口；判据 W6
- **Impact**: 现在失败只显示一个词；`status.ts` 刻意不渲染原始错误（保留这项卫生决策），但没有替代品

### Implementation Logic
1. `lib/status.ts` 增 `errorGuidance(code)` → `{titleKey, actionKey, target}`，`target ∈ {storage, sync, unlock, retry, companion}`。
2. `StatusLine` 增 `lastFailure`（code + 翻译键 + 目标 + 时间），**不含**原始文本/路径/内容。
3. `lib/i18n.ts` 为每个 `ErrorCode` 增双语两条键（标题 + 该做什么），parity 测试兜住。
4. 状态行渲染"最近失败：<标题> · [去处理]"；`retry` 目标直接触发 `sync.now`，其余跳到对应设置页签。

### Edge Cases
- Happy：离线同步失败 → "网络不可用，稍后自动重试" + 一键重试
- Err1：未知错误码 → 通用文案，永不显示原文
- Boundary：连续失败 → 只显示最近一次

### 工作流与协作
① 横切（任何后台动作失败）② 人（知道该做什么）③ 无产物变更 ④ 本条就是对 W6 的回答

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `StatusLine` | extended | `lastFailure` |
| `lib/i18n.ts` | +N | 每个 ErrorCode 的双语指引 |

## Feature F6: SSH 克隆引导（P1-2）

### Business Context
- **Related**: F5（companion 未装、克隆缺失都是失败路径）
- **Impact**: "SSH 需要本地克隆"是不可消除的物理事实，但只在 UI 声明一句等于把工作留给用户

### Implementation Logic
1. `lib/ui/auth-form.ts` 增纯函数 `cloneCommand(remoteUrl, repoRoot)` → `git clone <remote> <root>`（remote 用用户自己的 owner/repo 拼）。
2. options 存储页在 SSH 区块展示该命令 + 一键复制 + 克隆路径校验（绝对路径、非空、不与仓库根冲突）。
3. 保存/探测时若 `git.probe` 返回的 root 与填写路径不一致 → 明确说"这个路径不是仓库"，不泛泛失败。

### Edge Cases
- Happy：填路径 → 命令可复制 → 探测通过
- Err1：路径不存在 → 明确提示，命令仍可复制
- Boundary：Windows 反斜杠路径也要给出可复制命令

### 工作流与协作
① 配置阶段 ② 人（复制并执行）③ 无产物变更 ④ 探测失败映射到 F5

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `lib/ui/auth-form.ts` | extended | `cloneCommand` / `repoRootError` |

## Feature F7: 本地主动性 — 去重提示 / 归属建议 / 复习队列（P2-1，仅本地规则）

### Business Context
- **Related**: F3（卡片被接受后才谈得上复习）；判据 W2/W5
- **Impact**: 把 `Topic` / `ReviewState` 两个"死类型"变成工作流的一部分；全程零出网

### Implementation Logic
1. `lib/local/insights.ts`（纯函数）：`recallHint`（复用 dedup keys + 词项重叠）、`suggestTopic`（top-1 重叠 + 阈值，低于阈值给"无建议"）、
   `dueForReview`（简化 SM-2：间隔 × 易度）。
2. `review/state.json` 由 F3 的 accept 首次写入；`dueForReview` 只读它 + 卡片标签。
3. 呈现：popup 待处理区显示"今天该复习 N 条"与列表；捕获命中历史时提示"你 X 前存过相似内容"（**不阻塞捕获**）。
4. **不使用模型、不联网**；生成式建议与语义检索进 `open backlog`（下一需求）。

### Edge Cases
- Happy：重复捕获 → 命中提示；卡片接受 → 次日进入复习队列
- Err1：无缓存/索引 → 静默跳过，不报错不阻塞
- Boundary：相似度并列 → 显示"无建议"（宁可不说，也不误导）

### 工作流与协作
① Retrieve / Review ② AI（本地规则）建议、**人**决定 ③ 提示不写数据；复习状态由人的接受动作产生 ④ 失败静默跳过且不阻塞捕获

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `ReviewState` | 首次被读取 | `dueForReview` 计算复习队列 |
| `lib/local/insights.ts` | new | 三个纯函数 + 测试 |

## Feature F8: 首启显式选择加密取舍（P2-2）

### Business Context
- **Related**: 判据 W4（可理解）、F6 的配置流程
- **Impact**: 现状替用户默认了透明仓；对个人私密笔记，这个默认应由用户拍板

### Implementation Logic
1. 首次进入存储配置（store config 不存在且从未选择）→ 渲染一步：两个选项各配一句人话后果
   （透明仓="仓库里直接可读，托管方能看全部" / 保险库="托管方看不到内容，需要本设备口令"）。
2. 选择写入 store config（`saveStoreConfig`）；不选不给过（不静默默认）。
3. 已存在的仓库继续遵从其 config（`resolveTier` 既有规则不变）。

### Edge Cases
- Happy：首启选择 → config 落盘 → 后续遵从
- Err1：已有内容但无 config → 沿用 fail-closed（vault）+ 要求确认
- Boundary：中途离开 → 下次进入仍是这一步（未完成可恢复）

### 工作流与协作
① 配置阶段 ② **人**选择 ③ 写 config，可改（切换走既有 `switchTier`）④ 失败映射 F5

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| options 首启流程 | new | 一步显式选择 |
| `StoreConfig.security_mode` | shape 不变 | 由显式选择写入 |

## 数据变更汇总（本需求）

| 类别 | 变更 |
|------|------|
| 新 request type | `cards.list` · `card.decide` · `conflict.resolve`（全部 SECRET_BEARING + 限流） |
| 扩展 payload | `sync.status.conflicts[]` · `StatusLine.lastFailure` |
| 新仓库路径 | `archive/cards/**` · `archive/conflicts/**`（不进 NOTES.md 目录） |
| 首次激活的既有类型 | `KnowledgeCard.status` 流转 · `ReviewState` 读写 |
| 配置 | `.omnipilot/config.json` 结构不变（首次由用户显式选择写入） |
| 依赖 | **零新增** |

---

## Revision 5 — 理念细化后的增量设计（用户 2026-09-29 细化）

用户把理念细化为**两轴**：工作流 8 阶段（捕获→暂存→整理→连接→提炼→复习→输出→应用）× 协作 5 特质
（E1 时机 / E2 建议而非命令 / E3 可解释可控制 / E4 学习偏好 / E5 错误可纠正）。据此增量设计：

- **F1 判据文档**：已按两轴重写（`docs/product/00-design-principles.md`，130 行），并新增 `AGENTS.md` 与 README 立场。
- **F7 扩展（E4/E5 记忆）**：新增 `lib/local/preferences.ts`（纯函数 + `storage.local` 持久化，**只存本地、绝不进仓库**）：
  被拒建议的抑制集、用户纠正形成的"词项→主题"偏好、接受过的链接。`localPrefs` 只进 `storage.local`。
- **F9 连接与输出（新增，服务 连接/输出/应用 三阶段）**：
  ① `link.suggest` —— 本地算相关记录，**必须带理由**（共享标签 / 共享词项 / 同一主题），供人确认；
  ② `link.decide` —— 接受则写入记录的 `related_ids`（CKF 增可选字段），拒绝则写入 F7 的抑制集（E4）；
  ③ `note.export` —— 一键产出引用 / 主题大纲 / 片段 Markdown 供复制（不做编辑器）；
  ④ `note.mark` —— "已使用 / 已验证" 打标，写入本地（`review/state.json` 的 `applied_at`），只记录不推断。
- **新增 request type 合计**：`cards.list` · `card.decide` · `conflict.resolve` · `link.suggest` · `link.decide` ·
  `note.export` · `note.mark`（7 个，全部 SECRET_BEARING + 限流）。
- **CKF 变更**：`SourceItem` / `KnowledgeCard` 增可选 `related_ids?: string[]`（不破坏既有解析）。
- **界面**：popup 的"待处理"区扩展为三段——待确认卡片 / 相关记录建议（带理由）/ 今日复习；options 同步页签增"使用痕迹"。

### 工作流与协作（F9 的四问）
① 连接/输出/应用（此前完全空缺的三阶段）② AI（本地规则）建议、**人**决定；输出与应用由人主动触发 ③ 链接写进记录、
拒绝写进本地偏好、打标写进 review state，均可撤回 ④ 任一失败静默跳过，绝不阻塞捕获与同步。

### 风险（追加）
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| 新增 4 个 request type 使对外契约与攻击面扩大 | 中 | 中 | 全部 SECRET_BEARING + 限流 + B.22 专项；`link.decide` / `note.mark` 只接受受限 id 与路径并校验归属 |
| 偏好/抑制如果误存进仓库会泄露用户习惯 | 低 | 高 | 硬性约束：只写 `storage.local`；B.22 与 CR 清单各查一次 |
| 建议数量过多变成噪音（违反 E1） | 中 | 中 | 每类建议单次只给 top-1，且必须带理由；被拒两次即抑制 |
## Archived 2026-09-30 - req-2026-09-30-synapse-auth-tier-integrity
---
version: 6
previous_version: 5
artifact: 04-design.md
requirement_id: req-2026-09-30-synapse-auth-tier-integrity
history_ref: 04-design-history.md
---

# Design (delta) — 授权模式与档位契约

上游：`docs/product/00-design-principles.md`（必答四问）。涉及 AI 的 E1–E5：本次 **n/a**（不改任何 AI 路径）。

## F10 — 授权模式无关的仓库门面（R7）

**问题**：`resolveStore()` 硬要求一个 PAT 并构造 token 版 store；只有同步路径按 `authMode` 走 SSH。于是 SSH 用户在界面上"已配置"，实际**捕获/提炼/卡片/复习/冲突/探测全部不可用**。

**设计**：
- 新增 `lib/store/repo-store.ts`：`RepoStore` 接口（`KnowledgeStore` + 索引/记录/提交/URL 这层便利方法）与 `createRepoStore(knowledge, { codec, prefix, repoFullName, branch })`。
- `GitHubStore` **结构上**已满足 `RepoStore`（不改造它）；SSH 侧用 `GitTransportStore` + `createRepoStore` 得到同一形状。
- `resolveStore()` 改为走 `resolveAuth()`：token → GitHubStore；SSH → companion 传输的 `RepoStore`。所有 handler 与服务面向 `RepoStore` 编程，**只有一处**决定"用哪个模式"。
- 门面不引入新语义：索引/记录的解析与合并复用 `lib/store/tier.ts` 的纯函数（`parseIndex`/`mergeIndex`/`indexToFile`）。

**四问**：
1. 工作流阶段：全阶段（捕获 → 暂存 → 整理 → 检索 → 复习都经 store）。
2. 谁的动作：选定 SSH 的用户的所有动作。
3. 与谁冲突：与 token 路径冲突 —— 用同一接口消除"两套语义"。
4. 失败可见：`notConfigured` 不再伪装成"已配置"；不可用的能力在状态面上可见。

## F11 — 档位以仓库记录为准（R8）

**问题**：`resolveTier`/`loadStoreConfig`/`switchTier` 只有测试调用；运行时选 codec 的唯一依据是本机 `settings.securityMode`，而 `config.json` 写了却从不被读。后果：transparent 端可把**明文写进 vault 仓库**（不降级原则被绕过），vault 端可把密文写进 transparent 仓库。

**设计**：
- `resolveStore`/`resolveSyncRemote` 先 `loadStoreConfig({ store, prefix }, fallback = settings.securityMode)`，以结果的 `security_mode` 构造 codec/仓库（**仓库记录优先**；新仓库落到本机设置）。
- token 模式下 `GitHubStore` 需要 mode 才能构造：先以本机设置构造一次，读到记录不一致时再以记录构造一次（**只在分叉时多一次** —— 那正是被修的 bug 场景）。
- 切换档位复用 `settings.security`：handler 在 patch 之前判断 —— 仓库已有内容 → 用 `switchTier` 的守卫拒绝（可读原因 + 动作）；仓库为空 → patch 并写入 `config.json`。**不新增 message type**。

**风险**：每次构造 store 多读一次 config（一次请求，可接受）；SSH 门面没有 GitHub 的 ETag 缓存 → 由 companion 的 git 负责。

## 变更边界

- 不改 UI 结构，只改失败文案与"已配置"的判定。
- 不动 companion 协议（op 白名单不增加）。
- 已接受风险沿用：S4-02（TOCTOU）· S6-01（stderr 路径）· 可选主机权限 `https://*/*`。
