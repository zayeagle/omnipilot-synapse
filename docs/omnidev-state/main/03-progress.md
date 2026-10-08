# Progress - req-2026-09-30-synapse-manual-entry

## Group G1 - F11 手工录入（写笔记）

✅ T1 · lib/ui/format.ts (noteCapturePayload, NOTE_URL), lib/capture/service.ts (buildItem note semantics) · 10:54
✅ T2 · entrypoints/popup/main.ts, entrypoints/popup/style.css, lib/i18n.ts (6 keys x2) · 10:54
✅ T3 · lib/ui/note-payload.test.ts (new), lib/background/handlers.int.test.ts · 10:54
✅ T4 · 07-security-audit.md, 08-spec.md, 03-progress.md · 10:54

## Findings worth keeping

- **The protocol already carried `mode: 'note'`** (typed, validated, and handled by `CaptureService`) with **no
  surface anywhere that could send it** - which is precisely why the feature read as "not supported". A
  capability with no entry point is, to the user, absent. The work was therefore a surface plus two semantic
  corrections, not a new pipeline.
- `buildItem` treated every non-page mode as a selection, so a note was recorded as an EXCERPT of the URL it
  happened to sit next to, and an empty title fell back to that URL. Both are mode-aware now (TC-F11-U04..06,
  TC-F11-I01).

## Assertion changes (A6)

- None. The new tests are additive; the page/selection paths are pinned by the existing suites, which stayed
  green (UNIT 621, INT 121, REG 409).

## Waivers

- **E2E (browser suite)**: waived for this requirement on the user's explicit instruction ("do not run E2E",
  given twice on 2026-09-30). `05-test-plan.md` records it in `e2e_waiver`, TC-F11-S01 is listed for manual
  acceptance, and Phase 4 records the gap instead of pretending it ran.
- **TC-F11-I02** (queued on a transient store failure) is not duplicated: a note rides the identical
  `CaptureService.capture` path as a selection, whose queueing is already covered. The reason lives in the
  test file itself so the omission is traceable.

## Verification

| Layer | Command | Result |
|-------|---------|--------|
| types | npx tsc --noEmit | 0 |
| UNIT | npm test | 621 passed / 59 files |
| INT | npm run test:int | 121 passed / 13 files |
| REG | npm run test:reg | 409 passed |
| build | npm run build | 0 (425.9 kB) |
| content bundle | npm run assert:content | OK |

## Closure

- Phase 5 (release) skipped by the user: this product is an unpacked extension, so there is no production
  deploy and no release to cut for F11. Version stays 0.1.0 unless the owner asks for a bump.
- **Manual acceptance still owed (the E2E waiver)**: refresh the extension -> open the popup -> 写笔记 ->
  fill a title and body -> 保存 -> the note must appear in the Inbox and be findable in search. A note with
  no title must be titled after its first line.
- Changes are NOT committed: repository rule, and the owner has not asked. The tree carries F11 plus the
  earlier unlock-policy/trust work and the regenerated state docs.
