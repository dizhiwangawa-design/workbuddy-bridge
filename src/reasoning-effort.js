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

export function resolveReasoningEffort(requested, declaration) {
  const raw = requested === null || requested === undefined
    ? 'none'
    : canonical(requested);
  if (!ACCEPTED.has(raw)) {
    throw bad(`unknown reasoning effort: ${JSON.stringify(requested)}`);
  }
  if (!declaration || declaration.form === 'none' || !declaration.efforts?.length) {
    return null;
  }
  if (raw === 'none') return 'none';

  const wanted = raw === 'minimal' ? 'low' : raw;
  const supported = declaration.efforts;
  if (supported.includes(wanted)) return wanted;

  const wantedIndex = REASONING_LADDER.indexOf(wanted);
  const positions = supported
    .map((effort) => ({
      effort,
      index: REASONING_LADDER.indexOf(effort),
    }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);

  return positions.find((item) => item.index >= wantedIndex)?.effort
    || positions.at(-1)?.effort
    || null;
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
