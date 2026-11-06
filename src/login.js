import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawnPty } from './pty.js';
import { extractUrls, readable, TailBuffer } from './ansi.js';
import { accountEnv, ensureAccount, resolveAccountName } from './accounts.js';
import { loginLog, debug, warn } from './log.js';
import { pngFile } from './qr.js';
import { BRIDGE_HOME, ensureDir, readJson, writeJson } from './paths.js';
import { quickAuthCheck, runTask } from './runner.js';
import { noteAuth } from './pool.js';

/**
 * 扫码登录。
 *
 * codebuddy 没有 login 子命令，登录界面是启动时渲染的 Ink TUI。
 * 所以这里用伪终端把它跑起来，代替人做三件事：
 *   1. 在「Select login method」里按上下键选站点并回车
 *   2. 从 TUI 输出里把授权链接抠出来（OSC8 / 折行拼接 / 宽松匹配三层）
 *   3. 盯着它什么时候拿到凭证
 *
 * 拿到链接之后，手机扫码或直接点开都能授权；
 * 授权态由 CLI 自己轮询感知，因此不依赖手机上能否回调到本机端口。
 */

const SITES = [
  { key: 'cn', label: 'Chinese Site', index: 0 },
  { key: 'intl', label: 'International Site', index: 1 },
  { key: 'enterprise', label: 'Enterprise Domain', index: 2 },
  { key: 'ioa', label: 'iOA', index: 3 },
];

const LOGIN_UI_RE = /Select login method|Log in via (Chinese|International|Enterprise)/i;
const TRUST_UI_RE = /Do you trust the files in this folder\?|Trust folder only|Trust parent folder/i;
const WAITING_RE = /Waiting for auth|Browser didn'?t open/i;
const MAIN_UI_RE =
  /for shortcuts|esc to interrupt|Welcome to CodeBuddy|Type your message|Tips for getting started|Recent activity/i;
const IDLE_PROBE_MS = 45000;

/** 登录工作区由桥接自己创建；提前持久化信任，避免新版 TUI 卡在隐藏确认。 */
function trustLoginWorkspace(configDir, workspace) {
  const settingsFile = path.join(configDir, 'settings.json');
  const settings = readJson(settingsFile, {});
  const trusted = Array.isArray(settings.trustedDirectories) ? settings.trustedDirectories : [];
  if (trusted.includes(workspace)) return;
  settings.trustedDirectories = [...trusted, workspace];
  writeJson(settingsFile, settings);
}

function listLoginLogFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /^login-workspace__.*\.log$/.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  return files;
}

let counter = 0;

export class LoginSession extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.id = `login-${Date.now()}-${++counter}`;
    this.account = resolveAccountName(opts.account);
    this.site = opts.site || 'cn';
    this.timeoutMs = opts.timeoutMs || 300000;
    this.status = 'starting';
    this.url = null;
    this.qrPath = null;
    this.error = null;
    this.createdAt = Date.now();
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.pty = null;
    this.tail = new TailBuffer(30000);
    this.sentKeys = false;
    this.sentTrust = false;
    this.sentLoginPrompt = false;
    this.sessionChecked = false;
    this.configDir = null;
    this.logTimer = null;
    this.probeTimer = null;
    this.deadlineTimer = null;
    this.probeBusy = false;
  }

  snapshot() {
    return {
      id: this.id,
      account: this.account,
      site: this.site,
      status: this.status,
      url: this.url,
      qrPath: this.qrPath,
      error: this.error,
      elapsedMs: (this.finishedAt || Date.now()) - this.startedAt,
      nextStep: this.nextStep(),
    };
  }

  nextStep() {
    switch (this.status) {
      case 'waiting_scan':
        return '用手机扫码（或打开 url）完成授权，完成后状态会自动变成 authorized';
      case 'authorized':
        return '已完成，可以直接调用 workbuddy_task';
      case 'already_logged_in':
        return '该账号目录已有凭证，无需重复登录';
      case 'failed':
        return '查看 error；如自动检测失灵，重新 login 后可用 confirm=true 手动确认';
      default:
        return '等待 codebuddy 渲染登录界面…';
    }
  }

  setStatus(status, patch = {}) {
    this.status = status;
    Object.assign(this, patch);
    loginLog(`[${this.id}] status=${status}${this.url ? ' url-set' : ''}${this.error ? ' err=' + this.error : ''}`);
    this.emit('update', this.snapshot());
    if (['authorized', 'failed', 'timeout', 'cancelled', 'already_logged_in'].includes(status)) {
      this.finishedAt = Date.now();
      this.cleanup();
      this.emit('done', this.snapshot());
    }
  }

  async start() {
    ensureAccount(this.account);
    const env = accountEnv(this.account);
    this.configDir = env.CODEBUDDY_CONFIG_DIR;
    loginLog(`[${this.id}] start account=${this.account} site=${this.site} configDir=${env.CODEBUDDY_CONFIG_DIR}`);

    const loginCwd = ensureDir(`${BRIDGE_HOME}/login-workspace`);
    trustLoginWorkspace(env.CODEBUDDY_CONFIG_DIR, loginCwd);
    const pty = await spawnPty(process.env.WB_COMMAND || 'codebuddy', [], {
      env,
      cwd: loginCwd,
      cols: 110,
      rows: 42,
    });

    if (!pty) {
      this.setStatus('failed', {
        error:
          '当前平台无法创建伪终端。Windows 请先安装 node-pty（npm i -g node-pty），或直接在本机终端执行 codebuddy 手动登录。',
      });
      return this;
    }

    this.pty = pty;
    loginLog(`[${this.id}] pty mode=${pty.mode}`);
    this.startAuthLogWatch();

    pty.child.onData
      ? pty.child.onData((d) => this.onData(d))
      : pty.child.stdout?.on('data', (b) => this.onData(b.toString('utf8')));

    if (pty.child.onExit) {
      pty.child.onExit(({ exitCode }) => this.onExit(exitCode));
    } else {
      pty.child.on('close', (code) => this.onExit(code));
    }

    this.deadlineTimer = setTimeout(() => {
      if (['authorized', 'already_logged_in'].includes(this.status)) return;
      this.setStatus('timeout', {
        error: `登录超时（${Math.round(this.timeoutMs / 1000)}s）。二维码可能已过期，重新执行即可。`,
      });
    }, this.timeoutMs);

    // If the TUI does not reach a login screen, verify with the CLI instead of
    // treating the absence of UI as proof that credentials are valid.
    this.idleTimer = setTimeout(() => {
      if (this.status !== 'starting' || this.url) return;
      this.setStatus('probing_session');
      this.verifyByProbe().then((ok) => {
        if (!ok && this.status === 'probing_session') {
          this.setStatus('failed', {
            error:
              '没有检测到登录界面，真实认证探测也未通过。\n' +
              `最近输出：${this.tail.text.slice(-800) || '(无输出)'}`,
          });
        }
      });
    }, IDLE_PROBE_MS);

    return this;
  }

  onData(chunk) {
    const text = this.tail.push(chunk);
    const plain = readable(text);

    // 1) Accept the workspace trust prompt in the bridge-owned login directory.
    if (!this.sentTrust && TRUST_UI_RE.test(plain)) {
      this.sentTrust = true;
      this.status = 'trusting_folder';
      loginLog(`[${this.id}] accept login workspace trust prompt`);
      setTimeout(() => this.pty?.write('\r'), 300);
    }

    // 2) 选择登录站点（只按一次）
    if (!this.sentKeys && LOGIN_UI_RE.test(plain)) {
      this.sentKeys = true;
      this.status = 'choosing_method';
      const site = SITES.find((s) => s.key === this.site) || SITES[0];
      const downs = '\u001b[B'.repeat(site.index);
      loginLog(`[${this.id}] select method index=${site.index} (${site.label})`);
      setTimeout(() => {
        if (site.index > 0) this.pty?.write(downs);
        this.pty?.write('\r');
      }, 500);
    }

    // 3) 抓授权链接
    if (!this.url) {
      const urls = extractUrls(text);
      if (urls.length && urls[0].length > 30) {
        this.acceptAuthUrl(urls[0]);
      }
    }

    // 4) 新版 CLI 未登录时也会先渲染主界面，提交一条消息才会触发登录。
    if (['starting', 'trusting_folder'].includes(this.status) && MAIN_UI_RE.test(plain) && !this.url) {
      clearTimeout(this.idleTimer);
      if (!quickAuthCheck(this.account).loggedIn) {
        if (!this.sentLoginPrompt) {
          this.sentLoginPrompt = true;
          loginLog(`[${this.id}] main UI without credentials; submitting prompt to start login`);
          // 分两次写入更接近真实键盘输入；新版 Ink 会忽略与正文同包的 Enter。
          setTimeout(() => this.pty?.write('hi'), 300);
          setTimeout(() => this.pty?.write('\r'), 800);
          setTimeout(() => {
            if (this.url || this.status !== 'starting') return;
            loginLog(`[${this.id}] retry Enter while waiting for auth screen`);
            this.pty?.write('\r');
          }, 3500);
        }
      } else if (!this.sessionChecked) {
        this.sessionChecked = true;
        this.setStatus('probing_session');
        this.verifyByProbe().then((ok) => {
          if (!ok && this.status === 'probing_session') {
            this.setStatus('failed', {
              error:
                'CLI 已进入主界面，但认证探测未通过。\n' +
                '可能是登录状态已过期；重新执行 wb login 扫码登录。',
            });
          }
        });
      }
    }

    this.emit('output', chunk);
  }

  /** 新版 CLI 可能只把授权链接写进日志，不画到终端里。 */
  startAuthLogWatch() {
    const root = path.join(this.configDir, 'logs');
    const offsets = new Map();
    for (const file of listLoginLogFiles(root)) {
      try {
        offsets.set(file, fs.statSync(file).size);
      } catch {
        /* 文件刚好被轮转时忽略 */
      }
    }

    const tick = () => {
      if (this.url || ['authorized', 'failed', 'timeout', 'cancelled', 'already_logged_in'].includes(this.status)) {
        return;
      }

      for (const file of listLoginLogFiles(root)) {
        try {
          const size = fs.statSync(file).size;
          const offset = offsets.get(file) ?? 0;
          if (size <= offset) {
            offsets.set(file, size);
            continue;
          }
          const buffer = Buffer.alloc(size - offset);
          const fd = fs.openSync(file, 'r');
          try {
            fs.readSync(fd, buffer, 0, buffer.length, offset);
          } finally {
            fs.closeSync(fd);
          }

          // 只消费完整行，避免把正在追加的 URL 截成半截。
          const newline = buffer.lastIndexOf(0x0a);
          if (newline < 0) continue;
          const chunk = buffer.subarray(0, newline + 1);
          offsets.set(file, offset + chunk.length);
          const matches = [...chunk.toString('utf8').matchAll(/Opening auth URL:\s*(https?:\/\/\S+)/g)];
          if (matches.length) {
            loginLog(`[${this.id}] auth URL captured from account log`);
            this.acceptAuthUrl(matches.at(-1)[1].replace(/[\r,;]+$/, ''));
            return;
          }
        } catch {
          /* 日志读取失败时继续等终端输出 */
        }
      }
      this.logTimer = setTimeout(tick, 500);
      this.logTimer.unref?.();
    };
    tick();
  }

  acceptAuthUrl(url) {
    if (this.url || !url) return;
    clearTimeout(this.logTimer);
    this.logTimer = null;
    this.url = url;
    // 二维码落盘，方便 MCP 客户端直接把图片给用户看
    try {
      const dir = ensureDir(`${BRIDGE_HOME}/login`);
      this.qrPath = `${dir}/${this.id}.png`;
      pngFile(this.qrPath, url).catch(() => {});
    } catch {
      /* 二维码失败不影响文本链接 */
    }
    this.setStatus('waiting_scan');
    this.startProbing();
  }

  onExit(code) {
    loginLog(`[${this.id}] pty exit code=${code}`);
    if (this.status === 'authorized') return;

    if (this.url) {
      // TUI 退出通常意味着授权已经完成（登录成功后 CLI 会离开登录页）
      this.verifyByProbe();
      return;
    }

    if (this.status === 'starting' || this.status === 'choosing_method') {
      // 一点输出都没有就退出：可能本来就已登录，也可能被强制 headless 了
      if (code === 0 && this.tail.text.trim().length < 50) {
        this.verifyByProbe().then((ok) => {
          if (ok) return;
          this.setStatus('failed', {
            error:
              'codebuddy 启动后立刻退出，没有渲染登录界面。\n' +
              '常见原因：当前环境被强制 headless（如 CI/容器），或该账号其实已登录。\n' +
              '建议：在本地终端执行一次 codebuddy 完成登录，再用 wb export / wb import 把凭证搬到这台机器。',
          });
        });
        return;
      }

      this.setStatus('failed', {
        error: `codebuddy 在渲染登录界面之前就退出了（exit=${code}）。日志：${this.tail.text.slice(-600)}`,
      });
    }
  }

  startProbing() {
    clearInterval(this.probeTimer);
    this.probeTimer = setInterval(() => {
      if (['authorized', 'failed', 'timeout', 'cancelled'].includes(this.status)) return;
      this.verifyByProbe();
    }, 6000);
    this.probeTimer.unref?.();
  }

  /** 用一次极短的 -p 调用来确认凭证真的可用了（比看文件可靠）。 */
  async verifyByProbe() {
    if (this.probeBusy) return false;
    this.probeBusy = true;
    try {
      const res = await runTask({
        prompt: 'reply with the single word: ok',
        account: this.account,
        timeoutMs: 45000,
        extraArgs: ['--max-turns', '1'],
      });
      if (res.ok) {
        this.markAuthorized();
        return true;
      }
      if (res.code === 'AUTH_REQUIRED') {
        debug(`[${this.id}] probe: still unauthorized`);
      }
      return false;
    } catch (err) {
      warn(`[${this.id}] probe error: ${err.message}`);
      return false;
    } finally {
      this.probeBusy = false;
    }
  }

  markAuthorized() {
    if (this.status === 'authorized') return;
    ensureAccount(this.account, { lastLoginAt: new Date().toISOString(), status: 'active', site: this.site });
    // 重新登录成功，把号池里的「登录失效」标记一并清掉
    try {
      noteAuth(this.account, true);
    } catch {
      /* 号池未初始化时忽略 */
    }
    this.setStatus('authorized');
    this.pty?.kill?.();
  }

  /** 自动检测失灵时的手动兜底：用户说"我扫完了"。 */
  confirmManually() {
    if (this.status === 'authorized') return this.snapshot();
    this.markAuthorized();
    return this.snapshot();
  }

  cancel() {
    if (['authorized', 'failed', 'cancelled'].includes(this.status)) return this.snapshot();
    this.setStatus('cancelled', { error: '已取消' });
    return this.snapshot();
  }

  cleanup() {
    clearInterval(this.probeTimer);
    clearTimeout(this.logTimer);
    clearTimeout(this.deadlineTimer);
    clearTimeout(this.idleTimer);
    this.probeTimer = null;
    this.logTimer = null;
    this.deadlineTimer = null;
    this.idleTimer = null;
    try {
      this.pty?.kill?.();
    } catch {
      /* ignore */
    }
  }

  wait() {
    if (['authorized', 'failed', 'timeout', 'cancelled', 'already_logged_in'].includes(this.status)) {
      return Promise.resolve(this.snapshot());
    }
    return new Promise((resolve) => {
      this.once('done', (snap) => resolve(snap));
    });
  }
}

// 活跃会话表（MCP 工具按 id 查询状态）
const sessions = new Map();

export async function startLogin(opts = {}) {
  const session = new LoginSession(opts);
  sessions.set(session.id, session);
  session.on('done', () => {
    // 保留 30 分钟供查询，之后清理
    setTimeout(() => sessions.delete(session.id), 30 * 60 * 1000).unref?.();
  });
  await session.start();
  return session;
}

export function getSession(id) {
  return sessions.get(id) || null;
}

export function latestSession() {
  const all = [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
  return all[0] || null;
}

export function listSessions() {
  return [...sessions.values()].map((s) => s.snapshot());
}
