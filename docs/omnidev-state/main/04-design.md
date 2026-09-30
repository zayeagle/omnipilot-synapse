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
