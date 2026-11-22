import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTINUATION_NUDGE,
  CONTINUATION_NUDGE_MARKER,
  anthropicHasToolLoop,
  chatHasToolLoop,
  continuationNudgeApplies,
  continuationNudgeEnabled,
  continuationNudgeMode,
  detectAgentClient,
  responsesHasToolLoop,
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

test('约束不落在 tool 结果之后（末尾 system 会被当成新一轮指令）', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    user('refactor the parser'),
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'body' },
  ];
  const patched = withContinuationNudge(messages, { tools: 1 });
  // 位置必须是「最后一条 user 之后」，不能是整串末尾：跟 tool 结果并排会让模型
  // 把约束读成新一轮对话的开头，表现为说完一句就收工。
  assert.deepEqual(nudgePositions(patched), [2]);
  assert.notEqual(patched.at(-1).role, 'system');
});

test('tool_choice 为 none 时不注入（不与客户端意图冲突）', () => {
  const messages = [user('just answer')];
  assert.equal(withContinuationNudge(messages, { tools: 1, toolChoice: 'none' }), messages);
  assert.equal(withContinuationNudge(messages, { tools: 1, toolChoice: { type: 'none' } }), messages);
  // 其它 tool_choice 值照常注入
  assert.deepEqual(
    nudgePositions(withContinuationNudge(messages, { tools: 1, toolChoice: 'auto' })),
    [1],
  );
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

// —— 规则文本：可观测性回归 ——

test('规则 2 允许一句进度说明，不再禁止叙述', () => {
  // 旧文本禁止一切叙述，代价是过程完全不可见。实测 codex 接受「说明+工具调用」
  // 同轮，不会提前收尾，所以这条放开。
  assert.doesNotMatch(CONTINUATION_NUDGE, /不要在回复里预告或复述/);
  assert.match(CONTINUATION_NUDGE, /说明.*在做什么/);
  // 但「别只说不做」必须保留，否则等于把循环约束拆了
  assert.match(CONTINUATION_NUDGE, /说明不等于执行/);
  assert.match(CONTINUATION_NUDGE, /必须包含至少一个工具调用/);
});

test('规则 4 与 approval 策略解耦、规则 5 给出重试终止条件', () => {
  assert.match(CONTINUATION_NUDGE, /approval/);
  assert.doesNotMatch(CONTINUATION_NUDGE, /不要中途停下来征求意见/);
  assert.match(CONTINUATION_NUDGE, /连续失败两次/);
});

// —— 生效范围：off / auto / always ——

test('continuationNudgeMode 三态解析', () => {
  const previous = process.env.WB_CONTINUATION_NUDGE;
  try {
    delete process.env.WB_CONTINUATION_NUDGE;
    assert.equal(continuationNudgeMode({}), 'auto');
    assert.equal(continuationNudgeMode({ continuationNudge: true }), 'auto');
    assert.equal(continuationNudgeMode({ continuationNudge: false }), 'off');

    process.env.WB_CONTINUATION_NUDGE = '0';
    assert.equal(continuationNudgeMode({ continuationNudge: true }), 'off');
    process.env.WB_CONTINUATION_NUDGE = '1';
    assert.equal(continuationNudgeMode({ continuationNudge: false }), 'always');
  } finally {
    if (previous === undefined) delete process.env.WB_CONTINUATION_NUDGE;
    else process.env.WB_CONTINUATION_NUDGE = previous;
  }
});

test('detectAgentClient 识别 codex 与 dsh，未知客户端返回 null', () => {
  assert.equal(detectAgentClient({ headers: { originator: 'codex_exec' } }), 'codex');
  assert.equal(detectAgentClient({ headers: { 'user-agent': 'pi (linux 6.1; x64)' } }), 'dsh');
  assert.equal(detectAgentClient({ headers: { 'x-codex-turn-metadata': '{}' } }), 'codex');
  assert.equal(detectAgentClient({
    body: { client_metadata: { 'x-codex-window-id': 'w' } },
  }), 'codex');
  assert.equal(detectAgentClient({ headers: { 'user-agent': 'curl/8.5' } }), null);
  assert.equal(detectAgentClient({}), null);
});

test('auto 模式只对编码 Agent 或已在工具循环里的请求生效', () => {
  const unknown = { 'user-agent': 'python-requests/2.32' };
  assert.equal(continuationNudgeApplies({ mode: 'auto', headers: unknown }), false);
  assert.equal(continuationNudgeApplies({ mode: 'auto', headers: unknown, hasToolLoop: true }), true);
  assert.equal(continuationNudgeApplies({ mode: 'auto', headers: { originator: 'codex_exec' } }), true);
  assert.equal(continuationNudgeApplies({ mode: 'off', headers: { originator: 'codex_exec' } }), false);
  assert.equal(continuationNudgeApplies({ mode: 'always', headers: unknown }), true);
});

test('工具往返探测覆盖三条协议的历史形状', () => {
  assert.equal(responsesHasToolLoop({ input: [{ type: 'function_call' }] }), true);
  assert.equal(responsesHasToolLoop({ input: [{ type: 'function_call_output' }] }), true);
  assert.equal(responsesHasToolLoop({ input: [{ type: 'message', role: 'user' }] }), false);
  assert.equal(chatHasToolLoop({ messages: [{ role: 'tool', tool_call_id: 'x' }] }), true);
  assert.equal(chatHasToolLoop({ messages: [{ role: 'assistant', tool_calls: [{ id: 'c' }] }] }), true);
  assert.equal(chatHasToolLoop({ messages: [{ role: 'user', content: 'hi' }] }), false);
  assert.equal(anthropicHasToolLoop({ messages: [{ content: [{ type: 'tool_use' }] }] }), true);
  assert.equal(anthropicHasToolLoop({ messages: [{ content: [{ type: 'tool_result' }] }] }), true);
  assert.equal(anthropicHasToolLoop({ messages: [{ content: [{ type: 'text' }] }] }), false);
});
