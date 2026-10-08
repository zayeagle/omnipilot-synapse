---
status: PASS
requirement: req-2026-09-30-synapse-manual-entry
---

# Security Audit - req-2026-09-30-synapse-manual-entry (F11 手工录入)

Verdict: **PASS** (no new exposure; two notes recorded below).

| Check | Result | Evidence |
|-------|--------|----------|
| New message type | none added | F11 reuses `capture.request`, already in `CONTENT_SCRIPT_ALLOWED_TYPES` and in an existing rate-limit bucket. AGENTS 3's rule is satisfied by NOT adding a type. |
| Secret handling | unchanged | The note text is content, not a credential; no new secret read or write. |
| Sealing at rest | covered | The offline queue seals any payload (R8), so a note queued on a transient failure is sealed like a capture. |
| Content-script bundle | unchanged | The compose surface is popup-only; `npm run assert:content` OK. |
| New outbound path | none | No new endpoint, no AI egress; a note reaches only the user's own repository. |
| Injection | none | The note is written to Markdown as text and rendered in the Inbox as `textContent`; the UI never interprets it as HTML. |
| Irreversible action | none | No delete, no overwrite of user data. |

## Notes
1. A page-less note carries the synthetic `omnipilot:note` URL. Any surface that would OPEN a URL goes through
   `isSafeExternalUrl`, which accepts only http(s) - so a synthetic URL can never become a clickable link.
   Verified by reading that gate in `lib/ui/format.ts` rather than assuming it.
2. A note written next to a page stores that page's URL with the record, exactly as a clip does; a note taken
   with no page open stores only the synthetic URL.
