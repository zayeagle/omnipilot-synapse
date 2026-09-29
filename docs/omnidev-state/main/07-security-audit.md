---
requirement_id: req-2026-07-09-synapse-git-sync
iteration: 2
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

