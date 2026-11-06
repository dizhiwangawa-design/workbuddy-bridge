import { execFileSync } from 'node:child_process';
import {
  POOL_FILE,
  ensureBridgeDirs,
  readJson,
  writeJson,
} from './paths.js';
import { getAccount, listAccounts, resolveAccountName } from './accounts.js';
import { quickAuthCheck } from './runner.js';
import { debug, warn } from './log.js';
import {
  dayKey,
  emptySeries,
  normalizeSeries,
  recordSample,
} from './stats.js';

export { dayKey };

/**
 * 号池：把多个扫码登录的账号当成一组可调度资源。
 *
 * 参考了 teamclaude-rs（最少使用轮转）、GPT-Load（权重 + 冷却 + 故障切换）、
 * 以及号池实践中「按 token 而不是请求数均衡」的经验，取其中最小可用的部分：
 *   1. 硬过滤：停用 / 未登录 / 冷却中 / 并发打满 / 当日额度用尽 → 不参与调度
 *   2. 排序：突发避让（先给空闲账号）→ 权重归一后的当日 token → 最久未使用
 *   3. 失败处理：未登录 → 挂起等重新扫码；限流/额度 → 指数退避冷却；其他错误只记数
 *
 * 额度口径见 README：WorkBuddy CLI 没有公开的额度查询接口，
 * 因此剩余额度 = 每日预算（可配）− 本地计量 token；未配预算时只显示用量。
 */

const DAY_MS = 86400000;
const MAX_COOLDOWN_MS = 30 * 60 * 1000;
const COOLDOWN_BASE_MS = 60 * 1000;
const HISTORY_DAYS = 7;

// inflight 属于进程运行态，不能跟号池统计一起从磁盘重载。
const inflightByAccount = new Map();

export const STRATEGIES = {
  balanced: '均衡（按 token 用量 + 权重 + 空闲优先）',
  'round-robin': '加权轮询（按权重轮流）',
};

function emptyToday() {
  return {
    req: 0,
    ok: 0,
    fail: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ms: 0,
    cost: 0,
  };
}

function emptyTotal() {
  return { ...emptyToday() };
}

function emptyEntry(name) {
  return {
    name,
    enabled: true,
    weight: 1,
    maxConcurrency: 1,
    budgetTokens: 0,
    day: dayKey(),
    today: emptyToday(),
    days: {},
    total: emptyTotal(),
    status: 'ready',
    cooldownUntil: 0,
    failures: 0,
    lastUsedAt: 0,
    lastError: '',
    lastLatencyMs: 0,
    model: '',
    inflight: 0,
  };
}

function emptyPool() {
  return {
    version: 2,
    strategy: 'balanced',
    maxAttempts: 3,
    rrCursor: 0,
    accounts: {},
    series: emptySeries(),
  };
}

export function loadPool() {
  const raw = readJson(POOL_FILE, null);
  const pool = { ...emptyPool(), ...(raw || {}) };
  if (!pool.accounts || typeof pool.accounts !== 'object') pool.accounts = {};
  if (!STRATEGIES[pool.strategy]) pool.strategy = 'balanced';
  pool.series = normalizeSeries(pool.series);

  // inflight 是进程内状态；磁盘只保存统计，运行时值从内存覆盖回来。
  for (const [name, e] of Object.entries(pool.accounts)) {
    const base = emptyEntry(name);
    pool.accounts[name] = {
      ...base,
      ...e,
      // 老版本的 today/total 没有缓存字段，逐项补齐
      today: { ...emptyToday(), ...(e.today || {}) },
      total: { ...emptyTotal(), ...(e.total || {}) },
      inflight: inflightByAccount.get(name) || 0,
      name,
    };
    rollDay(pool.accounts[name]);
  }
  return pool;
}

export function savePool(pool) {
  ensureBridgeDirs();
  writeJson(POOL_FILE, pool);
  return pool;
}

/** 跨天时把 today 归档进 days，保证面板上的「今日」是真的今日。 */
export function rollDay(entry, now = Date.now()) {
  const today = dayKey(now);
  if (!entry.day) entry.day = today;
  if (entry.day === today) return entry;

  if (entry.today && entry.today.req > 0) {
    entry.days = entry.days || {};
    entry.days[entry.day] = { ...entry.today };
  }
  entry.day = today;
  entry.today = emptyToday();

  const keys = Object.keys(entry.days || {}).sort();
  while (keys.length > HISTORY_DAYS) {
    delete entry.days[keys.shift()];
  }
  return entry;
}

/** 账号在 accounts.json 里存在、且池里有记录；没有就补一条。 */
export function entryFor(pool, name) {
  const key = name;
  if (!pool.accounts[key]) pool.accounts[key] = emptyEntry(key);
  rollDay(pool.accounts[key]);
  return pool.accounts[key];
}

export function updateAccount(name, patch = {}) {
  const pool = loadPool();
  const e = entryFor(pool, resolveAccountName(name));
  for (const k of ['enabled', 'weight', 'maxConcurrency', 'budgetTokens']) {
    if (patch[k] !== undefined) e[k] = patch[k];
  }
  savePool(pool);
  return e;
}

export function setStrategy(strategy) {
  if (!STRATEGIES[strategy]) throw new Error(`未知策略：${strategy}`);
  const pool = loadPool();
  pool.strategy = strategy;
  savePool(pool);
  return pool.strategy;
}

/** 把工作交给调度器时调用；返回 false 表示这个号其实不该被选中。 */
export function noteAuth(name, loggedIn) {
  const pool = loadPool();
  const e = entryFor(pool, name);
  if (loggedIn) {
    if (e.status === 'unauthorized') e.status = 'ready';
    e.failures = 0;
    e.cooldownUntil = 0;
  } else {
    e.status = 'unauthorized';
  }
  savePool(pool);
}

export function beginTask(name) {
  const key = resolveAccountName(name);
  const next = (inflightByAccount.get(key) || 0) + 1;
  inflightByAccount.set(key, next);

  const pool = loadPool();
  const e = entryFor(pool, key);
  e.lastUsedAt = Date.now();
  savePool(pool);
  return next;
}

export function endTask(name, result) {
  const key = resolveAccountName(name);
  const next = Math.max(0, (inflightByAccount.get(key) || 0) - 1);
  if (next) inflightByAccount.set(key, next);
  else inflightByAccount.delete(key);

  const pool = loadPool();
  const e = entryFor(pool, key);

  const usage = result?.meta?.usage || {};
  // CLI 的 input_tokens 已包含 cache_read_input_tokens（0.2.x 实测），
  // 这里不能再加缓存，否则号池记账和面板曲线都会虚高近一倍。
  const tin = Number(usage.input_tokens || 0);
  const tout = Number(usage.output_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const cacheWrite = Number(usage.cache_creation_input_tokens || 0);
  const cost = Number(result?.meta?.costUsd || 0);
  const ms = Number(result?.durationMs || 0);
  const at = Date.now();

  e.total.req += 1;
  e.today.req += 1;
  e.total.tokensIn += tin;
  e.today.tokensIn += tin;
  e.total.tokensOut += tout;
  e.today.tokensOut += tout;
  e.total.cacheRead = (e.total.cacheRead || 0) + cacheRead;
  e.today.cacheRead = (e.today.cacheRead || 0) + cacheRead;
  e.total.cacheWrite = (e.total.cacheWrite || 0) + cacheWrite;
  e.today.cacheWrite = (e.today.cacheWrite || 0) + cacheWrite;
  e.total.cost = (e.total.cost || 0) + cost;
  e.today.cost = (e.today.cost || 0) + cost;
  e.total.ms += ms;
  e.today.ms += ms;
  e.lastLatencyMs = ms;
  if (result?.meta?.model) e.model = result.meta.model;

  if (result?.ok) {
    e.total.ok += 1;
    e.today.ok += 1;
    e.failures = 0;
    e.cooldownUntil = 0;
    e.lastError = '';
    e.status = 'ready';
  } else {
    e.total.fail += 1;
    e.today.fail += 1;
    e.lastError = String(result?.error || result?.code || '').slice(0, 300);

    if (result?.code === 'AUTH_REQUIRED') {
      e.status = 'unauthorized';
    } else if (isQuotaError(result)) {
      applyCooldown(e);
    } else {
      e.failures += 1;
    }
  }

  recordSample(
    pool,
    {
      at,
      account: key,
      model: result?.meta?.model || e.model || '',
      ok: Boolean(result?.ok),
      code: result?.code || '',
      tin,
      tout,
      cacheRead,
      cacheWrite,
      ms,
      cost,
    },
    at,
  );

  savePool(pool);
  return e;
}

export async function withAccountLease(name, fn) {
  beginTask(name);
  let result;
  try {
    result = await fn();
    return result;
  } finally {
    endTask(name, result || {
      ok: false,
      code: 'DISPATCH_ERROR',
      error: '任务在执行前或执行中抛出异常',
      durationMs: 0,
    });
  }
}

function applyCooldown(e, now = Date.now()) {
  e.failures = (e.failures || 0) + 1;
  const backoff = Math.min(COOLDOWN_BASE_MS * 2 ** (e.failures - 1), MAX_COOLDOWN_MS);
  e.cooldownUntil = now + backoff;
  e.status = 'cooling';
  return backoff;
}

/** 手动把某个号拉回可用（面板上的「重置冷却」）。 */
export function resetCooldown(name) {
  const pool = loadPool();
  const e = entryFor(pool, name);
  e.cooldownUntil = 0;
  e.failures = 0;
  e.lastError = '';
  if (e.status !== 'disabled' && e.status !== 'unauthorized') e.status = 'ready';
  savePool(pool);
  return e;
}

export function isQuotaError(result) {
  const s = `${result?.error || ''} ${result?.text || ''} ${result?.stderr || ''}`;
  return /rate.?limit|too many requests|\b429\b|quota|credit|额度|限流|频率|请求过多|上限/i.test(s);
}

/** 账号能否接活；不能时给出可读原因，面板直接用这句话。 */
export function availability(entry, { auth, now = Date.now() } = {}) {
  if (!entry.enabled) return { ok: false, reason: '已停用', kind: 'disabled' };
  // 凭证文件还在、但 CLI 已经报过未登录（例如 token 过期）——以运行态为准
  if (entry.status === 'unauthorized') {
    return { ok: false, reason: '登录已失效', kind: 'unauthorized' };
  }
  if (auth && !auth.loggedIn) return { ok: false, reason: auth.reason || '未登录', kind: 'unauthorized' };
  if (entry.cooldownUntil > now) {
    return { ok: false, reason: '冷却中', kind: 'cooling', until: entry.cooldownUntil };
  }
  if ((entry.inflight || 0) >= (entry.maxConcurrency || 1)) {
    return { ok: false, reason: '并发已满', kind: 'busy' };
  }
  if (entry.budgetTokens > 0 && tokensToday(entry) >= entry.budgetTokens) {
    return { ok: false, reason: '额度用尽', kind: 'exhausted' };
  }
  return { ok: true, reason: '可用', kind: 'ready' };
}

export function tokensToday(entry) {
  return (entry.today?.tokensIn || 0) + (entry.today?.tokensOut || 0);
}

/** 剩余额度：只有设了每日预算才算得出来，否则返回 null（不明说成 0）。 */
export function quotaOf(entry) {
  const used = tokensToday(entry);
  const limit = Number(entry.budgetTokens || 0);
  if (!limit) {
    return { source: 'local', limit: 0, used, remaining: null, percent: null };
  }
  const remaining = Math.max(0, limit - used);
  return {
    source: 'local',
    limit,
    used,
    remaining,
    percent: Math.min(100, Math.round((used / limit) * 100)),
  };
}

/** 保证池里能覆盖 accounts.json 中已有的账号（扫码后自动入池）。 */
export function syncPool() {
  const pool = loadPool();
  const names = listAccounts().map((a) => a.name);
  let changed = false;
  for (const n of names) {
    if (!pool.accounts[n]) {
      pool.accounts[n] = emptyEntry(n);
      changed = true;
    }
  }
  // accounts.json 里已删除的，池里也清掉
  for (const n of Object.keys(pool.accounts)) {
    if (!names.includes(n)) {
      delete pool.accounts[n];
      inflightByAccount.delete(n);
      changed = true;
    }
  }
  if (changed) savePool(pool);
  return pool;
}

/** 运行时状态：把落盘数据 + 实时登录检查 + 额度拼成一份可直接渲染的视图。 */
export function poolView() {
  const pool = syncPool();
  const now = Date.now();
  const defaultName = resolveAccountName();
  const rows = Object.keys(pool.accounts).map((name) => {
    const e = pool.accounts[name];
    const auth = quickAuthCheck(name);
    const avail = availability(e, { auth, now });
    // 有官方额度接口就用真数据，否则退回本地计量（口径见 README）
    const quota = externalQuota(name) || quotaOf(e);
    const status = !e.enabled
      ? 'disabled'
      : e.status === 'unauthorized' || !auth.loggedIn
        ? 'unauthorized'
        : e.cooldownUntil > now
          ? 'cooling'
          : 'ready';

    return {
      name,
      isDefault: name === defaultName,
      status,
      statusText: {
        ready: '可用',
        cooling: '冷却中',
        unauthorized: '未登录',
        disabled: '已停用',
        busy: '忙碌',
        exhausted: '额度用尽',
      }[status === 'ready' ? (avail.kind === 'busy' ? 'busy' : avail.kind === 'exhausted' ? 'exhausted' : 'ready') : status],
      available: avail.ok,
      reason: avail.reason,
      enabled: e.enabled,
      weight: e.weight,
      maxConcurrency: e.maxConcurrency,
      inflight: e.inflight || 0,
      budgetTokens: e.budgetTokens || 0,
      cooldownUntil: e.cooldownUntil || 0,
      cooldownLeftMs: Math.max(0, (e.cooldownUntil || 0) - now),
      lastUsedAt: e.lastUsedAt || 0,
      lastError: e.lastError || '',
      lastLatencyMs: e.lastLatencyMs || 0,
      model: e.model || '',
      auth: auth.reason,
      quota,
      today: {
        req: e.today.req,
        ok: e.today.ok,
        fail: e.today.fail,
        // 始终用本地计量：外部额度探针的 used 单位未必是 token
        tokens: tokensToday(e),
        cacheRead: e.today.cacheRead || 0,
        cacheWrite: e.today.cacheWrite || 0,
        cacheHitRate: e.today.tokensIn ? (e.today.cacheRead || 0) / e.today.tokensIn : null,
        costUsd: e.today.cost || 0,
        avgMs: e.today.req ? Math.round(e.today.ms / e.today.req) : 0,
        successRate: e.today.req ? e.today.ok / e.today.req : null,
      },
      total: {
        req: e.total.req,
        ok: e.total.ok,
        fail: e.total.fail,
        tokens: (e.total.tokensIn || 0) + (e.total.tokensOut || 0),
        cacheRead: e.total.cacheRead || 0,
        costUsd: e.total.cost || 0,
        avgMs: e.total.req ? Math.round(e.total.ms / e.total.req) : 0,
        successRate: e.total.req ? e.total.ok / e.total.req : null,
      },
      history: historySeries(e),
      profileDir: getAccount(name)?.profileDir || '',
    };
  });

  rows.sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));

  const okCount = rows.filter((r) => r.available).length;
  const totalReq = rows.reduce((s, r) => s + r.today.req, 0);
  const totalOk = rows.reduce((s, r) => s + r.today.ok, 0);
  const totalTokens = rows.reduce((s, r) => s + r.today.tokens, 0);

  return {
    strategy: pool.strategy,
    strategyText: STRATEGIES[pool.strategy],
    maxAttempts: pool.maxAttempts,
    accounts: rows,
    summary: {
      total: rows.length,
      available: okCount,
      cooling: rows.filter((r) => r.status === 'cooling').length,
      unauthorized: rows.filter((r) => r.status === 'unauthorized').length,
      disabled: rows.filter((r) => r.status === 'disabled').length,
      todayReq: totalReq,
      todayTokens: totalTokens,
      successRate: totalReq ? totalOk / totalReq : null,
      inflight: rows.reduce((s, r) => s + r.inflight, 0),
    },
    updatedAt: now,
  };
}

function historySeries(entry, days = 7, now = Date.now()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(now - i * DAY_MS);
    if (key === entry.day) {
      out.push({ day: key, tokens: tokensToday(entry), req: entry.today.req });
    } else {
      const d = entry.days?.[key];
      out.push({
        day: key,
        tokens: d ? (d.tokensIn || 0) + (d.tokensOut || 0) : 0,
        req: d?.req || 0,
      });
    }
  }
  return out;
}

/** 候选排序。返回选中的账号名，或一份「为什么没人可用」。 */
export function pickAccount({ exclude = [], strategy, now = Date.now() } = {}) {
  const pool = syncPool();
  const strat = strategy || pool.strategy;
  const rows = [];

  for (const [name, e] of Object.entries(pool.accounts)) {
    if (exclude.includes(name)) continue;
    const auth = quickAuthCheck(name);
    const avail = availability(e, { auth, now });
    if (!avail.ok) {
      rows.push({ name, avail, e });
      continue;
    }
    const weight = Math.max(1, Number(e.weight) || 1);
    const tokens = tokensToday(e);
    rows.push({
      name,
      avail,
      e,
      score: {
        inflight: e.inflight || 0,
        load: tokens / weight,
        lastUsedAt: e.lastUsedAt || 0,
      },
    });
  }

  const usable = rows.filter((r) => r.avail.ok);

  if (!usable.length) {
    const blocked = rows.filter((r) => r.name !== undefined && !r.avail.ok);
    const cooling = blocked.filter((r) => r.avail.kind === 'cooling').map((r) => r.avail.until);
    return {
      name: null,
      reason: blocked.map((r) => `${r.name}: ${r.avail.reason}`).join('；') || '池中没有账号',
      retryAt: cooling.length ? Math.min(...cooling) : 0,
    };
  }

  if (strat === 'round-robin') {
    // 按权重展开成一条环形队列，游标持久化，跨进程也能保持大致均匀
    const ring = [];
    for (const r of usable.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      for (let i = 0; i < Math.min(20, Math.max(1, r.e.weight || 1)); i++) ring.push(r.name);
    }
    const cursor = pool.rrCursor % ring.length;
    for (let i = 0; i < ring.length; i++) {
      const name = ring[(cursor + i) % ring.length];
      const hit = usable.find((r) => r.name === name);
      if (!hit) continue;
      const next = loadPool();
      next.rrCursor = (cursor + i + 1) % ring.length;
      savePool(next);
      return { name, strategy: strat };
    }
  }

  // balanced：先避开正在跑的号（突发流量不叠到同一个号上），再比权重归一后的 token，最后 LRU
  usable.sort(
    (a, b) =>
      a.score.inflight - b.score.inflight ||
      a.score.load - b.score.load ||
      a.score.lastUsedAt - b.score.lastUsedAt,
  );
  debug(`pick: ${usable.map((r) => `${r.name}(${Math.round(r.score.load)})`).join(' < ')}`);
  return { name: usable[0].name, strategy: strat };
}

/** 外部额度探针：给有官方额度接口的部署留的口子（可选）。 */
const quotaCache = new Map();

export function externalQuota(name, { ttlMs = 60000 } = {}) {
  const cmd = process.env.WB_QUOTA_CMD;
  if (!cmd) return null;
  const hit = quotaCache.get(name);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;

  const env = {
    ...process.env,
    WB_ACCOUNT: name,
    WB_PROFILE_DIR: getAccount(name)?.profileDir || '',
  };

  let value = null;
  try {
    const out = execSyncSafe(cmd, env);
    const parsed = JSON.parse(out);
    value = {
      source: 'external',
      limit: Number(parsed.limit || 0),
      used: Number(parsed.used || 0),
      remaining: parsed.remaining === undefined ? null : Number(parsed.remaining),
      unit: parsed.unit || 'tokens',
      resetAt: parsed.resetAt || null,
    };
  } catch (err) {
    warn(`WB_QUOTA_CMD 执行失败（${name}）：${err.message}`);
  }
  quotaCache.set(name, { at: Date.now(), value });
  return value;
}

function execSyncSafe(cmd, env) {
  // 用 shell 执行，用户可以写 `wb-quota --json` 这种带参数的命令
  if (process.platform === 'win32') {
    return execFileSync('cmd', ['/c', cmd], { env, encoding: 'utf8', timeout: 8000 });
  }
  return execFileSync('/bin/sh', ['-c', cmd], { env, encoding: 'utf8', timeout: 8000 });
}
