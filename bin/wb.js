#!/usr/bin/env node
import { parseArgs } from 'node:util';
import process from 'node:process';
import os from 'node:os';
import { runStdio } from '../src/server.js';
import { startHttpServer } from '../src/http.js';
import { startLogin } from '../src/login.js';
import { cliExists, cliCommand, quickAuthCheck } from '../src/runner.js';
import { dispatchTask, probeAccount } from '../src/dispatch.js';
import { poolView, updateAccount, resetCooldown, setStrategy, STRATEGIES } from '../src/pool.js';
import { terminalQr } from '../src/qr.js';
import { detectClients, installTo, uninstallFrom, genericSnippet } from '../src/install.js';
import {
  listAccounts,
  resolveAccountName,
  setDefaultAccount,
  removeAccount,
} from '../src/accounts.js';
import { loadConfig, saveConfig, BRIDGE_HOME, ensureBridgeDirs } from '../src/paths.js';

const VERSION = '0.4.0';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function help() {
  console.log(`
${C.bold('workbuddy-bridge')} ${C.dim('v' + VERSION)} — WorkBuddy MCP 子 Agent + Anthropic Messages API

${C.bold('用法')}
  wb login  [--account <名字>] [--site cn|intl|enterprise|ioa] [--port 7666] [--no-qr]
      扫码登录。终端会直接打印二维码，同时起一个本地登录页方便手机打开。

  wb install [--client claude,cursor,...] [--print] [--uninstall]
      把 MCP server 注册进已安装的 Agent（Claude Code / Codex / DeepSeek Harness /
      Cursor / OpenCode / Windsurf / Gemini / Cline）。
      dsh 会自动安装版本对齐的 @deepseek-ai/dsh-mcp-client 并写入 cordis.patch.yml。
      --print 只打印通用 JSON 片段，不改任何文件。

  wb serve
      以 stdio MCP 方式运行（Agent 内部调用，一般不手动执行）。

  wb http [--port 7666] [--mcp] [--host 0.0.0.0]
      起 HTTP 服务：/login 登录页、/admin 管理页、/v1/messages Anthropic API。
      API 直接请求 WorkBuddy 上游并复用现有账号池，不启动 codebuddy CLI。
      加 --mcp 同时暴露 Streamable HTTP MCP。

  wb task "<任务>" [--cwd <目录>] [--model <模型>] [--account <名字>]
      直接在终端委托一个任务给 WorkBuddy。默认 --account auto，由号池挑负载最轻的号。

  wb pool [list]
      查看号池：每个号的状态、权重、今日请求 / token、剩余额度、平均耗时。

  wb pool strategy <balanced|round-robin>
      切换调度策略：balanced=按 token 用量加权均衡，round-robin=按权重轮询。

  wb pool enable|disable <名字>      启停某个号（停用后不再接任务）
  wb pool weight <名字> <1-20>       调整权重，越高分到的任务越多
  wb pool reset <名字>               清除冷却与失败计数
  wb pool test <名字>                发一条最小请求，确认这个号真的能用

  wb admin [--port 7667] [--host 0.0.0.0]
      打开可视化管理界面（账号卡片、额度、负载、扫码登录、Anthropic 开关和
      客户端 Key 都能在上面管理）。

  wb accounts [list|use <名字>|remove <名字>]
      管理多账号。

  wb export [文件.tgz] [--account <名字>]
      把某个账号已登录的凭证目录打包（含 token，注意保管）。

  wb import <文件.tgz> [--account <名字>]
      在本机导入凭证。服务器没有浏览器时，这是最省事的路子：
      本机 wb login 一次 → wb export → 拷到服务器 → wb import。

  wb doctor
      检查环境。

${C.bold('Anthropic API')}
  Base URL     http://127.0.0.1:7666
  POST         /v1/messages
  POST         /v1/messages/count_tokens   （保守估算，不用于精确计费）

  TypeScript / JavaScript：
    const client = new Anthropic({
      apiKey: '<在 /admin 生成的客户端 Key>',
      baseURL: 'http://127.0.0.1:7666',
    });
    await client.messages.create({
      model: 'deepseek-v4.1-flash',
      max_tokens: 256,
      messages: [{ role: 'user', content: '你好' }],
    });

  回环地址默认免 Key；非回环连接或 trustProxy=true 时必须提供 x-api-key
  或 Authorization: Bearer。功能开关、Key 生成 / 删除和超时摘要都在 /admin。

${C.bold('环境变量')}
  WB_COMMAND      codebuddy 可执行文件（仅 MCP / CLI 任务使用；API 不依赖它）
  WB_BRIDGE_HOME  桥接数据目录（默认 ~/.workbuddy-bridge）
  WB_DEBUG        1 打开调试日志
`);
}

async function cmdLogin(values) {
  const account = values.account || resolveAccountName();
  const port = values.port === undefined ? 7666 : Number(values.port);

  if (!cliExists()) {
    console.error(C.red(`找不到 ${cliCommand()}。先安装：npm i -g @tencent-ai/codebuddy-code`));
    process.exit(1);
  }

  let httpSrv = null;
  if (port > 0) {
    try {
      httpSrv = await startHttpServer({ port, host: '127.0.0.1', mcp: false });
    } catch (err) {
      console.error(C.yellow(`登录页启动失败（${err.message}），仅使用终端二维码`));
    }
  }

  console.log(C.dim(`\n正在启动 WorkBuddy 登录流程… 账号=${account} 站点=${values.site || 'cn'}`));
  const session = await startLogin({ account, site: values.site || 'cn' });

  // Wait for either a QR URL or a verified terminal state. An already-valid
  // account legitimately has no URL, so treating that as failure is wrong.
  const early = await new Promise((resolve) => {
    const terminal = new Set(['authorized', 'already_logged_in', 'failed', 'timeout', 'cancelled']);
    const finish = () => resolve(session.snapshot());
    if (session.url || terminal.has(session.status)) return finish();
    const t = setTimeout(finish, 50000);
    session.on('update', (snap) => {
      if (snap.url || terminal.has(snap.status)) {
        clearTimeout(t);
        finish();
      }
    });
    session.once('done', () => {
      clearTimeout(t);
      finish();
    });
  });
  const url = early.url || session.url;

  if (!url && (early.status === 'authorized' || early.status === 'already_logged_in')) {
    console.log(C.green(`✓ 账号 "${early.account}" 已登录，无需重复扫码`));
    console.log(C.dim(`  凭证目录：${BRIDGE_HOME}/profiles/${early.account}`));
    httpSrv?.close();
    process.exit(0);
  }

  if (!url) {
    console.error(C.red(`\n没拿到登录链接（状态：${session.status}）`));
    if (session.error) console.error(C.dim(session.error));
    console.error(C.dim('可以试试：在本机终端直接运行 codebuddy ，按提示手动登录后再执行 wb doctor'));
    httpSrv?.close();
    process.exit(1);
  }

  if (values.qr !== false) {
    console.log('\n' + (await terminalQr(url)));
  }
  console.log(C.cyan('\n链接：') + url);
  if (httpSrv) console.log(C.dim(`手机同网段可打开：http://<本机IP>:${httpSrv.port}/login`));
  console.log(C.dim(`\n二维码已保存：${session.qrPath}`));
  console.log(C.yellow('\n等待扫码授权…（Ctrl+C 取消）\n'));

  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const started = Date.now();
  const timer = setInterval(() => {
    const sec = Math.round((Date.now() - started) / 1000);
    process.stdout.write(`\r${spinner[i++ % spinner.length]} ${session.status} · ${sec}s   `);
  }, 120);

  const snap = await session.wait();
  clearInterval(timer);
  process.stdout.write('\r' + ' '.repeat(50) + '\r');

  if (snap.status === 'authorized' || snap.status === 'already_logged_in') {
    console.log(C.green(`✓ 登录成功，账号 "${snap.account}" 已就绪`));
    console.log(C.dim(`  凭证目录：${BRIDGE_HOME}/profiles/${snap.account}`));
    console.log(C.dim('  下一步：wb install  —— 把它注册进你的编程 Agent'));
  } else {
    console.log(C.red(`✗ 登录未完成：${snap.status}`));
    if (snap.error) console.log(C.dim(snap.error));
  }

  httpSrv?.close();
  process.exit(snap.status === 'authorized' || snap.status === 'already_logged_in' ? 0 : 1);
}

async function cmdInstall(values) {
  const clients = values.client
    ? String(values.client)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  if (values.print) {
    console.log(genericSnippet());
    return;
  }

  if (values.uninstall) {
    const res = uninstallFrom(clients);
    for (const r of res) console.log(`${r.ok ? C.green('✓') : C.red('✗')} ${r.id} ${r.file ? C.dim(r.file) : ''}`);
    return;
  }

  const detected = detectClients();
  console.log(C.bold('\n检测到的 MCP 客户端：'));
  for (const c of detected) {
    console.log(`  ${c.detected ? C.green('●') : C.dim('○')} ${c.label.padEnd(14)} ${C.dim(c.file)}`);
  }

  const res = installTo(clients);
  console.log(C.bold('\n写入结果：'));
  for (const r of res) {
    console.log(`  ${r.ok ? C.green('✓') : C.red('✗')} ${r.label.padEnd(16)} ${C.dim(r.file || r.error)}`);
    if (r.note) console.log(C.yellow(`     ! ${r.note}`));
  }
  if (!res.length) {
    console.log(C.yellow('  没有检测到可写入的客户端。用 wb install --print 拿通用 JSON 片段，粘到你的客户端配置里。'));
  }
  console.log(C.dim('\n重启对应 Agent 后，工具列表里会出现 workbuddy_task / workbuddy_login。'));
}

async function cmdServe() {
  await runStdio();
}

async function cmdHttp(values) {
  ensureBridgeDirs();
  const port = Number(values.port || 7666);
  const host = values.host || '127.0.0.1';
  await startHttpServer({ port, host, mcp: !!values.mcp });
  console.log(C.bold(`\n管理界面：${C.cyan(`http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/admin`)}`));
  console.log(C.dim('Ctrl+C 退出'));
}

async function cmdTask(values, positionals) {
  const prompt = positionals.join(' ').trim();
  if (!prompt) {
    console.error('用法：wb task "让 WorkBuddy 做的事"');
    process.exit(1);
  }
  const res = await dispatchTask({
    prompt,
    cwd: values.cwd,
    model: values.model,
    account: values.account || 'auto',
    timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined,
  });
  if (!res.ok) {
    console.error(C.red(`失败：${res.error}`));
    if (res.hint) console.error(C.dim(res.hint));
    process.exit(1);
  }
  console.log(res.text);
  const tried = res.attempts?.length > 1 ? ` · 换号 ${res.attempts.map((a) => a.account).join('→')}` : '';
  console.error(C.dim(`\n(${(res.durationMs / 1000).toFixed(1)}s · 账号 ${res.account}${tried} · 目录 ${res.cwd})`));
}

function num(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

function ms(v) {
  if (!v) return '—';
  return v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`;
}

async function cmdPool(values, positionals) {
  const action = positionals[0] || 'list';
  const name = positionals[1];

  if (action === 'strategy') {
    const v = name || values.strategy;
    if (!v) throw new Error(`用法：wb pool strategy <${Object.keys(STRATEGIES).join('|')}>`);
    console.log(`策略 → ${setStrategy(v)}（${STRATEGIES[v]}）`);
    return;
  }
  if (action === 'enable' || action === 'disable') {
    if (!name) throw new Error(`用法：wb pool ${action} <名字>`);
    updateAccount(name, { enabled: action === 'enable' });
    console.log(`${name} 已${action === 'enable' ? '启用' : '停用'}`);
    return;
  }
  if (action === 'weight') {
    const w = Number(positionals[2] || values.weight);
    if (!name || !Number.isFinite(w)) throw new Error('用法：wb pool weight <名字> <1-20>');
    updateAccount(name, { weight: Math.max(1, Math.min(20, Math.round(w))) });
    console.log(`${name} 权重 → ${Math.max(1, Math.min(20, Math.round(w)))}`);
    return;
  }
  if (action === 'reset') {
    if (!name) throw new Error('用法：wb pool reset <名字>');
    resetCooldown(name);
    console.log(`${name} 的冷却已清除`);
    return;
  }
  if (action === 'test') {
    if (!name) throw new Error('用法：wb pool test <名字>');
    process.stdout.write(C.dim(`正在测试 ${name}…`));
    const r = await probeAccount(name);
    process.stdout.write('\r' + ' '.repeat(24) + '\r');
    console.log(
      r.ok
        ? `${C.green('✓')} ${name} 可用 · ${(r.durationMs / 1000).toFixed(1)}s · 「${r.text.trim()}」`
        : `${C.red('✗')} ${name} 失败：${r.error}`,
    );
    return;
  }

  const view = poolView();
  if (!view.accounts.length) {
    console.log('号池里还没有账号。执行 wb login --account <名字> 扫码添加。');
    return;
  }

  console.log(C.bold(`\n号池 · 策略 ${view.strategy}（${view.strategyText}）`));
  console.log(
    C.dim(
      `可用 ${view.summary.available}/${view.summary.total} · 今日 ${view.summary.todayReq} 次 · ` +
        `${num(view.summary.todayTokens)} tokens · 成功率 ${
          view.summary.successRate === null ? '—' : Math.round(view.summary.successRate * 100) + '%'
        }\n`,
    ),
  );

  const head = ['状态', '账号', '权重', '今日', '成功率', 'Token', '额度', '均值'];
  const rows = view.accounts.map((a) => {
    const q = a.quota;
    return [
      a.available ? C.green('● 可用') : C.yellow('○ ' + a.statusText),
      a.name + (a.isDefault ? C.dim(' *') : ''),
      '×' + a.weight,
      String(a.today.req),
      a.today.successRate === null ? '—' : Math.round(a.today.successRate * 100) + '%',
      num(q.used),
      q.limit ? `${num(q.remaining)}/${num(q.limit)}` : C.dim('未设预算'),
      ms(a.today.avgMs),
    ];
  });

  const widths = head.map((h, i) => Math.max(strWidth(h), ...rows.map((r) => strWidth(r[i]))));
  const line = (cols, dim) =>
    cols
      .map((c, i) => (dim ? c : c) + ' '.repeat(Math.max(0, widths[i] - strWidth(c) + 2)))
      .join('')
      .replace(/\s+$/, '');
  console.log('  ' + C.dim(line(head, true)));
  for (const r of rows) console.log('  ' + line(r));
  console.log(C.dim('\n  可视化界面：wb admin    额度说明见 README'));
  console.log('');
}

/** 中日韩字符占两个终端宽度，不处理会让表格错位。 */
function strWidth(s) {
  let w = 0;
  for (const ch of String(s).replace(/\x1b\[[0-9;]*m/g, '')) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w;
}

async function cmdAdmin(values) {
  ensureBridgeDirs();
  const port = Number(values.port || 7667);
  const host = values.host || '127.0.0.1';
  await startHttpServer({ port, host, mcp: false });
  console.log(C.bold(`\n管理界面：${C.cyan(`http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/admin`)}`));
  if (host === '0.0.0.0') {
    console.log(C.yellow('已监听所有网卡，建议同时设置 WB_ADMIN_TOKEN 环境变量，避免同网段任何人改动账号。'));
  }
  console.log(C.dim('Ctrl+C 退出\n'));
}

async function cmdAccounts(values, positionals) {
  const action = positionals[0] || 'list';
  const name = positionals[1];

  if (action === 'use') {
    if (!name) throw new Error('用法：wb accounts use <名字>');
    console.log(`默认账号 → ${setDefaultAccount(name)}`);
    return;
  }
  if (action === 'remove') {
    if (!name) throw new Error('用法：wb accounts remove <名字>');
    console.log(removeAccount(name) ? `已删除 ${name}` : `账号 ${name} 不存在`);
    return;
  }

  const def = resolveAccountName();
  const rows = listAccounts();
  if (!rows.length) {
    console.log(`还没有账号。执行 wb login 即可创建默认账号 "${def}"。`);
    return;
  }
  console.log(C.bold('\n账号：'));
  for (const a of rows) {
    const chk = quickAuthCheck(a.name);
    console.log(
      `  ${a.name === def ? C.green('*') : ' '} ${a.name.padEnd(16)} ` +
        `${chk.loggedIn ? C.green('已登录') : C.yellow('未登录')}  ${C.dim(a.profileDir)}`,
    );
  }
  console.log('');
}

async function cmdExport(values, positionals) {
  const { exportAccount } = await import('../src/transfer.js');
  const res = await exportAccount(values.account, positionals[0]);
  console.log(C.green(`✓ 已导出账号 "${res.account}" → ${res.file}`));
  console.log(C.dim(`  ${(res.bytes / 1024).toFixed(1)} KB · 权限已设为 600`));
  console.log(C.yellow('  该文件含登录凭证，等同于账号权限，别传公网、别进 git。'));
}

async function cmdImport(values, positionals) {
  const { importAccount } = await import('../src/transfer.js');
  if (!positionals[0]) throw new Error('用法：wb import <文件.tgz> [--account <名字>]');
  const res = await importAccount(positionals[0], values.account);
  console.log(C.green(`✓ 已导入到账号 "${res.account}"`));
  console.log(C.dim(`  ${res.dir}`));
  console.log(C.dim('  用 wb doctor 确认登录状态。'));
}

async function cmdDoctor() {
  const cfg = loadConfig();
  const acc = resolveAccountName();
  const chk = quickAuthCheck(acc);
  const hasCli = cliExists();
  const api = cfg.apiCompat || {};
  const anthropicOn = Boolean(api.enabled && (api.anthropicEnabled ?? api.anthropic));
  const apiAuth = api.requireApiKey
    ? '所有连接强制 Key'
    : '回环免 Key · 远程强制 Key';
  const rows = [
    ['Node.js', process.version, true],
    ['平台', `${process.platform}/${process.arch}`, true],
    ['codebuddy', hasCli ? cliCommand() : '未找到（仅影响 MCP / CLI 任务）', hasCli],
    ['桥接目录', BRIDGE_HOME, true],
    ['默认账号', `${acc} · ${chk.loggedIn ? '已登录' : '未登录（' + chk.reason + '）'}`, chk.loggedIn],
    ['默认模型', cfg.defaults.model || 'auto', true],
    ['权限模式', cfg.defaults.skipPermissions ? '自动授权(-y)' : '交互确认', true],
    ['登录页端口', String(cfg.loginPagePort), true],
    ['Anthropic API', anthropicOn ? '已开启 · /v1/messages' : '已关闭', anthropicOn],
    ['API 鉴权', apiAuth, true],
  ];
  console.log(C.bold('\n环境检查\n'));
  for (const [k, v, ok] of rows) {
    console.log(`  ${ok ? C.green('✓') : C.yellow('!')} ${String(k).padEnd(12)} ${v}`);
  }
  console.log(C.bold('\n已安装客户端\n'));
  for (const c of detectClients()) {
    if (c.detected) console.log(`  ${C.green('●')} ${c.label.padEnd(14)} ${C.dim(c.file)}`);
  }
  console.log('');
  if (!hasCli) {
    console.log(C.yellow('未找到 codebuddy：MCP / CLI 任务不可用；Anthropic API 直接走上游，不依赖该命令。\n'));
  }
  if (!chk.loggedIn) {
    console.log(C.yellow('账号未登录 → 执行 wb login 扫码，或在 Agent 里调用 workbuddy_login。\n'));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  const common = {
    account: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    model: { type: 'string' },
    cwd: { type: 'string' },
    site: { type: 'string' },
    client: { type: 'string' },
    timeout: { type: 'string' },
    strategy: { type: 'string' },
    weight: { type: 'string' },
    qr: { type: 'boolean' },
    mcp: { type: 'boolean' },
    print: { type: 'boolean' },
    uninstall: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  };

  let values = {};
  let positionals = [];
  // parseArgs 不支持 --no-xxx 取反写法，这里手工剥掉
  let noQr = false;
  const cleaned = argv.slice(1).filter((a) => {
    if (a === '--no-qr') {
      noQr = true;
      return false;
    }
    return true;
  });

  if (cmd && !['serve', 'doctor'].includes(cmd)) {
    const parsed = parseArgs({ args: cleaned, allowPositionals: true, options: common });
    values = parsed.values;
    positionals = parsed.positionals;
  }
  if (noQr) values.qr = false;

  if (values.version || cmd === '-v' || cmd === '--version') {
    console.log(VERSION);
    return;
  }

  switch (cmd) {
    case 'login':
      return cmdLogin(values);
    case 'install':
      return cmdInstall(values);
    case 'serve':
      return cmdServe();
    case 'http':
      return cmdHttp(values);
    case 'task':
      return cmdTask(values, positionals);
    case 'accounts':
      return cmdAccounts(values, positionals);
    case 'pool':
      return cmdPool(values, positionals);
    case 'admin':
      return cmdAdmin(values);
    case 'export':
      return cmdExport(values, positionals);
    case 'import':
      return cmdImport(values, positionals);
    case 'doctor':
      return cmdDoctor();
    case 'help':
    case undefined:
    case '-h':
    case '--help':
      return help();
    default:
      console.error(C.red(`未知命令：${cmd}`));
      help();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(C.red(`出错：${err.message}`));
  if (process.env.WB_DEBUG) console.error(err.stack);
  process.exit(1);
});
