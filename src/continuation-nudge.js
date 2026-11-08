// 编码代理的「回合收尾」约束。
//
// 背景：codex / dsh 这类客户端把「模型这一轮没有发出工具调用」当作任务结束。
// 模型只要在回合末尾写一句「先停掉测试：」这类散文，客户端就判定完成、把控制权
// 交回用户，用户必须手动打「继续」才能往下走。所有支持 tool calling 的上游都能
// 稳定复现，因此这不是某个模型的问题，而是提示层缺少循环约束。
//
// 处理方式与 reverse-proxy 的 CONTINUATION_NUDGE 保持一致：只要本次请求带工具，
// 就在最后一条 user 消息之后插一条 system 约束，明确告诉模型「没做完就必须继续
// 发工具调用」。不带工具的纯问答请求不插入，避免污染普通 API 用途。

/** 用于识别已插入的约束，防止重试或多轮拼装时重复注入。 */
export const CONTINUATION_NUDGE_MARKER = '运行约束（自动化编码循环，务必遵守）';

export const CONTINUATION_NUDGE = `${CONTINUATION_NUDGE_MARKER}
1. 这是一次连续的代理回合。任务未完成时，你的回复必须包含至少一个工具调用；只输出文字而不调用工具会被运行环境当作任务结束，用户必须手动催促才能继续。
2. 不要在回复里预告或复述“我正在…”“接下来我会…”。要做的动作直接作为工具调用发出。
3. 只有任务全部完成、并且已经用工具验证过结果之后，才可以输出不带工具调用的最终总结。
4. 需要修改文件时使用文件编辑工具；一次改不完就连续调用多次，不要中途停下来征求意见。
5. 补丁应用失败（上下文不匹配、范围过大）时，把改动拆成更小的 hunk 重新提交，不要放弃，也不要用文字解释失败原因代替重试。`;

/**
 * 开关优先级：环境变量 > 设置项 > 默认开启。
 *
 * `paths.js` 的 defaultConfig 会把 `continuationNudge` 合进 apiCompat，所以设置项
 * 几乎总是存在；如果让设置项优先，`WB_CONTINUATION_NUDGE=0` 就永远不会生效。
 * 环境变量在这里定位是运维应急开关，必须能盖住磁盘上的配置。
 */
export function continuationNudgeEnabled(config) {
  const override = String(process.env.WB_CONTINUATION_NUDGE ?? '').trim();
  if (override) return !matchesOff(override);
  if (typeof config?.continuationNudge === 'boolean') return config.continuationNudge;
  return true;
}

function matchesOff(value) {
  return /^(0|false|no|off)$/i.test(String(value ?? '').trim());
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

/**
 * 在最后一条 user 消息之后插入回合约束。
 *
 * 返回新数组（不修改入参）；不满足条件时原样返回同一引用，便于调用方判断是否
 * 发生过注入。工具调用与结果之间的相邻关系不受影响：约束总是落在 user 之后的
 * 第一个位置，assistant(tool_calls) 与随后的 tool 结果仍然紧邻。
 */
export function withContinuationNudge(messages, { tools, enabled = true } = {}) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  if (!enabled) return messages;
  if (!hasToolDeclarations(tools)) return messages;
  if (alreadyNudged(messages)) return messages;
  const nudge = { role: 'system', content: CONTINUATION_NUDGE };
  let index = -1;
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor]?.role === 'user') {
      index = cursor;
      break;
    }
  }
  if (index < 0) return [...messages, nudge];
  return [...messages.slice(0, index + 1), nudge, ...messages.slice(index + 1)];
}
