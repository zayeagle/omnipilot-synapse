# History: 07-security-audit.md

Append-only archive. Do not edit or delete past snapshots.
Newest entries appended at **bottom**.

| Metric | Value |
|--------|-------|
| snapshots | 1 |
| first_archived | 2026-09-29 16:55 |
| last_archived | 2026-09-29 16:55 |

---

## [ARCHIVE] 07-security-audit.md · v1 · 2026-09-29 16:55

---
requirement_id: req-2026-07-09-synapse-ext-mvp
iteration: 2
status: PASS
blocking_open: 0
git_tip: uncommitted (working tree)
audited_at: 2026-07-09T00:00:00+08:00
---

# Security Audit

## Summary

- **Scope**: everything produced by Phase 3 — `apps/extension/{lib,entrypoints,scripts,wxt.config.ts}`,
  the built `manifest.json`, and the E2E harness. ~90 new files; ~70 of them under `lib/**`.
- **Tools**: checklist-only (the repo ships no SAST) **plus** two project-specific automated guards
  that were written as part of this work: `scripts/assert-content-no-secrets.mjs` (build gate on the
  content bundle) and `lib/core/purity.test.ts` (core-layer boundary guard). `npm audit` run.
- **Result**: **PASS** — no open CRITICAL/HIGH. Three MEDIUM findings documented and accepted below.
- **Iteration**: 1 / 3.

This is a security-critical deliverable: the requirement makes privacy of a personal corpus P0, and
the extension holds repository credentials.

## Findings

| ID | Sev | File / area | Issue | Remediation |
|----|-----|-------------|-------|-------------|
| S1-01 | INFO | `lib/**/*.test.ts`, `e2e/helpers.ts` | Fixture credentials (`github_pat_11AA…`, `sk-e2e-…`) appear in test files | Not a leak: the values are synthetic and exist precisely to prove the scrubber redacts them. No production file contains a literal credential. |
| S2-01 | PASS | `lib/ui/**`, `lib/dom/**` | No `innerHTML` / `insertAdjacentHTML` / `createContextualFragment` with dynamic data | All dynamic text goes through `textContent`. The only `innerHTML` mentions are a comment and test assertions. Verified by grep. |
| S3-01 | PASS | `lib/background/router.ts`, `lib/messages.ts` | Privileged requests must not be reachable from a page context | `assertRequestAllowed` runs before any handler: a content-script sender may send only `prefs.get` and `capture.request`; every credential-touching type additionally requires an extension-page sender. Covered by `router.int.test.ts` (TC-F4-I01) and `handlers.int.test.ts`. |
| S4-01 | PASS | repo-wide | `eval`, `new Function`, `child_process`, unchecked shell | None present. The `exec(` grep hits are `RegExp.prototype.exec`. |
| S4-02 | PASS | `lib/core/paths.ts`, `lib/messages.ts` | Path traversal into the repository | `normalizePrefix` drops `.`/`..` segments; `validateGithubSettings` rejects them explicitly and rejects whitespace/slashes in owner/repo/branch. |
| S5-01 | PASS | `lib/providers.ts`, `lib/messages.ts`, `lib/store/github-api.ts` | Cleartext transport / disabled TLS verification | `isAcceptableEndpoint` allows `https:` everywhere and `http:` only for `localhost`/`127.0.0.1`/`[::1]`. No `rejectUnauthorized`/`NODE_TLS_REJECT_*` anywhere. Non-default endpoints need a trust acknowledgement that the worker re-checks (`assertEndpointTrusted`). |
| S6-01 | PASS | shipped code | Secrets or content in logs | No `console.*` in `lib/**`; the single logger in `background.ts` receives an already-scrubbed message and never content. The router scrubs every surfaced failure with the configured secrets. |
| S6-02 | PASS | `.output/chrome-mv3/manifest.json` | Over-broad permissions | `permissions: [storage, activeTab, scripting, contextMenus]`; `host_permissions` enumerate only the five catalog provider hosts + `api.github.com`; no `web_accessible_resources` at all, so no extension asset is exposed to pages. (M-01 discusses `optional_host_permissions`.) |
| S7-01 | PASS | `apps/extension/package.json` | Vulnerable dependencies | `npm audit --omit=dev` → **0 vulnerabilities**; the extension ships **zero** runtime dependencies (all packages are devDependencies). |
| S8-01 | INFO | CI | No SAST tool wired | Compensating controls: the secret-scan build assertion, the core-purity test, and `tsc --strict`. `npm run ci` runs all of them. A semgrep/eslint-security job is a Phase-5 follow-up. |
| M-01 | MEDIUM | `wxt.config.ts` | `optional_host_permissions: ["https://*/*"]` is broad | Accepted. It is **optional** (granted only when the user saves a custom base URL, and only for that host), which is the cost of "支持主流模型接入 + 自定义端点". Residual risk is limited because only the background may fetch, and only the configured base URL is used. Tightening to per-host requests at save time is a Phase-5 improvement. |
| M-02 | MEDIUM | `lib/store/codec.ts`, `lib/store/vault-codec.ts` | Vault mode still exposes *some* metadata | Accepted and documented in code. Paths use an opaque id, commit messages omit titles, and `url_key` is a fingerprint — but the host still sees file count, sizes, timestamps and the `content_key` fingerprint, which is a **confirmation oracle** for a candidate plaintext an attacker already holds. A keyed (HMAC) fingerprint would close it; deferred because it needs the vault key on every index read and would break transparent-mode dedup symmetry. |
| M-03 | MEDIUM | `storage.local` | Vault ciphertext + KDF parameters sit in the browser profile | Accepted. The passphrase is never persisted and the derived key lives only in `storage.session` (memory-backed, TTL-clamped). An attacker with profile access gets ciphertext, not plaintext — but can attempt an offline passphrase attack, which is why the KDF work factor is stored in the envelope and can be raised (`kdf.iterations`) without orphanning existing files. |

## Automated evidence

| Check | Command | Result |
|-------|---------|--------|
| Dependency CVEs | `npm audit --omit=dev` | `found 0 vulnerabilities` |
| Content bundle cannot reach a secret | `npm run assert:content` | `OK — scanned 1 content-script file(s)` |
| Core layer stays browser/network-free | `npx vitest run lib/core/purity.test.ts` | 4 passed |
| Sender authorization | `npx vitest run --config vitest.int.config.ts lib/background` | 22 passed |
| Secret scrubbing | `npx vitest run lib/security/redact.test.ts` | 10 passed |
| Fail-closed vault | `npx vitest run --config vitest.int.config.ts lib/distill-service.int.test.ts lib/background` | locked-write refusals asserted |
| Type strictness | `npx tsc --noEmit` | exit 0 |

## Iteration 2 — defect found by the E2E gate

The first E2E run was blocked: the extension loaded, its MV3 worker ran and reported
`onMessage.hasListeners() === true`, but the browser never dispatched a single `runtime.onMessage`
to it. Bisecting a throwaway extension (my manifest + a trivial worker **passed**; a minimal manifest
+ my worker **failed**) localised the fault to the worker bundle, and inspecting the worker's state
showed `chrome.commands === undefined` and an empty `storage.local`.

**Root cause**: the worker registered `browser.commands.onCommand` at top level, but `wxt.config.ts`
never declared a `commands` manifest key — so the API was absent and the worker threw **during its
initial evaluation, after `onMessage.addListener` had already run**. Chrome treats such a worker as
failed and silently stops dispatching events to it; the JS-side `hasListeners()` still reports `true`,
which is why every unit-level test passed.

**Classification**: HIGH severity as a **reliability** defect (the entire extension was inert:
no capture, no settings, no vault traffic), but **not a security regression** — a dead worker fails
closed and wrote nothing. It is exactly the class of integration failure that only an end-to-end gate
can catch, and it is why the E2E layer was not waived.

**Fix** (both parts are required, defence in depth):
1. `wxt.config.ts` now declares the `clip-page` / `clip-selection` commands with suggested keys.
2. `entrypoints/background.ts` guards every optional browser API at top level
   (`browser.contextMenus?.`, `browser.commands?.`, `browser.runtime.onInstalled?.`) and wraps menu
   creation in a `try`/`catch`, so a missing permission can never again take the worker down during
   start-up.

**Re-audit result**: **PASS** — no new CRITICAL/HIGH security finding; the fix removes an
undefined-API crash path. Verified by the full pipeline:

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | 381 passed / 30 files |
| `npx vitest run --config vitest.int.config.ts` | 67 passed / 9 files |
| `npm run build` | ✓ |
| `npm run assert:content` | OK |
| `npx playwright test` | **6 passed** (4 E2E specs incl. the vault-leak and distill-proposal assertions) |

## Decision

- **passed** — Phase 4 may start. Iteration 2 / 3, blocking findings: 0.
- M-01/M-02/M-03 remain accepted with their remediation paths; none blocks testing.
- Recommended Phase-5 hardening (not blocking): HMAC-keyed `content_key` in vault mode, per-host
  optional permissions, and a semgrep job in CI.

