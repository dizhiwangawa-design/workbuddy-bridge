import { randomUUID } from 'node:crypto';
import { ApiError } from '../api-errors.js';

function requestError(message, code = 'invalid_request') {
  return new ApiError(400, message, {
    type: 'invalid_request_error',
    code,
  });
}

function textContent(content, messageIndex) {
  if (typeof content === 'string') return content;
  if (content === null) return '';
  if (!Array.isArray(content) || content.length === 0) {
    throw requestError(`messages[${messageIndex}].content must be text`);
  }
  const parts = [];
  let hasImage = false;
  for (const part of content) {
    if (part?.type === 'image_url') {
      if (part.file_id !== undefined) throw requestError('file_id images are not supported', 'file_id_not_supported');
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url !== 'string' || !url) {
        throw requestError(`messages[${messageIndex}] image_url needs a URL`);
      }
      hasImage = true;
      parts.push({ type: 'image_url', image_url: { url } });
      continue;
    }
    if (part?.type !== 'text' || typeof part.text !== 'string') {
      throw requestError(`messages[${messageIndex}] only supports text or image_url content`);
    }
    parts.push({ type: 'text', text: part.text });
  }
  return hasImage
    ? parts
    : parts.map((part) => part.text).join('\n');
}

function normalizeMessages(messages) {
  return messages.map((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw requestError(`messages[${index}] must be an object`);
    }
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) {
      throw requestError(`messages[${index}].role is not supported`);
    }
    if (message.role === 'tool') {
      const id = String(message.tool_call_id || '').trim();
      if (!id) throw requestError(`messages[${index}].tool_call_id is required`);
      const knownIds = new Set();
      for (let previous = index - 1; previous >= 0; previous -= 1) {
        const prior = messages[previous];
        if (prior?.role === 'assistant') {
          for (const call of prior.tool_calls || []) knownIds.add(call?.id);
          break;
        }
      }
      if (!knownIds.has(id)) {
        throw requestError(`messages[${index}].tool_call_id references unknown tool_call: ${id}`);
      }
    }
    const normalized = {
      role: message.role,
      content: textContent(message.content, index),
    };
    if (message.role === 'tool') normalized.tool_call_id = message.tool_call_id;
    if (message.role === 'assistant' && message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) {
        throw requestError(`messages[${index}].tool_calls must be an array`);
      }
      const ids = new Set();
      normalized.tool_calls = message.tool_calls.map((call, callIndex) => {
        const id = String(call?.id || '').trim();
        const name = String(call?.function?.name || '').trim();
        if (!id || !name) throw requestError(`messages[${index}].tool_calls[${callIndex}] requires id and name`);
        if (ids.has(id)) throw requestError(`duplicate assistant tool_call id: ${id}`);
        ids.add(id);
        return {
          id,
          type: 'function',
          function: {
            name,
            arguments: typeof call.function.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function.arguments ?? {}),
          },
        };
      });
    }
    return normalized;
  });
}

function toolDeclaration(tool, index) {
  if (tool?.type !== 'function') throw requestError(`tools[${index}] must have type function`);
  const name = String(tool.function?.name || '').trim();
  if (!name) throw requestError(`tools[${index}].function.name is required`);
  const parameters = tool.function.parameters ?? {
    type: 'object',
    properties: {},
  };
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw requestError(`tools[${index}].function.parameters must be an object`);
  }
  return {
    type: 'function',
    function: {
      name,
      description: typeof tool.function.description === 'string' ? tool.function.description : '',
      parameters,
    },
  };
}

function normalizeToolChoice(choice, tools) {
  if (choice === undefined) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (choice?.type !== 'function' || !String(choice.function?.name || '').trim()) {
    throw requestError('tool_choice must be auto, none, required or a named function');
  }
  const name = String(choice.function.name).trim();
  if (!tools.some((tool) => tool.function.name === name)) {
    throw requestError(`tool_choice references unknown function: ${name}`);
  }
  return { type: 'function', function: { name } };
}

export function prepareOpenAIRequest(body, {
  defaultModel = 'deepseek-v4.1-flash',
  toolsEnabled = true,
} = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw requestError('request body must be a JSON object');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw requestError('messages must be a non-empty array');
  }
  if (body.n !== undefined && body.n !== 1) {
    throw requestError('only n=1 is supported');
  }
  if (
    body.functions !== undefined
    || body.function_call !== undefined
  ) {
    throw requestError(
      'legacy functions are not supported by the current minimal OpenAI adapter',
      'tools_not_supported',
    );
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw requestError('tools must be an array');
  }
  if (body.tools?.length && !toolsEnabled) {
    throw requestError(
      'tool support is disabled',
      'tools_disabled',
    );
  }

  const model = String(body.model || defaultModel || '').trim();
  if (!model) throw requestError('model must not be empty');

  const tools = (body.tools || []).map(toolDeclaration);
  const names = new Set();
  for (const tool of tools) {
    if (names.has(tool.function.name)) {
      throw requestError(`duplicate tool name: ${tool.function.name}`);
    }
    names.add(tool.function.name);
  }
  const toolChoice = normalizeToolChoice(body.tool_choice, tools);
  if (toolChoice !== undefined && !tools.length) {
    throw requestError('tool_choice requires at least one tool');
  }

  const outbound = structuredClone(body);
  outbound.model = model;
  outbound.messages = normalizeMessages(body.messages);
  outbound.stream = true;
  delete outbound.stream_options;
  delete outbound.n;
  delete outbound.parallel_tool_calls;
  if (tools.length) {
    outbound.tools = tools;
    if (toolChoice !== undefined) outbound.tool_choice = toolChoice;
  } else {
    delete outbound.tools;
    delete outbound.tool_choice;
  }
  return {
    body: outbound,
    model,
    stream: body.stream === true,
    toolsDeclared: tools.length > 0,
    toolChoice: toolChoice || 'auto',
    toolNames: names,
  };
}

function eventUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens);
  const total = Number(usage.total_tokens);
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens: Number.isFinite(total)
      ? total
      : (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0),
  };
}

function textDelta(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (
      typeof part === 'string'
        ? part
        : part?.type === 'text' && typeof part.text === 'string'
          ? part.text
          : ''
    ))
    .join('');
}

export async function aggregateOpenAI(events) {
  const aggregate = {
    id: undefined,
    created: undefined,
    content: '',
    reasoning: '',
    toolCalls: new Map(),
    finishReason: undefined,
    usage: undefined,
  };

  for await (const raw of events) {
    if (raw === '[DONE]') break;
    let event = raw;
    if (typeof raw === 'string') {
      try {
        event = JSON.parse(raw);
      } catch {
        throw new ApiError(502, 'upstream returned malformed OpenAI SSE JSON', {
          type: 'api_error',
          code: 'upstream_protocol_error',
        });
      }
    }
    if (!event || typeof event !== 'object') {
      throw new ApiError(502, 'upstream returned an invalid OpenAI SSE document', {
        type: 'api_error',
        code: 'upstream_protocol_error',
      });
    }
    if (event.error) {
      throw new ApiError(502, String(event.error.message || 'WorkBuddy upstream error'), {
        type: 'api_error',
        code: 'upstream_error',
      });
    }

    aggregate.id ||= event.id;
    if (aggregate.created === undefined && Number.isFinite(Number(event.created))) {
      aggregate.created = Number(event.created);
    }
    aggregate.usage = eventUsage(event.usage) || aggregate.usage;
    const choice = Array.isArray(event.choices) ? event.choices[0] : null;
    if (!choice) continue;
    aggregate.finishReason = choice.finish_reason || aggregate.finishReason;
    const delta = choice.delta || choice.message || {};
    aggregate.content += textDelta(delta.content);
    if (typeof delta.reasoning_content === 'string') {
      aggregate.reasoning += delta.reasoning_content;
    }
    for (const [fallbackIndex, call] of (delta.tool_calls || []).entries()) {
      const index = call.index ?? fallbackIndex;
      const current = aggregate.toolCalls.get(index) || {
        id: undefined,
        name: '',
        arguments: '',
      };
      if (call.id) current.id = call.id;
      current.name += call.function?.name || '';
      current.arguments += call.function?.arguments || '';
      aggregate.toolCalls.set(index, current);
    }
  }

  return aggregate;
}

function conservativeTokens(value) {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value ?? ''), 'utf8') / 3));
}

export function toOpenAIResponse(aggregate, model, { now = Date.now } = {}) {
  const toolCalls = [...(aggregate.toolCalls?.values() || [])]
    .filter((call) => call.name)
    .map((call) => {
      let args = call.arguments || '{}';
      try {
        args = JSON.stringify(JSON.parse(args));
      } catch {
        // The strict assembler reports malformed calls before this encoder.
      }
      return {
        id: call.id || `call_${randomUUID().replaceAll('-', '')}`,
        type: 'function',
        function: { name: call.name, arguments: args },
      };
    });
  const hasTools = toolCalls.length > 0;
  const message = {
    role: 'assistant',
    content: hasTools && !aggregate.content ? null : aggregate.content || '',
  };
  if (hasTools) message.tool_calls = toolCalls;
  if (aggregate.reasoning) message.reasoning_content = aggregate.reasoning;
  if (aggregate.refusal) message.refusal = aggregate.refusal;

  const finishReason = {
    length: 'length',
    content_filter: 'content_filter',
    refusal: 'content_filter',
  }[aggregate.finishReason] || (hasTools && aggregate.finishReason !== 'length' ? 'tool_calls' : 'stop');

  const used = aggregate.usage || {};
  const promptTokens = Number(used.prompt_tokens ?? used.input_tokens);
  const completionTokens = Number(used.completion_tokens ?? used.output_tokens);
  const prompt = Number.isFinite(promptTokens)
    ? promptTokens
    : conservativeTokens(message.content);
  const completion = Number.isFinite(completionTokens)
    ? completionTokens
    : conservativeTokens(message.content);
  const total = Number(used.total_tokens);

  return {
    id: aggregate.id || `chatcmpl-${randomUUID().replaceAll('-', '')}`,
    object: 'chat.completion',
    created: Number.isFinite(aggregate.created)
      ? aggregate.created
      : Math.floor(now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: Number.isFinite(total) ? total : prompt + completion,
    },
  };
}

export function createChatEncoder({ id, model, created = Math.floor(Date.now() / 1000) }) {
  const responseId = id || `chatcmpl-${randomUUID().replaceAll('-', '')}`;
  let started = false;
  let finished = false;
  let toolIndex = null;
  let lastToolCount = 0;
  function chunk(delta, finishReason = null, usage) {
    const data = {
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: finishReason || Object.keys(delta || {}).length
        ? [{ index: 0, delta, logprobs: null, finish_reason: finishReason }]
        : [],
    };
    if (usage !== undefined) data.usage = usage;
    return { type: 'message', data };
  }
  return {
    get id() {
      return responseId;
    },
    start() {
      if (started) return [];
      started = true;
      return [chunk({ role: 'assistant', content: '' })];
    },
    textDelta(text) {
      if (!started || finished || !text) return [];
      return [chunk({ content: String(text) })];
    },
    reasoningDelta(text) {
      if (!started || finished || !text) return [];
      return [chunk({ reasoning_content: String(text) })];
    },
    toolDelta(calls = []) {
      if (!started || finished || !calls.length) return [];
      if (toolIndex === null) toolIndex = 0;
      const offset = toolIndex;
      toolIndex += calls.length;
      lastToolCount = calls.length;
      return [chunk({
        tool_calls: calls.map((call, index) => ({
          index: offset + index,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        })),
      })];
    },
    ping() {
      if (!started || finished) return [];
      return [chunk({}, null, null)];
    },
    finalize({ calls = [], finishReason, usage = null, canceled = false } = {}) {
      if (finished) return [];
      const events = started ? [] : this.start();
      for (const call of calls) {
        const deltas = this.toolDelta([call]);
        events.push(...deltas);
      }
      finished = true;
      const reason = calls.length || lastToolCount ? 'tool_calls' : finishReason === 'length'
        ? 'length'
        : finishReason === 'content_filter' || finishReason === 'refusal'
          ? 'content_filter'
          : 'stop';
      events.push(chunk({}, canceled ? 'stop' : reason, usage || undefined));
      // Client interruption closes with one legal stop and one sentinel;
      // timeouts are encoded separately and never use this path.
      events.push({ type: 'data', data: '[DONE]' });
      return events;
    },
    error(error) {
      if (finished) return [];
      finished = true;
      return [chunk({}, null, null), {
        type: 'message',
        data: {
          error: {
            type: error?.type || 'api_error',
            message: error?.message || 'upstream error',
            code: error?.code || null,
          },
        },
      }];
    },
  };
}

function modelRow(model) {
  const id = String(model.id || '').trim();
  if (!id || id === 'undefined') return null;
  return {
    id,
    object: 'model',
    created: 0,
    owned_by: 'workbuddy',
    name: model.name || id,
    context_window: model.maxInputTokens ?? null,
    max_output_tokens: model.maxOutputTokens ?? null,
  };
}

export function mapModelCatalogue(payload, {
  defaultModel = 'deepseek-v4.1-flash',
} = {}) {
  const rows = payload?.data?.models
    || payload?.models
    || (Array.isArray(payload?.data) ? payload.data : []);
  const mapped = rows.map(modelRow).filter(Boolean);
  if (mapped.length) {
    const seen = new Set();
    return mapped.filter((model) => {
      if (seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  }

  const ids = ['auto', defaultModel || 'deepseek-v4.1-flash'];
  return [...new Set(ids)].map((id) => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'workbuddy',
    name: id,
    context_window: null,
    max_output_tokens: null,
    wb_source: 'fallback',
  }));
}
