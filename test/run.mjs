#!/usr/bin/env node
/**
 * 零依赖测试：不联网、不真调用模型。
 * 用一个假的 codebuddy 脚本把登录 TUI 完整演一遍。
 *
 * 约定：测试数据里的模型名统一用 deepseek-v4-flash，不要写 hy4。
 * 真实验证也走 deepseek，旗舰模型只用于手动抽查。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 必须在 import 业务模块之前设置，paths.js 在模块加载时求值
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
process.env.WB_BRIDGE_HOME = path.join(TMP, 'bridge');
process.env.WB_COMMAND = path.join(ROOT, 'test', 'fake-codebuddy.mjs');
process.env.WB_DEBUG = '';

// 假 CLI 需要可执行位，否则 spawn/script 都会 EACCES
fs.chmodSync(process.env.WB_COMMAND, 0o755);

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ${C.green('✓')} ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`  ${C.red('✗')} ${name}`);
    console.log(C.dim(`    ${err.message}`));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

console.log(C.bold('\nworkbuddy-bridge 测试\n'));

console.log(C.dim('[1/7] 输出解析'));
const { extractUrls, stripAnsi } = await import('../src/ansi.js');

await test('OSC8 超链接优先取完整 URL', () => {
  const raw = '\x1b]8;;https://copilot.tencent.com/a?code=1\x1b\\\x1b[2mhttps://copilot.tencent.com/...\x1b[0m';
  assertEqual(extractUrls(raw)[0], 'https://copilot.tencent.com/a?code=1');
});

await test('折行的 URL 能拼回完整', () => {
  const raw = 'sign in:\nhttps://copilot.tencent.com/auth/cli?code=abc&sta\nte=xyz789\n\nWaiting for auth...';
  assertEqual(extractUrls(raw)[0], 'https://copilot.tencent.com/auth/cli?code=abc&state=xyz789');
});

await test('粘在 URL 尾巴上的 UI 文案被清掉', () => {
  const raw = 'https://copilot.tencent.com/a?code=1Waiting for auth';
  assertEqual(extractUrls(raw)[0], 'https://copilot.tencent.com/a?code=1');
});

await test('重复渲染的同一链接只留一个', () => {
  const raw = 'https://a.com/x?c=1\nhttps://a.com/x?c=1';
  assertEqual(extractUrls(raw).length, 1);
});

await test('stripAnsi 去掉颜色控制符', () => {
  assertEqual(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

await test('package-lock 元数据与 package.json 一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assertEqual(lock.version, pkg.version, 'lock 根版本');
  assertEqual(lock.packages[''].version, pkg.version, 'lock 包版本');
  assertEqual(lock.packages[''].license, pkg.license, 'lock 许可证');
});

await test('CLI 支持 --version', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const result = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'wb.js'), '--version'], { stdio: 'pipe' });
    let output = '';
    p.stdout.on('data', (d) => (output += d));
    p.on('close', (code) => resolve({ code, output: output.trim() }));
  });
  assertEqual(result.code, 0, '退出码');
  assertEqual(result.output, pkg.version, '版本输出');
});

console.log(C.dim('\n[2/7] 二维码'));
const { terminalQr, pngDataUrl } = await import('../src/qr.js');

await test('终端二维码包含半块字符', async () => {
  const qr = await terminalQr('https://copilot.tencent.com/auth?x=1');
  assert(/[▀▄█]/.test(qr), '没有渲染出方块字符');
  assert(qr.length > 200, '内容太短');
});

await test('PNG data URL 可解析', async () => {
  const url = await pngDataUrl('https://example.test/x');
  assert(url.startsWith('data:image/png;base64,'));
  assert(url.length > 500);
});

console.log(C.dim('\n[3/7] 账号管理'));
const accounts = await import('../src/accounts.js');
const runner = await import('../src/runner.js');

await test('创建账号并写入独立目录', () => {
  const acc = accounts.ensureAccount('alice', { site: 'cn' });
  assert(fs.existsSync(acc.profileDir), '目录未创建');
  assert(acc.profileDir.includes('alice'));
});

await test('默认账号可切换', () => {
  accounts.ensureAccount('bob');
  assertEqual(accounts.setDefaultAccount('bob'), 'bob');
  assertEqual(accounts.resolveAccountName(), 'bob');
});

await test('账号目录彼此隔离', () => {
  const a = accounts.ensureAccount('alice').profileDir;
  const b = accounts.ensureAccount('bob').profileDir;
  assert(a !== b, '两个账号指向了同一个目录');
});

await test('账号认证 HOME 彼此隔离', () => {
  const envA = accounts.accountEnv('alice');
  const envB = accounts.accountEnv('bob');
  assert(envA.HOME !== process.env.HOME, '账号仍在共享真实 HOME');
  assert(envA.HOME !== envB.HOME, '两个账号共享认证 HOME');
  assert(envA.CODEBUDDY_CONFIG_DIR !== envB.CODEBUDDY_CONFIG_DIR, '配置目录未隔离');
});

await test('local_storage 文件不算登录凭证', () => {
  const acc = accounts.ensureAccount('local-only');
  const legacy = path.join(acc.profileDir, 'local_storage');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'entry_fake.info'), '"internal"');
  assertEqual(runner.quickAuthCheck('local-only').loggedIn, false);
});

await test('删除账号会清理目录', () => {
  accounts.ensureAccount('temp');
  const dir = accounts.ensureAccount('temp').profileDir;
  accounts.removeAccount('temp');
  assert(!fs.existsSync(dir), '目录未删除');
});

console.log(C.dim('\n[4/7] 扫码登录（假 CLI）'));
const { startLogin } = await import('../src/login.js');

let session = null;

await test('能从 TUI 输出里拿到授权链接', async () => {
  session = await startLogin({ account: 'alice', site: 'cn', timeoutMs: 30000 });
  const url = await waitFor(() => session.url, 12000);
  assert(url, `没拿到 URL，状态=${session.status}`);
  assert(url.includes('copilot.tencent.com'), 'URL 不对：' + url);
  assertEqual(session.status, 'waiting_scan');
});

await test('能先接受登录工作区信任提示再拿到授权链接', async () => {
  process.env.WB_FAKE_TRUST_PROMPT = '1';
  try {
    const trusted = await startLogin({ account: 'trust-check', site: 'cn', timeoutMs: 30000 });
    const url = await waitFor(() => trusted.url, 12000);
    assert(url, `信任提示后没拿到 URL，状态=${trusted.status}`);
    assertEqual(trusted.sentTrust, true);
    trusted.cancel();
  } finally {
    delete process.env.WB_FAKE_TRUST_PROMPT;
  }
});

await test('新版 CLI 在主界面等待登录时，提交提示后能拿到授权链接', async () => {
  process.env.WB_FAKE_MAIN_THEN_LOGIN = '1';
  process.env.WB_FAKE_SPLIT_ENTER = '1';
  try {
    const mainScreen = await startLogin({ account: 'main-screen', site: 'cn', timeoutMs: 30000 });
    const url = await waitFor(() => mainScreen.url, 12000);
    assert(url, `主界面没有进入扫码流程，状态=${mainScreen.status}`);
    assertEqual(mainScreen.status, 'waiting_scan');
    mainScreen.cancel();
  } finally {
    delete process.env.WB_FAKE_MAIN_THEN_LOGIN;
    delete process.env.WB_FAKE_SPLIT_ENTER;
  }
});

await test('授权链接只写入 CodeBuddy 日志时仍能进入扫码流程', async () => {
  process.env.WB_FAKE_MAIN_THEN_LOGIN = '1';
  process.env.WB_FAKE_LOGIN_URL_LOG = '1';
  try {
    const logOnly = await startLogin({ account: 'log-only', site: 'cn', timeoutMs: 30000 });
    const url = await waitFor(() => logOnly.url, 12000);
    assert(url, `没有从账号日志中拿到授权链接，状态=${logOnly.status}`);
    assertEqual(logOnly.status, 'waiting_scan');
    logOnly.cancel();
  } finally {
    delete process.env.WB_FAKE_MAIN_THEN_LOGIN;
    delete process.env.WB_FAKE_LOGIN_URL_LOG;
  }
});

await test('首次登录会预置桥接工作区信任，避免 TUI 等待隐藏确认', async () => {
  const acc = accounts.ensureAccount('preseed-trust');
  const login = await startLogin({ account: acc.name, site: 'cn', timeoutMs: 30000 });
  const settingsPath = path.join(acc.profileDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const loginWorkspace = path.join(process.env.WB_BRIDGE_HOME, 'login-workspace');
  assert(
    settings.trustedDirectories?.includes(loginWorkspace),
    `settings.json 未信任 ${loginWorkspace}`,
  );
  login.cancel();
});

await test('二维码落盘', async () => {
  assert(session.qrPath && fs.existsSync(session.qrPath), '二维码文件不存在');
});

await test('confirm=true 可手动标记登录成功', () => {
  const snap = session.confirmManually();
  assertEqual(snap.status, 'authorized');
});

await test('登录成功后账号记录了时间', () => {
  const acc = accounts.getAccount('alice');
  assert(acc.lastLoginAt, '没有 lastLoginAt');
});

console.log(C.dim('\n[5/7] MCP 协议与安装'));

await test('MCP 握手 + tools/list', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'server.js')],
    env: { ...process.env },
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = [
    'workbuddy_accounts',
    'workbuddy_doctor',
    'workbuddy_login',
    'workbuddy_login_status',
    'workbuddy_pool',
    'workbuddy_task',
  ];
  for (const n of expected) assert(names.includes(n), `缺少工具 ${n}`);
  assert(tools.every((t) => t.description), '有工具缺少 description');

  const doctor = await client.callTool({ name: 'workbuddy_doctor', arguments: {} });
  assert(!doctor.isError, 'doctor 返回错误');
  assert(doctor.content?.[0]?.text?.includes('codebuddy'), 'doctor 输出不完整');

  await client.close();
});

await test('runTask 识别未登录（AUTH_REQUIRED）', async () => {
  const { runTask } = await import('../src/runner.js');
  const res = await runTask({ prompt: 'hi', account: 'alice', timeoutMs: 20000 });
  assertEqual(res.ok, false);
  assertEqual(res.code, 'AUTH_REQUIRED');
});

await test('install 能写入隔离 HOME 下的 Cursor 配置', async () => {
  const fakeHome = path.join(TMP, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });

  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'wb.js'), 'install', '--client', 'cursor'], {
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      stdio: 'pipe',
    });
    p.on('close', resolve);
  });
  assertEqual(code, 0, 'install 退出码非 0');

  const cfgPath = path.join(fakeHome, '.cursor', 'mcp.json');
  assert(fs.existsSync(cfgPath), '未生成 mcp.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert(cfg.mcpServers?.workbuddy?.args?.[0]?.endsWith('server.js'), '配置结构不对');
});

await test('install --print 输出通用 JSON', async () => {
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'wb.js'), 'install', '--print'], {
      env: { ...process.env },
      stdio: 'pipe',
    });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.on('close', () => resolve(buf));
    p.on('error', reject);
  });
  const cfg = JSON.parse(out);
  assert(cfg.mcpServers.workbuddy.args[0].endsWith('server.js'));
});

// ---------------------------------------------------------------- dsh
const dshHome = path.join(TMP, 'dshhome');
const dshProfile = path.join(dshHome, '.dsh', 'profiles', 'web');
const dshPatch = path.join(dshProfile, 'cordis.patch.yml');

function runInstall(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'wb.js'), 'install', ...args], {
      env: {
        ...process.env,
        HOME: dshHome,
        USERPROFILE: dshHome,
        WB_DSH_SKIP_PLUGIN_INSTALL: '1',
        ...extraEnv,
      },
      stdio: 'pipe',
    });
    p.on('close', resolve);
    p.on('error', () => resolve(-1));
  });
}

await test('dsh: 没有 profile 时给出可操作的报错', async () => {
  fs.mkdirSync(dshHome, { recursive: true });
  const code = await runInstall(['--client', 'dsh']);
  assertEqual(code, 0, '进程应正常退出');
  assert(!fs.existsSync(dshPatch), '不应该凭空创建 profile');
});

await test('dsh: 把 insert 块写进 cordis.patch.yml', async () => {
  fs.mkdirSync(dshProfile, { recursive: true });
  fs.writeFileSync(dshPatch, '# header\n[]\n');
  await runInstall(['--client', 'dsh']);

  const txt = fs.readFileSync(dshPatch, 'utf8');
  assert(txt.includes('# >>> workbuddy-bridge >>>'), '缺少起始标记');
  assert(txt.includes('- insert:'), '缺少 insert 语法');
  assert(txt.includes("name: '@deepseek-ai/dsh-mcp-client'"), '插件名不对');
  assert(txt.includes('serverName: workbuddy'), 'serverName 缺失');
  assert(txt.includes('transport: stdio'), 'transport 缺失');
  assert(!/^\[\]$/m.test(txt), '占位符 [] 应该被移除');
  assert(txt.includes('# header'), '原有注释应保留');
});

await test('dsh: 重复安装不产生重复条目', async () => {
  await runInstall(['--client', 'dsh']);
  await runInstall(['--client', 'dsh']);
  const txt = fs.readFileSync(dshPatch, 'utf8');
  const count = (txt.match(/id: mcp-workbuddy/g) || []).length;
  assertEqual(count, 1, 'mcp-workbuddy 条目数');
});

await test('dsh: 卸载后恢复成空数组模板', async () => {
  await runInstall(['--uninstall', '--client', 'dsh']);
  const txt = fs.readFileSync(dshPatch, 'utf8');
  assert(!txt.includes('mcp-workbuddy'), '条目未清除');
  assert(/^\[\]$/m.test(txt.trim().split('\n').pop()), '应恢复为 []');
  assert(txt.includes('# header'), '注释应保留');
});

await test('管理令牌会注入页面并用于后续 API 请求', async () => {
  const { startHttpServer } = await import('../src/http.js');
  process.env.WB_ADMIN_TOKEN = 'test-admin-token';
  const server = await startHttpServer({ port: 0, host: '127.0.0.1', mcp: false });
  try {
    const html = await fetch(`http://127.0.0.1:${server.port}/admin?token=test-admin-token`).then((r) => r.text());
    assert(html.includes('var TOKEN="test-admin-token"'), '管理页没有携带令牌');
    const res = await fetch(`http://127.0.0.1:${server.port}/api/pool`, {
      headers: { 'x-wb-token': 'test-admin-token' },
    });
    assertEqual(res.status, 200, '管理令牌应能访问号池 API');
  } finally {
    await server.close();
    delete process.env.WB_ADMIN_TOKEN;
  }
});

// ---------------------------------------------------------------- 号池
console.log(C.dim('\n[6/7] 号池调度'));

const { POOL_FILE } = await import('../src/paths.js');
const poolMod = await import('../src/pool.js');
const { dispatchTask } = await import('../src/dispatch.js');

// 清空前面用例留下的账号，让调度断言只针对本节的号
for (const a of accounts.listAccounts()) accounts.removeAccount(a.name);
fs.rmSync(POOL_FILE, { force: true });
process.env.WB_FAKE_PER_ACCOUNT = '1';

/** 造一个有隔离认证文件的账号：quickAuthCheck 会认为它「已登录」。 */
function credAccount(name) {
  const acc = accounts.ensureAccount(name);
  const dir = accounts.accountAuthDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth_fake.info'), JSON.stringify({
    account: { uid: `uid-${name}`, nickname: name },
    auth: {
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 3600000,
      refreshExpiresAt: Date.now() + 7200000,
    },
    accounts: [],
  }), { mode: 0o600 });
  return acc;
}

await test('未登录的号不参与调度', () => {
  accounts.ensureAccount('nologin');
  const pick = poolMod.pickAccount();
  assertEqual(pick.name, null, '不该选出未登录账号');
  assert(pick.reason.includes('nologin'), '原因里应点名该账号');
});

await test('成功任务会记账 token / 请求数', async () => {
  credAccount('good');
  const res = await dispatchTask({ prompt: 'hi', timeoutMs: 20000 });
  assert(res.ok, '任务应成功：' + res.error);
  assertEqual(res.account, 'good');

  const view = poolMod.poolView();
  const row = view.accounts.find((a) => a.name === 'good');
  assertEqual(row.today.req, 1, '今日请求数');
  assert(row.today.tokens > 1200, 'token 未累计：' + row.today.tokens);
  assertEqual(row.available, true);
});

await test('凭证在但 CLI 报未登录 → 自动换号', async () => {
  accounts.removeAccount('nologin');
  credAccount('badcli');
  poolMod.resetCooldown('good');

  const res = await dispatchTask({ prompt: 'hi', timeoutMs: 20000 });
  assert(res.ok, '应换到 good 号后成功');
  assertEqual(res.account, 'good');
  assert(res.attempts.length >= 2, '应记录了换号：' + JSON.stringify(res.attempts));

  const bad = poolMod.poolView().accounts.find((a) => a.name === 'badcli');
  assertEqual(bad.status, 'unauthorized', 'badcli 应被标记未登录');
});

await test('限流后进入冷却，不再被选中', async () => {
  accounts.removeAccount('good');
  accounts.removeAccount('badcli');
  credAccount('limitedcli');

  const res = await dispatchTask({ prompt: 'hi', timeoutMs: 20000 });
  assertEqual(res.ok, false);
  assertEqual(res.code, 'RATE_LIMITED');

  const entry = poolMod.loadPool().accounts.limitedcli;
  assert(entry.cooldownUntil > Date.now(), '应设置冷却时间');
  assertEqual(entry.status, 'cooling');

  const pick = poolMod.pickAccount();
  assertEqual(pick.name, null, '冷却中的号不该被选中');
  assert(pick.reason.includes('冷却'), '原因应说明冷却：' + pick.reason);
});

await test('重置冷却后重新可用', () => {
  poolMod.resetCooldown('limitedcli');
  assertEqual(poolMod.pickAccount().name, 'limitedcli');
});

await test('加权轮询按权重分配', () => {
  accounts.removeAccount('limitedcli');
  credAccount('w1');
  credAccount('w3');
  poolMod.updateAccount('w1', { weight: 1 });
  poolMod.updateAccount('w3', { weight: 3 });
  poolMod.setStrategy('round-robin');

  const hits = { w1: 0, w3: 0 };
  for (let i = 0; i < 8; i++) {
    const p = poolMod.pickAccount();
    hits[p.name] += 1;
  }
  // 权重 1:3，8 次应为 2:6
  assertEqual(hits.w1, 2, 'w1 命中次数');
  assertEqual(hits.w3, 6, 'w3 命中次数');
  poolMod.setStrategy('balanced');
});

await test('当日预算用尽后不再派活', () => {
  poolMod.updateAccount('w1', { budgetTokens: 10 });
  // 手动把 w1 的今日 token 顶到预算之上
  const pool = poolMod.loadPool();
  pool.accounts.w1.today.tokensIn = 999;
  poolMod.savePool(pool);

  const view = poolMod.poolView().accounts.find((a) => a.name === 'w1');
  assertEqual(view.quota.remaining, 0, '剩余额度');
  assertEqual(view.available, false, '额度用尽应不可用');

  poolMod.updateAccount('w1', { budgetTokens: 0 });
});

await test('poolView 的剩余额度与百分比正确', () => {
  poolMod.updateAccount('w3', { budgetTokens: 10000 });
  const pool = poolMod.loadPool();
  pool.accounts.w3.today.tokensIn = 4000;
  pool.accounts.w3.today.tokensOut = 1000;
  pool.accounts.w3.today.cacheRead = 3200;
  poolMod.savePool(pool);

  const view = poolMod.poolView().accounts.find((a) => a.name === 'w3');
  assertEqual(view.quota.used, 5000);
  assertEqual(view.quota.limit, 10000);
  assertEqual(view.quota.remaining, 5000);
  assertEqual(view.quota.percent, 50);
  assertEqual(view.today.cacheHitRate, 0.8, '缓存命中率应按输入 token 计算');
});

await test('全部不可用时返回可操作的错误', async () => {
  poolMod.updateAccount('w3', { enabled: false });
  poolMod.updateAccount('w1', { enabled: false });
  const res = await dispatchTask({ prompt: 'hi', timeoutMs: 10000 });
  assertEqual(res.ok, false);
  assertEqual(res.code, 'POOL_EMPTY');
  assert(res.error.includes('没有可用账号'), res.error);
});

await test('并发占位会保留到任务释放，达到上限后不再派给该账号', () => {
  for (const a of accounts.listAccounts()) accounts.removeAccount(a.name);
  credAccount('concurrency-a');
  credAccount('concurrency-b');
  poolMod.updateAccount('concurrency-a', { maxConcurrency: 1 });
  poolMod.updateAccount('concurrency-b', { maxConcurrency: 1 });

  poolMod.beginTask('concurrency-a');
  try {
    const view = poolMod.poolView();
    const a = view.accounts.find((row) => row.name === 'concurrency-a');
    assertEqual(a.inflight, 1, '运行中的任务数不应被 loadPool 重置');
    assertEqual(poolMod.pickAccount({ strategy: 'balanced' }).name, 'concurrency-b');

    poolMod.beginTask('concurrency-b');
    try {
      assertEqual(poolMod.pickAccount({ strategy: 'balanced' }).name, null);
    } finally {
      poolMod.endTask('concurrency-b', { ok: true, durationMs: 1 });
    }
  } finally {
    poolMod.endTask('concurrency-a', { ok: true, durationMs: 1 });
  }

  assertEqual(poolMod.pickAccount({ strategy: 'balanced' }).name, 'concurrency-a');
});

await test('调度抛出异常时也会释放并发占位', async () => {
  for (const a of accounts.listAccounts()) accounts.removeAccount(a.name);
  credAccount('throw-release');
  poolMod.updateAccount('throw-release', { maxConcurrency: 1 });

  let error = null;
  try {
    await dispatchTask({ prompt: '', account: 'throw-release' });
  } catch (err) {
    error = err;
  }
  assert(error, '空提示应抛出异常');

  const row = poolMod.poolView().accounts.find((item) => item.name === 'throw-release');
  assertEqual(row.inflight, 0, '异常返回后并发占位应归零');
  assertEqual(poolMod.pickAccount({ strategy: 'balanced' }).name, 'throw-release');
});

// ------------------------------------------------------------------
console.log(C.dim('\n[7/7] 统计与看板'));
const statsMod = await import('../src/stats.js');

await test('同小时的多次采样合并进一个桶', () => {
  const base = new Date(2026, 10, 4, 10, 15, 0, 0).getTime();
  const pool = { series: statsMod.emptySeries() };
  statsMod.recordSample(pool, { at: base, ok: true, tin: 100, tout: 20, cacheRead: 80, ms: 1000, account: 'a' }, base);
  statsMod.recordSample(pool, { at: base + 60000, ok: false, tin: 50, tout: 10, cacheRead: 40, ms: 2000, account: 'a' }, base + 60000);

  const h = pool.series.hours[statsMod.hourKey(base)];
  assertEqual(h.req, 2, '请求数');
  assertEqual(h.ok, 1, '成功数');
  assertEqual(h.fail, 1, '失败数');
  assertEqual(h.tin, 150, '输入 token');
  assertEqual(pool.series.days[statsMod.dayKey(base)].req, 2, '天桶同步累加');
});

await test('seriesPoints 给空档补零，时间轴连续', () => {
  const base = new Date(2026, 10, 4, 8, 0, 0, 0).getTime();
  const pool = { series: statsMod.emptySeries() };
  statsMod.recordSample(pool, { at: base, ok: true, tin: 10 }, base);
  statsMod.recordSample(pool, { at: base + 3 * statsMod.HOUR_MS, ok: true, tin: 30 }, base + 3 * statsMod.HOUR_MS);

  const pts = statsMod.seriesPoints(pool, base, base + 3 * statsMod.HOUR_MS + 1, 'hour');
  assertEqual(pts.length, 4, '4 个小时点');
  assertEqual(pts[0].tin, 10);
  assertEqual(pts[1].tin, 0, '空档补零');
  assertEqual(pts[3].tin, 30);
});

await test('区间窗口：今日从 0 点起，本周从周一起', () => {
  const now = new Date(2026, 10, 4, 15, 30, 0, 0).getTime();
  const d0 = new Date(2026, 10, 4, 0, 0, 0, 0).getTime();
  assertEqual(statsMod.rangeWindow('today', now).from, d0);
  assertEqual(statsMod.rangeWindow('3d', now).from, d0 - 2 * statsMod.DAY_MS);
  assertEqual(statsMod.rangeWindow('30d', now).from, d0 - 29 * statsMod.DAY_MS);
  assertEqual(statsMod.rangeWindow('week', now).from, d0 - 2 * statsMod.DAY_MS, '2026-11-04 是周三');
});

await test('周环比对齐到上一周同一时段', () => {
  const now = new Date(2026, 10, 4, 15, 30, 0, 0).getTime();
  const pool = { series: statsMod.emptySeries() };
  statsMod.recordSample(pool, { at: now - 7 * statsMod.DAY_MS, ok: true, tin: 100 }, now);
  statsMod.recordSample(pool, { at: new Date(2026, 9, 31, 12, 0).getTime(), ok: true, tin: 999 }, now);

  const stats = statsMod.buildStats(pool, 'week', { now });
  assertEqual(stats.prev.tokens, 100, '上一周同段不应混入周末其他时段');
});

await test('月环比对齐到上一月同一时段', () => {
  const now = new Date(2026, 10, 4, 15, 30, 0, 0).getTime();
  const pool = { series: statsMod.emptySeries() };
  statsMod.recordSample(pool, { at: new Date(2026, 9, 4, 15, 30).getTime(), ok: true, tin: 100 }, now);
  statsMod.recordSample(pool, { at: new Date(2026, 9, 20, 12, 0).getTime(), ok: true, tin: 999 }, now);

  const stats = statsMod.buildStats(pool, 'month', { now });
  assertEqual(stats.prev.tokens, 100, '上一月同段不应混入该月其他日期');
});

await test('缓存命中率 = cacheRead / 输入 token', () => {
  const base = new Date(2026, 10, 4, 10, 0, 0, 0).getTime();
  const pool = { series: statsMod.emptySeries() };
  statsMod.recordSample(pool, { at: base, ok: true, tin: 1000, tout: 100, cacheRead: 800, ms: 2000 }, base);
  const pts = statsMod.seriesPoints(pool, base, base + 1, 'hour');
  const sum = statsMod.summarize(pts, { usdCny: 7.2, pin: 0, pout: 0, pcache: 0 });
  assertEqual(sum.cacheHitRate, 0.8);
  assertEqual(sum.freshIn, 200, '新鲜输入 = 输入 - 缓存');
  assertEqual(sum.tokens, 1100);
});

await test('buildStats 只统计区间内事件，最新的在前', () => {
  const now = new Date(2026, 10, 4, 12, 0, 0, 0).getTime();
  const pool = { series: statsMod.emptySeries(), accounts: {} };
  statsMod.recordSample(pool, { at: now - 2 * 3600000, ok: true, tin: 100, account: 'a' }, now);
  statsMod.recordSample(pool, { at: now - 60 * 60000, ok: false, tin: 200, account: 'b' }, now);
  statsMod.recordSample(pool, { at: now - 5 * 86400000, ok: true, tin: 999, account: 'c' }, now);

  const d = statsMod.buildStats(pool, 'today', { now });
  assertEqual(d.totals.req, 2, '只算今天 2 次');
  assertEqual(d.totals.tokens, 300);
  assertEqual(d.events.length, 2, '区间外事件不进列表');
  assert(d.events[0].at > d.events[1].at, '最新在前');
});

await test('活跃账号数不受请求流展示上限影响', () => {
  const now = new Date(2026, 10, 4, 12, 0, 0, 0).getTime();
  const pool = { series: statsMod.emptySeries(), accounts: {} };
  for (let i = 0; i < 65; i++) {
    statsMod.recordSample(pool, { at: now - i * 1000, ok: true, tin: 1, account: `acc-${i}` }, now);
  }

  const stats = statsMod.buildStats(pool, 'today', { now });
  assertEqual(stats.events.length, 60, '请求流仍限制为 60 条');
  assertEqual(stats.totals.activeAccounts, 65, '活跃账号数应覆盖完整区间');
});

await test('endTask 不重复累加缓存 token', () => {
  poolMod.updateAccount('w3', { enabled: true, budgetTokens: 0 });
  const before = poolMod.loadPool().accounts.w3.total.tokensIn || 0;
  poolMod.endTask('w3', {
    ok: true,
    durationMs: 1000,
    meta: { usage: { input_tokens: 10000, output_tokens: 500, cache_read_input_tokens: 8000 }, model: 'deepseek-v4-flash' },
  });
  const after = poolMod.loadPool().accounts.w3;
  assertEqual(after.total.tokensIn - before, 10000, 'input 已含缓存，不再叠加');
  assert(after.total.cacheRead >= 8000, '缓存单独记录');
});

await test('模型名从 modelUsage 回退解析（真实 CLI 无顶层 model）', async () => {
  const { runTask } = await import('../src/runner.js');
  const prev = process.env.WB_FAKE_MODE;
  process.env.WB_FAKE_MODE = 'ok';
  try {
    const res = await runTask({ prompt: 'hi', account: 'w3', timeoutMs: 30000 });
    assert(res.ok, res.error || '调用失败');
    assertEqual(res.meta.model, 'deepseek-v4-flash', '应从 modelUsage 的 key 取模型名');
  } finally {
    if (prev === undefined) delete process.env.WB_FAKE_MODE;
    else process.env.WB_FAKE_MODE = prev;
  }
});

await test('热力图覆盖整年，空格补齐', () => {
  const now = new Date(2026, 10, 4, 12, 0, 0, 0).getTime();
  const pool = { series: statsMod.emptySeries() };
  statsMod.recordSample(pool, { at: now, ok: true, tin: 5000 }, now);
  const h = statsMod.buildHeatmap(pool, now);
  const cells = h.weeks.reduce((n, w) => n + w.filter(Boolean).length, 0);
  assert(cells >= 364 && cells <= 372, '格子数约 365，实际 ' + cells);
  assertEqual(h.activeDays, 1);
});

// ------------------------------------------------------------------
function waitFor(fn, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}

// 收尾
try {
  session?.cancel();
  session?.cleanup?.();
} catch {
  /* ignore */
}
setTimeout(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${C.bold('结果：')} ${C.green(pass + ' 通过')}${fail ? '，' + C.red(fail + ' 失败') : ''}\n`);
  if (fail) {
    for (const f of failures) console.log(C.red(`  ${f.name}\n  ${f.err.stack?.split('\n')[1] || ''}`));
  }
  process.exit(fail ? 1 : 0);
}, 300);
