import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { getSession, latestSession, listSessions, startLogin } from './login.js';
import { pngDataUrl } from './qr.js';
import { createServer } from './server.js';
import { adminPage } from './admin.js';
import { probeAccount } from './dispatch.js';
import { poolView, resetCooldown, setStrategy, updateAccount, loadPool } from './pool.js';
import { buildStats, RANGES } from './stats.js';
import { BRIDGE_HOME } from './paths.js';
import { ensureAccount, removeAccount } from './accounts.js';
import { info, warn } from './log.js';
import { createApiAuthCheck, handleApiRequest, handleApiSettingsApi } from './api-server.js';
import {
  WS_PING_MS,
  WS_PONG_GRACE_MS,
  assertHandshake,
  createWebSocketTransport,
} from './websocket.js';

/** 登录页：手机上打开就能看到二维码，扫完自动跳状态。 */
function page(sessionId, initial, embed = false) {
  const data = JSON.stringify(initial).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<link rel="icon" href="data:,"/>
<title>WorkBuddy 扫码登录</title>
<style>
  :root{color-scheme:light dark;--bg:#f6f7f9;--fg:#111;--muted:#6b7280;--card:#fff;--line:#e5e7eb;--brand:#7c5cff}
  @media (prefers-color-scheme:dark){:root{--bg:#0e0f13;--fg:#f3f4f6;--muted:#9ca3af;--card:#171922;--line:#262a36}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);
       font-family:ui-sans-serif,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:24px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px;max-width:100%;width:460px;
        box-shadow:0 12px 40px rgba(0,0,0,.08)}
  h1{font-size:19px;margin:0 0 4px}
  p{margin:0;color:var(--muted);font-size:13px;line-height:1.6}
  .qr{margin:22px auto;width:260px;height:260px;border-radius:16px;background:#fff;padding:12px;
      border:1px solid var(--line);display:flex;align-items:center;justify-content:center}
  .qr img{width:100%;height:100%;image-rendering:pixelated}
  .status{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;justify-content:center;margin:8px 0 4px}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--brand);animation:pulse 1.4s infinite}
  .dot.ok{background:#16a34a;animation:none}
  .dot.bad{background:#ef4444;animation:none}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
  .link{word-break:break-all;font-size:12px;color:var(--muted);margin-top:14px;line-height:1.5}
  .link a{color:var(--brand)}
  .meta{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);
        display:grid;gap:6px}
  code{background:rgba(127,127,127,.12);padding:1px 6px;border-radius:6px;font-size:12px}
  body.embed{background:transparent;padding:0;display:block}
  body.embed .card{border:0;box-shadow:none;border-radius:0;padding:18px;width:100%}
  body.embed h1{font-size:16px}
</style></head>
<body class="${embed ? 'embed' : ''}"><div class="card">
  <h1>WorkBuddy 扫码登录</h1>
  <p>用 WorkBuddy / 微信扫下面的二维码完成授权，页面会自动更新状态。</p>
  <div class="qr"><img id="qr" alt="登录二维码" src=""/></div>
  <div class="status"><span class="dot" id="dot"></span><span id="st">正在获取二维码…</span></div>
  <div class="link" id="link"></div>
  <div class="meta">
    <div>账号：<code id="acc"></code></div>
    <div>会话：<code id="sid"></code></div>
    <div>状态机：starting → choosing_method → waiting_scan → authorized</div>
  </div>
</div>
<script>
const SID=${JSON.stringify(sessionId)};
let data=${data};
const $=(id)=>document.getElementById(id);
function paint(d){
  if(!d) return;
  data=d;
  $('acc').textContent=d.account||'-';
  $('sid').textContent=d.id||SID;
  const map={starting:'正在启动登录…',choosing_method:'正在选择登录方式…',waiting_scan:'等待扫码授权',
             authorized:'已登录，可以回到 Agent 继续',already_logged_in:'该账号已登录',failed:'登录失败',
             timeout:'二维码已过期',cancelled:'已取消'};
  $('st').textContent=map[d.status]||d.status;
  const dot=$('dot'); dot.className='dot'+(d.status==='authorized'||d.status==='already_logged_in'?' ok':(d.status==='failed'||d.status==='timeout'?' bad':''));
  if(d.url&&!$('qr').dataset.loaded){ $('qr').src='/api/qr/'+SID; $('qr').dataset.loaded='1';
    $('link').innerHTML='链接：<a href="'+d.url+'">'+d.url+'</a>'; }
}
paint(data);
async function tick(){
  try{
    const r=await fetch('/api/status/'+SID); const j=await r.json();
    if(j.ok) paint(j.session);
    if(['authorized','failed','timeout','cancelled','already_logged_in'].includes(j.session?.status)) return;
  }catch(e){}
  setTimeout(tick,1500);
}
tick();
</script></body></html>`;
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  if (!res || res.destroyed || res.writableEnded) return false;
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // The response already crossed a failed terminal path.
    }
    return false;
  }
  try {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
    return true;
  } catch {
    try {
      if (!res.destroyed && !res.writableEnded) res.end();
    } catch {
      // The peer may reset between the header and body writes.
    }
    return false;
  }
}

function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 监听地址是否只对本机可见。非回环意味着同网段的任何人都能连上来。 */
function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost'
    || value === '::1'
    || value === '127.0.0.1'
    || value.startsWith('127.');
}

function tokensMatch(got, expected) {
  const a = Buffer.from(String(got ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (!b.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 管理接口门禁。语义由**监听地址**决定，不是由「有没有配 token」决定：
 *  - 回环监听：只有本机连得上，未设 token 时默认放行（本地开发业态）。
 *  - 非回环监听：必须设 WB_ADMIN_TOKEN，否则 startHttpServer 直接拒绝启动。
 *    以前是「没设 token 就全开」，于是 wb http --host 0.0.0.0 等于把
 *    「关远程鉴权」「建 Key」两个接口送给整个网段。
 *
 * token 只从请求头读。查询串里的 token 会进浏览器历史和反代日志，
 * 因此只有管理页本身（浏览器没法带自定义头）接受它，页面会立刻把它从地址栏抹掉。
 */
function createAdminGate({ host, token }) {
  const expected = String(token ?? '').trim();
  const required = Boolean(expected);
  if (!required && !isLoopbackHost(host)) {
    throw Object.assign(
      new Error(
        [
          '拒绝在 ' + host + ' 上监听：非回环地址必须设置 WB_ADMIN_TOKEN，',
          '否则同网段的任何人都能通过管理接口改配置或创建 API Key。',
          '要么设 WB_ADMIN_TOKEN，要么只监听 127.0.0.1。',
        ].join(''),
      ),
      { code: 'ADMIN_TOKEN_REQUIRED' },
    );
  }
  return {
    required,
    /** API 请求：只认请求头。 */
    allows(req) {
      if (!required) return true;
      return tokensMatch(req.headers['x-wb-token'], expected);
    },
    /** 管理页本身：允许首次用 ?token= 引导，页面随后会清掉地址栏。 */
    allowsPage(req, url) {
      if (!required) return true;
      if (tokensMatch(req.headers['x-wb-token'], expected)) return true;
      return tokensMatch(url.searchParams.get('token'), expected);
    },
  };
}

/**
 * 启动本地 HTTP 服务：
 *  - /login            → 最近一次登录
 *  - /login/:id        → 指定登录会话
 *  - /api/status/:id   → 状态 JSON
 *  - /api/qr/:id       → 二维码 PNG
 *  - /mcp              → （可选）Streamable HTTP MCP 入口
 */
export async function startHttpServer({
  port = 7666,
  host = '127.0.0.1',
  mcp = false,
  apiDeps = {},
  adminToken = process.env.WB_ADMIN_TOKEN,
} = {}) {
  const admin = createAdminGate({ host, token: adminToken });
  const transports = new Map();
  const activeSockets = new Set();
  const activeWebSockets = new Set();
  // Persistence belongs to this server instance, not the process. This keeps
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    try {
      if (mcp && p === '/mcp') {
        await handleMcp(req, res, transports);
        return;
      }

      if (p === '/health' && req.method === 'GET') {
        return json(res, 200, { status: 'ok' });
      }

      if (p.startsWith('/v1/')) {
        if (await handleApiRequest({ req, res, url, deps: apiDeps })) return;
      }

      if (p === '/api/api-compat' || p.startsWith('/api/api-compat/')) {
        if (!admin.allows(req)) {
          return json(res, 401, { ok: false, error: '需要管理令牌' });
        }
        await handleApiSettingsApi(req, res, url);
        return;
      }

      if (p === '/' || p === '/admin') {
        if (!admin.allowsPage(req, url)) return send(res, 401, '需要管理令牌：?token=…');
        send(res, 200, adminPage({ home: BRIDGE_HOME, token: admin.required ? String(adminToken) : '' }), 'text/html; charset=utf-8');
        return;
      }

      // ------------------------------------------------------- 号池 API
      if (p === '/api/stats') {
        if (!admin.allows(req)) return json(res, 401, { ok: false, error: '需要管理令牌' });
        let range = url.searchParams.get('range') || 'today';
        if (!RANGES[range]) range = 'today';
        const stats = buildStats(loadPool(), range);
        return json(res, 200, { ok: true, ...stats });
      }

      if (p.startsWith('/api/pool')) {
        if (!admin.allows(req)) return json(res, 401, { ok: false, error: '需要管理令牌' });
        if (await handlePoolApi(req, res, url, p)) return;
      }

      if (p === '/login') {
        const s = latestSession();
        send(res, 200, page(s?.id || '', s ? s.snapshot() : null, url.searchParams.has('embed')), 'text/html; charset=utf-8');
        return;
      }

      const m = p.match(/^\/login\/([\w.-]+)$/);
      if (m) {
        const s = getSession(m[1]);
        if (!s) return send(res, 404, '会话不存在或已过期');
        send(res, 200, page(s.id, s.snapshot(), url.searchParams.has('embed')), 'text/html; charset=utf-8');
        return;
      }

      const st = p.match(/^\/api\/status\/([\w.-]+)$/);
      if (st) {
        const s = getSession(st[1]);
        if (!s) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }), 'application/json');
        send(res, 200, JSON.stringify({ ok: true, session: s.snapshot() }), 'application/json');
        return;
      }

      const qr = p.match(/^\/api\/qr\/([\w.-]+)$/);
      if (qr) {
        const s = getSession(qr[1]);
        if (!s?.url) return send(res, 404, 'no qr');
        const dataUrl = await pngDataUrl(s.url);
        const b64 = dataUrl.split(',')[1];
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(Buffer.from(b64, 'base64'));
        return;
      }

      if (p === '/api/sessions') {
        send(res, 200, JSON.stringify({ ok: true, sessions: listSessions() }), 'application/json');
        return;
      }

      send(res, 404, 'Not Found');
    } catch (err) {
      warn(`HTTP ${p}: ${err.message}`);
      send(res, 500, 'internal error');
    }
  });

  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.once('close', () => activeSockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  // Applied to every accepted TCP session, including the WebSocket upgrade.
  server.prependListener('connection', (socket) => {
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/v1/responses' && url.pathname !== '/v1/responses/') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    let result;
    try {
      const auth = createApiAuthCheck(apiDeps)(req);
      if (!auth.ok) {
        socket.write(`HTTP/1.1 ${auth.status} ${auth.status === 401 ? 'Unauthorized' : 'Not Found'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
        return;
      }
      const accept = assertHandshake(req);
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'));
      result = auth;
    } catch {
      socket.destroy();
      return;
    }
    let session;
    const ws = createWebSocketTransport(socket, {
      observer: true,
      // Responses owns an upstream account lease while a generation is active.
      // Production always requires peer liveness; fixtures may only shorten
      // the intervals so CI does not wait for the 15s/10s defaults.
      requireClientPong: true,
      pingMs: apiDeps.wsPingMs ?? WS_PING_MS,
      pongGraceMs: apiDeps.wsPongGraceMs ?? WS_PONG_GRACE_MS,
      onMessage(message) {
        if (message?.type === 'response.interrupt') {
          session?.interrupt();
          return;
        }
        if (message?.type === 'response.create' || message?.type === 'create') {
          session?.create(message);
          return;
        }
        ws.send({
          type: 'error',
          error: { code: 'unsupported_command', message: 'expected response.create or response.interrupt' },
        });
      },
      onClose(info) {
        activeWebSockets.delete(ws);
        warn(`Responses WebSocket closed: ${info.kind}`);
        return session?.close(info);
      },
    });
    activeWebSockets.add(ws);
    session = result.responses.wsSession({
      ws,
      send: (message) => ws.send(message),
      config: result.config,
      clientKey: result.clientKey,
    });
    if (head?.length) socket.emit('data', head);
  });

  const actual = server.address().port;
  info(`登录页：http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}/login`);
  if (mcp) info(`MCP over HTTP：http://${host}:${actual}/mcp`);

  return {
    server,
    port: actual,
    sockets: activeSockets,
    waitForConnections: (predicate = (items) => items.length === 0, timeoutMs = 3000) => (
      waitForConnections(activeSockets, predicate, timeoutMs)
    ),
    close: ({ graceMs = 3000 } = {}) => closeServer({
      server,
      sockets: activeSockets,
      graceMs,
      webSockets: activeWebSockets,
    }),
  };
}

async function waitForConnections(sockets, predicate, timeoutMs = 3000, intervalMs = 10) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!predicate([...sockets])) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}

async function closeServer({ server, sockets, webSockets, graceMs }) {
  for (const ws of webSockets) ws.close(1001, 'server shutting down');
  let closeError = null;
  server.close((error) => {
    closeError = error;
  });
  await waitForConnections(sockets, (items) => items.length === 0, graceMs);
  for (const socket of sockets) socket.destroy();
  for (const ws of webSockets) ws.terminate();
  const cleared = await waitForConnections(
    sockets,
    (items) => items.length === 0,
    Math.min(500, graceMs),
  );
  if (!cleared) {
    throw Object.assign(
      new Error(`server connections did not close (${sockets.size} remaining)`),
      { code: 'SERVER_CLOSE_TIMEOUT' },
    );
  }
  if (closeError) throw closeError;
}

/** 号池 REST 接口。返回 true 表示已处理，false 交给后续路由。 */
async function handlePoolApi(req, res, url, p) {
  const parts = p.split('/').filter(Boolean); // api / pool / :name / :action
  const name = parts[2] ? decodeURIComponent(parts[2]) : null;
  const action = parts[3] || null;

  try {
    if (!name) {
      if (req.method === 'GET') {
        return json(res, 200, { ok: true, ...poolView() }), true;
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const strategy = setStrategy(body.strategy);
        return json(res, 200, { ok: true, strategy }), true;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const account = String(body.name || '').trim();
        if (!account) throw new Error('缺少账号名');
        ensureAccount(account);
        return json(res, 200, { ok: true, account }), true;
      }
      return json(res, 405, { ok: false, error: 'method not allowed' }), true;
    }

    if (action === 'action') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' }), true;
      const body = await readBody(req);

      if (body.action === 'reset') {
        resetCooldown(name);
        return json(res, 200, { ok: true }), true;
      }
      if (body.action === 'test') {
        const result = await probeAccount(name);
        return json(res, 200, {
          ok: true,
          result,
          message: result.ok
            ? `${name} 可用 · ${(result.durationMs / 1000).toFixed(1)}s`
            : `${name} 失败：${result.error}`,
        }), true;
      }
      if (body.action === 'login') {
        const session = await startLogin({ account: name });
        return json(res, 200, { ok: true, sessionId: session.id, url: session.url || null }), true;
      }
      return json(res, 400, { ok: false, error: `未知操作 ${body.action}` }), true;
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const entry = updateAccount(name, body);
      return json(res, 200, { ok: true, account: entry }), true;
    }
    if (req.method === 'DELETE') {
      const removed = removeAccount(name);
      return json(res, 200, { ok: true, removed }), true;
    }
    return false;
  } catch (err) {
    json(res, 400, { ok: false, error: err.message });
    return true;
  }
}

async function handleMcp(req, res, transports) {
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );

  const sid = req.headers['mcp-session-id'];

  if (req.method === 'POST') {
    let transport = sid ? transports.get(sid) : null;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const server = createServer();
      await server.connect(transport);
    }
    await transport.handleRequest(req, res);
    return;
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    const transport = sid ? transports.get(sid) : null;
    if (!transport) {
      res.writeHead(400).end('unknown session');
      return;
    }
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(405).end('method not allowed');
}
