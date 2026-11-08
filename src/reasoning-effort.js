import { ApiError } from './api-errors.js';

export const REASONING_LADDER = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const ACCEPTED = new Set(['none', 'minimal', ...REASONING_LADDER]);

function bad(message) {
  return new ApiError(400, message, {
    type: 'invalid_request_error',
    code: 'invalid_reasoning_effort',
  });
}

function canonical(value) {
  return String(value ?? '').trim().toLowerCase();
}

function usableRung(value) {
  const named = canonical(value);
  return REASONING_LADDER.includes(named) ? named : null;
}

export function reasoningDeclaration(model) {
  const reasoning = model?.reasoning;
  if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) {
    return {
      form: 'none',
      efforts: [],
      declaredEffort: null,
      defaultEffort: null,
      canDisableThinking: null,
    };
  }

  const defaultEffort = usableRung(reasoning.defaultEffort);
  const canDisableThinking = typeof reasoning.canDisableThinking === 'boolean'
    ? reasoning.canDisableThinking
    : null;

  if (Array.isArray(reasoning.supportedEfforts)) {
    const efforts = [...new Set(
      reasoning.supportedEfforts.map(usableRung).filter(Boolean),
    )];
    return {
      form: efforts.length ? 'supported' : 'none',
      efforts,
      declaredEffort: null,
      defaultEffort,
      canDisableThinking,
    };
  }

  const declaredEffort = usableRung(reasoning.effort);
  if (declaredEffort) {
    return {
      form: 'single',
      efforts: [declaredEffort],
      declaredEffort,
      defaultEffort,
      canDisableThinking,
    };
  }

  return {
    form: 'none',
    efforts: [],
    declaredEffort: null,
    defaultEffort,
    canDisableThinking,
  };
}

function assertAccepted(raw) {
  if (!ACCEPTED.has(raw)) {
    throw bad(`unknown reasoning effort: ${JSON.stringify(raw)}`);
  }
}

/**
 * 把已归一的档位映射到目录声明的支持集合：精确命中优先，否则向上取最近值，
 * 超出最高档时取最高档。调用方保证 raw 已在 ACCEPTED 内且不是 none。
 *
 * @param {string} raw 已归一化的档位名
 * @param {{efforts: string[]}} declaration 有效声明（efforts 非空）
 * @returns {string|null}
 */
function mapToDeclaration(raw, declaration) {
  const wanted = raw === 'minimal' ? 'low' : raw;
  const supported = declaration.efforts;
  if (supported.includes(wanted)) return wanted;

  const wantedIndex = REASONING_LADDER.indexOf(wanted);
  const positions = supported
    .map((effort) => ({ effort, index: REASONING_LADDER.indexOf(effort) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);

  return positions.find((item) => item.index >= wantedIndex)?.effort
    || positions.at(-1)?.effort
    || null;
}

/**
 * 客户端意图 → 实际转发档位。
 *
 * 与 resolveReasoningEffort 的唯一区别：**目录给不出答案时透传客户端声明的值**。
 * 旧判定链把「目录里没有这个模型」和「模型不支持 reasoning」压成同一个 null，
 * 于是一次目录未预热就会静默删掉 reasoning_effort —— DeepSeek Harness 的模型
 * 列表是手写的，从不触发目录预热，因此它的思维链一直是整段丢失的。
 *
 * 「未声明」与「显式 none」两条既有语义刻意保持不变：是否思考不应由模型目录的
 * 元数据字段翻转，客户端显式表达的意图应当照发。
 *
 * @param {string|null|undefined} requested 客户端声明的档位；null/undefined 表示没声明
 * @param {object|null} declaration 该模型的目录声明；null 表示未知
 * @returns {{ effort: string|null, source: 'passthrough'|'mapped'|'default'|'disabled'|'unsupported' }}
 */
export function resolveRequestedEffort(requested, declaration) {
  const hasRequest = requested !== null && requested !== undefined;
  const raw = hasRequest ? canonical(requested) : null;
  if (hasRequest) assertAccepted(raw);

  if (declaration && declaration.form === 'none') {
    return { effort: null, source: 'unsupported' };
  }
  if (!hasRequest) return { effort: 'none', source: 'default' };
  if (raw === 'none') return { effort: 'none', source: 'disabled' };
  if (declaration?.efforts?.length) {
    return { effort: mapToDeclaration(raw, declaration), source: 'mapped' };
  }
  // 目录给不出答案（未预热 / 模型不在目录里）：不再删除客户端的意图。
  return { effort: raw === 'minimal' ? 'low' : raw, source: 'passthrough' };
}

export function resolveReasoningEffort(requested, declaration) {
  return resolveRequestedEffort(requested, declaration).effort;
}

export function budgetEffort(thinking) {
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) {
    throw bad('thinking must be an object');
  }
  if (!Object.hasOwn(thinking, 'type')) {
    throw bad('thinking.type is required');
  }
  if (thinking.type === 'disabled') return 'none';
  if (thinking.type !== 'enabled') {
    throw bad(`unknown thinking.type: ${JSON.stringify(thinking.type)}`);
  }

  const budget = thinking.budget_tokens;
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw bad('thinking.budget_tokens must be a non-negative integer');
  }
  if (budget < 4096) return 'low';
  if (budget < 16384) return 'high';
  return 'max';
}
