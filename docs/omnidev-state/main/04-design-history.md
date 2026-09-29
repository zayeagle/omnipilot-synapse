# History: 04-design.md

Append-only archive. Do not edit or delete past snapshots.
Newest entries appended at **bottom**.

| Metric | Value |
|--------|-------|
| snapshots | 4 |
| first_archived | 2026-07-09 00:00 |
| last_archived | 2026-09-29T19:00:00+08:00 |

---

## [ARCHIVE] 04-design.md · v1 · 2026-07-09 00:00

| Field | Value |
|-------|-------|
| version | 1 |
| archived_at | 2026-07-09T00:00:00+08:00 |
| reason | new_requirement — superseded by req-2026-07-09-synapse-git-sync |
| trigger | /od (new requirement on main) |
| requirement_id | req-2026-07-09-synapse-ext-mvp |
| summary | Design for the extension MVP (9 features: capture, CKF, codec, security, providers, store, distill, UI, release) |

<!-- BEGIN SNAPSHOT --># Design

> Single-file design (`design_split: false`). Feature sections are loaded individually in Phase 3.
> Spec traceability: `08-spec.md` (`SC-F{n}-{nn}`) · Tasks: `02-plan.md` · TCs: `05-test-plan.md`.

## Feature F1: Capture & Extraction

### Business Context
- **Related**: F2 (CKF), F6 (store), F8 (UI), F9 (manifest/commands)
- **Impact**: the only user-facing entry path; every later feature consumes its output

### Implementation Logic
1. Entry: three triggers — popup 剪藏按钮, `contextMenus` (page / selection / link), content-script 划线气泡 (or `Alt+Shift+S`) → all funnel into background message `CAPTURE_REQUEST`
2. `lib/capture/extract.ts` — `extractPage(doc, loc)` picks the正文 container by block-text score (length × punctuation density, minus nav/footer/aside penalty), falls back to `article` → `main` → `body`; harvests `og:`/meta title, canonical URL, byline, `lang`, `published_time`; `extractSelection(sel)` returns text + surrounding paragraph
3. `lib/core/dedup.ts` — `urlKey` (strip tracking params + fragment, lowercase host), `contentKey` (SHA-256 of normalized text), `isNearDuplicate` (5-gram Jaccard ≥ 0.9 over the first 2 KB)
4. Background: dedup probe via `index.json` → build `SourceItem` (`lib/core/ckf.ts`) → `lib/core/paths.ts` → codec encode (F3) → `store.commitFiles` (F6) → reply `CAPTURE_RESULT`
5. Body cap 512 KB (`truncated: true` + `original_bytes`); offline/failed capture is queued in `storage.local:captureQueue` and flushed on next success

### Edge Cases
- Happy: SC-F1-01/02 · Err1: store not configured → 引导配置，不入队重复失败 · Err2: permission denied (no activeTab/allowed page) → 明确提示 · Boundary: empty正文 → 只存标题+URL并标记 `extraction: "title-only"` · SC-F1-03 duplicate → 不写文件，返回既有路径

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `SourceItem` | new | `id, kind:'source', channel:'extension', url, title, byline, lang, captured_at, body, excerpt_of?, content_hash, truncated?, tags[]` |
| `index.json` | new | `{ schema, items: { id: {kind, path, url_key, content_key, created_at, updated_at} } }` |

## Feature F2: Canonical Knowledge Format (core, pure)

### Business Context
- **Related**: F1, F5, F6 — every producer/consumer of stored data
- **Impact**: the extraction seam for the future WeChat Mini Program (`packages/core`)

### Implementation Logic
1. `lib/core/ckf.ts` — types + `parse*` validators for `SourceItem` / `KnowledgeCard` / `Topic` / `ReviewState`; exhaustive field checks, `unknown` keys dropped, typed `CkfError` on failure
2. `lib/core/paths.ts` — `newId()` (time-sortable 8-char base32 + 4 random), `slugify()` (CJK-safe: keeps CJK, folds punctuation to `-`, caps at 60 chars), `sourceItemPath`, `cardPath`, `topicPath`
3. `lib/core/markdown.ts` — `encodeDoc(frontmatter, body)` / `decodeDoc(text)` with a YAML subset writer/reader (strings quoted defensively, arrays, numbers, booleans, ISO dates); body fenced so `---` inside content is safe
4. `lib/core/dedup.ts` — as F1 step 3 (kept pure, no I/O)
5. Purity is enforced by `lib/core/purity.test.ts`: asserts no `chrome`/`browser`/`fetch`/`window`/`document` and no import outside `lib/core/**`

### Edge Cases
- Happy: SC-F2-01 round trip · Err1: SC-F2-02 missing/invalid field → `CkfError` · Err2: duplicate `id` in index → last-write-wins with a logged warning · Boundary: frontmatter containing `---`, quotes, emoji, or CJK title

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `KnowledgeCard` | new | `id, kind:'card', source_id, title, summary, points[], scenarios?, counter_examples?, tags[], topic_id?, status:'pending'|'confirmed', distilled_by{provider,model,at}, evidence_paths[]` |
| `Topic` | new | `id, kind:'topic', name, path, parent_id?` |
| `ReviewState` | new | `id, stability, retrievability, last_reviewed_at?, next_review_at, self_rating?, use_count` |

## Feature F3: Content Codec & Confidentiality Tier

### Business Context
- **Related**: F4 (keys), F6 (store), F8 (settings UI)
- **Impact**: decides what the Git host can read — the core of §6.2 security baseline

### Implementation Logic
1. `lib/store/codec.ts` — one interface, two implementations: `transparentCodec` (plaintext Markdown via F2 markdown) and `vaultCodec` (envelope JSON, base64)
2. Envelope: `{ v:1, alg:'AES-GCM', kdf:{name:'PBKDF2-SHA256', iterations:250000, salt_b64}, iv_b64, cipher_b64, meta:{ kind, id, created_at, updated_at } }`; `meta` is deliberately minimal (no title, no url, no body)
3. File naming: `vault` writes `<name>.md.enc`, `transparent` writes `<name>.md`; `.omnipilot/config.json`, `index.json`, `review/state.json` always stay cleartext and contain identifiers/timestamps only
4. `meta` is duplicated into `index.json` so the extension can list and dedup without the key
5. Mode switch is per-store, stored in `.omnipilot/config.json`; switching requires a re-encode migration task (out of MVP: warn + refuse)

### Edge Cases
- Happy: SC-F3-01 vault write/read round trip · Err1: SC-F3-03 locked vault → `VaultLockedError`, no write · Err2: wrong passphrase → AES-GCM auth failure surfaced as "口令错误" (no partial output) · Boundary: SC-F3-02 empty body / 1-byte body / 512 KB body · mode mismatch (transparent file while vault mode on) → read attempts plaintext first, then envelope, then reports typed error

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `.omnipilot/config.json` | new | `{ schema_version, security_mode:'vault'|'transparent', created_at, updated_at }` |

## Feature F4: Security & Secret Custody

### Business Context
- **Related**: F3, F5, F6, F9 — every component that touches a credential
- **Impact**: P0 for a personal corpus; a leaked PAT exposes the whole knowledge base

### Implementation Logic
1. `lib/security/crypto-key.ts` — `deriveKey(passphrase, salt, iterations)` (PBKDF2-SHA256 → AES-GCM-256), `encryptText(key, text)` (random 12-byte IV), `decryptText(key, envelope)`; every function takes an injectable `crypto` for tests
2. `lib/security/key-session.ts` — module-scoped key + `unlockedAt`; mirrors `<no key>` into `chrome.storage.session` so a SW restart keeps the session within TTL (default 30 min); `lock()` clears both; **no passphrase persistence, no auto-unlock**
3. `lib/settings-store.ts` — `storage.local:settings` (non-secret config: provider id, model, base URL, repo/branch/path, security mode, public prefs) vs `storage.local:secretVault` (the vault envelope holding `{ githubPat, providerKey, ... }`); `storage.local:publicPrefs` (`enabled, storeKind, repo, securityMode, hasPat, hasKey, vaultLocked, aiAuthorized`) is the only thing content scripts may read
4. `lib/security/redact.ts` — `scrub(text, secrets)` exact-substring → `[REDACTED]` + `sk-…`/`gh[pousr]_…` regex; applied in `ai-client`, `github-api`, and the background error boundary
5. `lib/security/rate-limit.ts` — `SlidingWindowLimiter(max, windowMs, now)`; AI 30 req/60 s, GitHub 60 req/60 s, keyed `tab:<id>` with a global fallback cap
6. `lib/messages.ts` — secret-bearing message types (`VAULT_*`, `SET_*`, `DISTILL_*`, `CAPTURE_*`) require `isExtensionPageSender(sender)`; content scripts may only send `GET_PUBLIC_PREFS` and `CAPTURE_REQUEST`

### Edge Cases
- Happy: unlock → write → lock · Err1: SC-F4-02 provider 401 echoing the key → scrubbed · Err2: SC-F4-03 budget exceeded → rejected before fetch · Boundary: SC-F4-01 content bundle purity assertion · passphrase < 8 chars rejected · vault file present but `secretVault` missing → "需重新设置口令" (no silent reset)

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `storage.local:settings` | new | non-secret config |
| `storage.local:secretVault` | new | vault envelope `{saltB64, ivB64, cipherB64, iterations}` |
| `storage.local:publicPrefs` | new | safe projection for content scripts |
| `storage.local:captureQueue` | new | offline retry queue |
| `storage.local:aiLedger` | new | per-item AI authorization records |

## Feature F5: Provider Layer & AI Client

### Business Context
- **Related**: F4 (keys, redaction, rate limit), F7 (distill), F8 (settings)
- **Impact**: "支持主流模型接入" — must be catalog-driven so a new provider is data, not code

### Implementation Logic
1. `lib/providers.ts` — `PROVIDERS` catalog: `{ id, label, baseUrl, authStyle:'bearer'|'anthropic', defaultModel, models[], requiresTrustAck }` for `openai | deepseek | anthropic | openrouter | iflytek | custom`
2. `isValidBaseUrl(url)` = parseable + `https:` (or `http://localhost|127.0.0.1` for local testing); `requiresTrustAck(url)` = any host other than the catalog defaults
3. `lib/ai-client.ts` — `chat({ fetchImpl, provider, apiKey, baseUrl, model, messages, timeoutMs })`:
   - `bearer` → `POST {baseUrl}/chat/completions`, `Authorization: Bearer`, OpenAI body/response shape
   - `anthropic` → `POST {baseUrl}/messages`, `x-api-key` + `anthropic-version`, `system` hoisted out of `messages`, response `content[].text`
   - `parseChatCompletion` tolerates BOM, nested `data/result/output`, SSE `data:` chunks and NDJSON; `extractAssistantText` tries `choices[0].message.content` → `content[].text` → `text` → `output_text`
   - 15 s `AbortController` timeout, one retry on 429/5xx with backoff, every error mapped to a fixed user-facing string and scrubbed
4. `listModels()` is not fetched in MVP; the catalog ships curated model ids rendered into a `<datalist>` and the field stays free-text

### Edge Cases
- Happy: SC-F5-01 each provider shape parsed from recorded fixtures · Err1: 401/403 → "凭据无效"，no key echo · Err2: timeout → "请求超时，请重试" · Boundary: empty `choices`, SSE partial, huge `content` (cap stored reply length 8 KB) · SC-F5-02 non-HTTPS or untrusted host → block save + runtime permission request

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `settings.aiConfig` | new | `{ providerId, model, baseUrl, trustedHosts[] }` (no key — key lives in the vault) |

## Feature F6: GitHub Store Adapter

### Business Context
- **Related**: F2 (CKF), F3 (codec), F4 (secrets), F7 (distill output), F8 (visibility UI)
- **Impact**: the only authoritative persistence path in the MVP; the seam that keeps other stores possible

### Implementation Logic
1. `lib/store/types.ts` — `KnowledgeStore` contract: `probe()`, `readFile(path)`, `listDir(path)`, `commitFiles(files, message)`, `kind: 'github'`; results are typed discriminated unions, never thrown raw HTTP errors
2. `lib/store/github-api.ts` — `createGithubApi({ fetchImpl, token, owner, repo, branch, apiBase })` with `apiBase` defaulting to `https://api.github.com` (overridable so tests can point at a stub, and so a future Gitea/GitLab adapter is a sibling file):
   - `probeRepo()` → `GET /repos/{o}/{r}` → `{ private, default_branch, permissions: { push } }`
   - `readFile(path)` → `GET /repos/{o}/{r}/contents/{path}?ref={branch}` → decoded text or `null` on 404
   - `listDir(path)` → same endpoint with a directory → `[{ name, path, sha, type }]`
   - `commitFiles(files, message)` → `GET /git/ref/heads/{branch}` → `POST /git/blobs` (utf-8) per file → `POST /git/trees` with `base_tree` → `POST /git/commits` → `PATCH /git/refs/heads/{branch}`; returns `{ sha, html_url }`
   - Error mapping: 401 → `AuthError`, 403 → `ScopeError` (Contents write hint), 404 → `NotFoundError`, 409/422 ref conflict → one re-read + retry, then `ConflictError`
3. `lib/store/github-store.ts` — `GitHubStore implements KnowledgeStore`: wraps the api, applies the codec (F3), enforces the **public-repo guard** (a `probe()` result with `private:false` sets `canWrite:false` unless `publicRepoAcknowledged` is set), and keeps `index.json` consistent inside the same commit
4. Filenames are derived from F2 `paths.ts`; `index.json` is read-modify-written inside the same commit as the content file, so a capture is atomic
5. No retry on 4xx other than the single ref-conflict retry; 429/5xx → one backoff retry

### Edge Cases
- Happy: SC-F6-01 files land in one commit · Err1: SC-F6-03 401/403 → classified, no PATCH attempted · Err2: SC-F6-02 public repo → `canWrite:false` and the write is refused client-side · Boundary: single-file commit (degenerate), 1-byte and 512 KB blobs, empty directory listing, branch missing → `NotFoundError` with a hint · concurrent writer → 409 retry once then report

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `index.json` | created/updated | read-modify-write in the same commit as the content file |
| GitHub commit | created | one commit per capture, message `capture: <title> [<id8>]` |

## Feature F7: Distillation & Authorization Ledger

### Business Context
- **Related**: F2, F5, F6, F1, F8
- **Impact**: satisfies §4.2 "AI 只提案" and §6.2 "AI 外发最小权限 / 账本"

### Implementation Logic
1. `lib/distill.ts` — `buildDistillPrompt(item)` system+user messages demanding a strict JSON object; `parseDistillResult(text)` strips code fences, finds the first balanced JSON object, then validates via `ckf.parseKnowledgeCard`
2. Background `DISTILL_REQUEST`: gate 1 = global `aiAuthorized`, gate 2 = SC-F7-02 ledger entry for this `source_id` (unless the user set "本会话内允许"); then `ai-client.chat` → parse → write `cards/pending/<slug>-<id8>.md`
3. Evidence: the card's `evidence_paths` always contains the source path; the source file is never touched
4. Ledger entry `{ source_id, provider, model, at, purpose:'distill', ok, tokens?: null }` appended to `storage.local:aiLedger` (capped 500, no content, no prompt echo)
5. `distill` is reachable from the popup's Inbox list and from the content panel; there is no automatic distillation

### Edge Cases
- Happy: SC-F7-01 proposal written, source byte-identical · Err1: SC-F7-02 not authorized → no fetch at all (asserted by mock) · Err2: SC-F7-03 malformed JSON → typed error, nothing committed · Boundary: 3 points vs 12 points (validator caps at 12, warns below 3) · provider returns an empty string → rejected

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `KnowledgeCard` | written | `status:'pending'` under `cards/pending/` |
| `storage.local:aiLedger` | append | audit records, no content |

## Feature F8: UI Surfaces (popup console + options)

### Business Context
- **Related**: all features — the only human interface
- **Impact**: friction target "剪藏 ≤ 2 步" and the visibility/consent surfaces

### Implementation Logic
1. `entrypoints/popup/*` — master switch, `剪藏本页` / `剪藏选区`, live status row (store kind · repo · security mode · vault lock · AI authorization), recent Inbox items (from `index.json`, last 5), 打开设置 / 打开最近提交
2. `entrypoints/options/*` — tabbed sections: **模型**（provider select, model free-text + datalist, key input masked/never refilled, trust ack for custom URL）、**存储**（PAT, owner/repo, branch, path prefix, `测试连接`, visibility badge + 公开仓红色硬警告 + typed confirmation）、**安全**（设置/解锁/锁定口令, mode switch, 自动锁定 TTL）、**AI 授权**（全局开关 + per-item ledger 列表 + 清空）、**数据**（导出/重置配置）
3. `lib/i18n.ts` — flat zh_CN/en dictionaries + `t(key, vars)`; popup and options share it; no `_locales` manifest localization
4. All UI talks to the background through `lib/messages.ts`; UI never imports `settings-store` directly, so secrets cannot reach a page context
5. The public-repo warning is rendered from `store.probe()` result and blocks saving the GitHub section until acknowledged

### Edge Cases
- Happy: SC-F8-01 status renders without secrets · Err1: SC-F8-02 probe 401/404/403 → classified messages (token invalid / repo not found / scope missing) · Err2: no PAT configured → 剪藏 button disabled with 引导 · Boundary: very long repo path, CJK page title in the status line · public repo → write blocked even if settings saved earlier

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `publicPrefs` | new | `{ enabled, storeKind, repoFullName, securityMode, hasPat, hasKey, vaultLocked, aiAuthorized }` |

## Feature F9: Build, Tooling & Release

### Business Context
- **Related**: F4 (bundle purity), F1 (commands), F8 (pages)
- **Impact**: what makes the deliverable installable and verifiable

### Implementation Logic
1. `apps/extension/wxt.config.ts` — manifest per blueprint §5: `permissions: [storage, activeTab, scripting, contextMenus]`, `host_permissions` for `api.github.com` + 5 provider hosts, `optional_host_permissions: ["https://*/*"]`, `web_accessible_resources` for popup/options/icons, action with `default_popup` **kept** (unlike the reference, a popup is our primary surface)
2. `scripts/assert-content-no-secrets.mjs` — fails if the built content bundle contains any of `githubPat`, `secretVault`, `local:secretVault`, `providerKey`, `Authorization`; requires the marker `publicPrefs`
3. `scripts/gen-icons.mjs` — deterministic PNG icons (no binary assets in git); `scripts/pack.mjs` — test → build → zip with `--skip-test`
4. Root `package.json` delegates (`npm run dev|build|test|pack|ci`); `Makefile` mirrors it; `.github/workflows/ci.yml` runs `npm ci && npm test && npm run build && npm run assert:content`
5. `tsconfig.json` extends `.wxt/tsconfig.json`, `strict: true`; `vitest.config.ts` includes `lib/**/*.test.ts` and `lib/**/*.int.test.ts`, `environment: node`, `environmentMatchGlobs` upgrades DOM specs to `happy-dom`; `playwright.config.ts` loads the built extension via `launchPersistentContext`

### Edge Cases
- Happy: `npm run ci` green from a clean checkout · Err1: secret string introduced into a content import → assertion fails the build · Err2: WXT prepare missing → `postinstall` covers it · Boundary: `npm run pack --skip-test` still produces zips

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `.github/workflows/ci.yml` | new | test + build + assertion |
| `README.md` | updated | install, pack, security model, store setup |
<!-- END SNAPSHOT -->

---

## [ARCHIVE] 04-design.md · v2 · 2026-09-29 16:30

# Design — GitHub 双授权 · 双向自动同步 · 仓库内可读检索

> Single-file design (`design_split: false`). Feature sections are loaded individually in Phase 3.
> Spec traceability: `08-spec.md` (`SC-F{1..8}-{nn}`) · Tasks: `02-plan.md` · TCs: `05-test-plan.md`.
> Shipped context: the 0.1.0 extension (capture → distill → GitHub, vault/transparent tiers) — its
> design is archived in `04-design-history.md`; this document covers the delta.

## Feature F1: GitAuth Abstraction

### Business Context
- **Related**: F2 (SSH transport), F3 (sync), F5 (settings UI), F6 (layout)
- **Impact**: every remote operation goes through this; it is the only place that knows how credentials are used

### Implementation Logic
1. `lib/auth/types.ts` — `AuthMode = 'token' | 'ssh'`; `GitAuth { mode; describe(): AuthDescriptor; assertReady(): Promise<void>; probe(): Promise<StoreProbe>; createStore(ctx): KnowledgeStore }`. Pure except for the returned store.
2. `lib/auth/token-auth.ts` — wraps the existing `createGitHubStore` path: PAT from the vault, REST transport, `probeRepo` for visibility/scope. Behaviour unchanged from 0.1.0.
3. `lib/auth/ssh-auth.ts` — holds `{ host, user, keyRef }` where `keyRef` is an **identifier the companion resolves** (e.g. `default` or a path the *companion* reports). It never receives key bytes or a passphrase; it calls `native.send('git.probe')` and returns the companion's report.
4. `lib/auth/resolve.ts` — `resolveAuth(settings, availability)` picks the mode, and when the mode is `ssh` and the companion is missing returns an `unavailable` result carrying a reason (`native-missing | protocol-mismatch | git-missing`) instead of throwing, so both the UI and the handlers can degrade predictably.
5. `assertReady()` is the single gate every operation calls first: token → token present + repo configured; ssh → companion available + remote reachable.

### Edge Cases
- Happy: SC-F1-01 (token parity with 0.1.0), SC-F1-03 (ssh through the companion) · Err1: SC-F1-02 companion absent → `nativeUnavailable` code, no request attempted · Err2: token present but SSH selected and companion present while `git` is missing → companion reports `git-missing`, surfaced as a fixed message · Boundary: SC-F1-04 switching modes leaves the other credential intact · Both modes configured but the repo is public → the existing public-repo block still applies in both paths

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `settings.authMode` | new | `'token' \| 'ssh'`, default `'token'` (0.1.0 behaviour preserved) |
| `settings.ssh` | new | `{ host: string; user: string; keyRef: string }`, default `{ host: 'github.com', user: 'git', keyRef: 'default' }` |
| `ErrorCode` | extended | `+ nativeUnavailable \| protocolMismatch \| syncConflict \| indexUnavailable` |

## Feature F2: Native Messaging & Companion Host

### Business Context
- **Related**: F1 (ssh mode), F3 (sync transport), F5 (install hint)
- **Impact**: the only new *deliverable*; also the only new privileged boundary

### Implementation Logic
1. `apps/git-bridge/src/protocol.ts` — versioned envelope `{ v, id, op, args }` / `{ id, ok, data | error, code }`; `PROTOCOL_VERSION = 1`; `ALLOWED_OPS = ['ping','git.probe','git.fetch','git.status','git.commit','git.push','key.list','repo.info']`. **Nothing else is executable.**
2. `apps/git-bridge/src/git.ts` — `runGit(args, { cwd })` via `execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })`, always `-c core.autocrlf=false -c core.safecrlf=false`. No shell, no string interpolation. Every path argument is resolved and asserted to be inside the repository root.
3. `apps/git-bridge/src/main.ts` — stdio framing (4-byte little-endian length + UTF-8 JSON, the native-messaging wire format), strictly one request at a time, no long-lived state, exit on stdin EOF. stderr is reserved for diagnostics and never carries content.
4. `lib/native/protocol.ts` — the same schema on the extension side (grown from one source of truth in `packages/`-style shared folder inside the extension until extraction is justified), plus runtime narrowing for every response.
5. `lib/native/client.ts` — `connectNative` lifecycle: lazy connect, `ping`/version handshake on first use, request/response correlation by `id`, timeout (10 s, 60 s for git ops), auto-reconnect once on disconnect, and a cached `availability` result so the UI can render state without connecting.
6. **Hardening**: `nativeMessaging` permission added to the manifest; the content-bundle assertion additionally forbids native/protocol symbols from appearing in a page context; the companion refuses any `cwd`/repo path outside the configured root and any op not in the allow-list.

### Edge Cases
- Happy: SC-F2-01 handshake succeeds · Err1: SC-F2-01 version mismatch → `protocolMismatch`, connection refused, upgrade hint shown · Err2: SC-F2-02 unknown op or `../` path → rejected, no git run, error recorded · Err3: companion absent → `connectNative` throws immediately → `nativeUnavailable` · Boundary: SC-F2-03 a branch name or path containing spaces/quotes/`;` is passed as a single argv element and never reaches a shell · Large output (a 5 000-file tree listing) → chunked frames, capped per frame at 512 KB

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `apps/git-bridge/native-host-manifest.json` | new | per-OS host manifest template (Chrome `allowed_origins`), installed by the deploy script |
| manifest `permissions` | extended | `+ nativeMessaging`, `+ alarms`, `+ unlimitedStorage` |

## Feature F3: Sync Engine

### Business Context
- **Related**: F1, F2, F4 (index refresh), F5 (status), F6 (layout)
- **Impact**: turns write-only persistence into a two-way client; the highest-risk logic in the requirement

### Implementation Logic
1. `lib/sync/cache.ts` — IndexedDB store `records` keyed by repo path: `{ path, sha, kind, id, updatedAt, record }` (decoded, so search never re-reads the network), plus `syncState` (`{ head, lastSyncAt, lastResult }`) in `storage.local`. `unlimitedStorage` removes the quota worry.
2. `lib/sync/engine.ts` — `sync(reason)`:
   - `auth.assertReady()` → resolve store + transport
   - read remote head (`GET /git/ref/heads/{branch}` or `git.status`)
   - if `head === syncState.head` → return `{ upToDate: true }` (2 requests, SC-F5-01)
   - else compute changed paths (`GET /git/compare/{base}...{head}` for token; `git diff --name-status` for ssh) and fetch only added/modified blobs (SC-F5-02); deleted paths drop from cache + index
   - decode through the active codec; in `vault` mode a locked session aborts with `locked` **before** anything is cached (SC-F5-04)
   - re-index exactly the changed records (F4)
   - push the local dirty set, then update `syncState.head`
3. `lib/sync/reconcile.ts` — pure: `planMerge(localChanges, remoteChanges, base) → MergePlan` with the four/five cases in the blueprint §4.1, including the conflict-copy path name `<slug>-<id>.conflict-<yyyymmddHHMM>.md`.
4. `lib/sync/triggers.ts` — startup (once per session), after every successful capture, `chrome.alarms` interval (default 30 min, `syncIntervalMinutes`, 0 = off), vault unlock, and manual. A single in-flight guard prevents overlapping syncs; a queue of at most one pending reason coalesces bursts.
5. Push path reuses `commitFiles` semantics (`parents` read immediately before the commit) so a moved head is a retry, not a data loss; the ssh path uses `git pull --ff-only` then `git push`, and falls back to the conflict-copy path on a non-fast-forward.

### Edge Cases
- Happy: SC-F5-01 no-op, SC-F5-02 incremental pull, SC-F4-01 push after capture · Err1: SC-F4-02 head moved → retry once, then conflict copy, both versions present · Err2: offline/rate-limited → dirty set stays queued, `lastResult` records the reason, no partial head update · Err3: SC-F5-04 locked vault → abort before caching · Boundary: remote deletes a file we changed locally → resurrect locally and record it · a 1 000-file drift → progress reported, fetch concurrency capped at 4

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| IndexedDB `records` | new | decoded cache, the source for search and for reconcile base comparison |
| IndexedDB `dirty` | new | paths changed locally since the last successful push |
| `storage.local:syncState` | new | `{ head, lastSyncAt, lastResult, conflicts }` |
| `settings.syncPolicy` | new | `{ intervalMinutes, onStartup, onCapture, pullOnly }` |

## Feature F4: Search & Retrieval

### Business Context
- **Related**: F3 (index refresh), F5 (search UI), F6 (readable artefacts)
- **Impact**: this is the "满足最终检索要求" requirement — the storage layout exists to serve it

### Implementation Logic
1. `lib/search/postings.ts` — pure. Document terms from title + summary + points + body + tags + topic, tokenized with the existing `core/dedup.ts` rules (CJK per character, latin per word) **plus CJK bigrams** for precision; postings `term → [{ id, path, field, tf }]`. Sharded by the **first two characters of the term** into `search/<prefix>.json`, so one capture rewrites one small shard (SC-F6-03 keeps them rebuildable).
2. `lib/search/query.ts` — pure. Query parsing (terms, quoted phrases, `tag:` / `topic:` / `in:` filters), scoring = term coverage × field weight (title > tag > point > body) × recency decay, snippet extraction around the best match.
3. `lib/search/index.ts` — orchestration: `upsert(record)`, `remove(path)`, `query(text, opts)`, `rebuild(fromCacheOrRepo)`. Reads from the local cache first; falls back to the repository when the cache is cold (SC-F6-03).
4. `lib/search/docs.ts` — `renderNotesIndex(records)` → the readable `NOTES.md` catalogue (topics with counts, most recent cards, inbox backlog). Regenerated only when a content hash of the catalogue inputs changes, so ordinary captures do not add commit noise.

### Edge Cases
- Happy: SC-F6-01 a latin keyword finds a body match and returns path + snippet · SC-F6-02 a Chinese query finds the record via bigram match · Err1: an empty or punctuation-only query returns no results without error · Err2: a missing/corrupt shard degrades to "rebuild needed" instead of throwing · Boundary: a term in 10 000 records → postings capped per shard with a documented truncation marker; a query matching nothing returns an explicit empty result

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `search/<prefix>.json` | new | readable postings shard, committed with the note that changed |
| `NOTES.md` | new | human-readable catalogue, regenerated only when its inputs change |

## Feature F5: Settings & UI Surfaces

### Business Context
- **Related**: all — this is where the new modes are configured and observed
- **Impact**: makes the difference between "supported" and "usable"

### Implementation Logic
1. `lib/ui/auth-form.ts` (pure) — auth-mode form model: `formToAuthPayload`, `sshFormOf`, `validateSshForm`, `authModeOptions(availability)`, `companionStatusText(availability)`, `branchNotice(branchCheck)`.
2. Options → **存储** gains: an auth-mode tabs/radio (Access token · SSH), the SSH section (host, user, key reference, `测试连接` via `git.probe`, companion status with an install hint when missing), the branch field with a `检查分支` action reporting *exists / missing → create*, and the sync policy (interval, on-startup, on-capture).
3. Options → a new **同步与检索** section: last sync, head, conflicts list with "保留我的版本 / 保留远端版本 / 两者都留", manual sync, rebuild index, search settings.
4. Popup gains: an auth-mode + branch status row, a sync row (last sync · pending · conflicts), `立即同步`, and a search box that queries the index and opens results (the note's commit URL or its file in the repository).
5. All new strings go through `lib/i18n.ts` (both dictionaries) — the parity test keeps them in sync.

### Edge Cases
- Happy: SC-F8-01 status rows render without secrets · Err1: SSH selected with no companion → the mode is visibly disabled with a hint, so the user never reaches a failing save · Err2: `测试连接` with a bad branch → *branch missing* with a create action · Err3: a conflict exists → the count is shown and the resolution actions are reachable · Boundary: a very long branch name or a custom host renders without breaking the layout

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `PublicPrefs` | extended | `+ authMode`, `+ branch`, `+ sync: { lastSyncAt, pending, conflicts }`, `+ companion: 'ok' \| 'missing' \| 'mismatch'` (no secrets) |
| i18n dictionaries | extended | ~40 new keys per language |

## Feature F6: Storage Layout & Migration Safety

### Business Context
- **Related**: F3 (what gets committed), F4 (index), F5 (tier UI)
- **Impact**: satisfies "仓库中可读" without silently changing an existing user's security posture

### Implementation Logic
1. **Default tier becomes `transparent`** for a *new* store: `DEFAULT_SETTINGS.securityMode = 'transparent'`. The encrypted tier keeps its full implementation, its warning and its one-click switch (SC-F7-01).
2. **Existing stores are never rewritten**: `resolveTier()` keeps the mode recorded in `.omnipilot/config.json` when that file exists, so a repository already in `vault` mode stays there and the UI simply shows which tier is active (SC-F7-02). `switchTier` keeps refusing on a non-empty store.
3. `.omnipilot/config.json` gains `branch` and `sync_policy`, so a repository is self-describing for any client that reads it.
4. Path scheme stays readable and is documented in `NOTES.md` (`inbox/YYYY/MM/`, `cards/pending/`, `cards/`, `topics/`, `review/state.json`, `search/`).
5. `index.json` remains the catalogue; `search/` is additive, so a client that ignores `search/` still works (backwards compatibility with 0.1.0 readers).

### Edge Cases
- Happy: SC-F7-01 a new store defaults to readable, SC-F7-03 the catalogue appears when the topic/card set changes · Err1: SC-F7-02 an existing vault repo is opened → mode preserved, no rewrite, tier shown · Err2: a repository written by 0.1.0 (no `search/`, no `branch` in config) is opened → it reads fine, `branch`/`sync_policy` are added on the next write only · Boundary: a repository whose `config.json` is corrupt → treated as "unknown tier" and the user is asked, never guessed

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `.omnipilot/config.json` | extended | `+ branch`, `+ sync_policy`, `+ client_version` |
| `search/` | new tree | postings shards |
| `NOTES.md` | new | readable catalogue |

## [ARCHIVE] 04-design.md · v3 · 2026-09-29T18:10:00+08:00

# Design — GitHub 双授权 · 双向自动同步 · 仓库内可读检索

> Single-file design (`design_split: false`). Feature sections are loaded individually in Phase 3.
> Spec traceability: `08-spec.md` (`SC-F{1..8}-{nn}`) · Tasks: `02-plan.md` · TCs: `05-test-plan.md`.
> Shipped context: the 0.1.0 extension (capture → distill → GitHub, vault/transparent tiers) — its
> design is archived in `04-design-history.md`; this document covers the delta.

## Feature F1: GitAuth Abstraction

### Business Context
- **Related**: F2 (SSH transport), F3 (sync), F5 (settings UI), F6 (layout)
- **Impact**: every remote operation goes through this; it is the only place that knows how credentials are used

### Implementation Logic
1. `lib/auth/types.ts` — `AuthMode = 'token' | 'ssh'`; `GitAuth { mode; describe(): AuthDescriptor; assertReady(): Promise<void>; probe(): Promise<StoreProbe>; createStore(ctx): KnowledgeStore }`. Pure except for the returned store.
2. `lib/auth/token-auth.ts` — wraps the existing `createGitHubStore` path: PAT from the vault, REST transport, `probeRepo` for visibility/scope. Behaviour unchanged from 0.1.0.
3. `lib/auth/ssh-auth.ts` — holds `{ host, user, keyRef }` where `keyRef` is an **identifier the companion resolves** (e.g. `default` or a path the *companion* reports). It never receives key bytes or a passphrase; it calls `native.send('git.probe')` and returns the companion's report.
3b. `lib/store/git-transport.ts` (**added 2026-09-29**) — the ssh mode's `KnowledgeStore`. Reads target the
   **remote-tracking** ref (`origin/<branch>`), so a pull sees what the remote has rather than whatever the
   local working tree happens to contain; `refresh()` (delegating to `git.fetch`) runs first. A `notFound`
   from the companion becomes `null` — on a first pull most paths are legitimately absent. `commitFiles`
   writes, commits **and pushes** in that order, so a rejected push rejects the promise and the caller keeps
   the paths in the dirty set (that is what makes SC-F4-01 leave it queued rather than dropping it).
4. `lib/auth/resolve.ts` — `resolveAuth(settings, availability)` picks the mode, and when the mode is `ssh` and the companion is missing returns an `unavailable` result carrying a reason (`native-missing | protocol-mismatch | git-missing`) instead of throwing, so both the UI and the handlers can degrade predictably.
5. `assertReady()` is the single gate every operation calls first: token → token present + repo configured; ssh → companion available + remote reachable.

### Edge Cases
- Happy: SC-F1-01 (token parity with 0.1.0), SC-F1-03 (ssh through the companion) · Err1: SC-F1-02 companion absent → `nativeUnavailable` code, no request attempted · Err2: token present but SSH selected and companion present while `git` is missing → companion reports `git-missing`, surfaced as a fixed message · Boundary: SC-F1-04 switching modes leaves the other credential intact · Both modes configured but the repo is public → the existing public-repo block still applies in both paths

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `settings.authMode` | new | `'token' \| 'ssh'`, default `'token'` (0.1.0 behaviour preserved) |
| `settings.ssh` | new | `{ host: string; user: string; keyRef: string }`, default `{ host: 'github.com', user: 'git', keyRef: 'default' }` |
| `ErrorCode` | extended | `+ nativeUnavailable \| protocolMismatch \| syncConflict \| indexUnavailable` |

## Feature F2: Native Messaging & Companion Host

### Business Context
- **Related**: F1 (ssh mode), F3 (sync transport), F5 (install hint)
- **Impact**: the only new *deliverable*; also the only new privileged boundary

### Implementation Logic
1. `apps/git-bridge/src/protocol.ts` — versioned envelope `{ v, id, op, args }` / `{ id, ok, data | error, code }`; `PROTOCOL_VERSION = 1`; `ALLOWED_OPS = ['ping','repo.info','git.probe','git.status','git.fetch','git.show','git.ls','git.write','git.commit','git.push','key.list']`. **Nothing else is executable.**
1b. **Content channel (added 2026-09-29).** The original seven ops could drive git but could not move a note's
   bytes: `git.commit` only stages paths that already exist in the clone, so SSH mode could neither push nor
   pull content — the four requirements were unreachable in that mode. Three ops close the hole, all confined
   by `assertArgsSafe` + `resolveInsideRoot`:

   | Op | Request | Response | Cap |
   |----|---------|----------|-----|
   | `git.show` | `{ rev, path }` | `{ content, bytes }` | 512 KiB per object; absent ⇒ `notFound` |
   | `git.ls` | `{ rev, dir }` | `{ entries: [{ path, type, sha, size }] }` | — |
   | `git.write` | `{ message, files: [{ path, content }] }` | `{ sha, paths }` | 512 KiB/file, 700 KiB/request |

   `rev` is shape-checked (ASCII, no leading `-`, no `..` segment) because it is an argv fragment even though
   it is not a path. `git.write` **is a write primitive on the privileged boundary**: it materialises bytes
   under `repoRoot` only (re-checked inside `git.ts`, not just in the dispatcher), never through a shell, and
   is idempotent — when the index already matches it returns the current HEAD instead of creating an empty
   commit, so a retry after a rejected push is safe. `notFound` is a distinct error code so that the remote
   not having a path is never reported as a failure.
2. `apps/git-bridge/src/git.ts` — `runGit(args, { cwd })` via `execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })`, always `-c core.autocrlf=false -c core.safecrlf=false`. No shell, no string interpolation. Every path argument is resolved and asserted to be inside the repository root.
3. `apps/git-bridge/src/main.ts` — stdio framing (4-byte little-endian length + UTF-8 JSON, the native-messaging wire format), strictly one request at a time, no long-lived state, exit on stdin EOF. stderr is reserved for diagnostics and never carries content.
4. `lib/native/protocol.ts` — the same schema on the extension side (grown from one source of truth in `packages/`-style shared folder inside the extension until extraction is justified), plus runtime narrowing for every response.
5. `lib/native/client.ts` — `connectNative` lifecycle: lazy connect, `ping`/version handshake on first use, request/response correlation by `id`, timeout (10 s, 60 s for git ops), auto-reconnect once on disconnect, and a cached `availability` result so the UI can render state without connecting.
6. **Hardening**: `nativeMessaging` permission added to the manifest; the content-bundle assertion additionally forbids native/protocol symbols from appearing in a page context; the companion refuses any `cwd`/repo path outside the configured root and any op not in the allow-list.

### Edge Cases
- Happy: SC-F2-01 handshake succeeds · Err1: SC-F2-01 version mismatch → `protocolMismatch`, connection refused, upgrade hint shown · Err2: SC-F2-02 unknown op or `../` path → rejected, no git run, error recorded · Err3: companion absent → `connectNative` throws immediately → `nativeUnavailable` · Boundary: SC-F2-03 a branch name or path containing spaces/quotes/`;` is passed as a single argv element and never reaches a shell · Large output (a 5 000-file tree listing) → chunked frames, capped per frame at 512 KB

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `apps/git-bridge/native-host-manifest.json` | new | per-OS host manifest template (Chrome `allowed_origins`), installed by the deploy script |
| manifest `permissions` | extended | `+ nativeMessaging`, `+ alarms`, `+ unlimitedStorage` |

## Feature F3: Sync Engine

### Business Context
- **Related**: F1, F2, F4 (index refresh), F5 (status), F6 (layout)
- **Impact**: turns write-only persistence into a two-way client; the highest-risk logic in the requirement

### Implementation Logic
1. `lib/sync/cache.ts` — IndexedDB store `records` keyed by repo path: `{ path, sha, kind, id, updatedAt, record }` (decoded, so search never re-reads the network), plus `syncState` (`{ head, lastSyncAt, lastResult }`) in `storage.local`. `unlimitedStorage` removes the quota worry.
2. `lib/sync/engine.ts` — `sync(reason)`:
   - `auth.assertReady()` → resolve store + transport
   - read remote head (`GET /git/ref/heads/{branch}` or `git.status`)
   - if `head === syncState.head` → return `{ upToDate: true }` (2 requests, SC-F5-01)
   - else compute changed paths (`GET /git/compare/{base}...{head}` for token; `git diff --name-status` for ssh) and fetch only added/modified blobs (SC-F5-02); deleted paths drop from cache + index
   - decode through the active codec; in `vault` mode a locked session aborts with `locked` **before** anything is cached (SC-F5-04)
   - re-index exactly the changed records (F4)
   - push the local dirty set, then update `syncState.head`
3. `lib/sync/reconcile.ts` — pure: `planMerge(localChanges, remoteChanges, base) → MergePlan` with the four/five cases in the blueprint §4.1, including the conflict-copy path name `<slug>-<id>.conflict-<yyyymmddHHMM>.md`.
4. `lib/sync/triggers.ts` — startup (once per session), after every successful capture, `chrome.alarms` interval (default 30 min, `syncIntervalMinutes`, 0 = off), vault unlock, and manual. A single in-flight guard prevents overlapping syncs; a queue of at most one pending reason coalesces bursts.
5. Push path reuses `commitFiles` semantics (`parents` read immediately before the commit) so a moved head is a retry, not a data loss; the ssh path uses `git pull --ff-only` then `git push`, and falls back to the conflict-copy path on a non-fast-forward.

### Edge Cases
- Happy: SC-F5-01 no-op, SC-F5-02 incremental pull, SC-F4-01 push after capture · Err1: SC-F4-02 head moved → retry once, then conflict copy, both versions present · Err2: offline/rate-limited → dirty set stays queued, `lastResult` records the reason, no partial head update · Err3: SC-F5-04 locked vault → abort before caching · Boundary: remote deletes a file we changed locally → resurrect locally and record it · a 1 000-file drift → progress reported, fetch concurrency capped at 4

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| IndexedDB `records` | new | decoded cache, the source for search and for reconcile base comparison |
| IndexedDB `dirty` | new | paths changed locally since the last successful push |
| `storage.local:syncState` | new | `{ head, lastSyncAt, lastResult, conflicts }` |
| `settings.syncPolicy` | new | `{ intervalMinutes, onStartup, onCapture, pullOnly }` |

## Feature F4: Search & Retrieval

### Business Context
- **Related**: F3 (index refresh), F5 (search UI), F6 (readable artefacts)
- **Impact**: this is the "满足最终检索要求" requirement — the storage layout exists to serve it

### Implementation Logic
1. `lib/search/postings.ts` — pure. Document terms from title + summary + points + body + tags + topic, tokenized with the existing `core/dedup.ts` rules (CJK per character, latin per word) **plus CJK bigrams** for precision; postings `term → [{ id, path, field, tf }]`. Sharded by the **first two characters of the term** into `search/<prefix>.json`, so one capture rewrites one small shard (SC-F6-03 keeps them rebuildable).
2. `lib/search/query.ts` — pure. Query parsing (terms, quoted phrases, `tag:` / `topic:` / `in:` filters), scoring = term coverage × field weight (title > tag > point > body) × recency decay, snippet extraction around the best match.
3. `lib/search/index.ts` — orchestration: `upsert(record)`, `remove(path)`, `query(text, opts)`, `rebuild(fromCacheOrRepo)`. Reads from the local cache first; falls back to the repository when the cache is cold (SC-F6-03).
4. `lib/search/docs.ts` — `renderNotesIndex(records)` → the readable `NOTES.md` catalogue (topics with counts, most recent cards, inbox backlog). Regenerated only when a content hash of the catalogue inputs changes, so ordinary captures do not add commit noise.

### Edge Cases
- Happy: SC-F6-01 a latin keyword finds a body match and returns path + snippet · SC-F6-02 a Chinese query finds the record via bigram match · Err1: an empty or punctuation-only query returns no results without error · Err2: a missing/corrupt shard degrades to "rebuild needed" instead of throwing · Boundary: a term in 10 000 records → postings capped per shard with a documented truncation marker; a query matching nothing returns an explicit empty result

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `search/<prefix>.json` | new | readable postings shard, committed with the note that changed |
| `NOTES.md` | new | human-readable catalogue, regenerated only when its inputs change |

## Feature F5: Settings & UI Surfaces

### Business Context
- **Related**: all — this is where the new modes are configured and observed
- **Impact**: makes the difference between "supported" and "usable"

### Implementation Logic
1. `lib/ui/auth-form.ts` (pure) — auth-mode form model: `formToAuthPayload`, `sshFormOf`, `validateSshForm`, `authModeOptions(availability)`, `companionStatusText(availability)`, `branchNotice(branchCheck)`.
2. Options → **存储** gains: an auth-mode tabs/radio (Access token · SSH), the SSH section (host, user, key reference, `测试连接` via `git.probe`, companion status with an install hint when missing), the branch field with a `检查分支` action reporting *exists / missing → create*, and the sync policy (interval, on-startup, on-capture).
3. Options → a new **同步与检索** section: last sync, head, conflicts list with "保留我的版本 / 保留远端版本 / 两者都留", manual sync, rebuild index, search settings.
4. Popup gains: an auth-mode + branch status row, a sync row (last sync · pending · conflicts), `立即同步`, and a search box that queries the index and opens results (the note's commit URL or its file in the repository).
5. All new strings go through `lib/i18n.ts` (both dictionaries) — the parity test keeps them in sync.

### Edge Cases
- Happy: SC-F8-01 status rows render without secrets · Err1: SSH selected with no companion → the mode is visibly disabled with a hint, so the user never reaches a failing save · Err2: `测试连接` with a bad branch → *branch missing* with a create action · Err3: a conflict exists → the count is shown and the resolution actions are reachable · Boundary: a very long branch name or a custom host renders without breaking the layout

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `PublicPrefs` | extended | `+ authMode`, `+ branch`, `+ sync: { lastSyncAt, pending, conflicts }`, `+ companion: 'ok' \| 'missing' \| 'mismatch'` (no secrets) |
| i18n dictionaries | extended | ~40 new keys per language |

## Feature F6: Storage Layout & Migration Safety

### Business Context
- **Related**: F3 (what gets committed), F4 (index), F5 (tier UI)
- **Impact**: satisfies "仓库中可读" without silently changing an existing user's security posture

### Implementation Logic
1. **Default tier becomes `transparent`** for a *new* store: `DEFAULT_SETTINGS.securityMode = 'transparent'`. The encrypted tier keeps its full implementation, its warning and its one-click switch (SC-F7-01).
2. **Existing stores are never rewritten**: `resolveTier()` keeps the mode recorded in `.omnipilot/config.json` when that file exists, so a repository already in `vault` mode stays there and the UI simply shows which tier is active (SC-F7-02). `switchTier` keeps refusing on a non-empty store.
3. `.omnipilot/config.json` gains `branch` and `sync_policy`, so a repository is self-describing for any client that reads it.
4. Path scheme stays readable and is documented in `NOTES.md` (`inbox/YYYY/MM/`, `cards/pending/`, `cards/`, `topics/`, `review/state.json`, `search/`).
5. `index.json` remains the catalogue; `search/` is additive, so a client that ignores `search/` still works (backwards compatibility with 0.1.0 readers).

### Edge Cases
- Happy: SC-F7-01 a new store defaults to readable, SC-F7-03 the catalogue appears when the topic/card set changes · Err1: SC-F7-02 an existing vault repo is opened → mode preserved, no rewrite, tier shown · Err2: a repository written by 0.1.0 (no `search/`, no `branch` in config) is opened → it reads fine, `branch`/`sync_policy` are added on the next write only · Boundary: a repository whose `config.json` is corrupt → treated as "unknown tier" and the user is asked, never guessed

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `.omnipilot/config.json` | extended | `+ branch`, `+ sync_policy`, `+ client_version` |
| `search/` | new tree | postings shards |
| `NOTES.md` | new | readable catalogue |

## [ARCHIVE] 04-design.md · v4 · 2026-09-29T19:00:00+08:00

---
version: 4
previous_version: 3
artifact: 04-design.md
requirement_id: req-2026-09-29-synapse-workflow-elegance
design_split: false
last_updated: 2026-09-29T18:20:00+08:00
history_ref: 04-design-history.md
---

# Design — 设计理念入文档 · 全量功能审计 · 统一优化

> 每个 Feature 必须回答 **工作流与协作四问**（R1 的落地形式，本文件即范式）：
> ① 用户此刻在知识工作流的哪一步？② 这一步谁做决定（人还是 AI）？③ 决定后产物去哪、能不能撤回？
> ④ 失败时用户 3 秒内知道该做什么吗？答不出就不是一个完整的设计。

## Feature F1: 判据门禁文档

### Business Context
- **Related**: 所有 Feature；评审与 Phase 1/2 的输入
- **Impact**: 把理念从"人脑里的偏好"变成可指认的判据，否则每次都要重新争论

### Implementation Logic
1. 新增 `docs/product/00-design-principles.md`：理念表述 → 6 条判据（W1–W6，每条含"判定问题"+"当前反例"）→ 每个 Feature 必答四问 → CR 条目。
2. 判据必须**可判定**：能指着具体实现回答是/否。不可判定的表述不许进文档（如"体验要好"）。
3. 新增 `AGENTS.md`：非协商规则（安全 P0、判据门禁、证据要求、不新增依赖）+ 指向判据文档。
4. `README.md` 增一句立场并指向文档；`04-design.md` 增必答节（本文件即是）。

### 工作流与协作
① 横切全部阶段 ② 人（评审者）③ 产品是文档，可修订并留档 ④ 文档缺失/漂移由 `AGENTS.md` + CR 条目兜住

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `docs/product/00-design-principles.md` | new | 判据 + 反例 + 必答四问 + CR 清单 |
| `AGENTS.md` | new | 非协商规则；指向判据文档 |

## Feature F2: 全量功能审计

### Business Context
- **Related**: R3 的全部修复项由它产出
- **Impact**: 没有审计基线，"统一优化"就会退化成凭印象改几处

### Implementation Logic
1. 枚举基线三张表：`REQUEST_TYPES`（26 项，逐项判定可达性与出口）、CKF 4 类记录（是否被生产路径创建/渲染/更新）、
   工作流 6 阶段（Capture→Inbox→Distill→Place→Retrieve→Review，每阶段的进入/处理/离开是否存在）。
2. 每条结论一行证据：`file:line` + 判据编号（W#）+ 结论（OK / 断裂 / 死代码 / 无出口 / 静默失败）。
3. 单列四类问题（死代码、从未被创建的记录类型、无出口状态、静默失败路径），每项给 P0/P1/P2 与理由。
4. 每条修复项写明"修完如何验证"（测试 ID 或命令），使其同时成为回归清单。

### 工作流与协作
① 横切 ② 人（评审者决定优先级）③ 报告入库、带行号可复核 ④ 过期由判据门禁触发重审

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `docs/audits/00-functional-audit.md` | new | 三张枚举表 + 证据 + 四类问题 + 优先级 |

## Feature F3: 提案闭环 — 待确认卡片可见、可决定（P0-1）

### Business Context
- **Related**: F7（卡片被接受后才谈得上复习）、R2 的头号发现
- **Impact**: 现状是"AI 提案 → 一条 git 路径通知 → 人没有被给予决定的地方"，AI 协作价值链在此断掉

### Implementation Logic
1. **契约（Phase 2 冻结）**：`cards.list` `{limit?}` → `{cards:[{id,path,title,summary,points,tags,topic?,created_at}]}`；
   `card.decide` `{id,path,action:'accept'|'edit'|'discard',patch?}` → `{card?,path}`。两者进 `SECRET_BEARING_TYPES` + 限流预算。
2. **accept**：`card.status='confirmed'` → 路径改为 `cards/`（pending 时是 `cards/pending/`，由 codec 依据 status 推导）；
   同一次提交内更新 index 与 shards；成功后写 `review/state.json`（ReviewState 首次真正被创建，due = now + 1d）。
3. **edit**：白名单字段 `title/summary/points/tags` + 长度上限，重新编码到原路径（仍 pending）+ 索引 + shards，一次提交。
4. **discard**：移入 `archive/cards/<原相对路径>`，索引移除、shards 清除，一次提交 —— **归档而非删除**。
5. **vault 模式**：必须过 codec（decode → 改 → encodeRecord）；锁定时拒绝并提示解锁（同 SC-F5-04 规则），不缓存密文当明文。
6. **界面**：popup 新增"待处理"区（标题/摘要/要点/来源链接 + 接受·改写·丢弃三动作），空态明确显示"没有待处理"。

### Edge Cases
- Happy：一张 pending 卡片被接受 → 离开 pending、进入 cards/、并出现在复习队列
- Err1：卡片 id 存在但 path 不符（别处改过）→ 以 path 为准并在响应返回实际路径，不静默
- Err2：vault 锁定 → `locked`，不写任何字节
- Err3：`cards.list` 读索引失败 → 返回空列表 + 标记，不抛异常
- Boundary：100 张 pending → 分页上限；一次请求只处理一张卡片

### 工作流与协作
① Distill→Place 之间 ② **人在此决定**（AI 只提案一次）③ 产物进 `cards/` 或 `archive/cards/`，两处都可再改（各自一次提交）④ 失败映射到 F5 指引

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `REQUEST_TYPES` | +2 | `cards.list` / `card.decide` |
| `KnowledgeCard.status` | 首次真正被改写 | pending → confirmed 触发路径迁移 |
| `ReviewState` | 首次被创建 | 接受卡片时写 `review/state.json` |
| 仓库路径 | +1 | `archive/cards/**` |

## Feature F4: 冲突决策面（P0-2）

### Business Context
- **Related**: 与 F3 同类的"无出口状态"，发生在同步路径上
- **Impact**: `.conflict-<stamp>.md` 保住了数据却制造噪音；用户需要一个"一次决定"的地方

### Implementation Logic
1. `sync.status` 的 `conflicts` 扩展为每项 `{path, conflictPath, mine:{updatedAt,bytes}, theirs:{updatedAt,bytes}, readable}`；
   `readable=false` 表示 vault 未解锁（不给正文，只给可否比较）。
2. 新类型 `conflict.resolve` `{path,conflictPath,action}`（进 `SECRET_BEARING_TYPES` + 限流）：
   - `keep-mine`：本地版本写回主路径，远端版本移入 `archive/conflicts/<path>`；一次提交。
   - `keep-remote`：主路径保持远端版本，本地版本移入 `archive/conflicts/<path>`；一次提交。
   - `keep-both`：`.conflict-` 兄弟文件移入 `archive/conflicts/<path>.conflict-<stamp>`，主路径不再有噪音，两个索引项都保留。
3. 三种动作都把该 path 从 `syncState.conflicts` 移除并刷新 shards；归档件不进 `NOTES.md` 目录。
4. **界面**：同步页签冲突行给双方摘要 + 三选一；完成后回到"无冲突"。

### Edge Cases
- Happy：两侧都改过 → 决策后主路径唯一，归档件仍可找回
- Err1：vault 锁定 → 允许 `keep-both`（无需读内容），需要读内容的两项拒绝并提示解锁
- Err2：决策执行时远端又变 → 提交冲突保留 dirty，下次同步再决策（不吞）
- Boundary：同一分钟内多次冲突 → 归档名带 stamp，互不覆盖

### 工作流与协作
① 同步阶段（Retrieve/Review 之前）② **人在此决定**（默认不动，等决定）③ 胜者占主路径、败者进 `archive/conflicts/` 可再取回 ④ 失败走 F5

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `sync.status` payload | extended | `conflicts[]` 带双方摘要与可读性 |
| `REQUEST_TYPES` | +1 | `conflict.resolve` |
| 仓库路径 | +1 | `archive/conflicts/**` |

## Feature F5: 失败可读化（P1-1）

### Business Context
- **Related**: F3/F4 的错误出口；判据 W6
- **Impact**: 现在失败只显示一个词；`status.ts` 刻意不渲染原始错误（保留这项卫生决策），但没有替代品

### Implementation Logic
1. `lib/status.ts` 增 `errorGuidance(code)` → `{titleKey, actionKey, target}`，`target ∈ {storage, sync, unlock, retry, companion}`。
2. `StatusLine` 增 `lastFailure`（code + 翻译键 + 目标 + 时间），**不含**原始文本/路径/内容。
3. `lib/i18n.ts` 为每个 `ErrorCode` 增双语两条键（标题 + 该做什么），parity 测试兜住。
4. 状态行渲染"最近失败：<标题> · [去处理]"；`retry` 目标直接触发 `sync.now`，其余跳到对应设置页签。

### Edge Cases
- Happy：离线同步失败 → "网络不可用，稍后自动重试" + 一键重试
- Err1：未知错误码 → 通用文案，永不显示原文
- Boundary：连续失败 → 只显示最近一次

### 工作流与协作
① 横切（任何后台动作失败）② 人（知道该做什么）③ 无产物变更 ④ 本条就是对 W6 的回答

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `StatusLine` | extended | `lastFailure` |
| `lib/i18n.ts` | +N | 每个 ErrorCode 的双语指引 |

## Feature F6: SSH 克隆引导（P1-2）

### Business Context
- **Related**: F5（companion 未装、克隆缺失都是失败路径）
- **Impact**: "SSH 需要本地克隆"是不可消除的物理事实，但只在 UI 声明一句等于把工作留给用户

### Implementation Logic
1. `lib/ui/auth-form.ts` 增纯函数 `cloneCommand(remoteUrl, repoRoot)` → `git clone <remote> <root>`（remote 用用户自己的 owner/repo 拼）。
2. options 存储页在 SSH 区块展示该命令 + 一键复制 + 克隆路径校验（绝对路径、非空、不与仓库根冲突）。
3. 保存/探测时若 `git.probe` 返回的 root 与填写路径不一致 → 明确说"这个路径不是仓库"，不泛泛失败。

### Edge Cases
- Happy：填路径 → 命令可复制 → 探测通过
- Err1：路径不存在 → 明确提示，命令仍可复制
- Boundary：Windows 反斜杠路径也要给出可复制命令

### 工作流与协作
① 配置阶段 ② 人（复制并执行）③ 无产物变更 ④ 探测失败映射到 F5

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `lib/ui/auth-form.ts` | extended | `cloneCommand` / `repoRootError` |

## Feature F7: 本地主动性 — 去重提示 / 归属建议 / 复习队列（P2-1，仅本地规则）

### Business Context
- **Related**: F3（卡片被接受后才谈得上复习）；判据 W2/W5
- **Impact**: 把 `Topic` / `ReviewState` 两个"死类型"变成工作流的一部分；全程零出网

### Implementation Logic
1. `lib/local/insights.ts`（纯函数）：`recallHint`（复用 dedup keys + 词项重叠）、`suggestTopic`（top-1 重叠 + 阈值，低于阈值给"无建议"）、
   `dueForReview`（简化 SM-2：间隔 × 易度）。
2. `review/state.json` 由 F3 的 accept 首次写入；`dueForReview` 只读它 + 卡片标签。
3. 呈现：popup 待处理区显示"今天该复习 N 条"与列表；捕获命中历史时提示"你 X 前存过相似内容"（**不阻塞捕获**）。
4. **不使用模型、不联网**；生成式建议与语义检索进 `open backlog`（下一需求）。

### Edge Cases
- Happy：重复捕获 → 命中提示；卡片接受 → 次日进入复习队列
- Err1：无缓存/索引 → 静默跳过，不报错不阻塞
- Boundary：相似度并列 → 显示"无建议"（宁可不说，也不误导）

### 工作流与协作
① Retrieve / Review ② AI（本地规则）建议、**人**决定 ③ 提示不写数据；复习状态由人的接受动作产生 ④ 失败静默跳过且不阻塞捕获

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| `ReviewState` | 首次被读取 | `dueForReview` 计算复习队列 |
| `lib/local/insights.ts` | new | 三个纯函数 + 测试 |

## Feature F8: 首启显式选择加密取舍（P2-2）

### Business Context
- **Related**: 判据 W4（可理解）、F6 的配置流程
- **Impact**: 现状替用户默认了透明仓；对个人私密笔记，这个默认应由用户拍板

### Implementation Logic
1. 首次进入存储配置（store config 不存在且从未选择）→ 渲染一步：两个选项各配一句人话后果
   （透明仓="仓库里直接可读，托管方能看全部" / 保险库="托管方看不到内容，需要本设备口令"）。
2. 选择写入 store config（`saveStoreConfig`）；不选不给过（不静默默认）。
3. 已存在的仓库继续遵从其 config（`resolveTier` 既有规则不变）。

### Edge Cases
- Happy：首启选择 → config 落盘 → 后续遵从
- Err1：已有内容但无 config → 沿用 fail-closed（vault）+ 要求确认
- Boundary：中途离开 → 下次进入仍是这一步（未完成可恢复）

### 工作流与协作
① 配置阶段 ② **人**选择 ③ 写 config，可改（切换走既有 `switchTier`）④ 失败映射 F5

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| options 首启流程 | new | 一步显式选择 |
| `StoreConfig.security_mode` | shape 不变 | 由显式选择写入 |

## 数据变更汇总（本需求）

| 类别 | 变更 |
|------|------|
| 新 request type | `cards.list` · `card.decide` · `conflict.resolve`（全部 SECRET_BEARING + 限流） |
| 扩展 payload | `sync.status.conflicts[]` · `StatusLine.lastFailure` |
| 新仓库路径 | `archive/cards/**` · `archive/conflicts/**`（不进 NOTES.md 目录） |
| 首次激活的既有类型 | `KnowledgeCard.status` 流转 · `ReviewState` 读写 |
| 配置 | `.omnipilot/config.json` 结构不变（首次由用户显式选择写入） |
| 依赖 | **零新增** |

