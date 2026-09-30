# OmniDev Flow Board

- status: running
- mode: auto (autopilot)
- autopilot: true
- current: Phase 3 — Development (in progress; pre_dev confirmed long ago)
- started: 2026-09-29T17:50:00+08:00

| Phase | Name | State |
|-------|------|-------|
| 0 | Assessment | ✅ done |
| 1 | Blueprint | ✅ done |
| 2 | Planning | ✅ done |
| 3 | Development | ✅ done — 判据/门禁文档 · 全量审计 · 提案闭环 · 冲突决策面 · 失败可读 · 复习回路 · SSH 克隆引导 · 首启内容档位显式选择 · E2E 12→19 · B.22 iteration 4 PASS |
| 4 | Testing | ⏳ pending |
| 5 | Deploy | ⏳ pending |

## Requirement

`req-2026-09-29-synapse-workflow-elegance` — 把"对用户知识工作流的理解深度 + AI 与用户协作的优雅程度"
确立为基本设计理念并写入文档与门禁；按该理念审计全部已实现功能（证据化）；统一优化审计发现的问题。

Previous requirement `req-2026-07-09-synapse-git-sync` is **complete** (Phases 0–3 + B.22 PASS; Phase 4/5 not run).
Superseded artifacts are archived to their paired `*-history.md` before their first rewrite.

## Controls

- Open: `/od board` or `$od board`
- Manual next: `/od board next` · Pause: `/od x`
- Required phases **0** and **3** cannot be skipped.
Hard gates (`b0_confirm`, `pre_dev` M/L/XL, `deploy_prod`, `test_gate_fail`, manual `security_iterate_confirm`) still ask.

