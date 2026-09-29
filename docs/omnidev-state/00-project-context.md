# Project Context — omnipilot-synapse

## Stack & Layers

- **project_type**: greenfield
- **project_structure**: monorepo (planned) — `apps/extension` (MVP, this task) · `apps/miniprogram` (later) · `packages/core` (canonical model + adapters)
- **clients**: Browser Extension (WXT + TypeScript, MV3 / Firefox MV2) — **only mode implemented now**; WeChat Mini Program deferred
- **storage**: **GitHub only** (GitHub REST v3 Contents/Git Data API, Markdown + JSON knowledge base). GitLab/Gitee/self-hosted DB/local FS deferred — adapter interface must stay pluggable
- **storage auth (current requirement)**: **two credential modes** — HTTPS **access token** (GitHub REST, works today) and **SSH key**. A browser extension has no TCP socket API, so SSH cannot be spoken from MV3 directly; it needs a transport (native-messaging companion driving system `git`/`ssh`, or a self-hosted SSH-over-WebSocket bridge). Decision deferred to Phase 1.
- **sync model (current requirement)**: **automatic push _and_ pull** — a local cache plus a reconciliation engine, not write-only commits
- **repo readability (current requirement)**: storage layout is free-form as long as retrieval works; **readable-in-repo is preferred** when performance allows (transparent tier becomes the recommended default, with a searchable index)
- **AI providers**: mainstream LLM接入 — OpenAI-compatible · DeepSeek · Anthropic · OpenRouter · iFlytek(spark) · Custom base URL (pattern reused from `omnipilot-lingua-bridge/lib/providers.ts`)
- **tests**: vitest (unit) + playwright (smoke e2e)
- **frontend**: extension popup (in-page console) + options page (vanilla TS + CSS, no framework — matches reference repo)

## Dependency Topology

- External: GitHub REST API (HTTPS, PAT) · LLM provider APIs (HTTPS)
- Storage adapters: **GitHub (MVP)** · GitLab/Gitee/self-hosted DB/local filesystem (deferred, interface reserved)
- Optional AI distill service (explicit user authorization, default OFF)
- **No mandatory official cloud, no project backend**

## Architecture Patterns / Conventions

- Any-to-idea pipeline: **Capture → Inbox → Distill(AI, opt-in) → Place → Retrieve → Review**
- Canonical Knowledge Format (CKF): `SourceItem` / `KnowledgeCard` / `Topic` / `ReviewEvent`
- Security P0: content encryption by backend tier (Vault mode default · Git transparent-repo mode opt-in), token in end-side vault (PBKDF2 + AES-GCM, session unlock), AI plaintext egress requires explicit authorization + ledger, no secrets in content script bundle
- Reference implementation to follow: `D:\code\go\src\github.com\zayeagle\omnipilot-lingua-bridge` (WXT layout, `lib/*` pure modules + colocated `*.test.ts`, background-only secret access, `crypto-key.ts` vault, rate-limit, error scrubbing, i18n dictionary)

## Stability Level

- **high** (personal private data; security is P0)

## MCP Services

- None required for this task (no DB MCP, no browser MCP configured). Playwright is used directly via `@playwright/test`.

## Notes

- Requirements (SSOT): `docs/requirements/00-requirements.md` — §5A browser-extension scope, §5B form A (Git), §6 security baseline
- Remote: https://github.com/zayeagle/omnipilot-synapse
- Task scope decision: extension-only + GitHub-only; mini program, self-hosted DB and local FS must remain designable but unimplemented
- **Delivered so far** (`req-2026-07-09-synapse-ext-mvp`, 0.1.0): capture → Inbox → opt-in distill → GitHub commit; vault/transparent tiers; 455 tests green; spec merged into `specs.md`
- **Lesson learned (worth carrying)**: an MV3 worker that throws during its *initial* evaluation is treated by Chrome as failed and silently stops receiving `runtime.onMessage` — while `hasListeners()` still returns true. Every optional browser API registered at top level must be guarded. Only the E2E gate caught this; 448 unit/INT tests did not.
- **Known physical constraint**: extensions cannot open raw TCP sockets, so any SSH support implies a companion process or a bridge server. Do not design SSH as a pure-extension feature.
- **Lesson learned (0.2.0 sync work)**: a *content-write* primitive on a privileged boundary must refuse the repository's own machinery. `git.write` materialises bytes before it runs git, so accepting `.git/hooks/*` turned a notes API into a hook installer (executed by the very next `git commit`), and `.git/config` into a hooksPath/sshCommand override. Confinement to the root is not enough — and the check must be case-insensitive (`.GIT` on Windows). Found by the B.22 audit, not by the 48 unit + SYS tests that already existed.
- **Lesson learned (0.2.0 sync work)**: manifest-based diffing must cache the *remote's* version key. Comparing our wall-clock `updatedAt` against the repository's `updated_at` makes every pulled record look modified, so the second sync re-fetches the world and SC-F5-01 (no-op) can never hold.
- **Lesson learned (workflow-elegance work)**: a surface that is *confidently wrong* is worse than one that fails. `PublicPrefs.sync` was never supplied by any caller, so the popup said "never synced" no matter what happened — for three releases, through 500+ green tests. A crash gets noticed; a plausible lie does not. When adding a projection field, assert a caller actually fills it.
- **Lesson learned (workflow-elegance work)**: documentation rot is prevented by a failing test, not by discipline. `lib/tooling/design-docs.test.ts` fails the build when a new message type is not enumerated in the audit — it caught `review.due` the moment it was added. Same shape as the two-tables problem (`describeError` vs `ERROR_GUIDANCE`): when the same fact is defined twice, one of the copies is already stale.
