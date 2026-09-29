# History: 02-plan.md

Append-only archive. Do not edit or delete past snapshots.
Newest entries appended at **bottom**.

| Metric | Value |
|--------|-------|
| snapshots | 4 |
| first_archived | 2026-07-09 00:00 |
| last_archived | 2026-09-29T19:00:00+08:00 |

---

## [ARCHIVE] 02-plan.md · v1 · 2026-07-09 00:00

| Field | Value |
|-------|-------|
| version | 1 |
| archived_at | 2026-07-09T00:00:00+08:00 |
| reason | new_requirement — superseded by req-2026-07-09-synapse-git-sync |
| trigger | /od (new requirement on main) |
| requirement_id | req-2026-07-09-synapse-ext-mvp |
| summary | Plan for the extension MVP (52 tasks / 10 groups, F1-F9) |

<!-- BEGIN SNAPSHOT -->---
version: 1
artifact: 02-plan.md
requirement_id: req-2026-07-09-synapse-ext-mvp
complexity: L
total_tasks: 52
groups: 10
last_updated: 2026-07-09T00:00:00+08:00
history_ref: 02-plan-history.md
---

# Plan: 浏览器插件 MVP — 捕获 → 提炼 → GitHub 落库

**Build order**: bottom-up. G0 scaffold → G1–G5 pure/data layers → G6–G7 feature logic → G8 UI →
G9 release assets. Every `verify:` command must be runnable from `apps/extension/` unless it starts
with `npm run` at the repo root.

**Spec traceability**: every task names its feature (`F1`–`F9`) and the TC-IDs it must satisfy
(`05-test-plan.md`). A task without a passing verification command may not be marked `[x]`
(spec-driven §4 + §7).

## Task Groups

| Group | Theme | Features | Tasks | Depends on |
|-------|-------|----------|-------|------------|
| G0 | Bootstrap | F9 | T0.1–T0.4 | — |
| G1 | Canonical core | F2 | T1.1–T1.5 | G0 |
| G2 | Security & secrets | F4 | T2.1–T2.7 | G0 |
| G3 | Content codec & tier | F3 | T3.1–T3.4 | G1, G2 |
| G4 | Provider & AI client | F5 | T4.1–T4.6 | G2 |
| G5 | GitHub store adapter | F6 | T5.1–T5.6 | G1, G3, G4 |
| G6 | Capture pipeline | F1 | T6.1–T6.7 | G1, G3, G5 |
| G7 | Distillation & ledger | F7 | T7.1–T7.5 | G4, G5 |
| G8 | UI surfaces | F8 | T8.1–T8.6 | G2, G5, G6, G7 |
| G9 | Release & verification | F9 | T9.1–T9.6 | all |

## G0 — Bootstrap (F9)

- [x] **T0.1** [tooling] WXT app scaffold + strict TS + vitest config · feature: F9 · outputs: `apps/extension/package.json`, `apps/extension/wxt.config.ts`, `apps/extension/tsconfig.json`, `apps/extension/vitest.config.ts`, `apps/extension/.gitignore` · depends: — · verify: `cd apps/extension && npm install && npx wxt prepare` exits 0
- [x] **T0.2** [tooling] Root delegating scripts + Makefile · feature: F9 · outputs: `package.json`, `Makefile` · depends: T0.1 · verify: `npm run test --prefix . ` from repo root reaches the extension suite (`npm test` exits 0)
- [x] **T0.3** [tooling] i18n dictionaries + DOM-free `t()` · feature: F8 · outputs: `apps/extension/lib/i18n.ts`, `apps/extension/lib/i18n.test.ts` · depends: T0.1 · verify: `npm test -- i18n` (TC-F8-U05)
- [x] **T0.4** [tooling] Deterministic icon generation · feature: F9 · outputs: `apps/extension/scripts/gen-icons.mjs` · depends: T0.1 · verify: `npm run icons` writes `icon-16/32/48/96/128.png` into `apps/extension/public/`

## G1 — Canonical Core (F2)

- [x] **T1.1** [core] CKF types + runtime validators (`SourceItem`/`KnowledgeCard`/`Topic`/`ReviewState`) · feature: F2 · outputs: `apps/extension/lib/core/ckf.ts` · depends: T0.1 · verify: `npm test -- core/ckf` (TC-F2-U03, TC-F2-U04)
- [x] **T1.2** [core] Markdown + YAML-subset frontmatter codec · feature: F2 · outputs: `apps/extension/lib/core/markdown.ts`, `apps/extension/lib/core/markdown.test.ts` · depends: T1.1 · verify: `npm test -- core/markdown` (TC-F2-U01, TC-F2-U02)
- [x] **T1.3** [core] Ids, slugs and repo path builders · feature: F2 · outputs: `apps/extension/lib/core/paths.ts`, `apps/extension/lib/core/paths.test.ts` · depends: T1.1 · verify: `npm test -- core/paths` (TC-F2-U05, TC-F2-U06, TC-F2-U07)
- [x] **T1.4** [core] Dedup keys (url / content hash / near-duplicate) · feature: F2 · outputs: `apps/extension/lib/core/dedup.ts`, `apps/extension/lib/core/dedup.test.ts` · depends: T1.1 · verify: `npm test -- core/dedup` (TC-F1-U05, TC-F1-U06)
- [x] **T1.5** [core] Core purity guard test (no browser/network globals, no outward imports) · feature: F2 · outputs: `apps/extension/lib/core/purity.test.ts` · depends: T1.1–T1.4 · verify: `npm test -- core/purity` (TC-F2-U08)

## G2 — Security & Secret Custody (F4)

- [x] **T2.1** [security] PBKDF2 + AES-GCM primitives with injected crypto · feature: F4 · outputs: `apps/extension/lib/security/crypto-key.ts`, `apps/extension/lib/security/crypto-key.test.ts` · depends: T0.1 · verify: `npm test -- security/crypto-key` (TC-F4-U01, TC-F4-U02)
- [x] **T2.2** [security] Session key holder (TTL, `storage.session` mirror, lock) · feature: F4 · outputs: `apps/extension/lib/security/key-session.ts`, `apps/extension/lib/security/key-session.test.ts` · depends: T2.1 · verify: `npm test -- security/key-session`
- [x] **T2.3** [security] Secret scrubbing for errors and logs · feature: F4 · outputs: `apps/extension/lib/security/redact.ts`, `apps/extension/lib/security/redact.test.ts` · depends: T0.1 · verify: `npm test -- security/redact` (TC-F4-U03, TC-F4-U04)
- [x] **T2.4** [security] Per-tab sliding-window rate limiter · feature: F4 · outputs: `apps/extension/lib/security/rate-limit.ts`, `apps/extension/lib/security/rate-limit.test.ts` · depends: T0.1 · verify: `npm test -- security/rate-limit` (TC-F4-U05, TC-F4-U06)
- [x] **T2.5** [security] Typed message protocol + sender guard + request caps · feature: F4 · outputs: `apps/extension/lib/messages.ts`, `apps/extension/lib/messages.test.ts` · depends: T1.1 · verify: `npm test -- messages` (TC-F4-U07, TC-F4-I01)
- [x] **T2.6** [security] Settings store with public/secret split + `toPublicPrefs` · feature: F4 · outputs: `apps/extension/lib/settings-store.ts`, `apps/extension/lib/settings-store.test.ts` · depends: T2.2, T2.5 · verify: `npm test -- settings-store` (TC-F4-I02, TC-F8-U01)
- [x] **T2.7** [security] Capture queue + AI ledger persistence (capped, content-free) · feature: F4 · outputs: `apps/extension/lib/queues.ts`, `apps/extension/lib/queues.test.ts` · depends: T2.6 · verify: `npm test -- queues` (TC-F7-U05)

## G3 — Content Codec & Confidentiality Tier (F3)

- [x] **T3.1** [codec] Codec interface + transparent implementation · feature: F3 · outputs: `apps/extension/lib/store/codec.ts`, `apps/extension/lib/store/codec.test.ts` · depends: T1.2 · verify: `npm test -- store/codec` (TC-F3-U05)
- [x] **T3.2** [codec] Vault envelope implementation (`.md.enc`, minimal `meta`) · feature: F3 · outputs: `apps/extension/lib/store/vault-codec.ts`, `apps/extension/lib/store/vault-codec.test.ts` · depends: T3.1, T2.1, T2.2 · verify: `npm test -- store/vault-codec` (TC-F3-U01…U04, TC-F3-U06)
- [x] **T3.3** [codec] Mode selection from `.omnipilot/config.json` + index-entry builder · feature: F3 · outputs: `apps/extension/lib/store/tier.ts`, `apps/extension/lib/store/tier.test.ts` · depends: T3.2 · verify: `npm test -- store/tier`
- [x] **T3.4** [codec] Codec → store integration test (vault mode leaves no body in `index.json`) · feature: F3 · outputs: `apps/extension/lib/store/tier.int.test.ts` · depends: T3.3, T5.4 · verify: `npm run test:int -- store/tier` (TC-F3-I01)

## G4 — Provider Layer & AI Client (F5)

- [x] **T4.1** [ai] Provider catalog + base-URL validation + trust rule · feature: F5 · outputs: `apps/extension/lib/providers.ts`, `apps/extension/lib/providers.test.ts` · depends: T0.1 · verify: `npm test -- providers` (TC-F5-U08, TC-F5-U09)
- [x] **T4.2** [ai] AI client bearer path + request/response mapping · feature: F5 · outputs: `apps/extension/lib/ai-client.ts`, `apps/extension/lib/ai-client.test.ts` · depends: T4.1, T2.3 · verify: `npm test -- ai-client` (TC-F5-U01, TC-F5-U07)
- [x] **T4.3** [ai] Anthropic Messages path (`x-api-key`, system hoist, `content[].text`) · feature: F5 · outputs: `apps/extension/lib/ai-client.ts` · depends: T4.2 · verify: `npm test -- ai-client` (TC-F5-U02)
- [x] **T4.4** [ai] Tolerant response parsing (nested unwrap, SSE, NDJSON, empty) · feature: F5 · outputs: `apps/extension/lib/ai-parse.ts`, `apps/extension/lib/ai-parse.test.ts` · depends: T4.2 · verify: `npm test -- ai-parse` (TC-F5-U03, TC-F5-U04, TC-F5-U05)
- [x] **T4.5** [ai] Timeout, single backoff retry, fixed error mapping · feature: F5 · outputs: `apps/extension/lib/ai-client.ts` · depends: T4.4 · verify: `npm test -- ai-client` (TC-F5-U06)
- [x] **T4.6** [ai] Catalog → client → trust-rule integration across all six providers · feature: F5 · outputs: `apps/extension/lib/providers.int.test.ts` · depends: T4.3–T4.5 · verify: `npm run test:int -- providers` (TC-F5-I01)

## G5 — GitHub Store Adapter (F6)

- [x] **T5.1** [store] Adapter contract + GitHub REST skeleton + `probeRepo` · feature: F6 · outputs: `apps/extension/lib/store/types.ts`, `apps/extension/lib/store/github-api.ts`, `apps/extension/lib/store/github-api.test.ts` · depends: T0.1 · verify: `npm test -- store/github-api` (TC-F6-U03, TC-F6-U04, TC-F6-U05)
- [x] **T5.2** [store] `readFile` / `listDir` with base64 + directory parsing · feature: F6 · outputs: `apps/extension/lib/store/github-api.ts` · depends: T5.1 · verify: `npm test -- store/github-api`
- [x] **T5.3** [store] Atomic `commitFiles` (ref → blobs → tree → commit → patch ref) + conflict retry · feature: F6 · outputs: `apps/extension/lib/store/github-api.ts` · depends: T5.2 · verify: `npm test -- store/github-api` (TC-F6-U01, TC-F6-U02, TC-F6-U06)
- [x] **T5.4** [store] `GitHubStore` wrapper: codec application, index read-modify-write in one commit, public-repo guard · feature: F6 · outputs: `apps/extension/lib/store/github-store.ts`, `apps/extension/lib/store/github-store.test.ts` · depends: T5.3, T3.2 · verify: `npm test -- store/github-store` (TC-F8-U03)
- [x] **T5.5** [store] Store integration: commit through codec, one commit per capture · feature: F6 · outputs: `apps/extension/lib/store/github-store.int.test.ts` · depends: T5.4 · verify: `npm run test:int -- store/github-store` (TC-F6-I01)
- [x] **T5.6** [store] Error classifier shared by store and UI · feature: F6 · outputs: `apps/extension/lib/store/errors.ts`, `apps/extension/lib/store/errors.test.ts` · depends: T5.1 · verify: `npm test -- store/errors` (TC-F8-U04)

## G6 — Capture Pipeline (F1)

- [x] **T6.1** [capture] 正文提取 (block score, penalty, `og:`/meta fallbacks) · feature: F1 · outputs: `apps/extension/lib/capture/extract.ts`, `apps/extension/lib/capture/extract.test.ts` · depends: T0.1 · verify: `npm test -- capture/extract` (TC-F1-U01, TC-F1-U02, TC-F1-U03)
- [x] **T6.2** [capture] Selection capture with paragraph context · feature: F1 · outputs: `apps/extension/lib/capture/extract.ts` · depends: T6.1 · verify: `npm test -- capture/extract` (TC-F1-U04)
- [x] **T6.3** [capture] Body normalization + 512 KB cap + `truncated` metadata · feature: F1 · outputs: `apps/extension/lib/capture/normalize.ts`, `apps/extension/lib/capture/normalize.test.ts` · depends: T6.1 · verify: `npm test -- capture/normalize` (TC-F1-U07)
- [x] **T6.4** [capture] Capture service: dedup probe → CKF → codec → store → queue on failure · feature: F1 · outputs: `apps/extension/lib/capture/service.ts`, `apps/extension/lib/capture/service.int.test.ts` · depends: T6.3, T5.4, T2.7 · verify: `npm run test:int -- capture/service` (TC-F1-I01, TC-F1-I02)
- [x] **T6.5** [capture] Background entrypoint: router, context menus, commands, rate limits, error boundary · feature: F1 · outputs: `apps/extension/entrypoints/background.ts` · depends: T6.4, T2.5, T2.4 · verify: `npm run build` succeeds and `npm run assert:content` passes
- [x] **T6.6** [capture] Content script: selection bubble + capture panel + public-prefs subscription · feature: F1 · outputs: `apps/extension/entrypoints/content.ts`, `apps/extension/entrypoints/content.css` · depends: T6.5 · verify: `npm run build && npm run assert:content`
- [x] **T6.7** [capture] Offline queue flush + "稍后处理" retry path · feature: F1 · outputs: `apps/extension/lib/capture/service.ts` · depends: T6.4 · verify: `npm run test:int -- capture/service`

## G7 — Distillation & Authorization Ledger (F7)

- [x] **T7.1** [distill] Structured distill prompt builder · feature: F7 · outputs: `apps/extension/lib/distill.ts`, `apps/extension/lib/distill.test.ts` · depends: T1.1 · verify: `npm test -- distill` (TC-F7-U01)
- [x] **T7.2** [distill] Result parsing: fence strip, balanced-JSON scan, schema validation, point bounds · feature: F7 · outputs: `apps/extension/lib/distill.ts` · depends: T7.1, T1.1 · verify: `npm test -- distill` (TC-F7-U02, TC-F7-U03, TC-F7-U04, TC-F7-U06)
- [x] **T7.3** [distill] Authorization gates + ledger write (no fetch when unauthorized) · feature: F7 · outputs: `apps/extension/lib/distill-service.ts`, `apps/extension/lib/distill-service.test.ts` · depends: T7.2, T2.7, T4.2 · verify: `npm test -- distill-service` (TC-F7-U05)
- [x] **T7.4** [distill] Pending-card commit under `cards/pending/` with evidence links · feature: F7 · outputs: `apps/extension/lib/distill-service.ts` · depends: T7.3, T5.4 · verify: `npm run test:int -- distill-service` (TC-F7-I01)
- [x] **T7.5** [distill] Wire `DISTILL_REQUEST` into the background router · feature: F7 · outputs: `apps/extension/entrypoints/background.ts` · depends: T7.4, T6.5 · verify: `npm run build`

## G8 — UI Surfaces (F8)

- [x] **T8.1** [ui] Popup layout + styles · feature: F8 · outputs: `apps/extension/entrypoints/popup/index.html`, `apps/extension/entrypoints/popup/style.css` · depends: T0.3 · verify: `npm run build` produces `popup.html`
- [x] **T8.2** [ui] Popup logic: master switch, clip buttons, live status, recent Inbox, 提炼 action · feature: F8 · outputs: `apps/extension/entrypoints/popup/main.ts` · depends: T8.1, T6.5, T7.5 · verify: `npm run build && npm run assert:content` (TC-F8-U01, TC-F8-U02)
- [x] **T8.3** [ui] Options layout: 模型 / 存储 / 安全 / AI 授权 / 数据 sections · feature: F8 · outputs: `apps/extension/entrypoints/options/index.html`, `apps/extension/entrypoints/options/style.css` · depends: T0.3 · verify: `npm run build` produces `options.html`
- [x] **T8.4** [ui] Options logic: provider config, model datalist, trust acknowledgement, runtime permission request · feature: F8 · outputs: `apps/extension/entrypoints/options/providers.ts` · depends: T8.3, T4.1 · verify: `npm run build && npm run assert:content` (TC-F5-U09)
- [x] **T8.5** [ui] Options logic: GitHub config, probe, visibility warning + typed confirmation, vault setup/unlock · feature: F8 · outputs: `apps/extension/entrypoints/options/storage.ts`, `apps/extension/entrypoints/options/security.ts` · depends: T8.3, T5.4, T2.6 · verify: `npm run test:int -- options` (TC-F8-I01)
- [x] **T8.6** [ui] Options logic: AI authorization ledger view + export/reset data · feature: F8 · outputs: `apps/extension/entrypoints/options/main.ts` · depends: T8.5, T7.3 · verify: `npm run build && npm run assert:content`

## G9 — Release & Verification (F9)

- [x] **T9.1** [release] Secret-scan build assertion + tests · feature: F9 · outputs: `apps/extension/scripts/assert-content-no-secrets.mjs`, `apps/extension/lib/tooling/secret-scan.ts`, `apps/extension/lib/tooling/secret-scan.test.ts` · depends: T0.1 · verify: `npm test -- tooling/secret-scan` (TC-F9-U01, TC-F9-U02)
- [x] **T9.2** [release] Pack script + argument parser + tests · feature: F9 · outputs: `apps/extension/scripts/pack.mjs`, `apps/extension/lib/tooling/pack-args.ts`, `apps/extension/lib/tooling/pack-args.test.ts` · depends: T0.1 · verify: `npm test -- tooling/pack-args` (TC-F9-U03)
- [x] **T9.3** [release] Manifest finalization + command/context-menu registration + optional host permissions · feature: F9 · outputs: `apps/extension/wxt.config.ts`, `apps/extension/entrypoints/background.ts` · depends: T6.5, T8.2 · verify: `npm run build` and inspect `.output/chrome-mv3/manifest.json` for the exact permission set
- [x] **T9.4** [release] CI workflow · feature: F9 · outputs: `.github/workflows/ci.yml` · depends: T9.1, T9.2 · verify: `npm run ci` passes locally (mirrors the workflow steps)
- [x] **T9.5** [release] E2E specs with extension loading + GitHub route interception · feature: F9 · outputs: `apps/extension/e2e/smoke.spec.ts`, `apps/extension/e2e/clip.spec.ts`, `apps/extension/e2e/distill.spec.ts`, `apps/extension/playwright.config.ts`, `apps/extension/e2e/fixtures/*.html` · depends: T9.3, T8.2, T7.5 · verify: `npm run test:e2e` (TC-E2E-01, TC-E2E-02, TC-E2E-03)
- [x] **T9.6** [release] README + security model + store setup docs · feature: F9 · outputs: `README.md`, `docs/extension-setup.md` · depends: T9.4 · verify: manual read-through; links resolve

## Traceability (Task ↔ Feature ↔ TC)

| Feature | Tasks | UNIT | INT | E2E | SMK |
|---------|-------|------|-----|-----|-----|
| F1 Capture & Extraction | T6.1–T6.7 | TC-F1-U01…U07 | TC-F1-I01, I02 | TC-E2E-01, 02 | TC-SMK-02 |
| F2 Canonical Core | T1.1–T1.5 | TC-F2-U01…U08 (U05/U06 via T1.4) | TC-F2-I01 | — | — |
| F3 Content Codec & Tier | T3.1–T3.4 | TC-F3-U01…U06 | TC-F3-I01 | — | — |
| F4 Security & Secret Custody | T2.1–T2.7 | TC-F4-U01…U07 | TC-F4-I01, I02 | — | TC-SMK-01 |
| F5 Provider Layer & AI Client | T4.1–T4.6 | TC-F5-U01…U09 | TC-F5-I01 | — | — |
| F6 GitHub Store Adapter | T5.1–T5.6 | TC-F6-U01…U06 | TC-F6-I01 | — | — |
| F7 Distillation & Ledger | T7.1–T7.5 | TC-F7-U01…U06 | TC-F7-I01 | TC-E2E-03 | — |
| F8 UI Surfaces | T0.3, T8.1–T8.6 | TC-F8-U01…U05 | TC-F8-I01 | TC-E2E-01, 03 | TC-SMK-03 |
| F9 Build, Tooling & Release | T0.1, T0.2, T0.4, T9.1–T9.6 | TC-F9-U01…U03 | — | — | TC-SMK-01 |

## Mid-Phase Gates (B.15, complexity L)

| Gate | Trigger | Rule |
|------|---------|------|
| `pre_dev` | Before T0.1 (Phase 3 entry) | **Hard gate** — explicit confirmation required before any implementation |
| `change_impact` | After each group (G0…G9) | Summarize what changed vs `04-design.md`; confirm continue |
| Security audit | Phase 3 exit | B.22 — blocks Phase 4 until PASS or WAIVED |
| `checkpoint` | Phase 3 exit | Handoff to Phase 4 (Testing) |

## Notes

- **No task may be marked `[x]` without its `verify:` command having been run in this session** with
  the result recorded in `03-progress.md` as `verify: [command → result]` (spec-driven §7).
- Greenfield + `spec_mode_active: true` → every implementation task follows RED → GREEN → REFACTOR;
  the mapped TC's test is written and observed failing before the implementation exists.
- `TC-F5-I01` is intentionally scoped to catalog→client→trust rules; the cross-feature
  provider→distill→store path is covered once by `TC-F7-I01`.
<!-- END SNAPSHOT -->

---

## [ARCHIVE] 02-plan.md · v2 · 2026-09-29 16:30

---
version: 2
previous_version: 1
artifact: 02-plan.md
requirement_id: req-2026-07-09-synapse-git-sync
complexity: L
complexity_effective: XL
total_tasks: 46
groups: 9
last_updated: 2026-07-09T00:00:00+08:00
history_ref: 02-plan-history.md
---

# Plan: GitHub 双授权 · 双向自动同步 · 仓库内可读检索

**Build order**: foundations → auth → companion → sync → search → UI → layout → tooling → verification.
`[pkg:extension]` tasks run in `apps/extension`, `[pkg:git-bridge]` in `apps/git-bridge`,
`[pkg:both]` at the repo root. Every `verify:` command is runnable from the stated directory.

**Traceability**: every task names its feature (`F1`–`F7`) and the TC-IDs it must satisfy
(`05-test-plan.md`). A task may not be marked `[x]` without its verification command having been run in
this session (spec-driven §7).

## Task Groups

| Group | Theme | Feature | Pkg | Tasks | Depends |
|-------|-------|---------|-----|-------|---------|
| G0 | Foundations | — | extension | T0.1–T0.4 | — |
| G1 | GitAuth abstraction | F1 | extension | T1.1–T1.6 | G0 |
| G2 | Companion host | F2 | git-bridge | T2.1–T2.6 | — |
| G3 | Native messaging client | F2 | extension | T3.1–T3.4 | G2 (protocol) |
| G4 | Sync engine | F3 | extension | T4.1–T4.9 | G1, G3 |
| G5 | Search & retrieval | F4 | extension | T5.1–T5.7 | G0 |
| G6 | UI surfaces | F5 | extension | T6.1–T6.6 | G1, G4, G5 |
| G7 | Layout & migration safety | F6 | extension | T7.1–T7.4 | G0, G4 |
| G8 | Tooling, packaging, CI | F7 | both | T8.1–T8.4 | G2, G6 |
| G9 | Verification (E2E) | all | extension | T9.1–T9.2 | all |

## G0 — Foundations `[pkg:extension]`

- [ ] **T0.1** [settings] Extend `ExtensionSettings`: `authMode`, `ssh`, `syncPolicy`, `defaultTier` · feature: — · outputs: `apps/extension/lib/settings-store.ts` · depends: — · verify: `npx vitest run lib/settings-store.test.ts` (existing suite still green after the shape change)
- [ ] **T0.2** [settings] Extend `PublicPrefs` + projection with auth/branch/sync/companion state · feature: — · outputs: `apps/extension/lib/public-prefs.ts`, `apps/extension/lib/settings-store.ts` · depends: T0.1 · verify: `npx vitest run lib/settings-store.test.ts lib/public-prefs.test.ts` and assert no secret key is reachable (TC-F8-U01 carries over)
- [ ] **T0.3** [messages] Extend `ErrorCode` (+ `nativeUnavailable`, `protocolMismatch`, `syncConflict`, `indexUnavailable`) and add the new request types (`sync.now`, `sync.status`, `sync.policy`, `search.query`, `search.rebuild`, `auth.probe`, `native.status`) with validators · feature: — · outputs: `apps/extension/lib/messages.ts` · depends: — · verify: `npx vitest run lib/messages.test.ts`
- [ ] **T0.4** [i18n] Add the new dictionaries keys (both languages) · feature: F5 · outputs: `apps/extension/lib/i18n.ts` · depends: — · verify: `npx vitest run lib/i18n.test.ts` (parity test)

## G1 — GitAuth Abstraction (F1) `[pkg:extension]`

- [ ] **T1.1** [auth] `GitAuth` contract + descriptor types · feature: F1 · outputs: `apps/extension/lib/auth/types.ts` · depends: T0.1 · verify: `npx tsc --noEmit`
- [ ] **T1.2** [auth] `TokenAuth`: reuse the REST store path, assert readiness from the vault · feature: F1 · outputs: `apps/extension/lib/auth/token-auth.ts` · depends: T1.1 · verify: `npx vitest run lib/auth/token-auth.test.ts` (TC-F1-U01, U02)
- [ ] **T1.3** [auth] `SshAuth`: descriptor only, no key material; readiness delegated to the companion · feature: F1 · outputs: `apps/extension/lib/auth/ssh-auth.ts` · depends: T1.1, T3.1 · verify: `npx vitest run lib/auth/ssh-auth.test.ts` (TC-F1-U05, U07, U08)
- [ ] **T1.4** [auth] `resolveAuth`: mode selection + three degradation reasons, never throws for absence · feature: F1 · outputs: `apps/extension/lib/auth/resolve.ts` · depends: T1.2, T1.3 · verify: `npx vitest run lib/auth/resolve.test.ts` (TC-F1-U03, U04, U06)
- [ ] **T1.5** [auth] `GitTransportStore`: `KnowledgeStore` over the companion (`git.*` ops) · feature: F1 · outputs: `apps/extension/lib/store/git-transport.ts` · depends: T1.3, T3.2 · verify: `npx vitest run --config vitest.int.config.ts lib/store/git-transport.int.test.ts` (TC-F1-I02)
- [ ] **T1.6** [auth] Wire `auth.probe` + `store.probe` through `resolveAuth` in the handlers · feature: F1 · outputs: `apps/extension/lib/background/handlers.ts` · depends: T1.4, T1.5 · verify: `npx vitest run --config vitest.int.config.ts lib/background` (TC-F1-I01)

## G2 — Companion Host (F2) `[pkg:git-bridge]`

- [ ] **T2.1** [bridge] Package scaffold: `package.json`, `tsconfig.json`, vitest config, build to `dist/` · feature: F2 · outputs: `apps/git-bridge/{package.json,tsconfig.json,vitest.config.ts}` · depends: — · verify: `npm --prefix apps/git-bridge install && npm --prefix apps/git-bridge run build`
- [ ] **T2.2** [bridge] Wire protocol: framing, version handshake, request/response envelope · feature: F2 · outputs: `apps/git-bridge/src/protocol.ts` · depends: T2.1 · verify: `npm --prefix apps/git-bridge test` (TC-F2-U01, U02, U10)
- [ ] **T2.3** [bridge] Op allow-list + path confinement + argument safety · feature: F2 · outputs: `apps/git-bridge/src/guard.ts` · depends: T2.2 · verify: `npm --prefix apps/git-bridge test` (TC-F2-U03…U08)
- [ ] **T2.4** [bridge] `git` wrapper via `execFile` only, with the hardened config flags · feature: F2 · outputs: `apps/git-bridge/src/git.ts` · depends: T2.3 · verify: `npm --prefix apps/git-bridge test` (TC-F2-U06, U08 unit-level)
- [ ] **T2.5** [bridge] `key.list` (identifiers only) and `main` stdio loop · feature: F2 · outputs: `apps/git-bridge/src/{keys.ts,main.ts}` · depends: T2.4 · verify: `npm --prefix apps/git-bridge test` (TC-F2-U09)
- [ ] **T2.6** [bridge] SYS suite against a temp bare repository · feature: F2 · outputs: `apps/git-bridge/test/sys/*.sys.test.ts` · depends: T2.5 · verify: `npm --prefix apps/git-bridge run test:sys` (TC-F2-S01…S08)

## G3 — Native Messaging Client (F2) `[pkg:extension]`

- [ ] **T3.1** [native] Extension-side protocol mirror + runtime response narrowing · feature: F2 · outputs: `apps/extension/lib/native/protocol.ts` · depends: T2.2 · verify: `npx vitest run lib/native/protocol.test.ts`
- [ ] **T3.2** [native] `NativeClient`: connect, handshake, correlation, timeouts, reconnect-once, cached availability · feature: F2 · outputs: `apps/extension/lib/native/client.ts` · depends: T3.1 · verify: `npx vitest run --config vitest.int.config.ts lib/native/client.int.test.ts` (fake duplex host; TC-F2-I01)
- [ ] **T3.3** [native] Refuse non-allow-listed ops on the extension side too (defence in depth) · feature: F2 · outputs: `apps/extension/lib/native/protocol.ts` · depends: T3.1 · verify: `npx vitest run lib/native/protocol.test.ts` (TC-F2-I02)
- [ ] **T3.4** [native] Manifest `nativeMessaging` + content-bundle assertion extension · feature: F2 · outputs: `apps/extension/wxt.config.ts`, `apps/extension/scripts/assert-content-no-secrets.mjs` · depends: T3.3 · verify: `npm run build && npm run assert:content` (TC-SMK-02)

## G4 — Sync Engine (F3) `[pkg:extension]`

- [ ] **T4.1** [sync] `reconcile.ts`: pure `planMerge` with all five cases + conflict naming · feature: F3 · outputs: `apps/extension/lib/sync/reconcile.ts` · depends: T0.3 · verify: `npx vitest run lib/sync/reconcile.test.ts` (TC-F3-U01…U07)
- [ ] **T4.2** [sync] IndexedDB cache (`records`, `dirty`) with a storage.local `syncState` · feature: F3 · outputs: `apps/extension/lib/sync/cache.ts` · depends: T0.1 · verify: `npx vitest run lib/sync/cache.test.ts` (fake-indexeddb)
- [ ] **T4.3** [sync] Remote head + changed-path diffing for the REST transport · feature: F3 · outputs: `apps/extension/lib/store/github-api.ts` · depends: — · verify: `npx vitest run lib/store/github-api.test.ts` (tree/compare helpers)
- [ ] **T4.4** [sync] Pull: incremental blob fetch, decode, cache, re-index (locked-vault abort first) · feature: F3 · outputs: `apps/extension/lib/sync/engine.ts` · depends: T4.1, T4.2, T4.3 · verify: `npx vitest run lib/sync/engine.test.ts` (TC-F3-U08, U10, U11, U12)
- [ ] **T4.5** [sync] Push: dirty set → one commit (REST) / `git commit` + `git push` (companion) · feature: F3 · outputs: `apps/extension/lib/sync/engine.ts` · depends: T4.4, T1.5 · verify: `npx vitest run --config vitest.int.config.ts lib/sync/engine.int.test.ts` (TC-F3-I03, I04)
- [ ] **T4.6** [sync] Triggers: startup, after capture, `chrome.alarms` interval, unlock, manual + coalescing · feature: F3 · outputs: `apps/extension/lib/sync/triggers.ts` · depends: T4.4 · verify: `npx vitest run lib/sync/triggers.test.ts` (TC-F3-U09, I06)
- [ ] **T4.7** [sync] Sync handlers (`sync.now`, `sync.status`, `sync.policy`) + router wiring · feature: F3 · outputs: `apps/extension/lib/background/handlers.ts` · depends: T4.5, T4.6 · verify: `npx vitest run --config vitest.int.config.ts lib/background` (TC-F5-I01, I02)
- [ ] **T4.8** [sync] Delete handling + resurrection policy · feature: F3 · outputs: `apps/extension/lib/sync/engine.ts` · depends: T4.4 · verify: `npx vitest run --config vitest.int.config.ts lib/sync/engine.int.test.ts` (TC-F3-I07, TC-F3-U06)
- [ ] **T4.9** [sync] Dirty-set persistence after a transient failure (queue reuse) · feature: F3 · outputs: `apps/extension/lib/sync/engine.ts`, `apps/extension/lib/queues.ts` · depends: T4.5 · verify: `npx vitest run --config vitest.int.config.ts lib/sync/engine.int.test.ts` (TC-F3-I05)

## G5 — Search & Retrieval (F4) `[pkg:extension]`

- [ ] **T5.1** [search] Tokenizer: reuse the dedup rules, add CJK bigrams · feature: F4 · outputs: `apps/extension/lib/search/tokenize.ts` · depends: — · verify: `npx vitest run lib/search/tokenize.test.ts`
- [ ] **T5.2** [search] Postings: add/remove, shard key, truncation marker · feature: F4 · outputs: `apps/extension/lib/search/postings.ts` · depends: T5.1 · verify: `npx vitest run lib/search/postings.test.ts` (TC-F4-U01…U04)
- [ ] **T5.3** [search] Query: parsing, filters, scoring, snippets · feature: F4 · outputs: `apps/extension/lib/search/query.ts` · depends: T5.2 · verify: `npx vitest run lib/search/query.test.ts` (TC-F4-U05…U10, U12)
- [ ] **T5.4** [search] `renderNotesIndex` + content-hash guard · feature: F4 · outputs: `apps/extension/lib/search/docs.ts` · depends: — · verify: `npx vitest run lib/search/docs.test.ts` (TC-F4-U11)
- [ ] **T5.5** [search] Index orchestration: upsert/remove/query/rebuild from cache or repository · feature: F4 · outputs: `apps/extension/lib/search/index.ts` · depends: T5.2, T5.3, T4.2 · verify: `npx vitest run --config vitest.int.config.ts lib/search/index.int.test.ts` (TC-F4-I03)
- [ ] **T5.6** [search] Handlers `search.query` / `search.rebuild` · feature: F4 · outputs: `apps/extension/lib/background/handlers.ts` · depends: T5.5 · verify: `npx vitest run --config vitest.int.config.ts lib/background` (TC-F4-I01)
- [ ] **T5.7** [search] Commit the note and its shard together (single commit) · feature: F4 · outputs: `apps/extension/lib/sync/engine.ts` · depends: T5.5, T4.5 · verify: `npx vitest run --config vitest.int.config.ts lib/search/index.int.test.ts` (TC-F4-I02)

## G6 — UI Surfaces (F5) `[pkg:extension]`

- [ ] **T6.1** [ui] `lib/ui/auth-form.ts`: pure form model, validation, mode options, companion status, branch notice · feature: F5 · outputs: `apps/extension/lib/ui/auth-form.ts` · depends: T0.4, T1.4 · verify: `npx vitest run lib/ui/auth-form.test.ts` (TC-F5-U01, U02, U04, U06, U07)
- [ ] **T6.2** [ui] Options → 存储: auth-mode picker + SSH section + companion install hint · feature: F5 · outputs: `apps/extension/entrypoints/options/*` · depends: T6.1 · verify: `npm run build && npm run assert:content`
- [ ] **T6.3** [ui] Options → 存储: branch field + `检查分支` action (exists / create) · feature: F5 · outputs: `apps/extension/entrypoints/options/*`, `apps/extension/lib/background/handlers.ts` · depends: T6.2 · verify: `npx vitest run lib/ui/auth-form.test.ts` (TC-F5-U05)
- [ ] **T6.4** [ui] Options → 同步与检索 section: status, conflicts + resolution actions, manual sync, rebuild · feature: F5 · outputs: `apps/extension/entrypoints/options/*` · depends: T4.7, T5.6 · verify: `npx vitest run lib/ui/render.test.ts`
- [ ] **T6.5** [ui] Popup: auth/branch row, sync row, 立即同步, search box + results · feature: F5 · outputs: `apps/extension/entrypoints/popup/*` · depends: T6.4 · verify: `npx vitest run lib/ui/render.test.ts` (TC-F5-U03)
- [ ] **T6.6** [ui] Status projection without secrets + parity check · feature: F5 · outputs: `apps/extension/lib/status.ts`, `apps/extension/lib/ui/format.ts` · depends: T6.5 · verify: `npx vitest run lib/status.test.ts` (TC-F5-U03, U08)

## G7 — Layout & Migration Safety (F6) `[pkg:extension]`

- [ ] **T7.1** [layout] `resolveTier`: recorded mode wins; unknown → ask, never guess · feature: F6 · outputs: `apps/extension/lib/store/tier.ts` · depends: T0.1 · verify: `npx vitest run lib/store/tier.test.ts` (TC-F6-U02…U04)
- [ ] **T7.2** [layout] Default tier flip to `transparent` for a new store · feature: F6 · outputs: `apps/extension/lib/settings-store.ts` · depends: T7.1 · verify: `npx vitest run lib/settings-store.test.ts` (TC-F6-U01)
- [ ] **T7.3** [layout] `.omnipilot/config.json` gains `branch`, `sync_policy`, `client_version` · feature: F6 · outputs: `apps/extension/lib/store/tier.ts` · depends: T7.1 · verify: `npx vitest run --config vitest.int.config.ts lib/store/tier.int.test.ts` (TC-F6-I02, I03)
- [ ] **T7.4** [layout] 0.1.0 repository compatibility + existing-store regression · feature: F6 · outputs: `apps/extension/lib/store/tier.ts`, `apps/extension/lib/store/github-store.ts` · depends: T7.3 · verify: `npx vitest run --config vitest.int.config.ts lib/store` (TC-F6-U05, I01, TC-REG-ext-store-01)

## G8 — Tooling, Packaging, CI (F7) `[pkg:both]`

- [ ] **T8.1** [tooling] Native-host manifest template per OS + installer script · feature: F7 · outputs: `apps/git-bridge/native-host/{manifest.template.json,install.mjs}` · depends: T2.6 · verify: `node apps/git-bridge/native-host/install.mjs --dry-run` (TC-F7-U01, U02)
- [ ] **T8.2** [tooling] Companion packaging: single-file bundle per OS into `.output/` · feature: F7 · outputs: `apps/git-bridge/scripts/pack.mjs`, `deploy/pack/deploy.sh` · depends: T8.1 · verify: `npm --prefix apps/git-bridge run pack -- --skip-test --dry-run`
- [ ] **T8.3** [tooling] Deploy scripts gain a `companion` mode + install docs · feature: F7 · outputs: `deploy/deploy.sh`, `deploy/pack/deploy.sh`, `deploy/README.md` · depends: T8.2 · verify: `bash deploy/deploy.sh all --dry-run` and `bash deploy/deploy.sh companion --dry-run`
- [ ] **T8.4** [tooling] CI: build + test both packages, SYS suite, E2E, xvfb · feature: F7 · outputs: `.github/workflows/ci.yml` · depends: T8.3 · verify: `npm run ci` locally mirrors the workflow

## G9 — Verification (E2E) `[pkg:extension]`

- [ ] **T9.1** [e2e] "Remote drift" helper + pull/no-op/conflict specs · feature: F3, F6 · outputs: `apps/extension/e2e/{helpers.ts,sync.spec.ts}` · depends: T4.7, T6.5 · verify: `npx playwright test e2e/sync.spec.ts` (TC-E2E-01, 04, 05)
- [ ] **T9.2** [e2e] SSH-degradation, search and readable-default specs · feature: F1, F4, F6 · outputs: `apps/extension/e2e/{auth.spec.ts,search.spec.ts}` · depends: T9.1 · verify: `npx playwright test` (TC-E2E-02, 03, 06)

## Traceability (Task ↔ Feature ↔ TC)

| Feature | Tasks | UNIT | INT | SYS | E2E |
|---------|-------|------|-----|-----|-----|
| F1 GitAuth | T1.1–T1.6 | TC-F1-U01…U08 | TC-F1-I01, I02 | — | TC-E2E-02 |
| F2 Native + companion | T2.1–T2.6, T3.1–T3.4 | TC-F2-U01…U10 | TC-F2-I01…I03 | TC-F2-S01…S08 | TC-E2E-02 |
| F3 Sync engine | T4.1–T4.9 | TC-F3-U01…U12 | TC-F3-I01…I07 | — | TC-E2E-01, 04, 05 |
| F4 Search | T5.1–T5.7 | TC-F4-U01…U12 | TC-F4-I01…I03 | — | TC-E2E-03 |
| F5 UI | T6.1–T6.6 | TC-F5-U01…U08 | TC-F5-I01, I02 | — | TC-E2E-03 |
| F6 Layout | T7.1–T7.4 | TC-F6-U01…U06 | TC-F6-I01…I03 | — | TC-E2E-06 |
| F7 Tooling | T8.1–T8.4 | TC-F7-U01, U02 | — | — | — |

## Mid-Phase Gates (B.15)

| Gate | Trigger | Rule |
|------|---------|------|
| `pre_dev` | Before T0.1 | **Hard gate** — scope is XL; explicit confirmation required |
| `change_impact` | After each group | Auto-confirm under autopilot unless the diff departs from `04-design.md` |
| Security audit | Phase 3 exit | B.22 — new privileged boundary (the companion) must pass |
| `checkpoint` | Phase 3 exit | Handoff to Phase 4 |

## Notes

- **Highest-risk tasks first inside each group**: T2.3/T2.4 (the companion's privilege boundary) and
  T4.1/T4.4 (merge correctness) get their tests written before the implementation (TDD).
- The two spiking assumptions from the blueprint (A2 `connectNative` in an MV3 worker, A5 IndexedDB in
  a worker) are settled by T3.2 and T4.2 respectively; if either fails, stop and re-plan rather than
  working around it silently.
- Nothing in this plan touches an existing user's repository without an explicit tier/branch check
  (T7.1–T7.4).

## [ARCHIVE] 02-plan.md · v3 · 2026-09-29T18:10:00+08:00

---
version: 3
previous_version: 2
artifact: 02-plan.md
requirement_id: req-2026-07-09-synapse-git-sync
complexity: L
complexity_effective: XL
total_tasks: 50
groups: 9
last_updated: 2026-09-29T16:30:00+08:00
history_ref: 02-plan-history.md
revision_note: >-
  v3 (2026-09-29) adds the companion content channel (T2.7-T2.9, T3.5) after the audit found the ssh
  transport could neither push nor pull note content. Approved at the change_confirm gate; supersedes
  the read-only reading of T1.5.
---

# Plan: GitHub 双授权 · 双向自动同步 · 仓库内可读检索

**Build order**: foundations → auth → companion → sync → search → UI → layout → tooling → verification.
`[pkg:extension]` tasks run in `apps/extension`, `[pkg:git-bridge]` in `apps/git-bridge`,
`[pkg:both]` at the repo root. Every `verify:` command is runnable from the stated directory.

**Traceability**: every task names its feature (`F1`–`F7`) and the TC-IDs it must satisfy
(`05-test-plan.md`). A task may not be marked `[x]` without its verification command having been run in
this session (spec-driven §7).

## Task Groups

| Group | Theme | Feature | Pkg | Tasks | Depends |
|-------|-------|---------|-----|-------|---------|
| G0 | Foundations | — | extension | T0.1–T0.4 | — |
| G1 | GitAuth abstraction | F1 | extension | T1.1–T1.6 | G0 |
| G2 | Companion host | F2 | git-bridge | T2.1–T2.6 | — |
| G3 | Native messaging client | F2 | extension | T3.1–T3.4 | G2 (protocol) |
| G4 | Sync engine | F3 | extension | T4.1–T4.9 | G1, G3 |
| G5 | Search & retrieval | F4 | extension | T5.1–T5.7 | G0 |
| G6 | UI surfaces | F5 | extension | T6.1–T6.6 | G1, G4, G5 |
| G7 | Layout & migration safety | F6 | extension | T7.1–T7.4 | G0, G4 |
| G8 | Tooling, packaging, CI | F7 | both | T8.1–T8.4 | G2, G6 |
| G9 | Verification (E2E) | all | extension | T9.1–T9.2 | all |

## G0 — Foundations `[pkg:extension]`

- [x] **T0.1** [settings] Extend `ExtensionSettings`: `authMode`, `ssh`, `syncPolicy`, `defaultTier` · feature: — · outputs: `apps/extension/lib/settings-store.ts` · depends: — · verify: `npx vitest run lib/settings-store.test.ts` (existing suite still green after the shape change)
- [x] **T0.2** [settings] Extend `PublicPrefs` + projection with auth/branch/sync/companion state · feature: — · outputs: `apps/extension/lib/public-prefs.ts`, `apps/extension/lib/settings-store.ts` · depends: T0.1 · verify: `npx vitest run lib/settings-store.test.ts lib/public-prefs.test.ts` and assert no secret key is reachable (TC-F8-U01 carries over)
- [x] **T0.3** [messages] Extend `ErrorCode` (+ `nativeUnavailable`, `protocolMismatch`, `syncConflict`, `indexUnavailable`) and add the new request types (`sync.now`, `sync.status`, `sync.policy`, `search.query`, `search.rebuild`, `auth.probe`, `native.status`) with validators · feature: — · outputs: `apps/extension/lib/messages.ts` · depends: — · verify: `npx vitest run lib/messages.test.ts`
- [x] **T0.4** [i18n] Add the new dictionaries keys (both languages) · feature: F5 · outputs: `apps/extension/lib/i18n.ts` · depends: — · verify: `npx vitest run lib/i18n.test.ts` (parity test)

## G1 — GitAuth Abstraction (F1) `[pkg:extension]`

- [x] **T1.1** [auth] `GitAuth` contract + descriptor types · feature: F1 · outputs: `apps/extension/lib/auth/types.ts` · depends: T0.1 · verify: `npx tsc --noEmit`
- [x] **T1.2** [auth] `TokenAuth`: reuse the REST store path, assert readiness from the vault · feature: F1 · outputs: `apps/extension/lib/auth/token-auth.ts` · depends: T1.1 · verify: `npx vitest run lib/auth/token-auth.test.ts` (TC-F1-U01, U02)
- [x] **T1.3** [auth] `SshAuth`: descriptor only, no key material; readiness delegated to the companion · feature: F1 · outputs: `apps/extension/lib/auth/ssh-auth.ts` · depends: T1.1, T3.1 · verify: `npx vitest run lib/auth/ssh-auth.test.ts` (TC-F1-U05, U07, U08)
- [x] **T1.4** [auth] `resolveAuth`: mode selection + three degradation reasons, never throws for absence · feature: F1 · outputs: `apps/extension/lib/auth/resolve.ts` · depends: T1.2, T1.3 · verify: `npx vitest run lib/auth/resolve.test.ts` (TC-F1-U03, U04, U06)
- [x] **T1.5** [auth] `GitTransportStore`: `KnowledgeStore` over the companion (`git.*` ops) · feature: F1 · outputs: `apps/extension/lib/store/git-transport.ts` · depends: T1.3, T3.2 · verify: `npx vitest run --config vitest.int.config.ts lib/store/git-transport.int.test.ts` — **7 passed 2026-09-29** (was unbuildable until T2.7–T2.9 landed; see Revision 3) (TC-F1-I02)
- [x] **T1.6** [auth] Wire `auth.probe` + `store.probe` through `resolveAuth` in the handlers · feature: F1 · outputs: `apps/extension/lib/background/handlers.ts` · depends: T1.4, T1.5 · verify: `npx vitest run --config vitest.int.config.ts lib/background` (TC-F1-I01)

## G2 — Companion Host (F2) `[pkg:git-bridge]`

- [x] **T2.1** [bridge] Package scaffold: `package.json`, `tsconfig.json`, vitest config, build to `dist/` · feature: F2 · outputs: `apps/git-bridge/{package.json,tsconfig.json,vitest.config.ts}` · depends: — · verify: `npm --prefix apps/git-bridge install && npm --prefix apps/git-bridge run build`
- [x] **T2.2** [bridge] Wire protocol: framing, version handshake, request/response envelope · feature: F2 · outputs: `apps/git-bridge/src/protocol.ts` · depends: T2.1 · verify: `npm --prefix apps/git-bridge test` (TC-F2-U01, U02, U10)
- [x] **T2.3** [bridge] Op allow-list + path confinement + argument safety · feature: F2 · outputs: `apps/git-bridge/src/guard.ts` · depends: T2.2 · verify: `npm --prefix apps/git-bridge test` (TC-F2-U03…U08)
- [x] **T2.4** [bridge] `git` wrapper via `execFile` only, with the hardened config flags · feature: F2 · outputs: `apps/git-bridge/src/git.ts` · depends: T2.3 · verify: `npm --prefix apps/git-bridge test` (TC-F2-U06, U08 unit-level)
- [x] **T2.5** [bridge] `key.list` (identifiers only) and `main` stdio loop · feature: F2 · outputs: `apps/git-bridge/src/{keys.ts,main.ts}` · depends: T2.4 · verify: `npm --prefix apps/git-bridge test` (TC-F2-U09)
- [x] **T2.6** [bridge] SYS suite against a temp bare repository · feature: F2 · outputs: `apps/git-bridge/test/sys/*.sys.test.ts` · depends: T2.5 · verify: `npm --prefix apps/git-bridge run test:sys` (TC-F2-S01…S08)

## G3 — Native Messaging Client (F2) `[pkg:extension]`

- [x] **T3.1** [native] Extension-side protocol mirror + runtime response narrowing · feature: F2 · outputs: `apps/extension/lib/native/protocol.ts` · depends: T2.2 · verify: `npx vitest run lib/native/protocol.test.ts`
- [x] **T3.2** [native] `NativeClient`: connect, handshake, correlation, timeouts, reconnect-once, cached availability · feature: F2 · outputs: `apps/extension/lib/native/client.ts` · depends: T3.1 · verify: `npx vitest run --config vitest.int.config.ts lib/native/client.int.test.ts` (fake duplex host; TC-F2-I01)
- [x] **T3.3** [native] Refuse non-allow-listed ops on the extension side too (defence in depth) · feature: F2 · outputs: `apps/extension/lib/native/protocol.ts` · depends: T3.1 · verify: `npx vitest run lib/native/protocol.test.ts` (TC-F2-I02)
- [x] **T3.4** [native] Manifest `nativeMessaging` + content-bundle assertion extension · feature: F2 · outputs: `apps/extension/wxt.config.ts`, `apps/extension/scripts/assert-content-no-secrets.mjs` · depends: T3.3 · verify: `npm run build && npm run assert:content` — **build 0 / assert OK 2026-09-29**; permissions now `nativeMessaging` + `alarms` + `unlimitedStorage`, markers `connectNative` / `com.omnipilot.synapse.git_bridge` (TC-SMK-02)

## G4 — Sync Engine (F3) `[pkg:extension]`

- [x] **T4.1** [sync] `reconcile.ts`: pure `planMerge` with all five cases + conflict naming · feature: F3 · outputs: `apps/extension/lib/sync/reconcile.ts` · depends: T0.3 · verify: `npx vitest run lib/sync/reconcile.test.ts` (TC-F3-U01…U07)
- [x] **T4.2** [sync] IndexedDB cache (`records`, `dirty`) with a storage.local `syncState` · feature: F3 · outputs: `apps/extension/lib/sync/cache.ts` · depends: T0.1 · verify: `npx vitest run lib/sync/cache.test.ts` (fake-indexeddb)
- [x] ~~**T4.3**~~ [sync] Remote head + changed-path diffing for the REST transport · feature: F3 · outputs: `apps/extension/lib/store/github-api.ts` · depends: — · verify: `npx vitest run lib/store/github-api.test.ts` (tree/compare helpers)
- [x] **T4.4** [sync] Pull: incremental blob fetch, decode, cache, re-index (locked-vault abort first) · feature: F3 · outputs: `apps/extension/lib/sync/engine.ts` · depends: T4.1, T4.2, T4.3 · verify: `npx vitest run lib/sync/engine.test.ts` (TC-F3-U08, U10, U11, U12)
- [x] **T4.5** [sync] Push: dirty set → one commit (REST) / `git commit` + `git push` (companion) · feature: F3 · outputs: `apps/extension/lib/sync/engine.ts` · depends: T4.4, T1.5 · verify: `npx vitest run --config vitest.int.config.ts lib/sync/engine.int.test.ts` (TC-F3-I03, I04)
- [x] **T4.6** [sync] Triggers: startup, after capture, `chrome.alarms` interval, unlock, manual + coalescing · feature: F3 · outputs: `apps/extension/lib/sync/triggers.ts` · depends: T4.4 · verify: `npx vitest run lib/sync/triggers.test.ts` (TC-F3-U09, I06)
- [x] **T4.7** [sync] Sync handlers (`sync.now`, `sync.status`, `sync.policy`) + router wiring · feature: F3 · outputs: `apps/extension/lib/background/handlers.ts` · depends: T4.5, T4.6 · verify: `npx vitest run --config vitest.int.config.ts lib/background` (TC-F5-I01, I02)
- [x] **T4.8** [sync] Delete handling + resurrection policy · feature: F3 · outputs: `apps/extension/lib/sync/engine.ts` · depends: T4.4 · verify: `npx vitest run --config vitest.int.config.ts lib/sync/engine.int.test.ts` (TC-F3-I07, TC-F3-U06)
- [x] **T4.9** [sync] Dirty-set persistence after a transient failure (queue reuse) · feature: F3 · outputs: `apps/extension/lib/sync/engine.ts`, `apps/extension/lib/queues.ts` · depends: T4.5 · verify: `npx vitest run --config vitest.int.config.ts lib/sync/engine.int.test.ts` (TC-F3-I05)

## G5 — Search & Retrieval (F4) `[pkg:extension]`

- [x] **T5.1** [search] Tokenizer: reuse the dedup rules, add CJK bigrams · feature: F4 · outputs: `apps/extension/lib/search/tokenize.ts` · depends: — · verify: `npx vitest run lib/search/tokenize.test.ts`
- [x] **T5.2** [search] Postings: add/remove, shard key, truncation marker · feature: F4 · outputs: `apps/extension/lib/search/postings.ts` · depends: T5.1 · verify: `npx vitest run lib/search/postings.test.ts` (TC-F4-U01…U04)
- [x] **T5.3** [search] Query: parsing, filters, scoring, snippets · feature: F4 · outputs: `apps/extension/lib/search/query.ts` · depends: T5.2 · verify: `npx vitest run lib/search/query.test.ts` (TC-F4-U05…U10, U12)
- [x] **T5.4** [search] `renderNotesIndex` + content-hash guard · feature: F4 · outputs: `apps/extension/lib/search/docs.ts` · depends: — · verify: `npx vitest run lib/search/docs.test.ts` (TC-F4-U11)
- [x] **T5.5** [search] Index orchestration: upsert/remove/query/rebuild from cache or repository · feature: F4 · outputs: `apps/extension/lib/search/index.ts` · depends: T5.2, T5.3, T4.2 · verify: `npx vitest run --config vitest.int.config.ts lib/search/index.int.test.ts` (TC-F4-I03)
- [x] **T5.6** [search] Handlers `search.query` / `search.rebuild` · feature: F4 · outputs: `apps/extension/lib/background/handlers.ts` · depends: T5.5 · verify: `npx vitest run --config vitest.int.config.ts lib/background` (TC-F4-I01)
- [x] **T5.7** [search] Commit the note and its shard together (single commit) · feature: F4 · outputs: `apps/extension/lib/sync/engine.ts` · depends: T5.5, T4.5 · verify: `npx vitest run --config vitest.int.config.ts lib/search/index.int.test.ts` (TC-F4-I02)

## G6 — UI Surfaces (F5) `[pkg:extension]`

- [x] **T6.1** [ui] `lib/ui/auth-form.ts`: pure form model, validation, mode options, companion status, branch notice · feature: F5 · outputs: `apps/extension/lib/ui/auth-form.ts` · depends: T0.4, T1.4 · verify: `npx vitest run lib/ui/auth-form.test.ts` (TC-F5-U01, U02, U04, U06, U07)
- [x] **T6.2** [ui] Options → 存储: auth-mode picker + SSH section + companion install hint · feature: F5 · outputs: `apps/extension/entrypoints/options/*` · depends: T6.1 · verify: `npm run build && npm run assert:content`
- [x] **T6.3** [ui] Options → 存储: branch field + `检查分支` action (exists / create) · feature: F5 · outputs: `apps/extension/entrypoints/options/*`, `apps/extension/lib/background/handlers.ts` · depends: T6.2 · verify: `npx vitest run lib/ui/auth-form.test.ts` (TC-F5-U05)
- [x] **T6.4** [ui] Options → 同步与检索 section: status, conflicts + resolution actions, manual sync, rebuild · feature: F5 · outputs: `apps/extension/entrypoints/options/*` · depends: T4.7, T5.6 · verify: `npx vitest run lib/ui/render.test.ts`
- [x] **T6.5** [ui] Popup: auth/branch row, sync row, 立即同步, search box + results · feature: F5 · outputs: `apps/extension/entrypoints/popup/*` · depends: T6.4 · verify: `npx vitest run lib/ui/render.test.ts` (TC-F5-U03)
- [x] **T6.6** [ui] Status projection without secrets + parity check · feature: F5 · outputs: `apps/extension/lib/status.ts`, `apps/extension/lib/ui/format.ts` · depends: T6.5 · verify: `npx vitest run lib/status.test.ts` (TC-F5-U03, U08)

## G7 — Layout & Migration Safety (F6) `[pkg:extension]`

- [x] **T7.1** [layout] `resolveTier`: recorded mode wins; unknown → ask, never guess · feature: F6 · outputs: `apps/extension/lib/store/tier.ts` · depends: T0.1 · verify: `npx vitest run lib/store/tier.test.ts` (TC-F6-U02…U04)
- [x] **T7.2** [layout] Default tier flip to `transparent` for a new store · feature: F6 · outputs: `apps/extension/lib/settings-store.ts` · depends: T7.1 · verify: `npx vitest run lib/settings-store.test.ts` (TC-F6-U01)
- [x] **T7.3** [layout] `.omnipilot/config.json` gains `branch`, `sync_policy`, `client_version` · feature: F6 · outputs: `apps/extension/lib/store/tier.ts` · depends: T7.1 · verify: `npx vitest run --config vitest.int.config.ts lib/store/tier.int.test.ts` (TC-F6-I02, I03)
- [x] **T7.4** [layout] 0.1.0 repository compatibility + existing-store regression · feature: F6 · outputs: `apps/extension/lib/store/tier.ts`, `apps/extension/lib/store/github-store.ts` · depends: T7.3 · verify: `npx vitest run --config vitest.int.config.ts lib/store` (TC-F6-U05, I01, TC-REG-ext-store-01)

## G8 — Tooling, Packaging, CI (F7) `[pkg:both]`

- [x] **T8.1** [tooling] Native-host manifest template per OS + installer script · feature: F7 · outputs: `apps/git-bridge/native-host/{manifest.template.json,install.mjs}` · depends: T2.6 · verify: `node apps/git-bridge/native-host/install.mjs --dry-run` (TC-F7-U01, U02)
- [x] **T8.2** [tooling] Companion packaging: single-file bundle per OS into `.output/` · feature: F7 · outputs: `apps/git-bridge/scripts/pack.mjs`, `deploy/pack/deploy.sh` · depends: T8.1 · verify: `npm --prefix apps/git-bridge run pack -- --skip-test --dry-run`
- [x] **T8.3** [tooling] Deploy scripts gain a `companion` mode + install docs · feature: F7 · outputs: `deploy/deploy.sh`, `deploy/pack/deploy.sh`, `deploy/README.md` · depends: T8.2 · verify: `bash deploy/deploy.sh all --dry-run` and `bash deploy/deploy.sh companion --dry-run`
- [x] **T8.4** [tooling] CI: build + test both packages, SYS suite, E2E, xvfb · feature: F7 · outputs: `.github/workflows/ci.yml` · depends: T8.3 · verify: `npm run ci` locally mirrors the workflow

## G9 — Verification (E2E) `[pkg:extension]`

- [x] **T9.1** [e2e] "Remote drift" helper + pull/no-op/conflict specs · feature: F3, F6 · outputs: `apps/extension/e2e/{helpers.ts,sync.spec.ts}` · depends: T4.7, T6.5 · verify: `npx playwright test e2e/sync.spec.ts` (TC-E2E-01, 04, 05)
- [x] **T9.2** [e2e] SSH-degradation, search and readable-default specs · feature: F1, F4, F6 · outputs: `apps/extension/e2e/{auth.spec.ts,search.spec.ts}` · depends: T9.1 · verify: `npx playwright test` (TC-E2E-02, 03, 06)

## Traceability (Task ↔ Feature ↔ TC)

| Feature | Tasks | UNIT | INT | SYS | E2E |
|---------|-------|------|-----|-----|-----|
| F1 GitAuth | T1.1–T1.6 | TC-F1-U01…U08 | TC-F1-I01, I02 | — | TC-E2E-02 |
| F2 Native + companion | T2.1–T2.6, T3.1–T3.4 | TC-F2-U01…U10 | TC-F2-I01…I03 | TC-F2-S01…S08 | TC-E2E-02 |
| F3 Sync engine | T4.1–T4.9 | TC-F3-U01…U12 | TC-F3-I01…I07 | — | TC-E2E-01, 04, 05 |
| F4 Search | T5.1–T5.7 | TC-F4-U01…U12 | TC-F4-I01…I03 | — | TC-E2E-03 |
| F5 UI | T6.1–T6.6 | TC-F5-U01…U08 | TC-F5-I01, I02 | — | TC-E2E-03 |
| F6 Layout | T7.1–T7.4 | TC-F6-U01…U06 | TC-F6-I01…I03 | — | TC-E2E-06 |
| F7 Tooling | T8.1–T8.4 | TC-F7-U01, U02 | — | — | — |

## Mid-Phase Gates (B.15)

| Gate | Trigger | Rule |
|------|---------|------|
| `pre_dev` | Before T0.1 | **Hard gate** — scope is XL; explicit confirmation required |
| `change_impact` | After each group | Auto-confirm under autopilot unless the diff departs from `04-design.md` |
| Security audit | Phase 3 exit | B.22 — new privileged boundary (the companion) must pass |
| `checkpoint` | Phase 3 exit | Handoff to Phase 4 |

## Notes

- **Highest-risk tasks first inside each group**: T2.3/T2.4 (the companion's privilege boundary) and
  T4.1/T4.4 (merge correctness) get their tests written before the implementation (TDD).
- The two spiking assumptions from the blueprint (A2 `connectNative` in an MV3 worker, A5 IndexedDB in
  a worker) are settled by T3.2 and T4.2 respectively; if either fails, stop and re-plan rather than
  working around it silently.
- Nothing in this plan touches an existing user's repository without an explicit tier/branch check
  (T7.1–T7.4).

---

## Revision 3 — Companion content channel (2026-09-29)

Added at the `change_confirm` gate after the audit found that the ssh transport could move **no note
content in either direction** (`git.commit` only stages paths already present in the clone). See
`04-design.md` F2 step 1b and `08-spec.md` SC-F2-04/05.

| Task | Theme | Pkg | Status |
|------|-------|-----|--------|
| T2.7 | [bridge] `git.show` + `git.ls` (read the tree at a revision) | git-bridge | ✅ done — `test/content.test.ts` TC-F2-U11…U13 |
| T2.8 | [bridge] `git.write` (write + stage + commit, confined, idempotent) | git-bridge | ✅ done — TC-F2-U14…U16 |
| T2.9 | [bridge] `notFound` error code + `rev`/path/content validation | git-bridge | ✅ done — `guard.ts`, `protocol.ts` |
| T3.5 | [native] extension mirror: ops, shapes, `asGitShow`/`asGitLs`, `notFound` mapping | extension | ✅ done — `lib/native/protocol.test.ts` (6 passed) |

Evidence 2026-09-29: companion `tsc` 0 · **17 passed / 4 files** (was 11 / 3); extension `tsc` 0 ·
**UNIT 465 / 37** · **INT 94 / 12** (was 87 / 11); extension build 0 · `assert:content` OK.

Still open from Revision 2: `native/client.int.test.ts` (T3.2 verify)
and `sync/cache.test.ts` (T4.2 verify) do not exist; T4.3 is superseded by `manifest.ts` (record the
substitution in this plan rather than leaving the checkbox dangling); group checkboxes for G0–G5 are
still unchecked although their outputs exist — reconcile at the next progress write.


### Checkbox reconciliation (2026-09-29)

G0–G5 are now ticked against **evidence re-run in this session**, not against the earlier narrative: `extension tsc` 0 · UNIT/INT green (the two files G6 is still editing aside) · companion `tsc` 0 · 48 UNIT + 8 SYS. Groups G0, G1, G2, G3 and G5 shipped before this session but their boxes were never ticked, which is why the audit first read as ~55 % complete.

- **T4.3 is struck through, not done**: `manifest.ts` replaced it (the repository index *is* the manifest, so no `compare` or tree walk is needed, and the mechanism works identically over SSH). Recorded here so the task list does not keep implying missing work.
- **T3.2 and T4.2 verify files exist now** (`lib/native/client.int.test.ts`, `lib/sync/cache.test.ts`): those boxes were ticked in an earlier round while the files were still missing — they are real tests today.

## [ARCHIVE] 02-plan.md · v4 · 2026-09-29T19:00:00+08:00

---
version: 4
previous_version: 3
artifact: 02-plan.md
requirement_id: req-2026-09-29-synapse-workflow-elegance
complexity: L
total_tasks: 30
groups: 9
last_updated: 2026-09-29T18:30:00+08:00
history_ref: 02-plan-history.md
---

# Plan: 理念入文档 · 全量审计 · 统一优化

**Build order**: 文档层 → 审计 → P0（提案闭环 → 冲突决策面）→ P1（失败可读化 → SSH 引导）→ P2（本地主动性 → 首启选择）→ 收口。
每组结束跑该组测试 + 增量 B.22 复核；每个任务必须写明 `verify:` 命令。

| Group | Theme | Pkg | Tasks | Depends |
|-------|-------|-----|-------|---------|
| G0 | 设计理念与门禁（R1） | repo | T0.1–T0.4 | — |
| G1 | 全量功能审计（R2） | repo | T1.1–T1.4 | G0 |
| G2 | 提案闭环（P0-1） | extension | T2.1–T2.7 | G0 |
| G3 | 冲突决策面（P0-2） | extension | T3.1–T3.5 | G2（契约范式） |
| G4 | 失败可读化（P1-1） | extension | T4.1–T4.4 | — |
| G5 | SSH 克隆引导（P1-2） | extension | T5.1–T5.3 | — |
| G6 | 本地主动性（P2-1） | extension | T6.1–T6.4 | G2 |
| G7 | 首启层级选择（P2-2） | extension | T7.1–T7.3 | — |
| G8 | 收口与回归 | both | T8.1–T8.3 | all |

## G0 — 设计理念与门禁（R1，`[pkg:repo]`）

- [ ] **T0.1** 写 `docs/product/00-design-principles.md`（理念 → W1–W6 判据 + 判定问题 + 反例 → 每 Feature 必答四问 → CR 条目） · verify: 人工复核 + T0.4
- [ ] **T0.2** 写 `AGENTS.md`（非协商规则 + 指向判据文档），并在 `README.md` 增一句立场 · verify: T0.4
- [ ] **T0.3** `00-project-context.md` § Architecture Patterns 增"理念与判据"一条；确认 `04-design.md` 必答节已就位（本次已作为范式写入） · verify: 人工复核
- [ ] **T0.4** 文档契约测试 `apps/extension/lib/tooling/design-docs.test.ts`（TC-DOC-U01/U02） · verify: `npx vitest run lib/tooling`

## G1 — 全量功能审计（R2）

- [ ] **T1.1** 枚举三张表（`REQUEST_TYPES` 26 项 / CKF 4 类记录 / 工作流 6 阶段） · verify: 覆盖计数断言（T1.4）
- [ ] **T1.2** 逐项证据矩阵（`file:line` + 判据编号 + 结论） · verify: 至少 40 条带证据的判定
- [ ] **T1.3** 四类问题清单（死代码 / 未创建记录类型 / 无出口状态 / 静默失败）+ 优先级与验证方式 · verify: 每项都有 P 级与验证命令
- [ ] **T1.4** 审计契约测试（TC-DOC-U03/U04） · verify: `npx vitest run lib/tooling`

## G2 — 提案闭环（P0-1）`[pkg:extension]`

- [ ] **T2.1** 契约：`cards.list` / `card.decide` 加入 `REQUEST_TYPES` + payload 类型 + 校验器 + `SECRET_BEARING_TYPES` + i18n 键 · verify: UNIT `lib/messages.test.ts`
- [ ] **T2.2** codec：卡片路径依 `status` 推导（pending → `cards/pending/`，confirmed → `cards/`），保持 vault 加解密不变 · verify: UNIT `lib/store/codec.test.ts`
- [ ] **T2.3** 决策逻辑（纯 + 提交）：accept / edit / discard 的文件集计算与一次提交 · verify: UNIT `lib/cards/decide.test.ts`
- [ ] **T2.4** handlers：`cards.list` / `card.decide` 接线（限流 + 错误映射 + vault 锁定拒绝） · verify: INT `lib/background`
- [ ] **T2.5** popup"待处理"区（标题/摘要/要点/来源 + 三动作 + 空态） · verify: UNIT `lib/ui/render.test.ts` + E2E TC-P3-E01
- [ ] **T2.6** accept 后写 `review/state.json`（ReviewState 首次产出） · verify: INT TC-P3-I02
- [ ] **T2.7** 测试补全（TC-P3-U01…U04 / I01–I04 / E01） · verify: `npx vitest run` + `npx playwright test e2e/cards.spec.ts`

## G3 — 冲突决策面（P0-2）

- [ ] **T3.1** `sync.status` 扩展冲突摘要（双方时间/体积/可读性） · verify: UNIT TC-P4-U01
- [ ] **T3.2** `conflict.resolve` 三种动作的文件集与归档路径（`archive/conflicts/**`） · verify: UNIT TC-P4-U02
- [ ] **T3.3** handler + `syncState.conflicts` 清理 + shards 刷新 · verify: INT TC-P4-I01/I02
- [ ] **T3.4** 同步页签冲突行 UI（摘要 + 三选一 + 执行后回到无冲突） · verify: E2E TC-P4-E01
- [ ] **T3.5** 测试补全 · verify: `npx vitest run` + `npx playwright test e2e/sync.spec.ts`

## G4 — 失败可读化（P1-1）

- [ ] **T4.1** `errorGuidance(code)`（穷尽 `ErrorCode`）+ 双语键 · verify: UNIT TC-P5-U01/U03
- [ ] **T4.2** `StatusLine.lastFailure`（无原文/路径/内容） · verify: UNIT TC-P5-U02
- [ ] **T4.3** 状态行渲染"最近失败 + 去处理/重试" · verify: INT TC-P5-I01 + E2E 回归
- [ ] **T4.4** 测试补全 · verify: `npx vitest run`

## G5 — SSH 克隆引导（P1-2）

- [ ] **T5.1** `cloneCommand` / `repoRootError` 纯函数 · verify: UNIT TC-P6-U01/U02
- [ ] **T5.2** options SSH 区块展示命令 + 一键复制 + 路径校验 · verify: UNIT `lib/ui/auth-form.test.ts` + `npm run build`
- [ ] **T5.3** 测试补全 · verify: `npx vitest run lib/ui`

## G6 — 本地主动性（P2-1）

- [ ] **T6.1** `lib/local/insights.ts`（`recallHint` / `suggestTopic` / `dueForReview`，纯函数、零出网） · verify: UNIT TC-P7-U01…U03
- [ ] **T6.2** 复习队列呈现（popup 待处理区"今天该复习 N 条"） · verify: UNIT `lib/ui/render.test.ts`
- [ ] **T6.3** 捕获命中提示（不阻塞捕获） · verify: INT TC-P7-I01
- [ ] **T6.4** 测试补全 · verify: `npx vitest run`

## G7 — 首启层级选择（P2-2）

- [ ] **T7.1** 首启状态判定 + 选择写入 store config（不静默默认） · verify: UNIT TC-P8-U01/U02
- [ ] **T7.2** options 首启一步 UI（各配一句人话后果） · verify: UNIT `lib/ui/format.test.ts`
- [ ] **T7.3** E2E 首启强制选择 · verify: E2E TC-P8-E01

## G8 — 收口与回归

- [ ] **T8.1** 全量回归（extension UNIT/INT/E2E/SMK/REG + companion UNIT/SYS）+ build + `assert:content` · verify: 见 05-test-plan 追溯表
- [ ] **T8.2** B.22 安全审计增量复核（3 个新 request type + 2 个新归档路径 + StatusLine 投影）并更新 `07-security-audit.md` · verify: PASS
- [ ] **T8.3** 文档同步（`README.md` / `00-project-context.md` / `03-progress.md` / plan 勾选）+ 记录 Open backlog · verify: 人工复核

## Mid-Phase Gates（B.15）

| Gate | Trigger | Rule |
|------|---------|------|
| `pre_dev` | G0 之前 | L 复杂度：硬门，autopilot 已确认（`/od auto`） |
| `change_impact` | 每组结束 | autopilot 下自动确认，除非偏离 `04-design.md` |
| 安全审计 | Phase 3 退场 | B.22：新 request type 属新攻击面，必须 PASS |

## Open backlog（明确延后，不在本次交付）

1. **P1-3 检索增强**（本地词项扩展 / 本地向量；默认关、零出网）——需要独立设计与评测方法。
2. **生成式 AI 主动性**（AI 生成复习问题、跨笔记关联）——涉及出网与隐私取舍，需单独 spec。
3. **多设备协同**（同一账号多端并发编辑的冲突前置避免）——本次只把冲突变成"一次决定"，未消除冲突本身。
4. **`apps/miniprogram`**（微信小程序端）——既有 deferred 项。

## Notes

- 三个新 request type 全部扩展页面可发（`SECRET_BEARING_TYPES`）并落在最紧的限流预算里；这是 A2（blocking 假设）的验证方式。
- 归档路径（`archive/**`）不进入 `NOTES.md` 目录，避免污染"可读目录"，但文件仍在仓库、可检索到路径。
- 任何对既有断言的修改必须在 `03-progress.md` 记录理由（A6）。

