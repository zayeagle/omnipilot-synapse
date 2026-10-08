---
test_strategy_profile: frontend-M
layers_required: [unit, integration, smoke, regression]
e2e_tool: playwright
e2e_required: false
integration_required: true
e2e_waiver: user instruction 2026-09-30, do not run the browser suite; manual acceptance instead
---

## Test Strategy Summary
| Layer | Required | Tool | Command | TC Count |
|-------|----------|------|---------|----------|
| UNIT | yes | vitest | npm test | 6 |
| INT | yes | vitest | npm run test:int | 2 |
| E2E | WAIVED | playwright | npx playwright test | 0 |
| SMK | yes | manual | - | 1 |
| REG | yes | vitest | npm run test:reg | 1 |

## F11 - UNIT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|-------|------|--------|-------|----------|------|
| TC-F11-U01 | UNIT | Happy | noteCapturePayload | title+text | mode note, url fallback, selection=text | none |
| TC-F11-U02 | UNIT | Error | noteCapturePayload | empty text | null (refuse locally) | none |
| TC-F11-U03 | UNIT | Boundary | noteCapturePayload | over-limit text | capped at LIMITS.selectionChars | none |
| TC-F11-U04 | UNIT | Happy | buildItem(note) | title empty + two lines | title = first line, no excerptOf | none |
| TC-F11-U05 | UNIT | Happy | buildItem(note) | title T | title T, body = text | none |
| TC-F11-U06 | UNIT | Error | buildItem(selection) | selection payload | excerptOf still set (unchanged) | none |

## F11 - INT
| TC-ID | Layer | Type | Target | Input | Expected | Mock |
|-------|-------|------|--------|-------|----------|------|
| TC-F11-I01 | INT | Happy | capture.request(mode note) | note payload | committed + index entry + inbox list | fake GitHub API |
| TC-F11-I02 | INT | Failure | same, store transient | note payload | queued true, nothing lost | store throws |

## E2E Flows
| TC-ID | Layer | Flow | Steps | Expected |
|-------|-------|------|-------|----------|
| (waived) | E2E | 写笔记 | popup -> 写笔记 -> 填写 -> 保存 | Inbox 出现该条 —— 刷新扩展后由用户手工验收 |

## Smoke Suite
| TC-ID | Source-TC | Layer | Critical Path |
|-------|-----------|-------|---------------|
| TC-F11-S01 | TC-F11-I01 | SMK | 写一条笔记 -> 出现在 Inbox 与检索结果 |

## Regression Suite
| TC-ID | Layer | Module | Package | Type |
|-------|-------|--------|---------|------|
| TC-F11-R01 | REG | lib/capture, lib/ui | extension | 既有捕获/选区测试不受 note 修正影响 |
