# History: 05-test-plan.md

Append-only archive. Do not edit or delete past snapshots.
Newest entries appended at **bottom**.

| Metric | Value |
|--------|-------|
| snapshots | 3 |
| first_archived | 2026-07-09 00:00 |
| last_archived | 2026-09-29T19:00:00+08:00 |

---

## [ARCHIVE] 05-test-plan.md · v1 · 2026-07-09 00:00

| Field | Value |
|-------|-------|
| version | 1 |
| archived_at | 2026-07-09T00:00:00+08:00 |
| reason | new_requirement — superseded by req-2026-07-09-synapse-git-sync |
| trigger | /od (new requirement on main) |
| requirement_id | req-2026-07-09-synapse-ext-mvp |
| summary | Test plan for the extension MVP (57 UNIT / 10 INT / 4 E2E planned) |

<!-- BEGIN SNAPSHOT -->---
artifact: 05-test-plan.md
test_strategy_profile: frontend-only-L
layers_required: [unit, integration, e2e, smoke, regression]
layers_optional: [system]
e2e_tool: playwright
e2e_required: true
integration_required: true
unit_gate: blocking
regression_mode: targeted
project_type: greenfield
frontend_impact: yes
---

## Test Strategy Summary

| Layer | Required | Tool | Command / Path | TC Count |
|-------|:--------:|------|----------------|----------|
| UNIT | ✅ | vitest | `cd apps/extension && npm test` | 57 |
| INT | ✅ | vitest | `npm run test:int` (`lib/**/*.int.test.ts`) | 10 |
| E2E | ✅ | playwright | `npx playwright test e2e/` | 3 |
| SMK | ✅ | mixed | `npm run ci` + E2E subset | 3 |
| REG | ✅ | vitest | `npm test -- --testNamePattern=REG` | 8 |

**Profile rationale**: structure = `frontend-only` (we ship no service of our own), complexity = L.
INT is required beyond the `frontend-only-M` example because §2.3 triggers fire twice — an HTTP
cross-service boundary (GitHub REST) and ≥2-module collaboration per feature (capture → codec →
store). No `system` layer: there is no deployable multi-service chain in this MVP.

**Feature numbering** (see `04-design.md`): F1 Capture · F2 Core CKF · F3 Codec/Tier · F4 Security ·
F5 Providers/AI client · F6 GitHub Store · F7 Distill/Ledger · F8 UI · F9 Build/Tooling.

## Traceability

| Feature | Task IDs | UNIT | INT | E2E | SMK |
|---------|----------|------|-----|-----|-----|
| F1 Capture & Extraction | T1.1–T1.7 | TC-F1-U01…U07 | TC-F1-I01, I02 | TC-E2E-01, 02 | TC-SMK-02 |
| F2 Canonical Format (core) | T2.1–T2.5 | TC-F2-U01…U08 | TC-F2-I01 | — | — |
| F3 Content Codec & Tier | T3.1–T3.4 | TC-F3-U01…U06 | TC-F3-I01 | — | — |
| F4 Security & Secret Custody | T4.1–T4.7 | TC-F4-U01…U07 | TC-F4-I01, I02 | — | TC-SMK-01 |
| F5 Provider Layer & AI Client | T5.1–T5.6 | TC-F5-U01…U09 | TC-F5-I01 | — | — |
| F6 GitHub Store Adapter | T6.1–T6.6 | TC-F6-U01…U06 | TC-F6-I01 | — | — |
| F7 Distillation & Ledger | T7.1–T7.5 | TC-F7-U01…U06 | TC-F7-I01 | TC-E2E-03 | — |
| F8 UI Surfaces | T8.1–T8.6 | TC-F8-U01…U05 | TC-F8-I01 | TC-E2E-01, 03 | TC-SMK-03 |
| F9 Build & Tooling | T9.1–T9.6 | TC-F9-U01…U03 | — | — | TC-SMK-01 |

## Spec Coverage (SC → TC)

| Scenario | TC |
|----------|-----|
| SC-F1-01 | TC-F1-U01, TC-F1-I01, TC-E2E-01 |
| SC-F1-02 | TC-F1-U04, TC-E2E-02 |
| SC-F1-03 | TC-F1-U06, TC-F1-I02 |
| SC-F2-01 | TC-F2-U01, TC-F2-U02 |
| SC-F2-02 | TC-F2-U03, TC-F2-U04 |
| SC-F3-01 | TC-F3-U01, TC-F3-I01 |
| SC-F3-02 | TC-F3-U05, TC-F8-U04 |
| SC-F3-03 | TC-F3-U03 |
| SC-F4-01 | TC-F9-U01, TC-SMK-01 |
| SC-F4-02 | TC-F4-U03, TC-F4-U04 |
| SC-F4-03 | TC-F4-U05, TC-F4-U06 |
| SC-F5-01 | TC-F5-U01…U05, TC-F5-I01 |
| SC-F5-02 | TC-F5-U08, TC-F5-U09 |
| SC-F6-01 | TC-F6-U01, TC-F6-I01 |
| SC-F6-02 | TC-F6-U05, TC-F8-U03 |
| SC-F6-03 | TC-F6-U03, TC-F6-U04 |
| SC-F7-01 | TC-F7-I01, TC-E2E-03 |
| SC-F7-02 | TC-F7-U05, TC-F4-I01 |
| SC-F7-03 | TC-F7-U03, TC-F7-U04 |
| SC-F8-01 | TC-F8-U01, TC-SMK-03 |
| SC-F8-02 | TC-F8-U04, TC-F8-I01 |

## F1 — UNIT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|-------|------|--------|-------|----------|------|
| TC-F1-U01 | UNIT | Happy | `extractPage` | article fixture HTML | title/url/text extracted, `article` wins over `nav` | none (happy-dom) |
| TC-F1-U02 | UNIT | Happy | `extractPage` fallback | HTML without `<article>` | falls back `main` → `body`, no throw | none |
| TC-F1-U03 | UNIT | Boundary | `extractPage` empty | whitespace-only page | `extraction:'title-only'`, empty body allowed | none |
| TC-F1-U04 | UNIT | Happy | `extractSelection` | selection inside a paragraph | returns text + paragraph context | none |
| TC-F1-U05 | UNIT | Happy | `urlKey` | URL with `utm_*`, fragment, uppercase host | normalized key, tracking stripped | none |
| TC-F1-U06 | UNIT | Happy | `isNearDuplicate` | 2 KB body, one word changed | `true` (Jaccard ≥ 0.9) | none |
| TC-F1-U07 | UNIT | Boundary | body cap | 700 KB text | truncated to 512 KB, `truncated:true`, `original_bytes` set | none |

## F2 — UNIT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|-------|------|--------|-------|----------|------|
| TC-F2-U01 | UNIT | Happy | `encodeDoc`/`decodeDoc` | SourceItem with all fields | deep-equal after round trip | none |
| TC-F2-U02 | UNIT | Boundary | `decodeDoc` | body containing `---`, quotes, emoji, CJK title | parsed correctly, body byte-identical | none |
| TC-F2-U03 | UNIT | Error | `parseSourceItem` | missing `url` | `CkfError`, no partial record | none |
| TC-F2-U04 | UNIT | Error | `parseKnowledgeCard` | `points` as string | `CkfError` (type mismatch) | none |
| TC-F2-U05 | UNIT | Happy | `slugify` | CJK + punctuation title | CJK kept, punctuation folded, ≤60 chars | none |
| TC-F2-U06 | UNIT | Happy | `newId` | 10 000 ids | time-ordered, no collision | fake clock |
| TC-F2-U07 | UNIT | Happy | `sourceItemPath`/`cardPath` | date + id | `inbox/YYYY/MM/<slug>-<id8>.md` | fake clock |
| TC-F2-U08 | UNIT | Error | core purity test | scan `lib/core/**` | no browser/network global, no import outside core | none |

## F3 — UNIT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|-------|------|--------|-------|----------|------|
| TC-F3-U01 | UNIT | Happy | `vaultCodec.encode/decode` | SourceItem + derived key | body absent from file text, round trip ok | injected crypto |
| TC-F3-U02 | UNIT | Happy | envelope shape | encode twice | distinct `iv_b64`, same `salt_b64`, `meta` has no title/url/body | none |
| TC-F3-U03 | UNIT | Error | `decode` locked | no key | `VaultLockedError`, nothing written | none |
| TC-F3-U04 | UNIT | Error | wrong passphrase | ciphertext + other key | AES-GCM auth failure → "口令错误", no partial text | none |
| TC-F3-U05 | UNIT | Happy | `transparentCodec` | SourceItem | frontmatter Markdown, no encryption | none |
| TC-F3-U06 | UNIT | Boundary | mode mismatch | plaintext file while vault mode | plaintext read succeeds; unknown content → typed error | none |

## F4 — UNIT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|-------|------|--------|-------|----------|------|
| TC-F4-U01 | UNIT | Happy | `deriveKey` | same passphrase + salt | identical bytes; different salt → different bytes | injected crypto |
| TC-F4-U02 | UNIT | Happy | `encryptText`/`decryptText` | 1 B / 1 KB / 512 KB | round trip exact | injected crypto |
| TC-F4-U03 | UNIT | Error | `scrub` exact | message containing the configured PAT | `[REDACTED]` substituted | none |
| TC-F4-U04 | UNIT | Error | `scrub` regex | `sk-abc`, `ghp_abc` not in the secret list | redacted by pattern | none |
| TC-F4-U05 | UNIT | Happy | `SlidingWindowLimiter` | 31 calls in a 60 s window | 31st rejected, recovers after the window | fake clock |
| TC-F4-U06 | UNIT | Boundary | limiter keying | two tab buckets + global cap | per-tab independent, global cap enforced | fake clock |
| TC-F4-U07 | UNIT | Error | `isExtensionPageSender` | sender with `tab.url = https://evil.test` | secret-bearing type rejected | none |

## F5 — UNIT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|-------|------|--------|-------|----------|------|
| TC-F5-U01 | UNIT | Happy | `chat` bearer | OpenAI fixture response | text extracted, correct URL + `Authorization: Bearer` | fetch stub |
| TC-F5-U02 | UNIT | Happy | `chat` anthropic | Anthropic fixture | `x-api-key` + `anthropic-version`, `system` hoisted, `content[0].text` | fetch stub |
| TC-F5-U03 | UNIT | Happy | `parseChatCompletion` | deeply nested `data.result.output` | unwrapped ≤4 levels | none |
| TC-F5-U04 | UNIT | Happy | SSE tolerance | `data: {...}` chunks + NDJSON | concatenated text | none |
| TC-F5-U05 | UNIT | Boundary | empty choices | `{"choices":[]}` | typed `EmptyResponseError`, no crash | none |
| TC-F5-U06 | UNIT | Error | timeout | fetch never resolves | abort at 15 s → "请求超时" | fake timers |
| TC-F5-U07 | UNIT | Error | 401 echo | 401 body containing the api key | classified message, key scrubbed | fetch stub |
| TC-F5-U08 | UNIT | Error | `isValidBaseUrl` | `http://api.x.com`, `ftp://`, `not a url` | all rejected; `https://` and `http://127.0.0.1` accepted | none |
| TC-F5-U09 | UNIT | Happy | `requiresTrustAck` | catalog default host vs custom host | default false, custom true | none |

## F6 — UNIT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|------|------|--------|-------|----------|------|
| TC-F6-U01 | UNIT | Happy | `github-api.commitFiles` | 2 files | `GET ref` → 2×`POST blob` → `POST tree(base_tree)` → `POST commit` → `PATCH ref`; returns sha + html_url | fetch stub |
| TC-F6-U02 | UNIT | Boundary | `commitFiles` degenerate | 1 file | same sequence, `tree` carries one entry | fetch stub |
| TC-F6-U03 | UNIT | Error | `probeRepo` 401 | `{"message":"Bad credentials"}` | `AuthError`, no write attempted | fetch stub |
| TC-F6-U04 | UNIT | Error | 403 scope | `{"message":"Resource not accessible"}` | `ScopeError` with Contents-write hint | fetch stub |
| TC-F6-U05 | UNIT | Happy | `probeRepo` visibility | `{private:true}` / `{private:false}` | `canWrite:true` / `canWrite:false` + `warning:'public-repo'` | fetch stub |
| TC-F6-U06 | UNIT | Error | ref conflict | `PATCH ref` → 409 once then 200 | one re-read + retry, then success; second 409 → `ConflictError` | fetch stub |

## F7 — UNIT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|------|------|--------|-------|----------|------|
| TC-F7-U01 | UNIT | Happy | `buildDistillPrompt` | SourceItem | system demands strict JSON; user carries body; no PAT/key inside | none |
| TC-F7-U02 | UNIT | Happy | `parseDistillResult` | fenced ```` ```json ```` block | parsed card | none |
| TC-F7-U03 | UNIT | Error | `parseDistillResult` | prose with no JSON | `DistillParseError`, nothing committed | none |
| TC-F7-U04 | UNIT | Error | schema violation | valid JSON, `title` missing | validator rejects | none |
| TC-F7-U05 | UNIT | Error | authorization gate | item not in ledger, global AI on | rejected before any fetch | fetch spy asserts 0 calls |
| TC-F7-U06 | UNIT | Boundary | points bound | 15 points / 2 points | capped at 12 with warning; <3 accepted with warning | none |

## F8 — UNIT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|------|------|--------|-------|----------|------|
| TC-F8-U01 | UNIT | Happy | `toPublicPrefs` | full settings incl. secrets | projection has only booleans/metadata, no secret values | none |
| TC-F8-U02 | UNIT | Happy | status formatter | store + mode + lock state | human-readable line, no token substring | none |
| TC-F8-U03 | UNIT | Error | visibility state | `private:false` probe | `warning:'public-repo'`, save blocked until acknowledged | none |
| TC-F8-U04 | UNIT | Error | error classifier | 401 / 403 / 404 / 409 / 422 | distinct fixed messages, scope hint on 403 | none |
| TC-F8-U05 | UNIT | Boundary | `t()` | known key, unknown key, vars | translated; unknown → key fallback (no throw) | none |

## F9 — UNIT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|------|------|--------|-------|----------|------|
| TC-F9-U01 | UNIT | Happy | secret-scan predicate | bundle text with/without forbidden markers | fails on `secretVault`, passes when `publicPrefs` present | none |
| TC-F9-U02 | UNIT | Boundary | secret-scan predicate | empty file / missing file | clear failure message, non-zero exit | tmp fs |
| TC-F9-U03 | UNIT | Happy | pack arg parser | `--skip-test`, none, unknown | flags parsed; unknown flag rejected | none |

## F1 — INT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|------|------|--------|-------|----------|------|
| TC-F1-I01 | INT | API | background capture handler | `CAPTURE_REQUEST` from popup | store receives 3 files (source, index, config) in one commit | in-memory `KnowledgeStore` |
| TC-F1-I02 | INT | Failure | dedup path | second identical capture | zero commits, reply `duplicate` + existing path | in-memory store |

## F2 — INT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|------|------|--------|-------|----------|------|
| TC-F2-I01 | INT | API | core + codec + store | SourceItem through codec into store then read back | decoded record deep-equals original | in-memory store |

## F3 — INT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|------|------|--------|-------|----------|------|
| TC-F3-I01 | INT | API | vault-mode commit payload | capture in vault mode | committed files are `.md.enc`; `index.json` carries no body | in-memory store |

## F4 — INT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|------|------|--------|-------|----------|------|
| TC-F4-I01 | INT | Security | message boundary | content-script sender → `SET_GITHUB` / `DISTILL_REQUEST` | rejected, no handler side effect | stub runtime |
| TC-F4-I02 | INT | API | settings split | save secrets while locked, then unlock | `publicPrefs` never exposes values; unlock restores access | in-memory storage |

## F5 — INT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|------|------|--------|-------|----------|------|
| TC-F5-I01 | INT | API | provider → distill → store | authorized distill with mock provider | pending card committed under `cards/pending/` | fetch stub + in-memory store |

## F6 — INT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|------|------|--------|-------|----------|------|
| TC-F6-I01 | INT | API | `github-store` commit through codec | vault-mode `commitFiles` with index update | api receives blob/tree/commit/ref calls; index merged, one commit only | fetch stub |

## F7 — INT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|------|------|--------|-------|----------|------|
| TC-F7-I01 | INT | API | distill end-to-end | authorized item | card file written, source file byte-identical, ledger appended | fetch stub + in-memory store |

## F8 — INT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|------|------|--------|-------|----------|------|
| TC-F8-I01 | INT | API | settings save → status | `SET_GITHUB` then `GET_STATUS` | probe result stored, status reflects repo + visibility, no secret in payload | fetch stub + in-memory storage |

## E2E Flows
| TC-ID | Layer | Flow | Steps (short) | Expected |
|-------|------|------|---------------|----------|
| TC-E2E-01 | E2E | Load + clip full page | launch persistent context with the built extension → serve a fixture page → seed settings in `chrome.storage` → popup 剪藏 → wait for status | the intercepted GitHub call carries `inbox/YYYY/MM/*.md` + a merged `index.json` containing the page title |
| TC-E2E-02 | E2E | Clip selection | same context → select text → trigger selection capture | committed body equals the selection, `excerpt_of` = page URL |
| TC-E2E-03 | E2E | Distill stays a proposal | seed AI authorization + mock provider response → run 提炼 from the popup | `cards/pending/*.md` committed; the source file content in the same run is unchanged |

*E2E mechanism*: `chromium.launchPersistentContext(builtDir, { args: ['--disable-extensions-except=…','--load-extension=…'] })`
plus `context.route('https://api.github.com/**')` (service-worker request interception) serving canned
GitHub responses. **Risk**: if SW interception is unavailable in the pinned Playwright/Chromium,
fall back to a UI-only E2E and move the network assertion to `TC-F6-I01` — requires B.0 confirm.

## Smoke Suite
| TC-ID | Source-TC | Layer | Critical Path |
|-------|-----------|-------|---------------|
| TC-SMK-01 | TC-F9-U01 | UNIT | `npm run build` + `assert:content` green (SC-F4-01) |
| TC-SMK-02 | TC-F1-U01 | UNIT+E2E | clip a page end-to-end (SC-F1-01) |
| TC-SMK-03 | TC-F8-I01 | INT+E2E | settings save → status reflects it without leaking secrets (SC-F8-01) |

## Regression Suite
| TC-ID | Layer | Module | Package | Type |
|-------|-------|--------|---------|------|
| TC-REG-core-01 | REG | core (ckf/markdown/paths/dedup) | extension | UNIT |
| TC-REG-security-01 | REG | security (crypto/session/redact/limit) | extension | UNIT |
| TC-REG-store-01 | REG | store (github-api/github-store/codec) | extension | UNIT+INT |
| TC-REG-providers-01 | REG | providers + ai-client | extension | UNIT |
| TC-REG-capture-01 | REG | capture extraction | extension | UNIT |
| TC-REG-distill-01 | REG | distill + ledger | extension | UNIT |
| TC-REG-ui-01 | REG | settings / prefs projection | extension | UNIT |
| TC-REG-build-01 | REG | build + secret assertions | extension | SMK |

## Test Environment
- `npm test` runs UNIT with `environment: node`; DOM specs are upgraded to `happy-dom` via `environmentMatchGlobs`.
- `fetch` never hits the network in tests: every client takes an injected `fetchImpl`.
- WebCrypto is injected in crypto tests so PBKDF2 iteration counts stay small and fast.
- `chrome.*` is faked with `vi.stubGlobal` and torn down in `afterEach`.
- E2E requires `npm run build` first (Playwright global setup builds when `.output/chrome-mv3` is missing).
<!-- END SNAPSHOT -->

---

## [ARCHIVE] 05-test-plan.md · v2 · 2026-09-29T18:10:00+08:00

---
artifact: 05-test-plan.md
version: 2
previous_version: 1
test_strategy_profile: monorepo-XL
layers_required: [unit, integration, system, e2e, smoke, regression]
layers_optional: []
e2e_tool: playwright
e2e_required: true
integration_required: true
system_required: true
unit_gate: blocking
regression_mode: targeted
project_type: greenfield
frontend_impact: yes
---

## Test Strategy Summary

| Layer | Required | Tool | Command / Path | Planned TC |
|-------|:--------:|------|----------------|-----------:|
| UNIT | ✅ | vitest | `npm --prefix apps/extension test` · `npm --prefix apps/git-bridge test` | 56 |
| INT | ✅ | vitest | `npm --prefix apps/extension run test:int` | 20 |
| SYS | ✅ | vitest + real git/ssh | `npm --prefix apps/git-bridge run test:sys` | 8 |
| E2E | ✅ | playwright | `npm --prefix apps/extension run test:e2e` | 6 |
| SMK | ✅ | mixed | `npm run test:smk` | 3 |
| REG | ✅ | vitest | `npm run test:reg` | 10 |

**Profile rationale**: `monorepo-XL` because this requirement adds a **second package**
(`apps/git-bridge`), so UNIT is run per package and REG/INT are tagged by `[pkg:extension]` /
`[pkg:git-bridge]`. `system` is required (unlike the previous requirement) because the companion is a
real process that must be exercised against a real `git`/`ssh` — an in-process fake cannot prove the
transport works. `e2e_required` stays true: the extension still has a full UI path.

## Traceability

| Feature | Task IDs | UNIT | INT | SYS | E2E | SMK |
|---------|----------|------|-----|-----|-----|-----|
| F1 GitAuth abstraction | T1.0–T1.6 | TC-F1-U01…U08 | TC-F1-I01, I02 | — | TC-E2E-02 | — |
| F2 Native messaging & companion | T2.0–T2.8 | TC-F2-U01…U10 | TC-F2-I01…I03 | TC-F2-S01…S08 | TC-E2E-02 | TC-SMK-02 |
| F3 Sync engine | T3.0–T3.9 | TC-F3-U01…U12 | TC-F3-I01…I07 | TC-F2-S03, S05 | TC-E2E-01, 04, 05 | TC-SMK-01 |
| F4 Search & retrieval | T4.0–T4.7 | TC-F4-U01…U12 | TC-F4-I01…I03 | — | TC-E2E-03 | TC-SMK-03 |
| F5 Settings & UI | T5.0–T5.6 | TC-F5-U01…U08 | TC-F5-I01, I02 | — | TC-E2E-03 | TC-SMK-03 |
| F6 Layout & migration | T6.0–T6.4 | TC-F6-U01…U06 | TC-F6-I01…I03 | — | TC-E2E-06 | TC-SMK-01 |
| Pkg tooling & deploy | T7.0–T7.4 | TC-F7-U01, U02 | — | — | — | TC-SMK-02 |

## Spec Coverage (SC → TC)

| Scenario | Covering TCs |
|----------|--------------|
| SC-F1-01 | TC-F1-U01, F1-I01, E2E-02 |
| SC-F1-02 | TC-F1-U03, F1-U04, F1-I02, E2E-02 |
| SC-F1-03 | TC-F1-U05, F1-I02, F2-S04, E2E-02 |
| SC-F1-04 | TC-F1-U06, F5-U04 |
| SC-F2-01 | TC-F2-U01, F2-U02, F2-I01, F2-S01 |
| SC-F2-02 | TC-F2-U03…U07, F2-I02, F2-S06 |
| SC-F2-03 | TC-F2-U08, F2-S07 |
| SC-F3-01 | TC-F1-U07, F5-U05, F6-I02 |
| SC-F3-02 | TC-F1-U08, F5-U06, F6-I02, E2E-06 |
| SC-F4-01 | TC-F3-U05, F3-I03, E2E-05 |
| SC-F4-02 | TC-F3-U06, F3-U07, F3-I04, E2E-04 |
| SC-F5-01 | TC-F3-U01, F3-I01, E2E-01 |
| SC-F5-02 | TC-F3-U02, F3-U03, F3-I02, E2E-01 |
| SC-F5-03 | TC-F3-U08, F3-U09, F3-I06 |
| SC-F5-04 | TC-F3-U10, F3-I05 |
| SC-F6-01 | TC-F4-U01…U06, F4-I01, E2E-03 |
| SC-F6-02 | TC-F4-U07, F4-U08 |
| SC-F6-03 | TC-F4-U09, F4-U10, F4-I03 |
| SC-F7-01 | TC-F6-U01, F6-U02 |
| SC-F7-02 | TC-F6-U03, F6-I01, F6-I03, E2E-06 |
| SC-F7-03 | TC-F4-U11, F4-I02, F6-U04 |
| SC-F8-01 | TC-F5-U01, F5-U02, F5-U03, F5-I01 |
| SC-F8-02 | TC-F5-U07, F5-U08, F5-I02, E2E-05 |

## F1 — UNIT `[pkg:extension]`
| TC-ID | Type | Target | Input | Expected | Mock |
|-------|------|--------|-------|----------|------|
| TC-F1-U01 | Happy | `TokenAuth.assertReady` | token + owner/repo/branch | resolves | vault stub |
| TC-F1-U02 | Error | `TokenAuth.assertReady` | empty token | `NotConfiguredError` | vault stub |
| TC-F1-U03 | Happy | `resolveAuth` | mode `ssh`, companion missing | `{ unavailable: 'native-missing' }`, no throw | availability stub |
| TC-F1-U04 | Error | `resolveAuth` | mode `ssh`, protocol mismatch | `{ unavailable: 'protocol-mismatch' }` | availability stub |
| TC-F1-U05 | Happy | `SshAuth.assertReady` | companion ok | resolves, **no key material read** | native stub |
| TC-F1-U06 | Boundary | mode switch | token→ssh→token | each mode keeps its own credential | vault stub |
| TC-F1-U07 | Happy | `SshAuth.describe` | ssh config | `{ mode:'ssh', host, user, keyRef }` | none |
| TC-F1-U08 | Error | `resolveAuth` | mode `ssh`, `git` missing | `unavailable: 'git-missing'` | native stub |

## F2 — UNIT `[pkg:git-bridge]`
| TC-ID | Type | Target | Input | Expected | Mock |
|-------|------|--------|-------|----------|------|
| TC-F2-U01 | Happy | protocol decode | valid frame | parsed request | none |
| TC-F2-U02 | Boundary | protocol decode | frame at the 1 MB cap | accepted; above cap → `frameTooLarge` | none |
| TC-F2-U03 | Error | op allow-list | `shell.exec` | rejected `unknownOp`, no git run | child_process spy |
| TC-F2-U04 | Error | path confinement | `cwd: '../../etc'` | rejected `pathOutsideRoot` | none |
| TC-F2-U05 | Error | path confinement | absolute path outside root | rejected | none |
| TC-F2-U06 | Error | argument safety | branch `evil; rm -rf /` | passed as ONE argv element, shell never used | child_process spy asserts arg array |
| TC-F2-U07 | Error | response shape | unknown op | error response with a code, process stays alive | none |
| TC-F2-U08 | Boundary | argument safety | path with spaces/quotes/unicode | preserved exactly | child_process spy |
| TC-F2-U09 | Happy | `key.list` | fake ssh dir | returns identifiers only (never key bytes) | fs stub |
| TC-F2-U10 | Error | malformed frame | truncated length prefix | clean error, no crash | none |

## F2 — SYS (companion against real git/ssh; skipped when `ssh` is unavailable locally)
| TC-ID | Type | Flow | Expected |
|-------|------|------|----------|
| TC-F2-S01 | SYS | `ping` + version handshake over stdio | `{ v: 1 }` echoed, exit 0 on EOF |
| TC-F2-S02 | SYS | `git.probe` on a local bare repo (`file://`) | branch, head, remote reported |
| TC-F2-S03 | SYS | `git.fetch` after an external commit | new head reported; working tree updated |
| TC-F2-S04 | SYS | `git.commit` + `git.push` to the bare repo | commit present in the bare repo, `git log` matches |
| TC-F2-S05 | SYS | `git.status` with local changes | dirty paths listed |
| TC-F2-S06 | SYS | request `cwd` outside root | rejected, exit code 0, no git side effect |
| TC-F2-S07 | SYS | branch name with shell metacharacters | created verbatim, no shell execution |
| TC-F2-S08 | SYS | 5 000-file tree listing | chunked frames, all entries received, < 10 s |

*Real `ssh://` to GitHub is not exercised in CI (no key). A local bare repository over
`file://`/`ssh://localhost` proves the transport path; the GitHub-specific part is covered by
TC-F1-I02 with a fake companion.*

## F3 — UNIT `[pkg:extension]`
| TC-ID | Type | Target | Input | Expected |
|-------|------|--------|-------|----------|
| TC-F3-U01 | Happy | `planMerge` | nothing changed | `{ pull: [], push: [] }` |
| TC-F3-U02 | Happy | `planMerge` | remote changed only | pull list, no push |
| TC-F3-U03 | Happy | `planMerge` | local changed only | push list, no pull |
| TC-F3-U04 | Happy | `planMerge` | both, different paths | both lists, no conflict |
| TC-F3-U05 | Happy | `planMerge` | both, same path | conflict copy path + keep remote |
| TC-F3-U06 | Error | `planMerge` | remote deleted, local changed | resurrect + record |
| TC-F3-U07 | Boundary | conflict name | two conflicts in the same minute | distinct names (counter suffix) |
| TC-F3-U08 | Happy | `SyncEngine.sync` | head unchanged | `upToDate`, zero blob fetches |
| TC-F3-U09 | Boundary | trigger coalescing | 5 captures in 1 s | at most one in-flight sync + one queued |
| TC-F3-U10 | Error | `sync` | vault locked, tier vault | aborts `locked` before caching anything |
| TC-F3-U11 | Error | `sync` | network error mid-pull | head NOT advanced, dirty set preserved |
| TC-F3-U12 | Boundary | fetch concurrency | 40 changed blobs | ≤ 4 concurrent, all fetched |

## F3 — INT `[pkg:extension]`
| TC-ID | Type | Target | Expected |
|-------|------|--------|----------|
| TC-F3-I01 | API | sync against a fake remote, no drift | 2 requests, `upToDate` |
| TC-F3-I02 | API | remote gains 3 files | 3 blobs fetched, cache + index updated, head advanced |
| TC-F3-I03 | API | capture → push | commit created with the freshly read head as parent |
| TC-F3-I04 | Failure | head moves during push | retry once; second move → conflict copy committed |
| TC-F3-I05 | Security | vault locked | nothing cached, nothing pushed, `locked` returned |
| TC-F3-I06 | API | alarm trigger | pull runs on interval; interval 0 disables it |
| TC-F3-I07 | API | remote deletes a cached file | cache + index entry removed |

## F4 — UNIT `[pkg:extension]`
| TC-ID | Type | Target | Expected |
|-------|------|--------|----------|
| TC-F4-U01 | Happy | `postings.add` | term → record posting, deterministic order |
| TC-F4-U02 | Happy | `postings.remove` | posting disappears, shard stays valid JSON |
| TC-F4-U03 | Happy | shard key | first two characters of the term, unicode-safe |
| TC-F4-U04 | Boundary | shard size | 5 000 records → truncation marker present |
| TC-F4-U05 | Happy | `query` latin | matches body term, returns path + snippet |
| TC-F4-U06 | Happy | `query` field weights | title match ranks above body match |
| TC-F4-U07 | Happy | `query` CJK bigram | Chinese query finds the record |
| TC-F4-U08 | Boundary | `query` filters | `tag:` / `topic:` / `in:` narrow correctly |
| TC-F4-U09 | Error | `query` empty | `[]`, no throw |
| TC-F4-U10 | Error | corrupt shard | `needsRebuild` flag, no throw |
| TC-F4-U11 | Happy | `renderNotesIndex` | topics + recent cards, stable hash when unchanged |
| TC-F4-U12 | Boundary | recency ranking | newer record wins ties |

## F4 — INT `[pkg:extension]`
| TC-ID | Type | Target | Expected |
|-------|------|--------|----------|
| TC-F4-I01 | API | index → query end to end | seeded corpus, query finds the right record |
| TC-F4-I02 | API | capture → index → push | the note and its shard land in ONE commit |
| TC-F4-I03 | API | rebuild from the repository | index reconstructed, same query result |

## F5 — UNIT / INT `[pkg:extension]`
| TC-ID | Type | Target | Expected |
|-------|------|--------|----------|
| TC-F5-U01 | Happy | `authModeOptions` | token enabled; ssh enabled only when available |
| TC-F5-U02 | Happy | `companionStatusText` | three states → three fixed messages |
| TC-F5-U03 | Happy | status projection | auth mode, branch, sync state; never a secret |
| TC-F5-U04 | Boundary | mode switch in the form | other mode's stored value untouched |
| TC-F5-U05 | Happy | `branchNotice` | exists → ok; missing → create action |
| TC-F5-U06 | Error | `validateSshForm` | empty host/user rejected with field messages |
| TC-F5-U07 | Happy | `formToAuthPayload` | round trip form ↔ payload |
| TC-F5-U08 | Error | i18n parity | every new key present in both dictionaries |
| TC-F5-I01 | API | `sync.status` handler | reports last sync, pending, conflicts |
| TC-F5-I02 | API | `sync.now` handler | runs a sync, returns the result, updates status |

## F6 — UNIT / INT `[pkg:extension]`
| TC-ID | Type | Target | Expected |
|-------|------|--------|----------|
| TC-F6-U01 | Happy | `DEFAULT_SETTINGS` | `securityMode: 'transparent'` for a new store |
| TC-F6-U02 | Happy | `resolveTier` | no config → default; config present → recorded mode |
| TC-F6-U03 | Happy | `resolveTier` | existing vault config → vault preserved |
| TC-F6-U04 | Error | corrupt `config.json` | `unknown`, asks the user, never guesses |
| TC-F6-U05 | Boundary | 0.1.0 repository | reads fine; new fields added only on the next write |
| TC-F6-U06 | Boundary | `switchTier` | still refuses on a non-empty store |
| TC-F6-I01 | API | existing vault repo opened | no rewrite; tier reported; commit count unchanged |
| TC-F6-I02 | API | branch in config | custom branch round trip through config |
| TC-F6-I03 | API | sync_policy in config | written once, read on a fresh store instance |

## F7 — UNIT `[pkg:git-bridge]`
| TC-ID | Type | Target | Expected |
|-------|------|--------|----------|
| TC-F7-U01 | Happy | host manifest template | valid JSON per OS, `allowed_origins` present |
| TC-F7-U02 | Error | manifest placeholder | unfilled placeholder is rejected by the installer |

## E2E Flows
| TC-ID | Flow | Steps (short) | Expected |
|-------|------|---------------|----------|
| TC-E2E-01 | Pull after a remote change | seed repo via stub → capture once → add a file to the fake remote → open popup → 立即同步 | the new record appears in the cache/index; status reports 1 pulled |
| TC-E2E-02 | SSH mode degradation | select SSH in options with no companion | mode shown unavailable with a hint; token mode still clips successfully |
| TC-E2E-03 | Search a captured note | capture a distinctive phrase → open popup → search | the note is found with a snippet and path |
| TC-E2E-04 | Conflict surfacing | local edit + remote edit of the same path → sync | conflict count shown; both versions present in the repository |
| TC-E2E-05 | Sync status + no-op | sync twice with no remote change | second sync reports "up to date" and makes no commit |
| TC-E2E-06 | Readable default + existing store | new store → capture; then open a pre-seeded vault store | new store writes `.md`; vault store unchanged and reported as vault |

## Smoke Suite
| TC-ID | Source-TC | Critical Path |
|-------|-----------|---------------|
| TC-SMK-01 | TC-F3-I01 | sync is a no-op when nothing changed; a capture still commits |
| TC-SMK-02 | TC-F1-U03 | extension builds and runs with the companion absent (no crash, no secret in the bundle) |
| TC-SMK-03 | TC-F4-I01 | capture → search finds the note |

## Regression Suite
| TC-ID | Layer | Module | Package |
|-------|-------|--------|---------|
| TC-REG-ext-core-01 | REG | core (CKF/markdown/paths/dedup) | extension |
| TC-REG-ext-security-01 | REG | security (crypto/session/redact/limit) | extension |
| TC-REG-ext-store-01 | REG | store (codec/vault/tier/github-api/github-store) | extension |
| TC-REG-ext-capture-01 | REG | capture + distill + providers | extension |
| TC-REG-ext-ui-01 | REG | ui + status + i18n | extension |
| TC-REG-ext-sync-01 | REG | sync (reconcile/cache/engine) | extension |
| TC-REG-ext-search-01 | REG | search (postings/query/docs) | extension |
| TC-REG-bridge-unit-01 | REG | protocol + git wrapper | git-bridge |
| TC-REG-build-01 | REG | build + `assert:content` + companion packaging | both |
| TC-REG-e2e-01 | REG | the 0.1.0 E2E specs must still pass unchanged | extension |

## Test Environment
- Existing conventions hold: injected `fetchImpl`, injected clock, `vi.stubGlobal` for browser APIs.
- **New**: the companion is tested against a **local bare git repository** created in a temp dir
  (`git init --bare`), driven over stdio. `TC-F2-S*` skip with a clear message when `git` is absent,
  never fail silently.
- **New**: the native client is exercised with a **fake host** (an in-process duplex stream) so INT can
  cover framing, timeouts and reconnects without spawning a process.
- E2E keeps the stateful GitHub stub and adds a "remote drift" helper that mutates the stub's file map
  between syncs.

## [ARCHIVE] 05-test-plan.md · v3 · 2026-09-29T19:00:00+08:00

---
version: 3
previous_version: 2
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

