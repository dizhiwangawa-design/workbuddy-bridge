// 编码代理的「回合收尾」约束。
//
// 背景：codex / dsh 这类客户端把「模型这一轮没有发出工具调用」当作任务结束。
// 模型只要在回合末尾写一句「先停掉测试：」这类散文，客户端就判定完成、把控制权
// 交回用户，用户必须手动打「继续」才能往下走。所有支持 tool calling 的上游都能
// 稳定复现，因此这不是某个模型的问题，而是提示层缺少循环约束。
//
// 处理方式：只要本次请求带工具、且判定这条约束适用，就在 messages 末尾补一条
// system 约束，明确告诉模型「没做完就必须继续发工具调用」。
//
// 三条设计约束（都是踩过坑之后补的）：
//   1. 只有规则 1 是「必须调用工具」，其余规则不能反过来压制可观测性 —— 见规则 2。
//   2. `tool_choice:"none"` 时不注入：客户端明确说这次别用工具，约束不能硬顶。
//   3. 默认只对编码 Agent 生效（auto）：这是为 codex/dsh 的收尾判定写的补丁，
//      不该污染普通 API 用途。

/** 用于识别已插入的约束，防止重试或多轮拼装时重复注入。 */
export const CONTINUATION_NUDGE_MARKER = '运行约束（自动化编码循环，务必遵守）';

/**
 * 约束正文。
 *
 * 规则 2 曾写作「不要在回复里预告或复述『我正在…』『接下来我会…』」。它省下一次
 * 纯散文往返，代价是**过程完全不可见**：出问题时看不出模型在做什么，也看不出它
 * 为什么选了这条路。实测 codex 在「同一轮里既写说明又发工具调用」时不会提前收尾
 * （上游被请求 2 轮、说明文字正常展示），所以这句可以放开：允许一句话说明，但要
 * 求说明之后必须真的发工具调用。
 */
export const CONTINUATION_NUDGE = `${CONTINUATION_NUDGE_MARKER}
1. 这是一次连续的代理回合。任务未完成时，你的回复必须包含至少一个工具调用；只输出文字而不调用工具会被运行环境当作任务结束，用户必须手动催促才能继续。
2. 需要让用户看懂进度时，可以用一两句话说明“在做什么、为什么”，然后立刻发出工具调用。说明不等于执行：不要只写计划却不调用工具。
3. 只有任务全部完成、并且已经用工具验证过结果之后，才可以输出不带工具调用的最终总结。
4. 需要修改文件时使用文件编辑工具；一次改不完就连续调用多次。除非运行环境明确要求确认（approval 策略、危险操作），不要停下来征求许可。
5. 补丁应用失败（上下文不匹配、范围过大）时，把改动拆成更小的 hunk 重试；同一处连续失败两次后，改为读取原文重写整段，并说明卡在哪里，不要无限重试同一形状的补丁。`;

/** 生效模式：off（永不）/ auto（仅编码 Agent 与工具循环）/ always（强制）。 */
export const NUDGE_MODES = Object.freeze(['off', 'auto', 'always']);

function matchesOff(value) {
  return /^(0|false|no|off)$/i.test(String(value ?? '').trim());
}

function matchesOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

/**
 * 解析生效模式。优先级：环境变量 > 设置项 > 默认 auto。
 *
 * `paths.js` 的 defaultConfig 会把 `continuationNudge` 合进 apiCompat，所以设置项
 * 几乎总是存在；如果让设置项优先，`WB_CONTINUATION_NUDGE` 就永远不会生效。
 * 环境变量在这里定位是运维应急开关，必须能盖住磁盘上的配置。
 *
 * @param {object} [config] apiCompat 配置
 * @returns {'off'|'auto'|'always'}
 */
export function continuationNudgeMode(config) {
  const override = String(process.env.WB_CONTINUATION_NUDGE ?? '').trim();
  if (override) {
    if (matchesOff(override)) return 'off';
    if (matchesOn(override)) return 'always';
  }
  if (typeof config?.continuationNudge === 'boolean') {
    return config.continuationNudge ? 'auto' : 'off';
  }
  return 'auto';
}

/** 兼容旧调用方：返回「是否可能注入」，供不需要细分的场景使用。 */
export function continuationNudgeEnabled(config) {
  return continuationNudgeMode(config) !== 'off';
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct.join(', ');
  return direct === undefined || direct === null ? '' : String(direct);
}

function hasCodexMetadata(body) {
  const meta = body?.client_metadata;
  if (!meta || typeof meta !== 'object') return false;
  return Object.keys(meta).some((key) => key.startsWith('x-codex'));
}

/**
 * 判断请求来自「以无工具调用判定回合结束」的编码 Agent。
 *
 * 实测特征：
 *   - codex：`originator: codex_exec`、`x-codex-*` 请求头、`client_metadata` 里带
 *     `x-codex-turn-metadata`
 *   - dsh / pi-ai：`user-agent: pi (<platform> <release>; <arch>)`
 */
export function detectAgentClient({ headers = null, body = null } = {}) {
  const originator = headerValue(headers, 'originator').toLowerCase();
  if (originator.startsWith('codex')) return 'codex';
  const userAgent = headerValue(headers, 'user-agent');
  if (/^pi\b/i.test(userAgent)) return 'dsh';
  if (headerValue(headers, 'x-codex-turn-metadata')) return 'codex';
  if (headerValue(headers, 'session-id') && /codex/i.test(userAgent)) return 'codex';
  if (hasCodexMetadata(body)) return 'codex';
  return null;
}

/**
 * 本次请求要不要注入约束。
 *
 * @param {object} options
 * @param {'off'|'auto'|'always'} options.mode 生效模式
 * @param {object|null} [options.headers] 原始请求头
 * @param {object|null} [options.body] 客户端请求体（用于识别 client_metadata）
 * @param {boolean} [options.hasToolLoop] 历史里是否已有工具调用往返
 * @returns {boolean}
 */
export function continuationNudgeApplies({
  mode = 'auto',
  headers = null,
  body = null,
  hasToolLoop = false,
} = {}) {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return Boolean(detectAgentClient({ headers, body })) || hasToolLoop === true;
}

const TOOL_CALL_ITEM_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'shell_call',
]);

/**
 * Responses 请求里是否已经出现过工具往返。
 *
 * 「历史里有工具调用」是「这个客户端在跑工具循环」的最强本地证据：
 * 首轮纯问答不该被注入，但一旦它已经在循环里，就应该继续被约束。
 */
export function responsesHasToolLoop(body) {
  const input = body?.input;
  if (!Array.isArray(input)) return false;
  return input.some((item) => {
    const type = String(item?.type || '');
    return TOOL_CALL_ITEM_TYPES.has(type) || type.endsWith('_output');
  });
}

/** Chat Completions：历史里有 tool_calls 或 role:"tool" 即视为在工具循环里。 */
export function chatHasToolLoop(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => (
    message?.role === 'tool'
    || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)
  ));
}

/** Anthropic Messages：历史里有 tool_use / tool_result 即视为在工具循环里。 */
export function anthropicHasToolLoop(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    const content = message?.content;
    if (!Array.isArray(content)) return false;
    return content.some((block) => (
      block?.type === 'tool_use' || block?.type === 'tool_result'
    ));
  });
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (
      typeof part === 'string'
        ? part
        : typeof part?.text === 'string'
          ? part.text
          : ''
    ))
    .join('');
}

/** 已经带了同一条约束就不再重复插入。 */
function alreadyNudged(messages) {
  return messages.some((message) => (
    message?.role === 'system'
    && messageText(message).includes(CONTINUATION_NUDGE_MARKER)
  ));
}

function hasToolDeclarations(tools) {
  if (Array.isArray(tools)) return tools.length > 0;
  return Number(tools) > 0;
}

function choiceIsNone(toolChoice) {
  return toolChoice === 'none' || toolChoice?.type === 'none';
}

/**
 * 在 messages 末尾追加回合约束。
 *
 * 位置选择：**整个消息列表末尾**，而不是「最后一条 user 之后」。
 *   - 真实请求的尾部是工具往返（function_call / tool_use），不是 user；
 *     插在最后一条 user 之后等于把约束塞进历史中段，与「这一轮要干嘛」隔开。
 *   - 工具组已经闭合（assistant(tool_calls) + tool 结果成对结束），末尾追加不会
 *     破坏相邻性。
 *   - 上游接受末尾 system（实测 system 在开头 / user 后 / tool 后 / 最末尾均 200）。
 *
 * 返回新数组（不修改入参）；不满足条件时原样返回同一引用，便于调用方判断是否
 * 发生过注入。
 */
export function withContinuationNudge(messages, {
  tools,
  enabled = true,
  toolChoice = null,
} = {}) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  if (!enabled) return messages;
  if (!hasToolDeclarations(tools)) return messages;
  // 客户端明确不要工具调用时，约束与 tool_choice 冲突，不注入。
  if (choiceIsNone(toolChoice)) return messages;
  if (alreadyNudged(messages)) return messages;
  return [...messages, { role: 'system', content: CONTINUATION_NUDGE }];
}
