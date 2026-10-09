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

## Post-completion feedback (owner, 2026-10-08)

- Action order in the popup: **写笔记 first (default), then 剪藏本页, then 剪藏选区**. The emphasis moved with
  it (写笔记 is the primary button) so the row does not read backwards; the compose panel still starts
  COLLAPSED, because opening the popup must not push a form at the user (零压力).
- Verified: tsc 0, UNIT 621, build 0 (425.9 kB), `assert:content` OK.

## Post-completion feedback 2 (owner, 2026-10-08) - 真删除 (F12)

笔记现在有两个动作，后果不同：

- **归档**：正文移到 archive/sources/，原路径留墓碑，索引与分片不再引用 —— 可恢复。`source.archive` + lib/sources/archive.ts。
- **删除**：在同一次提交里把文件从仓库**移除**，并从索引与分片中摘掉 —— **不可恢复**。`source.delete` + lib/sources/delete.ts；popup 的按钮**先武装再执行**（第一次点击是询问，5 秒内第二次才真删），因为一次点击就永久生效正是要避免的误操作。

存储能力：REST 侧把删除作为 Git Data API 的树项 `sha: null` 传递（lib/store/github-api.ts）；删除与普通文件分开列出，因为删除没有 blob 要先创建。SSH 伴生进程只能新增/覆盖，因此它以自己的错误码回答（`deleteUnsupported`：「切到 Token 模式，或改用归档」）—— 报告限制，而不是提交一次并未发生的删除。已记入 02-plan.md 的 Open backlog。

测试：TC-F12-I01（归档）、TC-F12-I02（真删除不留任何痕迹：无墓碑、无 archive 副本、不再列出）、TC-F12-I03（索引与请求不一致时以 conflict 拒绝且不删任何东西）。测试桩被教会理解 `sha: null` —— 否则每条删除用例都会在一个**仍然持有该文件**的仓库上通过。

验证：tsc 0 · UNIT 621 · INT 124 · build 0 · assert:content OK。基线 INT 121 -> 124。

## Post-completion feedback 3 (owner, 2026-10-08) - 提炼报锁定 / 打开不可点 / 面板精简

1. **提炼报「保险库已锁定」且只有解锁一次才好** —— 根因是我上一版的一个**覆盖漏洞**：派生密钥只在
   `unlock()` 与 `setupVault()` 里被记住，而**在解锁策略存在之前就已解锁**的安装从未存过密钥，于是每次
   重启都回到「要口令」。修：`SettingsStore.rememberCurrentKey()` + `background.refresh()` 在会话已解锁
   且未存过时**补记一次**。这条正是「默认本机记住」本该覆盖、却被我漏掉的那一半。
2. **笔记的「打开」按钮不可点**：笔记没有可打开的页面。现在按 `isSafeExternalUrl` 判断，**没有可打开的
   http(s) 地址就不显示这个按钮**（贴着网页写的笔记仍保留该页面地址与按钮）；一个点了没反应的按钮比没
   有按钮更糟。
3. **检索与同步收进页签**：页签变为 收件箱 · 待处理 · 复习队列 · 检索 · 同步（可换行），下面只有一个面板
   区（`.panes`）。不可读时**页签变灰 + 面板区整块隐藏**，只留一行原因 —— 而不是四个空面板。

验证：tsc 0 · UNIT **622**（新增 TC-R8-U06：无会话时补记是空操作且不抛）· INT 124 · build 0（433.5 kB）· `assert:content` OK。基线 UNIT 621 -> 622。