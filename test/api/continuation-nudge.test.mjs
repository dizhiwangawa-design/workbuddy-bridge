import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTINUATION_NUDGE,
  CONTINUATION_NUDGE_MARKER,
  continuationNudgeEnabled,
  withContinuationNudge,
} from '../../src/continuation-nudge.js';
import { prepareResponsesRequest } from '../../src/protocols/responses.js';
import { normalizeAnthropicRequest } from '../../src/protocols/anthropic.js';
import { prepareOpenAIRequest } from '../../src/protocols/openai.js';

const user = (content) => ({ role: 'user', content });

function nudgePositions(messages) {
  return messages
    .map((message, index) => (
      message?.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes(CONTINUATION_NUDGE_MARKER)
        ? index
        : -1
    ))
    .filter((index) => index >= 0);
}

test('约束文本自带可识别标记', () => {
  assert.match(CONTINUATION_NUDGE, /工具调用/);
  assert.ok(CONTINUATION_NUDGE.startsWith(CONTINUATION_NUDGE_MARKER));
});

test('带工具时插到最后一条 user 之后', () => {
  const messages = [user('a'), { role: 'assistant', content: 'b' }, user('c')];
  const patched = withContinuationNudge(messages, { tools: 2 });
  assert.notEqual(patched, messages, '不应原地修改入参');
  assert.deepEqual(nudgePositions(patched), [3]);
  assert.equal(patched[1], messages[1], '原有消息顺序不变');
  assert.equal(patched[2], messages[2]);
});

test('插入后 assistant 工具调用与结果仍然相邻', () => {
  const messages = [
    user('go'),
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ];
  const patched = withContinuationNudge(messages, { tools: 1 });
  assert.deepEqual(nudgePositions(patched), [1]);
  assert.equal(patched[2].role, 'assistant');
  assert.equal(patched[3].role, 'tool');
});

test('没有 user 消息时追加到末尾', () => {
  const messages = [{ role: 'system', content: 'sys' }, { role: 'assistant', content: 'x' }];
  const patched = withContinuationNudge(messages, { tools: 1 });
  assert.equal(patched.at(-1).role, 'system');
  assert.ok(patched.at(-1).content.includes(CONTINUATION_NUDGE_MARKER));
});

test('不带工具、关闭开关、空消息都原样返回', () => {
  const messages = [user('hi')];
  assert.equal(withContinuationNudge(messages, { tools: 0 }), messages);
  assert.equal(withContinuationNudge(messages, { tools: 3, enabled: false }), messages);
  const empty = [];
  assert.equal(withContinuationNudge(empty, { tools: 3 }), empty);
  assert.equal(withContinuationNudge(undefined, { tools: 3 }), undefined);
});

test('重复调用不会叠加第二条约束', () => {
  const once = withContinuationNudge([user('a')], { tools: 1 });
  const twice = withContinuationNudge(once, { tools: 1 });
  assert.equal(twice, once);
  assert.deepEqual(nudgePositions(twice), [1]);
});

test('开关优先级：环境变量 > 设置项 > 默认开启', () => {
  const previous = process.env.WB_CONTINUATION_NUDGE;
  try {
    delete process.env.WB_CONTINUATION_NUDGE;
    assert.equal(continuationNudgeEnabled({}), true);
    assert.equal(continuationNudgeEnabled(undefined), true);
    assert.equal(continuationNudgeEnabled({ continuationNudge: true }), true);
    assert.equal(continuationNudgeEnabled({ continuationNudge: false }), false);

    // 环境变量是应急开关，必须能盖住磁盘上的配置
    process.env.WB_CONTINUATION_NUDGE = '0';
    assert.equal(continuationNudgeEnabled({}), false);
    assert.equal(continuationNudgeEnabled({ continuationNudge: true }), false);
    process.env.WB_CONTINUATION_NUDGE = 'off';
    assert.equal(continuationNudgeEnabled({ continuationNudge: true }), false);

    // 反过来也要能强制打开
    process.env.WB_CONTINUATION_NUDGE = '1';
    assert.equal(continuationNudgeEnabled({}), true);
    assert.equal(continuationNudgeEnabled({ continuationNudge: false }), true);

    process.env.WB_CONTINUATION_NUDGE = '   ';
    assert.equal(continuationNudgeEnabled({ continuationNudge: false }), false, '空白视为未设置');
  } finally {
    if (previous === undefined) delete process.env.WB_CONTINUATION_NUDGE;
    else process.env.WB_CONTINUATION_NUDGE = previous;
  }
});

// —— 三条协议的真实注入点 ——

const tool = {
  type: 'function',
  function: {
    name: 'exec_command',
    description: 'run a command',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
  },
};

test('Responses：带工具时注入，位置在最后一条 user 之后', () => {
  const prepared = prepareResponsesRequest({
    model: 'deepseek-v4.1-flash',
    input: [{ type: 'message', role: 'user', content: 'create calc.mjs' }],
    tools: [tool],
  });
  assert.deepEqual(nudgePositions(prepared.body.messages), [1]);
  assert.equal(prepared.body.messages[0].role, 'user');
});

test('Responses：不带工具时不注入纯问答请求', () => {
  const prepared = prepareResponsesRequest({
    model: 'deepseek-v4.1-flash',
    input: [{ type: 'message', role: 'user', content: '你好' }],
  });
  assert.deepEqual(nudgePositions(prepared.body.messages), []);
});

test('Responses：continuationNudge=false 可关闭', () => {
  const prepared = prepareResponsesRequest({
    model: 'deepseek-v4.1-flash',
    input: [{ type: 'message', role: 'user', content: 'go' }],
    tools: [tool],
  }, { continuationNudge: false });
  assert.deepEqual(nudgePositions(prepared.body.messages), []);
});

test('Anthropic：带工具时注入且保留 system 在首位', () => {
  const normalized = normalizeAnthropicRequest({
    model: 'deepseek-v4.1-flash',
    max_tokens: 256,
    system: 'you are a coding agent',
    messages: [{ role: 'user', content: 'create calc.mjs' }],
    tools: [{ name: 'exec_command', input_schema: tool.function.parameters }],
  });
  const positions = nudgePositions(normalized.messages);
  assert.deepEqual(positions, [2]);
  assert.equal(normalized.messages[0].role, 'system');
  assert.equal(normalized.messages[0].content, 'you are a coding agent');
});

test('Anthropic：不带工具时不注入', () => {
  const normalized = normalizeAnthropicRequest({
    model: 'deepseek-v4.1-flash',
    max_tokens: 64,
    messages: [{ role: 'user', content: '你好' }],
  });
  assert.deepEqual(nudgePositions(normalized.messages), []);
});

test('Chat：带工具时注入，continuationNudge=false 可关闭', () => {
  const body = {
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'create calc.mjs' }],
    tools: [tool],
  };
  assert.deepEqual(nudgePositions(prepareOpenAIRequest(body).body.messages), [1]);
  assert.deepEqual(
    nudgePositions(prepareOpenAIRequest(body, { continuationNudge: false }).body.messages),
    [],
  );
  assert.deepEqual(
    nudgePositions(prepareOpenAIRequest({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: '你好' }],
    }).body.messages),
    [],
  );
});
