import test from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetEffort,
  reasoningDeclaration,
  resolveReasoningEffort,
  resolveRequestedEffort,
} from '../../src/reasoning-effort.js';

function supported(efforts) {
  return reasoningDeclaration({
    reasoning: {
      supportedEfforts: efforts,
      defaultEffort: 'high',
      canDisableThinking: false,
    },
  });
}

test('五档模型保留 medium 和 xhigh', () => {
  const declaration = supported(['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(resolveReasoningEffort('medium', declaration), 'medium');
  assert.equal(resolveReasoningEffort('xhigh', declaration), 'xhigh');
});

test('三档模型向上归一化且 minimal 归为 low', () => {
  const declaration = supported(['low', 'high', 'max']);
  assert.equal(resolveReasoningEffort('minimal', declaration), 'low');
  assert.equal(resolveReasoningEffort('medium', declaration), 'high');
  assert.equal(resolveReasoningEffort('xhigh', declaration), 'max');
});

test('单值声明沿用目录值', () => {
  const declaration = reasoningDeclaration({
    reasoning: { effort: 'medium' },
  });
  assert.deepEqual(declaration.efforts, ['medium']);
  assert.equal(resolveReasoningEffort('low', declaration), 'medium');
  assert.equal(resolveReasoningEffort('high', declaration), 'medium');
  assert.equal(resolveReasoningEffort('none', declaration), 'none');
});

test('无 reasoning 对象不产生转发值', () => {
  const declaration = reasoningDeclaration({ id: 'glm-4.6' });
  assert.equal(resolveReasoningEffort('high', declaration), null);
  assert.equal(resolveReasoningEffort(null, declaration), null);
  assert.throws(
    () => resolveReasoningEffort('hihg', declaration),
    (error) => error.status === 400,
  );
});

test('已知模型缺失档位时显式转发 none', () => {
  const declaration = supported(['low', 'high', 'max']);
  assert.equal(resolveReasoningEffort(null, declaration), 'none');
});

test('未知档位返回 400 且大小写不敏感', () => {
  const declaration = supported(['low', 'high', 'max']);
  assert.equal(resolveReasoningEffort('HIGH', declaration), 'high');
  assert.throws(
    () => resolveReasoningEffort('hihg', declaration),
    (error) => error.status === 400 && /unknown reasoning effort/i.test(error.message),
  );
});

test('Anthropic 预算分桶边界稳定', () => {
  assert.equal(budgetEffort({ type: 'disabled' }), 'none');
  assert.equal(budgetEffort({ type: 'enabled', budget_tokens: 0 }), 'low');
  assert.equal(budgetEffort({ type: 'enabled', budget_tokens: 4095 }), 'low');
  assert.equal(budgetEffort({ type: 'enabled', budget_tokens: 4096 }), 'high');
  assert.equal(budgetEffort({ type: 'enabled', budget_tokens: 16383 }), 'high');
  assert.equal(budgetEffort({ type: 'enabled', budget_tokens: 16384 }), 'max');
});

test('Anthropic 空对象和未知 type 返回 400', () => {
  for (const thinking of [{}, { type: 'maybe' }]) {
    assert.throws(
      () => budgetEffort(thinking),
      (error) => error.status === 400,
    );
  }
});

// ---------------------------------------------------------------------------
// resolveRequestedEffort：客户端意图 → 实际转发值
//
// v0.4 的判定链把「目录里没有这个模型」和「模型不支持 reasoning」压成同一个
// null，于是一次目录未预热就静默删掉 reasoning_effort，上游随即不再返回思维链
// （dsh 的模型列表是手写的，永远不会触发目录预热）。这里只修这一点：目录给不出
// 答案时透传客户端声明的值；未声明与显式 none 的既有行为完全不变。
// ---------------------------------------------------------------------------

const CLOSABLE = reasoningDeclaration({
  reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true },
});
const NOT_CLOSABLE = reasoningDeclaration({
  reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: false },
});

test('目录未知时透传客户端声明的档位', () => {
  assert.deepEqual(resolveRequestedEffort('max', null), { effort: 'max', source: 'passthrough' });
  assert.deepEqual(resolveRequestedEffort('high', null), { effort: 'high', source: 'passthrough' });
  assert.deepEqual(resolveRequestedEffort('minimal', null), { effort: 'low', source: 'passthrough' });
});

test('目录热时仍然按能力归一化，不透传', () => {
  assert.deepEqual(resolveRequestedEffort('medium', CLOSABLE), { effort: 'high', source: 'mapped' });
  assert.deepEqual(resolveRequestedEffort('max', CLOSABLE), { effort: 'max', source: 'mapped' });
});

test('未声明档位保持现状：一律 none，不读 canDisableThinking', () => {
  assert.deepEqual(resolveRequestedEffort(null, CLOSABLE), { effort: 'none', source: 'default' });
  assert.deepEqual(resolveRequestedEffort(undefined, CLOSABLE), { effort: 'none', source: 'default' });
  assert.deepEqual(resolveRequestedEffort(null, null), { effort: 'none', source: 'default' });
  assert.deepEqual(resolveRequestedEffort(null, NOT_CLOSABLE), { effort: 'none', source: 'default' });
});

test('显式 none 保持现状：即便模型声明不可关思考也照发', () => {
  assert.deepEqual(resolveRequestedEffort('none', CLOSABLE), { effort: 'none', source: 'disabled' });
  assert.deepEqual(resolveRequestedEffort('none', NOT_CLOSABLE), { effort: 'none', source: 'disabled' });
  assert.deepEqual(resolveRequestedEffort('none', null), { effort: 'none', source: 'disabled' });
});

test('明确声明不支持 reasoning 的模型不转发', () => {
  const noReasoning = reasoningDeclaration({ id: 'glm-4.6' });
  assert.deepEqual(resolveRequestedEffort('high', noReasoning), { effort: null, source: 'unsupported' });
  assert.deepEqual(resolveRequestedEffort(null, noReasoning), { effort: null, source: 'unsupported' });
});

test('未知档位名在冷热目录下都返回 400', () => {
  for (const declaration of [null, CLOSABLE, reasoningDeclaration({ id: 'glm-4.6' })]) {
    assert.throws(
      () => resolveRequestedEffort('hihg', declaration),
      (error) => error.status === 400 && error.code === 'invalid_reasoning_effort',
    );
  }
});

test('档位大小写归一，输出恒为小写', () => {
  assert.deepEqual(resolveRequestedEffort('MAX', null), { effort: 'max', source: 'passthrough' });
  assert.deepEqual(resolveRequestedEffort('Max', CLOSABLE), { effort: 'max', source: 'mapped' });
});

test('resolveReasoningEffort 与新判定链给出同一个值', () => {
  for (const [requested, declaration] of [
    ['max', null],
    ['medium', CLOSABLE],
    [null, CLOSABLE],
    ['none', NOT_CLOSABLE],
    ['high', reasoningDeclaration({ id: 'glm-4.6' })],
  ]) {
    assert.equal(
      resolveReasoningEffort(requested, declaration),
      resolveRequestedEffort(requested, declaration).effort,
    );
  }
});
