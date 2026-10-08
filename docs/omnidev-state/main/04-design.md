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
