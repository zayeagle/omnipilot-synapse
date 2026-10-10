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

## Post-completion feedback 4 (owner, 2026-10-09) - 锁定状态要给出可执行动作

用户截图里那句「保险库已锁定 —— 未写入任何明文 —— 请先解锁保险库」**没有任何按钮** —— 这违反了仓库硬约束
「失败可见：可读原因 **+ 一个可执行动作**」。已修：阻塞态现在是一个可交互块（`.blocked`），解锁态下多一个
「去解锁」按钮，深链到 `options.html#security`（options 页按 hash 打开对应页签）；只有 `vaultLocked` 才给按钮，
其它阻塞原因（未配置、伴生进程缺失）不误导。

关于「锁定默认不打开」：口令信封的密文**没有口令无法解密**，因此已加密的数据躲不掉**最后一次**解锁；此后按
默认的「在本机记住解锁状态」不再询问。真正的「从不涉及口令」需要**无口令模式**（本机随机密钥 + 默认不锁，安全页
可开启口令锁）—— 属于安全模型变更，已向用户说明取舍并等待确认。

验证：tsc 0 · UNIT 627 · build 0（435.4 kB）· assert:content OK。基线 UNIT 622 -> 627。

## Post-completion feedback 5 (owner, 2026-10-09) - 无口令默认（keyless）

用户选择「无口令默认」。实现方式刻意最小：把本机随机密钥当作「我们替你管理的口令」，从而完整复用既有的
信封 / KDF / 加解密路径 —— 加密学零改动，只是没有人再被问到口令。

- UnlockPolicy 增加 keyless 并成为默认（getUnlockPolicy 缺省即 keyless）
- 新增 local:vaultLocalSecret（32 字节随机 -> base64）；ensureKeylessVault() 在首次使用时按需创建信封，
  adoptLocalSecret() 在任何密钥读取前静默采用（getSecrets 首行调用），因此不存在「锁定」这个状态
- 设置口令 = 打开锁：setupVault 现在会删除本机托管密钥（口令成为唯一入口）；rekeyToLocal() 用于关闭锁
  （需先解锁，密钥带过去）
- 安全页控件语义随之变为「启用口令锁」，默认关闭；文案写清两种状态的代价；「空闲自动锁定」只在开着锁时可用
  （关着锁时置灰并说明），因为它只对需要口令的会话有意义
- 测试：TC-R8-U07（全新安装按需建库、托管密钥落盘、二次调用不重建）；TC-R8-U04 的期望按 A6 由 remember 改为 keyless

验证：tsc 0 · UNIT 628 · INT 127 · build 0（438.0 kB）。基线 UNIT 627 -> 628、INT 124 -> 127。

## Post-completion feedback 6 (owner, 2026-10-09) - 自动同步被静默跳过

用户问「同步应该是自动完成，为什么还要手工处理」。查证结论：**同步本来就是自动的** ——
`DEFAULT_SYNC_POLICY = { intervalMinutes: 30, onStartup: true, onCapture: true, pullOnly: false }`，
`triggers.schedule()` 注册 chrome.alarms，`onAlarm → trigger('alarm')`，bootstrap 里 `trigger('startup')`，
剪藏后触发，另有 `service.flushQueue()` 补交离线队列。

**真正的缺陷是静默跳过**：bootstrap 里的自动启动同步写成
`if (snapshot.syncPolicy.onStartup && session.isUnlocked())` —— 保险库锁着时**一声不响地不跑**。用户长期处于
解锁前状态，于是状态行永远是「尚未同步」，自动同步看起来根本不存在。这违反了仓库硬约束「失败可见」，
也解释了为什么「自动完成」的功能被体验成「需要手工点」。

已修：去掉解锁门禁 —— 该跑就跑；锁定导致的失败会作为**可读原因**出现在状态行（`failureCode` → guidance →
一键动作，这条链路 popup 早已具备，无需新造）。

顺带核实（避免重复建设）：popup 的同步行**已经**显示上次同步时间、失败原因与动作按钮，不新增。
唯一本质上需要人的部分仍是**冲突决策**（两份都在，谁赢只能由人定；不决策则都留在 archive/conflicts/）。

验证：tsc 0 · UNIT 628 · INT 127 · build 0（438.0 kB）。

## Post-completion feedback 7 (owner, 2026-10-09) - 更新扩展后浮动窗口变成新标签页

用户点 chrome://extensions 的「更新」后，浮动窗口变成 Chrome 新标签页。原因是 Chrome 在扩展被重载/更新时
**吊销该扩展的所有已打开页面**，而浮动窗口本身是普通浏览器窗口（这正是它能被拖动的原因），于是退回新标签页。
代码与产物完好（getURL('/popup.html?mode=window') 未变、popup.html 正常构建）。

我第一版修法有两个错误，已一并改正：
1. 只做到「用户再点一次 ⧉ 时修复」—— 而用户的动作是点「更新」，所以应该**自动修**。
2. 把窗口 id 存在 storage.session —— 扩展一重载这份记录就没了，连「再点一次」都修不了。

现在：窗口 id 存 storage.local（重载后仍在）；新增 lib/ui/floating-window.ts（记住/读取 id、聚焦或修复窗口
—— 修复手段是导航它的 tab，因为 windows.update 不能导航）；background 的 bootstrap 在每次 worker 启动时
**自动修复**，于是「更新」之后窗口会自己回到控制台，不需要用户知道任何事；⧉ 仍复用同一个窗口，避免堆积。

验证：tsc 0 · UNIT 628 · INT 127 · build 0（440.0 kB）· assert:content OK。

## Post-completion feedback 8 (owner, 2026-10-09) - 面板只保留写笔记（剪藏合并为选区路径）

用户要求：把「剪藏本页 + 剪藏选区」合并成一个剪藏且只支持选区；面板上不再出现剪藏按钮；面板只保留「记笔记」。

实施：popup 移除两个剪藏按钮与其实现（clipPage / clipSelection / readPageSelection / setActionMode 与 ActionMode
状态一并删除，避免留死代码），动作行只剩记笔记；剪藏回到它的自然位置 —— 页面上的选区气泡（选中文字 -> 气泡 ->
剪藏）。

刻意没有做的一件事：**没有把选区做成选中即自动入库**。那会让每次复制文字都被存进知识库，「零压力」会变成「零控
制」；如果确实要自动触发，需要同时给一个撤销入口，属于独立决策。

A6 断言更新：render.test.ts 的 TC-F8-U02 原本断言面板里有剪藏按钮，现改为断言**面板里没有剪藏按钮**（防止它再长
回来）且记笔记存在；公开仓库那条用例的断言对象由剪藏改为记笔记。

验证：tsc 0 · UNIT 628 · INT 127 · build 0（440.7 kB）· assert:content OK。

## Post-completion feedback 9 (owner, 2026-10-09) - 输入框直接显示，去掉触发按钮

用户要求：不要点击按钮，打开就显示输入框。于是写笔记面板**默认可见**，触发它的按钮与用于关闭它的「取消」
一并移除 —— 一个只负责展开输入框的按钮是多出来的一个控件。保存仍是它唯一的动作（未就绪时该按钮禁用）。

随之清理：noteButton / actions 行 / setNoteOpen / noteCancelButton 与其监听器，以及 app.append 中的 actions 项、
保存成功后关闭面板那一步（面板常驻，无需关闭）。

A6 断言更新：TC-F8-U08 由「点按钮展开、点取消关闭」改为「无需点击面板就在屏幕上、且只提供保存一个动作」
（并断言不再有 记笔记/取消 这类只为展开或关闭而存在的控件）；TC-F8-U02 与公开仓库用例的断言对象由记笔记改为
保存笔记。

验证：tsc 0 · UNIT 629 · build 0（440.5 kB）。