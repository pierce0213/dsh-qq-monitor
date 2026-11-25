/**
 * Host half of the QQ monitor bundle.
 *
 * 数据来源（全部只读）：
 *  1. QQ 会话清单：`~/.dsh-qqbot/model-prefs.json` 的 `sessionIds`
 *     （@tencent-connect/dsh-qqbot 维护的 sessionKey → sessionId 映射）。
 *  2. 会话标题：宿主 `sessionQuery.listSessions()`（可选服务，缺失时降级）。
 *  3. 转写内容：`<DSH 数据目录>/sessions/<编码cwd>/<sessionId>/session.v4.jsonl.zstd`
 *     —— 已在真实日志上验证：zstd magic `28 b5 2f fd`，事件行
 *     `{type, seq, time, data}`；消息文本在 `data.content` /
 *     `data.message.content`（`[{type:'text',text}]` 块数组）。
 *
 * 浏览器半端通过同源 fetch 调用这里的两条路由；路由用 webServer 注册，
 * 与 qqbot 绑定页同一条已验证通道。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import * as zlibMod from 'node:zlib';

const ROUTE_SESSIONS = '/qq-monitor/sessions';
const ROUTE_TRANSCRIPT = '/qq-monitor/transcript';
const ROUTE_HEALTH = '/qq-monitor/health';
/** 端口探测超时（设计稿约束：500ms） */
const PORT_PROBE_TIMEOUT_MS = 500;
const MAX_TAIL_EVENTS = 400;
const MAX_TEXT_CHARS = 4000;

/** sessionQuery 的运行时引用（经独立 ctx.inject 注入，缺失时保持 undefined） */
const queryRef = { current: undefined };

function qqPrefsPath() {
  return resolve(homedir(), '.dsh-qqbot', 'model-prefs.json');
}

/** 读取 qqbot 的 sessionKey → sessionId 映射（只读；文件缺失/损坏返回空表） */
function readQqSessions() {
  try {
    const p = qqPrefsPath();
    if (!existsSync(p)) return [];
    const data = JSON.parse(readFileSync(p, 'utf8'));
    const map = data?.sessionIds;
    if (!map || typeof map !== 'object') return [];
    const out = [];
    for (const [key, sid] of Object.entries(map)) {
      if (typeof sid !== 'string' || !sid) continue;
      out.push({ key, sessionId: sid });
    }
    return out;
  } catch {
    return [];
  }
}

/** 会话 key 的展示信息：`qqbot:<appId>:<scope>:<peer>` */
function partsOf(key) {
  const seg = String(key).split(':');
  return { scope: seg[2] ?? '', peer: seg.slice(3).join(':') };
}

function peerLabel(peer) {
  const s = String(peer);
  return s.length > 12 ? `${s.slice(0, 10)}…` : s;
}

/** DSH 数据目录候选根（Host 进程环境未知，全部尝试） */
function dataRootCandidates() {
  const out = [];
  for (const envKey of ['DSH_HOME', 'DSH_PROFILE_DIR']) {
    const v = process.env[envKey];
    if (!v) continue;
    const root = envKey === 'DSH_PROFILE_DIR' ? resolve(v, '..', '..') : resolve(v);
    if (!out.includes(root)) out.push(root);
  }
  const home = resolve(homedir(), '.dsh');
  if (!out.includes(home)) out.push(home);
  return out;
}

/** 会话日志根目录候选（存在的优先） */
function sessionRoots() {
  const out = [];
  for (const root of dataRootCandidates()) {
    const dir = join(root, 'sessions');
    if (existsSync(dir) && !out.includes(dir)) out.push(dir);
  }
  return out;
}

/**
 * 按 sessionId 定位会话日志目录。已验证的真实布局：
 * `<root>/sessions/<编码工作区目录>/<sessionId>/session.v4.jsonl.zstd`；
 * 兼容旧式平铺 `<root>/sessions/<...>--<sessionId>/`。
 */
function findSessionDir(sessionId) {
  for (const root of sessionRoots()) {
    let workspaces;
    try { workspaces = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      const candidate = join(root, ws.name, sessionId);
      if (existsSync(candidate)) return candidate;
    }
    // 旧式平铺兼容
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      if (ws.name.endsWith(`--${sessionId}`) || ws.name.endsWith(sessionId)) {
        return join(root, ws.name);
      }
    }
  }
  return undefined;
}

/** 从 content 块数组提取可读文本（跳过 reasoning，图片占位） */
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'reasoning') continue;
    if (typeof b.text === 'string' && b.text) parts.push(b.text);
    else if (b.type === 'image' || b.mediaType) parts.push('[图片]');
  }
  const joined = parts.filter(Boolean).join('\n');
  return joined ? joined.slice(0, MAX_TEXT_CHARS) : undefined;
}

/** 把一条原始事件折叠成面板气泡（只保留对话相关类型） */
function bubbleOf(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return null;
  const data = ev.data;
  if (!data || typeof data !== 'object') return null;
  const at = typeof ev.time === 'number' ? ev.time : undefined;
  const seq = typeof ev.seq === 'number' ? ev.seq : undefined;
  switch (ev.type) {
    case 'user/message': {
      const text = textOfContent(data.content ?? data.message?.content);
      if (!text) return null;
      return { seq, type: 'user', at, text };
    }
    case 'assistant/message': {
      const text = textOfContent(data.message?.content ?? data.content);
      if (!text) return null;
      return { seq, type: 'assistant', at, text };
    }
    case 'tool/call': {
      const name = typeof data.name === 'string' ? data.name : 'tool';
      let args;
      if (typeof data.arguments === 'string' && data.arguments) {
        try {
          args = JSON.stringify(JSON.parse(data.arguments), null, 2);
        } catch {
          args = data.arguments;
        }
        if (args.length > 2000) args = `${args.slice(0, 2000)}…`;
      }
      return { seq, type: 'tool', at, name, text: `调用工具 ${name}`, args };
    }
    case 'session/title': {
      return typeof data.title === 'string' && data.title
        ? { seq, type: 'title', at, text: data.title }
        : null;
    }
    default:
      return null;
  }
}

function sessionLogPath(dir) {
  const preferred = join(dir, 'session.v4.jsonl.zstd');
  if (existsSync(preferred)) return preferred;
  try {
    const alt = readdirSync(dir).find(n => /^session\..*\.jsonl\.zst/.test(n));
    if (alt) return join(dir, alt);
  } catch { /* fall through */ }
  return undefined;
}

/** 会话日志是连续 zstd 帧的拼接；流式解压是唯一正确语义（同步 API 只解第一帧） */
async function decompressAllFrames(buf) {
  const { Readable } = await import('node:stream');
  // 流式构造器命名随版本而异，特性探测
  const makeStream = zlibMod.createZstdDecompress ?? zlibMod.zstdDecompressStream;
  if (typeof makeStream === 'function') {
    const chunks = [];
    const stream = Readable.from(buf).pipe(makeStream());
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.length > 0) return text;
  }
  // 回退：同步 API（部分版本一次解全部帧；只解第一帧时文本会明显偏短）
  const text = zlibMod.zstdDecompressSync?.(buf).toString('utf8');
  if (!text) throw new Error('zstd decompress produced no output');
  return text;
}

/** 把一份完整事件数组折叠成气泡（readSession 快照与文件日志共用） */
function bubblesFromEvents(events) {
  const bubbles = [];
  let title;
  for (const ev of events ?? []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'session/title' && typeof ev.data?.title === 'string') title = ev.data.title;
    const b = bubbleOf(ev);
    if (b) bubbles.push(b);
  }
  return { bubbles, title };
}

/* ── 转写缓存：health 3 秒轮询复用 transcript 结果；mtime + size 未变直接命中 ── */
const transcriptCache = new Map(); // sessionId -> { mtime, size, value }
const TRANSCRIPT_CACHE_LIMIT = 8;

function statSessionFile(sessionId) {
  const dir = findSessionDir(sessionId);
  const file = dir === undefined ? undefined : sessionLogPath(dir);
  if (file === undefined) return undefined;
  try {
    const st = statSync(file);
    return { mtime: st.mtimeMs, size: st.size, path: file };
  } catch {
    return undefined;
  }
}

/** 读取并解析一个会话的转写（尾部 MAX_TAIL_EVENTS 条气泡 + 标题；带文件版本缓存） */
async function readTranscript(sessionId) {
  const stat = statSessionFile(sessionId);
  const hit = transcriptCache.get(sessionId);
  if (stat && hit && hit.mtime === stat.mtime && hit.size === stat.size) {
    return hit.value;
  }
  const value = await readTranscriptUncached(sessionId);
  if (stat && value && !value.error) {
    if (transcriptCache.size >= TRANSCRIPT_CACHE_LIMIT) {
      const oldest = transcriptCache.keys().next().value;
      transcriptCache.delete(oldest);
    }
    transcriptCache.set(sessionId, { mtime: stat.mtime, size: stat.size, value });
  }
  return value;
}

async function readTranscriptUncached(sessionId) {
  // 首选：宿主自己的日志读取器（原生解析，无格式/版本假设）
  const query = queryRef.current;
  let serviceError;
  if (query && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId);
      const events = snapshot?.events ?? snapshot?.log?.events ?? (Array.isArray(snapshot) ? snapshot : undefined);
      if (events !== undefined) {
        const { bubbles, title } = bubblesFromEvents(events);
        return {
          events: bubbles.slice(-MAX_TAIL_EVENTS),
          title,
          generatedAt: Date.now(),
          debug: { source: 'readSession', events: events.length, snapshotKeys: Object.keys(snapshot ?? {}) },
        };
      }
      serviceError = `readSession returned unexpected shape: ${Object.keys(snapshot ?? {}).join(',')}`;
    } catch (err) {
      serviceError = String(err?.message ?? err).slice(0, 300);
    }
  }
  // 回退：直接读会话日志文件（zstd 多帧）
  const dir = findSessionDir(sessionId);
  const file = dir === undefined ? undefined : sessionLogPath(dir);
  if (file === undefined) {
    return { events: [], title: undefined, error: serviceError ?? 'session-directory-not-found' };
  }
  let buf;
  try { buf = readFileSync(file); } catch (err) {
    return { events: [], title: undefined, error: `read-failed: ${err?.message ?? err}` };
  }
  // zstd magic: 28 B5 2F FD
  if (buf.length < 4 || buf[0] !== 0x28 || buf[1] !== 0xb5 || buf[2] !== 0x2f || buf[3] !== 0xfd) {
    return { events: [], title: undefined, error: 'unsupported-log-format' };
  }
  let text;
  try {
    text = await decompressAllFrames(buf);
  } catch (err) {
    return { events: [], title: undefined, error: `decompress-failed: ${err?.message ?? err}`, debug: { dir, size: buf.length } };
  }
  const bubbles = [];
  let title;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    if (ev?.type === 'session/title' && typeof ev?.data?.title === 'string') title = ev.data.title;
    const b = bubbleOf(ev);
    if (b) bubbles.push(b);
  }
  return {
    events: bubbles.slice(-MAX_TAIL_EVENTS),
    title,
    generatedAt: Date.now(),
    debug: { dir, size: buf.length, chars: text.length, bubbles: bubbles.length },
  };
}

/* ── 会话记录字段提取（SessionRecord 结构未固化，全部候选式读取） ── */
function titleOf(rec) {
  if (!rec || typeof rec !== 'object') return undefined;
  const v = rec.title ?? rec.header?.title ?? rec.meta?.title ?? rec.summary?.title;
  return typeof v === 'string' && v ? v : undefined;
}
function updatedAtOf(rec) {
  if (!rec || typeof rec !== 'object') return undefined;
  const v = rec.updatedAt ?? rec.lastActivity ?? rec.header?.updatedAt;
  return typeof v === 'number' ? v : undefined;
}
function idOf(rec) {
  if (!rec || typeof rec !== 'object') return undefined;
  return typeof rec.id === 'string' ? rec.id : typeof rec.sessionId === 'string' ? rec.sessionId : undefined;
}

/* ── 同源围栏（对齐 dsh-prompt isAllowed：loopback 字面量 + sec-fetch-site + Origin 同源） ──
 * Host 必须是 loopback 字面量（127/8、::1、localhost，带端口先剥离），只做字面量比对、
 * 不做 DNS 解析（127.0.0.1.nip.io 这类"解析到 loopback 的域名"一律拒）；
 * cross-site 拒绝；Origin 缺失时只认 Host（Desktop IPC 桥会删 origin 头，loopback 已验过）；
 * Origin 存在时需与 Host 同值。 */
function isLoopbackHostValue(hostValue) {
  const raw = String(hostValue).trim().toLowerCase();
  if (!raw) return false;
  let hostname = raw;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) return false;
    hostname = raw.slice(1, end);
  } else {
    const colonCount = (raw.match(/:/g) || []).length;
    if (colonCount === 0) hostname = raw;
    else if (colonCount === 1) hostname = raw.slice(0, raw.lastIndexOf(':'));
    else hostname = raw;
  }
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname === '::1') return true;
  if (hostname.startsWith('::ffff:')) {
    const tail = hostname.slice('::ffff:'.length);
    const parts = tail.split('.');
    if (parts.length === 4 && parts[0] === '127') return true;
    return false;
  }
  const parts = hostname.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    return Number(parts[0]) === 127;
  }
  return false;
}

function headerValue(headers, name) {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/** 请求来源围栏：不满足一律 403（数据不敏感程度不豁免校验——聊天记录是隐私） */
function isAllowed(req) {
  try {
    const hostValue = headerValue(req.headers, 'host');
    if (!hostValue) return false;
    if (!isLoopbackHostValue(hostValue)) return false;
    const site = headerValue(req.headers, 'sec-fetch-site');
    if (site === 'cross-site') return false;
    const originValue = headerValue(req.headers, 'origin');
    if (originValue === undefined) return true;
    return new URL(originValue).host.toLowerCase() === String(hostValue).trim().toLowerCase();
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function handleSessions(req, res) {
  if (!isAllowed(req)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const prefs = readQqSessions();
    const sessions = prefs.map(p => {
      const { scope, peer } = partsOf(p.key);
      return {
        key: p.key,
        sessionId: p.sessionId,
        scope,
        peer,
        peerLabel: peerLabel(peer),
        title: undefined,
        updatedAt: undefined,
        lastText: undefined,
      };
    });
    // 会话少（QQ 场景典型 1~5 个），顺手把每条的尾部预览与最后时间一起带出，
    // 左侧列表不需要再为预览逐条拉转写。会话多时这段的开销仍可接受（zstd 快）。
    for (const s of sessions) {
      try {
        const t = await readTranscript(s.sessionId);
        if (typeof t.title === 'string' && t.title) s.title = t.title;
        const tail = [...(t.events ?? [])].reverse().find(ev => ev.type === 'user' || ev.type === 'assistant');
        if (tail) {
          s.lastText = tail.type === 'user' ? tail.text : tail.text;
          s.updatedAt = tail.at;
        }
      } catch { /* 单条失败不阻塞清单 */ }
    }
    const query = queryRef.current;
    if (query && typeof query.listSessions === 'function') {
      try {
        const records = await query.listSessions();
        const byId = new Map((records ?? []).map(r => [idOf(r), r]).filter(([id]) => id));
        for (const s of sessions) {
          const rec = byId.get(s.sessionId);
          s.title = titleOf(rec);
          s.updatedAt = updatedAtOf(rec);
        }
      } catch { /* 降级：无标题也可用 */ }
    }
    sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    sendJson(res, 200, { sessions, generatedAt: Date.now() });
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message ?? err) });
  }
}

async function handleTranscript(req, res) {
  if (!isAllowed(req)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const url = new URL(req.url ?? '/', 'http://local');
    const id = url.searchParams.get('id') ?? '';
    const prefs = readQqSessions();
    if (!prefs.some(p => p.sessionId === id)) {
      return sendJson(res, 403, { error: 'unknown-session' });
    }
    sendJson(res, 200, await readTranscript(id));
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message ?? err) });
  }
}

/**
 * 会话健康数据（设计稿【后端】）：
 * 只 stat 文件与事件元数据，不读日志内容；不返回完整路径。
 * lastRole/lastEventAt 取转写气泡的最后一跳（bubbleOf 已折叠），
 * health 与 transcript 共用 readTranscript 的内存缓存，不重复解压。
 */
async function collectHealth(sessionId, reqHostPort) {
  const now = Date.now();
  const out = {
    now,
    session: { size: undefined, mtime: undefined, lastRole: undefined, lastEventAt: undefined },
    visionRouter: { exists: false, mtime: undefined },
    webPort: { port: undefined, ok: false, latencyMs: undefined },
  };
  // 会话文件 stat
  const dir = findSessionDir(sessionId);
  const file = dir === undefined ? undefined : sessionLogPath(dir);
  if (file !== undefined) {
    try {
      const st = statSync(file);
      out.session.size = st.size;
      out.session.mtime = st.mtimeMs;
    } catch { /* stat 失败保持 undefined */ }
  }
  // 尾部角色/时间（走缓存，不重复解压）
  try {
    const t = await readTranscript(sessionId);
    const events = t.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === 'user' || ev.type === 'assistant' || ev.type === 'tool') {
        out.session.lastRole = ev.type;
        out.session.lastEventAt = ev.at;
        break;
      }
    }
    if (out.session.mtime === undefined && typeof t.generatedAt === 'number') {
      // 没拿到 stat 时至少保证前端可判定（极少发生）
      out.session.mtime = undefined;
    }
  } catch { /* 转写失败不阻塞 stat 数据 */ }
  // vision-router 日志（判定「疑似卡住」的旁证之一）
  try {
    const vr = join(dataRootCandidates()[0] ?? resolve(homedir(), '.dsh'), 'logs', 'vision-router', 'vision-router.log');
    if (existsSync(vr)) {
      out.visionRouter.exists = true;
      out.visionRouter.mtime = statSync(vr).mtimeMs;
    }
  } catch { /* 保持 exists:false */ }
  // Web 端口探测：端口取请求自身的 Host 头（请求能到达即端口真实），只连 127.0.0.1，500ms 超时
  try {
    const hostHeader = typeof reqHostPort === 'string' ? reqHostPort : '';
    const port = Number(hostHeader.startsWith('[')
      ? (hostHeader.match(/]:(\d+)$/) ?? [])[1]
      : hostHeader.includes(':') ? hostHeader.slice(hostHeader.lastIndexOf(':') + 1) : '');
    if (Number.isFinite(port) && port > 0) {
      out.webPort.port = port;
      const started = Date.now();
      out.webPort.ok = await new Promise((resolveProbe) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const done = (ok) => {
          socket.destroy();
          resolveProbe(ok);
        };
        socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => done(false));
        socket.once('connect', () => {
          out.webPort.latencyMs = Date.now() - started;
          done(true);
        });
        socket.once('error', () => done(false));
      });
    }
  } catch { /* 保持 ok:false */ }
  return out;
}

async function handleHealth(req, res) {
  if (!isAllowed(req)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const url = new URL(req.url ?? '/', 'http://local');
    const id = url.searchParams.get('id') ?? '';
    const prefs = readQqSessions();
    if (!prefs.some(p => p.sessionId === id)) {
      return sendJson(res, 403, { error: 'unknown-session' });
    }
    sendJson(res, 200, await collectHealth(id, req.headers?.host));
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message ?? err) });
  }
}

/** 宿主插件入口 */
export function apply(ctx) {
  const cleanups = [];
  const inject = ctx.inject;
  if (typeof inject !== 'function') {
    console.warn('[qq-monitor] ctx.inject 不可用，路由未注册');
    return;
  }
  // 数据路由（webServer 可选；缺失时本插件无路由，面板会显示连接失败）
  const dRoutes = inject.call(ctx, ['webServer'], (scoped) => {
    const webServer = scoped?.webServer;
    if (webServer === undefined || typeof webServer.register !== 'function') return undefined;
    const disposers = [
      webServer.register({
        kind: 'exact',
        path: ROUTE_SESSIONS,
        handler: (req, res) => { void handleSessions(req, res); },
      }),
      webServer.register({
        kind: 'exact',
        path: ROUTE_TRANSCRIPT,
        handler: (req, res) => { handleTranscript(req, res); },
      }),
      webServer.register({
        kind: 'exact',
        path: ROUTE_HEALTH,
        handler: (req, res) => { void handleHealth(req, res); },
      }),
    ];
    return () => { for (const d of disposers) d(); };
  }, 'qq-monitor.routes');
  if (typeof dRoutes === 'function') cleanups.push(dRoutes);

  // sessionQuery 标题增强（可选；缺失时仅显示会话清单）
  const dQuery = inject.call(ctx, ['sessionQuery'], (scoped) => {
    queryRef.current = scoped?.sessionQuery;
  }, 'qq-monitor.query');
  if (typeof dQuery === 'function') cleanups.push(dQuery);

  return () => {
    queryRef.current = undefined;
    for (const d of cleanups.reverse()) d();
  };
}

/** 仅供自检/测试导入；不影响插件运行时 */
export const __test = { readTranscript, readQqSessions, findSessionDir };
