---
branch: main
last_phase: 2
last_task_group: null
timestamp: 2026-09-29T18:30:00+08:00
complexity: M
complexity_effective: M
status: completed
spec_mode_active: true
requirement_id: req-2026-09-30-synapse-auth-tier-integrity
previous_requirement: req-2026-07-09-synapse-git-sync
state_files: ["00-project-context.md", "08-spec.md", "04-design.md", "05-test-plan.md", "02-plan.md"]
active_feature: F10
active_group: 0
context_hot: ["00-project-context.md", "docs/requirements/00-requirements.md §5B (form A: Git)"]
mid_task: null
mid_task_files: []
resume_payload: null
resume_payload_at: null
pending_decision: null
    - { id: cancel, command: "/od x" }
autopilot: true
---

## Session Goal

Extend the shipped browser-extension MVP (0.1.0) so GitHub storage supports **two authorization modes
(access token + SSH)**, keeps **`main` as the default branch with a user-overridable branch**, converts
note generation and reading into an **automatic push *and* pull** flow, and adopts a repository storage
layout that is **readable in-repo** whenever performance allows — while still supporting retrieval.

## Phase 0 Assessment

**Requirement Analysis**: the previous requirement delivered write-only, token-only, single-direction
persistence. This one turns the storage layer into a real two-way Git client: two credential modes,
branch selection, automatic push/pull with reconciliation, and a storage format chosen for human
readability first and retrieval second.

**Project Structure**: unchanged — greenfield, `apps/extension` (WXT + TS). **Possible new component**:
SSH cannot be spoken from an MV3 extension (no TCP socket API), so a native-messaging companion
(`apps/git-bridge`, driving system `git`/`ssh`) or a self-hosted SSH-over-WebSocket bridge is required.
Choosing the companion turns this into a two-deliverable requirement.

**Complexity Assessment**: **L** — four orthogonal changes to an existing, well-tested codebase
(auth abstraction, sync engine with a local cache and conflict handling, storage/retrieval layout,
configuration + UI). **XL if the native-messaging companion is in scope**, because that adds a second
process, an IPC protocol, its own packaging and its own deploy path.

**Stability Level**: high — a leaked SSH key or a botched three-way merge can corrupt the user's corpus.

**Frontend Impact**: yes — auth-mode picker (token / SSH), branch field (already present, to be
re-verified), sync status + manual trigger, conflict surfacing, and a search entry point.

**Test Strategy Hint**: add a sync-engine INT layer (fake remote that drifts between runs) and extend
E2E with a pull-after-remote-change flow. A companion process would need its own UNIT suite.

**Recommended Strategy**: Phase 1 Blueprint → 2 Planning → 3 Dev → 4 Test → 5 Deploy.

**Recommended Scope** (session-log only):
- `GitAuth` abstraction with two implementations: `TokenAuth` (existing REST bearer) and `SshAuth`
  (credentials/explicitly-out-of-scope until the transport is chosen)
- SSH transport decision (Phase 1 approach comparison, **blocking**): native-messaging companion +
  system git/ssh · self-hosted SSH-over-WebSocket bridge · token-only with SSH deferred
- Branch: default `main`, user-overridable, validated against the remote (exists / create)
- Sync engine: local cache (IndexedDB or `storage.local`), remote head tracking, pull → reconcile →
  push, conflict policy `last-write + conflict copy` (per requirements §5B)
- Automatic triggers: on startup, on capture, on a periodic alarm, and manually from the UI
- Storage layout: keep the readable Markdown + frontmatter form as the **default** tier, add a
  retrieval index (path/URL/tag/body-term postings) rebuilt incrementally from the repo
- Retrieval: keyword search over the index + topic/date browse; document what semantic search would need
- Migration: existing vault-mode repositories must keep working; no silent tier switch

**Confirmation Level**: full — L complexity, B.15 phase-end + mid-phase gates.

**Open risk to resolve in Phase 1**: the SSH transport choice is a hard platform constraint, not a
preference. Nothing else in the plan can be sized until it is decided.

## Key Decisions

- **Continuation, not a rewrite**: same branch, same product. Previous artifacts
  (`01-blueprint` / `02-plan` / `04-design` / `05-test-plan`) will be archived to their paired
  `*-history.md` at the first write of Phase 2 (`reason: new_requirement`), per document-history §7.
- **Spec layer re-activated**: `spec_mode: auto` + L complexity → a new `08-spec.md` delta will be
  written in Phase 2; the previous delta is already merged into `specs.md`.
- **Branch requirement is largely already met** (`branch` config defaults to `main` and is editable) —
  to be verified, hardened (existence check, creation path) and documented rather than rebuilt.

## Progress

- Phase 0: ✅ Complexity L (XL effective — SSH companion accepted), **autopilot ON** by user pick
- Phase 1: ✅ Blueprint v2 — 3 SSH transports compared, A (native companion) auto-selected; 10 assumptions, 8 questions, 11 risks
- Phase 2: ✅ Spec v2 (8 requirements / 23 scenarios) · Design v2 (6 features) · Test plan v2 (56 UNIT / 20 INT / 8 SYS / 6 E2E / 3 SMK / 10 REG) · Plan v2 (46 tasks / 9 groups)
- Phase 3: 🔄 **In progress** — G0 ✅ · G1 ✅ · G2 core ✅ · G3 ✅ · G4 (merge core) ✅ · G5 ✅ · G6/G7/G8/G9 ⏳
  Evidence: extension **428 UNIT / 81 INT** (baseline 381/67), companion **11 UNIT**, both `tsc` clean.
- Phase 4: ⏳ Not started
- Phase 5: ⏳ Not started

## Key Decisions

- **Continuation, not a rewrite**: same branch, same product; superseded artifacts archived byte-exactly
  (verified by byte comparison) before their first rewrite.
- **SSH needs a transport** (platform fact): a browser extension has no raw-socket API. Approach A
  chosen — a native-messaging companion driving the user's own `git`/`ssh`. This adds a second
  deliverable, so `complexity_effective: XL` was recorded and shown at the `pre_dev` gate; the user
  confirmed the full scope.
- **SSH needs a local clone**: discovered while implementing F1 — `git` requires a working tree, so
  `SshConfig` gained `repoRoot`. The UI must state this; token mode has no such requirement.
- **Readable by default, safe on doubt**: `DEFAULT_SECURITY_MODE = 'transparent'` (new store) is split
  from `SAFE_FALLBACK_MODE = 'vault'` (absent/corrupt/unknown config). One unreadable byte must never
  downgrade an encrypted repository to plaintext.
- **Both versions always survive a conflict**: remote keeps the path, ours becomes a
  `.conflict-<stamp>` sibling; a remote deletion of a locally-changed note resurrects ours rather than
  dropping it.
- **No secret can reach SSH mode**: `SshAuth` holds a host, a user, a key *reference* and a clone path —
  there is no field for key material. `probeFromCompanion` reports `visibility: 'unknown'` because SSH
  access is not evidence of privacy.
- **Process miss recorded**: the previous requirement's `03-progress.md` was overwritten before being
  archived; `03-progress-history.md` now holds an explicitly-labelled reconstruction. All other
  artifacts were archived byte-exactly. Not repeating this: archive first, then write.

## Incomplete Items

- [ ] **G4 sync I/O** (T4.2–T4.9): `sync/cache.ts` (IndexedDB), `sync/engine.ts` (pull → cache →
      re-index → push), `sync/triggers.ts` (startup/capture/alarm/unlock/manual), sync handlers —
      the remaining core of requirement 3 (自动推送和拉取)
- [ ] **T1.5** `store/git-transport.ts` (KnowledgeStore over the companion)
- [ ] **G6 UI** — options 存储/同步与检索 sections; popup status + 立即同步 + search
- [ ] **G7** `resolveTier` (recorded mode wins) + `branch`/`sync_policy` in `.omnipilot/config.json`
- [ ] **T2.6** companion SYS suite against a temp bare repo
- [ ] **G8** native-host manifest/installer, companion packaging, `deploy companion` mode, CI
- [ ] **G9** E2E: remote-drift pull, no-op sync, conflict, SSH degradation, search, readable default
- [ ] Manifest permissions (`nativeMessaging`, `alarms`, `unlimitedStorage`) + content-bundle assertion
- [ ] Phase 3 exit security audit — the companion is a **new privileged boundary**

## User Feedback Highlights

- Requirement 1: GitHub 授权要支持 **access token 和 SSH 两种方式**的配置。
- Requirement 2: **默认 main 分支**，分支可自定义填写。
- Requirement 3: 笔记的生成与读取要实现**自动推送和拉取**。
- Requirement 4: 笔记存储结构不限，只需满足**最终检索**效果。
- Requirement 5: **性能满足的前提下，建议在仓库中可读**（数据库或云端文档皆可）。

## Resume Instructions (SUPERSEDED — see the current block at the end of this file)

Next: Phase 0 confirmation. On `confirm`/`autopilot` → load `phases/01-blueprint.md`; the first
approach comparison MUST be the SSH transport (three options above), because it decides whether a
second deliverable (native-messaging companion) exists at all. Then: sync engine shape (local cache
technology, conflict policy, trigger set), storage/serialisation layout, and retrieval index.
Read `00-project-context.md` (updated) and `docs/requirements/00-requirements.md` §5B before Phase 1.

## Completeness Audit (2026-09-29 · `/od 深入检查当前项目的完整度`)

**Method**: every one of the 46 tasks in `02-plan.md` checked against disk; all five verification
commands re-run instead of quoting the stale table in `03-progress.md`.

**Fresh evidence**: extension `tsc` exit 0 · UNIT **465 / 37 files** · INT **87 / 11 files** ·
companion `tsc` exit 0 · UNIT **11 / 3**.

**Group verdicts (plan → disk)**:
- **G0 ✅** · **G1 🟡** T1.5 `store/git-transport.ts` missing; `auth.probe` handler missing (`store.probe` is wired)
- **G2 🟡** T2.1–T2.5 present (`key.list` inside `git.ts`, no `keys.ts`); **T2.6 SYS suite missing** (`test/sys/` and `test:sys` both absent)
- **G3 🟡** code present, **zero tests** (`native/client.int.test.ts`, `native/protocol.test.ts` absent); **T3.4 unmet — `nativeMessaging` permission not declared**
- **G4 🟡** T4.1 ✅ / T4.2 ✅ (but `sync/cache.test.ts` absent); T4.3 superseded by `manifest.ts` (documented); **T4.4–T4.9 `engine.ts` / `triggers.ts` / handlers absent**
- **G5 🟡** T5.1–T5.5 ✅; **T5.6/T5.7 handlers + single-commit wiring absent → the search layer is unreachable**
- **G6 ⏳** not started (no `lib/ui/auth-form.ts`; options/popup expose no auth-mode, 立即同步 or search)
- **G7 🟡** default flip + `SAFE_FALLBACK_MODE` ✅; **`resolveTier` and the `branch`/`sync_policy`/`client_version` config fields absent**
- **G8 🟡** `ci.yml` + `deploy/*` exist but extension-only (no companion job, no SYS, no `companion` deploy mode); native-host installer + bridge `pack.mjs` absent
- **G9 ⏳** not started (only the v1 `clip.spec.ts` / `distill.spec.ts`)

**Product-level blocker**: without manifest `nativeMessaging`, the extension cannot open the companion
port, so requirement 1 (SSH) cannot work end to end even though G1–G3 code exists.

**Drift**: all Phase-3 work is uncommitted (2 commits total; `apps/`, `deploy/`, `Makefile`,
`.github/`, `package.json` untracked) · session-log timestamp 2026-07-09 vs today 2026-09-29 ·
`last_phase: 2` vs board `current_phase: 3` (the `pre_dev` pending_decision was stale) · the old `/od re`
pointer said "from G4/T4.2" while T4.1/T4.2 are done — correct resume point is **T1.5 → T4.4** ·
Phase-3 exit security audit (B.22) not started.

**Completeness**: ≈22 / 46 tasks verified done → **~55–60 %** of `req-2026-07-09-synapse-git-sync`.

## Blocker (2026-09-29) — SSH pull is not implementable against the shipped companion protocol

Found while starting T1.5/T4.4. `ALLOWED_OPS` on both sides is
`ping, repo.info, git.probe, git.status, git.fetch, git.commit, git.push, key.list` — **no op returns file
content** (`git.ts` / `main.ts` expose exactly those). `KnowledgeStore` requires `readFile` + `listDir`,
so `store/git-transport.ts` (T1.5) can only implement `probe()` and `commitFiles()`, and `04-design.md` F3
step 2 ("fetch only added/modified blobs", `git diff --name-status` for ssh) has no op to call.

Consequence: SSH mode can push but cannot pull or re-index → requirement 3 (自动推送和拉取) is only
half-satisfiable in SSH mode and requirement 1 cannot be delivered end to end. Raise as a B.14 change
(design + plan delta) rather than inventing an op silently.

**T3.4 landed meanwhile**: manifest permissions extended with `nativeMessaging`/`alarms`/`unlimitedStorage`
and the content-bundle assertion now also rejects `connectNative` and `com.omnipilot.synapse.git_bridge`.



## Blocker revised (2026-09-29) — no content channel in either direction

The read-only finding was incomplete: `git.commit` only stages **paths that already exist in the clone**
(`git add -- <paths>` + `git commit`), and the companion has no `writeFile`/`mkdir`/stream anywhere
(`readdir` for `key.list` is its only fs call). So over SSH the extension cannot deliver note content
into the working tree **nor** read it back — SC-F1-03, SC-F4-01 and SC-F5-02 are unreachable, T1.5 is
not implementable, and only the token transport can carry content.

Minimum additions for a working SSH mode: `git.show` {rev,path}→{content}, `git.ls` {rev,dir}→entries,
`git.commit` extended to accept inline `files:[{path,content}]` (a new **write primitive** on the
privileged boundary), and a `notFound` error code. Op 3 is why this is raised as a fresh B.0/B.14
confirm instead of proceeding under the earlier read-only approval.

The user's first approval (option A, read-only extension) is therefore **superseded**; nothing has been
implemented against it. T3.4 (permissions + assertion) stayed in scope and is verified green.

## Progress update (2026-09-29, autopilot after change_confirm = proceed)

- **Landed**: T3.4 (manifest permissions + assertion), T2.7–T2.9 (companion content channel
  `git.show` / `git.ls` / `git.write` + `notFound`), T3.5 (extension mirror + tests), T1.5 (
  `store/git-transport.ts`).
- **Evidence**: companion tsc 0 · 17/4 (was 11/3); extension tsc 0 · UNIT 471/38 · INT 94/12
  (was 87/11); build 0 · assert:content OK.
- **Docs**: 04-design v3 (F1 3b, F2 1b), 02-plan v3 (Revision 3), 08-spec v3 (SC-F2-04/05); v2 of each
  archived to its history file before the rewrite.
- **Decision**: `git.write` is a write primitive on the privileged boundary and is now part of the Phase 3
  exit security-audit scope.
- **Next**: T4.4–T4.9 sync engine (both transports unblocked), then T3.2/T4.2 verify files, T2.6 SYS,
  G6 UI, G7, G8, G9, security audit.


## Progress update (2026-09-29, round 2 — implement-everything)

- **Land**: sync engine + shard store + triggers (T4.4–T4.9), cache test + remote version keys (T4.2),
  auth/native/sync/search handlers (T4.7, T5.6, T5.7), worker wiring (native client, cache, alarms,
  startup pull), native client INT suite (T3.2), tier resolution + config fields (T7.1–T7.4, Agent G7).
- **Evidence**: extension tsc 0 · UNIT 527/529 (2 failures are G6's in-flight options-page assertions) ·
  INT 108/13 · companion tsc 0 · UNIT 17/4.
- **Delegated in flight**: G6 UI surfaces, G8 packaging/CI/native-host (`subagent`).
- **Next**: fold in G6/G8, T2.6 SYS suite, G9 E2E, then the Phase 3 exit security audit.


## Progress update (2026-09-29, round 3)

- **T2.6 landed**: companion SYS suite (8 tests) over real stdio against a temp bare remote; `test:sys` builds first,
  the hermetic suite excludes `test/sys/**`. Companion suite: 48 / 6.
- **B.22 security audit: PASS** (iter 1, blocking 0) — `07-security-audit.md` v2, v1 archived. One HIGH fixed in-iteration:
  `git.write` could install `.git/hooks/*` or rewrite `.git/config` (code execution on the next commit).
- **In flight**: G6 UI (Agent G6), G9 E2E (Agent G9).


## Progress update (2026-09-29, round 4)

- **Retrieval hole closed**: the capture/distill paths commit directly (never through the sync engine) and
  previously committed only the record + `index.json` — so a freshly captured note was invisible to
  `search.query`, which reads the committed shards, and the engine would not repair it (the remote
  manifest already listed the record). `CommitRecordOptions.extraFiles` + an injected `shards(record)` collaborator now
  put the note, its index entry and its postings in **one** commit (T5.7). Tests: `TC-F4-I02` (note is findable from
  exactly the committed shards) + a case proving a failing shard computation still stores the note.
- **Evidence**: extension tsc 0 · UNIT **543 / 42** · INT **110 / 13** · build 0 · `assert:content` OK;
  companion tsc 0 · UNIT **48 / 6** · SYS **8**. G8 re-verified independently (installer + packer dry-runs exit 0).
- **Plan reconciled**: G0–G5 and T8.1–T8.4 ticked against re-run evidence; T4.3 recorded as superseded by
  `manifest.ts` rather than silently left open. Only T6.x (in flight) and T9.x (in flight) remain.


## Progress update (2026-09-29, round 5)

- **G6 (Agent G6) complete**: `lib/ui/auth-form.ts` + 19 tests, new 存储/同步 options tabs, popup auth/branch
  + sync rows + 立即同步 + search box, ~110 i18n keys in both dictionaries, format/status extensions with tests.
- **G6's blocker fixed by the orchestrator**: `authMode` now travels on `settings.security` (`SecuritySettingsPayload` +
  `validateSecuritySettings` via `validateAuthMode` + the handler patch/echo), so the picker survives a reload.
  Tests: `messages.test.ts` (validator) and `handlers.int.test.ts` `TC-F5-I02` (stored, not merely echoed — asserted through `prefs.get`).
- **Plan reconciled**: T6.1–T6.6 and T8.1–T8.4 ticked; only T9.1/T9.2 (Agent G9, in flight) remain.
- **B.22 re-audited as a delta (iteration 2, PASS)**: extraFiles path derivation, authMode validation and the G6 UI
  surface reviewed; page context still limited to `prefs.get`/`capture.request`.
- **Evidence**: extension tsc 0 · UNIT 543/42 · INT 111/13 · build 0 · assert:content OK; companion tsc 0 · UNIT 48/6 · SYS 8.


## Phase 3 complete (2026-09-29)

- **G9 landed**: `e2e/{sync,auth,search}.spec.ts` + helper extensions; **12/12 Playwright tests pass** including
  remote-drift pull, no-op sync, conflict-both-versions, SSH degradation, retrieval and the readable default.
  The G9 sub-agent stalled after its run (no report for ~30 min); it was interrupted and the suite was re-run by the
  orchestrator — the specs it left are sound and unchanged.
- **Final evidence**: extension tsc 0 · UNIT 543/42 · INT 111/13 · REG 372/25 · E2E 12 · build 0 · assert:content OK;
  companion tsc 0 · UNIT 48/6 · SYS 8. B.22 PASS (iter 2).
- **Docs**: README rewritten for the 0.2.0 surface (dual auth, companion, branch, bidirectional sync, retrieval,
  tier-default change, companion security row, new commands); root `package.json` gains companion scripts and a
  two-package `postinstall`.


## Phase 0 Assessment — req-2026-09-29-synapse-workflow-elegance

**Requirement Analysis**: 三个工作流。(R1) 把"对用户知识工作流的理解深度 + AI 与用户协作的优雅程度"
确立为产品的**基本设计理念**，并落成文档与门禁（不是口号：要有可判定的判据、每个 Feature 必答清单、CR 条目）。
(R2) 按该理念对**当前全部功能实现**做一次证据化审计（工作流 6 阶段 × CKF 4 类记录 × 判据矩阵，标出死代码、
无出口状态、断裂环节）。(R3) 审计发现的问题**统一优化**（代码 + 测试 + 文档一次到位）。

**Project Structure**: 不变 — greenfield monorepo：`apps/extension`（WXT+TS，MV3）+ `apps/git-bridge`（Node ESM companion）。

**Complexity Assessment**: **L** — 三条正交工作流，每条都跨两个包；审计范围天然发散（"所有功能实现"），
必须在 Phase 2 收敛成可交付清单。**XL 风险点**：若把语义检索、AI 主动复现、多设备协同都纳入修复范围，会膨胀为 XL——
Phase 1/2 会显式标注哪些延后到下一个需求。

**Stability Level**: high（个人私密知识资产；安全仍为 P0，任何修复不得降低既有安全属性）

**Frontend Impact**: yes — P0-1 提案闭环（卡片可见 + 接受/改写/丢弃）、P0-2 冲突决策面、P1-1 失败可读化、
P1-2 SSH 克隆引导、P2-2 首启层级选择，全部落在 popup/options。

**Test Strategy Hint**: monorepo-L → UNIT + INT + SYS(companion) + E2E(Playwright) + REG；每个界面级修复都要有自己的
E2E 场景（现有 12 条 E2E 作为回归基线）。

**Recommended Strategy**: Phase 1 Blueprint → 2 Plan → 3 Dev → 4 Test → 5 Deploy（L 走完整流程）。

**Recommended Scope** (session-log only):
- **文档**：新增 `docs/product/00-design-principles.md`（理念表述 + 6 条判据 + 反例 + 每个 Feature 必答清单 + CR 门禁），
  并把它接进 `00-project-context.md`（Architecture Patterns）、`README`（一句话立场）与 OmniDev 的 Phase 1/2 产物。
- **审计**：新增 `docs/audits/00-functional-audit.md` — 按 Capture→Inbox→Distill→Place→Retrieve→Review 逐段核对代码，
  每条结论附证据（文件:行），单独列出：死代码、定义了但从未被创建/渲染的记录类型、无出口的状态、静默失败路径。
- **修复（Phase 2 定稿优先级）**：P0-1 提案闭环；P0-2 冲突决策面（可比较摘要 + 三选一 + 败者归档）；
  P1-1 错误码→可执行指引 + 状态行重试；P1-2 SSH 克隆引导；P1-3 本地检索增强（可选、默认关、无出网）；
  P2-1 AI 本地主动性（去重提示/归属建议/复习队列，先把本地规则做出来）；P2-2 首启显式选择加密取舍。

**Confirmation Level**: full（L；Phase 3 退场必须过 B.22）。

**已知事实（Phase 0 阶段验证过，供 Phase 1 直接使用）**：`REQUEST_TYPES` 26 项中没有任何"列出/确认/改写卡片"的操作；
`listPendingCards` 只有定义与测试调用；`Topic` / `ReviewState` 从未被生产路径构造 —— 即工作流在 Distill 之后断裂。


## Phase 1 Blueprint — req-2026-09-29-synapse-workflow-elegance

**Approach comparison (3, autopilot auto-picked A)**

| Approach | Core idea | Compatibility | Complexity | Extensibility |
|----------|-----------|---------------|------------|---------------|
| **A 判据先行·证据化审计·收敛修复** | 理念→可判定判据→同一判据做全量审计→据证据冻结修复清单 | ✅ | ⚠️（审计须收敛） | ✅ |
| B 以使用者旅程为主线先补断点 | 跳过全量审计，直接按 6 阶段补 Place/Review | ⚠️ | ⚠️ | ⚠️（无基线，易漏非 UI 断裂） |
| C 只交文档+审计，修复另立需求 | 本次不实现 R3 | ✅ | ✅ | ❌（不满足用户"统一优化"要求） |

自动选择 **A**：需求本身是"标准 → 检查 → 修复"的因果链，A 让修复清单可辩护；B 无法回答"所有功能实现"，C 不满足 R3。

**Auto-picked soft decisions (autopilot)**: `blueprint_approach` → A；`assumptions_confirm` → accept（A1–A7，A2 为 blocking 且以测试+B.22 验证）；
`open_questions` → accept_defaults（Q1–Q6，见 `01-blueprint.md` §7）。

**Key facts carried from Phase 0**（Phase 2 直接使用）：工作流在 Distill 之后断裂；`REQUEST_TYPES` 无卡片决策入口；
`Topic`/`ReviewState` 从未被生产路径创建；`listPendingCards` 为死代码。


## Phase 2 Planning — req-2026-09-29-synapse-workflow-elegance

**Artifacts (all four prior versions archived byte-exactly first)**

| Artifact | Version | Content |
|----------|---------|---------|
| `08-spec.md` | v4 | 新增 R1（判据可判定且可执行 SC-R1-01/02）、R2（审计必须枚举真实面 + 单列四类失败模式 SC-R2-01/02）、R3（P0/P1 必须在同一需求内修掉 SC-R3-01…06）、MODIFIED R4（失败不得隐形 SC-R4-01）+ 约束（零新依赖、零新出网、新类型限扩展页面、vault 不降级、基线不红） |
| `04-design.md` | v4 | F1 判据门禁文档 · F2 审计方法 · F3 提案闭环 · F4 冲突决策面 · F5 失败可读化 · F6 SSH 引导 · F7 本地主动性 · F8 首启层级选择；每个 Feature 都回答了"工作流与协作四问"（R1 的范式落地） |
| `05-test-plan.md` | v3 | 新增 docs-contract 层（TC-DOC-U01…U04）+ F3–F8 的 UNIT/INT/E2E 用例 + REG/SMK 基线约束 |
| `02-plan.md` | v4 | G0–G8 共 30 项任务，逐项带 verify 命令；明确 Open backlog |

**Phase 2 decisions (autopilot auto-picked)**

- `phase2_plan_ready` → continue（默认）。
- **P1-3 检索增强延后**：需要独立设计（本地向量 vs 词项扩展）与评测方法，草率实现会伤害检索质量；已写入 Open backlog，
  并在 plan/test-plan 中显式标注，不是静默丢弃。
- 三个新 request type 的契约在 Phase 2 冻结（A3）：`cards.list` / `card.decide` / `conflict.resolve`。
- 归档路径定为 `archive/cards/**` 与 `archive/conflicts/**`（不进 NOTES.md 目录，但不删除）。

**Pre-Dev gate (B.15)**: L 复杂度要求硬门；autopilot 下仍会停下来确认（这是 autopilot 的定义）。


## Doc sync — 理念细化（用户 2026-09-29，B.14）

用户把理念细化为**两轴**并明确要求"同步到文档 + 按此方向优化产品"：

- **轴一 工作流深度**：捕获 → 暂存 → 整理 → **连接** → 提炼 → **复习** → **输出** → **应用**（8 阶段；加粗三项为本次新明确，前次只覆盖 6 阶段且 连接/输出/应用 完全空缺）。
- **轴二 协作优雅**：E1 介入时机 · E2 建议而非命令 · E3 可解释可控制 · **E4 学习用户偏好** · **E5 错误可纠正**（后两项此前没有任何实现）。
- **参考旅程**（论文 → 建议主题 → 确认 → 复习提醒 → 自评 → 调整时间）写入判据文档作为验收剧本。

| 文档 | 版本 | 变更 |
|------|------|------|
| `docs/product/00-design-principles.md` | new | 两轴 + 8 阶段承诺与克制点 + E1–E5 判定问题与反例 + W1–W6 + 必答四问 + CR 门禁 10 条 + 反例库（含我们自己的 5 条历史错误） |
| `AGENTS.md` | new | 非协商规则（设计门禁 / 产品约束 / 安全约束 / 工程约束 / 文档同步） |
| `README.md` | edited | 顶部增"产品立场"并指向判据文档 |
| `08-spec.md` | v5 | R1 重写为两轴可判定；新增 R5（连接/输出/应用 本地优先）与 R6（E4 抑制、E5 纠错记忆）；新增约束"偏好只存本地" |
| `04-design.md` | v5 | 追加 Revision 5：F7 扩展（偏好/抑制只写 storage.local）、**新增 F9 连接与输出**、CKF 增 @@related_ids@@、4 项新风险 |
| `05-test-plan.md` | v4 | 追加 Revision 5：TC-P9-U01…U06 / I01–I02 / E01；E2E 基线 12 → 15 |
| `02-plan.md` | v5 | 追加 G9（T9.1–T9.6）与 G10（T10.1–T10.3）；任务 30 → 39，request type 3 → 7 |

**待确认取舍**：7 个新 request type + 4 处界面使本次范围接近翻倍；已给出三档选择，推荐全纳入（除 @@note.export@@ 外全是纯本地规则、零出网，且正对应最薄弱的 E4/E5 与空缺的连接/输出/应用）。


**范围决定（autopilot 自动采用推荐档，2026-09-29 19:15）**：交互确认因单次调用超时而未能完成投递，
按用户既有的 `/od auto`（全程自动推进）与"按这个方向优化产品"的明确指示，自动采用推荐档 = **全部纳入本次**：
G2/G3 两个 P0 + G9（连接/输出/应用）+ G10（E4/E5 记忆），共 39 项任务、7 个新 request type。
该决定可随时用 `/od ad` 缩减（只做 连接+记忆，或全部延后）。理由：除 `note.export` 外全部是纯本地规则、
零出网、零新依赖，且正对判据中最薄弱的 E4/E5 与空缺的连接/输出/应用三阶段。

## 交接清单（2026-09-29，第 8 轮后）— 逐项带文件与锚点，供下一轮直接开工

**已完成并可复验**：G0（判据/门禁文档 + AGENTS.md + 文档契约测试）· G1（全量审计）· G2 后端+界面（提案闭环）· G3 后端（冲突决策）· G4 判据表 · G5 纯函数。
基线：extension UNIT 576/48 · INT 114/13 · E2E 12/12 · build 0 · assert OK；companion tsc 0 · 48/6 · SYS 8。

### 1. T3.4 — options 同步页签接三选一（最高优先，因为现在界面在说谎）
- 落点：`apps/extension/entrypoints/options/main.ts` 的"同步"区块（`conflictRows` 目前传的是 `string[]`）。
- 数据来源已就位：`sync.status` 返回 `conflicts: [{path, conflictPath, readable}]`（handlers.ts）。
- 现有函数 `lib/ui/format.ts:904 conflictRows(conflicts: readonly string[])` 需要接受上述对象数组（保持向后兼容：字符串仍可）。
- **必须删掉过时文案**（已于第 19 轮完成）：英文值 `'Conflict resolution is confirmed by the next sync — the handler currently reports conflicts only.'`（i18n.ts ~186 行附近，键名含 `options.sync.conflicts`）及其中文对应项 —— 后端已实现，`conflict.resolve` 立即生效。
- 动作 → `conflict.resolve {path, conflictPath, action}`；`keep-both` 不产生提交，文案应说明"两版原地保留"。

### 2. T4.1 双语键 + T4.2/T4.3 失败指引投影
- 键：每个 `ErrorCode` 两条（`guidance.<code>` / `guidance.<code>.action`），双语齐备。插入锚点（各自字典内唯一）：
  en → `'status.conflicts': '{count} conflicts',` 之后；zh → `'status.conflicts': '{count} 冲突',` 之后。
  表已在 `lib/status.ts` 的 `ERROR_GUIDANCE`（穷尽性由 `Record<ErrorCode, …>` 编译期保证；测试 `lib/status-guidance.test.ts` 覆盖行格式与兜底）。
- 投影链：`SyncState.lastErrorCode: ErrorCode | null`（`lib/sync/cache.ts`，normalize 容错）← `performSync` 的 `catch` 用 `router.ts` 既有的 `errorCodeOf(error)` 记录后**再抛出**（调用方仍要看到失败）→ `PublicSyncState.lastFailureCode`（`lib/public-prefs.ts`）→ `syncLineParts` 增 `failure: ErrorGuidance | null`（`lib/status.ts`）→ 状态行渲染 + 按 `target` 接动作（retry → 再次 `sync.now`）。
- 硬约束：**永不渲染 worker 的原始句子**（`syncLineParts` 现有注释已声明此意图，继续遵守）。

### 3. T5.2 — options SSH 区块
- 用 `lib/ui/auth-form.ts` 已备好的 `cloneCommand(remoteUrl, repoRoot)`（远端可用 `sshRemoteUrl(host, user, owner, repo)` 拼）与 `repoRootError(repoRoot)`；展示命令 + 一键复制 + 字段级错误提示。

### 4. 测试与收口
- **TC-P3-E01**（提案接受/丢弃）、**TC-P4-E01**（冲突三选一）、TC-P9-E01（参考旅程）三个 E2E 未写；E2E 基线 12 → 计划 15。
- **T2.6** 与 **G10** 合并：accept 时创建 `ReviewState`（`review/state.json`，首次真正产出该类型），G10 的 `dueForReview` 读它。
- **G9** 连接/输出/应用（`lib/local/links.ts` + `link.suggest/link.decide/note.export/note.mark`）· **G10** E4/E5 本地偏好（`lib/local/preferences.ts`，**只写 storage.local**）· **G7** 首启层级显式选择。
- **G8** 收口：全量回归 + **B.22 增量审计**（本次新增 7 个 request type 是新攻击面：全部须在 `SECRET_BEARING_TYPES` + 限流 + 参数校验，并把归档路径 `archive/**` 的写入纳入审计范围）+ 文档同步（README/审计报告/plan 勾选）。


## 轮次记录：第 23 轮（验证轮）

- 动作：build + **全量 E2E 12/12**（覆盖被 T3.4 改动的 options 渲染路径）。无新增代码。
- 理由：下一步（G10 读侧 / T4.3 动作）需要先读未读过的界面代码；在余量不足时不落地未验证改动，避免破坏「证据先于完成」的纪律。
- 下一轮入口（已锁定，无需重新发现）：
  1. **G10 读侧**：新增 `review.due`（无 payload）→ 读 `review/state.json` → 映射为 `ReviewInput` → `dueForReview` → 在 popup「待处理」区显示「今天该复习 N 条」。契约需进 `SECRET_BEARING_TYPES` + 限流。
  2. **T4.3 动作**：popup/options 的状态行按 `failure.target` 接动作；同时把 `describeError`（format.ts）与 `ERROR_GUIDANCE`（status.ts）**合并为单一错误字典**（避免第三个分叉）。
  3. 三个 E2E（提案决定 / 冲突三选一 / 参考旅程，基线 12 → 15）· G9 连接与输出 · G7 首启层级选择 · G8 收口。


## Resume Instructions (current — 2026-09-29, supersedes the older block above)

**Where we are**：req-2026-09-29-synapse-workflow-elegance 的 Phase 3 进行中，autopilot 开。已落地：判据与门禁文档（+契约测试）· 全量功能审计（含复审与增量安全审计）· **提案闭环**（cards.list/card.decide + popup 待处理区）· **冲突决策面**（conflict.resolve + 三选一 + 归档路标）· **失败可读**（表 + 双语键 + 状态行原因）· **复习回路**（accept 写 ReviewState → review.due 读回 → popup 呈现）。

**下一步（按依赖顺序，入口均已勘明，不要重新发现）**：

1. **T4.3 失败动作接线 + 合并错误表**：先读 `apps/extension/lib/ui/format.test.ts` 中 `describeError` 相关断言 → 让 `describeError` 从 `lib/status.ts` 的 `ERROR_GUIDANCE` 派生（依赖方向已确认无环：format → status 单向）→ **同一次提交内**更新受影响断言；随后 popup/options 按 `syncLineParts.failure.target` 接动作（retry→sync.now；unlock→聚焦口令；storage/companion→打开对应页签；none→不给按钮）。
2. **T5.2 SSH 区块**：`lib/ui/auth-form.ts` 已有 `cloneCommand` / `repoRootError`（含测试），接到 options 存储页（展示命令 + 一键复制 + 路径校验）。
3. **T9.1–T9.6 连接/输出/应用**：`lib/local/insights.ts` 已有 `recallHint`（**带理由**）/`suggestTopic`（**并列时不建议**）；接上后 `Topic` 将从「悬空类型」变成**首次被真实创建**的记录。契约新增 `link.suggest` / `link.decide` / `note.export` / `note.mark`，全部须进 `SECRET_BEARING_TYPES` + 限流。
4. **T10.x E4/E5 接线**：`lib/local/preferences.ts` 已有拒绝抑制与纠正记忆（**import 为空，只写 storage.local**），需要 `cards.list` 携带抑制标记（契约扩展）。
5. **T7.x 首启层级选择** · **T2.7/T3.5 三个 E2E**（提案决定 / 冲突三选一 / 参考旅程，基线 12 → 15）· **G8 收口**（全量回归 + 文档同步 + 台账更新）。

**硬约束（每次改动都要满足）**：零新依赖 · 零新出网 · 新 message type 必须进 `SECRET_BEARING_TYPES` + 限流 · vault 不明文降级 · 新文案双语齐备 · 基线不下降（UNIT ≥593 / INT ≥115 / E2E ≥12；companion 48/8）· **不执行 git commit/push**。完整门禁见 `AGENTS.md`，上游判据见 `docs/product/00-design-principles.md`。

**复跑命令**（离开会话前/接手先跑）：
```
cd apps/extension && npx tsc --noEmit && npx vitest run && npx vitest run --config vitest.int.config.ts && npm run build && npm run assert:content && npx playwright test
cd apps/git-bridge && npx tsc --noEmit && npx vitest run && npm run test:sys
```


## Resume (`/od 继续完成未完成的部分`, 2026-09-29)

用户指示继续完成剩余 22 项任务。已核对磁盘状态：工作区 clean（全部改动已提交并推送，HEAD = `857982d`）、`flow-board` 指向 Phase 3、`02-plan.md` 有 22 项未勾选。**本次为 Phase 3 续做，不重跑 Phase 0。**

### T4.3 的落点（本轮勘明，省下一次读取）

popup 的同步行在 `entrypoints/popup/main.ts`：元素建于 **147–157 行**（`syncOutcomeText` 徽标 / `syncCountsText` 计数 / `syncNowButton`，合成于 `syncRow`），渲染在 **约 325 行**（`syncOutcomeText.textContent = t('options.sync.outcome.' + syncView.outcome)`）。失败的**码**来自 `prefs.sync.lastFailureCode`（`status.get` 已投影），因此接线点是该渲染函数：由码取 `errorGuidance()` → 把原因写进 `syncCountsText`，并按 `target` 决定按钮（retry→`sync.now`；storage/companion→`openOptionsPage()`；unlock→聚焦口令输入；none→不加按钮）。

### 合并两张错误表的**低风险路径**（本轮同时勘明）

现有断言（`lib/ui/format.test.ts:101/116/120/122/145/147/152–157`）依赖 `describeError` 的既有词表：message 走 `error.<code>`，hint 走 `popup.needSetup` / `popup.needUnlock` / `options.store.scopeHint` 且**部分码的 hint 为 null**（如 timeout）。因此**不要**把 `describeError` 改成从 `ERROR_GUIDANCE` 派生（会改变这些文案并波及 8 处断言）。正确方向相反：**让 `ERROR_GUIDANCE` 的 `titleKey` 复用既有的 `error.<code>` 家族、只保留新增的 `guidance.<code>.action`**，并加一条测试断言「每个码的 titleKey 都能解析且不等于键名」。这样删掉 23 个重复的 `guidance.<code>` 键即可，不必动 `describeError` 的语义。

### 其余入口

T5.2 SSH 区块（`auth-form.ts` 的 `cloneCommand`/`repoRootError` 已备）· T6.4 复习队列补测 · T7.x 首启层级选择 · T9.1–T9.6 连接/输出/应用（`insights.ts` 的 `recallHint`/`suggestTopic` 已备）· T10.x E4/E5 接线（`preferences.ts` 已备，只写 `storage.local`）· T2.7/T3.5 三个 E2E · T8.x 收口。


### 用户标准更新（2026-09-29）

用户要求「继续完成剩下的部分，确保是一个完整可用的产品」。据此把剩余 21 项分为：**A 必须做**（T5.2/T5.3 SSH 引导接线 · T7.1–T7.3 首启层级选择 · T2.7/T3.5 三个 E2E）· **B 应该做**（错误字典合并 · T6.4 补测）· **C 延后到下一需求**（T9.x 连接/输出/应用 · T10.x E4/E5）· **D 收口**（T8.x）。判定标准写在 `02-plan.md` 的「完整可用产品」一节：**用户从安装到日常使用会不会撞墙或被骗**。

## Resume Instructions (current — 2026-09-29 第 42 轮，supersedes the block above)

**Where we are**：`req-2026-09-29-synapse-workflow-elegance` 的 Phase 3 **收口完成** —— 上面这条判定里的 A / B / D 组全部落地并验证；C 组（T9.x / T10.x）按该判定**明确延后**到下一需求，未做也未假装完成。

**本轮落地（逐项可复验）**：

- **T5.2/T5.3**：存储页 SSH 区块的克隆引导（这条命令 + 一键复制 + 路径在我们这边判定）；顺手修掉两个既有「界面在说谎」的缺陷（`ssh.*` 字段从不回填输入框、授权方式选择器从不反映已存储模式）。
- **T7.1/T7.2/T7.3**：首启内容档位成为**一次显式选择**（未选不可保存，两个选项各带一句人话后果）；仓库侧记录由 `storeConfigFileIfMissing` 随**捕获自身的那次提交**写入 —— 已记录、或有内容但无记录时都不写（永不覆盖、永不猜）。
- **E2E 12 → 19**：提案决定（`cards.spec.ts`）· 参考旅程（`review-journey.spec.ts`）· 首启档位（`first-run.spec.ts`）· 冲突三选一（`sync.spec.ts` 两条）。
- **T8.1/T8.2/T8.3**：全量回归 · B.22 `iteration 4 = PASS` · README / AGENTS 基线（→ 600 / 117 / 19）/ 审计 / 进度 / 计划同步。

**E2E 抓到的四件事（前 600 个单测都没抓到）**：① 一次保存里连发两次 `settings.security` 被限流（本轮引入，已合并为一次往返）；② `saveAuthSection` 是**死代码**，而档位持久化错落在其中 —— 界面上的「选择」根本不会落盘；③ 同步页签**不重读**状态，后台刚记下冲突时界面仍显示「冲突 0」；④ 冲突行不显示持有自己那一版的**兄弟路径**（三选一面对的是约定而不是路径）。

**验证（本轮实测）**：extension tsc 0 · UNIT **600 / 52** · INT **117 / 13** · E2E **19 / 19** · build 0 · `assert:content` OK；companion tsc 0 · UNIT **48 / 6** · SYS **8**。**零 git 提交（B.16）**。

**下一步**：Phase 4 的 `05-test-report.md` 仍是上一个需求的报告（本需求没把它列为交付物）；若要正式走 Phase 4，需先归档再重写。Phase 5 部署（`make deploy`）是维护者动作。C 组（连接 / 输出 / 应用、E4/E5 记忆）是下一需求的入口。

## Resume Instructions (current — 2026-09-30，supersedes the block above)

**Where we are**：`req-2026-09-30-synapse-auth-tier-integrity`（深度审计 → 修 P0/P1）的 Phase 3 **完成并全绿**；Phase 4/5 未跑（本轮交付物是修复 + 证据，不是新的测试报告）。

**本轮落地**：
- **G0（P0）**：`resolveStore` 改走 `resolveAuth`，token 与 SSH 共用一个 `RepoStore` 门面（`lib/store/repo-store.ts`）；`GitHubStore` 内部委托同一门面；`resolveSyncRemote` 复用同一次解析。顺手修掉"存储页保存 SSH-only 配置必然失败"。
- **G1（P1）**：`resolveRepo` 先 `loadStoreConfig`，**仓库记录的档位优先**；档位变更走 `switchTier` 守卫（有内容 → `tierLocked` + 动作；空仓库 → 写 `config.json`）。
- **附带**：`ERROR_CODES` 改为由 `Record<ErrorCode, true>` 推导（此前漏 5 个声明码）；`tierLocked` 新码 + 双语指引。

**验证（全绿）**：extension tsc 0 · UNIT **600** · INT **120** · E2E **19/19** · build 0 · `assert:content` OK；companion tsc 0 · UNIT **48** · SYS **8**。零 git 提交（B.16）。

**下一步**：① Phase 4 若要正式走，需先归档上一需求的 `05-test-report.md` 再重写；② 未修项 → `02-plan.md` Open backlog（`listPendingCards` 死代码 · 真正换档位的迁移 · 可选主机权限）；③ 上一需求的 C 组（T9.x/T10.x）仍是下一需求的入口。

## Phase 0 Assessment — 深度审计请求（2026-09-30）

**Requirement Analysis**：对整个实现做一次独立、证据化的深度检查（问题 + 安全风险），不是新功能。
**Complexity Assessment**: **M** —— 取证已完成；修复集中在 1–2 处接线，但涉及授权模式与档位契约，属高风险改动。
**Recommended Strategy**: Phase 0 → 2（Plan：发现 → 修复清单）→ 3（修复 + 门禁）→ 4（Test）。跳过 Blueprint（无方案选择）。
**Confirmation Level**: full（涉及 P0 功能断裂与安全姿态）。

**取证结论（文件:行）**：

1. **P0 · SSH 授权模式只通了一半（界面在说谎）**：`resolveStore()`（`lib/background/handlers.ts:111-137`）硬要求 `secrets.githubPat` 并构造 **token** 版 store；只有 `resolveSyncRemote()`（`handlers.ts:176-212`）按 `authMode` 走 SSH。使用 `resolveStore` 的处理器：`status.get:454` · `inbox.list:463` · `capture.request:478` · `store.probe:554` · `conflict.resolve:713` · `review.due:792` · `cards.list:816` · `card.decide:850` · `runDistill:920`（即 `distill.request`）。而 `isConfigured()`（`lib/public-prefs.ts:150-153`）在 SSH + companion ok 时返回 true → 界面说「已配置」，随后捕获/提炼/Inbox/提案/复习/冲突决策/测试连接全部 `notConfigured`。
2. **P1 · 仓库记录的档位在运行时从不被读取**：`resolveTier` / `loadStoreConfig` / `saveStoreConfig` / `switchTier`（`lib/store/tier.ts`）**只有测试调用**；运行时代码选 codec 的唯一依据是 `settings.securityMode`（`handlers.ts:128`、`:193`、`lib/store/github-store.ts:316`）。`storeConfigFileIfMissing` 读 config 只为决定「要不要写」。后果：README/`04-design` 的「仓库记录的档位优先」不成立；同一仓库被两个 `securityMode` 不同的客户端打开时，transparent 端会把**明文写进 vault 仓库**（不降级原则被绕过），vault 端会把密文写进 transparent 仓库；`switchTier` 的「有内容即拒绝切换」保护因此永不生效。
3. **P2 · 死代码**：`GithubStore.listPendingCards`（`lib/store/github-store.ts:253`）仅测试调用，生产用索引直接过滤。
4. **P3 · 权限面**：`optional_host_permissions: ['https://*/*']` + `unlimitedStorage` + `scripting`（`wxt.config.ts:21-38`）——有 trust-ack 与运行时按需授权兜着，但应在审计文档里显式记录为已接受风险。
5. **P4 · 限流与正常操作冲突**：vault 预算 12/分钟/标签页，options 一次加载约花 5；同一窗口内第二次保存可能被拒（E2E 已复现）。安全姿态正确，但用户会看到 `rateLimited` 这种缺动作指引的失败，值得检查 `errorGuidance` 对它的 target。

**已确认干净（本轮复核）**：无 `eval`/`innerHTML`/shell；`SECRET_BEARING_TYPES` 覆盖全部触仓库/companion 的类型，内容脚本只能发 `prefs.get`/`capture.request`（`lib/messages.ts:482-511`）；`assert:content` OK；companion 的 `.git/**` 拒绝仍在；工作区无密钥。


