/**
 * TUI 输出解析。
 *
 * 登录链接是最难拿的一环：codebuddy 的登录界面基于 Ink 渲染，
 * 长 URL 会被折行，还会夹带重绘产生的重复内容。
 * 所以这里按可靠性从高到低做三层提取：
 *   1. OSC 8 超链接（终端里可点击的链接，包着完整 URL，不会折行）
 *   2. 折行拼接（上一行以 ? & = / 结尾时把下一行接上）
 *   3. 整段去空白后宽松匹配
 */

const ANSI_RE = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|'),
  'g',
);

export function stripAnsi(input) {
  return String(input).replace(ANSI_RE, '');
}

/** OSC 8: ESC ] 8 ; params ; URI ST */
const OSC8_RE = /\u001B\]8;[^;]*;(https?:\/\/[^\u0007\u001B]+)(?:\u0007|\u001B\\)/g;

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;

// 折行后被 UI 文案粘在 URL 尾巴上的常见词，做一次兜底清洗。
// 这些词来自 codebuddy 登录界面的固定文案，顺序按长度降序以免被短词抢先匹配。
const TAIL_NOISE =
  /(Waitingforauthentication|Waitingforauth|Copiedlinktoclipboard|Copiedtoclipboard|Browserdidn'?topensee|Usetheurlbelow|PressESCtocancel|PressESC|Waiting|Copied|Press|ESC|Cancel|signin)+$/i;

function cleanTail(url) {
  let out = String(url);

  // Ink 重绘可能把同一个链接输出多次且中间没有分隔，取第一个
  const second = out.indexOf('http', 1);
  if (second > 0) out = out.slice(0, second);

  out = out.replace(TAIL_NOISE, '');
  out = out.replace(/[.,;:!?)]+$/, '');
  return out;
}

/** 过滤 UI 里那种被省略号截断的展示链接（xxx/...） */
function isTruncatedDisplay(u) {
  return /\.\.\.$/.test(u) || u.length < 12;
}

/**
 * 从一段原始输出里提取候选登录链接，按可信度（长度）排序去重返回。
 */
export function extractUrls(raw) {
  const text = String(raw);
  const found = [];

  // 1. OSC 8：终端超链接，URL 完整且不会被折行切开
  for (const m of text.matchAll(OSC8_RE)) {
    if (m[1]) found.push(cleanTail(m[1]));
  }

  const plain = stripAnsi(text).replace(/\r/g, '');

  // 2. 去掉换行后整体匹配：Ink 折行不会插入空格，拼起来就是完整 URL
  const squeezed = plain.replace(/[\r\n]+/g, '');
  for (const m of squeezed.matchAll(URL_RE)) {
    found.push(cleanTail(m[0]));
  }

  // 3. 逐行匹配补漏（URL 后面直接跟了其他文字时第 2 步可能吃掉尾巴）
  for (const line of plain.split('\n')) {
    for (const m of line.matchAll(URL_RE)) {
      found.push(cleanTail(m[0]));
    }
  }

  const seen = new Set();
  const out = [];
  for (const u of found) {
    if (!u || isTruncatedDisplay(u)) continue;
    if (!/^https?:\/\/[^/\s]+/.test(u)) continue;
    const key = u.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  // 长的更可能是完整链接（短的往往是折行残片或 UI 省略展示）
  return out.sort((a, b) => b.length - a.length);
}

export function pickLoginUrl(raw) {
  const urls = extractUrls(raw);
  return urls.length ? urls[0] : null;
}

/** 去掉 ANSI 与多余空白，用于状态机判断关键词。 */
export function readable(raw) {
  return stripAnsi(String(raw))
    .replace(/\r/g, '')
    .replace(/\u001B\][^\u0007]*\u0007/g, '')
    .replace(/[ \t]+/g, ' ');
}

/** 滑动窗口，只保留最近 n 个字符，避免长任务把内存吃满。 */
export class TailBuffer {
  constructor(limit = 20000) {
    this.limit = limit;
    this.buf = '';
  }

  push(chunk) {
    this.buf += chunk;
    if (this.buf.length > this.limit) {
      this.buf = this.buf.slice(this.buf.length - this.limit);
    }
    return this.buf;
  }

  get text() {
    return this.buf;
  }
}
