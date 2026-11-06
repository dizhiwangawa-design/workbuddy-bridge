import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { accountEnv, getAccount, resolveAccountName } from './accounts.js';
import { readAccountCredentials } from './auth-store.js';
import { loadConfig } from './paths.js';
import { debug } from './log.js';

const DEFAULT_TIMEOUT = 900000;

export function cliCommand() {
  return process.env.WB_COMMAND || 'codebuddy';
}

/** 判断 CLI 是否还在：给出可读的安装提示，而不是一句 spawn ENOENT。 */
export function cliExists() {
  const cmd = cliCommand();
  if (cmd.includes('/') || cmd.includes('\\')) return fs.existsSync(cmd);
  const paths = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  return paths.some((p) => exts.some((e) => fs.existsSync(path.join(p, cmd + e))));
}

/**
 * modelUsage 的 key 是实际调用过的模型，取 token 最多的那个作为本次主模型。
 */
function dominantModel(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const keys = Object.keys(modelUsage);
  if (!keys.length) return undefined;
  return keys.sort((a, b) => {
    const ta = (modelUsage[a]?.inputTokens || 0) + (modelUsage[a]?.outputTokens || 0);
    const tb = (modelUsage[b]?.inputTokens || 0) + (modelUsage[b]?.outputTokens || 0);
    return tb - ta;
  })[0];
}

/**
 * 执行一次 WorkBuddy 任务。
 * prompt 走 stdin，避免超长参数与 shell 转义问题。
 */
export function runTask(options = {}) {
  const cfg = loadConfig();
  const {
    prompt,
    cwd = cfg.defaults.cwd || process.cwd(),
    model = cfg.defaults.model || '',
    fallbackModel = cfg.defaults.fallbackModel || '',
    timeoutMs = cfg.defaults.timeoutMs || DEFAULT_TIMEOUT,
    skipPermissions = cfg.defaults.skipPermissions !== false,
    account,
    extraArgs = [],
    signal,
    onProgress,
    onRaw,
  } = options;

  if (!prompt || !prompt.trim()) {
    throw new Error('prompt 不能为空');
  }

  const accName = resolveAccountName(account);
  const env = accountEnv(accName);

  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (model) args.push('--model', model);
  if (fallbackModel) args.push('--fallback-model', fallbackModel);
  if (skipPermissions) args.push('--dangerously-skip-permissions');
  args.push(...extraArgs);

  const cmd = cliCommand();
  debug(`spawn ${cmd} ${args.join(' ')} (cwd=${cwd})`);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        ok: false,
        code: 'SPAWN_FAILED',
        text: '',
        error: `无法启动 ${cmd}：${err.message}`,
        durationMs: 0,
        account: accName,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let finalText = '';
    let assistantText = '';
    let meta = {};
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2000).unref?.();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({
        durationMs: Date.now() - startedAt,
        account: accName,
        cwd,
        model: model || 'auto',
        ...payload,
      });
    };

    let lineBuf = '';
    const handleLine = (line) => {
      if (!line.trim()) return;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        // 不是 JSON：可能是 CLI 降级成了纯文本输出
        assistantText += line + '\n';
        onProgress?.(line);
        return;
      }

      if (evt.type === 'result') {
        if (typeof evt.result === 'string') finalText = evt.result;
        meta = {
          sessionId: evt.session_id,
          subtype: evt.subtype,
          isError: evt.is_error,
          numTurns: evt.num_turns,
          costUsd: evt.total_cost_usd,
          durationApiMs: evt.duration_api_ms,
          // 号池按这两个字段记账：token 比请求数更能反映真实负载
          usage: evt.usage,
          modelUsage: evt.modelUsage,
        };
        // result 事件没有顶层 model（0.2.x 实测），从 modelUsage 里挑用量最大的那个，
        // 否则号池卡片和统计里记不到实际模型
        if (!meta.model) meta.model = dominantModel(evt.modelUsage);
      } else if (evt.type === 'assistant') {
        const content = evt.message?.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'text' && part.text) {
              assistantText += part.text;
              onProgress?.(part.text);
            }
          }
        }
      } else if (evt.type === 'stream_event') {
        const delta = evt.event?.delta?.text;
        if (delta) onProgress?.(delta);
      } else if (evt.type === 'system' && evt.subtype === 'init') {
        meta.sessionId = evt.session_id;
        meta.model = evt.model;
      }
    };

    child.stdout.on('data', (buf) => {
      const chunk = buf.toString('utf8');
      stdout += chunk;
      onRaw?.(chunk);
      lineBuf += chunk;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        handleLine(line);
      }
    });

    child.stderr.on('data', (buf) => {
      const chunk = buf.toString('utf8');
      stderr += chunk;
      onRaw?.(chunk);
    });

    child.on('error', (err) => {
      finish({
        ok: false,
        code: 'SPAWN_FAILED',
        text: '',
        error: `${cmd} 启动失败：${err.message}`,
        hint: '确认已安装：npm i -g @tencent-ai/codebuddy-code',
      });
    });

    child.on('close', (code) => {
      if (lineBuf.trim()) handleLine(lineBuf);
      const text = (finalText || assistantText).trim();

      if (timedOut) {
        finish({
          ok: false,
          code: 'TIMEOUT',
          text,
          error: `任务超时（${Math.round(timeoutMs / 1000)}s）`,
          hint: '可用 timeoutMs 参数或 WB_TIMEOUT 环境变量调大',
          meta,
        });
        return;
      }
      if (aborted) {
        finish({ ok: false, code: 'ABORTED', text, error: '调用方取消', meta });
        return;
      }

      const authProblem =
        /not logged in|login required|please log in|unauthorized|401|未登录|登录已失效/i.test(
          stderr + text,
        );

      if (authProblem) {
        finish({
          ok: false,
          code: 'AUTH_REQUIRED',
          text,
          error: 'WorkBuddy 账号未登录或登录已过期',
          hint: `在任意 Agent 里调用 workbuddy_login（account=${accName}），或用扫码登录页完成授权`,
          meta,
        });
        return;
      }

      // 限流 / 额度：号池据此把账号放进冷却，而不是当成普通失败
      const quotaProblem = /rate.?limit|too many requests|\b429\b|insufficient_quota|quota exceeded|额度|限流|请求过多/i.test(
        stderr + text,
      );
      if (quotaProblem && (meta.isError || code !== 0)) {
        finish({
          ok: false,
          code: 'RATE_LIMITED',
          text,
          error: '账号被限流或额度不足',
          hint: '稍后自动恢复；多账号时号池会自动换号',
          meta,
        });
        return;
      }

      // 模型侧报错（result.is_error）即使带了文本也不算成功，否则号池会记错账
      if (meta.isError) {
        finish({
          ok: false,
          code: 'AGENT_ERROR',
          text,
          error: (text || stderr).trim().slice(-800) || 'WorkBuddy 返回了错误结果',
          meta,
        });
        return;
      }

      if (code !== 0 && !text) {
        finish({
          ok: false,
          code: 'EXIT_' + code,
          text: '',
          error: stderr.trim().slice(-1500) || `codebuddy 退出码 ${code}`,
          meta,
        });
        return;
      }

      finish({ ok: true, code: 'OK', text, stderr: stderr.slice(-2000), meta });
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      /* 子进程可能已退出 */
    }
  });
}

/** 登录状态探测：只看该账号隔离 HOME 下的真实认证文件。 */
export function quickAuthCheck(accountName) {
  const acc = getAccount(accountName);
  const dir = acc?.profileDir;
  if (!dir || !fs.existsSync(dir)) return { loggedIn: false, reason: '账号目录不存在' };
  try {
    const cred = readAccountCredentials(accountName);
    return cred.ok
      ? { loggedIn: true, reason: cred.needsRefresh ? '凭证可刷新' : '登录有效' }
      : { loggedIn: false, reason: cred.reason };
  } catch (err) {
    return { loggedIn: false, reason: err.message };
  }
}
