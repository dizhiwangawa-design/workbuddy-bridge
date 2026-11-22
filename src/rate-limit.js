/**
 * 429 的恢复时刻解析。
 *
 * 上游撞限流时会给出「什么时候能再来」，不同部署给的形式不一样：
 *   Retry-After: 120            秒数（RFC 9110 也允许 HTTP 日期）
 *   retry-after-ms: 120000      毫秒数
 *   x-ratelimit-reset: 1795...  epoch 秒（少数实现给毫秒）
 *   报文正文：「额度将在 2026-11-22 15:30:00 (UTC+8) 重置」
 *
 * 拿到真实时刻就不要再用指数退避猜：猜短了就是连续撞限流，
 * 猜长了是白白搁置一个已经恢复的号。
 */

const MAX_RESET_HORIZON_MS = 24 * 60 * 60 * 1000;

/** 把毫秒时间戳夹进「未来 24 小时内」，明显的脏数据直接丢弃。 */
function plausible(ts, now) {
  if (!Number.isFinite(ts) || ts <= now) return 0;
  if (ts - now > MAX_RESET_HORIZON_MS) return 0;
  return Math.round(ts);
}

function fromNumericHeader(value, now, { unit }) {
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 相对时长最大也就一天；比 1e9 大的一律当 epoch 时间戳（秒或毫秒）
  if (n > 1e11) return plausible(n, now);
  if (n > 1e9) return plausible(n * 1000, now);
  if (unit === 'ms') return plausible(now + n, now);
  return plausible(now + n * 1000, now);
}

/** 报文里的重置时刻。只认带年份的日期，避免把「5 分钟」误读成某个时刻。 */
export function resetAtFromText(text, now = Date.now()) {
  const body = String(text || '');
  if (!body) return 0;
  const match = body.match(
    /(?:reset|重置)[^0-9]{0,20}(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/i,
  ) || body.match(
    /(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?[^0-9]{0,12}(?:UTC|GMT)\s*([+-]\d{1,2})?/i,
  );
  if (!match) return 0;
  const [, y, mo, d, h, mi, s, offset] = match;
  const hours = offset === undefined || offset === '' ? 8 : Number(offset); // 报文默认 UTC+8
  if (!Number.isFinite(hours)) return 0;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
  return plausible(utc - hours * 3600000, now);
}

/**
 * 从响应头 + 报文里取冷却截止时刻（epoch ms）。取不到返回 0，调用方退回退避。
 * 多个来源同时存在时取最晚的那个：宁可多等，也不要提前再撞一次。
 */
export function resetAtFromResponse(headers, text = '', now = Date.now()) {
  const get = (name) => {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    return headers[name] ?? null;
  };
  const candidates = [
    parseRetryAfterDate(get('retry-after'), now),
    fromNumericHeader(get('retry-after-ms'), now, { unit: 'ms' }),
    fromNumericHeader(get('retry-after'), now, { unit: 's' }),
    fromNumericHeader(get('x-ratelimit-reset'), now, { unit: 's' }),
    fromNumericHeader(get('x-ratelimit-reset-requests'), now, { unit: 's' }),
    resetAtFromText(text, now),
  ];
  return candidates.reduce((best, value) => (value > best ? value : best), 0);
}

function parseRetryAfterDate(value, now) {
  if (value === null || value === undefined || value === '') return 0;
  // 纯数字走 numeric 分支，只有 HTTP 日期才会走到这里
  if (/^\s*[\d.]+\s*$/.test(String(value))) return 0;
  return plausible(Date.parse(String(value)), now);
}

/** 冷却时长上限：上游说多久就多久，但不接受明显离谱的值。 */
export const COOLDOWN_HORIZON_MS = MAX_RESET_HORIZON_MS;
