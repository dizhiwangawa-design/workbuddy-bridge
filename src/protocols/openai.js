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
  if (!Array.isArray(content) || content.length === 0) {
    throw requestError(`messages[${messageIndex}].content must be text`);
  }
  const parts = [];
  for (const part of content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') {
      throw requestError(`messages[${messageIndex}] only supports text content`);
    }
    parts.push(part.text);
  }
  return parts.join('\n');
}

function normalizeMessages(messages) {
  return messages.map((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw requestError(`messages[${index}] must be an object`);
    }
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) {
      throw requestError(`messages[${index}].role is not supported`);
    }
    return {
      role: message.role,
      content: textContent(message.content, index),
    };
  });
}

export function prepareOpenAIRequest(body, {
  defaultModel = 'deepseek-v4-flash',
} = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw requestError('request body must be a JSON object');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw requestError('messages must be a non-empty array');
  }
  if (body.stream === true) {
    throw requestError(
      'streaming is not supported by the current minimal OpenAI adapter',
      'stream_not_supported',
    );
  }
  if (body.n !== undefined && body.n !== 1) {
    throw requestError('only n=1 is supported');
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    throw requestError(
      'tool calls are not supported by the current minimal OpenAI adapter',
      'tools_not_supported',
    );
  }
  if (Array.isArray(body.functions) && body.functions.length) {
    throw requestError(
      'legacy functions are not supported by the current minimal OpenAI adapter',
      'tools_not_supported',
    );
  }
  if (body.function_call !== undefined || body.tool_choice !== undefined) {
    throw requestError(
      'tool calls are not supported by the current minimal OpenAI adapter',
      'tools_not_supported',
    );
  }

  const model = String(body.model || defaultModel || '').trim();
  if (!model) throw requestError('model must not be empty');

  const outbound = structuredClone(body);
  outbound.model = model;
  outbound.messages = normalizeMessages(body.messages);
  outbound.stream = true;
  delete outbound.stream_options;
  delete outbound.n;
  if (Array.isArray(outbound.tools) && outbound.tools.length === 0) delete outbound.tools;
  return { body: outbound, model };
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
  if (aggregate.toolCalls?.size) {
    throw new ApiError(502, 'upstream returned tool calls that were not requested', {
      type: 'api_error',
      code: 'tool_calls_not_supported',
    });
  }
  const message = {
    role: 'assistant',
    content: aggregate.content || '',
  };
  if (aggregate.reasoning) message.reasoning_content = aggregate.reasoning;
  if (aggregate.refusal) message.refusal = aggregate.refusal;

  const finishReason = {
    length: 'length',
    content_filter: 'content_filter',
    refusal: 'content_filter',
  }[aggregate.finishReason] || 'stop';

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
  defaultModel = 'deepseek-v4-flash',
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

  const ids = ['auto', defaultModel || 'deepseek-v4-flash', 'hy3'];
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
