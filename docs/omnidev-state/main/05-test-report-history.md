## Archived 2026-10-08 - req-2026-09-30-synapse-auth-tier-integrity

---
artifact: 05-test-report.md
gate_status: PASS
test_strategy_profile: frontend-only-L
layers_executed: [unit, integration, e2e, smoke, regression]
e2e_tool: playwright
executed_at: 2026-07-09T00:00:00+08:00
---

# Test Report

## 1. Executive Summary

| Layer | Pass | Fail | Skip | Blocking |
|-------|-----:|-----:|-----:|:--------:|
| UNIT | 381 | 0 | 0 | yes |
| INT | 68 | 0 | 0 | yes |
| SYS | — | — | n/a | no (no service chain in this MVP) |
| E2E | 6 | 0 | 0 | yes |
| SMK | 3 | 0 | 0 | yes |
| REG | 321 | 0 | 0 | no |

**Gate status: PASS.** `npm run ci` (unit → int → build → assert:content → e2e) is green end to end.

## 2. Strategy Profile

`frontend-only-L` — a single browser-extension client, no service of our own.
`layers_required: [unit, integration, e2e, smoke, regression]`, `e2e_required: true`,
`integration_required: true`, `unit_gate: blocking`, `regression_mode: targeted`.

INT is required beyond the `frontend-only-M` example because two §2.3 triggers fire: an HTTP
cross-service boundary (GitHub REST) and ≥2-module collaboration per feature (capture → codec →
store → index). No `system` layer: there is no deployable multi-service chain.

## 3. Results by Layer

### UNIT — `npm test` (vitest, 30 files, 381 passed)

| Module | Files | Focus |
|--------|------:|-------|
| `lib/core/**` | 5 | CKF validators, Markdown round trip, ids/slugs/paths, dedup keys, **purity guard** |
| `lib/security/**` | 4 | PBKDF2/AES-GCM, session TTL, secret scrubbing, sliding-window limits |
| `lib/**` roots | 9 | messages/validation, settings projection, queues, providers, AI client + parser, distill, status, i18n, public prefs |
| `lib/store/**` | 4 | codec contracts, vault envelope, tier config/index, GitHub store guards |
| `lib/capture/**` | 2 | extraction heuristics, body cap/truncation |
| `lib/dom/**` | 1 | overlay bubble + toast |
| `lib/ui/**` | 3 | form/status/error formatting, both pages mounted |
| `lib/tooling/**` | 1 | secret-scan assertion, pack plan |

### INT — `npm run test:int` (vitest, 9 files, 68 passed)

| Suite | TCs | What it proves |
|-------|-----|----------------|
| `background/router.int.test.ts` | TC-F4-I01 | sender authorization, rate limiting, error classification |
| `background/handlers.int.test.ts` | TC-F8-I01 | the whole worker surface: vault → settings → probe → capture → inbox → distill → reset |
| `settings-store.int.test.ts` | TC-F4-I02 | vault lifecycle; no plaintext secret ever reaches storage |
| `store/tier.int.test.ts` | TC-F3-I01 | vault-mode commit payload; index carries no body |
| `store/github-store.int.test.ts` | TC-F2-I01, TC-F6-I01 | CKF round trip through codec+store; one atomic commit; **vault-mode metadata leak regression** |
| `capture/service.int.test.ts` | TC-F1-I01/I02 | capture → dedup → commit, queue replay, transient vs permanent failure |
| `distill-service.int.test.ts` | TC-F7-I01 | three authorization gates, pending card, source byte-identical, ledger audit |
| `providers.int.test.ts` | TC-F5-I01 | all six providers through the catalog + trust rules |
| `ui/format.int.test.ts` | TC-F8-I01 | settings save → status, with no secret in any payload |

### E2E — `npx playwright test` (4 specs in 2 files, 6 passed)

Real Chromium with the built extension loaded; GitHub and the model provider intercepted at the
context level, so no token and no network. The GitHub stub is **stateful** (blobs → tree → commit →
in-memory files), so a second capture genuinely re-reads the index it wrote.

| TC-ID | Spec | Result |
|-------|------|--------|
| TC-E2E-01 | `e2e/clip.spec.ts` — vault mode clips a selection without exposing it | ✅ |
| TC-E2E-02 | `e2e/clip.spec.ts` — transparent mode writes readable Markdown + `excerpt_of` | ✅ |
| TC-E2E-01 | `e2e/clip.spec.ts` — a repeat capture writes no second commit | ✅ |
| TC-E2E-03 | `e2e/distill.spec.ts` — 提炼 writes a pending card, source untouched | ✅ |
| TC-E2E-03 | `e2e/distill.spec.ts` — 提炼 refused while AI egress is off, capture still succeeds | ✅ |
| TC-E2E-03 | `e2e/distill.spec.ts` — vault mode still distils (card encrypted) | ✅ |

No screenshots or traces were needed; `test-results/` is empty because nothing failed.

### SMK — `npm run test:smk`

| TC-ID | Critical path | Command | Result |
|-------|---------------|---------|--------|
| TC-SMK-01 | build + content bundle cannot reach a secret | `npm run build && npm run assert:content` | ✅ |
| TC-SMK-02 | clip a page end to end | `playwright test e2e/clip.spec.ts` | ✅ 3 passed |
| TC-SMK-03 | settings save → status reflects it, no secret leaked | `handlers.int.test.ts` TC-F8-I01 + `ui/format.int.test.ts` | ✅ |

### REG — `npm run test:reg` (targeted by module, 24 files, 321 passed)

| TC-ID | Module | Result |
|-------|--------|--------|
| TC-REG-core-01 | `lib/core` (ckf/markdown/paths/dedup/purity) | ✅ |
| TC-REG-security-01 | `lib/security` (crypto/session/redact/rate-limit) | ✅ |
| TC-REG-store-01 | `lib/store` (codec/vault-codec/tier/github-api/github-store) | ✅ |
| TC-REG-providers-01 | `lib/providers` + `lib/ai-client` + `lib/ai-parse` | ✅ |
| TC-REG-capture-01 | `lib/capture` (extract/normalize) | ✅ |
| TC-REG-distill-01 | `lib/distill` (+ ledger assertions in `lib/queues`) | ✅ |
| TC-REG-ui-01 | `lib/ui` + `lib/status` + `lib/settings-store` | ✅ |
| TC-REG-build-01 | build + secret assertion | ✅ (SMK-01 command) |

## 4. Coverage

Not measured. `coverage_gate: false`, and no coverage provider is installed; adding one would mean a
new devDependency for a gate nobody asked for. Every **planned** TC-ID is either labelled in a test or
executed as a named suite command (see §6). If coverage becomes a gate, add
`@vitest/coverage-v8` and a `--coverage` script.

## 5. Spec Verify (SC → passing TC)

`/od spec verify` walk over `08-spec.md`. All 21 scenarios are covered by a passing test:

| Requirement | Scenarios | Covering TCs |
|-------------|-----------|--------------|
| R1 capture | SC-F1-01/02/03 | TC-F1-U01, U04, U06, I01, I02, E2E-01, E2E-02 |
| R2 CKF | SC-F2-01/02 | TC-F2-U01, U02, U03, U04, I01 |
| R3 content tier | SC-F3-01/02/03 | TC-F3-U01…U06, F3-I01, F8-U04 |
| R4 secret custody | SC-F4-01/02/03 | TC-F4-U03…U07, F4-I01, F4-I02, F9-U01, SMK-01 |
| R5 model access | SC-F5-01/02 | TC-F5-U01…U09, F5-I01 |
| R6 GitHub storage | SC-F6-01/02/03 | TC-F6-U01…U06, F6-I01, F8-U03, E2E-01 |
| R7 distillation | SC-F7-01/02/03 | TC-F7-U01…U06, F7-I01, E2E-03 |
| R8 status surface | SC-F8-01/02 | TC-F8-U01…U05, F8-I01, SMK-03 |

**Uncovered scenarios: 0.** No Gap Backfill was required in Phase 4.

## 6. Gaps & Backfill

| Gap | Class | Found | Action | Status |
|-----|-------|-------|--------|--------|
| TC-F2-I01 had no explicitly labelled test (the round trip was only implied by another suite) | G2 | Phase 4 TC audit | Added an explicit test to `store/github-store.int.test.ts` using a now-stateful GitHub stub | resolved |
| `commands` manifest key missing → the MV3 worker threw during initial evaluation and was inert | G5 | E2E gate (Phase 3 exit) | Declared the commands and guarded every optional browser API at top level; see `07-security-audit.md` iteration 2 | resolved |
| SMK/REG existed as plan tables but had no runnable commands | G2 | Phase 4 | Added `npm run test:smk` and `npm run test:reg` | resolved |

## 7. Blocking Issues

None.

## 8. Gate Status

**PASS** — every Required layer executed and green; 0 blocking findings; security audit PASS
(iteration 2). Phase 5 may start.

## Archived 2026-10-12 - req-2026-09-30-synapse-manual-entry

---
requirement: req-2026-09-30-synapse-manual-entry
feature: F11
status: PASS (E2E waived)
---

# Test report - F11 手工录入 (manual entry)

## Phase 4 Test Execution Plan

Profile: frontend-M | UNIT yes, INT yes, REG targeted, SMK substituted, E2E **waived**
Commands: `npx tsc --noEmit` · `npm test` · `npm run test:int` · `npm run test:reg` · `npm run build` · `npm run assert:content`
Blocking: UNIT + INT (both green).

## Results

```
TSC=0

 Test Files  59 passed (59)
      Tests  621 passed (621)
   Duration  16.99s (transform 16.32s, setup 0ms, collect 56.37s, tests 6.10s, environment 5.59s, prepare 28.86s)
UNIT=0
 Test Files  13 passed (13)
      Tests  121 passed (121)
   Duration  5.45s (transform 5.35s, setup 0ms, collect 15.19s, tests 639ms, environment 3ms, prepare 4.08s)
INT=0
      Tests  409 passed (409)
   Duration  11.89s (transform 6.97s, setup 0ms, collect 30.89s, tests 5.25s, environment 2.77s, prepare 12.26s)
REG=0
Σ Total size: 425.87 kB                            
  · content-scripts\content.js
ASSERT=0
```

## Gate status

| Gate | Status | Note |
|------|--------|------|
| UNIT (blocking) | PASS | 621 passed / 59 files, including the new TC-F11-U01..U03 |
| INT (blocking) | PASS | 121 passed / 13 files, including TC-F11-I01 |
| REG | PASS | 409 passed - the page/selection paths are untouched by the note fix |
| Security audit (B.22 entry gate) | PASS | `07-security-audit.md` frontmatter `status: PASS` |
| Build + content bundle | PASS | build 0 (425.9 kB), `assert:content` OK |
| SMK | SUBSTITUTED | `npm run test:smk` is build + assert:content + a Playwright spec; the two non-browser steps ran and passed, the spec falls under the E2E waiver |
| E2E | WAIVED | user instruction 2026-09-30 (twice): do not run the browser suite. TC-F11-S01 is listed for manual acceptance: refresh the extension, open the popup, 写笔记 -> 保存 -> the note appears in the Inbox and in search |

## Coverage against the spec

| SC | Scenario | TC | Result |
|----|----------|----|--------|
| SC-F11-01 | Compose with title and text -> committed and listed | TC-F11-U01, TC-F11-I01 | PASS |
| SC-F11-02 | No title -> the first line becomes the title | TC-F11-U02, TC-F11-I01 | PASS |
| SC-F11-03 | Empty body -> refused locally, nothing sent | TC-F11-U02 | PASS |
| SC-F11-04 | Store unreachable -> queued, not lost | shared capture path (recorded in the test file) | COVERED ELSEWHERE |

## Gaps and their disposition

- **E2E**: waived, not failed. Nothing about this feature was verified in a browser; the risk is a popup
  wiring mistake that UNIT/INT cannot see (the panel opening, the button being reachable). Disposition:
  manual acceptance (TC-F11-S01) plus the recorded waiver. It is listed here rather than omitted.
- **TC-F11-I02**: not written, for the reason recorded inside `handlers.int.test.ts` - a note rides the
  identical capture path as a selection, whose queueing is already covered.
