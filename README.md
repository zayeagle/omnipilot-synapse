# OmniPilot Synapse

Intelligent multi-domain knowledge management and governance — capture from WeChat and browser,
systematically organize and govern personal knowledge, AI-distill key points, and spaced-review for
retention. Pluggable storage: Git, self-hosted DB, or local files.

> **Status**: browser-extension MVP. Capture → Inbox → opt-in AI distill → **GitHub** as the single
> authoritative store. The WeChat Mini Program, a self-hosted database and local-filesystem storage
> are designed for but not implemented yet (see [Requirements](docs/requirements/00-requirements.md)).

> **产品立场**：笔记软件的竞争力不在功能多少，而在两件事——是否真正懂用户怎么思考、怎么积累知识；
> AI 介入的方式是否让人舒服、不添乱。这条立场有可判定的判据、每个 Feature 的必答四问与 CR 门禁：
> [docs/product/00-design-principles.md](docs/product/00-design-principles.md)。

## Why this exists

The requirement is not "another notes app" but a pipeline that closes four gaps:
multi-source capture → placing material into a system → AI distillation of reusable points →
active review. This repository implements the **capture end** of that loop, with the security
posture the requirements demand: your data lives in a repository *you* own, and the browser
extension treats every credential as radioactive.

## What works today

| Capability | Notes |
|---|---|
| Selection bubble + right-click + popup capture | `剪藏` (clip) and `提炼` (capture **and** distill) |
| Inbox in a GitHub repository | `inbox/YYYY/MM/`, date-partitioned, atomic commits |
| Canonical Knowledge Format | Markdown + YAML frontmatter, adapter-agnostic, no vendor lock |
| Duplicate detection | canonical-URL key + content fingerprint; a repeat capture writes nothing |
| Content tiers | **透明仓** (plain Markdown) or **保险库** (AES-GCM) — asked **once, explicitly**, the first time you save 存储: 保存 stays disabled until you answer, and the answer is recorded in the repository itself (`.omnipilot/config.json`). An absent or unreadable store config fails **closed** to vault — one unreadable byte never downgrades an encrypted repository to plaintext. |
| Two authorization modes | **access token** (GitHub REST) or **SSH** through a local companion process driving your own `git`/`ssh`. No key material ever reaches the extension. SSH shows the exact `git clone` command for your remote with one click to copy it, and refuses a relative or `..`-bearing clone path on the settings screen instead of failing later in your terminal. |
| Branch selection | `main` by default, overridable in 存储; validated against the remote with a create action when it does not exist. |
| Automatic push **and** pull | A local decoded cache plus a reconciliation engine: remote drift is pulled, local changes are pushed, and both versions survive a conflict as a `<name>.conflict-<stamp>.md` sibling. |
| Retrieval | Keyword index (`search/*.json` shards, CJK bigrams) + a readable `NOTES.md` catalogue; the shards are committed in the same commit as the note they index. |
| Mainstream model providers | OpenAI · DeepSeek · Anthropic · OpenRouter · iFlytek Spark · custom |
| Distillation | strict-JSON knowledge-card *proposals* under `cards/pending/` — never rewrites your text. A proposal is now **listed in the product** with 接受 / 改写 / 丢弃: accepting moves it out of `pending/`, discarding **archives** it under `archive/cards/`, and the path it left behind carries a signpost saying where the content went. |
| Conflict decisions | When a note changed on both sides, the sync keeps **both** versions — and the 同步 tab turns that into a decision: 保留我的 / 保留远端 / 两者都留. The winner takes the original path, the loser is archived under `archive/conflicts/`, and 两者都留 reads nothing, so it works with a locked vault. |
| Review queue | Accepting a card also creates its review record (`review/state.json` — cleartext, no content), and `review.due` reads it back: the notes you are about to forget, without asking the network or the vault. |
| Failure you can act on | A background failure reports a **translated cause and the one action that fixes it** (unlock the vault, install the companion, re-enter the token…). The worker's own error sentence is never rendered. |
| Secret custody | PBKDF2-SHA256 → AES-GCM vault, session unlock, no persisted passphrase |
| Offline tolerance | captures queue and replay when the network (or the vault) is back |

**Verification status**: 600 unit + 120 integration (extension) and 48 unit + 8 system (companion) tests pass, plus a
**19 Playwright end-to-end tests** covering capture, distill, sync drift/no-op/conflict, the three-way conflict decision, the proposal decision surface, the review queue, the first-run tier gate, SSH degradation and search;
`npm run ci` and `npm run ci:all` are green.
See the [test report](docs/omnidev-state/main/05-test-report.md) and
[security audit](docs/omnidev-state/main/07-security-audit.md).

## Security model

Read this before pointing the extension at a repository.

| Control | How it works |
|---|---|
| **Only the background worker is trusted** | Page-context code can read the page and ask for a capture. It cannot read settings or secrets; a build assertion fails if that ever changes. |
| **The vault is the only place a credential is written** | GitHub token and provider keys live in one AES-GCM envelope (`local:secretVault`). There is no plaintext fallback — a locked vault refuses to write. |
| **Vault mode hides content *and* metadata** | Content is encrypted; file paths use a record id instead of a title slug; the canonical URL is stored as a fingerprint; commit messages carry no title. |
| **Public repositories are blocked** | The extension probes visibility and refuses to save or write until you explicitly acknowledge the risk. |
| **Custom endpoints require a trust acknowledgement** | HTTPS only (loopback excepted for local testing), and the worker re-checks trust, not just the UI. |
| **AI egress is opt-in and ledgered** | Off by default. Only the item you explicitly act on is sent, in plaintext, and every request is recorded in an audit ledger with no content. |
| **Errors are scrubbed** | Anything that could echo a token is redacted before it reaches a log, a toast or storage. |
| **The companion is a narrow, confined boundary** | It executes an allow-listed set of `git` operations (`repo.info`, `git.probe/status/fetch/show/ls/write/commit/push`, `key.list`), always via `execFile` with an argv array — never a shell. Every path is realpath-confined to the configured clone, and the write primitive additionally refuses the repository's own git metadata (`.git/**`, case-insensitively): writing there would install a hook the next `git commit` executes. `key.list` returns identifiers derived from file names; the process has no operation that reads or transmits key material. |

**Residual risks you own**: a public repository is unrecoverable once written; losing the vault
passphrase loses encrypted content; a compromised browser profile can read extension storage; the
Git host can always see file names and commit timestamps even in vault mode.

## Install

```bash
npm --prefix apps/extension install     # or: npm install (root postinstall does it)
npm run build                            # root delegating script
```

SSH mode additionally needs the **companion** (a small Node process) and a **local clone** of the
repository — `git` needs a working tree, so SSH cannot be spoken from an extension at all. Install it
per OS/browser with the installer described in [`deploy/README.md`](deploy/README.md); token mode needs
neither.

Then load `.output/chrome-mv3` via **chrome://extensions → Developer mode → Load unpacked**.

Firefox: `npm run build:firefox` and load `.output/firefox-mv2/manifest.json` from
`about:debugging#/runtime/this-firefox`.

## Setup

1. **Vault first.** Open Settings → 安全, set a passphrase. Secrets cannot be stored without one.
2. **Storage.** Settings → 存储: a GitHub **fine-grained token** with `Contents: Read and write` on a
   single repository, plus owner/repo/branch and an optional path prefix. `测试连接` probes the
   repository and reports visibility and scope problems. A public repository shows a red warning and
   cannot be saved until you tick the acknowledgement.
3. **Authorization (optional SSH).** 存储 → 授权方式: 令牌 (token, the default) or **SSH**. SSH requires
   the companion and a local clone path; the picker shows whether the companion is installed, and the
   SSH block prints the one command that creates that clone (copy it, run it, paste the same directory
   back). 检查分支 validates the branch against the remote and offers to create it.
4. **Content tier — asked once, not defaulted.** The first save of 存储 asks the question outright:
   透明仓 (readable Markdown, so anyone who can open the repository can read it) or 保险库 (AES-GCM, and
   a lost passphrase cannot be recovered). 保存 stays disabled until you pick one; the answer is written
   into the repository as `.omnipilot/config.json` together with its first content, so every client reads
   the same answer. An existing repository keeps whatever that file records, an unreadable config falls
   back to 保险库, and later changes live under 安全.
5. **Models (optional).** Settings → 模型: provider, model, API key. A custom base URL needs the trust
   checkbox and a runtime host permission.
6. **AI authorization (optional).** Settings → AI 授权: turn egress on. Until you do, `提炼` captures
   the item and explains that AI is off.
7. **Sync & search.** Settings → 同步 set the pull interval (0 disables it), startup/capture triggers and
   pull-only mode; the same tab shows sync status, conflicts (with the three-way decision above) and a manual
   立即同步, and can rebuild the index or search the corpus.
8. **Proposals & review.** The popup lists what the AI proposed — accept, rewrite or discard each one — and
   what is due for review.

## Repository layout produced by the extension

```
.omnipilot/config.json          # { schema_version, security_mode, branch, sync_policy, client_version }
                                # written with the first content commit; never overwrites a recorded tier
index.json                      # ids, kinds, paths, timestamps + dedup keys only — also the remote manifest
search/<prefix>.json            # postings shards, committed with the note that changed them
NOTES.md                        # readable catalogue (topics, counts, recent cards)
inbox/YYYY/MM/<slug>-<id>.md    # SourceItem (transparent tier)
inbox/YYYY/MM/<id>.md.enc       # SourceItem (vault tier — opaque name, encrypted body)
cards/pending/<slug>-<id>.md    # AI proposal awaiting your confirmation
topics/<slug>.md                # Topic node
review/state.json               # scheduling metadata (no content)
```

In vault mode every content-bearing file is an envelope; only the identifiers and timestamps above
stay readable.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | WXT dev server (Chrome) with HMR |
| `npm test` | UNIT suite (vitest) |
| `npm run test:int` | integration suite (vitest, separate config) |
| `npm run test:reg` | targeted regression (module-scoped UNIT rerun) |
| `npm run test:smk` | smoke: build + secret assertion + the clip E2E |
| `npm run test:e2e` | Playwright against the built extension (needs `npm run build` first) |
| `npm run test:bridge` | companion UNIT suite |
| `npm run test:sys` | companion SYS suite — spawns the built companion against a temporary bare repository |
| `npm run build:bridge` / `pack:bridge` | build / single-file bundle the companion |
| `npm run ci:all` | extension CI + companion UNIT + companion SYS |
| `npm run build` / `build:firefox` | production bundles |
| `npm run assert:content` | fails the build if the content-script bundle can reach a secret |
| `npm run pack` | test → build → zip (`--skip-test`, `--firefox`, `--no-zip`, `--dry-run`) |
| `npm run ci` | everything above, in the order CI uses |
| `make help` | the same targets via Make |

### One-click delivery

The extension has no server, so delivery means producing installable packages:

```bash
make deploy-help                       # list the modes
make deploy                            # all browsers (typecheck + tests + build + zip)
make deploy-chrome                     # Chrome/Edge MV3
make deploy-firefox                    # Firefox
make deploy-verify                     # verification only
make deploy-dry-run MODE=chrome        # print the steps without running them
```

See [deploy/README.md](deploy/README.md) for install/rollback details.

> On Windows, use the Node path (`npm run pack`) or a POSIX shell that drives the Windows toolchain
> (Git Bash). The `bash` shipped as `WindowsApps\bash.exe` is WSL and cannot run a Windows
> `node_modules`.

Architecture, decisions and the test plan live in `docs/omnidev-state/main/`:
[blueprint](docs/omnidev-state/main/01-blueprint.md) ·
[design](docs/omnidev-state/main/04-design.md) ·
[test plan](docs/omnidev-state/main/05-test-plan.md) ·
[plan](docs/omnidev-state/main/02-plan.md).

### Conventions

- Logic lives in `lib/**` as small pure modules with colocated `*.test.ts`; entrypoints stay thin.
- `lib/core/**` is dependency-free and browser-free, enforced by a test — it is the seam for the
  future `packages/core` shared with the mini program.
- Everything network-facing takes an injected `fetchImpl`; everything time-dependent takes an
  injected `now`.
- No new runtime dependencies. The extension ships zero `dependencies`.

## License

See [LICENSE](LICENSE).
