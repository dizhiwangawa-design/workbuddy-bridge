import { ApiError } from '../api-errors.js';
import { budgetEffort } from '../reasoning-effort.js';
import { withContinuationNudge } from '../continuation-nudge.js';

function requestError(message) {
  return new ApiError(400, message, {
    type: 'invalid_request_error',
    code: 'invalid_request',
  });
}

function textFromBlocks(blocks, context) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) throw requestError(`${context} must be a string or content block array`);
  const parts = [];
  for (const block of blocks) {
    if (block?.cache_control !== undefined) {
      throw requestError(`${context} cache_control is not supported`);
    }
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      throw requestError(`${context} only supports text blocks`);
    }
    parts.push(block.text);
  }
  return parts.join('\n');
}

function toolResultText(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw requestError('tool_result content must be a string or block array');
  const parts = [];
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      throw requestError('tool_result only supports text content');
    }
    parts.push(block.text);
  }
  return parts.join('\n');
}

function anthropicImage(block) {
  const source = block?.source;
  if (!source || typeof source !== 'object') throw requestError('image block is missing source');
  if (source.type === 'url') {
    if (typeof source.url !== 'string' || !source.url) throw requestError('image URL is missing');
    return {
      type: 'image_url',
      image_url: { url: source.url },
    };
  }
  if (source.type === 'base64') {
    if (typeof source.data !== 'string' || !source.data) throw requestError('base64 image is missing data');
    if (typeof source.media_type !== 'string' || !source.media_type) {
      throw requestError('base64 image is missing media_type');
    }
    return {
      type: 'image_url',
      image_url: { url: `data:${source.media_type};base64,${source.data}` },
    };
  }
  throw requestError(`unsupported image source type: ${source.type || 'missing'}`);
}

function normalizeToolChoice(choice) {
  if (choice === undefined) return undefined;
  if (choice === 'auto' || choice === 'none') return choice;
  if (choice === 'any') return 'required';
  if (choice?.type === 'auto') return 'auto';
  if (choice?.type === 'none') return 'none';
  if (choice?.type === 'any') return 'required';
  if (choice?.type === 'tool') {
    const name = String(choice.name || '').trim();
    if (!name) throw requestError('tool_choice tool name must not be empty');
    return { type: 'function', function: { name } };
  }
  throw requestError('unsupported tool_choice');
}

function normalizeMessages(messages, warnings) {
  const output = [];
  let lastAssistantTools = new Set();

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!message || !['user', 'assistant'].includes(message.role)) {
      throw requestError(`messages[${messageIndex}].role must be user or assistant`);
    }

    if (typeof message.content === 'string') {
      output.push({ role: message.role, content: message.content });
      lastAssistantTools = new Set();
      continue;
    }
    if (!Array.isArray(message.content) || !message.content.length) {
      throw requestError(`messages[${messageIndex}].content must not be empty`);
    }

    if (message.role === 'assistant') {
      const texts = [];
      const toolCalls = [];
      const toolIds = new Set();
      for (const block of message.content) {
        if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
          // 历史思考块不进上游正文：折成可见文本会让模型把「自己的思考」当成
          // 「上一轮说过的话」，进而在正文里沿用这个格式（<prior_reasoning> 泄漏）。
          // 丢弃是安全默认。
          continue;
        }
        if (block?.cache_control !== undefined) {
          throw requestError('assistant cache_control is not supported');
        }
        if (block?.type === 'text') {
          if (typeof block.text !== 'string') throw requestError('assistant text block is invalid');
          texts.push(block.text);
          continue;
        }
        if (block?.type !== 'tool_use') {
          throw requestError(`unsupported assistant content block: ${block?.type || 'missing'}`);
        }
        const id = String(block.id || '').trim();
        const name = String(block.name || '').trim();
        if (!id || !name) throw requestError('tool_use requires id and name');
        if (toolIds.has(id)) throw requestError(`duplicate tool_use id: ${id}`);
        if (!block.input || typeof block.input !== 'object' || Array.isArray(block.input)) {
          throw requestError(`tool_use ${id} input must be a JSON object`);
        }
        toolIds.add(id);
        toolCalls.push({
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(block.input) },
        });
      }
      if (!texts.length && !toolCalls.length) continue;
      const converted = {
        role: 'assistant',
        content: texts.length ? texts.join('\n') : null,
      };
      if (toolCalls.length) converted.tool_calls = toolCalls;
      output.push(converted);
      lastAssistantTools = toolIds;
      continue;
    }

    const toolResults = [];
    const remaining = [];
    let sawNonResult = false;
    let reordered = false;
    for (const block of message.content) {
      if (block?.cache_control !== undefined) {
        throw requestError('user cache_control is not supported');
      }
      if (block?.type === 'tool_result') {
        if (sawNonResult) reordered = true;
        const id = String(block.tool_use_id || '').trim();
        if (!id || !lastAssistantTools.has(id)) {
          throw requestError(`tool_result references unknown tool_use: ${id || 'missing id'}`);
        }
        let content = toolResultText(block.content);
        if (block.is_error === true) content = `[tool_error]${content}`;
        toolResults.push({ role: 'tool', tool_call_id: id, content });
        continue;
      }
      sawNonResult = true;
      if (block?.type === 'text') {
        if (typeof block.text !== 'string') throw requestError('user text block is invalid');
        remaining.push({ type: 'text', text: block.text });
      } else if (block?.type === 'image') {
        remaining.push(anthropicImage(block));
      } else {
        throw requestError(`unsupported user content block: ${block?.type || 'missing'}`);
      }
    }
    if (reordered) {
      warnings.push({
        code: 'TOOL_RESULT_REORDERED',
        messageIndex,
      });
    }
    output.push(...toolResults);
    if (remaining.length) {
      output.push({
        role: 'user',
        content: remaining.length === 1 && remaining[0].type === 'text'
          ? remaining[0].text
          : remaining,
      });
    }
    lastAssistantTools = new Set();
  }
  return output;
}

export function normalizeAnthropicRequest(body, {
  requireMaxTokens = true,
  continuationNudge = true,
} = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw requestError('request body must be a JSON object');
  }
  const requestedEffort = body.thinking === undefined ? 'none' : budgetEffort(body.thinking);
  const thinkingEnabled = body.thinking?.type === 'enabled';
  if (body.mcp_servers !== undefined || body.container !== undefined) {
    throw requestError('mcp_servers and container are not supported');
  }
  if (body.cache_control !== undefined) {
    throw requestError('prompt caching is not supported');
  }
  if (body.top_k !== undefined) {
    throw requestError('top_k is not supported');
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw requestError('messages must be a non-empty array');
  }
  const maxTokens = body.max_tokens;
  if (
    (requireMaxTokens || maxTokens !== undefined)
    && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)
  ) {
    throw requestError('max_tokens must be a positive integer');
  }

  const warnings = [];
  const messages = [];
  if (body.system !== undefined) {
    const system = textFromBlocks(body.system, 'system');
    if (system) messages.push({ role: 'system', content: system });
  }
  messages.push(...normalizeMessages(body.messages, warnings));

  const tools = [];
  const toolNames = new Set();
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw requestError('tools must be an array');
    for (const tool of body.tools) {
      if (tool?.cache_control !== undefined) {
        throw requestError('tool cache_control is not supported');
      }
      const name = String(tool?.name || '').trim();
      if (!name) throw requestError('tool name must not be empty');
      if (toolNames.has(name)) throw requestError(`duplicate tool name: ${name}`);
      if (!tool.input_schema || typeof tool.input_schema !== 'object') {
        throw requestError(`tool ${name} is missing input_schema`);
      }
      toolNames.add(name);
      tools.push({
        type: 'function',
        function: {
          name,
          description: typeof tool.description === 'string' ? tool.description : '',
          parameters: tool.input_schema,
        },
      });
    }
  }

  let toolChoice;
  if (body.tool_choice !== undefined) {
    if (!tools.length) throw requestError('tool_choice requires at least one tool');
    toolChoice = normalizeToolChoice(body.tool_choice);
  }

  return {
    messages: withContinuationNudge(messages, {
      tools: tools.length,
      enabled: continuationNudge,
      toolChoice,
    }),
    tools,
    toolChoice,
    toolNames,
    warnings,
    maxTokens,
    model: body.model,
    requestedEffort,
    thinkingEnabled,
    temperature: body.temperature,
    topP: body.top_p,
    stopSequences: body.stop_sequences,
  };
}

export function anthropicToOpenAI(body, options = {}) {
  const normalized = normalizeAnthropicRequest(body, options);
  const outbound = {
    messages: normalized.messages,
    stream: true,
  };
  if (normalized.model !== undefined) outbound.model = normalized.model;
  if (normalized.maxTokens !== undefined) outbound.max_tokens = normalized.maxTokens;
  if (normalized.temperature !== undefined) outbound.temperature = normalized.temperature;
  if (normalized.topP !== undefined) outbound.top_p = normalized.topP;
  if (normalized.stopSequences !== undefined) outbound.stop = normalized.stopSequences;
  if (normalized.tools.length) outbound.tools = normalized.tools;
  if (normalized.toolChoice !== undefined) outbound.tool_choice = normalized.toolChoice;
  return {
    body: outbound,
    normalized,
    warnings: normalized.warnings,
  };
}

export function conservativeTokenEstimate(value) {
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  return Math.max(1, Math.ceil(bytes / 3));
}

function stopReason(finishReason, hasTools) {
  if (hasTools) return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'refusal' || finishReason === 'content_filter') return 'refusal';
  return 'end_turn';
}

export function createAnthropicEncoder({
  id,
  model,
  inputTokens = 0,
  thinkingEnabled = false,
}) {
  let started = false;
  let finished = false;
  let nextIndex = 0;
  let textIndex = null;
  let thinkingIndex = null;

  function event(type, data) {
    return { type, data };
  }

  function closeText() {
    if (textIndex === null) return [];
    const index = textIndex;
    textIndex = null;
    return [event('content_block_stop', {
      type: 'content_block_stop',
      index,
    })];
  }

  function closeThinking() {
    if (thinkingIndex === null) return [];
    const index = thinkingIndex;
    thinkingIndex = null;
    return [
      event('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: '' },
      }),
      event('content_block_stop', {
        type: 'content_block_stop',
        index,
      }),
    ];
  }

  // Anthropic 的 prompt 缓存是原生字段；上游没报（或为 0）时不输出，
  // 保持既有响应形状，避免严格 schema 的客户端因多出字段报错。
  function usage(
    outputTokens,
    reasoningTokens,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    inputTokens = null,
  ) {
    return {
      // message_start 只能给估算值（上游还没上报）。message_delta 是最后一次机会，
      // 客户端（Anthropic SDK / pi-ai）会用这里的 input_tokens 覆盖初值，
      // 因此有真实值时必须带上，否则上下文占用会一直停在 bytes/3 的估算上。
      ...(Number.isFinite(inputTokens) && inputTokens > 0
        ? { input_tokens: Math.max(0, inputTokens) }
        : {}),
      output_tokens: Math.max(0, Number(outputTokens) || 0),
      output_tokens_details: {
        reasoning_tokens: Math.max(0, Number(reasoningTokens) || 0),
      },
      ...(Number(cacheReadTokens) > 0
        ? { cache_read_input_tokens: Math.max(0, Number(cacheReadTokens)) }
        : {}),
      ...(Number(cacheWriteTokens) > 0
        ? { cache_creation_input_tokens: Math.max(0, Number(cacheWriteTokens)) }
        : {}),
    };
  }

  return {
    start() {
      if (started) return [];
      started = true;
      return [event('message_start', {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens },
        },
      })];
    },

    textDelta(text) {
      if (!started || finished || !text) return [];
      const events = closeThinking();
      if (textIndex === null) {
        textIndex = nextIndex;
        nextIndex += 1;
        events.push(event('content_block_start', {
          type: 'content_block_start',
          index: textIndex,
          content_block: { type: 'text', text: '' },
        }));
      }
      events.push(event('content_block_delta', {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: String(text) },
      }));
      return events;
    },

    thinkingDelta(text) {
      if (!thinkingEnabled || !started || finished || !text) return [];
      const events = closeText();
      if (thinkingIndex === null) {
        thinkingIndex = nextIndex;
        nextIndex += 1;
        events.push(event('content_block_start', {
          type: 'content_block_start',
          index: thinkingIndex,
          content_block: {
            type: 'thinking',
            thinking: '',
            signature: '',
          },
        }));
      }
      events.push(event('content_block_delta', {
        type: 'content_block_delta',
        index: thinkingIndex,
        delta: {
          type: 'thinking_delta',
          thinking: String(text),
        },
      }));
      return events;
    },

    finalize({
      calls = [],
      finishReason,
      outputTokens = 0,
      reasoningTokens = 0,
      cacheReadTokens = 0,
      cacheWriteTokens = 0,
      inputTokens = null,
    } = {}) {
      if (finished) return [];
      finished = true;
      const events = started ? [] : this.start();
      events.push(...closeThinking());
      events.push(...closeText());
      for (const call of calls) {
        const index = nextIndex;
        nextIndex += 1;
        events.push(event('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: {},
          },
        }));
        events.push(event('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(call.input ?? {}),
          },
        }));
        events.push(event('content_block_stop', {
          type: 'content_block_stop',
          index,
        }));
      }
      events.push(event('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason(finishReason, calls.length > 0),
          stop_sequence: null,
        },
        usage: usage(
          outputTokens,
          reasoningTokens,
          cacheReadTokens,
          cacheWriteTokens,
          inputTokens,
        ),
      }));
      events.push(event('message_stop', {
        type: 'message_stop',
      }));
      return events;
    },

    ping() {
      if (!started || finished) return [];
      return [event('ping', { type: 'ping' })];
    },

    cancel({
      outputTokens = 0,
      reasoningTokens = 0,
      cacheReadTokens = 0,
      cacheWriteTokens = 0,
    } = {}) {
      if (finished) return [];
      finished = true;
      const events = started ? [...closeThinking(), ...closeText()] : this.start();
      events.push(event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'canceled', stop_sequence: null },
        usage: usage(outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens),
      }));
      events.push(event('message_stop', { type: 'message_stop' }));
      return events;
    },

    error(error) {
      if (finished) return [];
      finished = true;
      const events = started ? [...closeThinking(), ...closeText()] : [];
      events.push(event('error', {
        type: 'error',
        error: {
          type: error?.type || 'api_error',
          message: error?.message || 'upstream error',
        },
      }));
      return events;
    },
  };
}
