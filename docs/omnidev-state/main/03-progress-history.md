# History: 03-progress.md

Append-only archive. Do not edit or delete past snapshots.
Newest entries appended at **bottom**.

| Metric | Value |
|--------|-------|
| snapshots | 1 |
| first_archived | — (reconstructed) |
| last_archived | 2026-07-09 00:00 |

> **Process note (honest record).** The previous requirement's `03-progress.md` was **overwritten**
> when the git-sync requirement started, before it was archived — `03-progress-history.md` did not
> exist yet, so document-history §2.1 was not followed. The snapshot below is a **reconstruction**
> from the session record, not a byte-exact copy. Every fact in it is independently verifiable from
> the files it names (`06-release-notes.md`, `07-security-audit.md`, `05-test-report.md`).
> The other artifacts of that requirement (`01-blueprint`, `02-plan`, `04-design`, `05-test-plan`)
> **were** archived byte-exactly, each verified with a byte comparison.

---

## [ARCHIVE] 03-progress.md · v1 · 2026-07-09 00:00 (reconstructed)

| Field | Value |
|-------|-------|
| version | 1 |
| archived_at | 2026-07-09T00:00:00+08:00 |
| reason | new_requirement — superseded by req-2026-07-09-synapse-git-sync |
| trigger | /od (new requirement on main) |
| requirement_id | req-2026-07-09-synapse-ext-mvp |
| summary | Phase 3 progress for the browser-extension MVP: 10/10 groups done, security audit PASS |

<!-- BEGIN SNAPSHOT (reconstructed) -->

**Requirement**: `req-2026-07-09-synapse-ext-mvp` — browser-extension MVP (capture → Inbox →
opt-in AI distill → GitHub). Complexity L · spec mode active · autopilot enabled by user pick.

### State Snapshot

| Group | Theme | Tasks | Status |
|-------|-------|-------|--------|
| G0 | Bootstrap (F9) | T0.1–T0.4 | ✅ done |
| G1 | Canonical core (F2) | T1.1–T1.5 | ✅ done |
| G2 | Security & secrets (F4) | T2.1–T2.7 | ✅ done |
| G3 | Content codec & tier (F3) | T3.1–T3.4 | ✅ done |
| G4 | Provider & AI client (F5) | T4.1–T4.6 | ✅ done |
| G5 | GitHub store adapter (F6) | T5.1–T5.6 | ✅ done |
| G6 | Capture pipeline (F1) | T6.1–T6.7 | ✅ done |
| G7 | Distillation & ledger (F7) | T7.1–T7.5 | ✅ done |
| G8 | UI surfaces (F8) | T8.1–T8.6 | ✅ done |
| G9 | Release & verification (F9) | T9.1–T9.6 | ✅ done |

### Verification Evidence (Phase 3 exit)

| Check | Command | Result |
|-------|---------|--------|
| Typecheck | `npx tsc --noEmit` | exit 0 |
| UNIT | `npx vitest run` | 381 passed / 30 files |
| INT | `npx vitest run --config vitest.int.config.ts` | 67 passed / 9 files |
| Build | `npm run build` | ✓ ~237 kB, 1 content-script file |
| Content-bundle secret gate | `npm run assert:content` | OK |
| Dependency audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Security audit (B.22) | `07-security-audit.md` | **PASS**, iter 2, 0 blocking |
| E2E | `npx playwright test` | **6 passed** (4 specs) |

### Defects found by the gates and fixed

1. **Vault-mode metadata leak** (found by TC-F6-I01): the page title travelled in the file path and the
   commit message, and the canonical URL in `index.json`. Fixed with `opaqueRecordContentPath`
   (id-only names), title-free commit messages for vault mode, and a fingerprinted `url_key`
   (`dedupUrlKey()` derives the key per tier so dedup still works in both).
2. **Empty-bodied captures collided** in content-hash dedup, so a second title-only capture was
   reported as a duplicate of the first. Dedup now ignores bodies under 200 characters.
3. **The worker was completely inert** (found by the E2E gate): `browser.commands.onCommand` was
   registered at top level while the manifest declared no `commands` key, so the API was `undefined`
   and the worker threw **during its initial evaluation, after `onMessage` had been registered**.
   Chrome treats such a worker as failed and silently stops dispatching events to it — while
   `hasListeners()` still returns `true`, so all 448 unit/INT tests passed. Fixed by declaring the
   commands **and** guarding every optional browser API at top level. Root-caused by bisecting a
   throwaway extension (my manifest + a trivial worker passed; a minimal manifest + my worker failed).

### Notes carried forward

- Never edit source files through PowerShell redirection (`Set-Content` corrupted a UTF-8 em dash once).
- `Uint8Array` → `BufferSource` needs `toBufferSource()` from `lib/security/crypto-key.ts`.
- A `KeySession` judges its own freshness: a store with an injected clock must not be paired with a
  session on a different clock, or a valid session reads as expired.
- WXT's storage API takes `local:`/`session:`-prefixed keys and strips the prefix when writing.
- Playwright's `Worker` type has **no `console` event** — service-worker logs are invisible to a test;
  evaluate on the worker instead.

<!-- END SNAPSHOT (reconstructed) -->

---
## Archived 2026-09-30 - req-2026-09-30-synapse-auth-tier-integrity
# Progress — Phase 3 Development (`req-2026-07-09-synapse-git-sync`)

> Active snapshot. Appended to `03-progress-history.md` on `/od compress` or phase exit.
> The previous requirement's progress is in `03-progress-history.md` — **reconstructed**, see the note
> at the top of that file.

**Branch**: main · **Complexity**: L (effective **XL**) · **Spec mode**: active (`08-spec.md` v2)
**Status**: Phase 3 **in progress** — G0, G1 (partial), G2 (partial), G3 (partial), G5 done and green.

## Verification Evidence (current)

| Check | Command | Result |
|-------|---------|--------|
| Extension typecheck | `npx tsc --noEmit` | **exit 0** |
| Extension UNIT | `npx vitest run` | **428 passed / 34 files** |
| Extension INT | `npx vitest run --config vitest.int.config.ts` | **81 passed / 10 files** |
| Companion typecheck | `cd apps/git-bridge && npx tsc --noEmit` | **exit 0** |
| Companion UNIT | `cd apps/git-bridge && npx vitest run` | **11 passed / 3 files** |

Baseline before this requirement: 381 UNIT / 67 INT. Net new: **+47 UNIT, +14 INT, +11 companion**.

> **Caveat on these numbers**: they were measured at a quiescent moment. Two sub-agents (the search
> layer and the companion) were still writing when this snapshot was taken — a later run showed
> 453 UNIT / 87 INT with the companion briefly red mid-write, then green again. Treat the table above
> as a **floor**, and re-run the commands below before trusting any figure.

## Task Status

| Group | Theme | Pkg | Status |
|-------|-------|-----|--------|
| G0 | Foundations (settings · public prefs · messages · protocol) | extension | ✅ **done** |
| G1 | GitAuth abstraction (F1) | extension | ✅ **done** (T1.1–T1.4, T1.6-equivalent); T1.5 `GitTransportStore` ⏳ |
| G2 | Companion host (F2) | git-bridge | ✅ **done** (T2.1–T2.5); SYS suite ⏳ |
| G3 | Native messaging client (F2) | extension | ✅ **done** (T3.1–T3.3); manifest/assertion extension ⏳ |
| G4 | Sync engine (F3) | extension | 🟡 `reconcile.ts` + `cache.ts` **done**; `engine.ts`/`triggers.ts`/handlers ⏳ |
| G5 | Search & retrieval (F4) | extension | ✅ **done** (T5.1–T5.4); index orchestration wiring into sync ⏳ |
| G6 | UI surfaces (F5) | extension | ⏳ not started |
| G7 | Layout & migration safety (F6) | extension | 🟡 default flip + `SAFE_FALLBACK_MODE` **done**; `resolveTier`/config fields ⏳ |
| G8 | Tooling, packaging, CI (F7) | both | ⏳ not started |
| G9 | E2E verification | extension | ⏳ not started |

## What Was Built (verified)

**G0 — foundations** `[pkg:extension]`
- `lib/settings-store.ts`: `authMode`, `ssh { host, user, keyRef, repoRoot }`, `syncPolicy { intervalMinutes, onStartup, onCapture, pullOnly }`; `DEFAULT_SETTINGS.securityMode` flipped to `transparent`.
- `lib/public-prefs.ts`: projection extended with `authMode`, `branch`, `sshHost`, `companion`, and a content-free `sync { lastSyncAt, lastOutcome, pending, conflicts }`; `isConfigured` now understands SSH mode (companion instead of token).
- `lib/messages.ts`: 4 new error codes (`nativeUnavailable`, `protocolMismatch`, `syncConflict`, `indexUnavailable`), 7 new request types (`auth.probe`, `native.status`, `sync.now/status/policy`, `search.query/rebuild`), validators, and all of them added to `SECRET_BEARING_TYPES` so page context can never reach them.
- `lib/native/protocol.ts`: the companion contract — version, op allow-list, all data shapes, runtime narrowing for each, and `nativeCodeToErrorCode`.
- `lib/store/tier.ts`: **`DEFAULT_SECURITY_MODE` = `transparent`** (new store, readable) split from **`SAFE_FALLBACK_MODE` = `vault`** (corrupt/unknown config fails closed). This split is deliberate: one unreadable byte must never downgrade an encrypted repository to plaintext.

**G1 — auth (F1)** `[pkg:extension]`
- `lib/auth/types.ts`: `GitAuth` + the two narrowed transports (`TokenBackedAuth` with `createStore()`, `SshBackedAuth` with `info()`/`createTransport()`), `AuthResolution` as data, `AuthUnavailableReason`.
- `lib/auth/token-auth.ts`: the 0.1.0 path behind the abstraction, fail-closed on a locked vault.
- `lib/auth/ssh-auth.ts`: holds **no secret** — host, user, key *reference*, local clone path only. `probeFromCompanion` deliberately reports `visibility: 'unknown'` because SSH access is not evidence of privacy.
- `lib/auth/resolve.ts`: `resolveAuth` returns `{ ok:false, reason }` for the five expected unavailability reasons and lets genuine bugs propagate; `probeAvailability` powers the mode picker.

**G2 — companion (F2)** `[pkg:git-bridge]` — **new second deliverable**
- `src/protocol.ts`, `src/guard.ts`, `src/git.ts`, `src/main.ts`; `execFile`-only git wrapper, op allow-list, realpath path confinement, `GIT_TERMINAL_PROMPT=0`, no credential material ever leaving the process. Verified by tests that assert the argv array and that no shell is used.

**G3 — native client (F2)** `[pkg:extension]`
- `lib/native/client.ts`: injected `connectNative`, handshake, request/response correlation, per-op timeouts (10 s / 60 s for git ops), fail-all-in-flight on disconnect, reconnect-once, cached availability, plus `createFakePort` for tests.

**G4 — merge core (F3)** `[pkg:extension]`
- `lib/sync/reconcile.ts`: pure `planMerge` covering all five cases. **Conflict policy: both versions always survive** (remote keeps the path, ours becomes `<stem>.conflict-<stamp>.<ext>`); a remote deletion of a locally-changed note **resurrects** ours rather than dropping it. `push` is the complete act-on-this set; `resurrect`/`conflicts` are informational subsets. 14 tests.
- `lib/sync/cache.ts`: decoded-record cache + sync state + dirty set behind a `CacheBackend` seam (IndexedDB backend, memory fallback). The cache is disposable by design — everything rebuilds from the repository.
- `lib/sync/manifest.ts`: **`index.json` doubles as the remote manifest.** Every commit writes it and it already lists every path with kind/id/timestamps, so a pull needs only **two requests** (ref + index) and **no tree walk and no `compare` API** — the engine diffs the manifest against the cache and fetches only the blobs that moved. Version comparison prefers `content_key` over `updated_at`, so a metadata-only rewrite correctly reads as unchanged instead of refetching the repository. 11 tests.

> **Design refinement (saves a planned task)**: T4.3 in `02-plan.md` ("remote head + changed-path diffing via tree/compare") is **no longer needed** — `manifest.ts` replaces it with a cheaper mechanism that also works identically over the SSH transport (where the companion would otherwise have to run `git diff --name-status`).

**G5 — search (F4)** `[pkg:extension]`
- `lib/search/{tokenize,postings,query,docs,index}.ts` with CJK bigram tokenization, prefix-sharded postings, weighted + recency-ranked queries with snippets, corrupt-shard → `needsRebuild`, and the readable `NOTES.md` catalogue with a content-hash guard.

## Incomplete Items (next session, in build order)

- [ ] **T4.5–T4.9 sync engine** — `lib/sync/engine.ts` assembling what already exists and is tested:
      `resolveAuth` (mode) → `readIndex` (remote manifest) → `diffRemoteManifest` →
      `localChanges(cache.dirty())` → `planMerge` → fetch only `plan.pull` → decode via the active
      codec → `SyncCache.put` + `SearchIndex.upsert` → commit `plan.push` + the record's
      `changedShards` in **one** commit (the search agent's contract) → `cache.clean(plan.push)` +
      `updateState({ head })`. Then `lib/sync/triggers.ts` (startup/capture/alarm/unlock/manual +
      coalescing) and the sync handlers.
      **All the decisions are already made and tested** — the engine only executes them.
- [ ] **T1.5** `store/git-transport.ts` (`KnowledgeStore` over the companion) — needed before the SSH
      path of the engine can run, though the token path works without it.
- [ ] **T6.x UI**, **T7.x `resolveTier`/config fields**, **T2.6 companion SYS suite**, **T8.x
      packaging/CI**, **T9.x E2E**, manifest permissions, Phase-3-exit security audit.
- [x] ~~i18n keys for the 5 new error codes~~ — **done** (both dictionaries; parity test green).
- [x] ~~Confirm the search agent's final state~~ — **done**: 49 UNIT + 6 INT, and it correctly left
      `lib/i18n.ts` untouched.
- [ ] **T1.5** `lib/store/git-transport.ts` — `KnowledgeStore` over the companion.
- [ ] **T6.x UI** — options 存储 (mode picker + SSH section + branch check) and 同步与检索; popup status + 立即同步 + search.
- [ ] **T7.x** — `resolveTier` (recorded mode wins), `branch`/`sync_policy`/`client_version` in `.omnipilot/config.json`, 0.1.0-repository compatibility test.
- [ ] **T2.6 SYS suite** — the companion against a temp bare repo (`git init --bare`), real stdio.
- [ ] **T8.x** — native-host manifest + installer, companion packaging, `deploy` `companion` mode, CI for both packages.
- [ ] **T9.x** — E2E: remote-drift pull, no-op sync, conflict surfacing, SSH degradation, search, readable default.
- [ ] **Manifest** — add `nativeMessaging`, `alarms`, `unlimitedStorage`; extend the content-bundle assertion.
- [ ] Security audit (B.22) at Phase 3 exit — the companion is a **new privileged boundary** and must be audited.

## Notes / gotchas

- **`complexity_effective: XL`** was recorded at Phase 1 and shown at the `pre_dev` gate; the user confirmed the full scope.
- SSH mode requires a **local clone** (`ssh.repoRoot`). This was discovered while implementing F1: `git` needs a working tree, so SSH mode cannot work against a bare remote. The design's `SshConfig` was extended with `repoRoot` accordingly. The UI must state this.
- Two sub-agents were used; the first companion agent **ran out of context before writing anything**. Re-dispatched with a third of the scope, it succeeded. Lesson: keep sub-agent briefs small — the failure mode is silent (no files, no report).
- The tier-default flip intentionally broke 7 test assertions (3 unit, 3 int, 1 handler) that encoded the old default; all were updated to assert the new intent, and the *safety* property (corrupt → vault) is still asserted.

## Next Session Start Command

`/od re` then continue Phase 3 from **G4 / T4.2**. Re-verify first with:
`cd apps/extension && npx tsc --noEmit && npx vitest run && npx vitest run --config vitest.int.config.ts`
and `cd apps/git-bridge && npx tsc --noEmit && npx vitest run`.

---

## Audit — 2026-09-29 (`/od 深入检查当前项目的完整度`)

**All five verification commands re-run** (the table above was a stale floor; the doc itself said to
re-run before trusting it):

| Check | Command | Result (2026-09-29) |
|-------|---------|---------------------|
| Extension typecheck | `npx tsc --noEmit` | **exit 0** |
| Extension UNIT | `npx vitest run` | **465 passed / 37 files** (was 428 / 34) |
| Extension INT | `npx vitest run --config vitest.int.config.ts` | **87 passed / 11 files** (was 81 / 10) |
| Companion typecheck | `npx tsc --noEmit` | **exit 0** |
| Companion UNIT | `npx vitest run` | **11 passed / 3 files** |

**Corrections to the task table above** (verified against disk, not taken on trust):

- **G3 is not "done with tests"** — `lib/native/` ships `client.ts` + `protocol.ts` but **no test
  files at all**: `native/client.int.test.ts` (T3.2) and `native/protocol.test.ts` (T3.1/T3.3) do not
  exist, so both planned verify commands are unrunnable. T3.4 is also unmet: `wxt.config.ts`
  permissions are still `storage/activeTab/scripting/contextMenus` — **`nativeMessaging` is absent**,
  so the companion is unreachable at runtime and the SSH requirement is non-functional end to end.
- **G4/T4.2 is not fully done** — `lib/sync/cache.test.ts` does not exist (verify command unrunnable).
- **G2/T2.5 drift** — `key.list` lives in `src/git.ts` + `src/main.ts`; there is no `src/keys.ts`.
- **G8 is partially done, not "not started"** — `.github/workflows/ci.yml` (extension job only: no
  companion, no SYS, no new-feature E2E) and `deploy/{deploy.sh,pack/deploy.sh,README.md}`
  (chrome/firefox only; **no `companion` mode**) already exist on disk. Still missing: the native-host
  manifest + installer (T8.1) and `apps/git-bridge/scripts/pack.mjs` (T8.2).
- **`/od re` start point is stale** — T4.1/T4.2 are done; the correct resume point is **T1.5 → T4.4**.

**Completeness**: ≈22 of 46 planned tasks verified done (**~55–60 %** of
`req-2026-07-09-synapse-git-sync`). Nothing is committed (2 commits total).

### T3.4 landed (2026-09-29)

- `wxt.config.ts`: permissions extended with `nativeMessaging`, `alarms`, `unlimitedStorage`.
- `scripts/assert-content-no-secrets.mjs`: `FORBIDDEN_MARKERS` now also rejects `connectNative` and
  `com.omnipilot.synapse.git_bridge`, so the native surface can never reach a page context.

### BLOCKER found (2026-09-29) — the SSH **pull** path is not implementable as designed

**T1.5 (`store/git-transport.ts`) and the ssh half of T4.4 cannot be built** against the shipped
companion protocol:

- `ALLOWED_OPS` (both sides) = `ping, repo.info, git.probe, git.status, git.fetch, git.commit, git.push, key.list` —
  **no operation returns file content**; `git.ts` exports only those seven git functions and `main.ts`
  dispatches exactly them.
- `KnowledgeStore` (`lib/store/types.ts`) requires `readFile(path)` and `listDir(path)`. The SSH mode cannot
  satisfy that contract, so `GitTransportStore` can only serve `probe()` + `commitFiles()` — the write half.
- `04-design.md` F3 step 2 says "fetch only added/modified blobs … `git diff --name-status` for ssh",
  but no op can fetch a blob (`git.fetch` returns `{head, ahead, behind}` only).

**Consequence**: over SSH the extension can **push but not pull or re-index**. Requirement 3 (自动推送和拉取)
is only half-satisfiable in SSH mode with the current protocol, and requirement 1 (SSH) therefore cannot
be delivered end to end. This is a design gap, not an implementation slip — hence a B.14 change confirm.

**Options**: (A) extend the protocol with a confined read op (`git.show` {rev,path} → text,` `git.ls` {rev,dir} →
entries) reusing the existing `assertArgsSafe` confinement — recommended; (B) SSH becomes push-only and
pull/index stays token-only; (C) defer SSH and build the token-path engine + UI first.



### BLOCKER (revised, 2026-09-29) — the SSH mode has **no content channel at all**, not just no read op

A second pass over the companion (prompted by reviewing `git.commit`) shows the gap is wider than the
read-only finding above, so the earlier option list is superseded:

- **No content read**: `ALLOWED_OPS` has no op that returns file bytes (already reported).
- **No content write**: `git.commit` takes `{ message, files: string[] }` where `files` are **paths**, and
  `git.commit` runs `git add -- <paths>` then `git commit` on files that must *already exist in the
  clone*. The package contains no `writeFile`, no `mkdir`, no stream — `readdir` (key listing) is its
  only fs call. So the extension cannot deliver a note's bytes into the user's working tree either.

**Net effect**: the companion is a git *runner*, not a transport. Over SSH the extension can probe, fetch,
status and push tags/branches — but it can transfer **no knowledge content in either direction**, so
SC-F1-03 (companion performs the remote operations), SC-F4-01 (push after capture) and SC-F5-02
(incremental pull) cannot be satisfied. T1.5 is not implementable and T4.4/T4.5 are only implementable
on the token transport.

**Minimum protocol additions for SSH to work** (all inside the existing privileged boundary, reusing
`assertArgsSafe` + `resolveInsideRoot`):

| # | Op | Shape | Serves |
|---|----|-------|--------|
| 1 | `git.show` | `{rev, path}` → `{content}` (cap ≈512 KiB, NUL-safe) | pull, `readFile` |
| 2 | `git.ls` | `{rev, dir}` → `[{path, type, sha, size}]` | `listDir`, rebuild |
| 3 | `git.commit` **extended** | `files: [{path, content}]` → write + `git add` + commit in one step | push |
| 4 | new error code | `notFound` (shown as absent, not as a failure) | first pull of a path |

Op 3 is a **write primitive** on a privileged boundary — new attack surface (arbitrary bytes into the
user's clone; must be confined, size-capped and never able to write outside `repoRoot`), so it needs
its own B.0 confirmation rather than being folded into the read-only approval.

Blast radius if approved: `apps/git-bridge/src/{protocol,guard,git,main}.ts` + tests,
`apps/extension/lib/native/protocol.ts`, `04-design.md` F2/F3, `02-plan.md` (T1.5 split, T2.7–T2.9,
T3.5), `08-spec.md` (SC-F2-04/05), and the Phase 3 security audit scope.

### Landed 2026-09-29 (autopilot, after `change_confirm` = proceed)

| Task | What | Evidence |
|------|------|----------|
| T3.4 | manifest permissions `nativeMessaging`/`alarms`/`unlimitedStorage`; assertion forbids `connectNative` and the host name | build 0 · `assert:content OK` |
| T2.7 | `git.show` + `git.ls` (read a tree at a revision) | TC-F2-U11…U13 |
| T2.8 | `git.write` (write + stage + commit, confined, idempotent) | TC-F2-U14…U16 |
| T2.9 | `notFound` code + rev/path/content validation in `guard.ts` | TC-F2-U12, U16 |
| T3.5 | extension protocol mirror: ops, shapes, `asGitShow`/`asGitLs`, code mapping | `lib/native/protocol.test.ts` (6) |
| T1.5 | `store/git-transport.ts` — `KnowledgeStore` over the companion | `git-transport.int.test.ts` (7) |

**Verified 2026-09-29 (all re-run, not quoted)**

| Check | Result |
|-------|--------|
| companion `tsc --noEmit` | exit 0 |
| companion UNIT | **17 passed / 4 files** (was 11 / 3) |
| extension `tsc --noEmit` | exit 0 |
| extension UNIT | **471 passed / 38 files** (was 465 / 37) |
| extension INT | **94 passed / 12 files** (was 87 / 11) |
| extension build + `assert:content` | exit 0 · OK (content bundle carries no native surface) |

unit_tests: TC-F2-U11, TC-F2-U12, TC-F2-U13, TC-F2-U14, TC-F2-U15, TC-F2-U16, TC-F2-U10, TC-F1-I02

**Design/plan/spec delta written**: `04-design.md` F1 step 3b + F2 step 1b · `02-plan.md` v3 (T2.7–T2.9, T3.5; T1.5 and T3.4 `[x]`) ·
`08-spec.md` v3 (SC-F2-04, SC-F2-05). All three prior versions archived byte-exactly to their `*-history.md`.

**Still open (next, in build order)**: T4.4–T4.9 sync engine + `triggers.ts` + handlers (the core of requirement 3, now
unblocked for **both** transports) · T3.2 `native/client.int.test.ts` · T4.2 `sync/cache.test.ts` · T2.6 companion SYS suite ·
G6 UI · G7 `resolveTier`/config fields · G8 packaging + CI for both packages · G9 E2E · Phase 3 exit security audit
(the `git.write` primitive is now part of that audit scope).


### Landed 2026-09-29 (round 2 — sync engine, retrieval wiring, verification)

| Task | What | Evidence |
|------|------|----------|
| T4.4–T4.6, T4.8, T4.9 | `lib/sync/engine.ts` (pull / push / remove / resurrect / conflict copies / single commit) + `lib/sync/shard-store.ts` + `lib/sync/triggers.ts` | `engine.test.ts` (9), `triggers.test.ts` (4) |
| T4.2 | `lib/sync/cache.test.ts` + remote-version fields on `CachedRecord` | 8 tests |
| T4.7 / T5.6 / T5.7 | handlers `auth.probe`, `native.status`, `sync.now/status/policy`, `search.query/rebuild`; `performSync` shared with the triggers | extension tsc 0 |
| T4.6 (app) | `entrypoints/background.ts`: native client, worker cache, `alarms` listener, startup schedule + startup pull | extension tsc 0 |
| T3.2 | `lib/native/client.int.test.ts` | 8 INT tests |
| T7.1–T7.4 | `resolveTier` + `branch`/`sync_policy`/`client_version` in `.omnipilot/config.json` (delegated, Agent G7) | tier UNIT 20 / INT 12 |

**Engine decisions worth knowing**

- **Change detection is manifest-based, not head-based**: the repository's own `index.json` lists every record with a `content_key`, so a pull is one index read plus only the blobs whose key moved (SC-F5-01/02).
- **Pulled records keep the remote's version key** (`CachedRecord.contentKey`/`remoteUpdatedAt`). Without that, every pulled record would look modified on the next run (our wall clock vs their timestamp) and the sync could never be a no-op.
- **A remote deletion is a remote change**: it must reach `planMerge` as `kind: 'deleted'`, and a removal alone still commits the manifest — otherwise the deleted path resurrects on the next run.
- **A conflict copy is its own index entry** (id `\<original-id\>-conflict-\<stamp\>`): sharing the original's id would make one of the two surviving versions invisible to every reader.
- **Pull-only never writes**, and the dirty paths stay queued and are reported as `pending`.

**Verified 2026-09-29 (round 2)**

| Check | Result |
|-------|--------|
| extension `tsc --noEmit` | exit 0 |
| extension UNIT | **527 / 529 passing** — the two failures are `lib/ui/render.test.ts` options-page assertions that G6 (in flight, Agent G6) is changing; not engine-related |
| extension INT | **108 passed / 13 files** (was 94 / 12) |
| companion `tsc` / UNIT | 0 / **17 / 4** |

**Still open**: G6 UI (agent in flight — must reconcile `lib/ui/render.test.ts`) · G8 packaging/CI/native-host (agent in flight) · T2.6 companion SYS suite · T9.1/T9.2 E2E · Phase 3 exit security audit (B.22) with the new `git.write` surface · plan checkboxes for G0–G3/G5 were stale and are now partly corrected.


### G8 landed (2026-09-29, Agent G8)

- `apps/git-bridge/native-host/{manifest.template.json,install.mjs}` (host `com.omnipilot.synapse.git_bridge`, per-browser dirs, `--dry-run`, Windows prints the `reg add` command instead of touching the registry).
- `apps/git-bridge/scripts/pack.mjs` (dependency-free single-file bundle to `.output/git-bridge-<platform>-<arch>.mjs`) + `pack`/`test:sys` npm scripts.
- `deploy/pack/deploy.sh` gains a `companion` mode (`all` = chrome+firefox+companion), `deploy/README.md` documents the native-host install, and `.github/workflows/ci.yml` gains a `git-bridge` job (tsc, vitest, test:sys, pack).
- Evidence: companion tsc 0 · **47 passed / 6 files** (was 17 / 4; the 30 new tests are the tooling suites) · `test:sys` exits 0 with no files until T2.6 lands.


🔒 Security audit · iter 1 · PASS · blocking=0 (S4-01 HIGH fixed in-iteration: `git.write` could install a git hook / rewrite `.git/config`)

### Landed 2026-09-29 (round 3 — SYS suite + security audit)

| Item | What | Evidence |
|------|------|----------|
| T2.6 | `apps/git-bridge/test/sys/bridge.sys.test.ts` — spawns `dist/main.js`, speaks the real 4-byte-framed stdio protocol against a temp **bare repo + clone**: handshake, repo.info, status clean/dirty, write+commit, push to the bare remote, read back through `origin/main`, confinement, unknown op, malformed frame survival | `npm run test:sys` → **8 passed** |
| — | `vitest.config.ts` excludes `test/sys/**` from the hermetic suite; `vitest.sys.config.ts` runs it; `test:sys` builds first | companion `test` → 48 / 6 |
| B.22 audit | `07-security-audit.md` v2 (v1 archived): **PASS**, iter 1, blocking 0 | one HIGH found + fixed in-iteration |

**S4-01 (HIGH, fixed)**: `git.write` writes bytes to disk *before* running git, and every path under the root was accepted — including `.git/hooks/pre-commit` (executed by the next `git commit`) and `.git/config` (can set `core.hooksPath`/`core.sshCommand`). Reproduced: the hook landed on disk and an overwritten config destroyed the test repository's identity; `.GIT/...` bypassed a case-sensitive comparison on Windows. Fixed by `assertNotGitMetadata()` (case-insensitive, first path segment) in the dispatcher plus a second check inside `writeAndCommit`, covered by `TC-F2-U17` (unit) and the SYS confinement case; re-probed → `pathOutsideRoot`, nothing on disk, benign writes still succeed.

**Still open**: G6 UI (in flight; one options-page assertion in `lib/ui/render.test.ts` still red in the agent's own scope) and G9 E2E (in flight). The B.22 audit is PASS for this tip and must be re-run if those land with material changes.


### Landed 2026-09-29 (round 4 — retrieval is reachable from the capture path)

**Gap found by integration review**: the capture and distill paths commit **directly** through `GitHubStore.commitRecord` (they never go through the sync engine), and that commit carried only the record + `index.json`. The postings shards were therefore never written on the normal path, so a freshly captured note was invisible to `search.query` — and the engine would not repair it either, because the remote manifest already listed the record. Requirement 4 ("最终检索") was broken in practice even though every unit and INT test was green.

**Fix (T5.7, properly this time)**:

- `CommitRecordOptions.extraFiles` — the store can now commit the record, its index entry and any extra files **atomically**; the record and the index win any path collision.
- `CaptureService` / `DistillService` accept an injected `shards(record)` collaborator and fold its files into the same commit. A failing shard computation is swallowed on purpose: the index is derived data that `search.rebuild` can regenerate, the captured note is not.
- Handlers and the startup replay path (`entrypoints/background.ts`) pass `shardProvider(store, prefix)`, built from the repository so the shards are read and written through the same transport.

**Evidence**: `lib/capture/service.int.test.ts` gains `TC-F4-I02` (one commit containing the note + `index.json` + `search/*.json`, and the note is then **findable** from exactly those shards) and a companion case proving a failing shard computation still stores the note. INT **110 / 13** (was 108 / 12); extension `tsc` 0; `build` 0; `assert:content` OK (content bundle 335.9 kB — the worker now carries the sync/search stack, the page bundle is unchanged and still secret-free).


🔒 Security audit · iter 2 (delta re-audit after G6 + shard-commit change) · PASS · blocking=0

### Phase 3 complete — final evidence (2026-09-29)

| Layer | Command | Result |
|-------|---------|--------|
| Typecheck (extension) | `npx tsc --noEmit` | exit 0 |
| UNIT (extension) | `npx vitest run` | **543 / 42 files** |
| INT (extension) | `npx vitest run --config vitest.int.config.ts` | **111 / 13 files** |
| REG (extension) | `npm run test:reg` | 372 / 25 files |
| E2E (extension) | `npm run build && npx playwright test` | **12 passed** (clip, distill, sync drift, no-op, conflict, SSH degradation, search, readable default) |
| Content-bundle assertion | `npm run assert:content` | OK — no secret/native symbol in a page context |
| Typecheck (companion) | `npx tsc --noEmit` | exit 0 |
| UNIT (companion) | `npx vitest run` | **48 / 6 files** |
| SYS (companion) | `npm run test:sys` | **8 passed** (spawned process, real bare repository) |
| Security audit | `07-security-audit.md` | **PASS** — iter 1 fixed S4-01 (HIGH), iter 2 delta re-audit clean |

All 50 planned tasks are ticked; nothing is committed (B.16 — the user commits).


### Phase 3 opened — G0（理念与门禁）与 G1（全量审计）落地（2026-09-29）

| 交付 | 内容 | 验证 |
|------|------|------|
| `docs/product/00-design-principles.md`（新，130 行） | 两轴：工作流 8 阶段（每阶段承诺 + 主动克制点）· 协作 5 特质 E1–E5（判定问题 + 反例）· W1–W6 横切判据 · 必答四问 · CR 门禁 10 条 · 反例库（含我们自己的 5 条历史错误） | 契约测试 TC-DOC-U01 |
| `AGENTS.md`（新） | 非协商规则：设计门禁 / 产品约束 / 安全约束 / 工程约束 / 文档同步 | TC-DOC-U02 |
| `README.md` | 顶部"产品立场"并指向判据文档 | TC-DOC-U02 |
| `docs/audits/00-functional-audit.md`（新，115 行） | 26 个 message type 逐项判定 · CKF 4 类记录 · 8 阶段 · 四类问题清单（死代码 / 未创建记录类型 / 无出口状态 / 静默失败）各带证据与优先级 | TC-DOC-U03/U04 |
| `apps/extension/lib/tooling/design-docs.test.ts`（新） | 文档契约测试：结构缺失即失败（每条请求类型都要被审计点名、≥25 条 `file:line` 证据、四类问题段落与 P0/P1/P2 必须存在） | 4 passed |

**审计头号结论**：数据模型写满了工作流（4 类记录），生产代码只产出 2 类——`Topic`/`ReviewState` 悬空三个版本周期；`listPendingCards` 是死代码；待确认卡片与冲突副本是两个"无出口状态"；同步失败是静默失败。

**范围决定**：`G9（连接/输出/应用）+ G10（E4/E5 记忆）` 采纳推荐档全部纳入（autopilot 自动确认，交互投递因调用超时未完成）；可随时 `/od ad` 缩减。


### G2 提案闭环 — 后端落地（2026-09-29）

| 任务 | 内容 | 验证 |
|------|------|------|
| T2.1 契约 | `cards.list` / `card.decide` 加入 `REQUEST_TYPES`、payload 类型、校验器（id/path/action + 白名单 patch）、`SECRET_BEARING_TYPES` | `lib/messages.test.ts` |
| T2.2 codec | 复核确认 codec **已支持**按 `card.status` 推导路径（透明：@@`cards/pending/<slug>-<id>.md`@@ → `cards/<slug>-<id>.md`；vault：同样规则的不透明名），无需改动 | TC-P3-U01 |
| T2.3 决策逻辑 | 新增 `lib/cards/decide.ts`（纯规划 + 一次提交）：accept 迁址并迁移 postings；edit 只改白名单四字段；discard 归档不删除；**旧地址一律留 tombstone**（append-only 存储不能删除，且仓库是给人看的）；manifest 与卡片同一次提交 | TC-P3-U01…U04（5 项） |

**关键设计取舍（已写入设计）**：存储 API 只能覆盖不能删除（与`远端删除复活`同源原则），因此卡片迁址/丢弃时旧路径写入**人类可读的 tombstone**（去哪了/为什么/什么时候/可安全删除），而不是留下神秘文件或复制一份正文。

**待续**：T2.4 handlers 接线（含 vault 锁定时拒绝）、T2.5 popup 待处理区、T2.6 accept 后写 `review/state.json`、T2.7 INT/E2E 补全。


### G2 提案闭环 — handlers 接线（2026-09-29）

- `cards.list`：从 manifest 里取出仍在 `cards/pending/` 的卡片（按创建时间倒序、受 limit 限制），逐张读出 `title/summary/points/tags/evidence_paths` 供人判断；单张读不出时以 `unreadable` 标记返回，**不因为一张卡片读不到就吞掉整个列表**（vault 锁定时仍会向上抛 `locked`，让 UI 提示解锁）。
- `card.decide`：校验 id/path/action/patch → 索引里必须存在该 id（否则 `notFound`）→ **index.path 与请求 path 必须一致**，不一致返回 `conflict` 而不是猜（卡片可能在产品外被改过）→ 读取记录确认是 card → `planCardDecision` → **一次 `commitFiles`**（卡片 + manifest + shards）→ 返回新路径/旧路径/归档路径。
- 新增 `cardShards(store, prefix)` 适配器：把仓库当作 shard 存储，使 postings 与卡片同一次提交（与 T5.7 的捕获路径同规则）。

**验证**：extension `tsc` 0 · INT **111 / 13** 全绿（既有 router/handler 测试零回归）。
**待补**：T2.7 的 `cards.list` / `card.decide` INT 用例（需要 handlers.int.test.ts 的 harness 断言「一次提交 + 索引一致 + 归档不丢」）与 E2E；T2.5 popup 待处理区；T2.6 accept 后写 `review/state.json`（**与 G10 的复习队列合并实现**：先能读再写才有意义）。


### G2 提案闭环 — INT 证据补齐（2026-09-29）

在既有 handlers harness（stub GitHub REST + stub 模型回复）上新增 3 条集成用例，全部一次通过：

| 用例 | 断言 |
|------|------|
| TC-P3-I01 | 捕获+提炼 → `cards.list` 能看到提案（title/summary/points/path 均在 pending 段）→ accept **恰好一次提交** → 卡片迁到 `cards/`、manifest 指向新路径、旧路径留下 `omnipilot:tombstone` 且**不再包含正文**、提案列表清空、对同一张卡的第二次决定被拒绝（不猜） |
| TC-P3-I03 | discard → 正文仍在 `archive/cards/**`（`distill` 的正文可读）、旧路径为路标、**index.json 中既无该 id 也无归档路径**（归档不是活笔记） |
| TC-P3-U02 | edit 只改白名单字段：summary 变成用户的话，而 AI 的 points 原样保留、卡片仍是提案 |

**验证**：extension tsc 0 · `lib/background` INT **26 passed**（handlers.int 13 → 17）· 既有 router/handler 用例零回归。


### G3 冲突决策面 — 规划器落地（2026-09-29）

- **共享化的 tombstone**：把`TOMBSTONE_MARKER / tombstoneFor / isTombstone / archivePathFor` 提取到 `lib/core/tombstone.ts`，卡片决策改为再导出（公共面貌不变、既有测试零改动），冲突决策复用同一套"路标 + 归档"语言。
- **契约**：`conflict.resolve` 进 `REQUEST_TYPES` / payload / `SECRET_BEARING_TYPES`，校验器要求 `path` 与 `conflictPath` 都是仓库相对路径且**必须不同**，动作枚举受限。
- **新增 `lib/sync/conflict.ts`（纯规划）**：三种出口——`keep-mine`（我方占用原路径、对方**逐字节**归档）、`keep-remote`（对方留在原路径、我方归档）、`keep-both`（**不读任何内容、不提交任何内容**，两版原地保留，只清冲突标记——因此它是唯一在 vault 锁定时仍可用的出口，这也是它必须作为一等动作而不是"什么都不做"的原因）。
- 败者一律归档到 `archive/conflicts/<原路径>`、旧兄弟路径留 tombstone；索引里兄弟项按**路径**清除（它的 id 是合成 id）、幸存者项按原路径刷新；postings 用`(survivor, loser)` 重算（两者同 id，所以是替换而非叠加）。

**验证**：extension tsc 0 · `lib/sync lib/cards` **56 passed / 7 files**（新增 conflict 5 项）。
**待续**：T3.1 `sync.status` 冲突摘要（改为**只读索引**：双方 updated_at/content_key + `readable`，不读正文——既省请求，也让锁定的 vault 仍能看到"有冲突需要决定"）、T3.3 handler 接线、T3.4 同步页签决策 UI、T3.5 测试补全。


### G3 冲突决策面 — 后端完成（2026-09-29）

- `SyncState` 增 `conflictPaths: Record<main, sibling>`（**加法而非替换**：`conflicts` 保留为路径数组，既有读者——prefs 计数、状态行——零改动）；由引擎在同步时记录，因为 `.conflict-<stamp>` 的 stamp 事后无法重建，而决策面必须能**指名它要决定哪个文件**。normalize 只接受 string→string 对，外来/半写条目被丢弃。
- `sync.status` 增 `conflicts: [{path, conflictPath, readable}]`，**不读任何正文**（路径来自同步状态），`readable` 告诉界面此刻能否做内容比较——锁定的 vault 仍然能看到"有冲突需要决定"并可以选择"都留"。
- 新增 `conflict.resolve` handler：**只有同步状态里真的记录为冲突的 path 才能被解决**（这是决策面，不是任意文件搬运器）；记录中的 sibling 与实际不符时返回 `conflict` 而不是猜；`keep-both` 因不读不写而**不产生提交**（也因此是锁定时唯一可用出口）；决定完成后把该 path 从冲突状态中移除。

**验证**：extension tsc 0 · INT **114 / 13** 全绿。
**待续**：T3.4 同步页签决策 UI（G6 已建好冲突行与三按钮，但文案仍写着"handler currently reports conflicts only"——该占位说明必须随本次一起改掉）、T3.5 INT/E2E 补全（需要一个真实冲突状态：同步 → 制造远端漂移与本地改动 → 决策 → 断言主路径唯一且归档件可读）。


### G4 失败可读化 — 判据表落地（2026-09-29）

新增 `lib/status.ts` 的 `ERROR_GUIDANCE`（`Record<ErrorCode, ErrorGuidance>`）+ `errorGuidance(code)`：每个错误码映射为 **i18n 键对 + 目标动作**（`storage | sync | unlock | retry | companion | none`）。

关键设计点：

- **不渲染 worker 的原始句子**（原有卫生决策保留），只渲染**码**——码是封闭 union 的成员，不可能携带 token 或路径；语言只在这一张表里产生。
- **穷尽性由编译器保证**：表声明为 `Record<ErrorCode, ErrorGuidance>`，union 新增成员而没人写指引 → `tsc` 失败。这一机制**当场就抓到了漏写的 `unknown`**（而不是等到线上显示"未知错误"）。
- `target` 让指引**可执行而非装饰**：UI 可把 "retry" 接到再次同步、"unlock" 接到解锁、`storage`/`companion` 跳到对应设置区，而不用自己发明行为。
- 未知码仍有兜底（retry + guidance.unknown），永远不会渲染成空。

**验证**：extension tsc 0 · UNIT **574 / 47**（新增 3 项：行格式、真实码的路由、兜底）。
**待续**（等 popup 子代理释放 `lib/i18n.ts`）：T4.1 的双语键、T4.2 `StatusLine.lastFailure`（需把失败**码**写进 `SyncState`/`publicPrefs`，并在 `performSync` 捕获时记录）、T4.3 状态行渲染与重试按钮、T4.4 测试补全。


### T2.5 popup「待处理」区落地（子代理完成，父代理独立复验）

- 新增 `entrypoints/popup/pending.ts`（**纯投影**：未知回包 → 行、只取发生变化的 title/summary 生成 patch、结果只含路径），无 DOM 无依赖 → 可单测；`main.ts` 在既有 refresh() 里加载 `cards.list`，每张卡片三动作；`style.css` 处理换行避免长来源路径被裁切。
- 19 个双语键（两本字典同步）；新增 7 项纯投影测试 + 6 项 popup 挂载测试（stub 现在会应答 `cards.list`/`card.decide`）。
- **判据证据（子代理自证 + 父代理复验）**：E1 = 只在打开 popup 与人工决定后取数据，无 `focus()`、无自动 AI 调用；E2 = 三动作**同权重**（无主按钮），改写必须先按保存、无改动则报"没有改动，未保存"且**不产生提交**；丢弃的按钮、常驻提示与结果行**三处**都说明"归档不是删除"并给出 `archive/cards/<path>`；**不可读卡片**显示路径与"先解锁保险库或检查存储"且**不给按钮**（任何决定都需要读不到的正文），绝不静默丢弃；空列表直说"没有待处理的提案"，而 `cards.list` **失败**时绝不谎称空队列。
- **E4/E5 缺口（诚实记录）**：拒绝记忆/建议抑制在本任务无法实现——`cards.list` 没有偏好字段，需要契约变更 + 本地偏好存储，归入 G10。

**父代理独立复验（本轮实测，非引用子代理结论）**：extension tsc 0 · UNIT **574 / 47** · INT **114 / 13** · build 0 · `assert:content` OK。


### G5 SSH 克隆引导 — 纯函数落地（2026-09-29）

追加到 `lib/ui/auth-form.ts`（不新建文件，保持该模块的内聚）：

- `cloneCommand(remoteUrl, repoRoot)` → 用用户**自己的远端**拼出可直接粘贴的 `git clone`；含空格/引号的路径才加引号（常见情形保持原样可复制）；**任一半边缺失就返回空串**——半截命令比没有更糟，它看起来能跑，却会在用户的终端里失败而不是在我们这边失败。
- `repoRootError(repoRoot)` → `'empty' | 'not-absolute' | 'has-parent' | null`。**故意不检查目录是否存在**（展示命令的前提就是它还不存在），只拦两个事后会以晦涩方式失败的错误：相对路径（会相对 **companion 的工作目录**解析，而不是用户的 shell）与含 `..` 的路径。

**验证**：extension tsc 0 · 新增 `lib/ui/ssh-clone.test.ts` 2 项通过（含 Windows 带空格路径的引号、相对路径拒绝、home/绝对路径通过）。
**待续**：T5.2 options 的 SSH 区块展示命令 + 一键复制 + 路径校验（需要读 options/main.ts 的存储区结构）；T5.3 补全。


### 全量复验（2026-09-29，第 7 轮改动后）

7 轮改动（提示卡片 popup、冲突决策后端、失败指引表、SSH 引导）之后的一次完整回归，全部实测：

| 层 | 结果 |
|----|------|
| extension `tsc` | 0 |
| extension UNIT | **576 / 48** |
| extension INT | **114 / 13** |
| extension E2E（真实浏览器 + 真实 popup） | **12 / 12 passed**（29.4s）——含驱动 popup 的用例，说明新增的"待处理"区没有破坏既有交互 |
| extension `build` + `assert:content` | 0 + OK |
| companion `tsc` / UNIT / SYS | 0 / **48 · 6** / **8** |

基线演进：543 → **576** UNIT（+33），111 → **114** INT，E2E 稳定 12（新增用例待写）。零回归。


### T4.1 双语键落地（2026-09-29）

- `lib/i18n.ts` 两本字典各新增 **46 个键**（23 个错误码 × 标题 + 动作），键形如 `guidance.<code>` / `guidance.<code>.action`，插入位置在各自的 `'status.conflicts'` 条目之后。
- 新增 `lib/guidance-i18n.test.ts`：**遍历 `ERROR_GUIDANCE` 的每一行、两种语言逐一断言键能解析**（缺失键会返回键本身，正是要防的失败）。这是表的编译期穷尽性检查的**运行时对偶**——只保证表齐全不够，还得保证它能被渲染出来。
- 过程中的一次真实教训：英文文案里的撇号（`clone's`）打断了单引号字符串，把文件写坏，被 `tsc` 立刻抓住；已改为撇号安全写入并复验。**`tsc` 在这里充当了写入格式的守卫**。

**验证**：extension tsc 0 · 新增用例与既有 `lib/i18n.test.ts` parity 测试同绿。
**待续**：T4.2/T4.3 —— 把失败**码**从 `performSync` 的 catch 记进 `SyncState.lastErrorCode` → `PublicSyncState.lastFailureCode` → `syncLineParts.failure` → 状态行渲染 + 按 `target` 接动作（锚点已写在 session-log 交接清单里）。


### T4.2 前置落地 — 失败**码**被持久记录（2026-09-29）

- `SyncState` 增 `lastErrorCode: ErrorCode | null`（`lastError` 保留为运维诊断用的已脱敏文本，但**没有任何渲染路径读它**）。
- `performSync` 现在包 try/catch：失败时用既有 `router.errorCodeOf(error)` 记下`码`，**再把异常继续抛出**——调用方（router、触发器）仍然必须看到失败，不能因为"记了日志"就吞掉。
- 为什么记码而不是记句子：码是封闭 union 的成员，界面可以用自己的 `ERROR_GUIDANCE` 表渲染成双语可执行指引；句子是外部字符串，一旦渲染就绕过了整套密钥卫生设计（`syncLineParts` 既有注释已声明此意图）。

**验证**：extension tsc 0 · UNIT / INT 全绿（下一步把码投影到 `publicPrefs` 与状态行）。


### T4.2 投影打通 —— 并顺手修掉一个"自信地显示错误信息"的界面（2026-09-29）

**发现的真问题**：`PublicPrefs.sync` **从来没有人提供过** —— `publicPrefs()` 的所有调用点都没传 `extra.sync`，于是投影里的同步状态**永远是默认值**（never / 0 / 0）。也就是说：无论实际同步成功、失败还是从未同步，popup 的同步行都在说"从未同步"。这与本次需求要消灭的"静默失败"是同一类病：**一个自信地显示错误信息的界面**。

**修复**：

- 新增 `syncStateForPrefs(cache)`（handlers），并在 `prefs.get` 与 `status.get` 中真正传入 `publicPrefs({sync})` → `lastSyncAt / lastOutcome / pending / conflicts / lastFailureCode` 全部来自缓存。
- `PublicSyncState` 增 `lastFailureCode: string | null`（**码而非句子**）；`DEFAULT` 与 `normalize` 同步更新。
- `syncLineParts` 增 `failure: ErrorGuidance | null`：由码经 `errorGuidance()` 得到（未知值走安全兜底，因此**不可能渲染成空**）。

**验证**：extension tsc 0 · UNIT **577 / 49**（三处 fixture 因新契约字段同步更新）· INT 全绿。
**待续**：T4.3 最后一跳——把 `failure` 渲染到状态行，并按 `target` 接动作（retry → 再次 `sync.now`）。


### T4.3 失败原因进入状态行（2026-09-29）

- `syncLine` 在既有"时间 · 待推送 · 冲突"之后追加**失败原因**（取自 `parts.failure.titleKey`，双语）；未改动任何 UI 文件——popup 与 options 已经渲染这个字符串，所以**用户从这一刻起就能看到"为什么失败"**，而不只是"失败"。
- 用例：断言中文状态行含「保险库处于锁定状态」且**不含键名**；另一个用例喂入**不认识的码**，断言仍渲染出句子（走兜底）而**不是空行**——这正是 `errorGuidance` 安全兜底存在的意义。

**验证**：extension tsc 0 · UNIT **577 / 49**（渲染用例含在内，全部通过）。


### G6/G10 基底 —— 本地智能（纯函数，零出网）（2026-09-29）

新增 `lib/local/insights.ts` + 6 项单元测试。三条规则直接来自判据：

1. **纯本地**：不联网、不用模型，答案全部由设备上已有的数据算出——零成本、零泄露、飞机上也能用。
2. **每条建议都带理由**（E3）：`recallHint` 的 `reason` 是字段而不是装饰（`same-url` / `same-content` / `shared-tags` / `shared-terms`）；`suggestTopic` 返回它**依据的词**（`matchedTerms`），用户可核对。
3. **沉默胜过猜测**：证据不足或**并列**时返回 `null`——"不显示建议"是一个合法的、刻意选择的结果，而不是"没意见"。一个被用户抓到大搞抛硬币的系统，会连它猜对的那部分一起失去信任。

另外两点设计：按证据强度排序（同一 URL 不是提示而是同一页；内容指纹次之；标签、词项递弱），每篇文档**只报最强的那个理由**，避免给用户一堆互相重叠的说辞；复习队列用**一句话能解释清楚**的规则（到期 = 上次复习 + 当前间隔；刚接受未复习的卡片**立即到期**），按逾期时长排序，便于截断显示时先丢最不紧急的。

**验证**：extension tsc 0 · `lib/local` 6 项通过（含"弱重叠不说话""并列不说话""从未复习立即到期"）。
**待接**：T6.2 复习队列呈现、T6.3 捕获命中提示（**不阻塞捕获**）、T6.4 补测；以及 G10 的 `lib/local/preferences.ts`（E4 抑制 / E5 纠错记忆，**只写 `storage.local**"）。


### E4/E5 记忆落地（2026-09-29）

新增 `lib/local/preferences.ts` + 4 项用例。这是审计里**差距最大的一项**（「建议类无拒绝记忆」）：产品此前会提建议、然后忘掉被拒绝，也能被纠正却从不记住纠正。

- **拒绝两次即沉默**（一次可能是误触，三次就是骚扰）；**接受是最强信号**，直接清空该建议的拒绝计数。
- **纠正按词项记成用户自己的规则**（E5）：同一个词项**最新的纠正胜出**——用户改了主意，这是最强证据，而不是需要平衡的冲突；只有**不同词项分别指向不同主题**时才算并列，而并列时**仍然不出主意**。
- **硬约束（带测试）**：该模块 **import 为空**，所以私人偏好在结构上**没有任何路径**进入仓库。偏好是关于一个人怎么思考的画像，而仓库是与托管方共享、甚至可能公开的——它只能待在 `storage.local`。

**过程中一处修正**：最初我写了一条「同一词项两个主题并列 → null」的用例，运行时发现该情形**数据结构上不可达**（map 后写覆盖）——这不是缺陷，而是「纠正即决定性」的设计。于是把用例改成**真实的并列**（两个不同词项各指向一个主题），并显式断言「最新纠正胜出」，让测试描述真实意图，而不是我原本的想象。

**验证**：extension tsc 0 · UNIT **589 / 51**（+4）· 全绿。
**待接**：`cards.list` 携带抑制标记（需契约扩展）+ 建议路径接入偏好。


### 全量复验 + 诚实台账：底座 vs 已接线（2026-09-29）

全量实测：extension tsc 0 · UNIT **589/51** · INT **114/13** · build 0 · `assert:content` OK · **E2E 12/12**；companion tsc 0 · UNIT **48/6** · SYS **8/1**。零回归。

**这份台账存在的理由**：本次需求已经积累了一批"纯模块 + 测试"的底座，但底座不等于用户能用到。把两者分开记账，是为了避免下一轮（或下一个人）把"「写了并有测试」"误读成"「用户已经受益」"——那正是这条设计理念最反对的自欺。

| 能力 | 后端/逻辑 | 测试 | 到达用户？ |
|------|-----------|------|------------|
| 提案闭环（接受/改写/丢弃） | `lib/cards/decide.ts` + handlers | UNIT 5 · INT 3 · popup 挂载 6 | **✅ 已接线**（popup 待处理区） |
| 冲突决策（三选一 + 归档） | `lib/sync/conflict.ts` + `conflict.resolve` handler + `sync.status` 摘要 | UNIT 5 | **⚠️ 界面未接**（options 三按钮仍只重跑同步；那句过时文案仍在） |
| 失败可读化（原因） | 码记录 + 46 双语键 + `syncLine` 渲染 | UNIT 5 · i18n 1 | **✅ 已到达**（状态行直接显示原因） |
| 失败可读化（动作） | `failure.target` 已算出 | UNIT 1 | **⚠️ 未接**（重试/解锁/跳设置页签） |
| SSH 克隆引导 | `cloneCommand` / `repoRootError` | UNIT 2 | **⚠️ 界面未接** |
| 本地智能（回顾/归属/复习） | `lib/local/insights.ts` | UNIT 6 | **⚠️ 未接**（无调用方） |
| E4/E5 记忆 | `lib/local/preferences.ts` | UNIT 4（含 import 为空硬约束） | **⚠️ 未接**（`cards.list` 无偏好字段） |
| 判据/门禁/审计文档 | `docs/product/00-design-principles.md` · `AGENTS.md` · `docs/audits/00-functional-audit.md` | 契约测试 4 | **✅ 已交付**（受测试保护，不会腐烂） |

**结论**：本次需求的两条 P0 中，提案闭环**已完整闭环**；冲突决策**后端齐备、界面未接**。所有未接线项都已在 `02-plan.md` 有对应任务，没有被静默丢弃。


### T3.4 第一步 —— 冲突列表其实**从来没显示过任何东西**（2026-09-29）

读 options 渲染代码时发现一个**先于我本轮改动就存在的死路**：`normalizeSyncStatus` 去读顶层 `conflicts: string[]`，
而后端此前**根本不发送这个字段**（只发 `{state, pending, policy}`，冲突在 `state.conflicts` 里）；我第 5 轮加上顶层 `conflicts` 后给的是**对象数组**，旧的解析器把对象当字符串过滤掉，结果仍是空。

也就是说：**审计里 N2（冲突无出口）在界面上一直是空的**——三按钮虽然渲染，但列表里从来没有行，用户永远点不到。这正是`「无出口状态」`在 UI 层的样子，而且它连测试都没抓到（UI 测试喂的是自己的 stub，E2E 断言的是仓库状态而不是界面列表）。

**本轮修复**：`lib/ui/format.ts` ——

- 新增 `ConflictStatus`（`path` / `conflictPath` / `readable`）与 `SyncStatusView.conflicts: ConflictStatus[]`；
- `normalizeSyncStatus` **同时接受两种形状**（后端结构化条目 + 旧式裸路径，后者 `conflictPath` 为空、`readable=false`）：**一个界面叫不出名字的冲突，就是用户无法决定的冲突**，丢掉它比显示它更糟；
- `conflictRows` 把 `conflictPath` 与 `readable` 带进行对象，并明确`「回复没有给出兄弟路径时不得凭空编造」`。

**验证**：extension tsc 0 · UNIT **589 / 51**（既有 `TC-F5-U03` 更新为断言新字段流动，并新增`「不得编造 sibling」`的断言）。

**下一步（已收窄到一处）**：`entrypoints/options/main.ts` 第 698–709 行的按钮现在可以拿到 `row.conflictPath`，把 `resolveConflict(choice)` 改为携带 `{path, conflictPath, action}` 调用 `conflict.resolve`，并删除已过时的 `options.sync.conflict.actionPending` 文案。


### T3.4 完成 —— 冲突决策面真正到达用户（2026-09-29）

- options 同步页签的三个按钮现在**携带真实路径**调用 `conflict.resolve`（`mine→keep-mine` / `theirs→keep-remote` / `both→keep-both`），成功后**重新读取状态**让已解决的行从列表消失。
- **无法指名副本时不撒谎**：若回复没有给出 `conflictPath`，按钮不会"假装完成"，而是明说找不到副本、并重新同步去寻找它（`options.sync.conflict.unknownSibling`）。
- **删掉了那句已经过时的文案**："冲突处理由下次同步确认 — 目前处理器只上报冲突列表" → 改为"选择后立即生效：胜出版本保留原路径，另一版归档到 `archive/conflicts/`，不会删除"（英中同步）。**界面不再说谎。**

**过程中发现一处真实的重复（记为待办）**：UI 层已有 `describeError(code)`（format.ts，返回 {message, hint}），与我本轮加的 `ERROR_GUIDANCE`（status.ts）职责重叠——**两张表描述同一件事迟早会分叉**。本次先复用既有函数以保持一致，并把"合并成单一错误字典"记入 `02-plan.md` 的后续任务。

**验证**：extension tsc 0 · UNIT **589 / 51** · build 0 · `assert:content` OK。


### T2.6 完成 —— ReviewState 第一次被真正创建（2026-09-29）

**审计 U2 关闭**：`ReviewState` 这个类型存在了三个版本周期，**从未被任何生产路径创建**。现在接受一张提案时，`review/state.json` 会在**同一次提交**内写入该卡的复习条目：读者不可能看到"卡片已确认、复习条目缺失"的中间态，写失败也不会让两者不一致。

- 文件格式本次**明确定义**（此前无人定义）：`{ schema: 1, items: { <card id>: ReviewState } }`；明文（codec 按设计拒绝编码 review 记录）、不含内容。
- 读取容错：文件不可读/损坏时**重建而不是信任**；兼容`只有 items`与`裸 map`两种既有形状。
- 种子值：`stability=0, retrievability=0, use_count=0, next_review_at=now`（刚接受的卡片立即到期——这也是`lib/local/insights.ts` 里`「从未复习立即到期」`那条规则的由来）。

**证据**：既有 `TC-P3-I01` 增加断言——accept 之后 `review/state.json` 里含该 card id、`kind: 'review'`、`use_count: 0`、`next_review_at` 为合法字符串。

**一处待对齐（诚实记录）**：`lib/local/insights.ts` 的 `dueForReview` 用的是 `intervalDays/lastReviewedAt`，而真实 `ReviewState` 用 `stability/retrievability/next_review_at`——接线时（G10）必须做一次显式映射或把模块改成消费真实形状，**不能两套时间语义并存**。

**验证**：extension tsc 0 · `lib/background` INT **26** · UNIT **589 / 51**。


### 上一轮记录的隐患当场消掉：复习队列改用**真实** ReviewState 形状（2026-09-29）

上一轮我记下`lib/local/insights.ts` 与真实 `ReviewState` 时间语义不一致的隐患，本轮直接修掉，而不是留到 G10 再说：

- `ReviewInput` 改为消费真实字段（`next_review_at`/`stability`/`retrievability`/`use_count`），并在注释里写明理由：**用存储记录里不存在的字段算出来的队列，就是第二个会悄悄分叉的"`到期"`定义**。
- `dueForReview` 规则随之明确：到期 = 记录自带的 `next_review_at`；**没有排期（刚接受）或时间不可解析**的条目**当即可复习**，而不是被静默丢弃——与`从未复习立即到期`同一条规则。按逾期时长倒序，截断显示时先丢最不紧急的。
- 用例同步改写并新增一条：未排期 + 时间不可解析的条目都**出现在队列里且 `overdueMs = 0`**。

**验证**：extension tsc 0 · `lib/local` **10 / 2**（insights 6 + preferences 4）· 全量 UNIT 绿。
**效果**：G10 的读取接线现在是一次**直接调用**，不再需要一次容易出错的语义映射。


🔒 Security audit（B.22 增量，iteration 3）· PASS · blocking=0 —— 7 个新 request type 逐项复核（扩展页面可发 + 限流 + 白名单 + 路径受限）；companion 操作白名单未扩大，S4-01 边界保持原样。

### 验证轮：冲突 UI 接线后的全量 E2E（2026-09-29）

T3.4 改动落在 options 渲染路径上，因此重跑**全部** E2E（而非只跑 sync）：**build 0 · E2E 12 / 12 passed**（25.5s）。

**本轮没有新增代码，这是有意的**：此刻能做的下一项（G10 读侧接线 / T4.3 动作接线）都需要先读未读过的界面代码，而我有意不在余量不足时落地**未经验证**的改动——本次需求已经反复证明「写了并有测试」与「用户能用到」是两回事，再叠加一层未验证的新代码只会让台账更难诚实。


### 计划对账（2026-09-29）

这一轮把**早已完成但未勾选**的两项补记清楚，避免计划继续低估进度：T4.1 · T4.2。
（T4.1 = 穷尽指引表 + 46 个双语键；T4.2 = lastErrorCode 从 performSync 的 catch 一路投影到 syncLineParts.failure，含本轮之前修掉的「同步投影永远是默认值」缺陷。）

**未勾选任务数：24**。剩余入口按依赖排序：T4.3（接动作 + 合并错误字典）→ T5.2/T5.3（SSH 区块）→ T2.7/T3.5（E2E 与 INT 补全）→ T6.2–T6.4（复习队列呈现）→ T7.x（首启选择）→ T9.x（连接/输出/应用）→ T10.x（E4/E5 接线）→ T8.x（全量回归与收口）。


### G10 读侧最后一块纯逻辑：review/state.json 的宽容读取器（2026-09-29）

新增 `parseReviewFile(raw)`（`lib/local/insights.ts`）+ 2 项用例。这是复习队列读取侧**最后一块不需要界面知识的逻辑**：

- **宽容与全仓一致**：外来/半写条目被丢弃而不是信任；**文件不可读 → 空队列而不是异常**——损坏的排期绝不能让界面看起来是坏的。
- **两种容器都接受**：接受路径写的规范形态 `{ schema, items }`，以及**本需求之前无人定义容器**时的裸 id→记录映射（兼容既有文件，不做迁移假设）。
- 只接受 `kind: 'review'` 的条目；`next_review_at` 缺失或非字符串记为 `null`（交给 `dueForReview` 的"立即到期"规则，而不是丢掉这条记录）。

**验证**：extension tsc 0 · UNIT **591 / 51**（`lib/local` 12 项）· 全绿。

**至此读侧已可一次调通**：handler 只需 `readFile(reviewStatePath(prefix))` → `parseReviewFile` → 用索引补 `path` → `dueForReview` → 返回（索引里没有 title，界面以路径为标签即可）。契约需进 `SECRET_BEARING_TYPES` + 限流。


### review.due 接线 —— 复习回路闭合（2026-09-29）

新增契约 `review.due`（无 payload，进 `SECRET_BEARING_TYPES` + 限流）与 handler：

- 读 `review/state.json` → `parseReviewFile` → 用索引补路径 → `dueForReview` → 返回最多 20 条。
- **锁定 vault 也能用**：复习文件按设计是明文（codec 拒绝编码 review 记录），所以这条路径**不读任何正文**、不需要解锁——`「我该复习什么」`这种问题不该被保险库挡住。
- 索引**刻意不存 title**（内容只存在于记录里），因此界面以**路径**为标签——这是内容隔离的代价，不是遗漏。

**回路闭合证据**（写进既有 `TC-P3-I01`）：接受提案 → `review/state.json` 出现该条目 → **同一条用例里** `review.due` 能把它读回来。`ReviewState` 从`「有人写、无人读」`变成一条真正闭合的回路。

**验证**：extension tsc 0 · UNIT / INT 全绿（`lib/background` 26）。
**待接**：popup「待处理」区显示「今天该复习 N 条」（纯呈现，数据已就绪）。


**一个值得记住的插曲**：加完 `review.due` 后，`lib/tooling/design-docs.test.ts`（文档契约测试）**立刻失败**——它要求审计文档枚举**每一个** message type，而新类型还没被点名。这正是 R2 想要的保证：**新增对外能力而不更新审计，构建就红**。已把 `review.due` 补进审计 §1 与 §7.2，测试转绿。

**验证（本轮最终）**：extension tsc 0 · UNIT **591 / 51** · INT **114 / 13**。


### 静默学习（C.1）· 2026-09-29

向 00-project-context.md 追加两条可携带的教训（累计 5 条，文件 50 行，仍在上限内）：

1. **"自信地显示错误信息"的界面比崩溃更危险**：PublicPrefs.sync 从未被任何调用方填过，于是 popup 三个版本周期里一直显示"从未同步"，穿过 500+ 个绿灯测试。**崩溃会被发现，似是而非的谎言不会。** 新增投影字段时，必须断言真的有人在填它。
2. **文档防腐靠会失败的测试，不靠自觉**：新增 message type 而不更新审计 → 构建立刻红（review.due 当场被抓）。与"两张表描述同一件事"（describeError vs ERROR_GUIDANCE）同型：**同一事实被定义两次时，其中一份已经开始过期。**


### 文档同步 —— README 说真话（2026-09-29）

README 的能力表与验证数字此前停留在早期轮次（543 / 111）。本次同步为**当前真实能力**：

- 验证数字 → **591 unit + 114 integration**（扩展）· 48 + 8（companion）。
- 新增四条能力行：**提案决策面**（接受/改写/丢弃；丢弃=归档到 archive/cards/，旧路径留路标）· **冲突决策面**（三选一，败者进 archive/conflicts/，两者都留不需解锁）· **复习队列**（accept 写记录、review.due 读回，不问网络也不问保险库）· **可行动的失败**（翻译后的原因 + 唯一的下一步；**永不渲染 worker 原句**）。
- 安装步骤补第 8 条（提案与复习）。

**验证**：文档契约测试 4/4（README 仍指向判据文档）。


### 复习队列的最后一块纯逻辑：popup 投影（2026-09-29）

新增 `entrypoints/popup/due.ts`（`dueRows`）+ 2 项用例，与子代理先前写的 `pending.ts` 同型：**纯投影**，让 popup 能在不做算术、不信任形状的前提下渲染**未受信**回包。

- 天数是这里算的（`overdueDays`，0 = 今天到期），措辞留给界面；DOM 代码里不应出现日期算术。
- **宽容但不说谎**：非数组/非对象/缺 id 的条目被丢弃（不渲染空行）；**但"已到期却没有路径"的条目保留**——因为"这条该复习了"才是用户要行动的事实，id 足以标识它。
- 负数或非数字的 `overdueMs` 被夹到 0，而不是渲染成荒谬的天数。

**验证**：extension tsc 0 · UNIT **593 / 52**（新增 2 项）· 全绿。
**待接（下一轮第一步，已收窄）**：popup 的 `refresh()` 增加 `review.due` 调用 → `dueRows` → 在「待处理」区渲染一行「今天该复习 N 条」+ 列表；需要 2 个双语键（标题 + 空态）。


### 复习队列进入 popup —— 8 阶段里最后那盏灯亮了（2026-09-29）

popup 的"待处理"区现在有三段：提案卡片 · **今天该复习** · （原有）状态与搜索。实现要点：

- 队列在**每次 refresh 时读取**（`review.due`）：它不需要自己的网络请求、也不需要解锁（排期是明文），所以随刷新一起问是免费的，`也就**不需要一个会打扰人的定时器**（E1）。
- 标题按状态分岔：有到期 → `该复习：N 条`；无 → `暂时没有需要复习的`；**读取失败 → `复习队列暂时读不到`**（绝不把失败渲染成"没有待复习"——那正是本次反复消灭的静默失败）。
- 每行显示标签（索引用路径，因为索引刻意不存标题）与`已逾期 N 天 / 今天到期`；天数由纯投影算，DOM 里没有日期算术。
- 5 个双语键（两本字典同步，parity 测试守住）。

**验证**：extension tsc 0 · UNIT **593 / 52** · `lib/ui` 全绿 · build 0 · `assert:content` OK。


### 全量复验（2026-09-29，popup 接入复习队列之后）

popup 是本轮唯一改动的界面，而 E2E 驱动的正是真实 popup，因此重跑全量：

| 层 | 结果 |
|----|------|
| extension tsc | 0 |
| extension UNIT | **593 / 52** |
| extension INT | **114 / 13** |
| extension E2E | **12 / 12 passed**（29.0s） |

零回归。新增的复习队列区块没有影响既有交互（捕获、提炼、检索、同步漂移/无操作/冲突、SSH 降级、可读默认）。


### T6.4 补测：空复习队列是一种状态，不是失败（2026-09-29）

新增 INT 用例 TC-P7-I03：在**任何卡片被接受之前**根本不存在 review/state.json。宽容读取器必须把它变成「没有待复习」——**缺失的排期是一种状态，不是一次失败**（否则全新安装的用户会看到一个坏掉的队列）。

这条用例的价值在于守住一个容易被「顺手加个报错」改坏的边界：空 ≠ 错。

**验证**：extension tsc 0 · lib/background INT **27**（handlers 18）· UNIT 全绿。


### 基线门禁更新（2026-09-29）

AGENTS.md 的基线门槛从 543/111 上调到 **593/115**（E2E 12 不变），并加了一句约束：**基线随需求上调；下调必须说明理由，否则等于把绿灯当装饰**。门禁数字如果长期低于真实覆盖，它会变成一种让人安心的摆设。

**验证**：文档契约测试 4/4（AGENTS.md 仍指向判据文档）。


### companion 复验（2026-09-29）

| 检查 | 结果 |
|------|------|
| companion tsc | 0 |
| companion UNIT | **48 / 6** |
| companion SYS（真实进程 + 真实裸仓库） | **8 / 1** |

本需求**未改动 companion 源码**（新增能力全在扩展侧），因此这里的绿是「没被顺手破坏」的证据，而不是新工作的证据——台账里要写清楚这个区别。


### 状态文件纠偏（2026-09-29）

- flow-board.json / flow-board.md 此前仍写着「at the pre_dev hard gate」（第二轮的状态），会把接手者指向一个早已确认通过的门。已改为真实状态：Phase 3 进行中，并列出已落地能力与「待接线见 02-plan.md」。
- 与上一轮修正的 session-log 续接说明同属一类问题：**状态文件里最危险的不是缺失，而是过时的确定**。


### 最终验证块（2026-09-29，逐条实测）

| 层 | 命令 | 结果 |
|----|------|------|
| extension 类型检查 | `npx tsc --noEmit` | **0** |
| extension UNIT | `npx vitest run` | **593 / 52 files** |
| extension INT | `vitest run --config vitest.int.config.ts` | **115 / 13 files** |
| extension 构建 | `npm run build` | **0**（335–340 kB 量级） |
| 内容包断言 | `npm run assert:content` | **OK**（页面上下文无密钥/native 符号） |
| extension E2E | `npx playwright test` | **12 / 12 passed**（28.5s） |
| companion 类型检查 | `npx tsc --noEmit` | **0** |
| companion UNIT | `npx vitest run` | **48 / 6 files** |
| companion SYS | `npm run test:sys` | **8 / 1 file**（真实进程 + 真实裸仓库） |

基线演进（本需求全程）：UNIT 543 → **593**（+50）· INT 111 → **115**（+4）· E2E 12（新增用例待补）· companion 48/8 未变。
**零回归 · 零 git 提交（B.16）**。

### 目标未完成的诚实声明（供下一轮/下一次会话）

本需求目标（R1/R2/R3 + 两轴理念落地）**尚未全部完成**，剩余 22/46 任务：

- **T4.3** 失败动作接线 + 合并 `describeError` 与 `ERROR_GUIDANCE`（执行计划含依赖方向与副作用，见 02-plan.md）；
- **T5.2/T5.3** SSH 区块接线与补测（`cloneCommand`/`repoRootError` 已备）；
- **T9.1–T9.6** 连接 / 输出 / 应用三阶段（`recallHint`/`suggestTopic` 已备；接上后 `Topic` 首次被真实创建）；
- **T10.1–T10.3** E4/E5 接线（`preferences.ts` 已备，**只写 storage.local**）；
- **T7.1–T7.3** 首启层级显式选择；
- **T2.7/T3.5** 三个 E2E（提案决定 / 冲突三选一 / 参考旅程，基线 12 → 15）；
- **T8.1–T8.3** 收口（全量回归 + B.22 复跑 + 文档同步）。

入口、硬约束与复跑命令已写入 `session-log.md` 的权威续接块（第 36 轮），此轮不重复。


### 收尾：过时标记扫描（2026-09-29，第 40 轮）

对全部状态与用户可见文档做了一次**过时标记扫描**（关键词：pre_dev 硬门 / Phase 0 confirmation / 「处理器只上报冲突」 / 旧基线数字）：

- 用户可见文档（README、审计报告）：**无残留**。
- 计划文件里的旧数字（543/111/381/455）：**无残留**（已随门禁更新替换）。
- 剩余命中全部落在**历史日志**里，属正常（append-only 日志中的历史待办本就不该被改写）；其中两处可能被误读为「仍未完成」，已就地标注：旧 Resume Instructions 标题补「SUPERSEDED」；第 8 轮交接清单里那条删文案的待办标注「已于第 19 轮完成」。


### T4.3 完成 —— 失败不再只给原因，也给出唯一动作（2026-09-29）

- **数据链路补齐**：SyncStatusView 增 failureCode（由 sync.status 的 state.lastErrorCode 读取；空回包时为 null）。语义分工明确：**码**来自 worker（封闭 union），**句子**由界面自己的表产生——worker 的原句永不渲染。
- **动作接线**：popup 同步行新增按钮，文案取自 guidance.<code>.action，行为由 failure.target 决定：retry → 复用既有同步按钮（单一入口）；storage/companion → 打开 options；unlock → 同样打开 options（popup 没有口令输入，**不假装**有一个）；**none → 按钮隐藏**（不给无用的按钮也是一种诚实）。
- **过程中一次真实事故**：第一次改动用正则定位插入点，插错到空回包分支，导致 tsc 同时报「重复属性 + raw 可能为 null + 另一分支缺字段」三条错。读代码后已精确修复。教训与本次需求同源：**结构化代码要用结构化编辑（精确锚点/行号），不要用正则猜位置**——猜错时编译器会兜住，但兜住之前已经留下了破损状态。


**T4.3 验证（本轮实测）**：extension tsc 0 · UNIT **593/52** · INT **115/13** · build 0 · `assert:content` OK · E2E 见上一条运行结果。

### 错误词典合并（B 组，2026-09-29）

`ERROR_GUIDANCE.titleKey` 改为复用既有的 `error.<code>` 家族，删除 23 个重复的 `guidance.<code>` 键（两本字典共 46 行）；**动作**仍用新键 `guidance.<code>.action`（这是本次新增的语义，无既有对应）。`describeError` 的语义与 8 处断言一行未动。

随之把三处断言从「字面文案」改为「性质断言」：**状态行必须出现一句翻译后的句子、且永不出现键名**——这比记住某句译文更能守住「失败可读」的本意。

验证：extension tsc 0 · 全量 UNIT 绿（见本轮实测）。

**本轮 B 组验证**：extension tsc 0 · UNIT **593/52** · INT **115/13** · build 0 · `assert:content` OK。
### T5.2/T5.3 — SSH 克隆引导接线（2026-09-29）

- `lib/ui/auth-form.ts`：新增 `repoRootProblemText` / `sshRemoteUrlFor` / `cloneGuidance`，并把 `repoRootError` 接进 `validateSshForm` —— 路径的三种坏形状（空 / 相对 / 含 `..`）现在在**我们自己的界面**上给出人话，而不是等 companion 拒绝。
- `entrypoints/options/main.ts`：存储页 SSH 区块新增「先创建本地克隆」一步：命令由当前表单的 host/user/owner/repo **拼出**（仓库名缺失时整条命令不显示 —— 半截命令看起来可执行，却会在用户终端里失败），一键复制，复制被拒时给可见的失败提示。
- **同时发现并修掉两个既有缺陷**（都属本轮主题「界面在说谎」）：
  1. `applyFormToInputs` 从未把 `ssh.*` 写回输入框 —— 用户保存过的本地克隆路径在界面上**看不见**，而 `syncForm` 又会把空输入读成「没有路径」；
  2. 授权方式选择器在首帧被 `paintDefaults` 填成 `token` 后，永远不会再反映**已存储**的 `ssh` 模式。
- 测试：`lib/ui/ssh-clone.test.ts` 增 3 条（TC-P6-U01…U05）；`lib/ui/render.test.ts` 增 1 条挂载断言（命令文本 + 复制按钮 + 相对路径在我们这边被拒）。

### T7.1/T7.2 — 首启内容档位：一次显式选择，而不是一个默认（2026-09-29）

- **设置**：`ExtensionSettings.contentTierChosen`（缺省 false，只认显式 `true`），随 `settings.security` 传递 —— **没有新增 message type**。
- **纯逻辑**（`lib/ui/format.ts`）：`needsTierChoice` / `tierChoiceOptions` / `storageSaveBlocked`。判据与 `resolveTier` 同源：**已记录 → 不问；有内容无记录 → 必须问；新仓库 → 没选过就问**。
- **界面**：存储页新增「内容档位（只需选一次）」，两个选项各带一句**人话后果**（谁能读到 / 口令丢了会怎样）；未选择前**保存被拒绝**，选择后解锁，保存成功后折叠成一行摘要；日常切换仍归「安全」页（一个值，一个活控件 + 一次性的首启确认）。
- **仓库侧记录**：`storeConfigFileIfMissing`（`lib/store/tier.ts`）返回「这个仓库还缺的 `.omnipilot/config.json`」，由 `CaptureService.bootstrap` 随**捕获自身的那一次提交**写入（`extraFiles`）—— 一次提交而不是两次，且提交失败不会留下半配置的仓库。已记录档位、或有内容但无记录时返回 `null`：**永不覆盖、永不猜**。
- **设置里的选择与仓库里的记录不会互相打架**：仓库记录优先（`resolveTier`），选择只决定「新仓库用哪一档」；`client_version` 现在真的会写进去（`BackgroundContext.clientVersion`）。

### 断言与夹具变更记录（A6，2026-09-29）

本轮改了三处既有断言/夹具，逐条记理由：

1. `lib/ui/render.test.ts` 的 `settings.export` 夹具新增 `contentTierChosen: true` —— 该夹具描述的是**已完成首启**的安装，档位门禁有自己的用例。
2. `lib/ui/format.test.ts` 的 `settingsToForm` 期望对象新增 `contentTierChosen: false` —— 源设置里没有这个字段，表单必须读成「未回答」，这正是 T7 的语义。
3. `e2e/helpers.ts` 的 `seedSettings` 现在带上 `contentTierChosen: true`（可用 `tierUnchosen: true` opt-out）—— 其余 E2E 不是关于首启门禁的，不该被它拦住。

**为什么没有改任何 commit 计数断言**：档位记录被**折进捕获自己的提交**，所以既有 `commitCount` 断言（1/2）全部保持原样。
这也是选择该实现方式的原因之一：一个只为记录元数据的额外提交会改变每一个既有断言的语义 —— 而「为了新功能去改一堆无关断言」正是本轮一直在消灭的那类噪音。

### 本轮验证（2026-09-29，逐条实测）

| 层 | 命令 | 结果 |
|----|------|------|
| extension 类型检查 | `npx tsc --noEmit` | **0** |
| extension UNIT | `npx vitest run` | **600 / 52 files**（基线 593） |
| extension INT | `vitest run --config vitest.int.config.ts` | **117 / 13 files**（基线 115） |
| extension 构建 | `npm run build` | **0**（388.57 kB） |
| 内容包断言 | `npm run assert:content` | **OK** |
| companion 类型检查 | `npx tsc --noEmit` | **0** |
| companion UNIT | `npx vitest run` | **48 / 6 files** |
| companion SYS | `npm run test:sys` | **8 / 1 file**（真实进程 + 真实裸仓库） |

companion 本需求未改动任何源码，因此它的绿是「没被顺手破坏」的证据，不是新工作的证据。**零 git 提交（B.16）**。
### 深度审计后的修复：授权模式 + 档位契约（2026-09-30，req-2026-09-30-synapse-auth-tier-integrity）

**审计发现（证据见 session-log 的 Phase 0 块）**：P0 SSH 授权模式只通了一半（`resolveStore` 硬要求 PAT，9 个 handler 因此失效，而 `isConfigured` 说"已配置"）；P1 仓库记录的档位运行时从不被读取（明文可写进 vault 仓库）。

**修复（G0/G1）**：

- **一个门面两种模式**：新增 `lib/store/repo-store.ts`（`RepoStore` + `createRepoStore`）。`GitHubStore` 内部改为**委托**同一个门面，SSH 的 `GitTransportStore` 也用它 → 索引/记录的语义只有一份实现。
- **`resolveStore` 走 `resolveAuth`**：token 与 SSH 返回同一形状；`resolveSyncRemote` 与它共用同一次解析（同步与其他 handler 不可能用不同的模式）。
- **档位以仓库记录为准**：`resolveRepo` 先 `loadStoreConfig`，以结果的 mode 构造 codec/仓库；本机设置只作为**新仓库**的回落。
- **档位变更是一次仓库操作**：`settings.security` 的 `securityMode` 变化走 `switchTier` —— 有内容即拒绝（新错误码 `tierLocked` + 双语原因 + 动作），空仓库则把选择写进 `.omnipilot/config.json`。
- **顺手修掉的两个同类缺陷**：① 存储页保存时 `probeCandidate` 没有 token 就抛错 → **SSH-only 配置根本保存不了**（现在 best-effort，返回 null，由页面自己的"测试连接"验证）；② router 的 `ERROR_CODES` 手写清单漏了 5 个已声明码（`nativeUnavailable`/`protocolMismatch`/`gitFailed`/`syncConflict`/`indexUnavailable`）→ 声明码被静默改写成 `unknown`，界面上的指引全部丢失。现在它由 `Record<ErrorCode, true>` 推导，**编译器不允许漏项**。

### 断言变更记录（A6，2026-09-30）

档位选择现在会写进仓库（`R8`），因此三处**提交计数**断言变了，逐条记理由：

1. `e2e/auth.spec.ts`：种子里的 vault 选择带来 1 次 config 提交 → SSH 被拒后是 1 次（原 0），token 捕获后是 2 次（原 1）。
2. `e2e/distill.spec.ts`：vault 用例 2 → 3 次（config + 源 + 卡片）。
3. `lib/store/tier.int.test.ts`：`TierMigrationRequiredError` 的码从 `validation` 改为 `tierLocked`。

### 修复轮验证（2026-09-30）

| 层 | 结果 |
|----|------|
| extension tsc / UNIT / INT | 0 · **600** · **120**（+3 新用例） |
| extension E2E | **19 passed** |
| build / assert:content | 0（392.77 kB）· OK |
| companion tsc / UNIT / SYS | 0 · **48** · **8** |
### 用户报障修复：`Cannot create item with duplicate id synapse-clip-page`（2026-09-30）

**现象**：`chrome://extensions` 的服务工作线程错误面板报 `Unchecked runtime.lastError: Cannot create item with duplicate id synapse-clip-page`。

**根因（不是"忘了 removeAll"，是一次竞态）**：`bootstrap()` 有三个入口 —— `runtime.onInstalled`、`runtime.onStartup`、以及模块自身的顶层调用；首次安装时 `onInstalled` 在 worker **仍在求值**时就触发，于是两次 `removeAll() + create()` **交错**：第二次 `create` 撞上刚被创建的同名 id。而且两次 `create` 的 promise 都没被 `await`，所以失败没有进 try/catch，而是以 Chrome 的 `runtime.lastError`（未读取）形式冒到扩展页。

**修复**：

- 新增 `lib/single-flight.ts`：`singleFlight(task)` 保证同一时刻只跑一次 boot；并发调用者共享在飞的那次，settle 后清空槽位（回收的 worker 仍能重新启动）。
- `entrypoints/background.ts`：三个入口统一走 `singleFlight(bootstrap)`，并统一 `.catch` 记录；两次 `create` 改为 **await**，让"id 已被占用"这种事落进既有 try/catch 并以 `console.warn` 留痕，而不是变成 unchecked 错误。
- 测试：`lib/single-flight.test.ts` 三条（并发只跑一次 / settle 后可再次 boot / 任务失败后槽位清空可重试 —— 最后一条防止"一次性 wedge"这种更隐蔽的回归）。

**验证**：extension tsc 0 · UNIT **603 / 53** · INT **120** · E2E **19 / 19** · build 0 · `assert:content` OK。基线 UNIT 600 → **603**（[AGENTS.md](../../AGENTS.md)）。
### 用户反馈：存储表单过于复杂（2026-09-30）

**反馈**：填写项太多、且没有任何字段说明。要求收到「至少两个，最多三个」：token · 仓库地址 · 可选的仓库内部地址。

**改前**：五个无说明的输入框（拥有者 / 仓库 / 分支 / 路径前缀 / API 地址）—— 把 GitHub 的内部词汇直接摊给用户。

**改后（主区 2 必填 + 1 可选，每个字段下面都有一句人话）**：

1. **GitHub Token**（沿用既有的一句权限说明）
2. **仓库地址**：接受 `https://github.com/owner/repo`、`owner/repo`、`git@github.com:owner/repo.git`；带 `/tree/<分支>` 的网址会顺带设定分支（并写回高级里的分支字段，**覆盖是可见的**）
3. **仓库内部目录（可选）**：留空 = 仓库根；只写相对目录如 `kb`

其余（分支 / API 地址 / 授权方式与 SSH 区块 / 检查分支）收进 **高级**（`<details>`，默认折叠；内容仍在 DOM 里，所以既有的 render 断言与 E2E 不受影响）。

**顺带堵掉上一轮暴露的坑**：

- `parseInnerPath` 拒绝含 `:` · `\` · `//` 的输入，并要求每段只含字母数字与 `-` `_`（**不允许点**）—— 所以把域名粘错字段也会被拒。以前 `https://github.com/zayeagle/` 能通过校验，并被写成目录名 `https:`。
- 地址解析失败时：**字段下方就地报错** · **禁用保存** · **探测与保存都被拦下**（否则会拿旧仓库去测新地址 —— 正是「看起来对、其实错」那一类）。

**测试**：新增 `lib/ui/repo-address.test.ts` 六条（接受的写法 / 分支解析 / 拒绝原因 / 回填往返 / 空目录 / URL 与域名被拒）。
**顺手清理**：`lib/ui/render.test.ts` 里遗留的 `describe('diagnostic') → dumps cards`（只 `console.log` 后 `expect(true).toBe(true)` 的脚手架测试）。

**验证**：extension tsc 0 · UNIT **608 / 54** · INT **120** · E2E **19 / 19** · build 0（401.79 kB）· `assert:content` OK。
### 用户报障修复：已配置仓库却提示「请先配置 GitHub 存储」（2026-09-30）

**现象**：popup 顶部红框写「请先配置 GitHub 存储」，而同一屏的「仓库」行明明显示 `zayeagle/notes`；剪藏按钮被禁用。

**根因**：`captureReadiness`（`lib/status.ts`）的判定顺序错了，而且错在一条**错误假设**上：

```
if (!prefs.repoFullName || !prefs.hasPat) return 'not-configured';   // ← 先判 hasPat
if (prefs.securityMode === 'vault' && prefs.vaultLocked) return 'vault-locked';
```

token 存在 **vault** 里，所以保险库锁着时 `toPublicPrefs` 会把 `hasPat` 报成 false —— 于是「锁着」被误报成「没配置」。原本那句注释写着「透明模式不需要 vault」，但**内容不加密 ≠ 凭据不加密**：透明仓的 token 一样在 vault 里。用户的配置正是「透明仓 + 保险库已锁定」，必然命中这条错路。

**修复**：

1. 先判仓库地址，再判 vault：`(token 模式 || 内容档位=vault) && vaultLocked → vault-locked`；只有 vault 解锁后才可能落到 `not-configured`。
2. **顺带修掉 SSH 的同类错误**：`!hasPat` 曾无条件拦截 —— SSH 用户的凭据来自伴生进程，不该因为没有 PAT 被说成「没配置」。新增 `companion-missing` 状态与文案「请先安装伴生进程以使用 SSH 模式」（原 R7 修复只改了 worker 侧，popup 侧漏了）。
3. **收件箱不再说谎**：`inbox.list` 读取失败时，列表原本显示「收件箱是空的」（与「读不到」是两件事），改为「收件箱暂时读不到」。

**断言的修正（A6）**：`status.test.ts` 里那条 `透明模式 + vaultLocked → ready` 的期望**编码了这个 bug**，已改为 `vault-locked` 并注明理由；新增 TC-F8-U06（SSH + 无 PAT + 无伴生进程 → `companion-missing`；伴生进程 ok → `ready`；vault 档位 + 锁定 → `vault-locked`）。
### 反馈修复：popup 限流 + 两个持久化缺口（2026-09-30）

**限流分桶改对了**（用户报「请求过于频繁，请稍后重试」）：`limiterKeyFor` 原来把**所有未列出的类型**都算进最紧的 `vault` 预算（12 次/分钟），于是 popup 一次打开（status + inbox + cards + review + sync ≈ 6 个请求）就吃掉一半；而**真实 popup 没有 tab id**，`bucketKey` 退化成 `internal`，整个 profile 共用一个桶。现在按**请求碰到什么**分桶：凭据/保险库类（`settings.*` / `vault.*`）留在最紧的 `vault`，其余走 `github`（60 次/分钟/键）。

**① 锁定后本机仍有明文正文 → 已修**：同步缓存里的记录体改为**用会话密钥封口**后落盘（新增 `lib/security/sealer.ts`，`SyncCache` 接一个可选 sealer）。锁定时 `requireKey` 抛错，条目**读不出但也不丢**（仍在本机，解锁即恢复）——这是「锁定」与「丢失」的区别。类型上把**存储形态**与**可用形态**分开（`StoredRecord = CachedRecord | SealedCachedRecord`），于是封口只是存储的实现细节，所有调用方仍然拿到 `record` 必有值的条目。

**② 离线队列明文存正文 → 已修**：`CaptureQueue` 入队时封口 payload（同一套 `QueuedCapture` / `StoredQueuedCapture` 拆分）。读不出的条目留在磁盘上；`size()` 改为数**原始条目**，锁定时不会把「有 N 条待补写」显示成空队列。

**测试**：新增 `lib/sync/cache-sealed.test.ts` 两条（封口后落盘不含正文 / 锁定时读不出但仍在 / 解锁后恢复）。

**配置瘦身（同一轮完成）**：

- **SSH 的 host / user / keyRef 默认隐藏**，只在**存过非默认值**时才出现（`sshCustom`），并用一句提示说明默认值（`github.com · git · default`）—— 隐藏用户真正设过的值是最糟的折中，所以用「改过才显示」而不是「一律隐藏」。SSH 区块因此只剩**本地克隆路径 + 克隆命令 + 测试连接**。
- **同步策略**（间隔 / 启动时 / 捕获后 / 仅拉取）收进「高级」折叠：同步页签默认只剩 状态 + 冲突决策 + 检索，保存按钮仍在 footer，折叠时也能保存。
- 两个折叠都用同一个 `details.advanced` 样式（此前存储页的高级区**没有样式**，看起来像一堵墙 —— 这次补上）。模型页的 baseUrl 标签本来就写着「（高级）」，未再另做折叠。

**popup 精简 + 样式（同一轮完成）**：

- 7 行状态明细收进 `details.more`「详情」（默认折叠，内容仍在 DOM，所以文本级断言与 E2E 不受影响）；popup 默认只回答两个问题：**现在能不能剪藏** 与 **是否在同步**。收件箱上限 5 → 3。
- 节奏与样式：整体间距 10 → 8px、内边距收紧，新增 `details.more` 的折叠行样式（带 ▸/▾ 指示），与 options 的 `details.advanced` 同构。

- **状态驱动（第二轮反馈「这一部分好丑」的真正修法）**：新增 `canReadRepository(prefs)`（`lib/status.ts`）—— 读仓库只需要凭据，而 token 模式的凭据在保险库里，所以**锁定时收件箱 / 提案 / 复习队列一起读不到**。popup 现在按这个谓词隐藏这三个区，只留**一行**「解锁后这里会显示…」，而不是三行「读不到」+ 一行红字叠在一起。
  这条谓词与 `captureReadiness` 分开：捕获还多两道门（探测、公开仓库确认），用捕获的状态去决定「能不能读」会把公开仓库的用户关在门外。
- **样式第二轮**：区块改为真正的块（`section` 加分隔与间距、`h2` 降到 11px 去大写），检索输入框补上 `input.control`（此前**完全没有样式**，所以和旁边的按钮不一致），失败行从裸红字改为带边框的 chip（`.hint[data-kind='error']`），空/不可读行改为左对齐小字。

**验证（本轮最终）**：extension tsc 0 · UNIT **612 / 55**（新增 TC-F8-U07 覆盖读能力谓词）· INT **120** · E2E **19 / 19** · build 0（407.9 kB）· `assert:content` OK。基线 UNIT → **612**。
### 报障续修 2：in-page toast 永不消失 + 提交上限拒绝中文内容（2026-09-30）

**① toast 不自动关闭（真 bug，测试接缝反噬）**：`lib/dom/toast.ts` 的自动隐藏写成 `if (setTimeoutImpl) { handle = setTimeoutImpl(...) }` —— 注入的假计时器**就是**机制本身，生产环境从不注入，于是内容脚本的 toast **永久留在页面上**（覆盖用户正在读的内容）。popup/options 用的是另一套实现（真 `setTimeout`），所以只有网页里那个卡住。
修：真实计时器为默认（注入只作测试接缝）、错误 7s / 普通 4s 自动消失、**点击即关闭**（监听只绑一次，避免重复消息堆积监听）。新增 `lib/dom/toast-dismiss.test.ts` 两条（无注入计时器也会自动消失 / 点击立即关闭并清空文本）——第一条正是原 bug 的钉子。

**② 中文内容被提交上限拒绝（很可能是「配置好了却报未配置」的真凶）**：`MAX_COMMIT_FILES = 64`，而一次捕获的提交要带**记录 + 索引 + 该内容命中的所有搜索分片**，分片按词的前两个字符切分 —— 英文是「少数几个」，**中文几乎是每个二字前缀都不同**，一篇中文文章就能命中几百个 → 合法提交被拒，且抛的是 `NotConfiguredError`，文案变成「存储配置不完整」。上限提到 **512**（GitHub 的 tree 接口能吃下几百项；代价是时间，时间比用户的笔记便宜）。

**③ E2E 移出自动门禁（用户要求）**：`ci.yml` 的 `e2e` job 加 `if: github.event_name == 'workflow_dispatch'` —— 只在 Actions 手动触发时运行；本地 `npm run test:e2e` 照旧。**specs 一个没删**，E2E ≥19 的基线仍然成立。

**验证**：tsc 0 · UNIT **614 / 56** · INT **120** · build 0（411.4 kB）· `assert:content` OK。本轮按用户要求**未运行 E2E**。基线 UNIT → **614**。
### popup 交互：浮动窗口 + 列表页签（2026-09-30）

**① 浮动窗口（用户要「可拖动、拖后只能手动关闭」）**：toolbar 弹窗在技术上**无法拖动**（锚定在工具栏按钮上、失焦即关），所以真正的实现是把同一个页面开成**独立窗口**：`browser.windows.create({ url: '/popup.html?mode=window', type: 'popup' })` —— 窗口可拖动、只有自己的关闭按钮能收掉，正是要的行为。弹窗底部新增「浮动窗口」按钮，打开后工具栏弹窗自行 `window.close()`（否则会同时存在两个控制台）；窗口模式下按钮隐藏、布局自适应（`body[data-mode='window']`）。

**② 收件箱 / 待处理 / 复习 改为页签**：三者是三个不同的问题（我存了什么 / AI 提议什么 / 该复习什么），原来挤在同一个滚动里互相抢注意力。现在一次一个面板。

**③ 随之更新两个 E2E spec**（`cards.spec.ts` / `review-journey.spec.ts`：先点「待处理」页签再断言，否则 `click()`/`toBeVisible()` 作用在隐藏面板上）。**并本地跑了一次 E2E：19 / 19 通过** —— 虽然它已从 CI 自动门禁移出，但不留坏测试在仓库里。

**待核实（下一轮）**：用户 popup 的收件箱里那条记录路径显示为 `inbox/2026/09/inbox/深入浅出…`，**多了一层 `inbox/`**。可能是显示拼接问题，也可能是真实路径重复 —— 需要看 `.omnipilot/config.json` 的 `path_prefix` 与该记录的 index 条目。

**验证**：tsc 0 · UNIT **614 / 56** · INT **120** · E2E **19 / 19**（本地单跑）· build 0（412.9 kB）。
### 设置改为右上角图标 + `commitTooLarge` 专用码（2026-09-30）

**① 设置按钮移到 header 右上角，绘制为齿轮图标**：`button.icon` + 内联 SVG（`gearIcon()`，无资源文件、无依赖，`stroke: currentColor` 继承颜色），`aria-label`/`title` 为「设置」，带 hover 边框态。footer 只剩「浮动窗口」。
随之更新 `render.test.ts`：图标按钮的文本为空，断言改查 `aria-label` 而不是 `button.textContent`（这正是「按钮变成图标」这件事的可判定形式）。

**② 补上漏掉的 import（我上一轮引入的 tsc 红）**：`github-store.ts` 用了 `CommitTooLargeError` 却没导入 → `TS2304` + 1 条 UNIT 失败。已修，现已全绿。**教训**：上一轮的验证输出里 TSC=2 就在眼前，我不该只看后半段的测试汇总。

**③ `commitTooLarge` 专用码（上一条报错的根治）**：一次提交的文件数超限原本抛 `NotConfiguredError`，于是**配置完好**的仓库报「存储配置不完整」。现在 `CommitTooLargeError` 带自己的码与文件数/上限，界面文案改为「这条内容需要的文件数超过单次提交上限 —— 搜索分片数量超了」，动作是「改成剪藏更小的一段，或到设置里重建检索索引」。**这正是「提炼」报错的成因**（一次提交 = 记录 + 索引 + 该内容命中的所有分片），上限已提至 512，但那只在重新加载扩展后生效。

**验证（本轮按用户要求不跑 E2E）**：tsc 0 · UNIT **614 / 56** · INT **120 / 13** · build 0（416.2 kB）· `assert:content` OK。

**补**：浮动窗口按钮**也**移到 header 右上角（与齿轮并排，同一个 `button.icon` 样式与 `svgIcon` 外壳：新增 `popoutIcon()`「弹出窗口」图形）。footer 因此为空，已删除。图标在窗口模式下自我隐藏（`WINDOW_MODE` 提前到 header 计算），避免在窗口里再开窗口。

**右上角两个图标落位时连着踩了两个 CSS 陷阱（记在这里，别再犯）**：

1. 占位元素的弹性只写在 .row .spacer 下，而图标放进了 header，于是占位不撑开、图标贴着标题。改为不依赖父类的 .spacer 规则。
2. hidden 被作者样式盖掉（第二次）：给图标按钮加了 display，于是按钮的 hidden 静默失效，已经在浮动窗口里还显示浮动按钮。上一轮为 section 补的兜底规则特异性不够，这次改成语义重置并用 important 固定。已在构建产物里核实该规则确实打进了 .output。

**教训**：只要给某类元素加了 display，就必须同时确认 hidden 仍然有效。这类回归不报错、测试全绿（断言看 textContent，hidden 只影响渲染），本项目已因此栽三次。

### 用户报障：勾选与 Token 在重载后回退（数据安全修复，2026-09-30）

**查到一条会静默毁数据的路径（已修）**：settings-store 的 setupVault 注释原文就是 Create or replace the vault，它用一个新的信封覆盖旧信封，而调用方（vault.setup 处理器）只带本次表单里输入的 secret。于是只要在安全页再提交一次口令，信封里原有的 GitHub Token 就被空值覆盖，且旧密文不可恢复。这违反了本项目自己的硬约束：可逆 / 不删除用户数据 / 不可逆动作默认不执行并显式说明。

修法（settings-store.ts）：重设口令时先把能读到的密钥带过去（解锁状态下合并，而不是清零）；读不到时（保险库锁定）直接抛 VaultLockedError 拒绝执行，要求先解锁。于是常见路径（解锁后改口令）Token 存活，危险路径（锁定时重设）被明确拒绝而不是默默销毁。

**另发现一个交互死循环（待修）**：模型页的 input/change 监听器直接调用 renderProvider()，而它把表单从已保存的 settings 重建 —— 所以刚勾上的信任勾选会被立刻还原成未勾选（保存又被拦），用户看到的是勾了又还原、无从下手。修法需要先读 syncForm/renderProvider 的语义（切换 provider 时确实要清空自定义 URL 与勾选），避免把那个刻意的重置改坏。

**验证**：tsc 0 · UNIT 614 · INT 120。

### 修复：信任勾选是只写不读（2026-09-30）

根因不是监听器（原先的怀疑），而是**这个存储值没有渲染路径**：勾选在保存时写进 ai.trustedHosts，而 applyFormToInputs 逐个还原了所有存储字段，唯独漏了它。于是每次加载都显示未勾选、自定义端点的保存继续被拦（validateProviderForm 要求勾选），用户只能再勾一次 —— 永远打转。

修法：
- lib/providers.ts 新增 hostOfEndpoint(baseUrl)（按 host 比较，路径与查询串不影响匹配）
- lib/ui/format.ts 新增 trustedHostsOf(value)（防御式读取导出数据里的 ai.trustedHosts）
- options/main.ts：loadAll 记住 storedTrustedHosts；applyFormToInputs 用它渲染勾选状态（与其它存储字段一致）。**一个被保存却不被渲染的字段，对用户来说等于没保存。**

测试：新增 lib/ui/trust-render.test.ts 两条（TC-F5-U07 读取与容错、TC-F5-U08 按 host 比较）。

验证：tsc 0 · UNIT 616 / 57 · INT 120 · build 0（417.4 kB）· assert:content OK。基线 UNIT -> 616。

### 可配置的解锁策略：默认在本机记住（2026-09-30）

需求：去掉每次重启都要解锁的门槛，做成可配置的安全级别放在安全页；默认本机记住。

这是一个安全取舍，不是 bug：会话密钥原本只活在 storage.session（内存），浏览器退出即失效 —— 这正是 vault 档位「没有口令解不开」的实现方式。要免解锁就必须把凭据留在本机：门槛从「知道口令」降到「能读到这个浏览器 profile」。所以默认值必须在界面上披露。

实现（按失败也不变坏的顺序分三层）：

1. 数据层（settings-store.ts）：UnlockPolicy = strict | remember；策略与它授权的密钥存在同一条记录 local:unlockPolicy（两者不会漂移）；解锁/设置口令时按策略导出派生密钥；restoreRememberedKey() 启动时导入并 adopt；显式 lock() 与切回 strict 都会清除密钥；reset() 一并清除。
2. 可配置（status.ts / handlers.ts / messages.ts / format.ts / options）：VaultStatus 带上策略，经 vaultStatusData 与 normalizeVaultInfo 送到安全页；settings.security 增加 unlockPolicy（落在 vault 自己的记录，不进 local:settings）；安全页新增勾选 + 代价说明 + 严格档对照说明。
3. 启动恢复（background.ts 的 refresh()）：按策略采用记住的密钥；strict 下空操作；失败只记日志、不阻塞启动。

两个必须说明的设计决定：

- 默认 remember（用户指定）。界面写明代价，且「严格」一键可切。
- 记住档位下空闲自动锁定不生效（否则与「重启免解锁」自相矛盾）：把「自动锁定分钟数」在该档位置灰并说明，而不是让它看着有用、实际失效。

语义边界：全新安装没有已记住的密钥，第一次仍要输入口令；此后重启免解锁。改口令仍需旧口令。

测试：settings-store-unlock.test.ts —— TC-R8-U04（缺省即 remember + 显式选择优先）、TC-R8-U05（离开 remember 即丢密钥；无会话不猜测）。

验证：tsc 0 · UNIT 618 / 58 · INT 120 · build 0（422.8 kB）· assert:content OK。基线 UNIT -> 618。

### 用户报障：剪藏提示「请先配置 GitHub 存储」（两道问题叠在一起）

**① 本轮自己引入的 CSS 回归**：为 popup 加的 `section { display: flex }` 是**作者样式**，它盖掉了浏览器内置的 `[hidden] { display: none }` —— 于是 `section.hidden = true` **静默失效**，「一行说明」与三个空区块同时出现。已补 `section[hidden], [hidden] { display: none }` 并写明原因（`hidden` 是 popup 隐藏不可读区块的机制，不能被自己的 `display` 悄悄废掉）。

**教训（值得携带）**：给元素加 `display` 时，必须同时确认 `hidden` 仍然有效 —— 这类回归**不会报错、测试也全绿**（DOM 断言看的是 `textContent`，而 `hidden` 只影响渲染）。这是本项目第三次遇到同一类问题：**能被断言的东西被断言了，渲染出来的东西没人看**。

**② 真正的原因**：`notConfigured` 不是「没配仓库」（仓库地址正常、详情行可见），而是 **Token 没存进去** —— 多半是保险库锁着时填的（那次保存被 `locked` 拒绝），而 token 输入框的占位文案一直写着「留空则保留已保存的密钥」，**在没有已保存密钥时这是一句谎话**，于是仓库看起来是配好的。已改为按真实状态显示：没有 Token 时提示「尚未保存 Token —— 请在下方粘贴后保存」，占位文案改成「粘贴你的 GitHub Token」。

**验证**：extension tsc 0 · UNIT **612 / 55** · INT **120** · E2E **19 / 19** · build 0（409.0 kB）。
### 报障续修：保存 Token 的死锁（2026-09-30）

**用户报「功能还不能用」**：剪藏报 `notConfigured`（`getSecrets()` 成功 → 保险库已解锁；那唯一的分支就是 **vault 里没有 PAT**）。而**为什么装不进去**：`保存` 被「必须先探测成功」挡住，而探测又需要**已保存的 Token** —— 死锁。用户点的是 `保存`（灰的、什么也没发生），看起来却像保存过了。

**修复**：

- **拆掉死锁**：`canSaveStorageSection(probe, acknowledged, typedToken)` —— **填了 Token 就允许保存**，因为 `settings.github` 会用候选 Token **先探测再落盘**（坏 Token 会在同一次请求里可见地失败）。公开仓库的确认仍然无条件拦截。文案从「请先「测试连接」」改为「请先填写 Token —— 保存时会先验证仓库」（原文案在新语义下已经不成立）。
- **保险库锁着时说清楚**：填了 Token 但保险库未解锁 → 保存按钮带原因禁用（「请先在「安全」页解锁保险库 —— Token 存在里面」），而不是让它跑一次网络请求后以 `locked` 失败。

**测试**：`format.test.ts` 增加两条断言（有 Token 时可保存；公开仓库未确认时仍不可保存）。
- **尚未做（仍待确认）**：专用码 `needToken`（要让 `resolveAuth` 的原因映射能区分「缺 Token」与「未配置」，涉及 3 个文件）。当前用把 `error.notConfigured` 的文案改准确（「仓库地址或已保存的 Token 有缺失」）顶上。


### CI 优化：状态台账不再触发全量跑 · E2E 独立成 job（2026-09-30）

- **`paths-ignore: docs/omnidev-state/**`**（push 与 PR）：这些是流程台账，**不是构建输入、没有任何测试读它**（契约测试只读 `docs/product/**`、`docs/audits/**`、`AGENTS.md`、`README.md` —— 这几个**刻意不忽略**，改它们本来就该让构建红）。此前每轮更新状态文件都会触发一次含浏览器套件的完整 CI。
  副作用已知：只改被忽略路径的 PR **不会产生任何 check**（若将来开启 required status checks，那种 PR 会被挡住）；因此保留 `workflow_dispatch` 以便手动跑一次。
- **E2E 拆成独立 job**（`needs: verify`）：unit 红了就不再花浏览器配额，两个 job 可以各自重跑；E2E job 里补上 **`npm run build`**（原来靠同 job 前序步骤留下的 `.output`，拆开后必须自己构建，否则 `test:e2e` 会对着不存在的产物跑），并新增**失败时上传 `test-results`**（trace/截图）。

**验证方式（CI 无法本地跑，所以逐条执行了它的每个步骤）**：tsc 0 · UNIT 612 · INT 120 · build(chrome) 0 · `assert:content` OK · **build(firefox) 0** · **E2E 19/19** · companion tsc 0 · UNIT 48 · SYS 8 · **pack ✓（44 KB bundle）**。YAML 侧做了结构检查（无 tab / 缩进全偶数 / 顶层键与 3 个 job + `needs` 正确）；本机没有 yaml 解析器，GitHub 自己的解析是唯一剩下的未知，首次 push 即可确认。





### E2E 补齐（T2.7 / T3.5 / T7.3，2026-09-29 第 42 轮）

三个 P0/首启流程现在有了**真实浏览器**证据，而这一步抓到的四件事都是前 600 个单测抓不到的：

| # | 发现 | 性质 | 处置 |
|---|------|------|------|
| 1 | 存储页保存时连发两次 `settings.security`（授权方式 + 档位），第二次被限流拒绝 → 保存失败 | **本轮引入的缺陷**，由 E2E 当场抓住 | 合并为**一次**请求（一个决定，一次往返）。恰好印证 `messages.ts` 里那句注释：两次往返是可以互相矛盾的 |
| 2 | `saveAuthSection` 是**死代码**（无任何调用点），而档位持久化最初落在了它里面 → 界面上「选择档位」根本不会落盘 | 既有死代码 + 本轮错位 | 删除该死函数，并在唯一真实的保存路径 `saveStorageSection` 上补齐它原本的两道守卫（companion 不可用 / SSH 表单不完整） |
| 3 | 同步页签**不会重新读取**状态：后台同步刚记下冲突时，界面仍显示「冲突 0」，而 worker 手里有一个 | 既有缺陷（决策面会说谎） | 页签激活时重读 `sync.status`。这也解释了子代理此前「同一页面 `sync.status` 有冲突、界面却是 0」的观察 |
| 4 | 冲突行只显示原路径，不显示**持有自己那一版的兄弟路径** | T3.4 的「摘要」缺项 | 行内补一句 `options.sync.conflict.sibling`（双语），让三选一面对的是路径而不是约定 |

**新增 E2E**：`e2e/cards.spec.ts`（TC-P3-E01 两条）· `e2e/review-journey.spec.ts`（TC-P9-E01 两条）· `e2e/first-run.spec.ts`（TC-P8-E01 一条）· `e2e/sync.spec.ts` 增两条（TC-P4-E01：保留我的 → 原文路径换回我的、远端版归档到 `archive/conflicts/`、兄弟路径留墓碑；两者都留 → 不提交、两版都在）。

**一条值得记住的测试环境约束**：router 的凭据预算是 **12 次 / 每标签页 / 每分钟**，而 options 页每次加载就要花掉约 5 次。因此「在同一个标签页里先 seed 再点保存」或「加载后再 reload」都会把一次合法保存推进 `rateLimited`。E2E 的解法是**用独立的标签页 seed 后关闭**，断言页保持干净预算 —— 这不是产品缺陷，但它决定了这类 spec 该怎么写。

### 第一次 E2E 全量（2026-09-29）

| 层 | 命令 | 结果 |
|----|------|------|
| extension E2E | `npx playwright test` | **19 / 19 passed**（基线 12；新增 7 条） |


