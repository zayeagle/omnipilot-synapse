---
version: 4
previous_version: 3
artifact: 05-test-plan.md
requirement_id: req-2026-09-29-synapse-workflow-elegance
last_updated: 2026-09-29T18:30:00+08:00
history_ref: 05-test-plan-history.md
---

# Test Plan — 理念入文档 · 全量审计 · 统一优化

分层沿用既有策略（extension: UNIT / INT / E2E / SMK / REG；companion: UNIT / SYS）。本需求**没有新增运行时依赖**，
因此不引入新测试框架；文档型交付用"契约测试"保证不会写成空壳。

## 契约测试（新增层：docs contract）

判据与审计是本次的核心交付物，如果只写文档没人守，它们会腐烂。用既有的 vitest 直接读仓库文档断言**结构性质**
（不比对全文，避免脆断言）：

| ID | 断言 |
|----|------|
| TC-DOC-U01 | `docs/product/00-design-principles.md` 存在，含 6 条判据（W1–W6）、每条一个"判定问题"与一个反例、以及"每个 Feature 必答四问"与 CR 清单 |
| TC-DOC-U02 | `AGENTS.md` 存在且指向判据文档；`README.md` 含理念立场且指向同一文档 |
| TC-DOC-U03 | `docs/audits/00-functional-audit.md` 覆盖全部 `REQUEST_TYPES`（逐项出现）、CKF 四类记录、工作流六阶段，且至少 N 条结论带 `file:line` 形式证据 |
| TC-DOC-U04 | 审计含"死代码 / 未被创建的记录类型 / 无出口状态 / 静默失败"四类清单，每项带 P0/P1/P2 与验证方式 |

## F3 提案闭环（P0-1）

| ID | 层 | 断言 |
|----|----|------|
| TC-P3-U01 | UNIT | `accept` 由 `pending` 推导出 `cards/` 路径；索引项与新路径一致 |
| TC-P3-U02 | UNIT | `edit` 只接受白名单字段与长度上限；越界/未知字段被拒 |
| TC-P3-U03 | UNIT | `discard` 生成 `archive/cards/<原路径>`，且不产生删除语义 |
| TC-P3-U04 | UNIT | vault 锁定时任何决定都返回 `locked`，零字节写入 |
| TC-P3-I01 | INT | 一次提交同时包含卡片新路径 + `index.json` + 受影响 shards（假 GitHub API） |
| TC-P3-I02 | INT | `accept` 之后 `review/state.json` 被创建，且该卡片 due 在未来 |
| TC-P3-I03 | INT | `discard` 后索引无该卡片、shards 清除、归档件仍可读 |
| TC-P3-I04 | INT | `cards.list` 在索引读取失败时返回空列表 + 标记而非抛错 |
| TC-P3-E01 | E2E | 真实 worker + stub GitHub：待处理卡片可见 → 接受 → 离开 pending 且出现在 `cards/` |

## F4 冲突决策面（P0-2）

| ID | 层 | 断言 |
|----|----|------|
| TC-P4-U01 | UNIT | 冲突摘要包含双方 updatedAt/bytes；vault 锁定时 `readable=false` |
| TC-P4-U02 | UNIT | `keep-mine` / `keep-remote` 的胜者路径与归档路径推导 |
| TC-P4-I01 | INT | `keep-mine` 一次提交后主路径为我方版本、归档件为远端版本、`syncState.conflicts` 移除该 path |
| TC-P4-I02 | INT | vault 锁定：`keep-both` 成功，需要读内容的两项被拒并提示解锁 |
| TC-P4-E01 | E2E | 冲突在同步页签可见并可三选一；执行后主路径唯一且归档件存在 |

## F5 失败可读化（P1-1）

| ID | 层 | 断言 |
|----|----|------|
| TC-P5-U01 | UNIT | `errorGuidance` 对 `ErrorCode` 全集穷尽（缺一个即失败） |
| TC-P5-U02 | UNIT | `StatusLine.lastFailure` 不含原始文本/路径/内容/密钥 |
| TC-P5-U03 | UNIT | 每条指引的双语键都存在（i18n parity 扩展） |
| TC-P5-I01 | INT | 同步失败后 `prefs.get` / `sync.status` 投影含可读失败信息且不含密钥 |

## F6 SSH 克隆引导（P1-2）

| ID | 层 | 断言 |
|----|----|------|
| TC-P6-U01 | UNIT | `cloneCommand` 对 ssh/https 远端与 Windows 路径都生成可复制命令 |
| TC-P6-U02 | UNIT | `repoRootError` 拒绝空/相对/冲突路径并给出原因 |

## F7 本地主动性（P2-1）

| ID | 层 | 断言 |
|----|----|------|
| TC-P7-U01 | UNIT | `recallHint` 命中历史记录（url_key/content_key/词项重叠）与未命中两种结论 |
| TC-P7-U02 | UNIT | `suggestTopic` 低于阈值或并列时返回"无建议" |
| TC-P7-U03 | UNIT | `dueForReview` 按到期时间排序并过滤未到期 |
| TC-P7-I01 | INT | 提示计算失败不影响捕获成功（捕获路径零阻塞） |

## F8 首启层级选择（P2-2）

| ID | 层 | 断言 |
|----|----|------|
| TC-P8-U01 | UNIT | 无 config 且未选择 → 需要选择；已有 config → 不需要（遵从既有） |
| TC-P8-U02 | UNIT | 两个选项各含一句人话后果（双语键齐全） |
| TC-P8-E01 | E2E | 首启未选择时存储保存被拒绝；选择后 config 落盘且可继续 |

## 回归与冒烟

| ID | 断言 |
|----|------|
| TC-REG-01 | 既有 12 条 E2E 全绿（本需求新增 3 条 E2E 后共 15 条） |
| TC-REG-02 | 基线不下降：extension UNIT ≥543 / INT ≥111；companion UNIT ≥48 / SYS ≥8 |
| TC-SMK-01 | `npm run build` + `npm run assert:content` 通过（新增 request type 不得进入内容包） |

## 追溯

| Feature | UNIT | INT | E2E |
|---------|------|-----|-----|
| F1/F2 文档 | TC-DOC-U01…U04 | — | — |
| F3 提案闭环 | U01–U04 | I01–I04 | E01 |
| F4 冲突决策面 | U01–U02 | I01–I02 | E01 |
| F5 失败可读化 | U01–U03 | I01 | — |
| F6 SSH 引导 | U01–U02 | — | — |
| F7 本地主动性 | U01–U03 | I01 | — |
| F8 首启选择 | U01–U02 | — | E01 |

**延后项（不进本次）**：P1-3 检索增强（本地语义/词项扩展）——需要独立设计与评测方法，草率实现会伤害检索质量；
生成式 AI 主动性；多设备协同。三者写入 `02-plan.md` 的 Open backlog。

---

## Revision 5 — 新增阶段（连接 / 输出 / 应用）与 E4/E5 的用例

| ID | 层 | 断言 |
|----|----|------|
| TC-P9-U01 | UNIT | `link.suggest` 只返回带理由的建议，且理由可读（共享标签/词项/主题三者之一） |
| TC-P9-U02 | UNIT | `link.decide` 接受后 `related_ids` 落盘；拒绝后进入抑制集 |
| TC-P9-U03 | UNIT | 同一建议被拒两次后不再出现（E4） |
| TC-P9-U04 | UNIT | `note.export` 产出引用/大纲/片段三种 Markdown，转义正确、无内容泄露风险 |
| TC-P9-U05 | UNIT | `note.mark` 只记录事实与日期，重复打标幂等 |
| TC-P9-U06 | UNIT | 用户编辑卡片主题后，下次相似内容建议匹配用户的分类（E5） |
| TC-P9-I01 | INT | 偏好与抑制集写入 `storage.local`，**不产生任何仓库提交** |
| TC-P9-I02 | INT | 建议计算失败不影响捕获/同步成功 |
| TC-P9-E01 | E2E | 端到端参考旅程：捕获→建议主题（带理由）→确认→复习队列出现→自评→下次时间调整 |

基线随之更新：E2E 由 12 → 15 条（cards / conflict / journey 各一）。
