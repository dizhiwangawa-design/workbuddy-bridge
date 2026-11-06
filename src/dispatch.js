import { runTask } from './runner.js';
import {
  beginTask,
  endTask,
  isQuotaError,
  pickAccount,
  resetCooldown,
  syncPool,
} from './pool.js';
import { debug } from './log.js';

/**
 * 一次任务 = 选号 → 执行 → 记账，失败时换号重试。
 *
 * 只有「还没产出任何内容」的失败才会换号：
 * 已经写了文件、或已经吐出半截答案的任务重跑，可能造成重复副作用，
 * 这种宁可把错误原样抛回去，也不要偷偷再执行一遍。
 */

const RETRYABLE = new Set(['AUTH_REQUIRED', 'COOLDOWN', 'QUOTA_EXCEEDED']);

async function runMeteredTask(account, options) {
  beginTask(account);
  let result;
  try {
    result = await runTask({ ...options, account });
    return result;
  } finally {
    endTask(
      account,
      result || {
        ok: false,
        code: 'DISPATCH_ERROR',
        error: '任务在执行前或执行中抛出异常',
        durationMs: 0,
      },
    );
  }
}

export async function dispatchTask(options = {}) {
  const { account, ...rest } = options;

  // 显式指定账号：不参与调度，也不换号（用户点名要用这个号）
  if (account && account !== 'auto') {
    const res = await runMeteredTask(account, rest);
    return { ...res, attempts: [{ account, code: res.code, ok: res.ok }] };
  }

  const pool = syncPool();
  const maxAttempts = Math.max(1, Math.min(Number(pool.maxAttempts) || 3, 5));
  const tried = [];
  const attempts = [];
  let last = null;

  for (let i = 0; i < maxAttempts; i++) {
    const pick = pickAccount({ exclude: tried });

    if (!pick.name) {
      if (!attempts.length) {
        return {
          ok: false,
          code: 'POOL_EMPTY',
          text: '',
          error: `号池里没有可用账号（${pick.reason}）`,
          hint: pick.retryAt
            ? `最早 ${Math.ceil((pick.retryAt - Date.now()) / 1000)} 秒后有账号结束冷却`
            : '执行 wb login 扫码添加账号，或在 wb admin 里启用/重置账号',
          attempts,
          retryAt: pick.retryAt,
        };
      }
      break;
    }

    tried.push(pick.name);
    debug(`dispatch → ${pick.name}（第 ${i + 1} 次）`);

    const res = await runMeteredTask(pick.name, rest);

    attempts.push({ account: pick.name, code: res.code, ok: res.ok, durationMs: res.durationMs });
    last = { ...res, account: pick.name };

    if (res.ok) return { ...last, attempts };

    // 已产出内容就不重试，避免重复副作用。
    // 但「未登录 / 被限流」时 CLI 也会回一句错误文本，那不算产出，该换号就换号。
    const infraFailure = res.code === 'AUTH_REQUIRED' || res.code === 'RATE_LIMITED';
    const hasOutput = !infraFailure && Boolean((res.text || '').trim());
    if (!RETRYABLE.has(res.code) || hasOutput || res.code === 'ABORTED') break;
    if (res.code === 'TIMEOUT') break;

    debug(`${pick.name} 失败（${res.code}），换下一个号`);
  }

  if (!last) {
    return {
      ok: false,
      code: 'POOL_EMPTY',
      text: '',
      error: '号池里没有可用账号',
      attempts,
    };
  }

  const hint = attempts.length > 1 ? `已尝试 ${attempts.map((a) => a.account).join(' → ')}` : undefined;
  return { ...last, attempts, hint: last.hint || hint };
}

/** 面板上的「测试」按钮：用最短的提示词确认账号真的能出话。 */
export async function probeAccount(name) {
  const started = Date.now();
  const res = await runMeteredTask(name, {
    prompt: 'reply with the single word: ok',
    timeoutMs: 60000,
    extraArgs: ['--max-turns', '1'],
  });
  if (res.code === 'AUTH_REQUIRED') resetCooldown(name);
  return {
    ok: res.ok,
    code: res.code,
    error: res.error,
    text: (res.text || '').slice(0, 120),
    durationMs: Date.now() - started,
    quotaError: isQuotaError(res),
  };
}
