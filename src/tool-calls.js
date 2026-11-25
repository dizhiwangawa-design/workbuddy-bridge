import { createHash } from 'node:crypto';

const BAR = '\u{FF5C}\u{FF5C}';
const CALLS_OPEN = `<${BAR}DSML${BAR} calls>`;
const CALLS_CLOSE = `</${BAR}DSML${BAR} calls>`;
const INVOKE_PREFIX = `<${BAR}DSML${BAR} invoke`;
const INVOKE_CLOSE = `</${BAR}DSML${BAR} invoke>`;
const PARAMETER_PREFIX = `<${BAR}DSML${BAR} parameter`;
const PARAMETER_CLOSE = `</${BAR}DSML${BAR} parameter>`;
export const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export function structuredToolArgumentLimit(configuredBytes, hardBytes = DEFAULT_MAX_BUFFER_BYTES) {
  const configured = Number(configuredBytes);
  const hard = Number(hardBytes);
  return Math.max(1, Math.min(
    Number.isSafeInteger(configured) && configured > 0
      ? configured
      : DEFAULT_MAX_BUFFER_BYTES,
    Number.isSafeInteger(hard) && hard > 0
      ? hard
      : DEFAULT_MAX_BUFFER_BYTES,
  ));
}

function scanError(code, message) {
  return { code, message };
}

function longestPrefixSuffix(value, target) {
  const max = Math.min(value.length, target.length - 1);
  for (let size = max; size > 0; size -= 1) {
    if (value.slice(-size) === target.slice(0, size)) return size;
  }
  return 0;
}

function isPrefixOf(value, target) {
  return value.length < target.length && target.startsWith(value);
}

/** 全部 DSML 标记：任何一个出现在正文里都说明信封结构串进了可见频道。 */
const DSML_MARKERS = [
  CALLS_OPEN,
  CALLS_CLOSE,
  INVOKE_PREFIX,
  INVOKE_CLOSE,
  PARAMETER_PREFIX,
  PARAMETER_CLOSE,
];

/** 结尾最多保留多少个字符，避免把一个跨分片到达的标记从中间切断。 */
function longestMarkerSuffix(value) {
  let keep = 0;
  for (const marker of DSML_MARKERS) {
    keep = Math.max(keep, longestPrefixSuffix(value, marker));
  }
  return keep;
}

/**
 * 从可见正文里剥掉没有归属的 DSML 标记。
 *
 * 模型偶尔会把信封的闭合标签（或残缺的开标签）写进正文，这些标记属于协议层，
 * 一旦流给客户端就是用户眼里的乱码。信封完整时走 `calls` 模式，根本进不到这里；
 * 所以这里只处理「正文里冒出来的孤儿标记」，且只删标记本身，不动周围文字。
 */
function stripOrphanMarkers(value) {
  if (!value) return value;
  let out = value;
  for (const closer of [CALLS_CLOSE, INVOKE_CLOSE, PARAMETER_CLOSE]) {
    if (!out.includes(closer)) continue;
    // 标记常常独占一行：连同行尾换行一起删，否则用户看到的只是「三行乱码」变成
    // 「三行空白」，正文尾部仍然多出一段突兀的空行。
    out = out.split(`${closer}\n`).join('').split(closer).join('');
  }
  // 残缺开标签连同它的属性一起删；找不到 '>' 就删到本次分片末尾。
  for (const opener of [INVOKE_PREFIX, PARAMETER_PREFIX]) {
    let at = out.indexOf(opener);
    while (at >= 0) {
      const end = out.indexOf('>', at + opener.length);
      out = out.slice(0, at) + (end >= 0 ? out.slice(end + 1) : '');
      at = out.indexOf(opener);
    }
  }
  return out;
}

function parseAttributes(source) {
  const attrs = {};
  const pattern = /([A-Za-z][\w-]*)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = pattern.exec(source))) attrs[match[1]] = match[2];
  return attrs;
}

function parseParameter(openTag, value) {
  const attrs = parseAttributes(openTag.slice(PARAMETER_PREFIX.length, -1));
  const name = String(attrs.name || '').trim();
  if (!name) {
    throw scanError('DSML_INVALID_INVOKE', 'DSML parameter is missing a name');
  }

  const stringMode = attrs.string === undefined ? 'true' : attrs.string;
  if (stringMode !== 'true' && stringMode !== 'false') {
    throw scanError('DSML_INVALID_INVOKE', 'DSML parameter has an invalid string mode');
  }
  if (stringMode === 'true') return [name, value];

  try {
    return [name, JSON.parse(value.trim())];
  } catch {
    throw scanError('DSML_INVALID_JSON', `DSML parameter "${name}" is not valid JSON`);
  }
}

function parseInvoke(openTag, body) {
  const attrs = parseAttributes(openTag.slice(INVOKE_PREFIX.length, -1));
  const name = String(attrs.name || '').trim();
  if (!name) {
    throw scanError('DSML_INVALID_INVOKE', 'DSML invoke is missing a tool name');
  }

  const input = {};
  let cursor = 0;
  while (cursor < body.length) {
    while (cursor < body.length && /\s/.test(body[cursor])) cursor += 1;
    if (cursor >= body.length) break;
    if (!body.startsWith(PARAMETER_PREFIX, cursor)) {
      throw scanError('DSML_INVALID_INVOKE', 'DSML invoke contains an unsupported element');
    }

    const openEnd = body.indexOf('>', cursor + PARAMETER_PREFIX.length);
    if (openEnd < 0) {
      throw scanError('DSML_INVALID_INVOKE', 'DSML parameter opening tag is malformed');
    }
    const closeStart = body.indexOf(PARAMETER_CLOSE, openEnd + 1);
    if (closeStart < 0) {
      throw scanError('DSML_INVALID_INVOKE', 'DSML parameter closing tag is missing');
    }

    const openTag = body.slice(cursor, openEnd + 1);
    if (!openTag.endsWith('>') || openTag.includes('</')) {
      throw scanError('DSML_INVALID_INVOKE', 'DSML parameter opening tag is malformed');
    }
    const value = body.slice(openEnd + 1, closeStart);
    const [key, parsed] = parseParameter(openTag, value);
    input[key] = parsed;
    cursor = closeStart + PARAMETER_CLOSE.length;
  }

  return { name, input };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function argumentHash(input) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(input ?? {})))
    .digest('hex');
}

export function createDsmlScanner({
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
} = {}) {
  const limit = Number(maxBufferBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('maxBufferBytes must be a positive integer');
  }

  let mode = 'text';
  let buffer = '';
  let fatal = null;

  function fail(result, code, message) {
    fatal = scanError(code, message);
    buffer = '';
    result.visibleText = '';
    result.error = fatal;
    return result;
  }

  function process(result, final = false) {
    while (buffer.length) {
      if (mode === 'text') {
        const at = buffer.indexOf(CALLS_OPEN);
        if (at >= 0) {
          result.visibleText += stripOrphanMarkers(buffer.slice(0, at));
          buffer = buffer.slice(at + CALLS_OPEN.length);
          mode = 'calls';
          continue;
        }
        if (final) {
          result.visibleText += stripOrphanMarkers(buffer);
          buffer = '';
          return result;
        }
        // 保留尾部：可能是任意一个标记的前半截，等下一片补齐再判断。
        const keep = longestMarkerSuffix(buffer);
        result.visibleText += stripOrphanMarkers(buffer.slice(0, buffer.length - keep));
        buffer = buffer.slice(buffer.length - keep);
        return result;
      }

      const leading = buffer.match(/^\s+/)?.[0] || '';
      if (leading) {
        buffer = buffer.slice(leading.length);
        continue;
      }
      if (buffer.startsWith(CALLS_CLOSE)) {
        buffer = buffer.slice(CALLS_CLOSE.length);
        mode = 'text';
        continue;
      }
      if (!buffer.startsWith('<')) {
        return fail(result, 'DSML_INVALID_INVOKE', 'DSML calls envelope contains unexpected text');
      }
      if (!buffer.startsWith(INVOKE_PREFIX)) {
        if (
          isPrefixOf(buffer, CALLS_CLOSE)
          || isPrefixOf(buffer, INVOKE_PREFIX)
          || isPrefixOf(buffer, PARAMETER_PREFIX)
        ) {
          return result;
        }
        return fail(result, 'DSML_INVALID_INVOKE', 'DSML calls envelope contains an invalid element');
      }

      const openEnd = buffer.indexOf('>', INVOKE_PREFIX.length);
      if (openEnd < 0) return result;
      const closeStart = buffer.indexOf(INVOKE_CLOSE, openEnd + 1);
      if (closeStart < 0) return result;

      const openTag = buffer.slice(0, openEnd + 1);
      const body = buffer.slice(openEnd + 1, closeStart);
      try {
        result.calls.push(parseInvoke(openTag, body));
      } catch (error) {
        return fail(
          result,
          error.code || 'DSML_INVALID_INVOKE',
          error.message || 'DSML invoke is invalid',
        );
      }
      buffer = buffer.slice(closeStart + INVOKE_CLOSE.length);
    }
    return result;
  }

  function enforceLimit(result) {
    if (Buffer.byteLength(buffer, 'utf8') <= limit) return null;
    return fail(result, 'DSML_BUFFER_LIMIT', `DSML buffer exceeded ${limit} bytes`);
  }

  function hasPartialCallMarker() {
    if (mode !== 'text') return true;
    for (let index = buffer.lastIndexOf('<'); index >= 0;) {
      if (CALLS_OPEN.startsWith(buffer.slice(index))) return true;
      index = index === 0 ? -1 : buffer.lastIndexOf('<', index - 1);
    }
    return false;
  }

  return {
    push(chunk) {
      const result = { visibleText: '', calls: [], error: null };
      if (fatal) {
        result.error = fatal;
        return result;
      }
      buffer += String(chunk ?? '');

      if (mode === 'text') {
        const at = buffer.indexOf(CALLS_OPEN);
        if (at >= 0) {
          result.visibleText += buffer.slice(0, at);
          buffer = buffer.slice(at + CALLS_OPEN.length);
          mode = 'calls';
        } else {
          try {
            process(result);
          } catch (error) {
            return fail(
              result,
              error.code || 'DSML_INVALID_INVOKE',
              error.message || 'DSML parsing failed',
            );
          }
          if (result.error) return result;
          return enforceLimit(result) || result;
        }
      }

      const overflow = enforceLimit(result);
      if (overflow) return overflow;
      try {
        process(result);
      } catch (error) {
        return fail(
          result,
          error.code || 'DSML_INVALID_INVOKE',
          error.message || 'DSML parsing failed',
        );
      }
      if (result.error) return result;
      return enforceLimit(result) || result;
    },

    hasPendingCall() {
      return hasPartialCallMarker();
    },

    finish() {
      const result = { visibleText: '', calls: [], error: null };
      if (fatal) {
        result.error = fatal;
        return result;
      }
      if (mode === 'calls') {
        try {
          process(result);
        } catch (error) {
          return fail(
            result,
            error.code || 'DSML_INVALID_INVOKE',
            error.message || 'DSML parsing failed',
          );
        }
        if (result.error) return result;
        if (mode === 'calls') {
          buffer = '';
          result.error = scanError('DSML_TRUNCATED', 'DSML calls envelope ended before it was complete');
          fatal = result.error;
          return result;
        }
      }
      try {
        process(result, true);
      } catch (error) {
        return fail(
          result,
          error.code || 'DSML_INVALID_INVOKE',
          error.message || 'DSML parsing failed',
        );
      }
      return result;
    },
  };
}

export function createStructuredToolAssembler({
  maxBytes = DEFAULT_MAX_BUFFER_BYTES,
  maxCalls = 64,
} = {}) {
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('maxBytes must be a positive integer');
  }
  const callLimit = Number(maxCalls);
  if (!Number.isSafeInteger(callLimit) || callLimit <= 0) {
    throw new Error('maxCalls must be a positive integer');
  }
  const pending = new Map();
  let retainedBytes = 0;
  let fatal = null;

  function overflow() {
    fatal = Object.assign(new Error(`structured tool arguments exceeded ${limit} bytes`), {
      code: 'TOOL_ARGUMENT_LIMIT',
    });
    pending.clear();
    retainedBytes = 0;
    return fatal;
  }

  return {
    push(deltas = []) {
      if (fatal) throw fatal;
      // OpenAI 非流式的 message.tool_calls 不带 index 字段：整批都缺 index 时它们是
      // 「一组完整调用」而不是「一批分片」，必须按数组下标各占一个槽位，否则多个并行
      // 调用会被拼进同一条（名字串成 get_weatherget_time、参数拼成非法 JSON）。
      // 真正的流式分片可能分多批到达，只要批内有任何一个带整数 index，就沿用原槽位
      // 规则，绝不因为某批缺 index 就重新从 0 编号——那会把已有槽位覆盖掉。
      const positional = Array.isArray(deltas)
        && deltas.length > 0
        && !deltas.some((delta) => Number.isInteger(delta?.index));
      let position = 0;
      for (const delta of deltas) {
        const index = positional
          ? position
          : (Number.isInteger(delta?.index) ? delta.index : 0);
        position += 1;
        if (!pending.has(index) && pending.size >= callLimit) throw overflow();
        const current = pending.get(index) || {
          index,
          id: '',
          name: '',
          arguments: '',
        };
        const idPart = delta?.id ? String(delta.id) : '';
        const namePart = delta?.function?.name ? String(delta.function.name) : '';
        const argument = delta?.function?.arguments === undefined
          ? ''
          : String(delta.function.arguments ?? '');
        const addedBytes = Buffer.byteLength(idPart, 'utf8')
          + Buffer.byteLength(namePart, 'utf8')
          + Buffer.byteLength(argument, 'utf8');
        if (retainedBytes + addedBytes > limit) throw overflow();
        current.id += idPart;
        current.name += namePart;
        if (delta?.function?.arguments !== undefined) {
          current.arguments += argument;
        }
        retainedBytes += addedBytes;
        pending.set(index, current);
      }
    },

    hasPending() {
      return pending.size > 0;
    },

    snapshot() {
      const calls = [];
      for (const item of [...pending.values()].sort((a, b) => a.index - b.index)) {
        if (!item.name || !item.arguments.trim()) continue;
        try {
          const input = JSON.parse(item.arguments);
          if (input && typeof input === 'object' && !Array.isArray(input)) {
            calls.push({ id: item.id, name: item.name, input });
          }
        } catch {
          // A partial JSON argument is intentionally not executable.
        }
      }
      return calls;
    },

    retain() {
      return [...pending.values()].map((item) => ({ ...item }));
    },

    finish() {
      const calls = [];
      const invalid = [];
      const ordered = [...pending.values()].sort((a, b) => a.index - b.index);
      for (const item of ordered) {
        const name = String(item.name || '').trim();
        if (!name) {
          invalid.push({ index: item.index, reason: 'missing tool name' });
          continue;
        }
        let input = {};
        if (item.arguments.trim()) {
          try {
            input = JSON.parse(item.arguments);
          } catch {
            invalid.push({ index: item.index, reason: 'arguments are not valid JSON' });
            continue;
          }
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          invalid.push({ index: item.index, reason: 'arguments must be a JSON object' });
          continue;
        }
        calls.push({
          id: String(item.id || '').trim(),
          name,
          input,
        });
      }
      pending.clear();
      retainedBytes = 0;
      return { calls, invalid };
    },
  };
}

function choiceIsNone(toolChoice) {
  return toolChoice === 'none' || toolChoice?.type === 'none';
}

function normalizeToolIds(calls, requestId, usedIds) {
  const used = usedIds || new Set();
  return calls.map((call, ordinal) => {
    let id = String(call.id || '').trim();
    if (!id || used.has(id)) id = `toolu_${requestId}_${ordinal}`;
    let suffix = ordinal;
    while (used.has(id)) {
      suffix += 1;
      id = `toolu_${requestId}_${suffix}`;
    }
    used.add(id);
    return { ...call, id };
  });
}

export function arbitrateToolCalls({
  structured = { calls: [], invalid: [] },
  dsml = [],
  toolsDeclared = false,
  toolChoice = 'auto',
  model = '',
  requestId = '',
  account = '',
  allowedToolNames = null,
}) {
  if (!toolsDeclared || choiceIsNone(toolChoice)) {
    return { calls: [], source: 'cleaned-only', warning: null };
  }

  const valid = structured.calls || [];
  const fallback = Array.isArray(dsml) ? dsml : [];
  let source = 'cleaned-only';
  let calls = [];
  let warning = null;

  if (valid.length) {
    source = 'structured';
    calls = valid;
    if (fallback.length) {
      warning = {
        code: 'DUAL_TOOL_FORMAT',
        model,
        requestId,
        account,
        structuredCount: valid.length,
        dsmlCount: fallback.length,
        argumentHashes: fallback.map((call) => argumentHash(call.input)),
      };
    }
  } else if (fallback.length) {
    source = 'dsml';
    calls = fallback;
  }

  if (allowedToolNames instanceof Set && allowedToolNames.size) {
    calls = calls.filter((call) => allowedToolNames.has(call.name));
  }
  if (!calls.length) source = 'cleaned-only';
  calls = normalizeToolIds(calls, requestId || 'message', undefined);
  return { calls, source, warning };
}
