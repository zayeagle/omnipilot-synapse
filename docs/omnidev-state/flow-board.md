# Flow Board

| Field | Value |
|-------|-------|
| status | **done** |
| mode | auto (autopilot) |
| requirement | req-2026-10-10-synapse-index-locality |
| updated_at | 2026-10-12T15:58:00+08:00 |

| Phase | Name | State |
|-------|------|-------|
| 0 | Assessment | done - M |
| 1 | Blueprint | skipped (M) |
| 2 | Planning | done - 04-design F17 / 05-test-plan / 02-plan |
| 3 | Development | done - write path moved to the machine, query no longer falls back, migration in rebuild, B.22 PASS |
| 4 | Testing | done - UNIT 645 / INT 139 / REG 416, E2E waived (gap recorded) |
| 5 | Deploy | skipped (unpacked extension, no production deploy) |

## Next
Nothing scheduled. Manual acceptance owed: capture a note containing 能力 and search it WITHOUT rebuilding,
then confirm the commit carries no search/ directory.
