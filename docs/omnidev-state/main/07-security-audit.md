---
requirement_id: req-2026-07-09-synapse-git-sync
# The audit spans both requirements it has covered; iterations 1-2 are the git-sync one,
# iterations 3-4 the workflow-elegance one.
iteration: 5
status: PASS
blocking_open: 0
git_tip: fbc3da7 (working tree; nothing committed — B.16)
audited_at: 2026-09-29T17:20:00+08:00
---

# Security Audit

## Summary

- **Scope**: everything this requirement touched — the companion content channel (`protocol.ts`, `guard.ts`,
  `git.ts`, `main.ts`, `native-host/install.mjs`, `scripts/pack.mjs`), the extension side of it
  (`lib/native/**`, `lib/store/git-transport.ts`, `lib/store/tier.ts`, `lib/sync/**`,
  `lib/search/shard-store.ts`, `lib/background/handlers.ts`, `entrypoints/background.ts`,
  `wxt.config.ts`, `scripts/assert-content-no-secrets.mjs`), plus `deploy/**` and `.github/workflows/ci.yml`.
- **Tools**: checklist + targeted greps (`auto` with no SAST configured in the repo; both packages declare
  **no runtime dependencies**, so there is no dependency tree to scan).
- **Result**: **PASS** — one HIGH found and fixed inside this iteration; two LOW accepted with rationale.
- **Iteration**: 1 / 3.

## Findings

| ID | Sev | File | Issue | Remediation |
|----|-----|------|-------|-------------|
| S4-01 | **HIGH** | `apps/git-bridge/src/{main,guard,git}.ts` | `git.write` materialises bytes **before** running git, and every path inside the repository root was accepted — including `.git/hooks/pre-commit` and `.git/config`. Writing a hook is arbitrary code execution as the user on the next `git commit`; writing `.git/config` can set `core.hooksPath` / `core.sshCommand` / `core.fsmonitor`. Reproduced: the hook landed on disk, and an overwritten `.git/config` destroyed the test repository's identity. `.GIT/...` bypassed a case-sensitive check on Windows. | **FIXED.** `assertNotGitMetadata()` refuses any target whose first path segment is `.git` (case-insensitive), applied in the dispatcher (`main.ts`) and again inside `git.writeAndCommit` as defence in depth. Tests: `TC-F2-U17` (unit) and the SYS confinement case (spawned process, real git). Re-probed after the fix: all three targets → `pathOutsideRoot`, no hook on disk, `user.email` intact, benign writes still succeed. |
| S4-02 | LOW | `apps/git-bridge/src/guard.ts` | TOCTOU between `resolveInsideRoot` (realpath check) and the subsequent `mkdir`/`writeFile`: a symlink created in that window by another process could redirect the write outside the root. | **Accepted.** The companion runs as the user, in the user's own clone; an attacker who can create that symlink already has the user's privileges, so the check protects against a *compromised extension*, not against a co-resident attacker. Documented rather than papered over. |
| S6-01 | LOW | `apps/git-bridge/src/main.ts` | Refusal diagnostics on stderr include a truncated (≤80 char, control-characters stripped) repository-relative path, e.g. `escaped root: ../x`. | **Accepted.** It is the user's own path, never note content or a credential, and it is the only way to diagnose a refusal. stderr is not part of the protocol. |
| S1-01 | LOW | `apps/extension/lib/**/*.test.ts` | Test fixtures contain obviously fake credential literals (`sk-abcdefghijklmnopqrstuvwxyz`, `ghp_0123456789abcdefghij`). | **Accepted.** Test-only, never imported by a build input, and the shipped content bundle is asserted secret-free by `npm run assert:content` (which also now rejects the native surface). |

## Checked and clean

- **S2 Injection**: no `eval`, `new Function`, `execSync`, or `shell: true` anywhere in either package; the
  companion's single `execFile` call site is argv-array-only and is asserted by tests (`TC-F2-U06/U08`).
  `git.write`'s content is written as bytes, never interpolated into a command.
- **S3 AuthN/AuthZ**: all seven new request types (`auth.probe`, `native.status`, `sync.now/status/policy`,
  `search.query/rebuild`) are listed in `SECRET_BEARING_TYPES`, so the router refuses a page-context sender
  before a handler runs; they also fall into the tightest (`vault`) rate-limit budget. On the companion side
  the op allow-list is enforced in `parseRequest` **and** `assertOpAllowed`, and the negotiated
  `allowed_origins`/`allowed_extensions` restrict which extension may connect at all.
- **S4 (remaining)**: `git.show` / `git.ls` take a `rev`, which is shape-checked (ASCII, no leading `-`,
  no `..` segment) because it is an argv fragment; both are tree-based, so `.git/config` is unreadable
  through them (`notFound`).
- **S5 Crypto/transport**: unchanged vault codec (PBKDF2 + AES-GCM, session-only key). The transparent tier
  is plaintext **by product decision** (requirement 5) with a fail-closed fallback (`SAFE_FALLBACK_MODE`) for
  an absent/unreadable config — recorded in `04-design.md` F6 and `08-spec.md`. `GIT_SSH_COMMAND` is only
  forwarded from the user's own environment; the companion never asks for or handles key material
  (`key.list` returns identifiers derived from file names).
- **S6**: no secret is projected to the UI (`public-prefs` carries booleans/counters only); `install.mjs`
  prints the Windows `reg add` command instead of editing the registry, refuses unfilled placeholders, and
  asserts every write target is inside the browser's own native-messaging directory.
- **S7/S8**: no runtime dependencies added; the repo configures no SAST tool, so this is checklist + grep
  scope only. `test:sys` and CI now cover the companion end to end, which is the compensating control for
  the privileged boundary.

## Tools

| Command | Result |
|---------|--------|
| `npx vitest run` (git-bridge) | 48 passed / 6 files |
| `npm run test:sys` (git-bridge) | 8 passed (real bare remote, spawned companion) |
| `npx tsc --noEmit` (git-bridge) | exit 0 |
| grep `shell: true\|execSync\(\|eval\(\|new Function` over `apps/**/*.ts` | no matches |
| grep `ghp_\|sk-\|BEGIN .* PRIVATE KEY` over `apps/**/*.ts` | test fixtures only (S1-01) |
| exploit probe: `git.write` → `.git/hooks/pre-commit`, `.GIT/hooks/post-commit`, `.git/config` | before: hook written, config destroyed · after: `pathOutsideRoot`, nothing on disk |

## Delta re-audit (iteration 2 — tip changed after G6) — still PASS

Everything below landed after iteration 1 and was reviewed as a delta; none of it reopens S4-01 or adds a privileged surface.

| Change | Security review |
|--------|-----------------|
| `CommitRecordOptions.extraFiles` + `shardProvider()` (capture/distill now commit their postings shards) | The extra paths are derived, never caller-supplied: `shardPath(key, prefix)` with `key = shardKey(term)` (the first two lowercased code points) and `prefix` validated at the message boundary by `ensureSafeRelativePath` (rejects `..`/`..` segments) and normalised again by `normalizePrefix`. The record and the index win any path collision, so a shard can never shadow the note it indexes. Worst case for a hostile term is a file written inside `search/` — not a traversal. |
| `settings.security` now carries `authMode` | Validated enum (`validateAuthMode`), persisted through the existing settings patch, echoed back for the picker. `settings.security` is not in `CONTENT_SCRIPT_ALLOWED_TYPES` (which holds only `prefs.get` and `capture.request`), so page-context code cannot set the mode. |
| G6 UI (options 存储/同步 tabs, popup rows, search box) | Presentation only: it calls the already-gated request types and renders secret-free projections. `lib/status.ts` deliberately drops the raw `lastError` text rather than rendering worker-supplied strings. The content-bundle assertion is green, so no native or secret symbol reached a page context. |

Evidence after the delta: extension `tsc` 0 · UNIT **543 / 42** · INT **111 / 13** · build 0 · `assert:content` OK; companion `tsc` 0 · UNIT **48 / 6** · SYS **8**.

## Decision

- **passed** (iteration 1). No open CRITICAL/HIGH. Cleared to leave Phase 3 once the remaining G6/G9
  evidence lands; this audit must be re-run if the tip changes materially afterwards.

## 增量审计（iteration 3 — 本需求新增的对外面，2026-09-29）

本需求新增 7 个 message type（已实现 3 个：@@cards.list@@ · @@card.decide@@ · @@conflict.resolve@@；G9 计划 4 个）。**每一个都是新的攻击面**，因此逐项复核，而不是等它们全部实现后再看。

| # | 检查 | 结论 | 证据 |
|---|------|------|------|
| 1 | 是否仅扩展页面可发 | ✅ 三者在 @@SECRET_BEARING_TYPES@@ 内；页面上下文只允许 @@prefs.get@@ / @@capture.request@@ | @@messages.ts:497-499@@ · @@:365-368@@（CONTENT_SCRIPT_ALLOWED_TYPES） |
| 2 | 是否受限流 | ✅ @@limiterKeyFor@@ 对未显式列出的类型一律落入最紧的 @@vault@@ 预算 | @@router.ts:45-48@@、@@:122@@ |
| 3 | 参数是否白名单校验 | ✅ @@card.decide@@ 的 patch **只允许** title/summary/points/tags（id/status/source_id 是身份不是内容）；@@conflict.resolve@@ 要求 path 与 conflictPath 均为仓库相对、不含 @@..@@ 或反斜杠、且**必须不同**；三者都有长度上限 | @@messages.ts@@（validateCardDecide / validateConflictResolve） |
| 4 | 能否覆写任意文件 | ✅ @@card.decide@@ 必须 id 在索引中且 @@index.path === 请求 path@@；@@conflict.resolve@@ **必须**该 path 曾在同步状态里被记录为冲突，且记录的 sibling 与请求一致——**这是决策面，不是文件搬运器** | @@handlers.ts@@（两个 handler 的前置守卫） |
| 5 | 归档路径可否逃逸 | ✅ @@archivePathFor@@ 只在**已校验的仓库相对路径**前加固定前缀 @@archive/cards@@ / @@archive/conflicts@@；路径来自请求或索引，均经过第 3/4 条的校验 | @@core/tombstone.ts@@ · @@sync/conflict.ts:98@@ · @@cards/decide.ts@@ |
| 6 | 是否引入新的内容读取面 | ⚠️ @@cards.list@@ 会读取卡片正文（用户必须读到才能决定）——因此它**必须在扩展页面内**（第 1 条已覆盖）；@@sync.status@@ 的冲突摘要**刻意只读索引**，锁定的 vault 仍可用 | @@handlers.ts@@（cards.list 注释）· @@sync.status@@ |
| 7 | 是否引入写入原语 | ⚠️ 新写入点两处：@@archive/**@@ 的归档件、@@review/state.json@@ 的复习条目。二者都由服务端**推导**（不由调用方指定内容），且路径受限；@@review/state.json@@ 明文但不含内容 | 同上 + @@reviewStateWithEntry@@ |
| 8 | 是否新增依赖 / 出网 | ✅ 零新依赖；零新出网（本地智能三函数纯本地，E4/E5 偏好**只写 storage.local**，并有测试断言其 import 为空） | @@package.json@@ · @@lib/local/preferences.test.ts@@ |

**结论：PASS（iteration 3，blocking 0）。** 无新增 CRITICAL/HIGH；两条 ⚠️ 均为**设计意图内**的能力（用户需要读到卡片才能决定；归档是"不删除"原则的代价），且都在既有约束下（扩展页面可发 + 限流 + 白名单 + 路径受限）。

**沿用未变的残余风险**：S4-02（路径校验与写入之间的 TOCTOU，单用户本机场景已接受）；S6-01（companion stderr 记录被拒绝的路径）。

**特别记录——SSH 侧的写原语没有被扩大**：本需求所有新写入都发生在**扩展侧的 REST/仓库路径**上；companion 的操作白名单**未增加任何一项**（仍是 @@repo.info@@ / @@git.probe|status|fetch|show|ls|write|commit|push@@ / @@key.list@@），因此 S4-01 修复后的特权边界保持原样。
## 增量审计（iteration 4 — 本轮的写原语与首启选择，2026-09-29）

本轮**没有新增任何 message type**（刻意的：首启档位选择复用 @@settings.security@@，仓库侧的记录由既有的提交路径承载），
因此审计对象是三类新东西：一个新的写原语、一个新的设置字段、两处界面。

| # | 检查 | 结论 | 证据 |
|---|------|------|------|
| 1 | 新写原语（@@.omnipilot/config.json@@）能否由调用方指定内容或路径 | ✅ 两者都不能。内容整份由 @@storeConfigFileIfMissing@@ **服务端推导**（schema_version / security_mode / branch / sync_policy / client_version / 时间戳），路径固定为 @@storeConfigPath(prefix)@@，prefix 在消息边界已过 @@ensureSafeRelativePath@@ 与 @@normalizePrefix@@ | @@lib/store/tier.ts@@ · @@lib/core/paths.ts@@ |
| 2 | 该文件是否含内容或密钥 | ✅ 不含：它说明**仓库怎么存**，不说存了什么。没有标题、没有正文、没有凭据；@@assert:content@@ 仍 OK | @@tier.ts@@（StoreConfig 字段表） |
| 3 | 能否用它静默降级档位 | ✅ 不能，这是本轮最重要的性质：@@storeConfigFileIfMissing@@ 在「已记录 mode」与「有内容但无记录（requiresUserDecision）」两种情况下都返回 @@null@@，**什么都不写**；未知状态仍走 @@SAFE_FALLBACK_MODE = vault@@ | @@tier.ts@@ resolveTier 前置分支 · @@tier.int.test.ts@@ TC-P8-I01/I02 |
| 4 | 新设置字段 @@contentTierChosen@@ 是否扩大可写面 | ✅ 只是一个 boolean，搭在 @@settings.security@@ 上（该类型**不在** @@CONTENT_SCRIPT_ALLOWED_TYPES@@ 内），校验器要求严格 boolean | @@messages.ts@@ validateSecuritySettings · CONTENT_SCRIPT_ALLOWED_TYPES |
| 5 | 该写原语落在哪条链路上 | ✅ 随**捕获自身的那一次提交**写入（@@CaptureService.bootstrap@@ → @@CommitRecordOptions.extraFiles@@）。路径冲突时记录与索引胜出，配置文件不可能遮蔽笔记；提交失败也不会留下「记了档位、没记笔记」的半配置仓库 | @@lib/capture/service.ts@@ · @@lib/store/github-store.ts:216-221@@ |
| 6 | 该元数据读取失败会不会让捕获失败 | ⚠️ 不会——bootstrap 与 shards 同为 best-effort（本次读不到就先不记，档位仍以设置为准）。**有意为之**：用户刚捕获的笔记不能因为一次元数据读取而失败 | @@service.ts@@ bootstrapFiles |
| 7 | 新界面（首启档位选择、SSH 克隆命令）是否泄露或越权 | ✅ 纯展示：档位选择只发 @@settings.security@@；克隆命令由**本机字段**拼出，@@sshRemoteUrlFor@@ 在仓库名缺失时返回空串（不生成半截可执行命令），复制经 @@navigator.clipboard@@ 写的就是同一条命令，不含任何凭据 | @@entrypoints/options/main.ts@@ · @@lib/ui/auth-form.ts@@ |
| 8 | 是否新增依赖 / 出网 / companion 能力 | ✅ 零新依赖、零新出网；companion 操作白名单**未增加任何一项**，其源码本需求未改动（SYS 8 条即此证据） | @@package.json@@ · @@apps/git-bridge@@ |

**结论：PASS（iteration 4，blocking 0）。** 无新增 CRITICAL/HIGH。唯一的 ⚠️（第 6 条）沿用既有的「捕获不可失败」原则，
且失败方向是「少记一次元数据」，而不是「记错」。

**本轮实测证据**：extension tsc 0 · UNIT **600 / 52** · INT **117 / 13** · build 0（388.57 kB）· @@assert:content@@ OK；
companion tsc 0 · UNIT **48 / 6** · SYS **8**。extension E2E **19 / 19**（基线 12）。

**沿用未变的残余风险**：S4-02（路径校验与写入之间的 TOCTOU，单用户本机场景已接受）· S6-01（companion stderr 记录被拒绝的路径）。
## 增量审计（iteration 5 — 授权模式与档位契约，2026-09-30）

本轮把审计本身当成了交付物：先做一次独立的深度取证，再修两个 P0/P1。审计对象是新出现的**模式分叉点**与**档位解析路径**。

| # | 检查 | 结论 | 证据 |
|---|------|------|------|
| 1 | `resolveStore` 现在按授权模式分叉，是否扩大了攻击面 | ✅ 分叉只发生在**选哪一个 transport**，两者都经 `resolveAuth`（原有的 fail-closed 判定），且都实现同一个 `RepoStore`。SSH 侧仍是 companion 的白名单 op，未新增任何 op | `lib/background/handlers.ts`（resolveRepo）· `lib/store/repo-store.ts` |
| 2 | 新的写原语（`createRepoStore.commitRecord`）能否覆写任意路径 | ✅ 路径来自 codec 的 `encodeRecord`（原有逻辑）与 `extraFiles`（shards 派生），索引/记录在冲突时胜出；空提交与超量提交被拒（与 REST 侧同一份实现） | `lib/store/repo-store.ts` |
| 3 | 档位解析是否引入降级路径 | ✅ 反向：仓库记录**优先**，本机设置只做新仓库回落；歧义（有内容无记录）仍 `SAFE_FALLBACK_MODE = vault`。明文写进 vault 仓库现在不可能 | `handlers.ts`（resolveRepo）· `tier.ts` resolveTier |
| 4 | 档位变更是否有出口且不可逆动作被阻止 | ✅ 有内容即拒绝（`tierLocked` + 双语原因 + "指向空仓库"动作），空仓库写 `config.json`；`switchTier` 的迁移守卫真正生效了（此前是死代码） | `handlers.ts` recordTierChange · `status.ts` ERROR_GUIDANCE |
| 5 | 保存存储配置是否会因缺 token 而失败（新的失败面） | ✅ 已修：`probeCandidate` 无凭据时返回 `null`（best-effort），不再让 SSH-only 配置无法保存；公库阻断仍要求 `probe !== null && visibility === 'public'` | `handlers.ts` probeCandidate |
| 6 | 错误码是否还能被静默改写 | ✅ 已修：`ERROR_CODES` 改由 `Record<ErrorCode, true>` 推导，编译器拒绝漏项（此前漏了 5 个声明码，界面指引全部丢失） | `lib/background/router.ts` |
| 7 | 是否新增依赖/出网/权限 | ✅ 零新依赖、零新出网、权限未变；companion 源码未改动（SYS 8 条） | `package.json` · `apps/git-bridge` |

**结论：PASS（iteration 5，blocking 0）。** 无新增 CRITICAL/HIGH。本轮同时关闭了 iteration 4 遗留的两条 ⚠️ 中的一条（档位降级），另一条（bootstrap 读取 best-effort）不变。

**本轮实测**：extension tsc 0 · UNIT **600** · INT **120** · E2E **19 / 19** · build 0 · `assert:content` OK；companion tsc 0 · UNIT **48** · SYS **8**。

**未修但已记录**：`GithubStore.listPendingCards` 仍是死代码；`optional_host_permissions: https://*/*` 仍为已接受风险；`switchTier` 的"迁移"（真正重编码）留待后续需求。



