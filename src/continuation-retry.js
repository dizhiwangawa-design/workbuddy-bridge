// 「回合被截停」（turn cut）的判定与续跑工具。
//
// 背景：codex / dsh 这类客户端把「模型这一轮没有发出工具调用」当作任务结束。
// 模型在长任务中途写一句「接着把 manifest 挂到 Sync 路由」就停下，客户端据此判定
// 完成、把控制权交还用户。`continuation-nudge.js` 的提示词侧补救已三次实测无效：
// 把指令放在首个/中途/末尾 system 或末尾 user，4/4 全部被遵守——约束送到了，但
// 它管不住客户端的判定规则。所以补救必须在**判定层级**：桥接层看到「宣布下一步
// 却不发工具调用」时，自己再要一轮。
//
// 判定方向是刻意不对称的（这是防误伤的护栏，不是可以放宽的地方）：
//   - 误判「该续」→ 多发一轮请求，终态照样给用户，代价小；
//   - 误判「不该续」→ 用户永远收不到最终答复，代价大。
// 所以「已完成」一侧宽进（末句或尾部出现完成措辞就不再续），「宣布」一侧窄出
// （必须是明确的宣布句型）。
//
// 本文件只放纯函数（判定谓词、续跑指令、去重合并、开关解析），便于单测；
// 网络与状态机留在 api-responses.js 的 run() 里。

/**
 * 追加给上游的续跑指令。
 *
 * 措辞要求（都是踩过的坑）：
 *   - 「直接执行下一步」压住「再描述一遍计划」；
 *   - 「不要复述已经做过的事」压住重复正文——重复的说明会原样出现在终态里，
 *     专门有用例守着。
 */
export const CONTINUATION_RETRY_PROMPT =
  '继续。直接执行下一步，不要再描述计划或复述已经做过的事。';

/** 判定只看正文末尾若干字符：正文中间提到「接下来」不该触发。 */
const TAIL_CHARS = 220;

/** 动作动词集：宣布型措辞后面必须真的跟一个动作，否则只是「接下来你可以…」。 */
const ACTION = '把|补|改|加|写|跑|看|做|实现|处理|修|删|移|挂|接|检查|验证|执行|运行|创建|新增|更新|替换|开始|继续|重新';
/** 宣布与动作之间允许出现的模态词。 */
const MODAL = '就|再|会|将|要|去|来|先|马上|立刻|需要';

/**
 * 宣布型措辞。中英混合，覆盖实测到的两类形态：
 *   1. 纯宣布：「接下来我会…」「我先…」「Let me…」「Next, …」
 *   2. 里程碑 + 宣布：「`Store` 已修复并编译通过。接着把 manifest 挂到 Sync 路由」
 *
 * 每条都要求「宣布词 + 动作动词」，这条约束让「接下来你可以在面板查看」这类
 * 真正的收尾建议不会误触发。
 */
const ANNOUNCE_PATTERNS = [
  // 接下来 / 下一步 / 然后我 / 随后我 (+ 我/模态词) + 动作
  new RegExp(`(?:^|[。！？；：，,.;!?\\n\\s])(?:接下来|下一步|下面(?:我)?|然后|随后)(?:我)?(?:${MODAL})*(?:${ACTION})`),
  // 接着 / 接着说…：单独的「接着」后必须跟动作
  new RegExp(`(?:^|[。！？；：，,.;!?\\n\\s])接着(?:我)?(?:${MODAL})*(?:${ACTION})`),
  // 现在(我)(就)(去|来|把|补|…)
  new RegExp(`(?:^|[。！？；：，,.;!?\\n\\s])现在(?:我)?(?:${MODAL})*(?:${ACTION})`),
  // 第一人称意志：我会 / 我将 / 我先 / 我这就
  new RegExp(`我(?:会|将|先|接着|这就|马上|立刻)(?:${MODAL})*(?:${ACTION})`),
  // 句首或跟在冒号后的「继续」：「测试继续通过」不会被命中
  /(?:^|[。！？；：\n])\s*继续/,
  // 英文：let me / i'll / i will / next / then i / now (i|we)
  /(?:^|[.!?;:,\n]\s*)(?:let me|let's|next[,:]?\s|then i(?:'ll| will| need)?|now (?:i|we))\b/i,
  /\b(?:i'll|i will|i'm going to|i am going to|i need to)\b/i,
];

/**
 * 「已完成」措辞，宽进：命中就不再续跑。
 *
 * 分两档：
 *   - STRONG：整个尾部命中即算完成（「测试通过」「全绿」「tests pass」）；
 *   - WEAK：只认**末句**，避免「已修复并编译通过。接着把 X」被当成收尾。
 */
const STRONG_FINAL_PATTERNS = [
  /(?:测试|用例|suite)[^。.!?\n]{0,20}(?:通过|全绿)/i,
  /\btests? (?:all )?(?:pass|passed|are passing|green)\b/i,
  /\ball (?:steps|tasks|checks|tests) (?:are )?(?:complete|done|pass)/i,
  /(?:全部|均|都)(?:完成|通过|已修复)/,
  /(?:没有|无)(?:遗留|待办|剩余|未完成)/,
];

const WEAK_FINAL_PATTERNS = [
  /(?:完成|搞定|结束|收工)(?:了)?[。！!.]?$/,
  /(?:通过|全绿)(?:了)?[。！!.]?$/,
  /修好了/,
  /\b(?:done|finished|complete|completed|all set|everything works)\b[.!]?$/i,
];

/** 取正文末尾若干字符用于判定。 */
export function tailOf(text, limit = TAIL_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return value.slice(-limit);
}

/**
 * 取末句：结论通常落在最后一句，而中间句可能只是里程碑。
 *
 * 代码块的收尾（```）不当作句末，否则一整段代码会被切走。
 */
export function lastSentence(text) {
  const value = String(text ?? '').replace(/```[\s\S]*?```/g, ' ');
  const parts = value.split(/(?<=[。！？!?\n])|(?<=[.]\s)/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : value.trim();
}

/**
 * 正文是否在「宣告完成」。宽进：判定为完成只是不续跑，代价可接受。
 *
 * @param {string} text 本轮正文
 * @returns {boolean}
 */
export function announcesCompletion(text) {
  const tail = tailOf(text).trim();
  if (!tail) return false;
  if (STRONG_FINAL_PATTERNS.some((pattern) => pattern.test(tail))) return true;
  const sentence = lastSentence(tail);
  return WEAK_FINAL_PATTERNS.some((pattern) => pattern.test(sentence));
}

/**
 * 正文是否在「宣布下一步」。窄出：必须是明确的「宣布词 + 动作」句型。
 *
 * @param {string} text 本轮正文
 * @returns {boolean}
 */
export function announcesNextStep(text) {
  const tail = tailOf(text);
  if (!tail.trim()) return false;
  return ANNOUNCE_PATTERNS.some((pattern) => pattern.test(tail));
}

/**
 * 本次回合要不要续跑。
 *
 * 条件全部满足才续（宁可不续）：开关 → finish_reason → 有工具 → tool_choice →
 * 本轮没有工具调用 → 未超上限 → 不是完成措辞 → 确实是宣布型收尾。
 *
 * @param {object} options
 * @param {boolean} options.enabled 开关（config.continuationRetry，含环境变量覆盖）
 * @param {string|null} options.finishReason 上游给的收尾原因
 * @param {boolean} options.toolsDeclared 本次请求是否声明了工具
 * @param {string|object|null} options.toolChoice 客户端的 tool_choice
 * @param {number} options.callCount 本轮解析出的工具调用数
 * @param {string} options.content 本轮正文
 * @param {number} [options.retries] 已经续跑过的次数
 * @param {number} [options.maxRetries] 上限，默认 1
 * @returns {{ retry: boolean, reason: string }}
 */
export function shouldContinueTurn({
  enabled = true,
  finishReason = null,
  toolsDeclared = false,
  toolChoice = null,
  callCount = 0,
  content = '',
  retries = 0,
  maxRetries = 1,
  dsmlTruncated = false,
} = {}) {
  if (!enabled) return { retry: false, reason: 'disabled' };
  // 信封被截断（模型把工具调用标记写进正文却没写完）是「话没说完」的最强证据：
  // 这一轮既没有可执行的工具调用，正文又停在半截，不做续跑就只能把控制权交回用户。
  // 对外仍报 length/incomplete（半截参数不可执行，客户端必须知道没完成），但这里
  // 要放行一次续跑——两者不冲突：续跑拿到的新一轮若正常收尾，终态随之更新。
  // 其余 finish_reason（content_filter / tool_calls）仍走原有逻辑。
  const truncated = Boolean(dsmlTruncated);
  if (!truncated && String(finishReason || '') !== 'stop') {
    return { retry: false, reason: 'finish_reason' };
  }
  if (!toolsDeclared) return { retry: false, reason: 'no_tools' };
  if (toolChoice === 'none' || toolChoice?.type === 'none') {
    return { retry: false, reason: 'tool_choice_none' };
  }
  if (Number(callCount) > 0) return { retry: false, reason: 'has_tool_calls' };
  if (Number(retries) >= Number(maxRetries)) return { retry: false, reason: 'retry_exhausted' };
  if (announcesCompletion(content)) return { retry: false, reason: 'completion' };
  if (!announcesNextStep(content)) return { retry: false, reason: 'no_announcement' };
  return { retry: true, reason: 'turn_cut' };
}

/**
 * 解析续跑开关：环境变量 > 设置项 > 默认开启。
 *
 * 与 `continuation-nudge.js` 同优先级：defaultConfig 总会写默认值，让设置项
 * 优先会让 `WB_CONTINUATION_RETRY=0` 永远不生效，而这个变量的定位正是运维
 * 应急开关。
 *
 * @param {object} [config] apiCompat 配置
 * @returns {boolean}
 */
export function continuationRetryEnabled(config) {
  const override = String(process.env.WB_CONTINUATION_RETRY ?? '').trim();
  if (override) {
    if (/^(0|false|no|off)$/i.test(override)) return false;
    if (/^(1|true|yes|on)$/i.test(override)) return true;
  }
  if (typeof config?.continuationRetry === 'boolean') return config.continuationRetry;
  return true;
}

/**
 * 剥掉续跑正文开头重复的上一轮说明。
 *
 * 续跑指令说了「不要复述」，但上游仍可能把同一句说明再写一遍；同一句出现在
 * 终态里两次会让客户端以为进度重复了。只剥**前缀**：正文中段提到同样的话是
 * 正常的引用，不能动。
 *
 * @param {string} previous 上一轮正文
 * @param {string} next 续跑正文
 * @returns {string}
 */
export function stripRepeatedPreamble(previous, next) {
  const before = String(previous ?? '').trim();
  const after = String(next ?? '').trim();
  if (!before || !after) return String(next ?? '');
  // 整段相同：续跑没有新内容，保留一份就够。
  if (after === before) return '';
  if (after.startsWith(before)) {
    return after.slice(before.length).replace(/^[\s。.!?]+/, '').trim();
  }
  // 只重复了上一轮的末句：按句切分找最长公共前缀句。
  const sentences = before
    .split(/(?<=[。！？.!?\n])/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (let count = Math.min(sentences.length, 4); count >= 1; count -= 1) {
    const prefix = sentences.slice(sentences.length - count).join('');
    if (prefix && after.startsWith(prefix)) {
      return after.slice(prefix.length).replace(/^[\s。.!?]+/, '').trim();
    }
  }
  return after;
}

/**
 * 把续跑回合的工具调用合并进第一轮，`call_id` 保持唯一。
 *
 * 两轮的 id 撞车时必须改名，否则客户端的 `function_call_output` 会配错对。
 *
 * @param {Array<{id:string,name:string,input:object}>} first
 * @param {Array<{id:string,name:string,input:object}>} next
 * @param {{requestId?: string, usedIds?: Set<string>}} [options]
 * @returns {Array<{id:string,name:string,input:object}>}
 */
export function mergeToolCalls(first, next, { requestId = '', usedIds = null } = {}) {
  const used = usedIds instanceof Set ? usedIds : new Set();
  const out = [];
  const stem = `toolu_${requestId || 'continuation'}`;
  for (const call of [...(first || []), ...(next || [])]) {
    let id = String(call?.id || '').trim();
    if (!id || used.has(id)) id = `${stem}_${out.length}`;
    let suffix = out.length;
    while (used.has(id)) {
      suffix += 1;
      id = `${stem}_${suffix}`;
    }
    used.add(id);
    out.push({ ...call, id });
  }
  return out;
}

/**
 * 合并两轮 usage：续跑是**同一个** response，但输入侧和输出侧的算法不一样。
 *
 * 输入侧取两轮的**较大值**，不能相加：第二轮把全部上下文（含第一轮的输出）重发了
 * 一遍，所以 1200 本身就是终态的真实上下文占用，加出来 2200 是把同一份上下文数了
 * 两次。这个数直接喂给客户端的上下文占用统计（codex / dsh 按它算剩余窗口），
 * 加了就凭空占掉一倍窗口。cached 输入是输入侧的一部分，同口径取较大值。
 *
 * 输出侧仍然相加：两轮都真的生成了 token，不累加就是少记账。
 */
export function mergeUsage(first, next) {
  const a = first || {};
  const b = next || {};
  const max = (key) => Math.max(Number(a[key]) || 0, Number(b[key]) || 0);
  const sum = (key) => (Number(a[key]) || 0) + (Number(b[key]) || 0);
  return {
    prompt_tokens: max('prompt_tokens'),
    completion_tokens: sum('completion_tokens'),
    reasoning_tokens: sum('reasoning_tokens'),
    cached_tokens: max('cached_tokens'),
  };
}

/** 合并推理通道：两轮摘要依次拼接，中间补一个空行分隔。 */
export function mergeReasoning(first, next) {
  const a = String(first ?? '').trim();
  const b = String(next ?? '').trim();
  if (!a) return b;
  if (!b) return a;
  return `${a}\n\n${b}`;
}
