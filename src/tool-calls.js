import { createHash } from 'node:crypto';

const BAR = '\u{FF5C}\u{FF5C}';
const CALLS_OPEN = `<${BAR}DSML${BAR} calls>`;
const CALLS_CLOSE = `</${BAR}DSML${BAR} calls>`;
const INVOKE_PREFIX = `<${BAR}DSML${BAR} invoke`;
const INVOKE_CLOSE = `</${BAR}DSML${BAR} invoke>`;
const PARAMETER_PREFIX = `<${BAR}DSML${BAR} parameter`;
const PARAMETER_CLOSE = `</${BAR}DSML${BAR} parameter>`;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

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
          result.visibleText += buffer.slice(0, at);
          buffer = buffer.slice(at + CALLS_OPEN.length);
          mode = 'calls';
          continue;
        }
        if (final) {
          result.visibleText += buffer;
          buffer = '';
          return result;
        }
        const keep = longestPrefixSuffix(buffer, CALLS_OPEN);
        result.visibleText += buffer.slice(0, buffer.length - keep);
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

export function createStructuredToolAssembler() {
  const pending = new Map();

  return {
    push(deltas = []) {
      for (const delta of deltas) {
        const index = Number.isInteger(delta?.index) ? delta.index : 0;
        const current = pending.get(index) || {
          index,
          id: '',
          name: '',
          arguments: '',
        };
        if (delta?.id) current.id += String(delta.id);
        if (delta?.function?.name) current.name += String(delta.function.name);
        if (delta?.function?.arguments !== undefined) {
          current.arguments += String(delta.function.arguments ?? '');
        }
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
