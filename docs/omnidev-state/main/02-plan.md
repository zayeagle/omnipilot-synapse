# Plan - req-2026-09-30-synapse-manual-entry

Feature: **F11 手工录入（写笔记）** · 复杂度 M · autopilot

- [x] **T1** [extension] 载荷构造 + note 语义修正 · feature: F11 · outputs: lib/ui/format.ts (noteCapturePayload), lib/capture/service.ts (buildItem) · depends: - · verify: npx vitest run lib/ui/format.test.ts
- [x] **T2** [extension] popup 写笔记面板 + 样式 + 双语文案 · feature: F11 · outputs: entrypoints/popup/main.ts, entrypoints/popup/style.css, lib/i18n.ts · depends: T1 · verify: npx tsc --noEmit && npm run build
- [x] **T3** [extension] 测试（UNIT + INT）· feature: F11 · outputs: lib/ui/format.test.ts, lib/capture/service.test.ts, lib/background/handlers.int.test.ts · depends: T1,T2 · verify: npm test && npm run test:int
- [x] **T4** [extension] 安全审计 + 文档同步 · feature: F11 · outputs: 07-security-audit.md, 03-progress.md, 08-spec.md · depends: T3 · verify: npm run assert:content

## Traceability
| Task | Feature | TC-IDs | SC |
|------|---------|--------|----|
| T1 | F11 | U01-U06 | SC-F11-01..03 |
| T2 | F11 | - (surface) | SC-F11-01 |
| T3 | F11 | I01, I02, S01, R01 | SC-F11-01, 02, 04 |
| T4 | F11 | - | - |

## Task Groups
| Group | Tasks | Gate |
|-------|-------|------|
| G1 | T1, T2, T3, T4 | Pre-Dev gate (soft under autopilot) -> Dev -> Phase 3 exit security audit |

## Open Backlog
- 本地文件导入（md/pdf/txt）仍是需求里未实现的输入通道，属独立需求，本需求不做。
- 从右键菜单直接「存为笔记」需要能程序化打开 popup（MV3 仅 Chrome 127+ 支持），暂不做。