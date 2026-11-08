import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../api-errors.js';
import {
  UPSTREAM_LENGTH_LIMIT,
  MAX_RETAINED_TEXT_BYTES,
  createTextCache,
} from '../stream-control.js';
import { outputFromPartial } from '../responses-store.js';
import { resolveReasoningEffort } from '../reasoning-effort.js';
import { withContinuationNudge } from '../continuation-nudge.js';

const SUPPORTED_TOOL_TYPES = new Set([
  'function',
  'custom',
  'namespace',
  'local_shell',
  'shell',
  'apply_patch',
]);

function bad(message, code = 'invalid_request') {
  return new ApiError(400, message, { type: 'invalid_request_error', code });
}

function random(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function stableHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function shorten(value, limit = 64) {
  const name = String(value);
  if (name.length <= limit) return name;
  const hash = stableHash(name);
  const head = name.slice(0, Math.max(1, limit - hash.length - 1));
  return `${head}-${hash}`;
}

export function responseMessage(content = '', status = 'completed') {
  return {
    id: random('msg'),
    type: 'message',
    status,
    role: 'assistant',
    content: [{ type: 'output_text', text: String(content), annotations: [] }],
  };
}

export function reasoningItem(summary = '', status = 'completed') {
  return {
    id: random('rs'),
    type: 'reasoning',
    status,
    summary: summary
      ? [{ type: 'summary_text', text: String(summary) }]
      : [],
  };
}

export function emptyCompletedReasoning() {
  return reasoningItem('', 'completed');
}

function toolOutput(item, status = 'completed') {
  if (['message', 'reasoning'].includes(item?.type)) return item;
  const id = item?.id || random(['function_call', 'local_shell_call', 'custom_tool_call'].includes(item?.type) ? 'fc' : 'ctc');
  if (item?.type === 'custom_tool_call') return {
    id,
    type: 'custom_tool_call',
    status,
    call_id: item.call_id,
    name: item.name,
    input: typeof item.input === 'string' ? item.input : String(item.input ?? ''),
  };
  if (item?.type === 'function_call') return {
    id,
    type: 'function_call',
    status,
    call_id: item.call_id,
    name: item.name,
    arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
    ...(item.namespace ? { namespace: item.namespace } : {}),
  };
  return { ...item, id, status };
}

export function baseResponse({
  id,
  model,
  createdAt,
  status = 'in_progress',
  output = [],
  usage = null,
  incomplete = null,
  error = null,
  store = true,
  previousResponseId = null,
  request = null,
}) {
  const requestBody = request?.body || {};
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    background: false,
    error,
    incomplete_details: incomplete,
    instructions: typeof requestBody.instructions === 'string'
      ? requestBody.instructions
      : null,
    max_output_tokens: request?.requestedMax ? request.maxOutputTokens : null,
    max_tool_calls: null,
    model,
    output,
    parallel_tool_calls: request?.parallelToolCalls !== false,
    previous_response_id: previousResponseId,
    prompt_cache_key: null,
    reasoning: { effort: request?.forwardedEffort ?? null, summary: null },
    safety_identifier: null,
    service_tier: 'default',
    store: Boolean(store),
    temperature: requestBody.temperature ?? null,
    text: { format: { type: 'text', format: null }, verbosity: 'medium' },
    tool_choice: request?.requestedToolChoice ?? request?.toolChoice ?? 'auto',
    tools: [],
    top_logprobs: 0,
    top_p: requestBody.top_p ?? null,
    truncation: requestBody.truncation ?? 'disabled',
    usage,
    user: requestBody.user ?? null,
    metadata: requestBody.metadata && typeof requestBody.metadata === 'object'
      ? requestBody.metadata
      : {},
  };
}

export function responseUsage(prompt = 0, completion = 0, reasoning = 0) {
  const input = Math.max(0, Number(prompt || 0));
  const output = Math.max(0, Number(completion || 0));
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: Math.max(0, Number(reasoning || 0)) },
    total_tokens: input + output,
  };
}

/** Serialize only a bounded, deduplicated tail of a Responses SSE stream. */
export function loopbackSse(responseId, events) {
  const picked = new Map();
  for (const event of events || []) {
    const data = event?.data;
    if (!data || typeof data !== 'object') continue;
    const delta = data.type === 'response.output_text.delta'
      ? String(data.delta || '')
      : '';
    if (!delta) continue;
    const key = data.item_id || `${data.output_index}:${data.content_index}`;
    const previous = picked.get(key) || { itemId: data.item_id, text: '', sequence: data.sequence_number };
    previous.text += delta;
    previous.sequence = data.sequence_number;
    picked.set(key, previous);
  }
  const block = [];
  for (const [key, item] of picked) {
    const data = {
      type: 'response.output_text.delta',
      sequence_number: item.sequence,
      item_id: item.itemId || key,
      output_index: 0,
      content_index: 0,
      delta: item.text.slice(-8192),
    };
    block.push(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  return block.join('');
}

function functionDeclaration(name, description, parameters, extra = {}) {
  return {
    type: 'function',
    function: {
      name,
      description: description || '',
      parameters: parameters || { type: 'object', properties: {} },
    },
    ...extra,
  };
}

export function convertResponsesTools(input) {
  if (input === undefined) return { tools: [], registry: new Map(), names: new Set() };
  if (!Array.isArray(input)) throw bad('tools must be an array');
  const tools = [];
  const registry = new Map();
  const names = new Set();

  for (const [index, tool] of input.entries()) {
    if (!tool || typeof tool !== 'object') throw bad(`tools[${index}] must be an object`);
    const type = String(tool.type || '');
    if (type === 'custom' && tool.name === 'apply_patch') {
      // The canonical Codex custom tool may be followed by its host counterpart.
    } else if (!SUPPORTED_TOOL_TYPES.has(type)) {
      throw bad(`tools[${index}] type ${type || '(missing)'} is not supported`, 'unsupported_tool_type');
    }
    if (type === 'namespace') {
      if (!String(tool.name || '').trim() || !Array.isArray(tool.tools)) {
        throw bad(`tools[${index}] namespace needs name and tools`, 'unsupported_tool_type');
      }
      for (const [childIndex, child] of tool.tools.entries()) {
        if (!['function', 'custom', 'shell', 'apply_patch'].includes(child?.type)) {
          throw bad(
            `tools[${index}].tools[${childIndex}] type is not supported`,
            'unsupported_tool_type',
          );
        }
        const namespace = String(tool.name).trim();
        const realName = String(child.name || '').trim();
        if (!realName) throw bad(`tools[${index}].tools[${childIndex}] needs a name`);
        const flattened = shorten(`${namespace}__${realName}`);
        const custom = child.type === 'custom' || child.type === 'apply_patch';
        const parameters = custom
          ? {
              type: 'object',
              properties: { input: { type: 'string' } },
              required: ['input'],
              additionalProperties: false,
            }
          : child.parameters || { type: 'object', properties: {} };
        const declaration = functionDeclaration(
          flattened,
          custom
            ? `${child.description || ''}\nReturn the complete free-form payload in input.`
            : child.description,
          parameters,
        );
        tools.push(declaration);
        registry.set(flattened, {
          kind: custom ? 'custom' : 'function',
          name: realName,
          namespace,
          flattened,
          declaration,
        });
        names.add(flattened);
        names.add(realName);
      }
      continue;
    }

    const name = type === 'apply_patch'
      ? 'apply_patch'
      : String(tool.name || type).trim();
    if (!name) throw bad(`tools[${index}] needs a name`);
    const custom = type === 'custom' || type === 'apply_patch';
    const shell = type === 'shell' || type === 'local_shell';
    const parameters = custom
      ? {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
          additionalProperties: false,
        }
      : shell
        ? (tool.parameters || {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          })
        : (tool.parameters || { type: 'object', properties: {} });
    const description = [
      tool.description,
      custom ? 'Put the complete free-form tool payload in the input string.' : '',
      tool.format?.definition ? `Grammar:\n${tool.format.definition}` : '',
    ].filter(Boolean).join('\n');
    const declaration = functionDeclaration(
      shorten(name),
      description,
      parameters,
    );
    tools.push(declaration);
    registry.set(declaration.function.name, {
      kind: custom ? 'custom' : type,
      name,
      namespace: null,
      flattened: declaration.function.name,
      declaration,
    });
    names.add(declaration.function.name);
    names.add(name);
  }
  return { tools, registry, names };
}

function contentPart(item, phase) {
  if (item?.file_id !== undefined) {
    throw bad('file_id content is not supported', 'file_id_not_supported');
  }
  if (item?.type === 'input_text') {
    if (typeof item.text !== 'string') throw bad(`${phase} input_text needs text`);
    return { type: 'text', text: item.text };
  }
  if (item?.type === 'input_image' || item?.type === 'image_url') {
    const url = typeof item.image_url === 'string'
      ? item.image_url
      : item.image_url?.url || item.url;
    if (typeof url !== 'string' || !url.trim()) {
      throw bad(`${phase} image needs a URL or data URL`, 'image_url_required');
    }
    return { type: 'image_url', image_url: { url } };
  }
  if (item?.type === 'output_text') return { type: 'text', text: String(item.text || '') };
  if (item?.type === 'refusal') return { type: 'text', text: String(item.refusal || '') };
  throw bad(`${phase} content type ${item?.type || '(missing)'} is not supported`);
}

function contentValue(content, phase) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw bad(`${phase}.content must be text or an array`);
  const parts = content.map((item) => contentPart(item, phase));
  const images = parts.some((item) => item.type === 'image_url');
  if (!images) return parts.map((item) => item.text).join('\n');
  return parts;
}

function callId(item, fallback) {
  return String(item.call_id || item.id || fallback).trim();
}

function toolInputForHistory(item) {
  if (item?.type === 'custom_tool_call') {
    return JSON.stringify({ input: String(item.input ?? '') });
  }
  return typeof item?.arguments === 'string'
    ? item.arguments
    : JSON.stringify(item?.arguments ?? item?.action ?? {});
}

function toolNameForHistory(item) {
  const explicit = String(item?.name || '').trim();
  if (explicit) return explicit;
  const byType = {
    local_shell: 'local_shell',
    local_shell_call: 'local_shell',
    shell: 'shell',
    shell_call: 'shell',
  };
  return String(byType[item?.type] || '').trim();
}

function replayHistory(input) {
  const rows = Array.isArray(input) ? input : [];
  const messages = [];
  const calls = new Map();
  const outputs = new Map();
  const positions = new Map();
  let order = 0;

  function callRecord(item) {
    const id = callId(item, `hist_${order}`);
    const name = toolNameForHistory(item);
    return {
      id,
      type: 'function',
      function: { name, arguments: toolInputForHistory(item) },
    };
  }

  for (const [position, item] of rows.entries()) {
    if (!item || typeof item !== 'object') throw bad(`input[${position}] must be an object`);
    order += 1;
    const type = String(item.type || '');
    if (type === 'message' && Array.isArray(item.content)) {
      const callChildren = [];
      for (const child of item.content) {
        if (!['function_call', 'custom_tool_call', 'local_shell_call', 'shell_call'].includes(child?.type)) continue;
        const id = callId(child, `embedded_${order}`);
        calls.set(id, callRecord(child));
        positions.set(id, position);
        callChildren.push(child);
      }
      if (callChildren.length) {
        const content = item.content.filter((child) => !callChildren.includes(child));
        if (content.length) {
          const role = item.role === 'developer' ? 'system' : item.role;
          messages.push({ role, content: contentValue(content, `input[${position}]`), position });
        }
        continue;
      }
    }
    if (type === 'message' || (!type && typeof item.role === 'string')) {
      const role = item.role === 'developer' ? 'system' : item.role;
      if (!['system', 'assistant', 'user'].includes(role)) throw bad(`input[${position}] role is not supported`);
      messages.push({
        role,
        content: contentValue(item.content, `input[${position}]`),
        position,
      });
      continue;
    }
    if (type === 'function_call' || type === 'custom_tool_call'
      || type === 'local_shell_call' || type === 'shell_call') {
      const id = callId(item, `call_${order}`);
      calls.set(id, callRecord(item));
      positions.set(id, position);
      continue;
    }
    if (type.endsWith('_output')) {
      const id = String(item.call_id || '').trim();
      if (!id) throw bad(`input[${position}].call_id is required`);
      outputs.set(id, {
        role: 'tool',
        tool_call_id: id,
        content: typeof item.output === 'string'
          ? item.output
          : JSON.stringify(item.output ?? item.content ?? ''),
      });
      positions.set(id, position);
      continue;
    }
    if (type === 'reasoning') continue;
    if (typeof item.text === 'string') {
      messages.push({ role: 'user', content: item.text, position });
      continue;
    }
    throw bad(`input[${position}] type ${type || '(missing)'} is not supported`);
  }

  const blocks = new Map();
  for (const [id, call] of calls) {
    if (!call.function.name) throw bad(`tool history has no name for ${id}`);
    blocks.set(id, {
      position: positions.get(id),
      messages: [{ role: 'assistant', content: null, tool_calls: [call] }],
      hasOutput: outputs.has(id),
    });
  }
  for (const [id, output] of outputs) {
    const block = blocks.get(id);
    if (!block) throw bad(`tool output references unknown call_id: ${id}`);
    block.messages.push(output);
    block.hasOutput = true;
  }
  const result = messages.map(({ position, ...message }) => ({ message, position }));
  for (const block of blocks.values()) result.push({ messages: block.messages, position: block.position });
  result.sort((a, b) => a.position - b.position);
  const flattened = [];
  for (const block of result) flattened.push(...(block.messages || [block.message]));
  return flattened;
}

export function prepareResponsesRequest(body, {
  defaultModel = 'deepseek-v4.1-flash',
  toolsEnabled = true,
  history = [],
  continuationNudge = true,
} = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be a JSON object');
  const model = String(body.model || defaultModel || '').trim();
  if (!model) throw bad('model must not be empty');
  const messages = [];
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }
  const rawInput = body.input === undefined ? [] : body.input;
  const input = typeof rawInput === 'string'
    ? [{ type: 'message', role: 'user', content: rawInput }]
    : rawInput;
  if (!Array.isArray(input)) throw bad('input must be a string or array');
  messages.push(...replayHistory([...history, ...input]));
  if (!messages.length) throw bad('input must contain at least one message');

  const converted = convertResponsesTools(body.tools || []);
  if (converted.tools.length && !toolsEnabled) {
    throw bad('tool support is disabled', 'tools_disabled');
  }
  const allowed = Array.isArray(body.allowed_tools)
    ? new Set(body.allowed_tools.flatMap((item) => {
        const name = String(item?.name || item);
        if (!item?.namespace) return [name];
        return [
          name,
          `${item.namespace}.${name}`,
          `${item.namespace}__${name}`,
        ];
      }))
    : null;
  const tools = allowed
    ? converted.tools.filter((item) => {
        const entry = converted.registry.get(item.function.name);
        return allowed.has(item.function.name)
          || entry && (
            allowed.has(entry.name)
            || allowed.has(`${entry.namespace}.${entry.name}`)
            || allowed.has(`${entry.namespace}__${entry.name}`)
            || allowed.has(entry.namespace)
          );
      })
    : converted.tools;
  const restricted = new Set(tools.map((item) => item.function.name));
  const registry = new Map([...converted.registry].filter(([name]) => restricted.has(name)));

  if (
    body.parallel_tool_calls !== undefined
    && body.parallel_tool_calls !== null
    && typeof body.parallel_tool_calls !== 'boolean'
  ) {
    throw bad('parallel_tool_calls must be boolean');
  }
  if (body.reasoning !== undefined) {
    if (!body.reasoning || typeof body.reasoning !== 'object' || Array.isArray(body.reasoning)) {
      throw bad('reasoning must be an object');
    }
  }
  const requestedEffort = body.reasoning?.effort === undefined
    || body.reasoning?.effort === null
    ? null
    : String(body.reasoning.effort).trim().toLowerCase();
  resolveReasoningEffort(requestedEffort, null);
  let choice = body.tool_choice;
  if (typeof choice === 'string' && !['auto', 'none', 'required'].includes(choice)) {
    throw bad('tool_choice must be auto, none, required or a tool selector');
  }
  if (choice === 'required' && !tools.length) throw bad('tool_choice requires at least one tool');
  if (choice && typeof choice === 'object') {
    if (
      choice.type !== undefined
      && !['function', 'custom', 'apply_patch', 'shell', 'local_shell'].includes(choice.type)
    ) {
      throw bad(`tool_choice type ${choice.type || '(missing)'} is not supported`);
    }
    const builtin = ['apply_patch', 'shell', 'local_shell'].includes(choice.type) ? choice.type : '';
    const chosen = String(builtin || choice.name || choice.function?.name || '');
    if (!chosen) throw bad('tool_choice must name a tool');
    const match = lookupRegistry(registry, chosen);
    if (!match) throw bad(`tool_choice references unknown tool: ${chosen}`);
    choice = { type: 'function', function: { name: match.key } };
  }

  const outbound = {
    model,
    // 带工具时补一条回合约束：没有工具调用的纯文字回复会被 codex / dsh 当作
    // 任务结束，导致模型只描述下一步就交还控制权。
    messages: withContinuationNudge(messages, {
      tools: tools.length,
      enabled: continuationNudge,
    }),
    stream: true,
  };
  const max = body.max_output_tokens;
  if (max !== undefined) {
    const value = Number(max);
    if (!Number.isSafeInteger(value) || value <= 0) throw bad('max_output_tokens must be a positive integer');
    outbound.max_tokens = value;
  }
  for (const field of ['temperature', 'top_p', 'user']) {
    if (body[field] !== undefined) outbound[field] = body[field];
  }
  const format = body.text?.format;
  if (format?.type === 'json_object') outbound.response_format = { type: 'json_object' };
  if (format?.type === 'json_schema') {
    outbound.response_format = {
      type: 'json_schema',
      json_schema: format.schema || format.json_schema || {},
    };
  }
  if (tools.length) {
    outbound.tools = tools;
    if (choice !== undefined) outbound.tool_choice = choice;
  }
  return {
    body: outbound,
    model,
    tools: registry,
    toolNames: new Set([
      ...registry.keys(),
      ...registry.values().flatMap((item) => [
        item.name,
        item.namespace ? `${item.namespace}.${item.name}` : null,
        item.namespace ? `${item.namespace}__${item.name}` : null,
      ].filter(Boolean)),
    ]),
    toolsDeclared: tools.length > 0,
    toolChoice: choice || 'auto',
    requestedToolChoice: body.tool_choice === undefined ? 'auto' : body.tool_choice,
    parallelToolCalls: body.parallel_tool_calls !== false,
    requestedMax: max !== undefined,
    maxOutputTokens: max,
    requestedEffort,
    forwardedEffort: null,
    store: body.store === true,
  };
}

function publicId(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(-128);
}

function lookupRegistry(registry, rawName) {
  const name = String(rawName || '').trim();
  if (registry.has(name)) return { key: name, entry: registry.get(name) };
  const candidates = [...registry.entries()].filter(([, entry]) => (
    entry.name === name || entry.flattened === name || entry.flattened.endsWith(`-${stableHash(name)}`)
  ));
  if (name.length > 64) {
    for (const [flattened, entry] of registry) {
      if (flattened.endsWith(`-${stableHash(name)}`) && (name.endsWith(entry.name) || name.includes(entry.name))) {
        candidates.push([flattened, entry]);
      }
    }
  }
  const unique = [...new Map(candidates).values()];
  return unique.length === 1
    ? { key: [...registry].find(([, value]) => value === unique[0])[0], entry: unique[0] }
    : null;
}

export function responseCallItems(calls, registry) {
  return (calls || []).map((call) => {
    const match = lookupRegistry(registry, call.name);
    const entry = match?.entry;
    const id = random('fc');
    if (entry?.kind === 'custom') {
      const input = typeof call.input?.input === 'string'
        ? call.input.input
        : JSON.stringify(call.input ?? {});
      return {
        id,
        type: 'custom_tool_call',
        status: 'completed',
        call_id: call.id || random('call'),
        name: entry.name,
        input,
      };
    }
    const name = entry?.name || String(call.name || '').slice(0, 128);
    return {
      id,
      type: 'function_call',
      status: 'completed',
      call_id: call.id || random('call'),
      name,
      arguments: JSON.stringify(call.input ?? {}),
      ...(entry?.namespace ? { namespace: entry.namespace } : {}),
    };
  });
}

export function outputForResult({
  reasoning = '',
  content = '',
  calls = [],
  registry = new Map(),
  status = 'completed',
} = {}) {
  const output = [];
  if (reasoning) output.push(reasoningItem(reasoning, status));
  if (content || !calls.length) output.push(responseMessage(content, status));
  output.push(...responseCallItems(calls, registry));
  return output;
}

export function completedResponseBody({
  id = random('resp'),
  model,
  createdAt = Math.floor(Date.now() / 1000),
  prior = [],
  reasoning = '',
  content = '',
  calls = [],
  registry = new Map(),
  usage = {},
  finishReason = 'stop',
  requestedMax = false,
  actuallyLimited = false,
  canceled = false,
  error = null,
  store = false,
  previousResponseId = null,
  request = null,
}) {
  let status = error ? 'failed' : canceled
    ? 'incomplete'
    : finishReason === 'length' ? 'incomplete' : 'completed';
  const current = outputForResult({
    reasoning,
    content,
    calls,
    registry,
    status: status === 'completed' ? 'completed' : 'incomplete',
  });
  const incomplete = canceled
    ? { reason: 'canceled' }
    : finishReason === 'length'
      ? { reason: requestedMax && actuallyLimited ? 'max_output_tokens' : UPSTREAM_LENGTH_LIMIT }
      : null;
  return baseResponse({
    id,
    model,
    createdAt,
    status,
    output: [...prior, ...current],
    usage: responseUsage(usage.prompt_tokens, usage.completion_tokens, usage.reasoning_tokens),
    incomplete,
    error,
    store,
    previousResponseId,
    request,
  });
}

export function outputFromContext(ctx) {
  return outputForResult(ctx).map((item) => toolOutput(item));
}

export function resumedPrior(record) {
  if (!record?.body?.output) return [];
  return record.body.output.map((item) => {
    if (item.type === 'message') return responseMessage(
      item.content?.map((part) => part.text || '').join('') || '',
      'completed',
    );
    return { ...item, id: item.id || random('fc') };
  });
}

export function historyForResponse(record) {
  const storedInput = Array.isArray(record?.body?._bridgeInput)
    ? record.body._bridgeInput
    : [];
  const output = Array.isArray(record?.body?.output) ? record.body.output : [];
  const meta = record?.body?._bridgeMeta;
  const outputOffset = meta?.version === 1
    && Number.isSafeInteger(meta.outputOffset)
    && meta.outputOffset >= 0
    && meta.outputOffset <= output.length
    ? meta.outputOffset
    : 0;
  return [...storedInput, ...output.slice(outputOffset).map((item) => {
    if (item.type === 'reasoning') return emptyCompletedReasoning();
    return item;
  })];
}

/** Live stdout lifecycle for Responses SSE. Final output is emitted only at
 * completion so a partial tool argument can never become executable. */
export function createResponsesStreamEncoder({
  response,
  maxBytes = MAX_RETAINED_TEXT_BYTES,
  retain = 'tail',
}) {
  let sequence = 2;
  let reasoningItem = null;
  let messageItem = null;
  const reasoningText = createTextCache({ maxBytes, retain });
  const outputText = createTextCache({ maxBytes, retain });
  let outputIndex = Array.isArray(response.output) ? response.output.length : 0;
  const output = [];
  const event = (type, data) => ({
    type,
    data: { type, sequence_number: sequence++, ...data },
  });

  function reasoningDelta(delta) {
    if (!delta) return [];
    reasoningText.append(delta);
    if (!reasoningItem) {
      reasoningItem = reasoningItemFor(response.id);
      output.push(reasoningItem);
      return [
        event('response.output_item.added', {
          output_index: outputIndex,
          item: { ...reasoningItem, status: 'in_progress', summary: [] },
        }),
        event('response.reasoning_summary_part.added', {
          item_id: reasoningItem.id,
          output_index: outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        }),
        event('response.reasoning_summary_text.delta', {
          item_id: reasoningItem.id,
          output_index: outputIndex,
          summary_index: 0,
          delta,
        }),
      ];
    }
    return [event('response.reasoning_summary_text.delta', {
      item_id: reasoningItem.id,
      output_index: outputIndex,
      summary_index: 0,
      delta,
    })];
  }

  function textDelta(delta) {
    if (!delta) return [];
    outputText.append(delta);
    if (!messageItem) {
      messageItem = responseMessage('', 'in_progress');
      output.push(messageItem);
      outputIndex += reasoningItem ? 1 : 0;
      return [
        event('response.output_item.added', {
          output_index: outputIndex,
          item: { ...messageItem, content: [] },
        }),
        event('response.content_part.added', {
          item_id: messageItem.id,
          output_index: outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }),
        event('response.output_text.delta', {
          item_id: messageItem.id,
          output_index: outputIndex,
          content_index: 0,
          delta,
        }),
      ];
    }
    return [event('response.output_text.delta', {
      item_id: messageItem.id,
      output_index: outputIndex,
      content_index: 0,
      delta,
    })];
  }

  return {
    reasoningDelta,
    textDelta,
    snapshot() {
      return {
        reasoning: reasoningText.value(),
        content: outputText.value(),
        output: output.map((item) => ({ ...item })),
      };
    },
  };
}

function reasoningItemFor(responseId) {
  const item = reasoningItem('', 'in_progress');
  return { ...item, id: `${responseId}_reasoning` };
}

export function responseEvents({
  response,
  reasoning = '',
  content = '',
  calls = [],
  registry = new Map(),
  finishType = null,
} = {}) {
  let sequence = 0;
  const respond = (type, data) => ({ type, data: { type, ...data } });
  const output = response.output;
  const textIndex = output.findIndex((item) => item.type === 'message');
  const reasoningIndex = output.findIndex((item) => item.type === 'reasoning');
  const events = [];
  const push = (type, data) => events.push({
    type,
    data: { type, sequence_number: sequence++, ...data },
  });
  events.push(respond('response.created', {
    response: { ...response, status: 'in_progress', output: [] },
  }));
  events.push(respond('response.in_progress', {
    response: { ...response, status: 'in_progress', output: [] },
  }));
  if (reasoningIndex >= 0) {
    push('response.output_item.added', {
      output_index: reasoningIndex,
      item: { ...response.output[reasoningIndex], status: 'in_progress', summary: [] },
    });
    push('response.reasoning_summary_part.added', {
      item_id: response.output[reasoningIndex].id,
      output_index: reasoningIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
    push('response.reasoning_summary_text.delta', {
      item_id: response.output[reasoningIndex].id,
      output_index: reasoningIndex,
      summary_index: 0,
      delta: reasoning,
    });
    push('response.reasoning_summary_text.done', {
      item_id: response.output[reasoningIndex].id,
      output_index: reasoningIndex,
      summary_index: 0,
      text: reasoning,
    });
    push('response.reasoning_summary_part.done', {
      item_id: response.output[reasoningIndex].id,
      output_index: reasoningIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: reasoning },
    });
    push('response.output_item.done', {
      output_index: reasoningIndex,
      item: response.output[reasoningIndex],
    });
  }
  if (textIndex >= 0) {
    const item = response.output[textIndex];
    push('response.output_item.added', {
      output_index: textIndex,
      item: { ...item, status: 'in_progress', content: [] },
    });
    push('response.content_part.added', {
      item_id: item.id,
      output_index: textIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    if (content) push('response.output_text.delta', {
      item_id: item.id,
      output_index: textIndex,
      content_index: 0,
      delta: content,
    });
    push('response.output_text.done', {
      item_id: item.id,
      output_index: textIndex,
      content_index: 0,
      text: content,
    });
    push('response.content_part.done', {
      item_id: item.id,
      output_index: textIndex,
      content_index: 0,
      part: { type: 'output_text', text: content, annotations: [] },
    });
    push('response.output_item.done', {
      output_index: textIndex,
      item,
    });
  }
  const completedCalls = output
    .filter((item) => ['function_call', 'custom_tool_call'].includes(item.type))
    .slice(-calls.length);
  const callItems = completedCalls.length === calls.length
    ? completedCalls
    : responseCallItems(calls, registry);
  for (const [offset, item] of callItems.entries()) {
    const outputIndex = output.indexOf(item) >= 0
      ? output.indexOf(item)
      : offset + (reasoning ? 1 : 0) + (content || !calls.length ? 1 : 0);
    push('response.output_item.added', {
      output_index: outputIndex,
      item: item.type === 'custom_tool_call'
        ? { ...item, status: 'in_progress', input: '' }
        : { ...item, status: 'in_progress', arguments: '' },
    });
    if (item.type === 'custom_tool_call') {
      push('response.custom_tool_call_input.delta', {
        item_id: item.id,
        output_index: outputIndex,
        delta: item.input,
      });
      push('response.custom_tool_call_input.done', {
        item_id: item.id,
        output_index: outputIndex,
        input: item.input,
      });
    } else {
      push('response.function_call_arguments.delta', {
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      });
      push('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      });
    }
    push('response.output_item.done', {
      output_index: outputIndex,
      item,
    });
  }
  const finalType = finishType || (response.status === 'incomplete'
    ? 'response.incomplete'
    : 'response.completed');
  push(finalType, { response });
  return events;
}

export function partialFromAggregate(visible, calls, registry) {
  return {
    content: visible || '',
    toolCalls: (calls || []).map((call) => ({ ...call, input: call.input ?? {} })).filter((call) => {
      const match = lookupRegistry(registry, call.name);
      return Boolean(match);
    }),
  };
}

export function callsFromPartial(partial) {
  return partial?.toolCalls || [];
}

export function responseOutputFromStored(record) {
  return record?.body?.output || outputFromPartial(record?.partial || {});
}

export function responseBaseFromRecord(record) {
  if (!record?.body) return null;
  return { ...record.body, status: record.body.status || 'completed' };
}
