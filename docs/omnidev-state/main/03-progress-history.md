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
