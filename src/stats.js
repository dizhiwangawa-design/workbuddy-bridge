/**
 * 用量时序：把每次任务的结果落进「小时桶 / 天桶」，再按任意区间聚合。
 *
 * 为什么要单独一层：
 *   - 号池卡片只关心「今日已用」，一个数字就够；
 *   - 看板要的是区间曲线、环比、缓存命中率、年度热力图，需要历史明细。
 * 两套口径共用同一份 sample，避免面板和额度判断对不上。
 *
 * token 口径（实测 CLI 0.2.x）：usage.input_tokens 已经包含 cache_read_input_tokens，
 * 所以总输入就是 input_tokens，不能再加一次缓存，否则用量会虚高。
 *   新输入 = input_tokens - cache_read_input_tokens
 *   缓存命中率 = cache_read_input_tokens / input_tokens
 */

export const HOUR_MS = 3600000;
export const DAY_MS = 86400000;

const KEEP_HOUR_DAYS = 16;
const KEEP_DAY_DAYS = 400;
const MAX_EVENTS = 160;

export const RANGES = {
  today: '今日',
  '3d': '近 3 日',
  week: '本周',
  month: '本月',
  '30d': '近 30 天',
  all: '全部',
};

// ------------------------------------------------------------------ 时间键

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function hourKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

export function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfHour(ts = Date.now()) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/** 把 YYYY-MM-DD 解析成本地时区的当天 0 点（不要用 Date.parse，UTC 会偏一天）。 */
export function parseDayKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}

// ------------------------------------------------------------------ 桶

export function emptyBucket() {
  return { req: 0, ok: 0, fail: 0, tin: 0, tout: 0, cacheRead: 0, cacheWrite: 0, ms: 0, cost: 0 };
}

export function addBucket(target, src) {
  target.req += src.req || 0;
  target.ok += src.ok || 0;
  target.fail += src.fail || 0;
  target.tin += src.tin || 0;
  target.tout += src.tout || 0;
  target.cacheRead += src.cacheRead || 0;
  target.cacheWrite += src.cacheWrite || 0;
  target.ms += src.ms || 0;
  target.cost += src.cost || 0;
  return target;
}

export function emptySeries() {
  return { version: 1, seq: 0, hours: {}, days: {}, events: [] };
}

/** 兼容旧 pool.json：缺字段补齐，别让面板因为一个 undefined 整块空白。 */
export function normalizeSeries(raw) {
  const base = emptySeries();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    hours: raw.hours && typeof raw.hours === 'object' ? raw.hours : {},
    days: raw.days && typeof raw.days === 'object' ? raw.days : {},
    events: Array.isArray(raw.events) ? raw.events.slice(0, MAX_EVENTS) : [],
    seq: Number(raw.seq || 0) || 0,
  };
}

/**
 * 记一次任务。
 * sample: { at, account, model, ok, code, tin, tout, cacheRead, cacheWrite, ms, cost }
 */
export function recordSample(pool, sample, now = Date.now()) {
  if (!pool.series) pool.series = emptySeries();
  const s = pool.series;
  const at = sample.at || now;
  const ok = sample.ok ? 1 : 0;

  const one = {
    req: 1,
    ok,
    fail: ok ? 0 : 1,
    tin: sample.tin || 0,
    tout: sample.tout || 0,
    cacheRead: sample.cacheRead || 0,
    cacheWrite: sample.cacheWrite || 0,
    ms: sample.ms || 0,
    cost: sample.cost || 0,
  };

  for (const [map, key] of [
    [s.hours, hourKey(at)],
    [s.days, dayKey(at)],
  ]) {
    if (!map[key]) map[key] = emptyBucket();
    addBucket(map[key], one);
  }

  s.seq = (Number(s.seq) || 0) + 1;
  s.events.unshift({
    seq: s.seq,
    at,
    account: sample.account || '',
    model: sample.model || '',
    ok,
    code: sample.code || '',
    tin: one.tin,
    tout: one.tout,
    cacheRead: one.cacheRead,
    ms: one.ms,
  });
  if (s.events.length > MAX_EVENTS) s.events.length = MAX_EVENTS;

  pruneSeries(pool, now);
  return s;
}

/** 只保留窗口内的桶，避免 pool.json 无限膨胀。 */
export function pruneSeries(pool, now = Date.now()) {
  const s = pool.series;
  if (!s) return;
  const hourCut = hourKey(now - KEEP_HOUR_DAYS * DAY_MS);
  const dayCut = dayKey(now - KEEP_DAY_DAYS * DAY_MS);

  for (const k of Object.keys(s.hours)) if (k < hourCut) delete s.hours[k];
  for (const k of Object.keys(s.days)) if (k < dayCut) delete s.days[k];
}

// ------------------------------------------------------------------ 区间

export function rangeWindow(range, now = Date.now()) {
  const d0 = startOfDay(now);
  switch (range) {
    case '3d':
      return { from: d0 - 2 * DAY_MS, to: now, label: RANGES['3d'] };
    case 'week': {
      const wd = (new Date(now).getDay() + 6) % 7; // 周一 = 0
      return { from: d0 - wd * DAY_MS, to: now, label: RANGES.week };
    }
    case 'month': {
      const d = new Date(now);
      return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now, label: RANGES.month };
    }
    case '30d':
      return { from: d0 - 29 * DAY_MS, to: now, label: RANGES['30d'] };
    case 'all':
      return { from: 0, to: now, label: RANGES.all };
    case 'today':
    default:
      return { from: d0, to: now, label: RANGES.today };
  }
}

/** 生成连续的时间点，中间没有数据的小时/天也要占位，曲线才不会被压扁。 */
export function seriesPoints(pool, from, to, granularity) {
  const s = pool.series || emptySeries();
  const unit = granularity === 'hour' ? HOUR_MS : DAY_MS;
  const start = granularity === 'hour' ? startOfHour(from) : startOfDay(from);
  const end = granularity === 'hour' ? startOfHour(to) : startOfDay(to);
  const out = [];

  // 上限保护：异常参数不至于把内存打满
  const maxPoints = granularity === 'hour' ? 24 * 32 : 500;
  let guard = 0;
  for (let t = start; t <= end && guard < maxPoints; t += unit, guard++) {
    const key = granularity === 'hour' ? hourKey(t) : dayKey(t);
    const b = (granularity === 'hour' ? s.hours[key] : s.days[key]) || emptyBucket();
    out.push({ ts: t, key, ...b, tokens: (b.tin || 0) + (b.tout || 0) });
  }
  return out;
}

export function priceConfig() {
  const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  const pin = num(process.env.WB_PRICE_IN, 0);
  const pout = num(process.env.WB_PRICE_OUT, 0);
  return {
    usdCny: num(process.env.WB_USD_CNY, 7.2),
    pin,
    pout,
    // 缓存读默认按输入价的一折，可单独覆盖
    pcache: num(process.env.WB_PRICE_CACHE, pin * 0.1),
  };
}

function costOf(b, price) {
  if (b.cost > 0) return { cny: b.cost * price.usdCny, source: 'cli', usd: b.cost };
  if (price.pin || price.pout) {
    const fresh = Math.max(0, (b.tin || 0) - (b.cacheRead || 0));
    const cny =
      (fresh * price.pin + (b.tout || 0) * price.pout + (b.cacheRead || 0) * price.pcache) / 1e6;
    return { cny, source: 'price', usd: price.usdCny ? cny / price.usdCny : 0 };
  }
  return { cny: null, source: 'none', usd: 0 };
}

export function summarize(points, price = priceConfig()) {
  const b = emptyBucket();
  for (const p of points) addBucket(b, p);

  let peakThroughput = 0;
  for (const p of points) {
    const v = p.ms ? (p.tout || 0) / (p.ms / 1000) : 0;
    if (v > peakThroughput) peakThroughput = v;
  }

  const tokens = b.tin + b.tout;
  const cost = costOf(b, price);

  return {
    req: b.req,
    ok: b.ok,
    fail: b.fail,
    tin: b.tin,
    tout: b.tout,
    cacheRead: b.cacheRead,
    cacheWrite: b.cacheWrite,
    freshIn: Math.max(0, b.tin - b.cacheRead),
    tokens,
    ms: b.ms,
    avgMs: b.req ? Math.round(b.ms / b.req) : 0,
    avgTokens: b.req ? Math.round(tokens / b.req) : 0,
    successRate: b.req ? b.ok / b.req : null,
    cacheHitRate: b.tin ? b.cacheRead / b.tin : null,
    throughput: b.ms ? b.tout / (b.ms / 1000) : 0,
    peakThroughput,
    costCny: cost.cny,
    costSource: cost.source,
    costUsd: cost.usd,
    activeAccounts: 0,
  };
}

function delta(cur, prev) {
  if (!prev || !prev.req || !cur) return null;
  if (!prev.tokens) return null;
  return cur.tokens / prev.tokens - 1;
}

/** 按自然周/自然月取上一段，其他区间取紧邻的等长一段。 */
function previousWindow(range, win) {
  if (range === 'week') {
    return { from: win.from - 7 * DAY_MS, to: win.to - 7 * DAY_MS };
  }
  if (range === 'month') {
    const shiftMonth = (ts) => {
      const d = new Date(ts);
      const targetMonth = d.getMonth() - 1;
      const lastDay = new Date(d.getFullYear(), targetMonth + 1, 0).getDate();
      return new Date(
        d.getFullYear(),
        targetMonth,
        Math.min(d.getDate(), lastDay),
        d.getHours(),
        d.getMinutes(),
        d.getSeconds(),
        d.getMilliseconds(),
      ).getTime();
    };
    return { from: shiftMonth(win.from), to: shiftMonth(win.to) };
  }
  const span = Math.max(win.to - win.from, HOUR_MS);
  return { from: win.from - span, to: win.from - 1 };
}

/** 主入口：区间聚合 + 环比 + 时序点 + 最近请求 + 年度热力图。 */
export function buildStats(pool, range = 'today', { now = Date.now() } = {}) {
  const price = priceConfig();
  const win = rangeWindow(range, now);

  let from = win.from;
  if (range === 'all') {
    const keys = Object.keys(pool.series?.days || {}).sort();
    from = keys.length ? parseDayKey(keys[0]) : startOfDay(now) - 29 * DAY_MS;
  }

  const span = Math.max(win.to - from, HOUR_MS);
  const granularity = span <= 3 * DAY_MS + HOUR_MS ? 'hour' : 'day';
  const points = seriesPoints(pool, from, win.to, granularity);
  const totals = summarize(points, price);

  // 环比：等长的前一段。全部区间没有「上一段」，返回 null 让前端不显示箭头
  let prev = null;
  if (range !== 'all' && from - span > 0) {
    const previous = previousWindow(range, win);
    const prevPoints = seriesPoints(pool, previous.from, previous.to, granularity);
    prev = summarize(prevPoints, price);
  }

  const rangeEvents = (pool.series?.events || []).filter((e) => e.at >= from && e.at <= win.to);
  const events = rangeEvents.slice(0, 60);
  const accounts = new Set(rangeEvents.map((e) => e.account).filter(Boolean));

  return {
    range,
    label: win.label,
    from,
    to: win.to,
    granularity,
    totals: { ...totals, activeAccounts: accounts.size },
    prev,
    deltas: prev
      ? {
          tokens: delta(totals, prev),
          req: prev.req ? totals.req / prev.req - 1 : null,
          cacheHitRate:
            prev.cacheHitRate && totals.cacheHitRate
              ? totals.cacheHitRate / prev.cacheHitRate - 1
              : null,
          cost:
            prev.costCny && totals.costCny
              ? totals.costCny / prev.costCny - 1
              : null,
        }
      : null,
    series: points.map((p) => ({
      ts: p.ts,
      key: p.key,
      tokens: p.tokens,
      tin: p.tin,
      tout: p.tout,
      req: p.req,
      ok: p.ok,
      fail: p.fail,
      cacheRead: p.cacheRead,
      ms: p.ms,
      throughput: p.ms ? p.tout / (p.ms / 1000) : 0,
    })),
    events,
    heatmap: buildHeatmap(pool, now),
    price: { ...price, configured: Boolean(price.pin || price.pout) },
    generatedAt: now,
  };
}

/**
 * 年度热力图：按周分列，周一到周日 7 行。
 * 色阶按非零值的 p90 归一，避免某一天的峰值把其余全压成最浅色。
 */
export function buildHeatmap(pool, now = Date.now()) {
  const end = startOfDay(now);
  const start = end - 364 * DAY_MS;
  const startOffset = (new Date(start).getDay() + 6) % 7; // 周一 = 0
  const alignedStart = start - startOffset * DAY_MS;

  const cells = [];
  const pad = startOffset;
  for (let i = 0; i < pad; i++) cells.push(null);

  let cursor = alignedStart + pad * DAY_MS;
  while (cursor <= end) {
    const key = dayKey(cursor);
    const b = pool.series?.days?.[key] || emptyBucket();
    cells.push({
      key,
      ts: cursor,
      tokens: (b.tin || 0) + (b.tout || 0),
      req: b.req || 0,
      ok: b.ok || 0,
    });
    cursor += DAY_MS;
  }
  // 尾部补齐整周，前端网格不会缺角
  while (cells.length % 7 !== 0) cells.push(null);

  const active = cells.filter((c) => c && c.tokens > 0);
  const scaleList = active.map((c) => c.tokens).sort((a, b) => a - b);
  const p90 = scaleList.length ? scaleList[Math.floor(scaleList.length * 0.9)] : 0;
  const max = scaleList.length ? scaleList[scaleList.length - 1] : 0;
  const scale = p90 || max || 1;

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  const totalReq = active.reduce((s, c) => s + c.req, 0);
  const totalTokens = active.reduce((s, c) => s + c.tokens, 0);
  const peak = active.reduce((best, c) => (!best || c.tokens > best.tokens ? c : best), null);

  return {
    weeks,
    scale,
    max,
    activeDays: active.length,
    totalReq,
    totalTokens,
    peak: peak ? { key: peak.key, tokens: peak.tokens, req: peak.req } : null,
    from: cells.find(Boolean)?.key || null,
    to: dayKey(end),
  };
}
