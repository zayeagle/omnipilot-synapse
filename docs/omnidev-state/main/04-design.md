# Design

## Feature F11: 手工录入（写笔记）

### Business Context
- Related: F1 捕获（capture.request 已支持 mode note 与校验，但**全仓没有任何入口** —— 这就是缺口）· F6 提交/索引/分片 · F8 就绪度
- Impact: popup（新入口 + compose 面板）· CaptureService.buildItem（note 语义修正）· i18n 双语。**无 worker 协议变更、无新 message type、无限流预算变更**（capture.request 已在既有允许列表与桶内）

### Implementation Logic
1. Entry: popup 剪藏行新增「写笔记」按钮 -> 展开 compose 面板（标题 input + 正文 textarea + 保存/取消）
2. Core: noteCapturePayload(title, text, fallbackUrl)（纯函数，放 lib/ui/format.ts，与 selectionCapturePayload 并列）-> {mode: note, url, title, selection: text} -> 走既有 capture.request
   （校验要求 url 非空：面板带当前标签页 URL，无页面时用合成值 omnipilot:note）
3. Data: buildItem 对 note 不写 excerptOf；标题为空时取正文首个非空行；id/时间/路径/索引/分片/提交全部复用既有路径

### Edge Cases
- Happy: 标题+正文 -> 提交 + Inbox 可见 + 可检索 | Err1: 正文为空 -> 本地拒绝（不发消息） | Err2: 存储不可达 -> 入队 queued，UI 说「稍后处理」 | Boundary: 正文超 LIMITS.selectionChars -> 本地截断并说明
- 未配置存储 / 保险库锁定 -> 沿用既有就绪度提示，不新增状态

### Data Changes
| Entity | Change | Details |
|--------|--------|---------|
| CKF source | 无 schema 变更 | note 复用 body；仅不再设置 excerptOf |
| popup | 新增面板节点与样式 | 不新增 message type |

## F16 - 检索索引改为本机存储（决策 B，2026-10-10）

### 动机（全部为实测事实）

- 仓库里每个词的桶都是一个 JSON 文件：一条 50 字中文笔记产生 **30 个分片**（实测 shards=30）；分片数随词前缀多样性增长，
  大语料下可达数千个文件。
- 每次捕获重写**所有被触及的桶**：中文笔记捕获 **89 次请求**、归档 **159 次**（实测）；Git 存储小文件的经济性很差，
  仓库持续膨胀。
- 每次查询/重建都要列 `search/` 目录，响应随文件数增长。
- **安全**：vault（加密）档位下，记录是密文但 `search/*.json` 是**明文**（索引内容取自 title/body 的分词）
  ⇒ 实质降级为部分明文，违背「vault 模式永不降级为明文」。

### 决议

索引是**派生数据**（`search/index.ts` 头部即写明 rebuildable from the repository），因此**索引不再进仓库**，只存本机。

### 设计

1. **存储**：索引分片写入 IndexedDB（与同步缓存同一个库、新增 object store）；IndexedDB 不可用时回退到内存后端
   （沿用既有 `createBestBackend` 的回退语义）。
2. **分桶**：现状**已经是哈希分桶**（`SHARD_BUCKETS = 256`，键形如 `b0f`，一次捕获最多重写 258 个文件 —— 有上界 ✓，
   不是“一词一文件”）。本改动把桶数降到 **64**（`SHARD_BUCKETS = 64`）：一次捕获的文件数上限从 258 降到 66，
   仓库里的索引文件数上限从 256 降到 64。查询仍只读该词命中的桶（1–3 个）。
3. **重建触发**：a) 同步后记录发生变化；b) 用户点「重建索引」；c) 本地索引缺失或以**仓库 head 之外**的版本构建过
   （存 `builtForHead`，不匹配即视为陈旧）。
4. **迁移**：仓库中既有的 `search/**` **删除**（一次性提交）。这需要把 `SyncRemote.commitFiles(files, message)` 扩展为
   可携带 `deleted: string[]`（store 层早已支持 `sha: null` 删除）；SSH/伴侣路径像源码删除一样抛 `deleteUnsupported`。
5. **失败可见**：索引不可用一律给出**可读原因 + 重建动作**；冷缓存时提示先同步；锁定保险库时说明无法核对索引。

### 工作流与协作四问

1. **用户做什么**：捕获、检索、重建 —— 操作与今天完全一致；唯一区别是检索在本机索引上完成，因此**更快**且仓库不再增长。
2. **协作者看到什么**：仓库里**只有记录**（不再有派生的 `search/` 文件）；换设备或清缓存后，各设备在本地各自构建一次索引。
3. **失败时**：索引缺失/陈旧 ⇒ 明确说明并给重建动作（沿用现有错误码与 guidance）；本地无记录 ⇒ 提示先同步。
4. **出口**：索引不可用**不是死路** —— 重建按钮始终可用；本次修好的「索引尚未建立」状态直接复用。

### 代价与风险（接受）

- 索引**不再随仓库走**：多设备各自建一次（首次检索前需要一次同步 + 一次本地构建，构建在后台进行并显示进度）。
- 首建/重建需要遍历本地记录（本机操作，毫秒到秒级），不再产生网络请求。
- 旧分片删除依赖 `deleted` 参数（步骤 4），SSH 模式下删除不可用 ⇒ 该模式下保留旧文件并在界面说明。

### 测试计划

- UNIT：分桶函数（固定 64 桶、分布与稳定性）、`builtForHead` 陈旧判定、索引存储后端的选择与回退。
- INT：捕获后索引在**本机**可查且仓库**不含** `search/`；同步后索引自动更新；head 变化触发重建；迁移删除旧分片；
  冷缓存与锁定保险库的失败路径（可读原因 + 动作）。
- E2E：现有 TC-E2E-03 / E2E-08 / E2E-09 的断言由「仓库里有分片」改为「本机索引可查」，并在真实浏览器里验证检索仍命中。
- 实测对照：给出**改前/改后**的「捕获请求数 / 仓库文件数 / 检索耗时 / 重建耗时」。

### 不在本次范围

紧凑编码（C）与后台延迟索引（D）：索引落地本机后，本地更新为毫秒级，D 不再必要；C 的收益随仓库不再承载索引而下降，
留作后续可选优化。