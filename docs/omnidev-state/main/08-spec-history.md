# History: 08-spec.md

Append-only archive. Do not edit or delete past snapshots.
Newest entries appended at **bottom**.

| Metric | Value |
|--------|-------|
| snapshots | 4 |
| first_archived | 2026-07-09 00:00 |
| last_archived | 2026-09-29T19:00:00+08:00 |

---

## [ARCHIVE] 08-spec.md · v1 · 2026-07-09 00:00

| Field | Value |
|-------|-------|
| version | 1 |
| archived_at | 2026-07-09T00:00:00+08:00 |
| reason | merged into the cumulative `docs/omnidev-state/specs.md` at Phase 5 exit (`/od spec archive`) |
| trigger | `/od spec archive` |
| requirement_id | req-2026-07-09-synapse-ext-mvp |
| summary | 8 requirements / 21 scenarios for the browser-extension MVP, all verified by passing tests |

<!-- BEGIN SNAPSHOT -->
```markdown
---
version: 1
artifact: 08-spec.md
spec_mode: auto
requirement_id: req-2026-07-09-synapse-ext-mvp
---

# Spec Delta: 浏览器插件 MVP（捕获 → 提炼 → GitHub 落库）

## ADDED

### R1: Capture into Inbox
The system SHALL convert a page, selection or manual note into a `SourceItem` and store it in the
configured GitHub repository without the user leaving the page.
#### Scenario: SC-F1-01 clip full page
- **WHEN** the user activates "剪藏本页" from the popup or context menu on a loaded page
- **THEN** a `SourceItem` is committed to `inbox/YYYY/MM/<slug>-<id8>.md` and the UI reports the commit
#### Scenario: SC-F1-02 clip selection
- **WHEN** the user selects text and presses the bubble action (or the clip-selection command)
- **THEN** the stored body contains the selection and `excerpt_of` points at the page URL
#### Scenario: SC-F1-03 duplicate capture
- **WHEN** an already-captured URL is captured again within the dedup window
- **THEN** no new file is written and the UI reports "已在 Inbox" with a link to the existing item

### R2: Canonical Knowledge Format
The system SHALL represent every stored record as a frontmatter document whose fields validate
against the CKF schema, so any storage adapter can round-trip it.
#### Scenario: SC-F2-01 round trip
- **WHEN** a `SourceItem` is encoded and decoded
- **THEN** all CKF fields are preserved and unknown fields are dropped, not crashed on
#### Scenario: SC-F2-02 invalid record
- **WHEN** a decoded document is missing a required field or has a wrong type
- **THEN** decoding fails with a typed error and never produces a partially valid record

### R3: Content confidentiality tier
The system SHALL support two content tiers and default to encrypted.
#### Scenario: SC-F3-01 vault mode
- **WHEN** security mode is `vault`
- **THEN** every content-bearing file is committed as an AES-GCM envelope and only identifiers/timestamps stay readable
#### Scenario: SC-F3-02 transparent mode requires acknowledgement
- **WHEN** the user selects `transparent` mode
- **THEN** the UI states that plaintext will be readable by the host and requires explicit confirmation before saving
#### Scenario: SC-F3-03 locked vault fails closed
- **WHEN** the vault is locked and a write is requested
- **THEN** the write is refused with a lock error; no plaintext and no unencrypted fallback is written

### R4: Secret custody
The system SHALL keep every credential inside the background service worker and out of page-context code.
#### Scenario: SC-F4-01 content bundle purity
- **WHEN** the extension is built
- **THEN** the content script bundle contains no secret storage key and the build assertion fails otherwise
#### Scenario: SC-F4-02 scrubbed errors
- **WHEN** a provider or GitHub request fails with a message containing the credential
- **THEN** the user-visible and logged message replaces the credential with `[REDACTED]`
#### Scenario: SC-F4-03 rate limit
- **WHEN** a tab exceeds the configured AI or GitHub request budget
- **THEN** further requests in that window are rejected with a retry hint and no network call is made

### R5: Mainstream model access
The system SHALL reach mainstream LLM providers through one catalog and one client.
#### Scenario: SC-F5-01 provider routing
- **WHEN** the user selects any supported provider and model
- **THEN** the request is sent to that provider's endpoint with its own auth style and the reply text is extracted
#### Scenario: SC-F5-02 custom endpoint trust
- **WHEN** a non-default base URL is entered
- **THEN** the endpoint must be HTTPS, a trust acknowledgement is required before saving, and the host permission is requested at runtime

### R6: GitHub is the only authoritative store
The system SHALL persist through a `KnowledgeStore` adapter whose only implementation is GitHub.
#### Scenario: SC-F6-01 atomic commit
- **WHEN** a capture writes multiple files
- **THEN** they land in one commit on the configured branch and the result reports the commit URL
#### Scenario: SC-F6-02 public repository guard
- **WHEN** the configured repository is not private
- **THEN** writes are blocked until the user explicitly confirms, and the UI shows a persistent warning
#### Scenario: SC-F6-03 auth failure
- **WHEN** the token is missing, expired or lacks Contents write scope
- **THEN** the adapter returns a classified error and no partial commit is attempted

### R7: Distillation is a proposal
The system SHALL only propose KnowledgeCards and never rewrite user text.
#### Scenario: SC-F7-01 proposal pending
- **WHEN** the user runs 提炼 on an inbox item with AI authorized
- **THEN** a card file is written under `cards/pending/` and the source file is unchanged
#### Scenario: SC-F7-02 unauthorized egress
- **WHEN** AI egress is disabled or the item is not authorized
- **THEN** no provider request is made and the UI offers to authorize
#### Scenario: SC-F7-03 malformed model output
- **WHEN** the model returns non-JSON or schema-invalid content
- **THEN** the proposal is rejected with a typed error and nothing is committed

### R8: Observable status and settings
The system SHALL expose current store, provider, security mode and authorization state in the UI.
#### Scenario: SC-F8-01 status surface
- **WHEN** the popup opens
- **THEN** it shows store kind, repository, security mode, vault lock state and AI authorization state without revealing any secret
#### Scenario: SC-F8-02 connection test
- **WHEN** the user saves GitHub settings
- **THEN** the extension probes the repository, reports visibility and scope problems, and stores only on success
```
<!-- END SNAPSHOT -->

---

## [ARCHIVE] 08-spec.md · v2 · 2026-09-29 16:30

---
version: 2
previous_version: 1
artifact: 08-spec.md
spec_mode: auto
requirement_id: req-2026-07-09-synapse-git-sync
supersedes: req-2026-07-09-synapse-ext-mvp (v1 merged into ../../specs.md; snapshot in 08-spec-history.md)
---

# Spec Delta: GitHub 双授权 · 双向自动同步 · 仓库内可读检索

## ADDED

### R1: Two GitHub authorization modes
The system SHALL offer access-token and SSH authorization as first-class, user-selectable modes, and
SHALL report honestly when a mode cannot run.
#### Scenario: SC-F1-01 token mode
- **WHEN** the user selects the token mode and enters a fine-grained token
- **THEN** probe, read and write use the GitHub REST API exactly as in 0.1.0
#### Scenario: SC-F1-02 SSH mode without a transport
- **WHEN** the user selects the SSH mode while the companion process is not installed
- **THEN** the mode is reported as unavailable with an install hint, no request is attempted, and the
  token mode remains fully usable
#### Scenario: SC-F1-03 SSH mode with a transport
- **WHEN** the companion is present and the user selects the SSH mode
- **THEN** remote operations are performed by the companion through the user's own `git`/`ssh`, and no
  key material or passphrase is ever sent to the extension
#### Scenario: SC-F1-04 mode switch
- **WHEN** the user switches the authorization mode
- **THEN** the next operation uses the new mode, and the previously stored credential of the other mode
  is left untouched

### R2: Companion host contract
The system SHALL treat the companion as an untrusted-by-default boundary with an explicit contract.
#### Scenario: SC-F2-01 handshake
- **WHEN** the extension connects to the companion
- **THEN** versions are exchanged first, and a mismatch refuses the connection with an upgrade hint
#### Scenario: SC-F2-02 command allow-list
- **WHEN** a request arrives that is not on the allow-list, or whose path resolves outside the
  repository root
- **THEN** the companion rejects it and performs no git operation
#### Scenario: SC-F2-03 no shell interpolation
- **WHEN** any git operation runs
- **THEN** it is executed without a shell, with arguments passed as an array

### R3: Branch selection
The system SHALL default to `main` and allow any branch name, validated against the remote.
#### Scenario: SC-F3-01 default branch
- **WHEN** the user configures storage without touching the branch field
- **THEN** `main` is used
#### Scenario: SC-F3-02 custom branch
- **WHEN** the user enters a branch name
- **THEN** it is validated against the remote, and a missing branch is reported with the option to
  create it rather than failing opaquely

### R4: Automatic push
The system SHALL push local notes automatically, without losing data on contention.
#### Scenario: SC-F4-01 push after capture
- **WHEN** a capture is written locally
- **THEN** it is pushed to the configured branch, and a temporary failure leaves it queued for the next
  sync rather than dropping it
#### Scenario: SC-F4-02 remote moved before push
- **WHEN** the branch head moves between the read and the write
- **THEN** the engine re-reads the head and retries once, and if the same path also changed remotely it
  preserves both versions as a conflict copy instead of overwriting

### R5: Automatic pull
The system SHALL pull remote changes automatically and make them available to retrieval.
#### Scenario: SC-F5-01 no-op sync
- **WHEN** a sync runs and the remote head equals the last synced head
- **THEN** no content is fetched and the sync is reported as up to date
#### Scenario: SC-F5-02 incremental pull
- **WHEN** the remote head moved
- **THEN** only new or changed files are fetched, the local cache is updated, and the search index is
  refreshed for exactly those records
#### Scenario: SC-F5-03 periodic pull
- **WHEN** the configured sync interval elapses
- **THEN** a pull runs automatically, and pulling is disabled when the user turns the interval off
#### Scenario: SC-F5-04 pull before unlock
- **WHEN** the active tier is `vault` and the vault is locked
- **THEN** the sync reports that it cannot reconcile content yet instead of caching ciphertext as if it
  were a record

### R6: Retrieval over the stored notes
The system SHALL support keyword retrieval at the quality the product requires, and SHALL keep the
index rebuildable from the repository alone.
#### Scenario: SC-F6-01 keyword search
- **WHEN** the user searches for a term present in a title, body, tag or topic
- **THEN** matching records are returned, ranked, with a snippet and the repository path
#### Scenario: SC-F6-02 CJK search
- **WHEN** the query or the content is Chinese
- **THEN** bigram matching finds the record without requiring a tokenizer dependency
#### Scenario: SC-F6-03 rebuild
- **WHEN** the local index is missing, stale or explicitly rebuilt
- **THEN** it is reconstructed from the repository contents and queries keep working

### R7: Readable in-repository storage
The system SHALL prefer a layout a human can read in the repository, and SHALL NOT change an existing
store silently.
#### Scenario: SC-F7-01 readable default
- **WHEN** a user configures storage for the first time
- **THEN** the default tier is readable Markdown, with the encrypted tier one explicit choice away
#### Scenario: SC-F7-02 existing store untouched
- **WHEN** an existing repository is already using the encrypted tier
- **THEN** nothing rewrites it, and the active tier is shown in the UI
#### Scenario: SC-F7-03 readable catalogue
- **WHEN** a sync completes and the set of topics or cards changed
- **THEN** a human-readable catalogue file in the repository is regenerated in the same push

### R8: Sync observability
The system SHALL make sync state visible and controllable.
#### Scenario: SC-F8-01 status
- **WHEN** the popup or the settings page is open
- **THEN** it shows the authorization mode, branch, last sync time and result, current head, and any
  pending local changes or conflicts
#### Scenario: SC-F8-02 manual control
- **WHEN** the user triggers a sync manually, or pauses automatic syncing
- **THEN** the action takes effect immediately and the state shown reflects it

## [ARCHIVE] 08-spec.md · v3 · 2026-09-29T18:10:00+08:00

---
version: 3
previous_version: 2
artifact: 08-spec.md
spec_mode: auto
requirement_id: req-2026-07-09-synapse-git-sync
supersedes: req-2026-07-09-synapse-ext-mvp (v1 merged into ../../specs.md; snapshot in 08-spec-history.md)
---

# Spec Delta: GitHub 双授权 · 双向自动同步 · 仓库内可读检索

## ADDED

### R1: Two GitHub authorization modes
The system SHALL offer access-token and SSH authorization as first-class, user-selectable modes, and
SHALL report honestly when a mode cannot run.
#### Scenario: SC-F1-01 token mode
- **WHEN** the user selects the token mode and enters a fine-grained token
- **THEN** probe, read and write use the GitHub REST API exactly as in 0.1.0
#### Scenario: SC-F1-02 SSH mode without a transport
- **WHEN** the user selects the SSH mode while the companion process is not installed
- **THEN** the mode is reported as unavailable with an install hint, no request is attempted, and the
  token mode remains fully usable
#### Scenario: SC-F1-03 SSH mode with a transport
- **WHEN** the companion is present and the user selects the SSH mode
- **THEN** remote operations are performed by the companion through the user's own `git`/`ssh`, and no
  key material or passphrase is ever sent to the extension
#### Scenario: SC-F1-04 mode switch
- **WHEN** the user switches the authorization mode
- **THEN** the next operation uses the new mode, and the previously stored credential of the other mode
  is left untouched

### R2: Companion host contract
The system SHALL treat the companion as an untrusted-by-default boundary with an explicit contract.
#### Scenario: SC-F2-01 handshake
- **WHEN** the extension connects to the companion
- **THEN** versions are exchanged first, and a mismatch refuses the connection with an upgrade hint
#### Scenario: SC-F2-02 command allow-list
- **WHEN** a request arrives that is not on the allow-list, or whose path resolves outside the
  repository root
- **THEN** the companion rejects it and performs no git operation
#### Scenario: SC-F2-03 no shell interpolation
- **WHEN** any git operation runs
- **THEN** it is executed without a shell, with arguments passed as an array
#### Scenario: SC-F2-04 content channel (added v3)
- **WHEN** the extension needs to read or write a note over the companion
- **THEN** `git.show` / `git.ls` return the bytes or the listing and `git.write` materialises content under the
  repository root, commits it and reports the new sha; a path that resolves outside the root is refused with
  `pathOutsideRoot` and no file is created, and a path absent at a revision is `notFound`, never an empty string
#### Scenario: SC-F2-05 write is idempotent and push-gated (added v3)
- **WHEN** the same content is written twice, or a push is rejected after the commit
- **THEN** no second (empty) commit is created, the promise rejects on the rejected push, and the caller keeps
  the paths queued so the next run re-sends them rather than losing or duplicating the note

### R3: Branch selection
The system SHALL default to `main` and allow any branch name, validated against the remote.
#### Scenario: SC-F3-01 default branch
- **WHEN** the user configures storage without touching the branch field
- **THEN** `main` is used
#### Scenario: SC-F3-02 custom branch
- **WHEN** the user enters a branch name
- **THEN** it is validated against the remote, and a missing branch is reported with the option to
  create it rather than failing opaquely

### R4: Automatic push
The system SHALL push local notes automatically, without losing data on contention.
#### Scenario: SC-F4-01 push after capture
- **WHEN** a capture is written locally
- **THEN** it is pushed to the configured branch, and a temporary failure leaves it queued for the next
  sync rather than dropping it
#### Scenario: SC-F4-02 remote moved before push
- **WHEN** the branch head moves between the read and the write
- **THEN** the engine re-reads the head and retries once, and if the same path also changed remotely it
  preserves both versions as a conflict copy instead of overwriting

### R5: Automatic pull
The system SHALL pull remote changes automatically and make them available to retrieval.
#### Scenario: SC-F5-01 no-op sync
- **WHEN** a sync runs and the remote head equals the last synced head
- **THEN** no content is fetched and the sync is reported as up to date
#### Scenario: SC-F5-02 incremental pull
- **WHEN** the remote head moved
- **THEN** only new or changed files are fetched, the local cache is updated, and the search index is
  refreshed for exactly those records
#### Scenario: SC-F5-03 periodic pull
- **WHEN** the configured sync interval elapses
- **THEN** a pull runs automatically, and pulling is disabled when the user turns the interval off
#### Scenario: SC-F5-04 pull before unlock
- **WHEN** the active tier is `vault` and the vault is locked
- **THEN** the sync reports that it cannot reconcile content yet instead of caching ciphertext as if it
  were a record

### R6: Retrieval over the stored notes
The system SHALL support keyword retrieval at the quality the product requires, and SHALL keep the
index rebuildable from the repository alone.
#### Scenario: SC-F6-01 keyword search
- **WHEN** the user searches for a term present in a title, body, tag or topic
- **THEN** matching records are returned, ranked, with a snippet and the repository path
#### Scenario: SC-F6-02 CJK search
- **WHEN** the query or the content is Chinese
- **THEN** bigram matching finds the record without requiring a tokenizer dependency
#### Scenario: SC-F6-03 rebuild
- **WHEN** the local index is missing, stale or explicitly rebuilt
- **THEN** it is reconstructed from the repository contents and queries keep working

### R7: Readable in-repository storage
The system SHALL prefer a layout a human can read in the repository, and SHALL NOT change an existing
store silently.
#### Scenario: SC-F7-01 readable default
- **WHEN** a user configures storage for the first time
- **THEN** the default tier is readable Markdown, with the encrypted tier one explicit choice away
#### Scenario: SC-F7-02 existing store untouched
- **WHEN** an existing repository is already using the encrypted tier
- **THEN** nothing rewrites it, and the active tier is shown in the UI
#### Scenario: SC-F7-03 readable catalogue
- **WHEN** a sync completes and the set of topics or cards changed
- **THEN** a human-readable catalogue file in the repository is regenerated in the same push

### R8: Sync observability
The system SHALL make sync state visible and controllable.
#### Scenario: SC-F8-01 status
- **WHEN** the popup or the settings page is open
- **THEN** it shows the authorization mode, branch, last sync time and result, current head, and any
  pending local changes or conflicts
#### Scenario: SC-F8-02 manual control
- **WHEN** the user triggers a sync manually, or pauses automatic syncing
- **THEN** the action takes effect immediately and the state shown reflects it

## [ARCHIVE] 08-spec.md · v4 · 2026-09-29T19:00:00+08:00

---
version: 4
previous_version: 3
artifact: 08-spec.md
spec_mode: auto
requirement_id: req-2026-09-29-synapse-workflow-elegance
supersedes: req-2026-07-09-synapse-git-sync (v3 archived to 08-spec-history.md)
---

# Spec Delta: 设计理念入文档 · 全量功能审计 · 统一优化

## ADDED

### R1: Design philosophy is judgeable, not decorative
The system SHALL state its product philosophy — depth of understanding of the user's knowledge workflow, and
elegance of AI–human collaboration — as criteria a reviewer can decide yes/no against, and SHALL gate design
work on them.

#### Scenario: SC-R1-01 criteria exist and are applied per feature
- **WHEN** a feature is designed (Phase 1/2) or reviewed
- **THEN** it is judged against the six published criteria (W1 zero-cost capture, W2 visible destination, W3 the
  human decides on AI proposals, W4 reversible and comprehensible automation, W5 retrieval from fuzzy recall,
  W6 no silent failure), and a feature that fails a criterion must record why or change
#### Scenario: SC-R1-02 the gate is enforceable, not aspirational
- **WHEN** a reader opens `AGENTS.md` or the principles document
- **THEN** they find the criteria, the counter-example for each, the per-feature checklist and the code-review
  items, with a pointer from the repository README

### R2: Every implemented feature is audited against the criteria
The system SHALL be accompanied by an evidence-based audit of everything it claims to do.

#### Scenario: SC-R2-01 the audit enumerates the real surface
- **WHEN** the audit is read
- **THEN** it covers every message type, every record kind in the canonical model, and every stage of the
  knowledge pipeline, each conclusion carrying a `file:line` reference
#### Scenario: SC-R2-02 the audit names the failure modes explicitly
- **WHEN** something is implemented but unreachable, or defined but never created, or broken in silence
- **THEN** the audit lists it separately as dead code, an unproduced record type, a state with no exit, or a
  silent failure — rather than describing it as "future work"

### R3: The audit's findings are fixed in the same requirement
Every finding rated P0/P1 SHALL be fixed with code, tests and documentation; anything deferred SHALL be listed
explicitly with its reason.

#### Scenario: SC-R3-01 an AI proposal has a decision surface
- **WHEN** a distillation produces a pending knowledge card
- **THEN** the card is listed inside the product (title, summary, points, source link) and the user can accept,
  edit or discard it; accepting moves it out of `cards/pending/`, discarding archives it rather than deleting it,
  and each decision is one commit that keeps the index and the search shards consistent
#### Scenario: SC-R3-02 a conflict is a decision, not a stray file
- **WHEN** the same note changed locally and remotely
- **THEN** the status surface shows both sides (time, size, whether it is readable) and offers keep-mine,
  keep-remote or keep-both; the winner takes the original path, the loser is archived under `archive/conflicts/`
  rather than left as a `.conflict-` sibling, and both versions remain retrievable afterwards
#### Scenario: SC-R3-03 a background failure tells the user what to do
- **WHEN** sync, the companion or the index fails
- **THEN** the status line shows a human-readable, translated cause plus the one action that fixes it and a retry
  affordance — and never the raw worker error text
#### Scenario: SC-R3-04 SSH mode explains its prerequisite
- **WHEN** the user selects SSH without a local clone
- **THEN** the product offers the exact `git clone` command for their own remote, copyable, with the clone path
  validated, instead of only stating that a clone is required
#### Scenario: SC-R3-05 local intelligence before remote intelligence
- **WHEN** a capture matches something already stored, or a card plausibly belongs to an existing topic, or notes
  are due for review
- **THEN** the product says so using local data only (no network egress), and never blocks the capture
#### Scenario: SC-R3-06 the encryption trade-off is chosen, not assumed
- **WHEN** the user configures storage for the first time
- **THEN** they explicitly pick readable-in-repo or encrypted, each with a one-line human consequence, and the
  choice is recorded in the store config

## MODIFIED

### R4: Nothing automated may fail invisibly
Previously the sync surface reported only an outcome word. The status projection SHALL carry a translated,
actionable cause; the raw error text SHALL remain inside the worker.

#### Scenario: SC-R4-01 the projection stays secret-free
- **WHEN** the failure is projected to any page
- **THEN** it contains a code, a translated title and an action target — no token, no path, no note content

## Constraints (unchanged, and binding on every fix)

- No new runtime dependency in either package.
- No new network egress; AI egress stays opt-in, per-item and ledgered.
- New message types are extension-page only (`SECRET_BEARING_TYPES`) and rate-limited.
- Vault mode never downgrades to plaintext, and a locked vault refuses rather than caches ciphertext.
- The existing regression baseline (543 UNIT / 111 INT / 8 SYS / 12 E2E) must not go red; an intentional
  assertion change is recorded with its reason in `03-progress.md`.

