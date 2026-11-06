import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runTask, cliExists, cliCommand, quickAuthCheck } from './runner.js';
import { dispatchTask } from './dispatch.js';
import { poolView, resetCooldown, setStrategy, updateAccount, STRATEGIES } from './pool.js';
import { startLogin, getSession, latestSession, listSessions } from './login.js';
import {
  listAccounts,
  resolveAccountName,
  setDefaultAccount,
  removeAccount,
} from './accounts.js';
import { loadConfig, BRIDGE_HOME } from './paths.js';
import { terminalQr, pngDataUrl } from './qr.js';
import { info, error } from './log.js';

const VERSION = '0.3.1';

function text(s) {
  return { type: 'text', text: String(s) };
}

function jsonBlock(obj) {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}

/** 把登录态包装成一句话，避免用户每次都要自己判断。 */
function authLine(name) {
  const chk = quickAuthCheck(name);
  return chk.loggedIn ? `已登录（${chk.reason}）` : `未登录（${chk.reason}）`;
}

export function createServer() {
  const server = new McpServer(
    { name: 'workbuddy', version: VERSION },
    {
      instructions: [
        '本服务器把 WorkBuddy（codebuddy CLI）当作子 Agent 暴露给当前编程助手。',
        '当用户说「让 workbuddy 做…」「用 WorkBuddy 处理…」，调用 workbuddy_task。',
        '若返回 AUTH_REQUIRED 或提示未登录，调用 workbuddy_login 拿到二维码，请用户用 WorkBuddy App 扫码，',
        '然后用 workbuddy_login_status 轮询（或把二维码图片直接展示给用户）。',
        '任务里产生的文件落在 cwd 指定的目录，不会自动进入当前助手的上下文，需要时请自行读取。',
      ].join('\n'),
    },
  );

  // ---------------------------------------------------------------- 任务
  server.registerTool(
    'workbuddy_task',
    {
      title: '让 WorkBuddy 执行任务',
      description: [
        '把一段自然语言任务交给本机 WorkBuddy 执行，返回它的最终文本结果。',
        '默认从账号池里自动挑负载最轻的账号；某个号未登录或被限流时会自动换号重试。',
        '适合：批量文件处理、文档/表格/PPT 生成、长链路调研、需要 WorkBuddy 技能与连接器的场景。',
        '文件会写入 cwd，不会自动进入你的上下文。',
      ].join(''),
      inputSchema: {
        prompt: z.string().describe('交给 WorkBuddy 的任务描述，可多行，越具体越好'),
        cwd: z.string().optional().describe('工作目录，WorkBuddy 在这里读写文件；默认取桥接配置'),
        model: z.string().optional().describe('模型 ID，如 auto / hy3 / deepseek-v4-pro'),
        fallbackModel: z.string().optional().describe('主模型限流时的回退模型'),
        timeoutMs: z.number().int().min(5000).max(3600000).optional().describe('超时毫秒，默认 900000'),
        account: z
          .string()
          .optional()
          .describe('指定账号名；默认 auto = 由号池自动分配负载。填具体名字则强制用这个号，不做故障切换'),
        skipPermissions: z.boolean().optional().describe('是否自动授权文件/网络操作，默认 true'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      const progressToken = extra?._meta?.progressToken;
      let lastNotify = 0;
      let chars = 0;

      const onProgress = (delta) => {
        chars += delta.length;
        const now = Date.now();
        if (!progressToken || now - lastNotify < 3000) return;
        lastNotify = now;
        try {
          extra?.sendNotification?.({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: Math.min(chars, 100000),
              message: `WorkBuddy 正在执行… 已产生 ${chars} 字`,
            },
          })?.catch?.(() => {});
        } catch {
          /* 客户端不支持通知时忽略 */
        }
      };

      const res = await dispatchTask({ ...args, account: args.account || 'auto', signal: extra?.signal, onProgress });

      if (!res.ok) {
        return {
          isError: true,
          content: [
            text(`WorkBuddy 执行失败：${res.error}${res.hint ? `\n提示：${res.hint}` : ''}`),
            text(jsonBlock({ code: res.code, account: res.account, attempts: res.attempts, durationMs: res.durationMs })),
          ],
        };
      }

      const footer = [
        '',
        '---',
        `耗时 ${(res.durationMs / 1000).toFixed(1)}s · 模型 ${res.meta?.model || res.model} · 账号 ${res.account}`,
        res.attempts?.length > 1 ? `已换号 ${res.attempts.length} 次：${res.attempts.map((a) => a.account).join(' → ')}` : '',
        `工作目录 ${res.cwd}`,
      ].filter(Boolean).join('\n');

      return {
        content: [text(res.text || '（WorkBuddy 没有返回文本内容）' + footer)],
        structuredContent: {
          text: res.text,
          durationMs: res.durationMs,
          account: res.account,
          attempts: res.attempts,
          cwd: res.cwd,
          sessionId: res.meta?.sessionId,
          tokens: res.meta?.usage,
        },
      };
    },
  );

  // ---------------------------------------------------------------- 扫码登录
  server.registerTool(
    'workbuddy_login',
    {
      title: '扫码登录 WorkBuddy 账号',
      description: [
        '启动 WorkBuddy 的登录流程并返回一张二维码（图片 + 终端字符画 + 链接）。',
        '请把二维码展示给用户，让用户用 WorkBuddy / 微信扫码完成授权；',
        '之后用 workbuddy_login_status 查询是否登录成功（会持续轮询，通常 5~30 秒）。',
        '不需要本机浏览器，适合远程服务器。',
      ].join(''),
      inputSchema: {
        account: z.string().optional().describe('账号名，登录结果会存到这个独立配置目录，默认 default'),
        site: z
          .enum(['cn', 'intl', 'enterprise', 'ioa'])
          .optional()
          .describe('登录站点：cn=国内站，intl=国际站，enterprise=企业版，ioa=腾讯内网'),
        timeoutMs: z.number().int().min(30000).max(900000).optional().describe('等待授权的上限，默认 300000'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      if (!cliExists()) {
        return {
          isError: true,
          content: [
            text(
              `找不到 ${cliCommand()}。请先安装 WorkBuddy CLI：\n  npm i -g @tencent-ai/codebuddy-code\n然后重新调用本工具。`,
            ),
          ],
        };
      }

      const session = await startLogin(args);

      // 给 TUI 一点时间渲染出登录链接（多数机器 1~3 秒）
      const url = await waitForUrl(session, 15000);

      if (!url) {
        const snap = session.snapshot();
        return {
          isError: true,
          content: [
            text(`还没有拿到登录链接（状态：${snap.status}）。\n${snap.error || ''}`),
            text('再等几秒后调用 workbuddy_login_status 查询；若一直拿不到，可在本机终端直接运行 codebuddy 手动登录。'),
            text(jsonBlock(snap)),
          ],
        };
      }

      const ascii = await terminalQr(url);
      const dataUrl = await pngDataUrl(url);
      const base64 = dataUrl.split(',')[1];

      return {
        content: [
          text(`请用手机扫码授权（账号：${session.account}，站点：${session.site}）\n\n${ascii}`),
          {
            type: 'image',
            data: base64,
            mimeType: 'image/png',
          },
          text(`链接（可在手机浏览器打开）：\n${url}\n\n二维码已保存：${session.qrPath || '(未落盘)'}`),
          text(
            `sessionId=${session.id}\n完成后状态会自动变为 authorized；也可调用 workbuddy_login_status 查询，或用 confirm=true 手动确认。`,
          ),
        ],
        structuredContent: {
          sessionId: session.id,
          account: session.account,
          url,
          status: session.status,
          qrPath: session.qrPath,
        },
      };
    },
  );

  server.registerTool(
    'workbuddy_login_status',
    {
      title: '查询扫码登录状态',
      description:
        '查询 workbuddy_login 的进度。默认返回最近一次登录会话；confirm=true 可手动标记为已完成（自动检测失灵时用）。',
      inputSchema: {
        sessionId: z.string().optional().describe('登录会话 id，不填则取最近一次'),
        confirm: z.boolean().optional().describe('用户确认已扫码完成，直接标记为已登录'),
        waitSeconds: z.number().int().min(0).max(120).optional().describe('最多等待多少秒，默认 3'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const session = args.sessionId ? getSession(args.sessionId) : latestSession();
      if (!session) {
        return { isError: true, content: [text('没有进行中的登录会话，请先调用 workbuddy_login。')] };
      }

      if (args.confirm) session.confirmManually();

      const waitMs = (args.waitSeconds ?? 3) * 1000;
      if (waitMs > 0 && !['authorized', 'failed', 'timeout', 'cancelled', 'already_logged_in'].includes(session.status)) {
        await Promise.race([session.wait(), new Promise((r) => setTimeout(r, waitMs))]);
      }

      const snap = session.snapshot();
      return {
        content: [
          text(`状态：${snap.status}\n账号：${snap.account}\n${snap.nextStep}`),
          text(jsonBlock(snap)),
        ],
        structuredContent: snap,
      };
    },
  );

  // ---------------------------------------------------------------- 账号
  server.registerTool(
    'workbuddy_accounts',
    {
      title: '管理 WorkBuddy 账号',
      description:
        '列出 / 切换默认 / 删除账号。每个账号对应一个独立的 WorkBuddy 配置目录，扫码登录后互不影响。',
      inputSchema: {
        action: z.enum(['list', 'use', 'remove']).default('list'),
        name: z.string().optional().describe('action=use/remove 时的账号名'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ action, name }) => {
      if (action === 'use') {
        if (!name) return { isError: true, content: [text('action=use 需要提供 name')] };
        try {
          const key = setDefaultAccount(name);
          return { content: [text(`默认账号已切换为 ${key}`)] };
        } catch (err) {
          return { isError: true, content: [text(err.message)] };
        }
      }
      if (action === 'remove') {
        if (!name) return { isError: true, content: [text('action=remove 需要提供 name')] };
        const ok = removeAccount(name);
        return { content: [text(ok ? `已删除账号 ${name}（含其配置目录）` : `账号 ${name} 不存在`)] };
      }

      const def = resolveAccountName();
      const rows = listAccounts().map((a) => ({
        name: a.name,
        default: a.name === def,
        lastLoginAt: a.lastLoginAt || null,
        site: a.site || null,
        auth: authLine(a.name),
        dir: a.profileDir,
      }));
      if (!rows.length) rows.push({ name: def, default: true, auth: authLine(def), dir: '(首次扫码后创建)' });

      return {
        content: [
          text(
            rows
              .map(
                (r) =>
                  `${r.default ? '* ' : '  '}${r.name} · ${r.auth}${r.lastLoginAt ? ` · 最近登录 ${r.lastLoginAt}` : ''}`,
              )
              .join('\n'),
          ),
          text(jsonBlock(rows)),
        ],
        structuredContent: { accounts: rows, default: def },
      };
    },
  );

  // ---------------------------------------------------------------- 号池
  server.registerTool(
    'workbuddy_pool',
    {
      title: '管理 WorkBuddy 号池',
      description: [
        '查看账号池的负载与额度，或调整调度：list=总览，strategy=切换策略（balanced/round-robin），',
        'enable/disable=启停某个号，weight=改权重，reset=清除冷却。',
        'workbuddy_task 默认从池里自动选号，通常不需要手动指定。',
      ].join(''),
      inputSchema: {
        action: z.enum(['list', 'strategy', 'enable', 'disable', 'weight', 'reset']).default('list'),
        name: z.string().optional().describe('action=enable/disable/weight/reset 时的账号名'),
        strategy: z.enum(['balanced', 'round-robin']).optional().describe('action=strategy 时的目标策略'),
        weight: z.number().int().min(1).max(20).optional().describe('action=weight 时的权重'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ action, name, strategy, weight }) => {
      try {
        if (action === 'strategy') {
          if (!strategy) return { isError: true, content: [text('action=strategy 需要提供 strategy')] };
          const v = setStrategy(strategy);
          return { content: [text(`调度策略已切换为 ${v}（${STRATEGIES[v]}）`)] };
        }
        if (['enable', 'disable', 'weight', 'reset'].includes(action)) {
          if (!name) return { isError: true, content: [text(`action=${action} 需要提供 name`)] };
          if (action === 'reset') {
            resetCooldown(name);
            return { content: [text(`已清除 ${name} 的冷却与失败计数`)] };
          }
          if (action === 'weight') {
            if (!weight) return { isError: true, content: [text('action=weight 需要提供 weight（1-20）')] };
            updateAccount(name, { weight });
            return { content: [text(`${name} 的权重已设为 ${weight}`)] };
          }
          updateAccount(name, { enabled: action === 'enable' });
          return { content: [text(`${name} 已${action === 'enable' ? '启用' : '停用'}`)] };
        }

        const view = poolView();
        const lines = view.accounts.map((a) => {
          const q = a.quota;
          const quotaText = q.limit
            ? `剩余 ${q.remaining} / ${q.limit} tokens`
            : `今日 ${q.used} tokens（未设预算）`;
          return `${a.available ? '●' : '○'} ${a.name} · ${a.statusText} · ×${a.weight} · 今日 ${a.today.req} 次 / 成功率 ${a.today.successRate === null ? '—' : Math.round(a.today.successRate * 100) + '%'} · ${quotaText}`;
        });
        return {
          content: [
            text(
              `策略：${view.strategy}（${view.strategyText}）\n可用 ${view.summary.available}/${view.summary.total} · 今日 ${view.summary.todayReq} 次 · ${view.summary.todayTokens} tokens\n\n` +
                (lines.join('\n') || '（池里还没有账号）'),
            ),
            text(jsonBlock(view)),
          ],
          structuredContent: view,
        };
      } catch (err) {
        return { isError: true, content: [text(err.message)] };
      }
    },
  );

  // ---------------------------------------------------------------- 诊断
  server.registerTool(
    'workbuddy_doctor',
    {
      title: '检查桥接环境',
      description: '检查 codebuddy 是否可用、账号登录状态、桥接目录与默认参数。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const cfg = loadConfig();
      const acc = resolveAccountName();
      const checks = [
        { item: 'codebuddy 命令', ok: cliExists(), detail: cliCommand() },
        { item: '桥接目录', ok: true, detail: BRIDGE_HOME },
        { item: `账号 ${acc}`, ok: quickAuthCheck(acc).loggedIn, detail: quickAuthCheck(acc).reason },
        { item: '默认模型', ok: true, detail: cfg.defaults.model || 'auto' },
      ];
      const sessions = listSessions();

      return {
        content: [
          text(checks.map((c) => `${c.ok ? '[ok]' : '[!!]'} ${c.item}: ${c.detail}`).join('\n')),
          text(`进行中的登录会话：${sessions.length}`),
          text(jsonBlock({ cfg, checks, sessions })),
        ],
        structuredContent: { checks },
      };
    },
  );

  return server;
}

function waitForUrl(session, timeoutMs) {
  if (session.url) return Promise.resolve(session.url);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.off('update', onUpdate);
      resolve(session.url || null);
    }, timeoutMs);
    const onUpdate = () => {
      if (session.url) {
        clearTimeout(timer);
        session.off('update', onUpdate);
        resolve(session.url);
      }
    };
    session.on('update', onUpdate);
    session.once('done', () => {
      clearTimeout(timer);
      session.off('update', onUpdate);
      resolve(session.url || null);
    });
  });
}

export async function runStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  info(`MCP stdio 已就绪（账号 ${resolveAccountName()}）`);
}

// 直接 `node src/server.js` 时以 stdio MCP 运行。
// 各客户端注册的就是这条命令，所以必须支持文件入口。
const isEntry =
  process.argv[1] &&
  pathToFileURL(fs.realpathSync(process.argv[1])).href ===
    pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;

if (isEntry) {
  runStdio().catch((err) => {
    error(`启动失败：${err.message}`);
    process.exit(1);
  });
}
