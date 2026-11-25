import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTINUATION_RETRY_PROMPT,
  announcesCompletion,
  announcesNextStep,
  continuationRetryEnabled,
  mergeReasoning,
  mergeToolCalls,
  mergeUsage,
  shouldContinueTurn,
  stripRepeatedPreamble,
} from '../../src/continuation-retry.js';

/**
 * 判定谓词的单元测试。
 *
 * 与 `continuation-retry.test.mjs` 的分工：那边走完整 HTTP 栈验行为，这里只验
 * 谓词本身，失败时能立刻指出是「措辞没覆盖」还是「管道接错了」。
 *
 * 判定是刻意不对称的：误判「该续」代价小，误判「不该续」用户永远收不到答复。
 * 所以下面「必须不续」的用例比「必须续」的更严格——它们是防误伤的护栏。
 */

const decide = (content, overrides = {}) => shouldContinueTurn({
  enabled: true,
  finishReason: 'stop',
  toolsDeclared: true,
  toolChoice: 'auto',
  callCount: 0,
  content,
  ...overrides,
});

test('宣布下一步的措辞会触发续跑', () => {
  const cases = [
    '接下来我会补 Sync 路由。',
    // 交接文档里的原句：先报里程碑，再宣布下一步
    '`Store` 已修复并编译通过。接着把 manifest/bucket/看板挂到 Sync 路由，再补集成测试。',
    '我先看一下日志。',
    '现在把 store 挂到路由上。',
    'Store 修好了。然后我把测试补上。',
    'Let me check the build output.',
    "I'll patch the handler next.",
    'Next, wire the manifest into the Sync route.',
  ];
  for (const text of cases) {
    assert.equal(decide(text).retry, true, `应该续跑：${text}`);
  }
});

test('完成型收尾绝不触发续跑（护栏）', () => {
  const cases = [
    '全部完成。`node test/run.mjs` 73 通过 / 0 失败，`node test/api/run.mjs` 全绿。',
    '任务全部完成，测试通过。',
    'All steps are complete; tests pass.',
    '修好了，共改动 3 个文件，没有遗留问题。',
    '完成。',
    // 句中的「继续」不是宣布
    '测试继续通过，没有回退。',
    // 结论后面跟的「接下来你…」是给用户的建议，不是模型要做的事
    '全部完成。测试通过，接下来你可以在面板查看。',
    '工作已完成。接下来你可以自行验证。',
  ];
  for (const text of cases) {
    assert.equal(decide(text).retry, false, `不该续跑：${text}`);
  }
});

test('判定只看正文末尾，正文中段提到「接下来」不触发', () => {
  const text = `${'长'.repeat(400)}接下来我会研究这个问题，${'但这一段只是回顾。'.repeat(80)}结论：没有遗留问题。`;
  assert.equal(announcesNextStep(text), false, '中段的宣布词不该被看见');
  assert.equal(decide(text).retry, false);
});

test('shouldContinueTurn 逐条守住前置条件', () => {
  const announced = '接下来我会补 Sync 路由。';

  assert.equal(decide(announced, { enabled: false }).reason, 'disabled');
  assert.equal(decide(announced, { finishReason: 'tool_calls' }).reason, 'finish_reason');
  assert.equal(decide(announced, { finishReason: 'length' }).reason, 'finish_reason');
  assert.equal(decide(announced, { toolsDeclared: false }).reason, 'no_tools');
  assert.equal(decide(announced, { toolChoice: 'none' }).reason, 'tool_choice_none');
  assert.equal(decide(announced, { toolChoice: { type: 'none' } }).reason, 'tool_choice_none');
  assert.equal(decide(announced, { callCount: 1 }).reason, 'has_tool_calls');
  assert.equal(decide(announced, { retries: 1, maxRetries: 1 }).reason, 'retry_exhausted');
  assert.equal(decide(announced, { retries: 0, maxRetries: 1 }).retry, true, '第一轮可以续');
  assert.equal(decide('我看了一下代码。').reason, 'no_announcement');
});

test('DSML 信封被截断时放行一次续跑，其余 length 仍不续', () => {
  // 真实现场：模型把工具调用信封写进正文却没写完（DSML_TRUNCATED）。对外仍报
  // length / incomplete —— 半截参数不可执行，客户端必须知道没完成；但这一轮既
  // 没有工具调用、正文又停在半截，不续跑就只能把控制权交回用户。
  const announced = '接下来我会补 Sync 路由。';

  assert.equal(decide('截断但仍在宣布下一步', { finishReason: 'length' }).reason, 'finish_reason',
    '普通 length 不续：输出到顶不是「话没说完」');
  assert.equal(
    decide(announced, { finishReason: 'length', dsmlTruncated: true }).retry,
    true,
    '信封截断必须放行续跑',
  );
  // 放行不能变成绕过其它护栏。
  assert.equal(
    decide(announced, { finishReason: 'length', dsmlTruncated: true, retries: 1 }).reason,
    'retry_exhausted',
  );
  assert.equal(
    decide(announced, { finishReason: 'length', dsmlTruncated: true, callCount: 1 }).reason,
    'has_tool_calls',
  );
  assert.equal(
    decide(announced, { finishReason: 'length', dsmlTruncated: true, toolChoice: 'none' }).reason,
    'tool_choice_none',
  );
  assert.equal(
    decide('任务全部完成，测试通过。', { finishReason: 'length', dsmlTruncated: true }).reason,
    'completion',
  );
});

test('续跑指令同时要求「直接执行」和「不要复述」', () => {
  assert.match(CONTINUATION_RETRY_PROMPT, /继续/);
  assert.match(CONTINUATION_RETRY_PROMPT, /直接执行下一步/);
  assert.match(CONTINUATION_RETRY_PROMPT, /不要.*描述计划/);
  assert.match(CONTINUATION_RETRY_PROMPT, /复述/);
});

test('开关优先级：环境变量 > 设置项 > 默认开启', () => {
  const previous = process.env.WB_CONTINUATION_RETRY;
  try {
    delete process.env.WB_CONTINUATION_RETRY;
    assert.equal(continuationRetryEnabled({ continuationRetry: true }), true);
    assert.equal(continuationRetryEnabled({ continuationRetry: false }), false);
    assert.equal(continuationRetryEnabled({}), true, '缺省必须开启');

    // 环境变量是运维应急开关，必须能盖住磁盘上的配置。
    process.env.WB_CONTINUATION_RETRY = '0';
    assert.equal(continuationRetryEnabled({ continuationRetry: true }), false);
    process.env.WB_CONTINUATION_RETRY = 'false';
    assert.equal(continuationRetryEnabled({ continuationRetry: true }), false);
    process.env.WB_CONTINUATION_RETRY = '1';
    assert.equal(continuationRetryEnabled({ continuationRetry: false }), true);

    // 无法识别的值不改变结论。
    process.env.WB_CONTINUATION_RETRY = 'maybe';
    assert.equal(continuationRetryEnabled({ continuationRetry: false }), false);
  } finally {
    if (previous === undefined) delete process.env.WB_CONTINUATION_RETRY;
    else process.env.WB_CONTINUATION_RETRY = previous;
  }
});

test('stripRepeatedPreamble 只剥前缀，不动正文中段的引用', () => {
  const previous = '接下来我会补 Sync 路由。';
  assert.equal(stripRepeatedPreamble(previous, previous), '', '整段重复要全剥掉');
  assert.equal(
    stripRepeatedPreamble(previous, `${previous}然后跑测试。`),
    '然后跑测试。',
  );
  assert.equal(
    stripRepeatedPreamble(previous, '然后跑测试。'),
    '然后跑测试。',
    '不重复时原样返回',
  );
  // 中段提到同样的话属于正常引用，必须保留。
  const quoted = '先跑测试。接下来我会补 Sync 路由。这话说过了。';
  assert.equal(stripRepeatedPreamble(previous, quoted), quoted);
});

test('mergeToolCalls 保证 call_id 唯一', () => {
  const merged = mergeToolCalls(
    [{ id: 'call_1', name: 'a', input: {} }],
    [{ id: 'call_1', name: 'b', input: {} }, { id: 'call_2', name: 'c', input: {} }],
    { requestId: 'resp_x' },
  );
  const ids = merged.map((call) => call.id);
  assert.equal(new Set(ids).size, ids.length, `call_id 撞车必须改名：${JSON.stringify(ids)}`);
  assert.equal(merged[0].id, 'call_1', '第一轮的 id 原样保留');
  assert.equal(merged[1].id, 'toolu_resp_x_1', '撞车的那个改名');
  assert.equal(merged[2].id, 'call_2', '不撞车的保留原名');

  // 空 id 也要补出来，否则客户端的 function_call_output 无法配对。
  const filled = mergeToolCalls([], [{ id: '', name: 'a', input: {} }], { requestId: 'r' });
  assert.equal(filled[0].id, 'toolu_r_0');
});

test('mergeUsage 输入侧取两轮较大值、输出侧相加', () => {
  // 语义改写说明：以前输入侧也相加，但续跑的第二轮会重发全部上下文（含第一轮
  // 的输出），所以 **1200 才是真实终态上下文占用**，2200 是重复计数。相加会把
  // 客户端的上下文占用统计直接虚高近一倍（codex / dsh 都按这个数算剩余窗口）。
  // 输出侧仍然相加：两轮都真的生成了 token，不算就少记账。
  const merged = mergeUsage(
    { prompt_tokens: 1000, completion_tokens: 20, reasoning_tokens: 5, cached_tokens: 30 },
    { prompt_tokens: 1200, completion_tokens: 8, reasoning_tokens: 0, cached_tokens: 10 },
  );
  assert.equal(merged.prompt_tokens, 1200, '输入侧必须是 1200（较大值），不是 2200（相加）');
  assert.equal(merged.completion_tokens, 28, '两轮都真的生成了 token，输出侧相加');
  assert.equal(merged.reasoning_tokens, 5);
  assert.equal(merged.cached_tokens, 30, 'cached 输入是输入侧的一部分，同样取较大值');

  // 取的是「较大值」而不是「第二轮」，第一轮更大时同样成立。
  const firstBigger = mergeUsage(
    { prompt_tokens: 900, completion_tokens: 1, cached_tokens: 40 },
    { prompt_tokens: 700, completion_tokens: 2, cached_tokens: 10 },
  );
  assert.equal(firstBigger.prompt_tokens, 900);
  assert.equal(firstBigger.cached_tokens, 40);
  assert.equal(firstBigger.completion_tokens, 3);

  assert.deepEqual(mergeUsage({}, {}), {
    prompt_tokens: 0,
    completion_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
  });
});

test('mergeReasoning 依次拼接两轮推理', () => {
  assert.equal(mergeReasoning('先看 a', '再看 b'), '先看 a\n\n再看 b');
  assert.equal(mergeReasoning('', '只有第二轮'), '只有第二轮');
  assert.equal(mergeReasoning('只有第一轮', ''), '只有第一轮');
});
