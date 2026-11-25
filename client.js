/**
 * Browser half of the QQ monitor bundle.
 *
 * 注册模式照抄 @tencent-connect/dsh-qqbot 的已验证写法：
 *   - `window.__ModuleLoader__.load({ id: <包名>, factory })` 自注册；
 *   - `ctx.inject(['layout'], ...)` 嵌套作用域里注册 keyed `main` 主面板
 *     与 `sidebar.panellist` 侧栏入口（图标组件接收宿主传入的 size）。
 *
 * 数据经同源 fetch 调 Host 半区的 /qq-monitor/* 路由；轮询仅在页面可见时进行。
 *
 * 样式主题（设计稿 1-3，已实现）：
 *   - CSS 变量定义主题，值优先引用宿主 token（--dsw-alias-*，随宿主深浅色切换），
 *     token 缺失时落到字面色；字面色另按 prefers-color-scheme 提供深色回退；
 *   - 所有类名 qm- 前缀；
 *   - markdown 渲染不用 innerHTML：先结构化解析再产出 React 元素，
 *     全部文本走 React 转义，链接只放行 http/https（等效 DOMPurify 白名单）。
 *
 * 交互与呈现（设计稿 4-8，本版新增）：
 *   4. 工具调用一行折叠条（<details>，展开显示完整参数），连续工具调用合并为组；
 *   5. 左列表标题 + 最后消息预览 + 相对时间，选中 #EEF2FF + 左 3px 蓝条；
 *   6. 吸顶半透明头部 + blur(12px)，会话名 + 绿点「实时」，去掉 tick 调试文字；
 *   7. 轮询 diff 增量追加（120ms 淡入），上翻不自动滚动 + 「回到底部」按钮，日期分隔胶囊；
 *   8. prefers-reduced-motion 降级 + 全部可交互元素键盘焦点可见。
 */
;(function registerBundle() {
  const loader = typeof window !== 'undefined' ? window.__ModuleLoader__ : undefined;
  if (!loader || typeof loader.load !== 'function') {
    if (typeof console !== 'undefined') {
      console.warn('[qq-monitor] 没有 window.__ModuleLoader__，client bundle 跳过自注册');
    }
    return;
  }

  const PANEL_ID = 'qq-monitor';
  const ROUTE_SESSIONS = '/qq-monitor/sessions';
  const ROUTE_TRANSCRIPT = '/qq-monitor/transcript';
  const ROUTE_HEALTH = '/qq-monitor/health';
  const SESSIONS_POLL_MS = 10000;
  const TRANSCRIPT_POLL_MS = 3000;
  const NEW_FADE_MS = 120;

  loader.load({
    id: '@local/qq-monitor', // 必须等于 package.json 的 name
    factory(require) {
      const React = require('react');
      const h = React.createElement;
      const useState = React.useState;
      const useEffect = React.useEffect;
      const useRef = React.useRef;
      const useCallback = React.useCallback;
      const Fragment = React.Fragment;

      /* ── 主题（设计稿 1）── */
      const CSS = `
.qm-root {
  --qm-bg: var(--dsw-alias-bg-base, #ffffff);
  --qm-bg-subtle: var(--dsw-alias-bg-layer-2, #f3f4f7);
  --qm-bot-bubble: var(--dsw-alias-bg-layer-2, #f3f4f7);
  --qm-user-bubble: var(--dsw-alias-brand-primary, #4d6bfe);
  --qm-user-text: #ffffff;
  --qm-text: var(--dsw-alias-label-primary, #1f2329);
  --qm-muted: var(--dsw-alias-label-secondary, #8a9099);
  --qm-line: var(--dsw-alias-border-l1, #e5e8ec);
  --qm-accent: var(--dsw-alias-brand-primary, #4d6bfe);
  --qm-select: #eef2ff;
  --qm-tool-bg: #f0f4ff;
  --qm-ok: var(--dsw-alias-state-success-primary, #22a06b);
  --qm-codeblock-bg: #1e2128;
  --qm-codeblock-text: #e6e8ee;
}
@media (prefers-color-scheme: dark) {
  .qm-root {
    --qm-bg: var(--dsw-alias-bg-base, #17181c);
    --qm-bg-subtle: var(--dsw-alias-bg-layer-2, #23262d);
    --qm-bot-bubble: var(--dsw-alias-bg-layer-2, #23262d);
    --qm-user-bubble: var(--dsw-alias-brand-primary, #4d6bfe);
    --qm-text: var(--dsw-alias-label-primary, #e8eaed);
    --qm-muted: var(--dsw-alias-label-secondary, #9aa0a8);
    --qm-line: var(--dsw-alias-border-l1, #2e3138);
    --qm-select: #24304a;
    --qm-tool-bg: #1d2438;
  }
}
.qm-page { height: 100%; min-height: 0; display: flex; flex-direction: column; box-sizing: border-box;
  background: var(--qm-bg); color: var(--qm-text); }
.qm-head { flex: none; }
/* 吸顶头部（设计稿 6）：半透明 + blur，压在滚动区上方 */
.qm-headbar { display: flex; align-items: center; gap: 12px; padding: 12px clamp(16px, 3vw, 40px);
  border-bottom: 1px solid var(--qm-line);
  background: color-mix(in srgb, var(--qm-bg) 72%, transparent);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  position: relative; z-index: 2; }
@supports not (backdrop-filter: blur(12px)) {
  .qm-headbar { background: var(--qm-bg); }
}
.qm-headbar h2 { margin: 0; font-size: 15px; font-weight: 600; }
.qm-live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--qm-muted); }
.qm-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--qm-ok); flex: none;
  animation: qm-pulse 2.4s ease-in-out infinite; }
@keyframes qm-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.qm-badge { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 11px;
  background: var(--qm-bg-subtle); color: var(--qm-muted); }
.qm-refresh { display: inline-flex; align-items: center; height: 30px; padding: 0 14px;
  border: 1px solid var(--qm-line); border-radius: 8px; margin-left: auto;
  background: transparent; color: var(--qm-text); font: inherit; font-size: 12px; cursor: pointer; }
.qm-refresh:hover { background: var(--qm-bg-subtle); }
.qm-refresh:focus-visible, .qm-item:focus-visible, .qm-codeblock-copy:focus-visible,
.qm-tool summary:focus-visible, .qm-jump:focus-visible {
  outline: 2px solid var(--qm-accent); outline-offset: 2px; }
.qm-body { flex: 1; min-height: 0; display: flex;
  border-bottom: 1px solid var(--qm-line); overflow: hidden; background: var(--qm-bg); }
/* 左侧会话列表（设计稿 5） */
.qm-list { width: 250px; flex: none; overflow-y: auto; border-right: 1px solid var(--qm-line);
  padding: 8px; box-sizing: border-box; display: flex; flex-direction: column; gap: 2px; }
.qm-item { display: flex; flex-direction: column; gap: 3px; padding: 9px 12px; border-radius: 8px; cursor: pointer;
  border: none; text-align: left; background: transparent; color: var(--qm-text); font: inherit;
  position: relative; }
.qm-item:hover { background: var(--qm-bg-subtle); }
.qm-item.active { background: var(--qm-select); }
.qm-item.active::before { content: ''; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px;
  border-radius: 2px; background: var(--qm-accent); }
.qm-item-top { display: flex; align-items: baseline; gap: 8px; }
.qm-item-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex: 1; min-width: 0; }
.qm-item-time { font-size: 11px; color: var(--qm-muted); flex: none; }
.qm-item-preview { font-size: 12px; color: var(--qm-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qm-chat { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
.qm-thread { flex: 1; min-height: 0; overflow-y: auto; }
.qm-thread-inner { max-width: 760px; margin: 0 auto; padding: 18px 20px 30px;
  display: flex; flex-direction: column; }
.qm-empty { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px;
  color: var(--qm-muted); font-size: 13px; padding: 24px; text-align: center; }
/* 消息（设计稿 2） */
.qm-row { display: flex; gap: 10px; margin: 0 0 6px; }
.qm-row.new-sender { margin-top: 20px; }
.qm-row.user { flex-direction: row-reverse; }
.qm-avatar { width: 32px; height: 32px; border-radius: 50%; flex: none; display: flex;
  align-items: center; justify-content: center; background: var(--qm-accent); color: #fff;
  margin-top: 18px; }
.qm-avatar.hidden { visibility: hidden; }
.qm-col { display: flex; flex-direction: column; max-width: 75%; min-width: 0; }
.qm-row.user .qm-col { align-items: flex-end; }
.qm-meta { font-size: 12px; color: var(--qm-muted); margin-bottom: 4px; padding: 0 4px; }
.qm-bubble { padding: 9px 14px; font-size: 15px; line-height: 1.7; box-sizing: border-box;
  overflow-wrap: break-word; white-space: normal; }
.qm-bubble.bot { align-self: flex-start; background: var(--qm-bot-bubble);
  border-radius: 4px 16px 16px 16px; color: var(--qm-text); width: fit-content; max-width: 100%; }
/* 设计稿 5：用户气泡固定 #4D6BFE 白字（不随主题 token 漂移）；机器人 #F3F4F7 浅灰 */
.qm-bubble.user { background: #4d6bfe; color: #ffffff;
  border-radius: 16px 4px 16px 16px; }
@media (prefers-color-scheme: dark) {
  .qm-bubble.bot { background: var(--dsw-alias-bg-layer-2, #23262d); }
}
/* 新消息淡入（设计稿 7）；prefers-reduced-motion 下关闭（设计稿 8） */
.qm-row.fresh, .qm-tool.fresh { animation: qm-fade ${NEW_FADE_MS}ms ease-out; }
@keyframes qm-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.qm-bubble p { margin: 0 0 8px; }
.qm-bubble p:last-child { margin-bottom: 0; }
.qm-bubble h1, .qm-bubble h2, .qm-bubble h3 { margin: 10px 0 6px; font-size: 15px; font-weight: 600; }
.qm-bubble ul, .qm-bubble ol { margin: 4px 0 8px; padding-left: 22px; }
.qm-bubble li { margin: 2px 0; }
.qm-code { font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: 13px;
  background: var(--qm-bg-subtle); border: 1px solid var(--qm-line); border-radius: 5px;
  padding: 1px 5px; }
.qm-bubble.user .qm-code { background: rgba(255,255,255,.18); border-color: rgba(255,255,255,.3); }
.qm-codeblock { margin: 8px 0; border-radius: 10px; overflow: hidden; background: var(--qm-codeblock-bg); }
.qm-codeblock-head { display: flex; align-items: center; justify-content: space-between;
  padding: 6px 12px; background: rgba(255,255,255,.06); }
.qm-codeblock-lang { font-size: 11px; color: #9aa3b2; font-family: ui-monospace, Consolas, monospace; }
.qm-codeblock-copy { border: none; background: transparent; color: #9aa3b2;
  cursor: pointer; padding: 2px 6px; border-radius: 5px; font: inherit; font-size: 11px; }
.qm-codeblock-copy:hover { background: rgba(255,255,255,.12); color: #e6e8ee; }
.qm-codeblock-pre { margin: 0; padding: 10px 14px; overflow-x: auto; }
.qm-codeblock code { font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: 13px;
  line-height: 1.6; color: var(--qm-codeblock-text); white-space: pre; }
.qm-bubble a { color: var(--qm-accent); text-decoration: underline; text-underline-offset: 2px; }
.qm-bubble.user a { color: #fff; }
/* 日期分隔胶囊（设计稿 7） */
.qm-day { display: flex; justify-content: center; margin: 14px 0 10px; }
.qm-day span { font-size: 11px; color: var(--qm-muted); background: var(--qm-bg-subtle);
  border-radius: 999px; padding: 3px 12px; }
/* 状态条（健康看板）：4 卡片，窄屏 2×2；只用底色无描边阴影 */
.qm-health { flex: none; padding: 10px clamp(16px, 3vw, 40px) 0; }
.qm-health-top { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.qm-hchip { font-size: 12px; font-weight: 600; }
.qm-hspacer { flex: 1; }
.qm-health-fold { border: none; background: transparent; color: var(--qm-muted); cursor: pointer;
  padding: 2px 8px; border-radius: 6px; font: inherit; font-size: 12px; }
.qm-health-fold:hover { background: var(--qm-bg-subtle); }
.qm-health-fold:focus-visible { outline: 2px solid var(--qm-accent); outline-offset: 2px; }
.qm-health-alert { font-size: 12px; color: #e5484d; background: #fff0f0;
  border-radius: 8px; padding: 6px 10px; margin-bottom: 8px; line-height: 1.5; }
.qm-health-summary { font-size: 12px; color: var(--qm-muted); background: var(--qm-bg-subtle);
  border-radius: 8px; padding: 6px 10px; }
.qm-health-cardbox { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
@media (max-width: 900px) { .qm-health-cardbox { grid-template-columns: repeat(2, 1fr); } }
.qm-hcard { position: relative; background: var(--qm-bg-subtle); border-radius: 10px;
  padding: 10px 14px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
/* 设计稿 2：状态圆点在标题左侧（不再放右上角）；标题行 flex 对齐 */
.qm-hdot { width: 8px; height: 8px; border-radius: 50%;
  background: #9aa0a8; flex: none; }
.qm-hdot.ok { background: #22a06b; }
.qm-hdot.warn { background: #e8a317; }
.qm-hdot.stuck { background: #e5484d; }
.qm-hcard-title { font-size: 12px; color: var(--qm-muted); display: flex; align-items: center; gap: 6px; }
.qm-hcard-value { font-size: 18px; font-weight: 700; line-height: 1.3; color: var(--qm-text);
  display: flex; align-items: center; gap: 8px; min-width: 0; }
.qm-hcard-sub { font-size: 12px; color: var(--qm-muted); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.qm-spark { display: block; flex: none; }
.qm-face { flex: none; }
/* 注入元数据灰字行（第1轮-1）与开关行 */
.qm-sysline { font-size: 11px; color: var(--qm-muted); opacity: .75; padding: 2px 46px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; box-sizing: border-box; }
.qm-sysline-toggle { display: flex; justify-content: center; margin: 0 0 8px; }
.qm-sysline-toggle button { border: none; background: transparent; color: var(--qm-muted);
  font: inherit; font-size: 11px; cursor: pointer; padding: 2px 10px; border-radius: 999px; }
.qm-sysline-toggle button:hover { background: var(--qm-bg-subtle); }
.qm-sysline-toggle button:focus-visible { outline: 2px solid var(--qm-accent); outline-offset: 1px; }
/* 工具调用折叠条（设计稿 4） */
.qm-tool { align-self: flex-start; margin: 0 0 4px 42px; font-size: 13px; box-sizing: border-box;
  max-width: 75%; background: var(--qm-tool-bg); border-left: 2px solid var(--qm-accent);
  border-radius: 4px; overflow: hidden; }
.qm-tool-group { margin: 0 0 4px 42px; max-width: 75%; }
.qm-tool summary { list-style: none; cursor: pointer; padding: 4px 10px;
  font-size: 13px; color: var(--qm-muted); user-select: none;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qm-tool summary::-webkit-details-marker { display: none; }
.qm-tool summary::before { content: '▸'; display: inline-block; margin-right: 6px;
  transition: transform 120ms ease; font-size: 11px; }
.qm-tool[open] summary::before { transform: rotate(90deg); }
.qm-tool-body { padding: 0 10px 8px 22px; }
.qm-tool-args { font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.6;
  color: var(--qm-text); white-space: pre-wrap; word-break: break-word;
  background: var(--qm-bg); border: 1px solid var(--qm-line); border-radius: 6px;
  padding: 8px 10px; margin: 4px 0 0; max-height: 240px; overflow: auto; }
/* 回到底部按钮（设计稿 7） */
.qm-jump { position: absolute; right: 18px; bottom: 18px; width: 36px; height: 36px;
  border-radius: 50%; border: 1px solid var(--qm-line); cursor: pointer;
  background: var(--qm-bg); color: var(--qm-text); font-size: 16px; line-height: 1;
  box-shadow: 0 2px 10px rgba(0,0,0,.14); display: flex; align-items: center; justify-content: center; }
.qm-jump:hover { background: var(--qm-bg-subtle); }
.qm-error { color: var(--dsw-alias-state-error-primary, #d64545); font-size: 12px;
  padding: 8px clamp(16px, 3vw, 40px); flex: none; }
.qm-rail-icon { display: block; color: currentColor; }
/* 标签页（第2轮） */
.qm-tabs { display: flex; gap: 4px; padding: 8px clamp(16px, 3vw, 40px) 0; border-bottom: 1px solid var(--qm-line); flex: none; }
.qm-tab { border: none; background: transparent; color: var(--qm-muted); font: inherit; font-size: 13px;
  cursor: pointer; padding: 6px 16px; border-radius: 8px 8px 0 0; position: relative; }
.qm-tab:hover { background: var(--qm-bg-subtle); color: var(--qm-text); }
.qm-tab.active { color: var(--qm-accent); font-weight: 600; }
.qm-tab.active::after { content: ''; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px;
  background: var(--qm-accent); border-radius: 1px; }
.qm-tab:focus-visible { outline: 2px solid var(--qm-accent); outline-offset: -2px; }
/* 总览页：此刻卡片 + 时间线 */
.qm-now { display: flex; align-items: center; gap: 14px; margin: 14px clamp(16px, 3vw, 40px) 0;
  padding: 14px 18px; background: var(--qm-bg-subtle); border-radius: 12px; }
.qm-now-doing { font-size: 17px; font-weight: 600; }
.qm-now-sub { font-size: 12px; color: var(--qm-muted); }
.qm-timeline-wrap { margin: 14px clamp(16px, 3vw, 40px); }
.qm-timeline-title { font-size: 12px; color: var(--qm-muted); margin-bottom: 8px; }
.qm-timeline { display: block; width: 100%; }
/* 模块卡片网格 */
.qm-modgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px;
  margin: 14px clamp(16px, 3vw, 40px) 20px; }
.qm-mod { background: var(--qm-bg-subtle); border-radius: 10px; padding: 12px 14px; min-width: 0;
  display: flex; flex-direction: column; gap: 6px; }
.qm-mod.off, .qm-mod.stale { opacity: .55; }
.qm-mod-top { display: flex; align-items: center; gap: 8px; }
.qm-mod-title { font-size: 13px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.qm-mod-headline { font-size: 12px; color: var(--qm-text); }
.qm-mod-row { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
.qm-mod-label { color: var(--qm-muted); flex: none; }
.qm-mod-value { color: var(--qm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qm-mod-empty { grid-column: 1 / -1; }
/* 统计页 */
.qm-stats { margin: 14px clamp(16px, 3vw, 40px); display: flex; flex-direction: column; gap: 18px; }
.qm-stat-card { background: var(--qm-bg-subtle); border-radius: 10px; padding: 12px 16px; }
.qm-stat-title { font-size: 12px; color: var(--qm-muted); margin-bottom: 8px; }
.qm-stat-chart { display: block; width: 100%; }
.qm-stat-num { font-size: 18px; font-weight: 700; color: var(--qm-text); }
.qm-stat-sub { font-size: 12px; color: var(--qm-muted); margin-top: 2px; }
.qm-rank-row { display: flex; align-items: center; gap: 10px; font-size: 13px; padding: 4px 0; }
.qm-rank-name { width: 130px; color: var(--qm-text); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; flex: none; }
.qm-rank-bar-track { flex: 1; height: 8px; background: var(--qm-bg); border-radius: 4px; overflow: hidden; }
.qm-rank-bar { height: 100%; background: var(--qm-accent); border-radius: 4px; }
.qm-rank-count { width: 44px; text-align: right; color: var(--qm-muted); flex: none; }
/* 设计稿 8：减少动态 */
@media (prefers-reduced-motion: reduce) {
  .qm-row.fresh, .qm-tool.fresh { animation: none; }
  .qm-live-dot { animation: none; }
  .qm-tool summary::before { transition: none; }
}
`;

      /* ── 安全 markdown 渲染（设计稿 3，沿用已实现版）── */
      const INLINE_RE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

      function parseInline(text, keyBase) {
        const nodes = [];
        let last = 0;
        let m;
        let i = 0;
        INLINE_RE.lastIndex = 0;
        while ((m = INLINE_RE.exec(text))) {
          if (m.index > last) nodes.push(text.slice(last, m.index));
          const k = `${keyBase}-${i++}`;
          if (m[1] !== undefined) nodes.push(h('code', { key: k, className: 'qm-code' }, m[1]));
          else if (m[2] !== undefined) nodes.push(h('strong', { key: k }, m[2]));
          else if (m[3] !== undefined) {
            nodes.push(h('a', { key: k, href: m[4], target: '_blank', rel: 'noreferrer noopener' }, m[3]));
          }
          last = m.index + m[0].length;
        }
        if (last < text.length) nodes.push(text.slice(last));
        return nodes;
      }

      function CodeBlock({ lang, text, keyBase }) {
        const [copied, setCopied] = useState(false);
        const copy = useCallback(() => {
          const clip = typeof navigator !== 'undefined' && navigator.clipboard;
          if (!clip) return;
          clip.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }).catch(() => {});
        }, [text]);
        return h('div', { key: keyBase, className: 'qm-codeblock' },
          h('div', { className: 'qm-codeblock-head' },
            h('span', { className: 'qm-codeblock-lang' }, lang || 'text'),
            h('button', { type: 'button', className: 'qm-codeblock-copy', onClick: copy }, copied ? '已复制' : '复制')),
          h('pre', { className: 'qm-codeblock-pre' }, h('code', null, text)));
      }

      function parseBlocks(text) {
        const lines = String(text ?? '').split('\n');
        const out = [];
        let para = [];
        let list = null;
        let code = null;
        const flushPara = () => { if (para.length) { out.push({ kind: 'p', text: para.join('\n') }); para = []; } };
        const flushList = () => { if (list) { out.push(list); list = null; } };
        for (const line of lines) {
          const fence = /^```(\w*)\s*$/.exec(line.trim());
          if (code) {
            if (fence) { out.push({ kind: 'code', lang: code.lang, text: code.lines.join('\n') }); code = null; }
            else code.lines.push(line);
            continue;
          }
          if (fence) { flushPara(); flushList(); code = { lang: fence[1] || '', lines: [] }; continue; }
          const t = line.trim();
          // 空行不打断列表：列表项之间允许空行（序号延续），仅段落结束
          if (!t) { flushPara(); continue; }
          const hm = /^(#{1,3})\s+(.*)$/.exec(t);
          if (hm) { flushPara(); flushList(); out.push({ kind: 'h', level: hm[1].length, text: hm[2] }); continue; }
          const ul = /^[-*•]\s+(.*)$/.exec(t);
          // 序号变体：1. / 1、 / 1) / 1。以及 markdown 转义号 1\.（bot 常输出）；
          // start 记录首个序号值，跨空行合并同一列表避免序号重排
          const ol = /^(?:(\d+)[\\]?[.、。)]|(\d+)。)\s*(.*)$/.exec(t);
          if (ul) {
            flushPara();
            if (!list || list.ordered) { flushList(); list = { kind: 'list', ordered: false, start: 1, items: [] }; }
            list.items.push(ul[1]);
            continue;
          }
          if (ol) {
            flushPara();
            const value = Number(ol[1] ?? ol[2]);
            if (!list || !list.ordered) { flushList(); list = { kind: 'list', ordered: true, start: value || 1, items: [] }; }
            list.items.push(ol[3]);
            continue;
          }
          flushList();
          para.push(t);
        }
        if (code) out.push({ kind: 'code', lang: code.lang, text: code.lines.join('\n') });
        flushPara();
        flushList();
        return out;
      }

      function MarkdownBody({ text, keyBase }) {
        const blocks = parseBlocks(text);
        return blocks.map((b, i) => {
          const k = `${keyBase}-${i}`;
          if (b.kind === 'p') return h('p', { key: k }, parseInline(b.text, k));
          if (b.kind === 'h') {
            const Tag = b.level === 1 ? 'h1' : b.level === 2 ? 'h2' : 'h3';
            return h(Tag, { key: k }, parseInline(b.text, k));
          }
          if (b.kind === 'list') {
            const items = b.items.map((it, j) => h('li', { key: `${k}-${j}` }, parseInline(it, `${k}-${j}`)));
            return b.ordered
              ? h('ol', { key: k, start: b.start ?? 1 }, items)
              : h('ul', { key: k }, items);
          }
          if (b.kind === 'code') return h(CodeBlock, { key: k, lang: b.lang, text: b.text, keyBase: k });
          return null;
        });
      }

      /* ── 展示辅助 ── */
      /* ── 注入元数据过滤（第1轮-1）──
       * Harness 注入的系统消息（时间采样/时区/运行时上下文等）默认隐藏；
       * 开关打开后以灰色小字一行展示（不用气泡） */
      const INJECTED_PREFIXES = [
        'Time sampled while preparing',
        'Elapsed since the',
        'Browser time zone',
        'Current runtime context',
        'Current working directory',
        'Current DSH file policy',
        'Current DeepSeek Harness',
        'Approval prompts are',
        '<system-reminder>',
        '<available_skills>',
        '<skill_content>',
        '<system>',
        '[Request interrupted',
        '<environment_context>',
        '<runtime_context>',
      ];

      function isInjectedMeta(text) {
        const s = String(text ?? '').trimStart();
        if (!s) return false;
        return INJECTED_PREFIXES.some(p => s.startsWith(p));
      }

      function timeOf(at) {
        if (typeof at !== 'number' || !Number.isFinite(at)) return '';
        const d = new Date(at);
        const p = n => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      }

      function dayKeyOf(at) {
        if (typeof at !== 'number' || !Number.isFinite(at)) return null;
        const d = new Date(at);
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      }

      function dayLabelOf(key) {
        if (!key) return null;
        const [y, m, d] = key.split('-').map(Number);
        const that = new Date(y, m - 1, d);
        const today = new Date();
        const startOf = dt => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
        const diffDays = Math.round((startOf(today) - startOf(that)) / 86_400_000);
        if (diffDays === 0) return '今天';
        if (diffDays === 1) return '昨天';
        return `${m} 月 ${d} 日`;
      }

      function relTime(at) {
        if (typeof at !== 'number' || !Number.isFinite(at)) return '';
        const diff = Date.now() - at;
        if (diff < 60_000) return '刚刚';
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
        if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
        return `${Math.floor(diff / 86_400_000)} 天前`;
      }

      function scopeLabel(scope) {
        if (scope === 'group') return '群聊';
        if (scope === 'c2c') return '私聊';
        return scope || '会话';
      }

      function BotAvatar() {
        return h('div', { className: 'qm-avatar', 'aria-hidden': true },
          h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none' },
            h('rect', { x: 5, y: 8, width: 14, height: 11, rx: 3.5, fill: 'currentColor' }),
            h('circle', { cx: 9.5, cy: 13.5, r: 1.6, fill: 'var(--qm-accent)' }),
            h('circle', { cx: 14.5, cy: 13.5, r: 1.6, fill: 'var(--qm-accent)' }),
            h('rect', { x: 11, y: 4, width: 2, height: 3, rx: 1, fill: 'currentColor' }),
            h('circle', { cx: 12, cy: 3.5, r: 1.6, fill: 'currentColor' })));
      }

      /** 一条消息行（设计稿 2 布局 + 设计稿 7 淡入标记） */
      function MessageRow({ ev, prev, fresh, keyBase }) {
        const sender = ev.type === 'user' ? 'user' : 'bot';
        const prevSender = prev ? (prev.type === 'user' ? 'user' : prev.type === 'tool' ? 'tool' : 'bot') : null;
        const newSender = sender !== prevSender;
        const who = sender === 'user' ? 'QQ 用户' : '机器人';
        return h('div', { className: `qm-row ${sender}${newSender ? ' new-sender' : ''}${fresh ? ' fresh' : ''}` },
          sender === 'bot'
            ? h(BotAvatar, { key: `${keyBase}-av` })
            : h('div', { className: 'qm-avatar hidden', 'aria-hidden': true }),
          h('div', { className: 'qm-col' },
            newSender ? h('div', { className: 'qm-meta' }, `${who} · ${timeOf(ev.at)}`) : null,
            h('div', { className: `qm-bubble ${sender}` },
              h(MarkdownBody, { text: ev.text ?? '', keyBase })),
          ));
      }

      /**
       * 工具调用折叠条（设计稿 4）：<details> 一行折叠，展开显示完整参数；
       * group 内多条连续调用共享一个折叠条，收起时显示条数。
       */
      function ToolRow({ group, fresh, keyBase }) {
        const [open, setOpen] = useState(false);
        const first = group[0];
        const label = group.length === 1
          ? `🛠 ${first.name ?? '工具'} · ${timeOf(first.at)}`
          : `🛠 ${first.name ?? '工具'} 等 ${group.length} 次调用 · ${timeOf(first.at)}`;
        return h('details', {
          key: keyBase,
          className: `qm-tool${fresh ? ' fresh' : ''}`,
          open,
          onToggle: (e) => setOpen(e.target.open),
        },
          h('summary', null, label),
          h('div', { className: 'qm-tool-body' },
            group.map((g, gi) => h('div', { key: `${keyBase}-${gi}` },
              group.length > 1
                ? h('div', { className: 'qm-meta' }, `${g.name ?? '工具'} · ${timeOf(g.at)}`)
                : null,
              h('pre', { className: 'qm-tool-args' }, g.args ?? g.text ?? ''),
            ))));
      }

      /** 把事件流折叠为渲染单元：注入元数据降级为 sysline（第1轮-1），连续工具调用合并为组（设计稿 4） */
      function toUnits(events) {
        const units = [];
        for (const ev of events) {
          if (ev.type === 'tool') {
            const last = units[units.length - 1];
            if (last && last.kind === 'tool') last.group.push(ev);
            else units.push({ kind: 'tool', group: [ev] });
            continue;
          }
          if (ev.type !== 'user' && ev.type !== 'assistant') continue;
          if (ev.type === 'user' && isInjectedMeta(ev.text)) {
            const last = units[units.length - 1];
            if (last && last.kind === 'sysline') last.group.push(ev);
            else units.push({ kind: 'sysline', group: [ev] });
            continue;
          }
          units.push({ kind: 'msg', ev });
        }
        return units;
      }

      /* ── 状态条（健康看板）──
       * 判定（设计稿【判定逻辑】，不简化成"文件不涨就报警"）：
       * - lastRole === 'assistant' → 待机（灰点，不计时）
       * - lastRole 是 user 或 tool → 计时开始：
       *     <30s 正常（绿点）；30–90s 偏慢（黄点+黄底）；
       *     >90s 且 session mtime 与 vision-router mtime 均无变化 → 疑似卡住（红点+红底）
       * - 相对时间全部用服务端 now 基准 + 前端每秒本地递增，不依赖本机时钟 */
      const STUCK_MS = 90_000;
      const WARN_MS = 30_000;
      const VISION_STALE_MS = 10_000;
      const SESSION_STALE_MS = 10_000;

      function judgeHealth(h, nowLocal) {
        const baseNow = typeof h?.now === 'number' ? h.now : nowLocal;
        const elapsed = Math.max(0, nowLocal - baseNow);
        const lastRole = h?.session?.lastRole;
        const lastEventAt = h?.session?.lastEventAt;
        if (!lastRole || lastRole === 'assistant') {
          return { level: 'idle', label: '待机', ageMs: 0, waiting: false };
        }
        const ageMs = typeof lastEventAt === 'number' ? Math.max(0, baseNow + elapsed - lastEventAt) : elapsed;
        const waiting = true;
        if (ageMs < WARN_MS) return { level: 'ok', label: '生成中', ageMs, waiting };
        if (ageMs < STUCK_MS) return { level: 'warn', label: '偏慢', ageMs, waiting };
        // >90s：文件都静止才算疑似卡住
        const sessionStale = typeof h?.session?.mtime === 'number' && (baseNow + elapsed - h.session.mtime) > SESSION_STALE_MS;
        const visionStale = !h?.visionRouter?.exists
          || (typeof h?.visionRouter?.mtime === 'number' && (baseNow + elapsed - h.visionRouter.mtime) > VISION_STALE_MS);
        if (sessionStale && visionStale) return { level: 'stuck', label: '疑似卡住', ageMs, waiting };
        return { level: 'warn', label: '偏慢', ageMs, waiting };
      }

      function fmtDuration(ms) {
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s} 秒`;
        const m = Math.floor(s / 60);
        return `${m} 分 ${s % 60} 秒`;
      }

      function fmtBytes(n) {
        if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(2)} MB`;
      }

      /** 状态表情：32px 圆脸（正常微笑 / 偏慢平静 / 疑似卡住着急 / 待机闭眼） */
      function StatusFace({ level }) {
        const c = level === 'stuck' ? '#e5484d' : level === 'warn' ? '#e8a317' : 'var(--qm-accent)';
        const eyes = level === 'idle'
          ? [h('path', { key: 'e', d: 'M8.2 11.5h2.6M13.2 11.5h2.6', stroke: '#fff', 'stroke-width': 1.6, 'stroke-linecap': 'round' })]
          : level === 'stuck'
            ? [h('circle', { key: 'l', cx: 9.5, cy: 11.5, r: 1.5, fill: '#fff' }), h('circle', { key: 'r', cx: 14.5, cy: 11.5, r: 1.5, fill: '#fff' })]
            : [h('circle', { key: 'l', cx: 9.5, cy: 11.5, r: 1.4, fill: '#fff' }), h('circle', { key: 'r', cx: 14.5, cy: 11.5, r: 1.4, fill: '#fff' })];
        const mouth = level === 'stuck'
          ? h('circle', { cx: 12, cy: 16.2, r: 2, fill: '#fff' })
          : h('path', { d: level === 'idle' ? 'M9.5 15.5h5' : 'M9.5 15.2q2.5 2.2 5 0', stroke: '#fff', 'stroke-width': 1.6, 'stroke-linecap': 'round', fill: 'none' });
        return h('span', { className: 'qm-face', 'aria-hidden': true },
          h('svg', { width: 24, height: 24, viewBox: '0 0 24 24' },
            h('circle', { cx: 12, cy: 12, r: 10, fill: c }),
            ...eyes, mouth));
      }

      /** 80×24 迷你折线：polyline + 最新点圆点；采样 <5 点时显示灰色"收集中…"（设计稿 3） */
      function Sparkline({ points }) {
        const W = 80;
        const H = 24;
        if (!points || points.length < 5) {
          return h('span', { style: { fontSize: 11, color: 'var(--qm-muted)', lineHeight: `${H}px` } }, '收集中…');
        }
        const max = Math.max(...points);
        const min = Math.min(...points);
        const span = Math.max(max - min, 1);
        const step = W / (points.length - 1);
        const pts = points.map((v, i) => `${(i * step).toFixed(1)},${(H - 3 - ((v - min) / span) * (H - 6)).toFixed(1)}`).join(' ');
        const lastY = H - 3 - ((points[points.length - 1] - min) / span) * (H - 6);
        return h('svg', { className: 'qm-spark', width: W, height: H, 'aria-hidden': true },
          h('polyline', { points: pts, fill: 'none', stroke: 'var(--qm-accent)', 'stroke-width': 2, 'stroke-linejoin': 'round' }),
          h('circle', { cx: W - 0.5, cy: lastY.toFixed(1), r: 2.5, fill: 'var(--qm-accent)' }));
      }

      /** 状态条整体：折叠态单行摘要 / 展开态 4 卡片；疑似卡住自动展开 + 顶部红条 */
      function HealthBar({ health, nowTick, selectedTitle }) {
        const [folded, setFolded] = useState(false);
        const verdict = judgeHealth(health, nowTick);
        // 疑似卡住时强制展开（用户手动收起后下一轮仍会展开——红字优先于折叠偏好）
        useEffect(() => {
          if (verdict.level === 'stuck') setFolded(false);
        }, [verdict.level]);
        const ageText = verdict.waiting ? fmtDuration(verdict.ageMs) : null;
        const size = health?.session?.size;
        const mtime = health?.session?.mtime;
        const port = health?.webPort;
        // 会话文件大小环形数组（前端内存，最近 60 点）+ 最近 5 分钟增量
        const sizesRef = useRef([]);
        const mtimeRef = useRef(undefined);
        useEffect(() => {
          if (typeof size !== 'number') return;
          const arr = sizesRef.current;
          const last = arr[arr.length - 1];
          if (last === undefined || last !== size) arr.push(size);
          if (arr.length > 60) arr.shift();
          if (typeof mtime === 'number') mtimeRef.current = mtime;
        }, [size, mtime]);
        const points = sizesRef.current.slice(-60);
        const windowStart = Date.now() - 5 * 60_000;
        // 增量基线：5 分钟窗口内最早的采样（不足 5 分钟用最旧的）
        let deltaText = '—';
        {
          const arr = sizesRef.current;
          if (arr.length >= 2 && typeof health?.now === 'number') {
            deltaText = `+${fmtBytes(Math.max(0, arr[arr.length - 1] - arr[0]))} / 采样 ${arr.length}`;
          } else if (arr.length === 1) {
            deltaText = `+0 KB / 采样 1`;
          }
        }
        void windowStart;
        const webOk = port?.ok === true;
        const webSub = webOk ? `127.0.0.1:${port.port} · ${port.latencyMs ?? '?'}ms` : '不可达';
        const stuck = verdict.level === 'stuck';
        const summaryBits = [
          verdict.label,
          ageText ? `已等 ${ageText}` : null,
          typeof size === 'number' ? fmtBytes(size) : null,
          webOk ? `端口 ${port.port} 通` : '端口不可达',
        ].filter(Boolean);
        return h('div', { className: 'qm-health' },
          h('div', { className: 'qm-health-top' },
            h('span', { className: 'qm-hchip' }, '状态'),
            h('span', { className: 'qm-hspacer' }),
            h('button', {
              type: 'button', className: 'qm-health-fold',
              onClick: () => setFolded(f => !f),
              'aria-expanded': !folded,
            }, folded ? '展开 ▾' : '收起 ▴'),
          ),
          stuck && h('div', { className: 'qm-health-alert' },
            `疑似卡住：最后一条是 ${verdict.label === 'stuck' ? 'user/工具调用' : ''}，已 ${fmtDuration(verdict.ageMs)} 无任何落盘或视觉活动。长回复生成期间文件不变是正常的，但超过 90 秒且双文件静止就需要人工看一眼了。`),
          folded
            ? h('div', { className: 'qm-health-summary' }, summaryBits.join(' · '))
            : h('div', { className: 'qm-health-cardbox' },
                // 卡片一：最后心跳（圆点在标题左侧）
                h('div', { className: `qm-hcard${verdict.level === 'warn' ? ' warn' : ''}${stuck ? ' stuck' : ''}` },
                  h('span', { className: 'qm-hcard-title' },
                    h('span', { className: `qm-hdot ${verdict.level === 'idle' ? '' : verdict.level}` }),
                    '最后心跳'),
                  h('span', { className: 'qm-hcard-value' },
                    StatusFace({ level: verdict.level }),
                    ageText ?? (verdict.level === 'idle' ? '待机' : '—')),
                  h('span', { className: 'qm-hcard-sub' },
                    verdict.level === 'idle'
                      ? `最后一条是机器人回复${typeof lastTime(health) === 'number' ? ` · ${relTime(lastTime(health))}` : ''}`
                      : `${verdict.label} · 基准 ${timeOf(health?.session?.lastEventAt) || '—'}`)),
                // 卡片二：会话文件
                h('div', { className: 'qm-hcard' },
                  h('span', { className: 'qm-hcard-title' },
                    h('span', { className: `qm-hdot ${typeof size === 'number' ? 'ok' : ''}` }),
                    '会话文件'),
                  h('span', { className: 'qm-hcard-value' },
                    Sparkline({ points }),
                    typeof size === 'number' ? fmtBytes(size) : '—'),
                  h('span', { className: 'qm-hcard-sub' }, deltaText)),
                // 卡片三：Web 端口
                h('div', { className: `qm-hcard${webOk ? '' : ' stuck'}` },
                  h('span', { className: 'qm-hcard-title' },
                    h('span', { className: `qm-hdot ${webOk ? 'ok' : 'stuck'}` }),
                    'Web 端口'),
                  h('span', { className: 'qm-hcard-value' }, port?.port ?? '—'),
                  h('span', { className: 'qm-hcard-sub' }, webSub)),
                // 卡片四：视觉路由
                (() => {
                  const vr = health?.visionRouter;
                  const vrStale = vr?.exists && typeof vr.mtime === 'number' && (Date.now() - vr.mtime) > VISION_STALE_MS;
                  return h('div', { className: 'qm-hcard' },
                    h('span', { className: 'qm-hcard-title' },
                      h('span', { className: `qm-hdot ${vr?.exists ? (vrStale ? 'warn' : 'ok') : ''}` }),
                      '视觉路由'),
                    h('span', { className: 'qm-hcard-value' }, vr?.exists ? '运行中' : '未启用'),
                    h('span', { className: 'qm-hcard-sub' }, vr?.exists ? `日志 ${relTime(vr.mtime)}更新` : '无 vision-router 日志'));
                })(),
              ));
      }

      function lastTime(health) {
        return health?.session?.lastEventAt;
      }

      /* ── 总览页（第2轮）── */
      /** 工具名 → 中文映射（便于扩展的常量表） */
      const TOOL_CN = {
        pwsh: '执行命令',
        read: '读取文件',
        write: '写入文件',
        edit: '编辑文件',
        glob: '查找文件',
        grep: '搜索内容',
        web_search: '搜索网页',
        web_fetch: '抓取网页',
        read_image: '查看图片',
        send_meme: '挑表情包',
        comfyui_workflow: '生成图片',
        todo_write: '整理清单',
        send_message: '发消息',
        schedule_create: '建提醒',
      };
      const toolCn = name => TOOL_CN[name] ?? name ?? '工具';

      /**
       * 「此刻在做什么」：由最后事件推导，不依赖模型自述（第2轮总览 2）。
       * user/message → 思考中；tool/call → 正在使用 <工具>（持续秒数）；
       * assistant/message → 空闲（距今时间）。
       */
      function deriveNow(events, baseNow) {
        const arr = events ?? [];
        for (let i = arr.length - 1; i >= 0; i--) {
          const ev = arr[i];
          if (ev.type === 'user') {
            return { doing: '思考中', sub: `主人 ${relTime(ev.at)} 发来消息`, level: 'busy', at: ev.at };
          }
          if (ev.type === 'tool') {
            const since = typeof ev.at === 'number' ? Math.max(0, baseNow - ev.at) : 0;
            return { doing: `正在使用 ${toolCn(ev.name)}`, sub: `已持续 ${fmtDuration(since)}`, level: 'busy', at: ev.at };
          }
          if (ev.type === 'assistant') {
            return { doing: '空闲', sub: typeof ev.at === 'number' ? `上一条回复 ${relTime(ev.at)}` : '', level: 'idle', at: ev.at };
          }
        }
        return { doing: '暂无活动', sub: '', level: 'idle', at: null };
      }

      /** 今日时间线：0–24 点横轴 + 事件竖线（纯 SVG，第2轮总览 3） */
      const TL_COLORS = { user: '#4d6bfe', assistant: '#22a06b', tool: '#e8a317' };
      function TodayTimeline({ events }) {
        const W = 760;
        const H = 64;
        const pad = 8;
        const today = dayKeyOf(Date.now());
        const items = (events ?? []).filter(ev =>
          (ev.type === 'user' || ev.type === 'assistant' || ev.type === 'tool')
          && dayKeyOf(ev.at) === today && typeof ev.at === 'number');
        const axisY = H - 16;
        const xOf = at => {
          const d = new Date(at);
          const frac = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
          return pad + frac * (W - pad * 2);
        };
        const marks = items.map((ev, i) => {
          const x = xOf(ev.at).toFixed(1);
          const c = TL_COLORS[ev.type] ?? '#9aa0a8';
          const h = ev.type === 'user' ? 14 : ev.type === 'assistant' ? 11 : 7;
          return h('line', {
            key: `tl${i}`,
            x1: x, y1: axisY - h, x2: x, y2: axisY,
            stroke: c, 'stroke-width': 2, 'stroke-linecap': 'round',
          }, h('title', null, `${ev.type === 'tool' ? toolCn(ev.name) : ev.type === 'user' ? 'QQ 用户' : '机器人'} · ${timeOf(ev.at)}`));
        });
        const hourLabels = [0, 6, 12, 18, 24].map(hh => {
          const x = pad + (hh / 24) * (W - pad * 2);
          return h('text', { key: `h${hh}`, x, y: H - 2, 'text-anchor': hh === 0 ? 'start' : hh === 24 ? 'end' : 'middle', 'font-size': 9, fill: 'var(--qm-muted)' }, `${hh}:00`);
        });
        return h('svg', { className: 'qm-timeline', viewBox: `0 0 ${W} ${H}`, height: H, 'aria-label': '今日事件时间线' },
          h('line', { x1: pad, y1: axisY, x2: W - pad, y2: axisY, stroke: 'var(--qm-line)', 'stroke-width': 1 }),
          ...marks,
          ...hourLabels,
          items.length === 0 ? h('text', { x: W / 2, y: axisY - 18, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--qm-muted)' }, '今天还没有事件') : null,
        );
      }

      /* ── 统计页（第2轮）── */
      /** 14 天每日消息数 + 回复耗时 + 工具排行，全部由 transcript 前端聚合 */
      function computeStats(events) {
        const arr = (events ?? []).filter(ev => ev.type === 'user' || ev.type === 'assistant' || ev.type === 'tool');
        const days = [];
        const today = new Date();
        for (let i = 13; i >= 0; i--) {
          const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
          days.push({ key: dayKeyOf(d.getTime()), label: `${d.getMonth() + 1}/${d.getDate()}`, count: 0 });
        }
        const byDay = new Map(days.map(d => [d.key, d]));
        const latencies = [];
        let pendingUser = null;
        const toolCount = new Map();
        for (const ev of arr) {
          if (ev.type === 'user') {
            const day = byDay.get(dayKeyOf(ev.at));
            if (day) day.count++;
            pendingUser = ev;
          } else if (ev.type === 'assistant') {
            const day = byDay.get(dayKeyOf(ev.at));
            if (day) day.count++;
            if (pendingUser && typeof ev.at === 'number' && typeof pendingUser.at === 'number') {
              const dt = ev.at - pendingUser.at;
              if (dt >= 0 && dt < 10 * 60_000) latencies.push(dt);
            }
            pendingUser = null;
          } else if (ev.type === 'tool') {
            const name = ev.name ?? 'tool';
            toolCount.set(name, (toolCount.get(name) ?? 0) + 1);
          }
        }
        latencies.sort((a, b) => a - b);
        const pick = p => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] : null;
        const top = [...toolCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
        return { days, latencyMedian: pick(0.5), latencyP90: pick(0.9), latencyCount: latencies.length, top };
      }

      function fmtLatency(ms) {
        if (ms === null || ms === undefined) return '—';
        if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
        return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
      }

      /** 14 天折线（纯 SVG） */
      function DaysChart({ days }) {
        const W = 760;
        const H = 120;
        const padX = 24;
        const padY = 14;
        const max = Math.max(1, ...days.map(d => d.count));
        const step = days.length > 1 ? (W - padX * 2) / (days.length - 1) : 0;
        const yOf = v => H - padY - (v / max) * (H - padY * 2);
        const pts = days.map((d, i) => `${(padX + i * step).toFixed(1)},${yOf(d.count).toFixed(1)}`).join(' ');
        return h('svg', { className: 'qm-stat-chart', viewBox: `0 0 ${W} ${H}`, height: H },
          h('polyline', { points: pts, fill: 'none', stroke: 'var(--qm-accent)', 'stroke-width': 2, 'stroke-linejoin': 'round' }),
          ...days.map((d, i) => h('circle', { key: `p${i}`, cx: (padX + i * step).toFixed(1), cy: yOf(d.count).toFixed(1), r: 2.5, fill: 'var(--qm-accent)' },
            h('title', null, `${d.label} · ${d.count} 条`))),
          ...days.map((d, i) => (i % 2 === 0 || i === days.length - 1)
            ? h('text', { key: `x${i}`, x: padX + i * step, y: H - 2, 'text-anchor': 'middle', 'font-size': 9, fill: 'var(--qm-muted)' }, d.label)
            : null),
        );
      }

      /** 模块卡片（第2轮【卡片注册机制】渲染端）：全部 textContent 级渲染（React 文本节点） */
      function ModuleCard({ m }) {
        const staleCls = m.stale ? ' stale' : m.status === 'off' ? ' off' : '';
        return h('div', { className: `qm-mod${staleCls}` },
          h('div', { className: 'qm-mod-top' },
            m.icon ? h('span', { 'aria-hidden': true }, m.icon) : null,
            h('span', { className: 'qm-mod-title' }, m.title),
            h('span', { className: `qm-hdot ${m.status === 'ok' ? 'ok' : m.status === 'warn' ? 'warn' : m.status === 'error' ? 'stuck' : ''}` })),
          m.headline ? h('div', { className: 'qm-mod-headline' }, m.headline) : null,
          ...m.rows.map((r, i) => h('div', { key: `r${i}`, className: 'qm-mod-row' },
            h('span', { className: 'qm-mod-label' }, r.label),
            h('span', { className: 'qm-mod-value' }, r.value))),
          m.spark && m.spark.length >= 2 ? h(Sparkline, { points: m.spark }) : null,
          m.stale ? h('div', { className: 'qm-now-sub' }, '数据已过期') : null,
        );
      }

      /* ── 主面板 ── */
      function MonitorPage() {
        const [sessions, setSessions] = useState([]);
        const [selectedId, setSelectedId] = useState(null);
        const [events, setEvents] = useState(null);
        const [titles, setTitles] = useState({});
        const [error, setError] = useState(null);
        const [atBottom, setAtBottom] = useState(true);
        const [health, setHealth] = useState(null);
        // 本地 1 秒心跳：驱动「x 秒前」递增与倒计时判定，不依赖轮询节奏（设计稿 5）
        const [nowTick, setNowTick] = useState(() => Date.now());
        // 注入元数据显示开关（第1轮-1）：默认隐藏
        const [showSys, setShowSys] = useState(false);
        const scrollRef = useRef(null);
        const nearBottomRef = useRef(true);
        // 已渲染事件数：仅尾部新增的消息/工具组标记 fresh（设计稿 7 增量淡入）
        const renderedCountRef = useRef(0);

        const loadSessions = useCallback(async () => {
          try {
            const res = await fetch(ROUTE_SESSIONS, { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
            setSessions(data.sessions ?? []);
            setError(null);
          } catch (err) {
            setError(`会话清单加载失败：${err?.message ?? err}`);
          }
        }, []);

        const loadTranscript = useCallback(async (id) => {
          if (!id) return;
          try {
            const res = await fetch(`${ROUTE_TRANSCRIPT}?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
            setEvents(data.events ?? []);
            setError(null);
            if (typeof data.title === 'string' && data.title) setTitles(prev => ({ ...prev, [id]: data.title }));
          } catch (err) {
            setError(`转写加载失败：${err?.message ?? err}`);
          }
        }, []);

        // health 轮询：沿用 3 秒、页面可见才跑（设计稿【约束】）
        useEffect(() => {
          if (!selectedId) { setHealth(null); return undefined; }
          let stopped = false;
          const load = async () => {
            try {
              const res = await fetch(`${ROUTE_HEALTH}?id=${encodeURIComponent(selectedId)}`, { cache: 'no-store' });
              const data = await res.json();
              if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
              if (!stopped) setHealth(data);
            } catch { /* 单次失败保持旧值，状态条自身会显示端口不可达 */ }
          };
          load();
          const timer = setInterval(() => {
            if (!stopped && document.visibilityState === 'visible') load();
          }, TRANSCRIPT_POLL_MS);
          return () => {
            stopped = true;
            clearInterval(timer);
          };
        }, [selectedId]);

        // 本地 1 秒 tick（页面可见才递增）
        useEffect(() => {
          const timer = setInterval(() => {
            if (document.visibilityState === 'visible') setNowTick(Date.now());
          }, 1000);
          return () => clearInterval(timer);
        }, []);

        useEffect(() => {
          let stopped = false;
          const loop = () => {
            if (stopped || document.visibilityState !== 'visible') return;
            loadSessions();
          };
          loop();
          const timer = setInterval(loop, SESSIONS_POLL_MS);
          const onVis = () => { if (document.visibilityState === 'visible') loop(); };
          document.addEventListener('visibilitychange', onVis);
          return () => {
            stopped = true;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVis);
          };
        }, [loadSessions]);

        useEffect(() => {
          if (!selectedId) { setEvents(null); return undefined; }
          renderedCountRef.current = 0;
          nearBottomRef.current = true;
          let stopped = false;
          const loop = () => {
            if (!stopped && document.visibilityState === 'visible') loadTranscript(selectedId);
          };
          loop();
          const timer = setInterval(loop, TRANSCRIPT_POLL_MS);
          const onVis = () => { if (document.visibilityState === 'visible') loop(); };
          document.addEventListener('visibilitychange', onVis);
          return () => {
            stopped = true;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVis);
          };
        }, [selectedId, loadTranscript]);

        // 底部跟随 + atBottom 状态（设计稿 7：上翻不自动滚动）
        useEffect(() => {
          const el = scrollRef.current;
          if (!el) return;
          el.scrollTop = el.scrollHeight;
        }, [selectedId]);
        useEffect(() => {
          const el = scrollRef.current;
          if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
          if (events?.length) renderedCountRef.current = events.length;
        }, [events]);

        const onScroll = () => {
          const el = scrollRef.current;
          if (!el) return;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          nearBottomRef.current = near;
          setAtBottom(near);
        };

        const jumpToBottom = () => {
          const el = scrollRef.current;
          if (!el) return;
          nearBottomRef.current = true;
          setAtBottom(true);
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        };

        const selected = sessions.find(s => s.sessionId === selectedId) ?? null;
        const units = toUnits(events ?? []);
        const unitCount = events?.length ?? 0;
        const sysCount = (events ?? []).filter(ev => ev.type === 'user' && isInjectedMeta(ev.text)).length;
        const hasSys = sysCount > 0;
        const selectedTitle = titles[selectedId] ?? selected?.title ?? (selected ? `${scopeLabel(selected.scope)} ${selected.peerLabel}` : '');

        /* ── 标签页（第2轮）：可注册数组 + URL hash 记忆 ── */
        // 后续新标签往这个数组加 { id, label, render: () => 节点 } 即可，不写死
        const TABS = [
          { id: 'overview', label: '总览', render: () => h(OverviewPage, { events, health, nowTick }) },
          { id: 'chat', label: '对话', render: renderChatTab },
          { id: 'stats', label: '统计', render: () => h(StatsPage, { events }) },
        ];
        const [tab, setTab] = useState(() => {
          const h0 = typeof window !== 'undefined' && window.location?.hash?.replace(/^#/, '');
          return TABS.some(t => t.id === h0) ? h0 : 'overview';
        });
        useEffect(() => {
          try { window.history.replaceState(null, '', `#${tab}`); } catch { /* hash 只作记忆 */ }
        }, [tab]);
        const onHashChange = () => {
          const h0 = window.location?.hash?.replace(/^#/, '');
          if (TABS.some(t => t.id === h0)) setTab(h0);
        };
        useEffect(() => {
          window.addEventListener('hashchange', onHashChange);
          return () => window.removeEventListener('hashchange', onHashChange);
        });

        function renderChatTab() {
          return h('div', { className: 'qm-body' },
            h('div', { className: 'qm-list' },
              sessions.length === 0
                ? h('div', { className: 'qm-empty' }, '还没有 QQ 会话。', h('br'), '在 QQ 里给机器人发一条消息后，这里就会出现会话。')
                : sessions.map(s => h('button', {
                    key: s.sessionId,
                    type: 'button',
                    className: `qm-item${s.sessionId === selectedId ? ' active' : ''}`,
                    onClick: () => setSelectedId(s.sessionId),
                  },
                    h('span', { className: 'qm-item-top' },
                      h('span', { className: 'qm-item-title' }, titles[s.sessionId] ?? s.title ?? `${scopeLabel(s.scope)} ${s.peerLabel}`),
                      s.updatedAt ? h('span', { className: 'qm-item-time' }, relTime(s.updatedAt)) : null),
                    h('span', { className: 'qm-item-preview' },
                      s.lastText ? s.lastText.replace(/\s+/g, ' ').slice(0, 60) : `${scopeLabel(s.scope)} · ${s.peerLabel}`),
                  )),
            ),            h('div', { className: 'qm-chat' },
              selectedId === null
                ? h('div', { className: 'qm-empty' }, '← 从左侧选择一个会话查看实时对话')
                : h(Fragment, null,
                    h('div', { className: 'qm-thread', ref: scrollRef, onScroll },
                      h('div', { className: 'qm-thread-inner' },
                        units.length === 0
                          ? h('div', { className: 'qm-empty' }, events === null ? '加载中…' : '这个会话还没有可显示的记录')
                          : units.map((u, i) => {
                              // 该渲染单元的最后一个事件在「上次渲染」之后 → fresh（设计稿 7）
                              const evEnd = u.kind === 'tool' ? u.group[u.group.length - 1] : u.ev;
                              const idxInEvents = events.indexOf(evEnd);
                              const fresh = idxInEvents >= 0 && idxInEvents >= renderedCountRef.current && renderedCountRef.current > 0;
                              const dayKey = u.kind === 'msg' ? dayKeyOf(u.ev.at) : dayKeyOf(u.group[0].at);
                              const prevUnit = i > 0 ? units[i - 1] : null;
                              const prevDay = prevUnit
                                ? (prevUnit.kind === 'msg' ? dayKeyOf(prevUnit.ev.at) : prevUnit.kind === 'tool' ? dayKeyOf(prevUnit.group[0].at) : dayKeyOf(prevUnit.group[0].at))
                                : null;
                              return h(Fragment, { key: u.kind === 'tool' ? `g${i}` : u.kind === 'sysline' ? `s${i}` : (u.ev.seq ?? `m${i}`) },
                                dayKey && dayKey !== prevDay ? h('div', { className: 'qm-day' }, h('span', null, dayLabelOf(dayKey))) : null,
                                u.kind === 'tool'
                                  ? h(ToolRow, { group: u.group, fresh, keyBase: `g${i}` })
                                  : u.kind === 'sysline'
                                    ? (showSys
                                        ? h('div', { className: 'qm-sysline', title: u.group[0].text },
                                            `⚙ ${u.group.length > 1 ? `${u.group.length} 条系统注入` : u.group[0].text.slice(0, 120)}`)
                                        : null)
                                    : h(MessageRow, {
                                        ev: u.ev,
                                        prev: prevUnit?.kind === 'msg' ? prevUnit.ev : null,
                                        fresh,
                                        keyBase: `m${i}`,
                                      }),
                              );
                            }),
                      ),
                    ),
                    !atBottom && units.length > 0
                      ? h('button', {
                          className: 'qm-jump', type: 'button', 'aria-label': '回到底部',
                          onClick: jumpToBottom,
                        }, '↓')
                      : null,
                    // 注入消息开关（第1轮-1）：有被过滤内容时才显示
                    hasSys && h('div', { className: 'qm-sysline-toggle' },
                      h('button', {
                        type: 'button',
                        onClick: () => setShowSys(v => !v),
                        'aria-pressed': showSys,
                      }, showSys ? '隐藏系统注入消息' : `显示系统注入消息（${sysCount} 条）`)),
                  ),
            ),
          );
        }

        return h('div', { className: 'qm-page qm-root' },
          // 吸顶头部（设计稿 6）
          h('div', { className: 'qm-headbar' },
            h('h2', null, 'QQ 监控'),
            h('span', { className: 'qm-live' },
              h('span', { className: 'qm-live-dot', 'aria-hidden': true }), '实时'),
            h('span', { className: 'qm-badge' }, `${sessions.length} 个会话`),
            h('span', { className: 'qm-head-meta', style: { fontSize: 12, color: 'var(--qm-muted)' } },
              selectedTitle || '实时镜像本 Harness 里的 QQ 机器人对话'),
            h('button', {
              className: 'qm-refresh', type: 'button',
              onClick: () => { loadSessions(); if (selectedId) loadTranscript(selectedId); },
            }, '刷新'),
          ),
          // 标签栏（第2轮）
          h('div', { className: 'qm-tabs', role: 'tablist' },
            TABS.map(t => h('button', {
              key: t.id,
              type: 'button', role: 'tab',
              className: `qm-tab${tab === t.id ? ' active' : ''}`,
              'aria-selected': tab === t.id,
              onClick: () => setTab(t.id),
            }, t.label)),
          ),
          error ? h('div', { className: 'qm-error' }, error) : null,
          tab === 'chat' && selectedId !== null
            ? h(HealthBar, { health, nowTick, selectedTitle })
            : null,
          TABS.find(t => t.id === tab)?.render() ?? null,
        );
      }

      /** 总览页（第2轮）：状态条 + 此刻在做什么 + 今日时间线 + 模块卡片网格 */
      function OverviewPage({ events, health, nowTick }) {
        const [modules, setModules] = useState(null);
        useEffect(() => {
          let stopped = false;
          const load = () => {
            fetch(ROUTE_MODULES, { cache: 'no-store' }).then(r => r.json()).then(data => {
              if (!stopped) setModules(data.modules ?? []);
            }).catch(() => { if (!stopped) setModules([]); });
          };
          load();
          const timer = setInterval(() => {
            if (document.visibilityState === 'visible') load();
          }, TRANSCRIPT_POLL_MS);
          return () => { stopped = true; clearInterval(timer); };
        }, []);
        const now = deriveNow(events, nowTick);
        return h('div', { className: 'qm-chat', style: { overflowY: 'auto' } },
          h(HealthBar, { health, nowTick, selectedTitle: '' }),
          h('div', { className: 'qm-now' },
            StatusFace({ level: now.level === 'busy' ? 'ok' : 'idle' }),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'qm-now-doing' }, now.doing),
              h('div', { className: 'qm-now-sub' }, now.sub || '由会话事件推导，不依赖模型自述')),
          ),
          h('div', { className: 'qm-timeline-wrap' },
            h('div', { className: 'qm-timeline-title' }, '今日时间线（蓝=用户 绿=机器人 黄=工具）'),
            h(TodayTimeline, { events })),
          h('div', { className: 'qm-modgrid' },
            modules === null
              ? h('div', { className: 'qm-mod-empty' }, '加载中…')
              : modules.length === 0
                ? h('div', { className: 'qm-mod-empty qm-empty', style: { padding: '18px' } }, '功能上线后会出现在这里')
                : modules.map(m => h(ModuleCard, { key: m.id, m })),
          ),
        );
      }

      /** 统计页（第2轮）：14 天消息折线 + 回复耗时 + 工具排行 */
      function StatsPage({ events }) {
        const stats = computeStats(events);
        return h('div', { className: 'qm-stats' },
          h('div', { className: 'qm-stat-card' },
            h('div', { className: 'qm-stat-title' }, '近 14 天每日消息数（用户+机器人）'),
            h(DaysChart, { days: stats.days })),
          h('div', { className: 'qm-stat-card' },
            h('div', { className: 'qm-stat-title' }, `回复耗时（用户 → 机器人下一条回复，样本 ${stats.latencyCount} 次）`),
            h('div', { style: { display: 'flex', gap: 32 } },
              h('div', null,
                h('div', { className: 'qm-stat-num' }, fmtLatency(stats.latencyMedian)),
                h('div', { className: 'qm-stat-sub' }, '中位数')),
              h('div', null,
                h('div', { className: 'qm-stat-num' }, fmtLatency(stats.latencyP90)),
                h('div', { className: 'qm-stat-sub' }, 'P90')))),
          h('div', { className: 'qm-stat-card' },
            h('div', { className: 'qm-stat-title' }, '工具调用排行（前 8）'),
            stats.top.length === 0
              ? h('div', { className: 'qm-now-sub' }, '还没有工具调用记录')
              : h('div', null, stats.top.map(([name, count], i) => {
                  const max = stats.top[0][1];
                  return h('div', { key: name, className: 'qm-rank-row' },
                    h('span', { className: 'qm-rank-name' }, `${i + 1}. ${toolCn(name)}`),
                    h('span', { className: 'qm-rank-bar-track' },
                      h('span', { className: 'qm-rank-bar', style: { width: `${Math.max(4, (count / max) * 100)}%` } })),
                    h('span', { className: 'qm-rank-count' }, String(count)));
                }))),
        );
      }

      /** 左侧栏入口图标（宿主传入 size：展开 18 / 收起 16） */
      function RailIcon({ size = 16 }) {
        return h('svg', {
          className: 'qm-rail-icon', width: size, height: size, viewBox: '0 0 64 64',
          fill: 'none', 'aria-hidden': true,
        },
          h('rect', { x: 4, y: 12, width: 56, height: 40, rx: 12, fill: 'currentColor', opacity: .9 }),
          h('circle', { cx: 22, cy: 31, r: 5, fill: 'var(--dsw-alias-bg-base, #fff)' }),
          h('circle', { cx: 42, cy: 31, r: 5, fill: 'var(--dsw-alias-bg-base, #fff)' }),
          h('path', { d: 'M24 42c4 4 12 4 16 0', stroke: 'var(--dsw-alias-bg-base, #fff)', 'stroke-width': 4, 'stroke-linecap': 'round', fill: 'none' }),
        );
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          ctx.effect(() => {
            const style = document.createElement('style');
            style.setAttribute('data-plugin-css', 'qq-monitor');
            style.textContent = CSS;
            document.head.appendChild(style);
            return () => { style.remove(); };
          }, 'qq-monitor.styles');

          const slots = ctx.slots;
          const ctxInject = ctx.inject;
          if (slots === undefined || typeof ctxInject !== 'function') return;
          ctxInject.call(ctx, ['layout'], (pageCtx) => {
            const pageSlots = pageCtx?.slots;
            const layout = pageCtx?.layout;
            if (pageSlots === undefined || layout === undefined) return undefined;
            const stopMain = pageSlots.inject('main', () => pageSlots.register({
              name: 'main',
              key: PANEL_ID,
            }, MonitorPage));
            const stopSidebar = pageSlots.inject('sidebar.panellist', () => pageSlots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 12,
              label: 'QQ 监控',
            }, RailIcon));
            return () => {
              stopSidebar();
              stopMain();
            };
          });
        },
      };
    },
  });
})();
