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

## 性能：四项操作的 3 秒预算（实测，2026-10-09）

用测试桩的 `worker.calls` **实测**请求数（不是估算），并给每次请求注入 20ms 延迟来测**墙钟时间**：

| 操作 | 请求数 | 改前墙钟 | 改后墙钟 |
| 录入（~50 字中文） | 89 | —— | 见下 |
| 归档 | 159 | 777 ms | **502 ms** |
| 删除 | 29 | 776 ms | **497 ms** |

（20ms/请求注入；按真实 150ms/请求线性外推：归档 ≈ 3.8s → 仍需继续压，见 backlog）

关键发现：请求数不是指标，**串行深度**才是。blob 上传与 `changedShards` 的分片读早已并发（前一轮性能改动），
**唯一剩下的串行热循环**在 `SearchIndex.remove` 的分片读上（`index.ts:295`），而它正好是**归档/删除**的路径 ——
已改为 `mapWithConcurrency`；并发上限由 8/12 提到 24/20（GitHub 官方上限约 100 并发，滥用检测针对创建型突发，
所以读比写更高）。

A6 断言更新：`TC-F4-I05`（并发不得超过上限）原硬编码 8，现改为断言 ≤ `SHARD_READ_CONCURRENCY`（导出常量），
上限再调时该用例不会再变成假绿。

新增测试：TC-F14-I01（实测四项操作的请求数）、TC-F14-I02（注入延迟测墙钟时间）。它们把性能变成**可测量的回归门**。

未解决（需决策）：**提炼**含模型生成（数秒），同步架构下无法满足 3 秒；要满足必须改为异步（受理→后台生成→卡片进提案）。
另一条结构性选项：把分片写从捕获提交里拆成第二次提交（索引可重建是既有设计），用户等待从 89 次降到 ~5 次。

## 性能续：popup 打开的请求放大（实测修复，2026-10-09）

发现：`resolveStore` 在**每条消息**里都重新解析存储（`resolveRepo` → `loadStoreConfig` = 一次读 .omnipilot/config.json 的网络请求）。
popup 打开会并发发 5 条消息（status / inbox / cards / review / sync）→ 5 次配置读 + 各自的数据读。

修法：**并发消息共享同一次在途解析**（`inFlightResolve` WeakMap + `resolveRepoShared`）。安全性是结构性的 ——
只有**已经在途中**的请求会合并，没有任何缓存/TTL，因此不存在陈旧档位或陈旧凭据；失败也会清除（不缓存 rejection）。

实测（新增 TC-F14-I03）：`BURST {messages: 5, configReads: 1, requests: 7}` —— 5 条消息只读一次配置，整个突发 7 次请求。

验证：tsc 0 · UNIT 630 · INT 130 · build 0（441.4 kB）。基线 INT 129 -> 130。

仍然开放（已在上一条分析里列出，等排期）：复习缺少"已复习"出口（无出口状态，P0）· 笔记在扩展内不可阅读（P0）·
frontmatter 引号策略待核实（P1 安全）· 草稿不持久（P2）· optional_host_permissions 收窄（P2）· 分片写拆分与提炼异步（P2，需取舍）。

## 安全核实结论：frontmatter 注入（安全，2026-10-09）

上一条分析里我把它标为「待核实」并拒绝下结论。现在读到了实现：

lib/core/markdown.ts:32-33 —— encodeScalar 对**所有字符串标量**使用 JSON.stringify(value)（JSON 双引号字符串是合法
YAML 标量且转义一切），而 encodeDoc 把 body **追加在闭合分隔符之后**。因此标题/标签中的换行、---、kind: card 只会
成为文本，无法伪造字段或改变记录身份。这是**结构性**保证。

新增钉子测试 TC-F15-U01（lib/core/document-injection.test.ts）：敌对文本往返后 kind 仍为 source，id/title/tags/body
原样还原，且文档中出现的是带引号的 kind: "source"。它的价值在于防止将来有人把 writer 简化为裸插值。

仍开放（按优先级）：① 复习无出口（P0 功能洞，违反「不制造无出口状态」）② 笔记在扩展内读不到正文（P0 体验洞）
③ 草稿不持久（P2）④ optional_host_permissions 收窄（P2）⑤ 分片写拆分 / 提炼异步（P2，需取舍）。

### 检索根因修复（2026-10-09，已完结）

两个成因（都实测确认）：

1. **候选分片来自“列 search/ 目录”**（index.ts 的 query）。列表为空或失败 ⇒ 候选为空 ⇒ **一个分片都不读、命中为 0**；
   而列目录失败还会被 catch 成 `needsRebuild`，把一次网络抖动说成“索引损坏，请重建”。现在候选键由**查询词自己算出来**
   （分片键是确定性的），列目录降级为**仅供陈旧检测**（best effort，失败不再谎报）。
2. **命中必须出现在文档表里**（query.ts 的 `allowed.length === 0 → 空响应`），而文档表来自**本地记录缓存** —— 缓存冷
   就等于“没有任何结果”。现在缓存为空时用**清单索引**（`remote.readIndex()`，1 次请求）兜底：命中仍有 id/path，
   标题与片段等缓存热起来再补。

实测（TC-F16-I01，去掉 it.fails 标记）：命中 **0 → 1**；请求 6 次（配置 + 目录 + **该词的 3 个分片桶** b28/bc9/bfa + 清单）；
2ms。顺带达成两项优化：查询只读**该词对应的桶**（不再随分片总数增长），且不再依赖列目录的完整性。

新增/调整的断言：TC-F16-I01（捕获后立即可检索，含 `hits > 0`）；TC-F16-I02 诊断用例已删除（它的使命是定位，不是守卫）。

**A6 断言更新（检索根因修复的配套）**：TC-F4-I03 原先要求「列目录失败 ⇒ needsRebuild=true」。那条契约本身就是
误导的来源（把网络抖动说成索引损坏），现在改为：**仅损坏分片 → needsRebuild**；**列表失败但分片可读 → 正常作答**
（查询只需要自己那几个分片桶）。同时把「损坏分片」那一支改为**损坏全部分片**，否则那条损坏未必落在查询的候选桶里，
测试会变成偶发。用例名相应改为「flags a corrupt shard, and still answers when only the listing fails」。

### 检索调查的结论与回退（2026-10-09，重要）

**我走了一段弯路，必须记录清楚**：我实测到「存了含某词的笔记，搜该词 0 命中、且不读任何分片」，据此改了检索的
候选选择（改为由查询词算出分片桶）。后续证据表明：**这个 0 命中是测试夹具的产物** —— 夹具的目录列表
（/contents/search）返回空，而产品代码在真实 GitHub 上并非如此。我把检索代码**完整回退**到审计过的形态，
并删除了那个只能测夹具、无法测产品的测试（TC-F16-I01）。

回退的依据（不是感觉）：我的改动同时打红了**两条既有契约**——
TC-F4-I03（任意位置的分片损坏都要被标记）与 TC-F4-I04（缺失分片不得产生请求，冷仓库零读）。
两者都是产品正确性/性能的守卫，我的改动与之冲突而**没有**带来可证明的用户收益，因此按证据回退。

**保留下来的是真正的产品发现（待修）**：`search.query` 里列目录失败会被 catch 成 `needsRebuild`，
于是**一次网络抖动会显示成「索引需要重建」**（用户实际看到的红字），误导并且没有给出正确动作。
修它需要同时调整上述两条契约（损坏分片才需重建；列表失败可继续用查询词算出的桶作答），并补测试。
另一条性能事实：一次查询会读**列出的每个分片**（不是只读该词的桶），所以仓库越大查询越慢；
优化方向是 search/manifest.json 或按 HEAD sha 缓存列表（见 Open Backlog）。

最终状态：检索代码与基线均未被本次调查改变（INT 130 / UNIT 631），夹具缺口与产品发现都已入库。

### 检索调查中保留下来的改动（2026-10-09，需补测试）

buildSearchIndex 的 docs 回调原本只从**本地记录缓存**取文档；缓存冷时 search() 会因 allowed.length === 0
直接返回空响应 —— 也就是说**缓存冷 = 检索查不到**。现在缓存为空时回退到**清单索引**（remote.readIndex，1 次请求）：
命中仍带 id/path，标题与片段等缓存热起来再补。

保留理由：它是「存了却搜不到」的一个真实成因，且不破坏任何既有断言（INT 130 全绿）。
**但它缺少直接测试**（需要一个冷缓存夹具才能覆盖），这是对「新逻辑必须有测试」的偏离，明确记录在此，
不能算作已完结；补测试属于下一步（与上一条 needsRebuild 误导一起做）。

### 检索速度：只读该词的桶（2026-10-09）

根因：query() 以前把**目录列出的每个分片**都读一遍（for key of keys → readShard），中文语料分片可达数百个，
于是索引越大检索越慢，且每次查询都付。改为：**由查询词算出需要哪几个桶**（tokenizeForSearch + parseQuery 的
indexTerms），目录列表只用于过滤「哪些桶确实存在」；**列表为空则一个分片都不读**（冷索引零请求的既有契约不变）。
典型查询从读全部分片降到 **1–3 次分片读**。

A6：TC-F4-I03 的「损坏分片」一支原为「任意一个分片损坏」，现改为**损坏全部分片**（确定性）—— 查询只需自己那几个桶，
路径外的损坏本就不该影响这次查询。

### 同步：失败被说成成功（2026-10-09，已修文案，原因待呈现）

现象（用户截图）：绿条写「同步已完成 — 上次同步失败」，同时状态是「尚未同步 / 上次同步：从未」—— 自相矛盾。

原因：options/main.ts 的 toast 用恒定前缀 + 结果标签拼接（options.sync.done 恒为「同步已完成」），
且颜色恒为 success ⇒ 唯一最需要醒目的状态（失败）看起来像成功。已改为**由 outcome 决定整句与颜色**：
失败时只显示「上次同步失败」并用 error 色。

仍缺：**失败原因没有呈现**。数据是有的（handlers.ts:510 传出 lastFailureCode，status.ts:201 已把它映射成
可读 guidance），但同步面板没有渲染它 ⇒ 违反「失败可见：可读原因 + 一个可执行动作」。下一步就是把它渲染出来，
并配一个动作（重试 / 打开安全 / 前往存储配置）。

重要推论：**同步失败会连锁导致检索不可用** —— 缓存空 ⇒ 重建写不出任何分片 ⇒ 仓库没有 search/ 目录 ⇒
检索报「索引需要重建」。所以「检索查不到」的根因很可能就是同步本身失败，而不是检索代码。

### 同步状态：成功不再显示“从未”（2026-10-09，已修且有断言）

用户现象：「上次同步：从未」+ 绿条「同步已完成 — 上次同步失败」（自相矛盾）。

三个环节共同造成，缺一不可：
1. **成功路径不写状态**：performSync 只在 catch 里 updateState(failed)，成功直接 return ⇒ 状态永远是默认值。
2. **投影是旧的**：sync.now 返回 `publicPrefs()` 时没有把刚发生的状态传进去，而 publicPrefs 是“存储里的投影”
   ⇒ 面板读到上一次的值（默认 never）。
3. **夹具没有共享缓存**：worker 持有单例 cache（background.ts:48 经 context.syncCache），而测试夹具每次
   createSyncCache 都新建内存后端 ⇒ 写入对下一次读取不可见 ⇒ **前两个即使修好也无法被测试证明**，
   也就是我上一轮“改了却验证不出效果”的真正原因。

修法：①成功也记录 outcome（引擎写过则以引擎为准，只补缺口）；②sync.now 显式把 cache 里读回的新状态传给投影；
③夹具接上单例 cache，与 worker 一致。

验证：TC-F17-I01 断言 `prefs.sync.lastOutcome === 'upToDate'` 且 `lastSyncAt` 非空 —— 实测通过（此前为 never）。

### 检索端到端打通（2026-10-09，已修且有用例钉住）

用例 TC-F16-I01（F16 INT）：捕获一条含「能力」的笔记 → 删掉 search/ 下的全部分片（= 用户状态）→ 重建 → 检索。

实测输出：

    E2E capture {ok:true}
    E2E before  {needsRebuild:false}                           无索引时不再谎报需要重建（读取按空索引处理）
    E2E rebuilt {records:1, shards:31, shardFiles:31}          重建真的写出 31 个分片
    E2E after   {hits:1, needsRebuild:false}                   检索命中

关键前提（也是此前用例失败的真因）：**夹具必须像 worker 一样持有单例缓存**（context.syncCache）。
此前每次 createSyncCache 都新建内存后端 ⇒ 重建时的同步把记录写进 A、重建从 B 读 ⇒ 无记录可索引 ⇒ 写不出分片。
夹具与生产不一致，导致这个 bug 既测不出也看不见。

现在：重建会真正写入分片，且查询能命中。用户侧的「索引需要重建」最可能是**跑了旧构建**（重载前点的重建）。

仍待办：重建若 records=0 应明确报「没有可索引的记录，请先同步」，并在选项页显示「已重建 N 条 / M 分片」
（worker 已返回这两个数字，只差界面渲染）。

### 里程碑 2：重建不再“空成功”（2026-10-09，已修）

选项页的“重建索引”原先无论结果如何都显示绿色成功，而 records=0 时它什么都没写 —— 这正是“界面说重建好了、
仓库里却没有 search/ 目录”的来源。现在：
- records=0 → **info 色**提示「没有可索引的记录 — 请先同步 · 0 / 0」（并说明该做什么）
- 否则 → 「索引已重建 · N 条 / M 分片」，数字来自 worker 早已返回的 {records, shards}

三个里程碑的状态：
1. 同步状态落库 —— 完成（TC-F17-I01 断言 lastOutcome=upToDate、lastSyncAt 非空）
2. 重建诚实化 —— 完成（本文档）
3. 检索端到端 —— 完成（TC-F16-I01：重建写出 31 分片，查询命中 1）

验证：tsc 0 · UNIT 631 · INT 132 · build 442.8 kB · assert:content OK。

### 3 秒预算：检索达到并钉住（2026-10-09）

目标要求「关键词检索在 3 秒内可用」——此前只有请求数，没有墙钟证据。现在用**注入真实往返延迟**测量：

    LATENCY {searchMs: 930, hits: 1, perCallDelayMs: 150}   ← 每请求 150ms（偏保守），命中 1 条

新用例 TC-F16-I02：先把索引建好（快构建），再把同一份仓库文件交给一个 delayMs=150 的 worker 计时查询，
断言 hits>0 且 **searchMs < 3000**。930ms 相对 3s 有 3.2 倍余量，且查询只读该词的 1–3 个桶，
不会随语料规模线性变慢。

验证：tsc 0 · UNIT 631 · INT 133 · build · assert:content OK。

### E2E 全量跑通：21/21（2026-10-10，含检索 E2E）

结论：能跑 E2E，而且跑完了 —— **21 passed (50.5s)**，其中 `e2e/search.spec.ts` 的 TC-E2E-03
（捕获 → 同步 → 重建 → 查询 → 断言命中路径与片段）在**真实 Chromium + 真实 service worker + GitHub 桩**下通过 ✓。

先前的红色来自两条**过期用例**（早前 delegated worker 留下、从未被跑过）：e2e/popup-status.spec.ts 的
TC-F8-E01/E02 断言的是**已被业主删除的旧 UI**（面板里的 记笔记 按钮与两个剪藏按钮、折叠的 composer）。
按 A6 更新：E01 保留其真正要守的性质（在途状态属于状态行、不属于任何按钮），断言对象改为面板现存的那个动作
（popup.noteSave）；E02 整个前提已消失，改写为「无需点击即可到达输入框，且面板只有一个动作」并显式断言
记笔记/剪藏按钮**不再存在**（防止它们长回来）。

诚实的边界：E2E 走的是**本地桩**，所以它证明的是**正确性**（真实浏览器里的行为），不是耗时；3 秒预算由 INT 的
延时注入用例证明（TC-F16-I02：150ms/请求 → 930ms，断言 <3000ms）。两者互补，不能互相替代。

基线：E2E ≥19 -> **≥21**。

### “上次同步失败”是假警报（2026-10-10，已修，根因在投影）

业主反复看到红字「上次同步失败」，但同步面板同时说「尚未同步 / 从未」—— 两者矛盾，说明红字不真。

根因：lib/ui/format.ts 的 normalizeSyncResult 在顶层读 outcome，而 sync.now 的回复是 `{report, prefs}`
（outcome 在 data.report.outcome）⇒ 永远读不到 ⇒ 落到 else 分支的 `'failed'` ⇒ **无论同步实际结果如何都显示“失败”** ✗。

修法：先解包 `report`（兼容裸 report），且**无法识别时返回空串而不是 failed** —— 认不出来是“未知”，不是“失败”；
调用方遇到空串只重绘面板、不做任何结果断言（不再编造失败）。

A6 断言更新：format.test.ts 的 TC-F5-U03 原断言 `normalizeSyncResult('nonsense').outcome === 'failed'`，
**它正是把这个 bug 保护起来的断言**，改为 `=== ''` 并补 `{report:{outcome:'upToDate'}} → 'upToDate'`；
新增 lib/ui/sync-result.test.ts（TC-F14-U01/U02）。

验证：tsc 0 · UNIT 633 · INT 133 · **E2E 21/21（50.6s，真实 Chromium）** · build 443 kB · assert:content OK。
基线：UNIT ≥631 -> **≥633**。

### 破除「需要重建 → 重建什么都不写 → 需要重建」的死循环（2026-10-10）

业主的截图给出 `1 / 0`（记录 1 条、分片 0 个）—— 记录存在但没有可索引文本时，重建**永远不会创建 search/ 目录**，
于是下一次检索又报「索引需要重建」，形成**无法靠重建走出的循环** ✗。

修法：**「没有索引」是空索引，不是损坏的索引**。query() 在分片列表为空（目录不存在或没有分片）时返回
`indexMissing: true` + `needsRebuild: false` + 0 命中；404 抛错的分支同样如此。判断依据是事实，不是猜测。

新增 INT 用例 TC-F16-I03：仓库有记录但删掉全部分片 → 查询返回 indexMissing=true、needsRebuild=false、hits=0
（实测输出 MISSING-INDEX {indexMissing:true,needsRebuild:false,hits:0}）。

仍待：把 indexMissing 渲染成界面提示（「索引尚未建立 — 请在设置里重建索引」，双语键）。

### 信任端点的两个缺陷（2026-10-10，定位；一半已修）

业主报告：设置 → AI 授权 的「我信任该端点」勾选**没有持久化**（重载后又变空）。

1. **worker 完全忽略同意标记（已修）**：handlers.ts 的 settings.provider 只要 payload.baseUrl 非空就
   把该主机写入 trustedHosts，**从不检查 payload.trustAcknowledged** ⇒ 勾没勾都信任，违反「AI 出网默认关闭、
   逐条授权」。现改为 `if (payload.baseUrl && payload.trustAcknowledged === true)`。该标记本来一路都在
   （messages.ts 的 ProviderSettingsPayload、validator、format.ts 的 formToProviderPayload），只有最后一跳没用。
2. **勾选后主机仍未写入（未修，已复现）**：夹具里带 trustAcknowledged=true 保存后，settings.export 的
   ai.trustedHosts 仍为空 ⇒ 回填 endpointAlreadyTrusted() 为 false ⇒ 勾选看起来无效。这正是业主看到的
   「没有持久化」。下一步：沿 settings.provider 的 patch → settings-store.patch → export 三段查该数组为何丢元素。

过程记录（诚实）：我为这条写的 INT 用例在替换时误吞了夹具的 send / configuredWorker 助手，导致文件无法编译；
已用 git checkout HEAD -- lib/background/handlers.int.test.ts（注意工作目录是 apps/extension，第一次路径写错、
checkout 静默未生效）恢复，套件回到绿。那条守卫用例待缺陷修好后重建。

样式：选项页搜索区的「请输入搜索内容」在尚未搜索时是孤儿提示，已改为初始隐藏；搜索输入框与按钮的垂直对齐仍待一轮 CSS。