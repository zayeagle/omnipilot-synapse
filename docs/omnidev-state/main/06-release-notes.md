---
artifact: 06-release-notes.md
version: 0.1.0
released_at: 2026-07-09T00:00:00+08:00
gate_status: PASS
deploy_modes: [chrome, firefox, verify]
deploy_autonomy: full
---

# Release Notes — OmniPilot Synapse 0.1.0 (browser-extension MVP)

First deliverable of the personal knowledge OS: the **capture end** of the loop, as a browser
extension, storing into a GitHub repository the user owns.

## What's in this release

### Added — product

- **Capture** three ways: the in-page selection bubble (剪藏 / 提炼), the right-click context menu, and
  the toolbar popup (剪藏本页 / 剪藏选区).
- **Inbox** in a GitHub repository, date-partitioned (`inbox/YYYY/MM/`), written with the Git Data API
  so a capture is one atomic commit (record + index together).
- **Canonical Knowledge Format** — Markdown + YAML frontmatter, adapter-agnostic; the same record
  model is designed to be shared with the future WeChat Mini Program.
- **Duplicate detection** by canonical URL and content fingerprint; a repeat capture writes nothing
  and tells you where the existing item lives.
- **Two content tiers** — `vault` (AES-GCM, default) and `transparent` (readable Markdown), with a
  hard guard against switching tiers on a non-empty repository.
- **Six model providers** through one catalog: OpenAI, DeepSeek, Anthropic, OpenRouter, iFlytek
  Spark, and a custom HTTPS endpoint.
- **Distillation as a proposal** — strict-JSON knowledge cards under `cards/pending/`; the source file
  is never rewritten. Clicking 提炼 in the capture flow is itself the per-item authorization, on top
  of a global switch and an audit ledger.
- **Offline tolerance** — a capture that cannot be written is queued and replayed later.

### Added — security

- Vault: PBKDF2-SHA256 (250 000 iterations, stored per-envelope so it can be raised) → AES-GCM-256,
  with a session unlock that expires and fails closed.
- Credentials exist only inside the background worker; page-context code can learn *whether* a token
  exists, never what it is — enforced by a build assertion that walks the content script's real
  import graph.
- Vault mode hides metadata as well as content: opaque file names, title-free commit messages, and a
  fingerprinted canonical URL in the index.
- Public repositories are blocked until the user explicitly acknowledges the risk.
- Custom model endpoints require an HTTPS trust acknowledgement that the worker re-checks.
- Every surfaced error is scrubbed of credential-shaped substrings.

### Added — engineering

- 381 unit + 68 integration + 6 end-to-end tests, all green; `npm run ci` runs the lot.
- E2E loads the real extension into Chromium and intercepts GitHub + the model provider, so the suite
  needs no token and no network.
- CI (`.github/workflows/ci.yml`): typecheck, unit, integration, build, secret assertion, Firefox
  build, E2E under `xvfb-run`, artifact upload.
- One-click delivery: `make deploy` / `deploy/deploy.sh` (modes `chrome`, `firefox`, `all`, `verify`).

### Fixed during this release

- **Worker was completely inert.** `browser.commands.onCommand` was registered at top level while the
  manifest declared no `commands` key, so the API was `undefined` and the worker threw during its
  initial evaluation — *after* `onMessage` had been registered. Chrome treats such a worker as failed
  and silently stops dispatching events, so every capture, settings save and vault operation did
  nothing while all 448 unit/integration tests passed. Found by the E2E gate; fixed by declaring the
  commands and guarding every optional browser API at top level.
- **Vault mode leaked metadata**: the page title travelled in the file path and the commit message,
  and the canonical URL in `index.json`. Fixed with opaque paths, opaque commit messages and a
  fingerprinted `url_key`; `dedupUrlKey()` keeps deduplication working in both tiers.
- **Empty-bodied captures collided** in content-hash dedup, so a second title-only capture was
  reported as a duplicate of the first. Dedup now ignores bodies under 200 characters.
- The dropdown language of the popup status rows now follows the browser locale.

## Deploy modes

| Mode | One-click | Produces |
|------|-----------|----------|
| `chrome` | `make deploy-chrome` | `.output/chrome-mv3/` + `omnipilotsynapse-extension-0.1.0-chrome.zip` |
| `firefox` | `make deploy-firefox` | `.output/firefox-mv2/` + `*-firefox.zip` |
| `all` | `make deploy` | both, plus `*-sources.zip` |
| `verify` | `make deploy-verify` | typecheck + unit + integration + secret assertion |

**Deviation from the generic template**: this project is a browser extension, so `docker` / `k8s` /
`binary` modes are not applicable — there is no server to containerise or schedule. The modes above
are the extension equivalents. Production "deploy" here means publishing a signed store package,
which only the maintainer can do.

## Artifacts produced for this release

| Artifact | Size |
|----------|------|
| `apps/extension/.output/omnipilotsynapse-extension-0.1.0-chrome.zip` | 85.2 kB |
| `apps/extension/.output/omnipilotsynapse-extension-0.1.0-firefox.zip` | 85.1 kB |
| `apps/extension/.output/omnipilotsynapse-extension-0.1.0-sources.zip` | 213.3 kB |
| unpacked bundles | `.output/chrome-mv3/`, `.output/firefox-mv2/` |

Verified, not shipped with the release: `apps/extension/.output/` is git-ignored.

## Deployment

### Prerequisites

- Node ≥ 20 (developed on 24.18) and npm.
- `npm --prefix apps/extension install` (the root `postinstall` also does it).
- For E2E only: `npx playwright install chromium` (Linux CI additionally needs `xvfb`).

### Environment variables

None are required to build or package. `ENV=production` is only a guard when passing `--production`.
The extension takes all credentials from the user at runtime; see the security model in
[README.md](../README.md).

### Steps (Chrome / Edge)

```bash
make deploy-chrome
# chrome://extensions → Developer mode → Load unpacked → apps/extension/.output/chrome-mv3
```

### Steps (Firefox)

```bash
make deploy-firefox
# about:debugging#/runtime/this-firefox → Load Temporary Add-on → .output/firefox-mv2/manifest.json
```

### Post-install smoke (manual, 2 minutes)

1. Settings → 安全: set a vault passphrase.
2. Settings → 存储: fine-grained token with `Contents: Read and write`, owner/repo/branch, 测试连接
   (expect a **private** badge), 保存.
3. Select text on any article → bubble → 剪藏 → the page reports *Saved to Inbox* and the repository
   gains `inbox/YYYY/MM/<id>.md.enc` plus an updated `index.json`.
4. Select again → *Already in Inbox* and no new commit.

### Rollback

No server to roll back. Remove the unpacked extension (or the temporary add-on) and re-load the
previous build. Captured data is untouched — it lives in your GitHub repository, not the extension.

## Known issues / deferred

- **Metadata is minimised, not eliminated.** The Git host still sees file names, sizes, timestamps,
  commit frequency, and a non-cryptographic `content_key` fingerprint. An HMAC-keyed fingerprint
  would close the confirmation-oracle gap; deferred (see security audit M-02).
- `optional_host_permissions: ["https://*/*"]` is broad; it is only requested when a custom endpoint
  is configured. Per-host requests are a Phase-5/thereafter improvement (audit M-01).
- No `web_accessible_resources`: intentional. Nothing in the extension is exposed to pages, because —
  unlike the reference project — there is no in-page injected console.
- WeChat Mini Program, self-hosted DB storage and local-filesystem storage are designed for but not
  implemented. `KnowledgeStore` is the seam, and `lib/core/**` is browser-free for exactly that
  reason.
- No coverage gate; `@vitest/coverage-v8` is not installed (`coverage_gate: false`).
- No SAST in CI; the two in-repo guards (content-bundle secret assertion, core purity test) stand in.

## Links

- [Test report](05-test-report.md) — gate **PASS**, 455 tests across five layers
- [Security audit](07-security-audit.md) — **PASS**, iteration 2, 0 blocking
- [Requirements](../../requirements/00-requirements.md) · [README](../../../README.md)
