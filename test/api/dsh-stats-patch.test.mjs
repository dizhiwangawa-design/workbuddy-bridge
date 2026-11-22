import test from 'node:test';
import assert from 'node:assert/strict';

const { sessionStatsProjectionDefinition, DECODE_GATE_MS_ } =
  await import('../../vendor/dsh-session-stats-0.2.1-rc.5/index.js');

const def = sessionStatsProjectionDefinition;

function fold(events) {
  let state = def.init();
  for (const event of events) state = def.apply(state, event);
  return def.wire.view(state);
}

/** One step that produced `out` tokens over `span` ms, with the given channels. */
function step({ turn = 1, step = 1, at = 1000, span = 500, out = 100, reasoning, text, args }) {
  const stream = [];
  let cursor = at + 50; // first token 50ms after the step starts
  const first = cursor;
  if (reasoning) {
    stream.push({ type: 'reasoning-chunks', time0: cursor, index: 0, dt: [span - 1], texts: [reasoning] });
    cursor += span;
  }
  if (text) {
    stream.push({ type: 'text-chunks', time0: cursor, index: 1, dt: [], texts: [text] });
  }
  if (args) {
    stream.push({ type: 'tool-call-chunks', time0: cursor, index: 2, dt: [], id: 'call_1', name: 'run_shell', args: [args] });
  }
  return [
    { type: 'step/start', time: at, data: { turn, step } },
    {
      type: 'assistant/message',
      // the message lands exactly `span` after the first token
      time: first + span,
      data: {
        turn,
        step,
        stream,
        usage: { inputTokens: 10, outputTokens: out },
      },
    },
    { type: 'step/end', time: first + span + 1, data: { turn, step } },
  ];
}

test('单步解码窗口正常时照常计入 decodeMs 与 decodeTokens', () => {
  const view = fold(step({ span: 500, out: 100, text: 'hello world' }));
  assert.equal(view.decodeMs, 500);
  assert.equal(view.decodeTokens, 100);
  assert.equal(view.steps, 1);
  assert.equal(view.ttftSteps, 1);
});

test('瞬时爆发步（窗口 <= 5ms）不进入 decode 统计，避免除以 ~0', () => {
  const view = fold(step({ span: DECODE_GATE_MS_, out: 38000, text: 'x'.repeat(4000) }));
  assert.equal(view.decodeMs, 0, '零窗口步不得贡献分母');
  assert.equal(view.decodeTokens, 0, '零窗口步的 token 也不得进分子');
  assert.equal(view.steps, 1, '但它仍然是一个已结束的 step');
  assert.equal(view.ttftSteps, 1, 'TTFT 仍然有样本');
});

test('零窗口步被剔除后，速度只反映真实生成窗口', () => {
  // 一步瞬时爆发 38000 token + 一步真实生成 500ms / 100 token。
  const events = [
    ...step({ turn: 1, step: 1, at: 1000, span: 0, out: 38000, args: '{"command":"ls"}' }),
    ...step({ turn: 1, step: 2, at: 60000, span: 500, out: 100, text: 'real generation' }),
  ];
  const view = fold(events);
  assert.equal(view.decodeMs, 500);
  assert.equal(view.decodeTokens, 100);
  const tps = view.decodeTokens / (view.decodeMs / 1000);
  assert.equal(tps, 200, '速度应为真实值，而不是 38000 / 0.5s');
});

test('按通道拆分的三个 token 字段之和等于 decodeTokens', () => {
  const view = fold(step({
    span: 500,
    out: 300,
    reasoning: 'r'.repeat(100),
    text: 't'.repeat(100),
    args: 'a'.repeat(200),
  }));
  const sum = view.decodeFrameTokens + view.decodeTextTokens + view.decodeReasoningTokens;
  assert.ok(Math.abs(sum - view.decodeTokens) < 1e-9, `split ${sum} != ${view.decodeTokens}`);
  // 字符占比 100:100:200 → token 300 分成 75 / 75 / 150
  assert.ok(Math.abs(view.decodeTextTokens - 75) < 1e-6, 'text 占 1/4');
  assert.ok(Math.abs(view.decodeReasoningTokens - 75) < 1e-6, 'reasoning 占 1/4');
  assert.ok(Math.abs(view.decodeFrameTokens - 150) < 1e-6, 'frame 占 1/2');
});

test('只有正文的步：frame 与 reasoning 拆分保持 0', () => {
  const view = fold(step({ span: 500, out: 50, text: 'pure answer' }));
  assert.equal(view.decodeTokens, 50);
  assert.ok(Math.abs(view.decodeTextTokens - 50) < 1e-6, '全部归到 text');
  assert.equal(view.decodeFrameTokens, 0);
  assert.equal(view.decodeReasoningTokens, 0);
});

test('未上报 usage 的步不进入 decode 统计', () => {
  const events = step({ span: 500, out: 100, text: 'x' });
  delete events[1].data.usage;
  const view = fold(events);
  assert.equal(view.decodeMs, 0);
  assert.equal(view.decodeTokens, 0);
});

test('stateVersion 提升到 2，旧缓存行会被丢弃重算而不是混读', () => {
  assert.equal(def.stateVersion, 2);
  assert.equal(def.key, 'sessionStats');
});

test('既有字段的语义未被改写：turns / llmMs / toolMs / ttftMs / ttftSteps 照旧', () => {
  const view = fold([
    ...step({ turn: 1, step: 1, at: 1000, span: 500, out: 100, text: 'a' }),
    { type: 'tool/call', time: 2000, data: { callId: 'c1' } },
    { type: 'tool/result', time: 2500, data: { message: { source: { callId: 'c1' } } } },
  ]);
  assert.equal(view.turns, 1);
  assert.equal(view.steps, 1);
  assert.equal(view.toolMs, 500, 'toolMs = tool/call → tool/result');
  assert.equal(view.llmMs, 550, 'llmMs = step/start → assistant/message（含 50ms 首字）');
  assert.equal(view.ttftMs, 50, 'ttftMs = step/start → 首个 token');
  assert.equal(view.decodeMs, 500, 'decodeMs = 首个 token → assistant/message');
  assert.equal(view.ttftSteps, 1);
});

test('5ms 门槛落在两类之间，不会误杀真实窗口（真实会话分布）', () => {
  // 两个真实会话的实测分布：零窗口步最大 2–3ms，最短真实窗口 316–319ms。
  // 门槛必须落在这条 313ms 宽的缝里，否则要么漏剔除要么误杀。
  const real = [316, 319, 357, 396, 414, 443, 516, 548, 573, 615];
  for (const span of real) {
    const view = fold(step({ span, out: 100, text: 'x' }));
    assert.equal(view.decodeMs, span, `${span}ms 的真实窗口必须计入`);
  }
  for (const span of [0, 1, 2, 3, 5]) {
    const view = fold(step({ span, out: 100, text: 'x' }));
    assert.equal(view.decodeMs, 0, `${span}ms 的瞬时爆发必须剔除`);
  }
});

