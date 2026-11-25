# QQ 监控（qq-monitor）

DeepSeek Harness 侧栏插件：在 Web 界面左侧栏新增一个「QQ 监控」入口，点进去就是一个
AstrBot 风格的对话镜像窗口，实时显示 `@tencent-connect/dsh-qqbot` 驱动的 QQ 聊天记录。

## 使用

1. 重启 Harness（或等待插件热加载）后打开 Web 界面；
2. 左侧栏图标列里点「QQ 监控」（机器人小图标，order 12）；
3. 左列是 QQ 会话清单（来自 `~/.dsh-qqbot/model-prefs.json` 的映射），
   点一个会话，右列显示对话气泡，每 3 秒自动刷新（页面不可见时暂停）。

## 标签页（总览 / 对话 / 统计）

头部下方标签栏，用 URL hash（`#overview` / `#chat` / `#stats`）记住当前页，刷新保持。
标签定义是可注册数组（`TABS`），后续新功能按 `{ id, label, render }` 追加即可。

### 总览页

1. 顶部沿用状态条（四卡片健康看板）；
2. **「此刻在做什么」由会话最后事件推导，不依赖模型自述**：
   `user/message` → 思考中；`tool/call` → 正在使用 <工具名>（持续秒数）；
   `assistant/message` → 空闲（距今时间）。工具名映射表 `TOOL_CN` 是常量，便于扩展；
3. **今日时间线**：0–24 点横轴，竖线标事件（蓝=用户 绿=机器人 黄=工具），悬停显示时间，纯 SVG；
4. **模块卡片网格**：渲染 `~/.dsh-qqbot/panel/*.json` 注册的外部卡片。

### 统计页（全部由 transcript 前端聚合，零外联）

- 近 14 天每日消息数折线（SVG）；
- 回复耗时：用户消息 → 机器人下一条回复的时间差，中位数与 P90（窗口 10 分钟内）；
- 工具调用次数排行（前 8，条形图）。

## 模块卡片注册（外部功能接入点）

任何插件/脚本写一个 JSON 文件到 `~/.dsh-qqbot/panel/<id>.json` 即可在总览页出现卡片：

```json
{
  "id": "bili-duty",
  "title": "B站值守",
  "icon": "📺",
  "status": "ok",
  "headline": "上一轮看了 2 个视频",
  "rows": [{ "label": "今日已看", "value": "14 个视频" }],
  "spark": [2, 5, 3, 8],
  "updatedAt": 1795576904603
}
```

- 单文件限 8KB；解析失败/形状错误跳过并记录，不影响整页；
- `status` ∈ ok | warn | error | idle | off（缺失降级 idle）；
- `updatedAt` 超过 10 分钟：卡片置灰显示「数据已过期」；
- 所有文本字段以 React 文本节点渲染（textContent 级），**无 innerHTML**，模型输出无法注入脚本；
- 数据不含文件完整路径；沿用 loopback / 同源围栏，面板只读。
- 注意：Windows 记事本保存的 UTF-8 文件带 BOM，插件已兼容（读取时剥离）。

## 数据流

- Client（`client.js`）：侧栏图标 + keyed `main` 主面板，同源 fetch 取数；
- Host（`index.js`）：
  - `/qq-monitor/sessions` — 会话清单（qqbot prefs + `sessionQuery.listSessions` 标题增强）；
  - `/qq-monitor/transcript?id=<sessionId>` — 转写气泡；
    首选宿主 `sessionQuery.readSession()` 快照（已验证），
    回退直接解压 `<DSH 数据目录>/sessions/<工作区>/<sessionId>/session.v4.jsonl.zstd`
    （多帧 zstd，流式解压）。
- 安全（对齐 dsh-prompt 的同源围栏）：请求 Host 必须是 loopback 字面量
  （127/8、::1、localhost，带端口剥离，不做 DNS 解析）；`sec-fetch-site: cross-site`
  拒绝；带 Origin 的请求必须与 Host 同源（Desktop IPC 桥删除 origin 头时以 loopback
  Host 为准放行）；未知 sessionId 一律 403。已实测四态：无 Origin 200、
  同源 Origin 200、跨站 Origin 403、非 loopback Host 403。

## 隐私边界

- 数据不离开本机：插件零外联（无遥测、无上传），只读本地文件；
- 不向 AI 暴露：未注册任何 Agent 工具，模型看不到面板内容与聊天记录；
- 本机暴露面：路由绑定 GUI 端口但要求 loopback Host——**远程访问场景下不可达**
  （非 loopback Host 直接 403）；同机的本用户进程与磁盘上的会话日志文件同等可见；
- 聊天记录本身已在 DSH 会话日志与模型服务商侧存在，本面板不产生新的副本。

## 状态条（健康看板）

会话头部与对话区之间的横排 4 卡片：最后心跳 / 会话文件 / Web 端口 / 视觉路由（窄屏 2×2）。

### /qq-monitor/health 路由

`GET /qq-monitor/health?id=<sessionId>` 返回：

```json
{
  "now": <服务端时间戳>,
  "session": { "size": <字节>, "mtime": <ms>, "lastRole": "user|assistant|tool", "lastEventAt": <ms> },
  "visionRouter": { "exists": true, "mtime": <ms> },
  "webPort": { "port": <端口>, "ok": true, "latencyMs": <ms> }
}
```

- 只做 `fs.stat` 与事件元数据读取，**不读日志内容、不返回完整路径**；
- 端口探测只连 127.0.0.1，超时 500ms，端口取请求自身 Host 头；
- 复用同源围栏，未知 id 一律 403；
- 前端用服务端 `now` 计算相对时间，不依赖本机时钟。

### 状态判定规则（不简化成"文件不涨就报警"）

| 最后一条事件 | 判定 |
|---|---|
| `assistant` 回复 | 待机（灰点），不计时 |
| `user` 消息或 `tool` 调用 | 开始计时：<30s 正常（绿）；30–90s 偏慢（黄+黄底）；>90s 且 session mtime 与 vision-router mtime **均**静止 >10s → 疑似卡住（红+红底） |

原因：会话文件只在消息完成时落盘，长回复生成期间文件不变是正常的；只有双文件都静止才判卡住。
"疑似卡住"时状态条自动展开并在顶部显示红色提示行。

### 其它

- 心跳"x 秒前"由前端每秒本地递增（服务端 now 为基准），不依赖轮询节奏；
- "会话文件"卡片带 80×24 SVG 迷你折线（最近 60 采样点，前端内存数组）与增量显示；
- 状态条右上角可收起为单行摘要；
- health 轮询沿用 3 秒、页面不可见暂停；转写解析带 mtime+size 版本缓存，
  health 轮询零重复解压开销；
- 无新增外联，不注册 Agent 工具，隐私边界不变。

## 已验证

- 路由数据：sessions / transcript / health / **modules** 四条路由 200 正确（2026-11-25）；
- modules：sanitize 三例（非字符串滤除、坏 status 降级 idle、spark 过滤非数字）、
  stale 标记（15 分钟前 → true）、UTF-8 BOM 兼容、超限/坏文件跳过不崩溃；
- 判定逻辑五态冒烟：assistant→idle、user 10s→ok、tool 50s→warn、tool 120s 双静止→stuck、tool 120s 但 mtime 新→warn（不误报）；
- 列表解析六场景冒烟：普通/转义号(1\.)/全角号(1。)/顿号/跨空行续排/起始序号；
- 注入过滤冒烟：15 种前缀识别 + toUnits 分组（sysline/msg 交错正确）；
- deriveNow 三态 + computeStats 聚合冒烟；
- 同源围栏四态 + unknown id 403（四条路由一致）；
- 转写缓存回归：mtime+size 未变时同引用命中；
- 插件条目 `include:qq-monitor` active。

## 未验证

- 标签页切换、总览页时间线、统计页图表的实际渲染效果（本会话无浏览器控制）；
- 模块卡片的浏览器端 stale 置灰呈现。

## 气泡类型映射

| 会话事件 | 面板表现 |
|---|---|
| `user/message` | 右侧蓝色气泡（QQ 用户） |
| `assistant/message` | 左侧灰色气泡（机器人，reasoning 块已过滤） |
| `tool/call` | 细节行（🛠 工具名） |
| `session/title` | 会话标题（清单与头部） |
