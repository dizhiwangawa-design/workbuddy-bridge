import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
const ALL_MODELS = '*';

// inflight 属于进程运行态，不能跟号池统计一起从磁盘重载。
const inflightByAccount = new Map();

/** 单号并发槽位上限：实测到 8 未触发限流，但不建议把 8 当默认值。 */
export const MAX_CONCURRENCY = 10;

// ---------------------------------------------------------------- 落盘与缓存
//
// 一次请求要碰两次号池（beginTask / endTask），而 pool.json 有近 100 KB，
// 其中约六成是面板的时序数据。每次都全量解析 + 全量重写，12 并发时每波就是
// 24 次 100 KB 的同步 I/O。这里做两件事：
//
//   1. 读走内存缓存：只有磁盘签名（ino + mtime + size）变了才重新解析；
//   2. 写分两类：配置类同步落盘，统计类合并 —— 空闲 500 ms 后写，
//      持续有流量时最多 2 s 一次。
//
// 别的进程（wb pool、另一个 bridge）改了文件时按「配置以磁盘为准、统计以内存
// 为准」合并：既不会把对方刚改的配置改回去，也不会丢掉还没落盘的计数。
// 已知代价：对方写入时若把尚未落盘的冷却带走了，该号会再撞一次 429 才重新进冷却。

const FLUSH_DELAY_MS = 500;
const FLUSH_MAX_DELAY_MS = 2000;

/** cache.pool 是「磁盘 + 未落盘统计」的唯一内存副本，调用方直接改它。 */
let cache = null; // { pool, sig }
let dirty = false;
let flushTimer = null;
let firstDirtyAt = 0;
let exitHooksInstalled = false;

function fileSignature() {
  try {
    const s = fs.statSync(POOL_FILE);
    return { ino: s.ino, mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function sameSignature(a, b) {
  if (!a || !b) return !a && !b;
  return a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

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
    // 观测：没有这两项就不要放开并发（峰值帮忙判断槽位够不够，429 次数帮忙回滚）
    peakInflight: 0,
    rateLimited: 0,
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
    cooldowns: Object.create(null),
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
    // 新账号的并发槽位默认值。默认保守，按号放开（单号实测安全到 3，不建议把 8 当默认）
    defaultMaxConcurrency: 1,
    rrCursor: 0,
    accounts: {},
    series: emptySeries(),
  };
}

function normalizeCooldowns(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return Object.create(null);
  }
  const out = Object.create(null);
  for (const [model, value] of Object.entries(raw)) {
    if (!model) continue;
    const until = Number(value?.until ?? value);
    if (!Number.isFinite(until) || until <= now) continue;
    out[model] = {
      until,
      failures: Math.max(1, Number(value?.failures) || 1),
    };
  }
  return out;
}

function cooldownUntil(entry, now = Date.now()) {
  const active = Object.values(entry?.cooldowns || {})
    .filter((value) => Number(value?.until) > now);
  return active.length
    ? Math.max(...active.map((value) => Number(value.until)))
    : 0;
}

function syncCooldownState(entry, now = Date.now()) {
  entry.cooldowns = normalizeCooldowns(entry.cooldowns, now);
  entry.cooldownUntil = cooldownUntil(entry, now);
  if (entry.status !== 'unauthorized' && entry.status !== 'disabled') {
    if (entry.cooldownUntil > now) entry.status = 'cooling';
    else if (entry.status === 'cooling') entry.status = 'ready';
  }
  return entry.cooldownUntil;
}

/** 只从磁盘读一次并规范化；调用方是缓存层，其他代码一律走 readPool()。 */
function loadPoolFromDisk() {
  let raw = null;
  let sig = null;
  try {
    sig = fileSignature();
    raw = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  } catch {
    raw = null; // 文件不存在或内容损坏：按空池起步，不阻断请求
  }
  const pool = { ...emptyPool(), ...(raw || {}) };
  if (!pool.accounts || typeof pool.accounts !== 'object') pool.accounts = {};
  if (!STRATEGIES[pool.strategy]) pool.strategy = 'balanced';
  pool.series = normalizeSeries(pool.series);

  // inflight 是进程内状态；磁盘只保存统计，运行时值从内存覆盖回来。
  for (const [name, e] of Object.entries(pool.accounts)) {
    pool.accounts[name] = normalizeEntry(name, e);
  }
  return { pool, sig };
}

function normalizeEntry(name, e) {
  const base = emptyEntry(name);
  const now = Date.now();
  const cooldowns = normalizeCooldowns(e?.cooldowns, now);
  // v2 只保存账号级冷却。升级后按“所有模型”处理，避免旧状态提前失效。
  if (!Object.hasOwn(e || {}, 'cooldowns') && Number(e?.cooldownUntil) > now) {
    cooldowns[ALL_MODELS] = {
      until: Number(e.cooldownUntil),
      failures: Math.max(1, Number(e.failures) || 1),
    };
  }
  const entry = {
    ...base,
    ...e,
    cooldowns,
    // 老版本的 today/total 没有缓存字段，逐项补齐
    today: { ...emptyToday(), ...(e?.today || {}) },
    total: { ...emptyTotal(), ...(e?.total || {}) },
    inflight: inflightByAccount.get(name) || 0,
    name,
  };
  syncCooldownState(entry, now);
  rollDay(entry);
  return entry;
}

/**
 * 有缓存就复用，没有或磁盘变了才重新解析。
 *
 * 磁盘变化来自别的进程（wb pool、另一个 bridge）。此时统计以内存为准：
 * 本进程还没落盘的计数不能被一份更旧的磁盘快照覆盖，否则请求结束就白记了。
 * 配置、冷却、series 以磁盘为准 —— 用户刚在面板上改的东西要立刻生效。
 */
function readPool() {
  const sig = fileSignature();
  if (!cache) {
    cache = loadPoolFromDisk();
    installExitHooks();
  } else if (!sameSignature(sig, cache.sig) && !(dirty && !sig)) {
    // 签名变了（含文件被删）就以磁盘重来；只有「文件不见但还有没落盘的统计」例外 ——
    // 那份统计是仅存的数据，不能被一次删除抹掉。
    const fresh = loadPoolFromDisk();
    // 没有待落盘的统计时直接以磁盘为准；有则合并，两边都不丢。
    cache.pool = dirty ? mergeDiskConfig(fresh.pool, cache.pool) : fresh.pool;
    cache.sig = fresh.sig;
  }
  // 每次读都要重算：inflight 是本进程的实时值，冷却会随时间自然过期，
  // 跨天要归档 —— 这些都不能停在「上一次解析那一刻」的状态。
  refreshEntries(cache.pool);
  return cache.pool;
}

/** 就地刷新每个账号条目：规范化、同步 inflight、跨天归档。 */
function refreshEntries(pool) {
  pool.series = normalizeSeries(pool.series);
  for (const [name, e] of Object.entries(pool.accounts)) {
    pool.accounts[name] = normalizeEntry(name, e);
  }
  return pool;
}

/** 别的进程能改的字段：配置、启停、冷却。其余（统计、时序）归本进程所有。 */
const CONFIG_FIELDS = ['enabled', 'weight', 'maxConcurrency', 'budgetTokens'];

/**
 * 合并「刚读到的磁盘快照」与「内存里还没落盘的池」。
 *   配置 / 冷却 / 启停 ← 磁盘（用户刚改的要立刻生效）
 *   统计 / 时序 / 最近使用 ← 内存（还没落盘的计数不能丢）
 */
function mergeDiskConfig(disk, mine) {
  const out = { ...disk, series: mine.series };
  out.accounts = { ...disk.accounts };
  for (const [name, m] of Object.entries(mine.accounts || {})) {
    const d = out.accounts[name];
    if (!d) {
      out.accounts[name] = m;
      continue;
    }
    const e = { ...m, inflight: inflightByAccount.get(name) || 0 };
    for (const k of CONFIG_FIELDS) e[k] = d[k];
    e.cooldowns = d.cooldowns;
    e.cooldownUntil = d.cooldownUntil;
    e.failures = d.failures;
    e.status = d.status;
    // 跨天时「今日」不是同一天，磁盘那份才是今天
    if (d.day !== m.day) {
      e.day = d.day;
      e.today = d.today;
      e.days = d.days;
    }
    syncCooldownState(e, Date.now());
    out.accounts[name] = e;
  }
  return out;
}

/** 兼容旧调用名：从缓存读，不每次都碰磁盘。 */
export function loadPool() {
  return readPool();
}

/**
 * 真正落盘。写失败只记 warn 并保留脏标记，下一次再试 ——
 * 一次磁盘错误不能让请求失败。
 */
export function flushPool() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!cache || !dirty) return false;
  try {
    ensureBridgeDirs();
    writeJson(POOL_FILE, cache.pool);
    cache.sig = fileSignature();
    dirty = false;
    firstDirtyAt = 0;
    return true;
  } catch (err) {
    warn(`pool 落盘失败，保留脏标记：${err.message}`);
    return false;
  }
}

/**
 * 统计类写：合并后再落盘。空闲 500 ms 后写；持续有流量时最多 2 s 一次。
 * 显式落盘的配置写不走这里，直接 savePool()。
 */
export function markPoolDirty() {
  dirty = true;
  const now = Date.now();
  if (!firstDirtyAt) firstDirtyAt = now;
  if (now - firstDirtyAt >= FLUSH_MAX_DELAY_MS) {
    flushPool();
    return;
  }
  clearTimeout(flushTimer);
  const wait = Math.max(0, Math.min(FLUSH_DELAY_MS, firstDirtyAt + FLUSH_MAX_DELAY_MS - now));
  flushTimer = setTimeout(flushPool, wait);
  // 不能因为一个待落盘的统计把进程钉在事件循环里
  flushTimer.unref?.();
}

const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * 退出前把合并窗口里的统计写完。
 *
 * 'exit' 钩子只在正常退出时跑；被 SIGINT/SIGTERM 打断时进程直接结束，钩子不会执行。
 * 所以信号也要接，但只在没有别的处理者时才由我们 exit —— 否则 Ctrl+C 会被这里
 * 抢先吞掉（安装顺序在我们之后的其他处理者就再也不会执行）。判据是 once 包装器
 * 在调用前已被移除：此时 listenerCount 为 0 说明确实只剩我们。
 */
function installExitHooks() {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.once('exit', () => {
    try {
      flushPool();
    } catch {
      /* 退出路径上不能再抛 */
    }
  });
  for (const signal of EXIT_SIGNALS) {
    process.once(signal, () => {
      try {
        flushPool();
      } catch {
        /* 退出路径上不能再抛 */
      }
      if (process.listenerCount(signal) === 0) process.exit(0);
    });
  }
}

/** 配置类写：先更新缓存再把整份文件同步写下去，保证别的进程立刻看到。 */
export function savePool(pool) {
  // 没读过就写：先建缓存，否则 flushPool 会因为「没有缓存」直接跳过这次落盘
  if (!cache) {
    cache = { pool, sig: null };
    installExitHooks();
  } else if (pool !== cache.pool) {
    cache.pool = pool;
  }
  dirty = true;
  flushPool();
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
  if (!pool.accounts[key]) {
    pool.accounts[key] = emptyEntry(key);
    pool.accounts[key].maxConcurrency = clampConcurrency(pool.defaultMaxConcurrency);
  }
  rollDay(pool.accounts[key]);
  return pool.accounts[key];
}

/** 并发槽位只允许 1..MAX_CONCURRENCY 的整数，越小越保守。 */
export function clampConcurrency(value) {
  const n = Math.round(Number(value) || 0);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_CONCURRENCY);
}

export function updateAccount(name, patch = {}) {
  const pool = loadPool();
  const e = entryFor(pool, resolveAccountName(name));
  for (const k of ['enabled', 'weight', 'budgetTokens']) {
    if (patch[k] !== undefined) e[k] = patch[k];
  }
  // 并发槽位是唯一会被 clamp 的字段：手滑写 999 不该把号池打穿
  if (patch.maxConcurrency !== undefined) e.maxConcurrency = clampConcurrency(patch.maxConcurrency);
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
    e.cooldowns = Object.create(null);
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
  // 峰值并发是判断槽位够不够的唯一凭据，跟着统计一起落盘
  if (next > (e.today.peakInflight || 0)) e.today.peakInflight = next;
  markPoolDirty();
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

  // 只有「会让这个号立刻停派」的变化才值得同步落盘：统计丢了只是少一个计数，
  // 冷却丢了会立刻再撞一次 429。
  let urgent = false;

  if (result?.ok) {
    e.total.ok += 1;
    e.today.ok += 1;
    e.failures = 0;
    e.status = 'ready';
    const previousLastError = e.lastError;
    const requestModel = String(result?.meta?.model || '');
    if (!requestModel) e.cooldowns = Object.create(null);
    else delete e.cooldowns[requestModel];
    e.lastError = Object.keys(e.cooldowns).length ? previousLastError : '';
  } else {
    e.total.fail += 1;
    e.today.fail += 1;
    e.lastError = String(result?.error || result?.code || '').slice(0, 300);

    if (result?.code === 'AUTH_REQUIRED') {
      e.status = 'unauthorized';
      urgent = true;
    } else if (isQuotaError(result)) {
      e.today.rateLimited = (e.today.rateLimited || 0) + 1;
      applyCooldown(e, result?.meta?.model, at, result?.meta?.resetAt);
      urgent = true;
    } else {
      e.failures += 1;
    }
  }
  syncCooldownState(e, at);

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
      // 时间口径由 runtime 提供；缺失时保持 0，stats 会把它们当作「无样本」。
      ttftMs: Number(result?.meta?.ttftMs) || 0,
      decodeMs: Number(result?.meta?.decodeMs) || 0,
      cost,
      apiProtocol: result?.meta?.apiProtocol || '',
      clientKeyId: result?.meta?.clientKeyId || '',
      clientKeyName: result?.meta?.clientKeyName || '',
    },
    at,
  );

  if (urgent) savePool(pool);
  else markPoolDirty();
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

/**
 * 打冷却。上游给了恢复时刻就按时刻走，没给才退避。
 *
 * 指数退避（1min → 30min 封顶）是猜；猜短了会连续撞限流，而 CodeBuddy 生态的
 * 429 一旦给出重置时刻，等待可能就是几小时。所以 result.meta.resetAt 优先。
 * 失败计数仍然累加，这样连续撞限流时退避也不会倒退。
 */
function applyCooldown(e, model, now = Date.now(), resetAt = 0) {
  const key = String(model || ALL_MODELS);
  if (!e.cooldowns || typeof e.cooldowns !== 'object' || Array.isArray(e.cooldowns)) {
    e.cooldowns = Object.create(null);
  }
  const previous = e.cooldowns[key];
  const failures = Math.max(1, Number(previous?.failures) || 0) + 1;
  e.failures = (e.failures || 0) + 1;
  const backoff = Math.min(COOLDOWN_BASE_MS * 2 ** (failures - 1), MAX_COOLDOWN_MS);
  const until = Number(resetAt) > now ? Math.round(Number(resetAt)) : now + backoff;
  e.cooldowns[key] = {
    until,
    failures,
  };
  if (e.status !== 'unauthorized' && e.status !== 'disabled') e.status = 'cooling';
  syncCooldownState(e, now);
  return Math.max(0, until - now);
}

/** 手动把某个号拉回可用（面板上的「重置冷却」）。 */
export function resetCooldown(name) {
  const pool = loadPool();
  const e = entryFor(pool, name);
  e.cooldownUntil = 0;
  e.cooldowns = Object.create(null);
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
function activeCooldownFor(entry, { model, now = Date.now() } = {}) {
  const cooldowns = normalizeCooldowns(entry?.cooldowns, now);
  const allModels = cooldowns[ALL_MODELS];
  if (allModels) return { model: ALL_MODELS, ...allModels };
  if (model && cooldowns[model]) return { model, ...cooldowns[model] };
  if (!model) {
    const active = Object.entries(cooldowns)
      .sort((a, b) => Number(b[1].until) - Number(a[1].until));
    if (active.length) return { model: active[0][0], ...active[0][1] };
  }
  return null;
}

export function availability(entry, { auth, now = Date.now(), model } = {}) {
  if (!entry.enabled) return { ok: false, reason: '已停用', kind: 'disabled' };
  // 凭证文件还在、但 CLI 已经报过未登录（例如 token 过期）——以运行态为准
  if (entry.status === 'unauthorized') {
    return { ok: false, reason: '登录已失效', kind: 'unauthorized' };
  }
  if (auth && !auth.loggedIn) return { ok: false, reason: auth.reason || '未登录', kind: 'unauthorized' };
  const cooldown = activeCooldownFor(entry, { model, now });
  if (cooldown) {
    return { ok: false, reason: '冷却中', kind: 'cooling', until: cooldown.until, model: cooldown.model };
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
    const cooldowns = normalizeCooldowns(e.cooldowns, now);
    const cooldownModels = Object.keys(cooldowns);
    // 有官方额度接口就用真数据，否则退回本地计量（口径见 README）
    const quota = externalQuota(name) || quotaOf(e);
    const status = !e.enabled
      ? 'disabled'
      : e.status === 'unauthorized' || !auth.loggedIn
        ? 'unauthorized'
        : cooldownModels.length
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
      maxConcurrencyMax: MAX_CONCURRENCY,
      cooldownUntil: e.cooldownUntil || 0,
      cooldownLeftMs: Math.max(0, (e.cooldownUntil || 0) - now),
      cooldownModels,
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
        // 放开并发必须能看见这两项，否则回滚没有依据
        peakInflight: e.today.peakInflight || 0,
        rateLimited: e.today.rateLimited || 0,
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
    defaultMaxConcurrency: pool.defaultMaxConcurrency || 1,
    maxConcurrencyMax: MAX_CONCURRENCY,
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
export function pickAccount({
  exclude = [],
  strategy,
  now = Date.now(),
  model,
} = {}) {
  const pool = syncPool();
  const strat = strategy || pool.strategy;
  const rows = [];

  for (const [name, e] of Object.entries(pool.accounts)) {
    if (exclude.includes(name)) continue;
    const auth = quickAuthCheck(name);
    const avail = availability(e, { auth, now, model });
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
      // 游标是调度态：只更新缓存里的那一份，落盘跟着统计一起合并写。
      // 跨进程的轮询精度会略降（最多差一个窗口），换来的是每次选号不写 100 KB。
      pool.rrCursor = (cursor + i + 1) % ring.length;
      markPoolDirty();
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
