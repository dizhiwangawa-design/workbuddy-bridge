import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToOpenAI,
  conservativeTokenEstimate,
  createAnthropicEncoder,
  normalizeAnthropicRequest,
} from '../../src/protocols/anthropic.js';
import {
  arbitrateToolCalls,
  createStructuredToolAssembler,
} from '../../src/protocols/normalize.js';
import { createSseParser, encodeSseEvent } from '../../src/sse.js';

test('Anthropic 请求转换支持 tools、图片、tool_result 与 is_error', () => {
  const converted = anthropicToOpenAI({
    model: 'deepseek-v4.1-flash',
    max_tokens: 256,
    system: [{ type: 'text', text: 'Be concise.' }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'weather?' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_1',
          name: 'get_weather',
          input: { city: 'Beijing' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          is_error: true,
          content: [{ type: 'text', text: 'service unavailable' }],
        }],
      },
    ],
    tools: [{
      name: 'get_weather',
      description: 'Get weather',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
      },
    }],
    tool_choice: { type: 'tool', name: 'get_weather' },
  });

  assert.equal(converted.body.stream, true);
  assert.equal(converted.body.messages[0].role, 'system');
  assert.equal(converted.body.messages[2].role, 'assistant');
  assert.equal(converted.body.messages[2].tool_calls[0].id, 'toolu_1');
  assert.equal(converted.body.messages[3].role, 'tool');
  assert.equal(converted.body.messages[3].tool_call_id, 'toolu_1');
  assert.match(converted.body.messages[3].content, /^\[tool_error\]/);
  assert.equal(converted.body.tools[0].function.name, 'get_weather');
  assert.equal(converted.body.tool_choice.function.name, 'get_weather');
});

test('乱序 tool_result 自动前置且保持两组内部相对顺序', () => {
  const normalized = normalizeAnthropicRequest({
    model: 'deepseek-v4.1-flash',
    max_tokens: 128,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'one', input: {} },
          { type: 'tool_use', id: 'b', name: 'two', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first text' },
          {
            type: 'tool_result',
            tool_use_id: 'b',
            content: 'second result',
          },
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.test/x.png' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'a',
            content: 'first result',
          },
          { type: 'text', text: 'last text' },
        ],
      },
    ],
  });

  assert.equal(normalized.warnings[0].code, 'TOOL_RESULT_REORDERED');
  assert.deepEqual(
    normalized.messages.at(-3).content,
    'second result',
  );
  assert.deepEqual(
    normalized.messages.at(-2).content,
    'first result',
  );
  assert.equal(normalized.messages.at(-1).role, 'user');
  assert.equal(normalized.messages.at(-1).content[0].text, 'first text');
  assert.equal(normalized.messages.at(-1).content[1].type, 'image_url');
  assert.equal(normalized.messages.at(-1).content[2].text, 'last text');
});

test('tool_result 已在 text 前时保持原顺序且不产生重排 warning', () => {
  const normalized = normalizeAnthropicRequest({
    model: 'deepseek-v4.1-flash',
    max_tokens: 128,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'echo', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
          { type: 'text', text: 'continue with the result' },
        ],
      },
    ],
  });

  assert.deepEqual(normalized.warnings, []);
  assert.equal(normalized.messages.at(-2).role, 'tool');
  assert.equal(normalized.messages.at(-1).role, 'user');
  assert.equal(normalized.messages.at(-1).content, 'continue with the result');
});

test('tool_result 没有匹配前一条 assistant tool_use 时返回 400', () => {
  assert.throws(() => anthropicToOpenAI({
    model: 'deepseek-v4.1-flash',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }],
    }],
  }), (error) => error.status === 400 && /tool_use/.test(error.message));
});

test('Anthropic 对不支持的 thinking、缓存与请求字段返回明确 400', () => {
  const base = {
    model: 'deepseek-v4.1-flash',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  };
  for (const body of [
    { ...base, thinking: { type: 'enabled', budget_tokens: 1 } },
    { ...base, mcp_servers: [] },
    { ...base, container: 'container_1' },
    { ...base, cache_control: { type: 'ephemeral' } },
    { ...base, top_k: 5 },
    { ...base, max_tokens: undefined },
    { ...base, max_tokens: 0 },
    {
      ...base,
      system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    },
    {
      ...base,
      tools: [{
        name: 'read',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral' },
      }],
    },
  ]) {
    assert.throws(
      () => normalizeAnthropicRequest(body),
      (error) => error.status === 400 && error.type === 'invalid_request_error',
    );
  }
  const countOnly = normalizeAnthropicRequest({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'count me' }],
  }, { requireMaxTokens: false });
  assert.equal(countOnly.maxTokens, undefined);
});

test('结构化工具调用只在响应结束时完成，并与 DSML 完全隔离', () => {
  const structured = createStructuredToolAssembler();
  structured.push([{
    index: 0,
    id: 'call_1',
    function: { name: 'get_', arguments: '{"city":"Bei' },
  }]);
  structured.push([{
    index: 0,
    function: { name: 'weather', arguments: 'jing"}' },
  }]);

  const fakeDsml = [{ name: 'search', input: { q: 'DSML only' } }];
  const finished = structured.finish();
  assert.deepEqual(finished.calls, [{
    id: 'call_1',
    name: 'get_weather',
    input: { city: 'Beijing' },
  }]);
  assert.deepEqual(fakeDsml, [{ name: 'search', input: { q: 'DSML only' } }]);

  const arbitration = arbitrateToolCalls({
    structured: finished,
    dsml: fakeDsml,
    toolsDeclared: true,
    toolChoice: 'auto',
    model: 'deepseek-v4.1-flash',
    requestId: 'req_test',
  });
  assert.equal(arbitration.source, 'structured');
  assert.equal(arbitration.calls[0].name, 'get_weather');
  assert.equal(arbitration.warning.code, 'DUAL_TOOL_FORMAT');
  assert.equal(JSON.stringify(arbitration.warning).includes('Beijing'), false);
  assert.equal(String(arbitration.warning.argumentHashes[0]).length, 64);
});

test('结构化工具参数超过字节上限后冻结且不暴露半截调用', () => {
  const structured = createStructuredToolAssembler({ maxBytes: 16 });
  assert.throws(
    () => structured.push([{
      index: 0,
      id: 'call_large',
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ input: 'x'.repeat(32) }),
      },
    }]),
    (error) => error.code === 'TOOL_ARGUMENT_LIMIT',
  );
  assert.deepEqual(structured.snapshot(), []);
  assert.deepEqual(structured.finish(), { calls: [], invalid: [] });
  assert.throws(
    () => structured.push([{
      index: 0,
      function: { name: 'later', arguments: '{}' },
    }]),
    (error) => error.code === 'TOOL_ARGUMENT_LIMIT',
  );
});

test('结构化全部无效时才回退到 DSML，未声明 tools 时永不调用', () => {
  const fallback = arbitrateToolCalls({
    structured: { calls: [], invalid: [{ index: 0, reason: 'bad json' }] },
    dsml: [{ name: 'search', input: { q: 'fallback' } }],
    toolsDeclared: true,
    toolChoice: 'auto',
    model: 'm',
    requestId: 'r',
  });
  assert.equal(fallback.source, 'dsml');
  assert.equal(fallback.calls[0].name, 'search');

  const none = arbitrateToolCalls({
    structured: { calls: [], invalid: [] },
    dsml: [{ name: 'search', input: { q: 'ignored' } }],
    toolsDeclared: false,
    toolChoice: 'auto',
    model: 'm',
    requestId: 'r',
  });
  assert.equal(none.source, 'cleaned-only');
  assert.deepEqual(none.calls, []);
});

test('Anthropic SSE encoder 生成完整 text/tool 事件并正确双重转义 JSON', () => {
  const encoder = createAnthropicEncoder({
    id: 'msg_test',
    model: 'deepseek-v4.1-flash',
    inputTokens: 12,
  });
  const events = encoder.start();
  events.push(...encoder.textDelta('可见😀 "quote"'));
  events.push(...encoder.finalize({
    calls: [{
      id: 'toolu_test_0',
      name: 'write_file',
      input: {
        text: 'line1\n"quoted"\\tail',
        city: '北京',
      },
    }],
    finishReason: 'tool_calls',
    outputTokens: 7,
  }));

  assert.deepEqual(events.map((event) => event.type), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  assert.deepEqual(events.slice(1, 2).map((event) => event.data.index), [0]);
  assert.equal(events[7].data.delta.stop_reason, 'tool_use');

  const toolStart = events[4].data;
  const toolDelta = events[5].data;
  assert.equal(toolStart.content_block.type, 'tool_use');
  assert.deepEqual(toolStart.content_block.input, {});
  assert.equal(toolDelta.delta.type, 'input_json_delta');
  assert.deepEqual(JSON.parse(toolDelta.delta.partial_json), {
    text: 'line1\n"quoted"\\tail',
    city: '北京',
  });

  const wire = events.map((event) => encodeSseEvent(event.type, event.data)).join('');
  const parsed = createSseParser().feed(wire).finished();
  const parsedToolDelta = parsed.find((event) => (
    event.data?.delta?.type === 'input_json_delta'
  ));
  assert.deepEqual(JSON.parse(parsedToolDelta.data.delta.partial_json), {
    text: 'line1\n"quoted"\\tail',
    city: '北京',
  });
});

test('Anthropic encoder 出错时关闭 text block 且不发送 message_stop', () => {
  const encoder = createAnthropicEncoder({
    id: 'msg_error',
    model: 'm',
    inputTokens: 1,
  });
  const events = encoder.start();
  events.push(...encoder.textDelta('partial'));
  events.push(...encoder.error({
    type: 'api_error',
    message: 'upstream interrupted',
  }));

  assert.equal(events.filter((event) => event.type === 'error').length, 1);
  assert.equal(events.some((event) => event.type === 'message_stop'), false);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(
    events.filter((event) => event.type === 'content_block_start').length,
    events.filter((event) => event.type === 'content_block_stop').length,
  );
});

test('Anthropic encoder 直接结束空响应时仍生成完整成功事件序列', () => {
  const encoder = createAnthropicEncoder({
    id: 'msg_empty',
    model: 'deepseek-v4.1-flash',
    inputTokens: 1,
  });
  const events = encoder.finalize({
    finishReason: 'stop',
    outputTokens: 0,
  });

  assert.deepEqual(events.map((event) => event.type), [
    'message_start',
    'message_delta',
    'message_stop',
  ]);
  assert.equal(events[0].data.message.id, 'msg_empty');
});

test('没有最终工具块时不会仅因上游 finish_reason 返回 tool_use', () => {
  const encoder = createAnthropicEncoder({
    id: 'msg_no_tools',
    model: 'deepseek-v4.1-flash',
  });
  const events = encoder.finalize({
    calls: [],
    finishReason: 'tool_calls',
  });

  assert.equal(
    events.find((event) => event.type === 'message_delta').data.delta.stop_reason,
    'end_turn',
  );
});

test('保守 token 估算确定、单调并包含固定 framing', () => {
  const short = conservativeTokenEstimate({ text: 'hello' });
  const long = conservativeTokenEstimate({ text: 'hello world 你好世界 😀' });
  assert.ok(short >= 1);
  assert.ok(long > short);
  assert.equal(long, conservativeTokenEstimate({ text: 'hello world 你好世界 😀' }));
});

test('SSE parser 支持任意 UTF-8 分块、CRLF 和多行 data', () => {
  const parser = createSseParser();
  const raw = Buffer.from(
    'event: one\r\ndata: {"text":"你好😀"}\r\n\r\n' +
    'data: line1\ndata: line2\n\n',
    'utf8',
  );
  const events = [];
  for (let i = 0; i < raw.length; i += 1) {
    events.push(...parser.feed(raw.subarray(i, i + 1)));
  }
  events.push(...parser.finished());

  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'one');
  assert.deepEqual(JSON.parse(events[0].data), { text: '你好😀' });
  assert.equal(events[1].data, 'line1\nline2');
});

test('SSE parser 对单事件、跨 data 行和残片缓存执行字节上限', () => {
  assert.throws(
    () => createSseParser({ maxBufferBytes: 64 }).feed(`data: ${'x'.repeat(96)}\n\n`),
    (error) => error.code === 'SSE_BUFFER_LIMIT',
  );
  const manyLines = createSseParser({ maxBufferBytes: 64 });
  assert.throws(
    () => manyLines.feed(Array.from(
      { length: 12 },
      () => `data: ${'x'.repeat(8)}`,
    ).join('\n')),
    (error) => error.code === 'SSE_BUFFER_LIMIT',
  );
  const partial = createSseParser({ maxBufferBytes: 32 });
  assert.throws(
    () => partial.feed(`data: ${'x'.repeat(40)}`),
    (error) => error.code === 'SSE_BUFFER_LIMIT',
  );
});

test('SSE parser 不会因单次 feed 包含多个完整小事件而误判超限', () => {
  const parser = createSseParser({ maxBufferBytes: 64 });
  const events = parser.feed(Array.from(
    { length: 20 },
    (_, index) => `data: ${index}\n\n`,
  ).join(''));
  assert.equal(events.length, 20);
  assert.equal(events[19].data, '19');
});

test('工具 ID 缺失或重复时生成稳定且唯一的 Anthropic ID', () => {
  const result = arbitrateToolCalls({
    structured: {
      calls: [
        { id: '', name: 'first', input: {} },
        { id: 'duplicate', name: 'second', input: {} },
        { id: 'duplicate', name: 'third', input: {} },
      ],
      invalid: [],
    },
    dsml: [],
    toolsDeclared: true,
    toolChoice: 'auto',
    model: 'm',
    requestId: 'req_ids',
  });
  assert.deepEqual(result.calls.map((call) => call.id), [
    'toolu_req_ids_0',
    'duplicate',
    'toolu_req_ids_2',
  ]);
});
