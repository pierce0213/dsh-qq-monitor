# QQ 监控（qq-monitor）

DeepSeek Harness 侧栏插件：在 Web 界面左侧栏新增一个「QQ 监控」入口，点进去就是一个
AstrBot 风格的对话镜像窗口，实时显示 `@tencent-connect/dsh-qqbot` 驱动的 QQ 聊天记录。

## 使用

1. 重启 Harness（或等待插件热加载）后打开 Web 界面；
2. 左侧栏图标列里点「QQ 监控」（机器人小图标，order 12）；
3. 左列是 QQ 会话清单（来自 `~/.dsh-qqbot/model-prefs.json` 的映射），
   点一个会话，右列显示对话气泡，每 3 秒自动刷新（页面不可见时暂停）。

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

- 路由数据：sessions（清单+预览）、transcript（400 气泡+标题）、health（size/mtime/lastRole/webPort ok+latency）全部 200 正确（2026-11-24）；
- 同源围栏：无 Origin 200 / 同源 200 / 跨站 403 / 非 loopback 403 / unknown id 403（三条路由一致）；
- 判定逻辑五态冒烟：assistant→idle、user 10s→ok、tool 50s→warn、tool 120s 双静止→stuck、tool 120s 但 mtime 新→warn（不误报）；
- 转写缓存回归：mtime+size 未变时同引用命中；
- 插件条目 `include:qq-monitor` active。

## 未验证

- 状态条与折线图的实际渲染效果（本会话无浏览器控制）；前端判定已冒烟，视觉呈现（配色/折线形状/收起动画）需要页面上确认；
- 看板娘挪位与状态表情（规划中，尚未实现）。

## 气泡类型映射

| 会话事件 | 面板表现 |
|---|---|
| `user/message` | 右侧蓝色气泡（QQ 用户） |
| `assistant/message` | 左侧灰色气泡（机器人，reasoning 块已过滤） |
| `tool/call` | 细节行（🛠 工具名） |
| `session/title` | 会话标题（清单与头部） |
