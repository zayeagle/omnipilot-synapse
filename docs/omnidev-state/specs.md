# OmniPilot Synapse — Cumulative Specification

**Long-lived source of truth.** Phase 1 reads this file instead of per-requirement deltas.
Per-requirement deltas (`08-spec.md`) are merged here when a requirement ships, then archived to
`08-spec-history.md`.

Every requirement uses **SHALL**; every scenario uses **WHEN/THEN**.
Scenario IDs are stable once shipped — never renumber, never reuse.

| Metric | Value |
|--------|-------|
| requirements | 8 |
| scenarios | 21 |
| first_merged | 2026-07-09 |
| last_merged | 2026-07-09 |

---

## R1: Capture into Inbox

*Shipped in* `req-2026-07-09-synapse-ext-mvp` *(browser extension 0.1.0)*

The system SHALL convert a page, selection or manual note into a `SourceItem` and store it in the
configured repository without the user leaving the page.

#### Scenario: SC-F1-01 clip full page
- **WHEN** the user activates "剪藏本页" from the popup or context menu on a loaded page
- **THEN** a `SourceItem` is committed to `inbox/YYYY/MM/<slug>-<id>.md` and the UI reports the commit

#### Scenario: SC-F1-02 clip selection
- **WHEN** the user selects text and presses the bubble action (or the clip-selection command)
- **THEN** the stored body contains the selection and `excerpt_of` points at the page URL

#### Scenario: SC-F1-03 duplicate capture
- **WHEN** an already-captured URL is captured again within the dedup window
- **THEN** no new file is written and the UI reports "已在 Inbox" with a link to the existing item

## R2: Canonical Knowledge Format

*Shipped in* `req-2026-07-09-synapse-ext-mvp`

The system SHALL represent every stored record as a frontmatter document whose fields validate
against the CKF schema, so any storage adapter can round-trip it.

#### Scenario: SC-F2-01 round trip
- **WHEN** a `SourceItem` is encoded and decoded
- **THEN** all CKF fields are preserved and unknown fields are dropped, not crashed on

#### Scenario: SC-F2-02 invalid record
- **WHEN** a decoded document is missing a required field or has a wrong type
- **THEN** decoding fails with a typed error and never produces a partially valid record

## R3: Content confidentiality tier

*Shipped in* `req-2026-07-09-synapse-ext-mvp`

The system SHALL support two content tiers and default to encrypted.

#### Scenario: SC-F3-01 vault mode
- **WHEN** security mode is `vault`
- **THEN** every content-bearing file is committed as an AES-GCM envelope, with an opaque record id in
  the path and only identifiers/timestamps readable

#### Scenario: SC-F3-02 transparent mode requires acknowledgement
- **WHEN** the user selects `transparent` mode
- **THEN** the UI states that plaintext will be readable by the host and requires explicit confirmation
  before saving

#### Scenario: SC-F3-03 locked vault fails closed
- **WHEN** the vault is locked and a write is requested
- **THEN** the write is refused with a lock error; no plaintext and no unencrypted fallback is written

## R4: Secret custody

*Shipped in* `req-2026-07-09-synapse-ext-mvp`

The system SHALL keep every credential inside the background service worker and out of page-context code.

#### Scenario: SC-F4-01 content bundle purity
- **WHEN** the extension is built
- **THEN** the content script bundle and every chunk it can reach contain no secret storage key, and the
  build assertion also fails when the expected safe marker is absent

#### Scenario: SC-F4-02 scrubbed errors
- **WHEN** a provider or GitHub request fails with a message containing the credential
- **THEN** the user-visible and logged message replaces the credential with `[REDACTED]`

#### Scenario: SC-F4-03 rate limit
- **WHEN** a tab exceeds the configured AI or GitHub request budget
- **THEN** further requests in that window are rejected with a retry hint and no network call is made

## R5: Mainstream model access

*Shipped in* `req-2026-07-09-synapse-ext-mvp`

The system SHALL reach mainstream LLM providers through one catalog and one client.

#### Scenario: SC-F5-01 provider routing
- **WHEN** the user selects any supported provider and model
- **THEN** the request is sent to that provider's endpoint with its own auth style and the reply text is
  extracted tolerantly (nested bodies, SSE chunks, NDJSON)

#### Scenario: SC-F5-02 custom endpoint trust
- **WHEN** a non-default base URL is entered
- **THEN** the endpoint must be HTTPS (loopback excepted), a trust acknowledgement is required, the host
  permission is requested at runtime, and the worker re-checks trust before any request

## R6: GitHub is the only authoritative store

*Shipped in* `req-2026-07-09-synapse-ext-mvp`

The system SHALL persist through a `KnowledgeStore` adapter whose first implementation is GitHub, and
SHALL keep that seam open for other adapters.

#### Scenario: SC-F6-01 atomic commit
- **WHEN** a capture writes multiple files
- **THEN** they land in one commit on the configured branch and the result reports the commit URL

#### Scenario: SC-F6-02 public repository guard
- **WHEN** the configured repository is not private
- **THEN** writes are blocked until the user explicitly confirms, and the UI shows a persistent warning

#### Scenario: SC-F6-03 auth failure
- **WHEN** the token is missing, expired or lacks Contents write scope
- **THEN** the adapter returns a classified error and no partial commit is attempted

## R7: Distillation is a proposal

*Shipped in* `req-2026-07-09-synapse-ext-mvp`

The system SHALL only propose KnowledgeCards and never rewrite user text.

#### Scenario: SC-F7-01 proposal pending
- **WHEN** the user runs 提炼 on an inbox item with AI authorized
- **THEN** a card file is written under `cards/pending/` and the source file is byte-identical afterwards

#### Scenario: SC-F7-02 unauthorized egress
- **WHEN** AI egress is globally disabled, or the item has not been authorized in this session
- **THEN** no provider request is made and the UI offers to authorize

#### Scenario: SC-F7-03 malformed model output
- **WHEN** the model returns non-JSON or schema-invalid content
- **THEN** the proposal is rejected with a typed error, the attempt is recorded in the ledger, and
  nothing is committed

## R8: Observable status and settings

*Shipped in* `req-2026-07-09-synapse-ext-mvp`

The system SHALL expose current store, provider, security mode and authorization state in the UI.

#### Scenario: SC-F8-01 status surface
- **WHEN** the popup opens
- **THEN** it shows store kind, repository, content tier, vault lock state and AI authorization state
  without revealing any secret

#### Scenario: SC-F8-02 connection test
- **WHEN** the user saves GitHub settings
- **THEN** the extension probes the repository, reports visibility and scope problems, and stores only on
  success

---

## Merged requirements

| Requirement | Merged | Result |
|-------------|--------|--------|
| `req-2026-07-09-synapse-ext-mvp` — browser-extension MVP (capture → distill → GitHub) | 2026-07-09 | 8 requirements, 21 scenarios, all covered by passing tests (`05-test-report.md` §5) |

## Not yet specified

Deferred, and therefore deliberately absent from this document: the WeChat Mini Program client,
self-hosted database storage, local-filesystem storage, and the review-scheduling UI.
