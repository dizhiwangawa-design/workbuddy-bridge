import test from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetEffort,
  reasoningDeclaration,
  resolveReasoningEffort,
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
