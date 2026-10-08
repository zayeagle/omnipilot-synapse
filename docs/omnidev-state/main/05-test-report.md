---
requirement: req-2026-09-30-synapse-manual-entry
feature: F11
status: PASS (E2E waived)
---

# Test report - F11 手工录入 (manual entry)

## Phase 4 Test Execution Plan

Profile: frontend-M | UNIT yes, INT yes, REG targeted, SMK substituted, E2E **waived**
Commands: `npx tsc --noEmit` · `npm test` · `npm run test:int` · `npm run test:reg` · `npm run build` · `npm run assert:content`
Blocking: UNIT + INT (both green).

## Results

```
TSC=0

 Test Files  59 passed (59)
      Tests  621 passed (621)
   Duration  16.99s (transform 16.32s, setup 0ms, collect 56.37s, tests 6.10s, environment 5.59s, prepare 28.86s)
UNIT=0
 Test Files  13 passed (13)
      Tests  121 passed (121)
   Duration  5.45s (transform 5.35s, setup 0ms, collect 15.19s, tests 639ms, environment 3ms, prepare 4.08s)
INT=0
      Tests  409 passed (409)
   Duration  11.89s (transform 6.97s, setup 0ms, collect 30.89s, tests 5.25s, environment 2.77s, prepare 12.26s)
REG=0
Σ Total size: 425.87 kB                            
  · content-scripts\content.js
ASSERT=0
```

## Gate status

| Gate | Status | Note |
|------|--------|------|
| UNIT (blocking) | PASS | 621 passed / 59 files, including the new TC-F11-U01..U03 |
| INT (blocking) | PASS | 121 passed / 13 files, including TC-F11-I01 |
| REG | PASS | 409 passed - the page/selection paths are untouched by the note fix |
| Security audit (B.22 entry gate) | PASS | `07-security-audit.md` frontmatter `status: PASS` |
| Build + content bundle | PASS | build 0 (425.9 kB), `assert:content` OK |
| SMK | SUBSTITUTED | `npm run test:smk` is build + assert:content + a Playwright spec; the two non-browser steps ran and passed, the spec falls under the E2E waiver |
| E2E | WAIVED | user instruction 2026-09-30 (twice): do not run the browser suite. TC-F11-S01 is listed for manual acceptance: refresh the extension, open the popup, 写笔记 -> 保存 -> the note appears in the Inbox and in search |

## Coverage against the spec

| SC | Scenario | TC | Result |
|----|----------|----|--------|
| SC-F11-01 | Compose with title and text -> committed and listed | TC-F11-U01, TC-F11-I01 | PASS |
| SC-F11-02 | No title -> the first line becomes the title | TC-F11-U02, TC-F11-I01 | PASS |
| SC-F11-03 | Empty body -> refused locally, nothing sent | TC-F11-U02 | PASS |
| SC-F11-04 | Store unreachable -> queued, not lost | shared capture path (recorded in the test file) | COVERED ELSEWHERE |

## Gaps and their disposition

- **E2E**: waived, not failed. Nothing about this feature was verified in a browser; the risk is a popup
  wiring mistake that UNIT/INT cannot see (the panel opening, the button being reachable). Disposition:
  manual acceptance (TC-F11-S01) plus the recorded waiver. It is listed here rather than omitted.
- **TC-F11-I02**: not written, for the reason recorded inside `handlers.int.test.ts` - a note rides the
  identical capture path as a selection, whose queueing is already covered.
