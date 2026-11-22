# DSH 思维链缺失与速度失真修复指南（v2.1）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development 或
> superpowers:executing-plans 按任务逐条执行。所有步骤用 `- [ ]` 复选框跟踪。
>
> **执行状态（已被实际提交超越，以本节为准）：**
>
> | 任务 | 状态 | 证据 |
> |---|---|---|
> | T1 纯函数层 passthrough | **已合并** | `aced061` `fix: forward the requested reasoning effort when the catalogue has no entry` |
> | T2 接入三条协议 | **已合并** | 同上一条之后的三协议调用点切换（`src/reasoning-effort.js` 的 `resolveRequestedEffort`） |
> | T3a 索引重构 + 推理结束事件 | **已合并** | `fb54007` `fix: give each responses block its own output index and close reasoning increments` |
> | T4 Responses usage 缓存字段 | **已合并** | `3d15bf4` `fix: pass upstream prompt-cache hits through responses usage` |
> | T5 Chat / Anthropic usage 明细 | **已合并** | `40aac50` `fix: report upstream prompt-cache hits on chat and anthropic usage` |
> | T3b 工具参数按上游帧下发 | **未做，且按新判据应回滚不做** | 见下方「T3b 的最终结论」 |
> | T6 文档与验收 | **部分完成** | README / CHANGELOG 已改；本文件的「尚未执行」已在此处纠正 |
>
> **T3b 的最终结论（与 §5 的「先测量再决定」一致）：不做。**
> 本轮实测上游把参数切成 10 帧 / 40 ms 发完；即使桥接逐帧转发，`decodeMs` 也只从 ~0 涨到 40 ms，
> 而 `outputTokens` 里仍含工具调用框架开销（实测 out=42 token / 30 字符参数），速度读数仍会虚高。
> 更重要的是：把 `function_call_arguments.delta` 提前下发，会让「未经仲裁的可执行参数」出现在流里，
> 与 `test/api/responses.test.mjs` 的两条既有契约冲突（`流式工具 item 使用合法 function/custom 结构并与 completed 身份一致`、
> `拒绝同轮合法调用旁边的半截结构化工具参数`）。本次实施时实测到这两条变红，已按契约回滚。
> **要真正修好速度读数，需要在 DSH 侧把 outputTokens 拆成 reasoning / text / toolcall-frame，属于本仓库之外。**
>
> **v2 变更摘要**（相对 v1）：撤掉 `canDisableThinking` 参与判定（§9.1）；索引重构并入 3a
> 并把顺序提前（§9.2）；T3 收益重新定性、3b 降级为「先测量再决定」（§9.3）；修掉 3 处会让
> 执行静默出错的 P0（§9.4）；全文 `文件:行` 改为**符号锚点**（§9.5）。
>
> **v2.1 变更摘要**（第二轮评审）：`output_index` 必须等于终态下标，新增硬规则与 Step 4b（§9.9-1）；
> 统计脚本作为 T3a Step 0 交付物落地、已实测（§9.9-2）；§0.2 数据全量重算并删掉绝对 tps 判据
> （§9.9-3）；§1 / §9.6 措辞修正，并据外部实测新增「双信号」验收（§9.9-4/5/6）。

**Goal:** 让桥接把客户端声明的推理档位真正送到上游（思维链恢复），并让下行的工具调用
按真实节奏到达（修正 DSH 侧速度读数），同时不破坏正在进行的其他修复。

**架构判断:** 两个症状来自两处「提前压平」：**客户端意图**被归一化到「已知能力」之外就删字段；
**上游工具参数的到达节奏**被攒成瞬时块。修复分两条主线（effort 透传 / 增量时序），改动面几乎
不重叠，可独立落地、独立回滚。

**Tech Stack:** Node.js `>=22.13`，原生 ESM，`node:test`，零新增依赖。

**前置文档:** `docs/superpowers/specs/2026-11-08-reasoning-effort-routing-design.md`、
`docs/superpowers/plans/2026-11-08-reasoning-effort-pr1.md`。

**基线:** 含并行工作 4 个未提交文件时 `node test/api/run.mjs` = 293/293，exit 0。

---

## 0. 审计结论（修复依据）

### 0.1 思维链为什么不见了

| 观测 | 证据 | 状态 |
|---|---|---|
| 上游只认 `reasoning_effort`，`none` 或字段缺失都不返回 `reasoning_content` | 真实上游对照：`max` 有推理；冷目录删字段 0 条；未声明显式 `none` 0 条 | 成立 |
| 目录未知时桥接**删除**字段 | `resolveReasoningEffort` 在 catalog 缺失时 `return null`（符号锚点 `resolveReasoningEffort`），`applyReasoningEffort` 随即 `delete prepared.body.reasoning_effort`（符号锚点 `applyReasoningEffort`） | 成立 |
| 客户端没声明时桥接显式发 `none` | `resolveReasoningEffort` 把 `null` 归一成 `'none'`（同一函数首行） | 成立 |
| 生产里目录**永远是冷的** | 目录只在 `GET /v1/models` 时填充、只在内存、TTL 10 分钟；dsh 走网络发现只采纳 id/名称/容量，从不触发读取 | 成立 |
| dsh 端到端复现 | 冷目录 `forwardedEfforts:["null"]`、`dshReasoningSteps:0`；热目录 `forwardedEfforts:["max","none"]`、`dshReasoningSteps:1` | 成立 |

**推理是否「有时有有时没有」**：真实上游的思考出现率有较大抖动（同一 prompt 同样带
`effort:max`，受控实验里 3 次只有 1 次返回 `reasoning_content`）。这**不是**桥接的 bug，
但它放大了冷目录问题——原本 100% 会丢，热目录下也有相当比例本来就拿不到。

### 0.2 速度为什么虚高

DSH 的算法是 `tps = ΣoutputTokens / Σ(decodeMs)`，`decodeMs = Σ(t_message − t_firstToken)`。
桥接把工具参数攒成瞬时块，纯工具调用步因此 `decodeMs ≈ 0`。

**实测分类（真实 dsh 会话 `--mnt-windata-awa-NAPCAT--`，脚本见 §10）**

会话 A（`session-8b4adb24…`，251 步）：

| 步型（有推理 R / 有工具调用 T / 有正文 X） | 步数 | output token | token 占比 | 零窗口步 |
|---|---|---|---|---|
| `-T-`（纯工具调用） | **198** | 38,131 | 63.4% | **198（全部）** |
| `-TX`（工具调用 + 正文） | 32 | 9,786 | 16.3% | 0 |
| `RT-`（推理 + 工具调用） | **14** | **7,399** | 12.3% | 0 |
| `RTX` | 4 | 2,517 | 4.2% | 0 |
| `--X`（只有正文） | 3 | 2,325 | 3.9% | 0 |
| **合计** | **251** | **60,158** | 100% | 198 |

会话 B（`session-a5a3c82c…`，250 步）做交叉验证：`-T-` 183 步 / 46,852 token（44.1%），
零窗口 188 步 / 47,459 token（44.7%）——**同一个现象，比例随推理出现率浮动**。

**结论：零窗口 token 100% 落在「纯工具调用步」**（会话 A 占 63.4%，会话 B 占 44.7%），
其余步型的零窗口步数为 0。修的方向因此很清楚——**不是**「让推理更流式」（它本来就是流式的），
而是**让工具调用按上游真实节奏到达**。

> 注意：`RT-`（有推理 + 工具调用）步**零窗口数为 0**，因为推理增量本身就把窗口撑开了。
> 这解释了为什么「修好思维链」会**间接**改善速度读数——多出来的推理步自带时间轴。

**上游的真实节奏（多规模实测，5 条命令 × 2 种前缀）**

| 命令长度 | `tool_calls` 帧数 | 首帧→末帧跨度 |
|---|---|---|
| `ls` | 8 | 48–57 ms |
| `ls src` | 9 | 53–72 ms |
| `cat package.json` | 10 | 67–75 ms |
| `grep -n "reasoning" …`（长） | 24 | 79–108 ms |
| `sed -n 1,120p …`（长） | 23 | 101–108 ms |

上游把 `function.arguments` 切成小帧，**48–108 ms** 内发完；桥接把它拼成一个字符串，
在响应结束时一次性下发（符号锚点 `push('response.function_call_arguments.delta'`），
于是这段生成窗口塌成 0。

**桥接能修到的上限（按上述实测重算，不是拍脑袋）**

| 场景 | 现状 | 补上 48 ms/步 | 补上 108 ms/步 |
|---|---|---|---|
| 会话 A 全量 251 步 | 527 tok/s | 487 | 444 |
| 会话 A 第 114 步快照（截图口径 906.5） | 906 tok/s | 767 | 643 |

> **所以 3b 的收益是「去掉虚高的最后一段」，不是「回到真实速度」。** 它把截图上那个
> 四位数拉下三成到四成，但读数仍会停在数百——因为 `outputTokens` 里含工具调用框架开销
> （实测 `out=42 token / 30 字符 arguments`），这是 DSH 的口径，桥接改不了。
> **验收判据因此不采用绝对 tps，只采用「零窗口 token 占比」这个相对量**（见 T3b 的 Step 3）。

### 0.2b 为什么「修桥接」不能根治速度读数（必须写清楚，否则验收会误判）

`decodeMs` 的分子是 `outputTokens`，而 `outputTokens` 里含**上游工具调用框架的开销**
（实测：`out=42 token` 对应 `30` 字符 arguments）。这些 token 不是「用户可见的生成」，
但 DSH 把它们全部计进速率分子。因此：

- 桥接能让**分母**（decode 窗口）变真实：把 0 ms 恢复到 48–108 ms/步。
- 桥接**改不了分子**：框架 token 依然计入。
- 结论：修好之后的读数**仍然是偏低的分母 + 偏高的分子**组合，只是从「虚高 3–4 倍」
  变成「虚高 1.5–2 倍」。要彻底对齐需要在 DSH 侧把 `outputTokens` 拆成
  `reasoning + text + toolcall-frame`，这属于本仓库之外。

**这条对计划的影响**：验收判据只保留相对量（零窗口 token 占比），不设绝对 tps 阈值。

### 0.3 顺带确认的三个缺陷

- **输出索引冲突（v1 → v2 已升级为 P0 必修）**：`textDelta` 里
  `outputIndex += reasoningItem ? 1 : 0`（符号锚点 `outputIndex += reasoningItem`）在
  「正文先到、推理后到」时会让 message 与 reasoning 共用 `output_index 0`。用 pi-ai 自己的
  `processResponsesStream` 跑这段事件序列，最终 content 是
  `[text:"先写正文。", thinking:"然后我才思考。", text:"先写正文。"]`——**正文被复制了一份**。
  这是**用户可见的错误**，优先级高于速度问题。
- **推理增量从不关闭**：`reasoningDelta` 发 `part.added` 与 `text.delta`，**从不发
  `reasoning_summary_text.done` / `part.done` / `output_item.done`**，客户端只能靠终态补。
- **缓存命中恒为 0**：`responseUsage` 硬编码 `input_tokens_details: { cached_tokens: 0 }`
  （符号锚点 `export function responseUsage`）。实测上游在同一前缀上返回
  `prompt_cache_hit_tokens: 3840 / prompt_tokens: 4010`，桥接全部丢弃。

---

## 1. 与并行工作的隔离约定（重要）

另一个智能体正在改同一目录。**它的改动范围会变，不要按清单核对，按 `git status` 的实际输出为准。**
起草本指南时观察到的是 6–7 个文件（`CHANGELOG.md`、`README.md`、`src/install.js`、
`src/protocols/responses.js`、`test/api/responses.test.mjs`、`test/live/codex-client-smoke.mjs`、
`test/run.mjs`），但**这个数量不固定**——数量变多不代表发生过范围越界。

执行本指南时必须遵守：

- **不要 `git stash` / `git checkout --` / `git restore` 任何文件**。对方未提交的改动一旦被冲掉会丢工作。
- **不要 `git commit -a`**。每个任务只 `git add` 自己列出的文件。
- 每个任务开工前先跑一次 `git status --porcelain=v1`，把输出贴进任务记录；结束时再跑一次，
  确认**除本任务文件外没有新增变更**（而不是「数量与上次相同」）。
- 用 `read` 读文件后再 `edit`；**不要按行号定位**，用 §9.5 的符号锚点。
- 本计划**不修改** `HOSTED_TOOL_TYPES` / `isHostedToolType` / `convertResponsesTools` /
  `prepareResponsesRequest` 的 tool_choice 段。这些区域归对方。
- 需要动 `src/protocols/responses.js` 时只碰：`responseUsage`、`createResponsesStreamEncoder`、
  `outputForResult`、`cancelEvents` 相关路径（以及它们内部的私有辅助函数）。
- 分支建议 `git switch -c fix/dsh-reasoning-and-timing`；若 Lead 要求同分支工作，则改完一个任务
  立刻提交，绝不长时间悬挂未提交改动。

> ⚠️ **两个同名文件不要混**：`test/run.mjs`（顶层，跑 CLI + API 全量）正在被对方修改，
> 而本计划的测试命令用的是 `test/api/run.mjs`（API 子集）。**跑测试一律用 `test/api/run.mjs`**，
> 不要执行顶层那个，否则会把对方的 CLI 测试改动一起卷进来。

## 2. 目标与非目标

**Goals（v1 本期）**

1. 客户端显式声明了档位，就一定按声明下发（目录未知时也下发），除非上游明确拒绝。
2. 同一响应内 `output_index` 严格单调，不再出现块串位 / 正文重复。
3. 推理增量补齐结束事件；工具调用按上游节奏下发（3a 先把安全前提做实，3b 视测量再决定）。
4. usage 的缓存命中字段如实透传。

**Non-Goals（本期不做）**

- **不让 `canDisableThinking` 参与「未声明 / 显式 none」的判定**（评审结论，见 §9.1）。
- 不改 DSH 的 `decodeMs` 算法（在 dsh 包内，不在本仓库）。
- 不转发 `reasoning_summary` / `include`（上游接受度无证据，§0.1）。
- 不动 Anthropic `thinking` 的语义（只共享第 1 条的透传修复）。
- 不引入任何第三方依赖。

---

## 3. 行为矩阵

### 3.1 本期做（v1 判定链，**不读 `canDisableThinking`**）

| # | requested | decl | catalog | 修复前转发 | **修复后转发** | 说明 |
|---|---|---|---|---|---|---|
| 1 | `high` | 三档 `[low,high,max]` | 热 | `high` | `high` | 不变 |
| 2 | `medium` | 三档 | 热 | `high`（向上取） | `high` | 不变 |
| 3 | `max` | 单值 `medium` | 热 | `medium` | `medium` | 不变 |
| 4 | `high` | `form:'none'` | 热 | 不发送 | 不发送 | 模型确实不支持 |
| **5** | **`max`** | **未知** | **冷** | **不发送** | **`max`** | ★ 本次唯一净变化，救回 dsh 主请求 |
| 6 | `none` | 任意 | 任意 | `none` | `none` | **保持现状**（评审：显式意图就是意图） |
| 7 | 未声明 | 任意 | 任意 | `none` | `none` | **保持现状**（评审：不让元数据翻转行为） |
| 8 | `hihg` | 任意 | 任意 | 400 | 400 | 不变 |

**判定链（严格按序）：**

```
1. 归一化 requested（trim + toLowerCase）；不在 ACCEPTED 里 → 400 invalid_reasoning_effort
2. declaration 明确 form:'none'        → 不发送（source: 'unsupported'）
3. requested 未声明（null/undefined）    → 'none'（source: 'default'）        ← 保持现状
4. requested === 'none'                → 'none'（source: 'disabled'）        ← 保持现状
5. declaration 有效（efforts 非空）      → 走原有向上取档（source: 'mapped'）
6. declaration 为 null（目录冷/模型不在目录）→ 透传归一化后的值（source: 'passthrough'） ★
```

第 5 条与第 6 条的顺序很重要：**目录热了就一定按能力归一化**，透传只发生在「目录给不出答案」时。

### 3.2 本期不做（明确记录，避免执行者自由发挥）

| # | 场景 | 为什么不做 |
|---|---|---|
| 9 | 未声明 + `canDisableThinking:false` → 走模型默认档 | 评审否决：同一请求的行为被模型元数据翻转，是副作用而非设计 |
| 10 | 显式 `none` + `canDisableThinking:false` → 强制回默认档 | 评审否决：实测 3 个声明 `false` 的模型里 2 个确实能被 `none` 关掉（hy4free 0 tok、glm-5.3 1 tok），强制开启是纯回归 |
| 11 | 未声明 + `canDisableThinking:true` → 显式 `none` | 保持现状（本来就是这个行为） |

> 如果将来要重开第 10 行，前提是**先拿到「声明 `false` 但 `none` 无效」的更大样本**，
> 并把它做成按模型的显式覆盖表，而不是从 `canDisableThinking` 推。

---

## 4. 文件蓝图

| 文件 | 任务 | 改动性质 |
|---|---|---|
| `src/reasoning-effort.js` | T1 | 新增纯函数 `resolveRequestedEffort`；`resolveReasoningEffort` 变薄封装 |
| `test/api/reasoning-effort.test.mjs` | T1 | 新增 §3.1 判定链用例 |
| `src/api-responses.js` | T2 | `applyReasoningEffort` 改调用新函数 |
| `src/api-runtime.js` | T2 | Chat / Anthropic 两处同样切换 |
| `test/api/responses.test.mjs` 等 | T2 | 冷目录新用例（只追加，不动对方用例） |
| `src/protocols/responses.js` | **T3a** | 索引重构（`nextIndex()`）、推理结束事件、`closeToolCalls()` 安全网 |
| `src/api-responses.js` | **T3a** | 流结束时发关闭事件、`cancelEvents` 加过滤 |
| `src/protocols/responses.js` | T3b（待定） | 工具参数按上游帧增量下发 |
| `src/protocols/responses.js` | T4 | `responseUsage` 缓存字段 |
| `src/protocols/openai.js`、`src/protocols/anthropic.js` | T5 | usage 缓存字段 |
| `README.md`、`CHANGELOG.md` | T6 | 行为变更文档（**等对方提交后再改**） |

---

## 5. 任务分解

每个任务都是「先写失败测试 → 跑红 → 实现 → 跑绿 → 全量 API → 提交」。

### Task 1：纯函数层——只改一件事：目录未知时透传

**Files:** `src/reasoning-effort.js`、`test/api/reasoning-effort.test.mjs`

**Interfaces:**

```js
// 新增
resolveRequestedEffort(requested, declaration) -> {
  effort: string | null,           // 发送给上游的值；null = 不发送
  source: 'passthrough' | 'mapped' | 'default' | 'disabled' | 'unsupported',
}
// 既有导出保持签名不变
resolveReasoningEffort(requested, declaration) -> string | null   // 包一层 .effort
```

- [ ] **Step 1: 把「未知档位 400」抽成 `assertAccepted(raw)`**

现状：`resolveReasoningEffort` 内联了这段校验。先抽函数（不改行为），跑
`node --test test/api/reasoning-effort.test.mjs` 确认仍然全绿——这一步是**纯重构**，
必须独立可验证。

```js
function assertAccepted(raw) {
  if (!ACCEPTED.has(raw)) {
    throw bad(`unknown reasoning effort: ${JSON.stringify(raw)}`);
  }
}
```

- [ ] **Step 2: 先写失败测试（只覆盖 §3.1 的 8 行）**

在 `test/api/reasoning-effort.test.mjs` 追加：

```js
import { resolveRequestedEffort } from '../../src/reasoning-effort.js';

const THREE_RUNG = {
  form: 'supported',
  efforts: ['low', 'high', 'max'],
  declaredEffort: null,
  defaultEffort: 'high',
  canDisableThinking: true,
};
const NO_REASONING = {
  form: 'none',
  efforts: [],
  declaredEffort: null,
  defaultEffort: null,
  canDisableThinking: null,
};

test('目录未知时透传客户端声明的档位（DSH 主请求场景）', () => {
  assert.deepEqual(resolveRequestedEffort('max', null), { effort: 'max', source: 'passthrough' });
  assert.deepEqual(resolveRequestedEffort('high', null), { effort: 'high', source: 'passthrough' });
  assert.deepEqual(resolveRequestedEffort('minimal', null), { effort: 'low', source: 'passthrough' });
});

test('目录热时仍然按能力归一化，不透传', () => {
  assert.deepEqual(resolveRequestedEffort('medium', THREE_RUNG), { effort: 'high', source: 'mapped' });
  assert.deepEqual(resolveRequestedEffort('max', THREE_RUNG), { effort: 'max', source: 'mapped' });
});

test('未声明档位保持现状：一律 none（不读 canDisableThinking）', () => {
  assert.deepEqual(resolveRequestedEffort(null, THREE_RUNG), { effort: 'none', source: 'default' });
  assert.deepEqual(resolveRequestedEffort(undefined, THREE_RUNG), { effort: 'none', source: 'default' });
  // 即使目录未知、即使 canDisableThinking 为 false，都不改变这条
  assert.deepEqual(resolveRequestedEffort(null, null), { effort: 'none', source: 'default' });
  assert.deepEqual(
    resolveRequestedEffort(null, { ...THREE_RUNG, canDisableThinking: false }),
    { effort: 'none', source: 'default' },
  );
});

test('显式 none 保持现状：即便模型声明不可关思考也照发', () => {
  assert.deepEqual(resolveRequestedEffort('none', THREE_RUNG), { effort: 'none', source: 'disabled' });
  assert.deepEqual(
    resolveRequestedEffort('none', { ...THREE_RUNG, canDisableThinking: false }),
    { effort: 'none', source: 'disabled' },
  );
  assert.deepEqual(resolveRequestedEffort('none', null), { effort: 'none', source: 'disabled' });
});

test('明确声明不支持 reasoning 的模型不转发', () => {
  assert.deepEqual(resolveRequestedEffort('high', NO_REASONING), { effort: null, source: 'unsupported' });
  assert.deepEqual(resolveRequestedEffort(null, NO_REASONING), { effort: null, source: 'unsupported' });
});

test('未知档位名仍然 400，冷热目录都一样', () => {
  for (const declaration of [null, THREE_RUNG, NO_REASONING]) {
    assert.throws(
      () => resolveRequestedEffort('hihg', declaration),
      (error) => error.status === 400 && error.code === 'invalid_reasoning_effort',
    );
  }
});

test('档位大小写归一，输出恒为小写', () => {
  assert.deepEqual(resolveRequestedEffort('MAX', null), { effort: 'max', source: 'passthrough' });
  assert.deepEqual(resolveRequestedEffort('Max', THREE_RUNG), { effort: 'max', source: 'mapped' });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
node --test test/api/reasoning-effort.test.mjs
```

预期：`SyntaxError: The requested module ... does not provide an export named 'resolveRequestedEffort'`。

- [ ] **Step 4: 实现**

```js
export function resolveRequestedEffort(requested, declaration) {
  const hasRequest = requested !== null && requested !== undefined;
  const raw = hasRequest ? canonical(requested) : null;
  if (hasRequest) assertAccepted(raw);

  if (declaration && declaration.form === 'none') {
    return { effort: null, source: 'unsupported' };
  }
  // 未声明与显式 none 都保持 v0.4 的既有行为：不读 canDisableThinking。
  if (!hasRequest) return { effort: 'none', source: 'default' };
  if (raw === 'none') return { effort: 'none', source: 'disabled' };

  if (declaration?.efforts?.length) {
    return { effort: resolveReasoningEffort(raw, declaration), source: 'mapped' };
  }
  // 目录给不出答案（冷目录 / 模型不在目录）：不再删除客户端意图。
  return { effort: raw === 'minimal' ? 'low' : raw, source: 'passthrough' };
}

export function resolveReasoningEffort(requested, declaration) {
  return resolveRequestedEffort(requested, declaration).effort;
}
```

> 注意：`resolveReasoningEffort` 变成封装后，原来「目录未知返回 null」的语义变了。
> **这是有意的**，但会同时影响 `test/api/reasoning-effort.test.mjs` 里既有的
> 「无 reasoning 对象不产生转发值」那条用例——它传的是 `reasoningDeclaration({...})`
> 也就是 `form:'none'`，**不受影响**，跑一次确认即可。

- [ ] **Step 5: 跑聚焦测试**

```bash
node --test test/api/reasoning-effort.test.mjs
```

- [ ] **Step 6: 提交**

```bash
git add src/reasoning-effort.js test/api/reasoning-effort.test.mjs
git commit -m "fix: forward the requested reasoning effort when the catalogue has no entry"
```

---

### Task 2：接入三条协议

**Files:** `src/api-responses.js`、`src/api-runtime.js`、相关测试

三处调用点（用符号锚点定位，别数行号）：

| 协议 | 锚点 |
|---|---|
| Responses | `function applyReasoningEffort(prepared, account, credentials)` |
| Chat | `applyReasoningEffort` 的闭包版本（函数体内引用 `body.normalized.requestedEffort`） |
| Anthropic | 内联段：`const declaration = reasoningCatalogue?.getDeclaration({`（函数体内随后 `delete body.body.reasoning_effort`） |

- [ ] **Step 1: 先写失败测试——冷目录下 Responses 必须转发 `max`**

在 `test/api/responses.test.mjs` **文件末尾追加**（不要插入对方新增用例之间）：

```js
test('Responses 能力目录未预热时透传客户端档位（DSH 真实场景）', async (t) => {
  let received;
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstream(res, 'done');
  }); // 不传 reasoningCatalogue：等价于目录冷

  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', input: 'go', reasoning: { effort: 'max' } }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(received.reasoning_effort, 'max');
  assert.equal(body.reasoning.effort, 'max');
});

test('Responses 冷目录下客户端的 none 与未声明的行为保持不变', async (t) => {
  const received = [];
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    upstream(res, 'done');
  });
  for (const reasoning of [{ effort: 'none' }, undefined]) {
    await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', input: 'off', ...(reasoning ? { reasoning } : {}) }),
    });
  }
  assert.equal(received[0].reasoning_effort, 'none');
  assert.equal(received[1].reasoning_effort, 'none');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test --test-name-pattern="能力目录未预热|保持不变" test/api/responses.test.mjs
```

预期：第一条 `undefined !== 'max'`；第二条应当**立即通过**（它守的是「不回归」）。

- [ ] **Step 3: 切换 Responses 调用点**

```js
import { resolveRequestedEffort } from './reasoning-effort.js';

function applyReasoningEffort(prepared, account, credentials) {
  const declaration = reasoningCatalogue?.getDeclaration({
    accountId: account,
    credentials,
    model: prepared.model,
  }) || null;
  const decision = resolveRequestedEffort(prepared.requestedEffort, declaration);
  if (decision.effort === null) delete prepared.body.reasoning_effort;
  else prepared.body.reasoning_effort = decision.effort;
  prepared.forwardedEffort = decision.effort;
  prepared.effortSource = decision.source;
  return decision;
}
```

`delete` 必须保留：目录热了之后再重试同一请求，不能残留上一次写入的值。

- [ ] **Step 4: 切换 Chat 与 Anthropic**

两处同样改为 `resolveRequestedEffort(...).effort`，保持「`null` → `delete`」的语义。
Anthropic 那处顺带确认 `thinkingEnabled` 不再从转发值反推（若现有代码依赖
`forwardedEffort === 'none'` 判断，改成直接读客户端 `thinking.type`）。

- [ ] **Step 5: 跑三条协议的聚焦测试**

```bash
node --test test/api/responses.test.mjs
node --test test/api/openai.test.mjs
node --test test/api/anthropic.test.mjs
node --test test/api/anthropic-http.test.mjs
```

- [ ] **Step 6: 处理可能失效的既有断言（逐条判断，不要成批删除）**

| 位置（用例名，非行号） | 断言 | 处理 |
|---|---|---|
| `Responses 无 reasoning 声明时不注入字段` | 传 `NO_REASONING`（`form:'none'`），断言不注入 | **保留**：语义未变 |
| `Responses 已知模型缺少 reasoning 时转发 none` | 传 `THREE_RUNG`，断言 `none` | **保留**：§3.1 第 7 行未变 |
| `Chat 无 reasoning 声明时删除克隆中的字段` | 传 `CHAT_NO_REASONING` | **保留** |
| `Chat ... 显式转发 none`（`messages: [{role:'user', content:'off'}]`） | 断言 `none` | **保留**：§3.1 第 6 行 |
| Anthropic「未启用 thinking 转发 none」 | 断言 `received.reasoning_effort === 'none'` | **保留**：原因同上 |

判断规则：**只有断言「目录冷 → 删除字段」的用例才需要改**；本仓库里目前**没有**这类用例
（现有冷目录用例都断言 `none`），所以预期这一步是空操作。若真出现失败，说明实现走偏了，
回去看 Step 4 的判定链，而不是改断言。

- [ ] **Step 7: 全量 API 测试 + 提交**

```bash
node test/api/run.mjs      # 期望 293 + 新增用例数，exit 0
git add src/api-responses.js src/api-runtime.js test/api/responses.test.mjs
git commit -m "fix: apply passthrough effort routing to responses, chat and anthropic"
```

---

### Task 3a：索引重构 + 推理结束事件 + 工具调用安全网（**必修，零风险**）

**Files:** `src/protocols/responses.js`（`createResponsesStreamEncoder` + `outputForResult` /
`completedResponseBody`；**不动** `responseUsage` 与托管工具相关区段）、
`src/api-responses.js`（`alignLiveOutputIds`、流结束路径、`cancelEvents`）、
`test/api/responses.test.mjs`

**为什么这一步必须在 3b 之前**：3b 要把工具参数改成增量下发，而增量的前提是「每个块有唯一
且稳定的 `output_index`」+「结束时一定有 `*.done` 关闭事件」。这两件事本身就是用户可见的
bug 修复，与速度无关，先落地可以先收货、先回滚。

- [ ] **Step 0: 先落地统计脚本（后续所有「先测量」都靠它）**

仓库里目前**没有**任何测量 `decodeMs` 的工具（`.audit/`、`.cap/`、`.probe/` 都已不存在）。
新建 `scripts/decode-window.mjs`（约 60 行，零依赖），它同时是 §0.2 那张表的复现入口：

```js
#!/usr/bin/env node
// 统计一次 dsh 会话的 decode 窗口与步型分布。
// 口径与 @deepseek-ai/dsh-session-stats 的 sessionStats 投影一致：
//   decodeMs = t_message − t_firstVisibleDelta（每步）
//   tps      = ΣoutputTokens / ΣdecodeMs
// 用法：node scripts/decode-window.mjs <session.v4.jsonl.zstd | session.v4.jsonl> [chat|trajectory]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/decode-window.mjs <session.v4.jsonl.zstd>');
  process.exit(2);
}
const raw = file.endsWith('.zstd')
  ? execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  : fs.readFileSync(file, 'utf8');
const events = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));

const runTimes = (run) => {
  const times = [run.time0];
  for (const dt of run.dt || []) times.push(times[times.length - 1] + dt);
  return times;
};
const isTokenDelta = (chunk) => {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text !== '';
  if (chunk.type === 'tool-call-delta') return chunk.argumentsDelta !== '' || chunk.name !== undefined;
  return false;
};
function firstVisibleTime(stream) {
  for (const rec of stream) {
    if (rec.type === 'chunk') {
      if (isTokenDelta(rec.chunk)) return rec.time;
      continue;
    }
    const times = runTimes(rec);
    if (rec.type === 'tool-call-chunks') {
      if (rec.name !== undefined) return rec.time0;
      if ((rec.args || []).length) return times[Math.min(1, times.length - 1)];
      continue;
    }
    const texts = rec.texts || [];
    for (let i = 0; i < texts.length; i += 1) {
      if (texts[i] && texts[i].trim()) return times[Math.min(i, times.length - 1)];
    }
  }
  return undefined;
}
const hasRun = (stream, type) => stream.some((r) => r.type === type);

const rows = [];
for (const event of events) {
  if (event.type !== 'assistant/message') continue;
  const stream = event.data?.stream || [];
  const tokens = event.data?.usage?.outputTokens || 0;
  if (!tokens) continue;
  const first = firstVisibleTime(stream);
  const span = first === undefined ? 0 : Math.max(0, event.time - first);
  rows.push({
    key: `${hasRun(stream, 'reasoning-chunks') ? 'R' : '-'}`
      + `${hasRun(stream, 'tool-call-chunks') ? 'T' : '-'}`
      + `${hasRun(stream, 'text-chunks') ? 'X' : '-'}`,
    tokens,
    span,
    toolFrames: stream.filter((r) => r.type === 'tool-call-chunks').reduce((n, r) => n + 1 + (r.dt || []).length, 0),
  });
}

const total = rows.reduce((n, r) => n + r.tokens, 0);
const decodeMs = rows.reduce((n, r) => n + r.span, 0);
const zero = rows.filter((r) => r.span <= 5);
const zeroTokens = zero.reduce((n, r) => n + r.tokens, 0);

console.log(`steps=${rows.length} outputTokens=${total} decodeMs=${decodeMs} tps=${(total / (decodeMs / 1000)).toFixed(1)}`);
console.log(`zeroWindowSteps=${zero.length} zeroWindowTokens=${zeroTokens} (${(100 * zeroTokens / total).toFixed(1)}%)`);
const byKind = new Map();
for (const row of rows) {
  const acc = byKind.get(row.key) || { steps: 0, tokens: 0, zero: 0 };
  acc.steps += 1;
  acc.tokens += row.tokens;
  if (row.span <= 5) acc.zero += 1;
  byKind.set(row.key, acc);
}
for (const [kind, acc] of [...byKind].sort()) {
  console.log(`  ${kind}  steps=${String(acc.steps).padStart(4)} tokens=${String(acc.tokens).padStart(7)} `
    + `(${(100 * acc.tokens / total).toFixed(1)}%) zeroSteps=${acc.zero}`);
}
```

跑一次验证它能复现 §0.2 的表：

```bash
node scripts/decode-window.mjs ~/.dsh/sessions/--mnt-windata-awa-NAPCAT--/session-8b4adb24-4c3a-444c-a376-2668b5608a55/session.v4.jsonl.zstd
```

预期：`steps=251 … zeroWindowTokens=38131 (63.4%)`，`-T-` 行 `steps=198 tokens=38131`。
**数字对不上就先停下**——说明会话文件变了或口径写错了，别带着错的尺子往下走。

提交脚本本身（独立 commit，便于 T3b 复用）：

```bash
git add scripts/decode-window.mjs
git commit -m "test: add a decode-window analyser for dsh session logs"
```

- [ ] **Step 1: 先写失败测试——索引冲突**

```js
test('Responses 正文与推理的 output_index 不冲突', async (t) => {
  const { baseUrl } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // 真实上游可能先给正文，再给推理
    res.write(encodeSseEvent('message', { choices: [{ delta: { content: '先写正文。' } }] }));
    res.write(encodeSseEvent('message', { choices: [{ delta: { reasoning_content: '然后我才思考。' } }] }));
    res.write(encodeSseEvent('message', { choices: [{ delta: {}, finish_reason: 'stop' }] }));
    res.end('data: [DONE]\n\n');
  });
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, store: false, input: 'mix' }),
  });
  const events = parseSse(await response.text());
  const added = events.filter((e) => e.type === 'response.output_item.added');
  const indexes = added.map((e) => e.output_index);
  assert.equal(new Set(indexes).size, indexes.length, `duplicate output_index: ${indexes}`);
  const doneIds = events
    .filter((e) => e.type === 'response.output_item.done')
    .map((e) => e.item?.id);
  assert.equal(new Set(doneIds).size, doneIds.length, `duplicate output_item.done: ${doneIds}`);

  // ★ 顺序不变量：output_index 必须等于该 item 在终态 output 里的下标
  const terminal = events.find((e) => e.type === 'response.completed');
  terminal.response.output.forEach((item, i) => {
    assert.equal(
      added.find((e) => e.item?.id === item.id)?.output_index,
      i,
      `item ${item.id} (${item.type}) 的流索引与终态下标不一致： expected ${i}, got ${added.find((e) => e.item?.id === item.id)?.output_index}`,
    );
  });
});
```

> 后面这条顺序断言是本任务的核心：**只断言「索引唯一」会让「流与终态顺序相反」的 bug 溜过去**。

- [ ] **Step 2: 先写失败测试——推理结束事件**

```js
test('Responses 推理增量必须带出结束事件', async (t) => {
  const { baseUrl } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', { choices: [{ delta: { reasoning_content: '想一想' } }] }));
    res.write(encodeSseEvent('message', { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }));
    res.end('data: [DONE]\n\n');
  });
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, store: false, input: 'think' }),
  });
  const events = parseSse(await response.text());
  const at = (type) => events.findIndex((e) => e.type === type);
  assert.ok(at('response.reasoning_summary_text.delta') >= 0);
  assert.ok(at('response.reasoning_summary_text.done') > at('response.reasoning_summary_text.delta'));
  assert.ok(at('response.reasoning_summary_part.done') > 0);
  assert.ok(at('response.reasoning_summary_text.done') < at('response.completed'));
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
node --test --test-name-pattern="output_index 不冲突|推理增量必须带出结束事件" test/api/responses.test.mjs
```

预期：第一条重复索引；第二条缺 `.done`。

**★ 硬规则（评审 P0，先读再动手）**

> `output_index` **必须等于该 item 在 `response.completed.response.output` 数组里的下标**。
> 也就是说「流里的索引」和「终态的顺序」是同一条不变量，不能各走各的。

当前代码违反这条：`outputForResult`（符号锚点 `export function outputForResult({`）**固定**按
`reasoning → message → calls` 构造终态；而 `alignLiveOutputIds` **只搬 id、不搬顺序**。
一旦 live 索引改成按到达顺序分配，正文先到就会出现：

```
流:    message@0   reasoning@1
终态:  output[0]=reasoning   output[1]=message      ← 与流矛盾
```

v2 的 Step 1 用例只断言「索引唯一、done 不重复」，**抓不到这个**——它会通过，然后 dsh 侧
块位置互换。因此本任务必须同时改两处：

1. **live 侧**：`nextIndex()` 按到达顺序分配（Step 4）。
2. **终态侧**：`outputForResult` 改为**以 live 的到达顺序为准**重排；`prior` 之后的部分
   按 live 记录的顺序输出，`alignLiveOutputIds` 连同顺序一起对齐，而不只搬 id（新 Step 4b）。

`response.completed` 的块顺序因此**会**在多块交错时变化。这是**有意的契约变更**：唯一
自洽的选择是「流的顺序 = 终态的顺序」。若某客户端依赖「reasoning 永远在第一位」，会在
CHANGELOG 里标注为可见变更。

- [ ] **Step 4: 重构索引分配（在 `createResponsesStreamEncoder` 内）**

把「一个共享的 `outputIndex` + 事后修正」改成「进一次 `nextIndex()` 取一个新号」：

```js
function createResponsesStreamEncoder({ response, maxBytes = MAX_RETAINED_TEXT_BYTES, retain = 'tail' }) {
  let sequence = 2;
  let nextOutputIndex = Array.isArray(response.output) ? response.output.length : 0;
  let reasoningItem = null;
  let reasoningIndex = -1;
  let messageItem = null;
  let messageIndex = -1;
  const reasoningText = createTextCache({ maxBytes, retain });
  const outputText = createTextCache({ maxBytes, retain });
  const output = [];
  const event = (type, data) => ({ type, data: { type, sequence_number: sequence++, ...data } });
  const nextIndex = () => nextOutputIndex++;
  // 下面 reasoningDelta / textDelta 里所有 `output_index: outputIndex` 改成
  // `output_index: reasoningIndex` / `output_index: messageIndex`，
  // 块首次创建时分别 `reasoningIndex = nextIndex()` / `messageIndex = nextIndex()`。
  // **删除** `outputIndex += reasoningItem ? 1 : 0` 这一行。
}
```

> 这一步只改索引来源，不改事件种类与顺序。改完先跑 Step 1 的用例——**它现在会因为
> 「流与终态顺序相反」而失败**，这正是下一步要修的。

- [ ] **Step 4b: 让终态顺序跟随 live 顺序（与 Step 4 是同一条不变量，必须一起做）**

改 `src/api-responses.js` 的 `alignLiveOutputIds`：从「只搬 id」升级为「搬 id **并**按 live
顺序重排 `prior` 之后的部分」。

```js
function alignLiveOutputIds(finalBody) {
  const live = liveEncoder?.snapshot();
  if (!live?.output?.length) return finalBody;
  const head = finalBody.output.slice(0, prior.length);
  const tail = finalBody.output.slice(prior.length);
  const rank = (item) => {
    const at = live.output.findIndex((candidate) => candidate.type === item.type);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const liveById = new Map(live.output.map((item) => [item.type, item]));
  finalBody.output = [
    ...head,
    ...tail
      .map((item) => {
        const match = liveById.get(item.type);
        return match ? { ...item, id: match.id } : item;
      })
      .sort((a, b) => rank(a) - rank(b)),
  ];
  return finalBody;
}
```

同时确认 `outputForResult` **不需要**改构造顺序——它仍按 `reasoning → message → calls`
构造（那是「没有 live 信息时」的默认顺序），由 `alignLiveOutputIds` 在 live 存在时统一重排。
若执行者发现重排后 `calls` 的位置不对，说明 `rank()` 落在 `Number.MAX_SAFE_INTEGER` 上了，
原因是 live 快照里只有 message/reasoning 两类，调用类 item 应保持相对顺序排在最后——
把 `sort` 换成**稳定重排**（先取 live 顺序的两类，再把其余原样追加）即可。

改完跑 Step 1 的两组断言，**必须同时通过**。

- [ ] **Step 5: 补推理结束事件，并在流结束时统一关闭**

新增到编码器：

```js
function reasoningSummaryDone() {
  const item = reasoningItem;
  if (!item || reasoningDone) return [];      // 幂等：只发一次
  reasoningDone = true;
  const text = reasoningText.value();
  return [
    event('response.reasoning_summary_text.done', {
      item_id: item.id,
      output_index: reasoningIndex,
      summary_index: 0,
      text,
    }),
    event('response.reasoning_summary_part.done', {
      item_id: item.id,
      output_index: reasoningIndex,
      summary_index: 0,
      part: { type: 'summary_text', text },
    }),
    event('response.output_item.done', {
      output_index: reasoningIndex,
      item: { ...item, status: 'completed', summary: [{ type: 'summary_text', text }] },
    }),
  ];
}
```

> 两个容易写错的地方，写完都必须自查：
>
> 1. **顺序坑**：必须先 `const item = reasoningItem;` 再判空/置标志，**不要**先
>    `reasoningItem = null` 再用 `reasoningItem?.id`，否则 `item_id` 会变成 `undefined`。
>    因此这里用独立的 `reasoningDone` 标志做幂等，而不是把 `reasoningItem` 置空。
> 2. **`reasoningItem` 仍要保留**：`snapshot()` 用它产 `output`，`cancelEvents` 也用它判断
>    是否已有 live item。置空会连带破坏这两处。

- [ ] **Step 6: 在 `src/api-responses.js` 的流结束路径调用它**

锚点：**只用** `const finalBody = completedResponseBody({` 这一个（全仓唯一）。

> ⚠️ `alignLiveOutputIds(finalBody);` 有 **2 处**（`terminalFailure` 与 `run()` 各一）。
> 以它作为主锚点会插到失败路径里，导致成功路径永远不发关闭事件。**必须**先定位
> `const finalBody = completedResponseBody({`，再在它上面那一行插入。

```js
// 先关闭 live 块（推理/正文），再发终态；终态里的重复项由 cancelEvents 过滤。
publishLive(liveEncoder?.reasoningSummaryDone());
```

- [ ] **Step 7: 让 `cancelEvents` 过滤重复关闭事件**

锚点：`function cancelEvents(finalBody, { finalDeltas = false, finalReasoningDeltas = false } = {})`。
现有过滤只挡 `output_item.added` 与 `*_part.added`，需要补一条**与 `.added` 同源**的规则：
「live 已经发过的 item，终态里的 `.done` 系列一律跳过」。实现方式二选一（任选，别两种都上）：

- **方式 A（推荐，改动小）**：live 编码器暴露 `closedIds()`，`cancelEvents` 见到
  `event.data.item?.id` 或 `event.data.item_id` 在该集合里，就把这条 `.done` 标 `markRemoved`。
- **方式 B**：给编码器一个 `handoff(finalBody)` 方法，返回「live 已完整走完的 item id 集合」，
  由 `run()` 传给 `cancelEvents`。

`response.completed` 的完整 `response.output` **必须保留**（客户端靠它落库）。

- [ ] **Step 8: 跑聚焦 + 全量**

```bash
node --test test/api/responses.test.mjs
node --test test/api/disconnect-resilience.test.mjs
node --test test/api/openai-tool-roundtrip.test.mjs
node test/api/run.mjs
```

- [ ] **Step 9: 用 pi-ai 做一次真实回归**

把 §0.3 那段 `[text, thinking, text]` 的事件序列喂给 dsh 自带的
`@earendil-works/pi-ai` 的 `processResponsesStream`，期望 content 是
`[text, thinking]` 而不是三个块。命令示例：

```bash
node -e "
const { processResponsesStream } = await import('file:///…/pi-ai/dist/api/openai-responses-shared.js');
// 事件序列与 §0.3 相同，只看 output.content 的类型序列
"
```

- [ ] **Step 10: 提交**

```bash
git add src/protocols/responses.js src/api-responses.js test/api/responses.test.mjs
git commit -m "fix: give each responses block its own output index and close reasoning increments"
```

---

### Task 3b：工具参数按上游帧下发（**先测量，再决定做不做**）

**前置条件：** T3a 已合并进主分支并通过全量测试。

**为什么先测量：** 上游把 `tool_calls.arguments` 切成 1–4 字符、123 ms 内发完；桥接把它攒成
一次下发，这才是零窗口步的真因。但**修好之后 decode 窗口也只回到 ~123 ms**，而 `outputTokens`
里还含工具调用框架开销（实测 `out=42 token / 30 字符参数`），所以 **tps 仍会显示 300–500 量级**，
不会回到「真实生成速度」。要不要为这个收益承担「客户端可能提前执行半截参数」的风险，需要先用
数据说话。

- [ ] **Step 1: 用 T3a Step 0 落地的脚本采集基线**

脚本已在 T3a Step 0 提交（`scripts/decode-window.mjs`），这里直接复用，**不要**再写一份：

```bash
node test/live/dsh-client-smoke.mjs                     # 跑一轮真实多步任务
node scripts/decode-window.mjs <这次生成的 session.v4.jsonl.zstd>
```

判据**只用相对量**（绝对 tps 见 §0.2b，不可作为判据）：

- `-T-` 行的 `zeroSteps` 占该行 `steps` 的比例：
  - **< 20%** → 3b 的收益已经由 T3a 顺带拿到（或上游变了），**3b 不必做，跳到 T4**。
  - **仍 > 80%** → 3b 值得做，继续 Step 2。
- 同时记录 `-T-` 行的 `token 占比`：它决定 3b 的天花板有多高。占比高才值得动。

> T3a 不改变纯工具调用步的形态（工具参数仍一次性下发），所以**预期这一步 `-T-` 的
> zeroSteps 仍接近 100%**——这正好说明 3b 与 T3a 是两个独立问题。

- [ ] **Step 2（仅当上一步判定值得做）: 增量下发工具参数**

要点，顺序不能变：

1. `response.output_item.added`（`item.type === 'function_call'`，`arguments: ''`）**必须**
   在第一条参数增量之前发出——pi-ai 的 `createSlot` 在 `output_item.added` 时就分配槽位，
   晚发会让后续增量被 `getSlot` 丢掉。
2. `response.function_call_arguments.delta` 逐帧转发上游 `function.arguments` 片段。
3. 流结束时（**不是**每帧结束时）发 `response.function_call_arguments.done` + `output_item.done`，
   并由 T3a 建立的关闭机制保证幂等。

**硬约束：** 仲裁逻辑（`createStructuredToolAssembler` + `arbitrateToolCalls`）**不变**，
最终可执行参数仍以仲裁结果为准；live 下发只是给客户端看的进度。若仲裁判定调用无效，
终态必须是 `response.failed`，且**不再**发 `function_call_arguments.done`。

- [ ] **Step 3: 测试**

```js
test('Responses 工具参数按上游帧分多次下发且先于任何参数增量有 added', async (t) => {
  // 假上游分 3 帧发 arguments：'{"comma' / 'nd":"ls' / ' -la"}'
  // 断言：deltas.length >= 2；拼接等于完整参数；added 的 index < 首个 delta 的 index
});

test('Responses 仲裁失败的调用不会下发参数 done', async (t) => {
  // 上游发出畸形 args；断言终态 failed 且没有 function_call_arguments.done
});
```

- [ ] **Step 4: 跑 DSML 全量 + 客户端回归**

```bash
node --test test/api/dsml.test.mjs
node --test test/api/openai-tool-roundtrip.test.mjs
node test/api/run.mjs
node test/live/dsh-client-smoke.mjs
```

- [ ] **Step 5: 重复 Step 1 的统计，确认相对量真的下降**

对照同一批步型行（`-T-`）的 `zeroSteps` 比例：

- 从 ~100% 掉到 **< 20%** → 收益成立，保留 3b。
- 仍在 **50% 以上** → **回滚 3b**（收益不成立，不值得多担一层风险），并在 CHANGELOG 里
  写明「工具参数保持整块下发」的原因。

**不要**用绝对 tps 作为判据。按 §0.2 的实测重算，3b 落地后截图口径的读数只会从
906 落到 640–770，全量口径从 527 落到 444–487——**远达不到「看起来正常」**，
用它当判据会误判 3b 无效。

- [ ] **Step 6: 提交**

```bash
git add src/protocols/responses.js test/api/responses.test.mjs
git commit -m "fix: stream function-call arguments at the upstream cadence"
```

---

### Task 4：usage 缓存字段（仅 Responses）

**Files:** `src/protocols/responses.js`、`test/api/responses.test.mjs`

- [ ] **Step 1: 先写失败测试**

```js
test('Responses 透传上游缓存命中 token', async (t) => {
  const { baseUrl } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', { choices: [{ delta: { content: 'ok' } }] }));
    res.write(encodeSseEvent('message', {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 4010,
        completion_tokens: 12,
        total_tokens: 4022,
        prompt_cache_hit_tokens: 3840,
        prompt_tokens_details: { cached_tokens: 3840 },
      },
    }));
    res.end('data: [DONE]\n\n');
  });
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', input: 'cache' }),
  });
  const body = await response.json();
  assert.equal(body.usage.input_tokens, 4010);
  assert.equal(body.usage.input_tokens_details.cached_tokens, 3840);
});
```

- [ ] **Step 2: 实现**

1. 锚点 `export function responseUsage(prompt = 0, completion = 0, reasoning = 0)`：
   增加第 4 个参数 `cached = 0`，`input_tokens_details: { cached_tokens: Math.max(0, Number(cached) || 0) }`。
2. 锚点 `snapshot()`（`createResponsesStreamEncoder` 之外的那个结构化快照）：`usage` 里带上
   `cached_tokens: Number(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0)`。
3. 锚点 `export function completedResponseBody(...)`：把 `usage.cached_tokens` 传给 `responseUsage`。

**不要**改 `input_tokens` 的语义（OpenAI 的 `input_tokens` 含 cached，上游 `prompt_tokens` 也含，
两边一致）。

- [ ] **Step 3: 跑测试 + 提交**

```bash
node --test --test-name-pattern="缓存命中" test/api/responses.test.mjs
node test/api/run.mjs
git add src/protocols/responses.js test/api/responses.test.mjs
git commit -m "fix: pass upstream prompt-cache hits through responses usage"
```

---

### Task 5：Chat 与 Anthropic 的 usage 明细

**Files:** `src/protocols/openai.js`、`src/protocols/anthropic.js`、对应测试

- [ ] **Step 1: 先写 Chat 失败测试**

```js
test('Chat 透传 prompt 缓存命中明细', async (t) => {
  // 假上游 usage 带 prompt_cache_hit_tokens: 3840
  // 断言 body.usage.prompt_tokens_details.cached_tokens === 3840
});
```

- [ ] **Step 2: 实现（锚点 `function eventUsage(usage)`）**

```js
function promptCacheDetails(source) {
  const cached = source?.prompt_cache_hit_tokens
    ?? source?.prompt_tokens_details?.cached_tokens;
  const tokens = Number(cached);
  if (!Number.isFinite(tokens) || tokens <= 0) return {};
  return { prompt_tokens_details: { cached_tokens: Math.max(0, tokens) } };
}
// eventUsage 的返回对象里展开：...promptCacheDetails(usage)
```

- [ ] **Step 3: Anthropic（锚点 `function usage(outputTokens, reasoningTokens)`）**

补 `cache_read_input_tokens`（来自 `prompt_cache_hit_tokens`）与
`cache_creation_input_tokens`（来自 `prompt_cache_write_tokens`）。**只在非零时输出**，
避免改变既有响应形状。

- [ ] **Step 4: 跑测试 + 提交**

```bash
node --test test/api/openai.test.mjs
node --test test/api/anthropic-http.test.mjs
node test/api/run.mjs
git add src/protocols/openai.js src/protocols/anthropic.js test/api/openai.test.mjs test/api/anthropic-http.test.mjs
git commit -m "fix: report upstream prompt-cache hits on chat and anthropic usage"
```

---

### Task 6：文档与验收（**必须在并行工作提交之后**）

- [ ] **Step 1: 前置检查**

```bash
git status --porcelain=v1     # 期望：只剩本指南这个未跟踪文件
git log --oneline -3
```

若有对方的未提交改动，**停下**，先与 Lead 确认合并顺序。

- [ ] **Step 2: README「推理档位」小节**

替换这两条（原文在 `### 推理档位` 下）：

- 旧：「模型目录明确声明无 reasoning，或缓存中没有该模型时，不向上游发送 `reasoning_effort`。」
  新：「**只有模型目录明确声明无 reasoning 时**才不发送。目录中查不到该模型（未预热、超时、
  模型不在上游列表里）时**透传客户端声明的档位**——这正是 DeepSeek Harness 这类手写模型
  列表的客户端的常态。」
- 保留：「已知支持 reasoning 的模型在请求缺少档位时显式接收 `none`。」
  追加一句：「客户端显式要求 `none` 时一律照发，不会因模型元数据被改写。」

新增两条：

- 「`reasoning.summary` / `include` 当前不转发到上游；响应里的 `reasoning.summary` 恒为 `null`。」
- 「Responses 的推理增量以 `response.reasoning_summary_text.done` / `part.done` 收尾；
  每个输出块拥有唯一且单调的 `output_index`。」

- [ ] **Step 3: README 行为边界**

- 「Responses 的 reasoning 事件来自上游文本，不代表新增了独立的私有推理通道。」
  → 追加：「若工具参数改为按上游帧下发，`response.function_call_arguments.delta` 会分多帧，
  客户端必须拼接片段后再解析。」（**仅当 3b 落地时加**）
- 新增 usage 说明：「`usage.input_tokens_details.cached_tokens` 与 Chat 的
  `usage.prompt_tokens_details.cached_tokens` 反映上游报告的 prompt 缓存命中；上游不报告时为 0。」

- [ ] **Step 4: CHANGELOG「Unreleased」**

```md
### Fixed

- Reasoning effort is forwarded as requested when the model catalogue has no
  entry for the model, instead of being silently deleted. Clients with
  hand-written model lists (DeepSeek Harness) never warm the catalogue, so their
  thinking content used to disappear entirely.
- Every Responses output block now owns a distinct, monotonically increasing
  `output_index`, and reasoning increments close with
  `response.reasoning_summary_text.done` / `part.done`.
- Prompt-cache hits reported by the upstream are exposed on Responses, Chat and
  Anthropic usage instead of a hard-coded zero.
```

- [ ] **Step 5: 全量 + 真实客户端验收**

```bash
node test/api/run.mjs
node test/live/dsh-client-smoke.mjs
```

验收标准：

1. `node test/api/run.mjs` exit 0，用例数 ≥ 293 + 本次新增。
2. dsh 会话日志里，带工具的首轮步骤出现 `reasoning-chunks` 的比例**明显高于修复前**；
   请注意上游本身有抖动，**用 ≥ 2 轮同 prompt 对照**，不要用单轮下结论。
   判断「有没有思考」必须**两个信号取并集**——`outputTokens` 里的
   `output_tokens_details.reasoning_tokens > 0` **或** `reasoning-chunks` 非空，
   任一成立即算思考发生。只看 `reasoning_tokens` 会漏报（外部实测 §5.2：16 个样本
   `reasoning_tokens` 全 0，而 `reasoning_content` 有 357–939 字符）。
3. 跑 `scripts/decode-window.mjs`（T3a Step 0 交付）：`-T-` 行的 `zeroSteps` 比例从 ~100% 降到
   < 90%（只做 T3a，预期基本不变）或 < 20%（做完 3b）。**不要用绝对 tps 作为判据**（§0.2b）。
4. 不再出现「正文重复」：同一响应里每个 `output_item.id` 只 closed 一次。

- [ ] **Step 6: 提交**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe reasoning effort passthrough and responses block lifecycle"
```

---

## 6. 验证矩阵

| 症状 | 修复前 | 修复后期望 | 用什么验 |
|---|---|---|---|
| dsh 无思维链 | 冷目录 forward=null，0 步有推理 | forward=max，首轮多数步有推理 | T2 用例 + `test:live:dsh` |
| 档位被吞 | `forwardedEfforts:["null"]` | `["max"]` | 假上游断言 + 真实上游抓包 |
| 正文重复块 | pi-ai 得到 2 个 text 块 | 1 个 text + 1 个 thinking | T3a Step 1/9 |
| 推理块不关闭 | 无 `*.done` | delta 之后紧跟 done，且在 completed 之前 | T3a Step 2 |
| 速度虚高 | 零窗口 token 63.4%（`-T-` 步 198/198 零窗口） | 相对量：`-T-` 行 zeroSteps 比例 < 20%（做完 3b）；**不设绝对 tps 阈值** | `scripts/decode-window.mjs` |
| 缓存 0% | `cached_tokens:0` | 3840/4010 | T4、T5 用例 |

---

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 透传目录外档位 | 未知模型可能被上游 400 | 实测上游接受全部小写档位名（`LOW` 大写才会 400，我们已归一化）；400 走既有失败路径，不静默降级 |
| 索引重构**必然**改变终态块顺序 | 依赖「reasoning 恒在 output[0]」的客户端 | 已由 T3a 的 Step 1 顺序断言 + Step 4b 覆盖；`output_index` 与终态下标强制一致。这是**有意的契约变更**，在 CHANGELOG 标注 |
| 终态重排遗漏 prior 段 | 续接响应的输出错乱 | `alignLiveOutputIds` 只重排 `prior.length` 之后的部分，`head` 原样保留 |
| 3b 增量工具参数 | 客户端提前执行半截参数 | `added` → 增量 → `done` → 仲裁否决则 `response.failed`；且 3b 有「收益不达标就回滚」的前置判据 |
| 与并行工作冲突 | 覆盖对方改动 | §1 隔离约定；每任务前 `git status`，只 `git add` 自己的文件 |
| usage 新增字段 | 严格 schema 的客户端报错 | 只在非零时输出；Responses/Chat 用标准 OpenAI 字段名 |

**逐任务回滚：** 每个任务一个独立 commit。T3a 与 T3b 同文件不同区域，
回滚 3b 后再回滚 3a；T4 与 T3a 同在 `responses.js`，回滚顺序 T4 → 3b → 3a。

---

## 8. 执行顺序

```
T1 → T2 → T3a(含索引重构) → T4 → T5 → [测量：T3b 值不值得] → T6(等对方提交)
```

T3b 的位置是**有意**的：它价值取决于 T3a 之后的实测数据，而不是取决于写得多漂亮。

---

## 9. 评审结论与修正（v1 → v2）

本节记录评审提出的每一条意见、我的核对结果、以及 v2 的处置。**执行者如果只看 §3 而跳过本节，
会误以为矩阵里还留着 v1 的第 9/10 行——它们已经移到 §3.2「本期不做」。**

### 9.1 撤掉 `canDisableThinking` 参与判定（采纳）

**评审意见：** v1 第 9/10 行让「未声明 / 显式 none 是否思考」取决于模型元数据。实测数据
（`docs/reasoning-effort-guide.md` §5.1）显示：声明 `canDisableThinking:false` 的模型里，
`space-bunny` 传 `none` 47 tok 关不掉，但 `hy4free` 0 tok、`glm-5.3` 1 tok **都能关掉**。
于是第 10 行在 2/3 的样本上是纯回归：客户端明确要求关闭、实际也能关闭，桥接却强行开回去。
第 9 行则让同一请求的行为被模型元数据翻转。

**核对：** 该实测文档**不在仓库里**（`docs/` 下只有 `superpowers/`；设计文档 §引用 提到
`docs/reasoning-effort-guide.md` 与两个 `scripts/*.py`，三者都不在版本控制里）。因此我无法
复核那三行数据本身——但**结论方向不依赖于精确数字**：只要存在「声明 false 但能被 none 关掉」
的模型，第 10 行就是回归；而 `canDisableThinking` 的字段语义确实没有证据表明它就是
「能否关闭」的权威声明。**采纳，并把它写进 §3.2 作为「本期不做」的留档。**

**v2 处置：** §3.1 判定链完全不读 `canDisableThinking`；唯一净变化是第 5 行（目录未知时透传
客户端显式声明）。未声明仍发 `none`，显式 `none` 照发。

### 9.2 索引重构并入 T3a，T4 只留 usage（采纳）

**评审意见：** `reasoningItemIndex` / `messageItemIndex` / `toolStates` / `closedReasoning` /
`nextIndex` / `openToolCallIds` / `liveEmitted` / `liveDone` 这 8 个标识符在仓库里 **0 处定义**；
按 v1 顺序先跑 T3 会 `ReferenceError`。

**核对：** 逐条 grep 确认，8 个全部 0 命中。**成立。**

**v2 处置：** 索引重构写进 T3a 的 Step 4 与具体代码；T4 缩到只剩 usage 缓存字段；
执行顺序改为 `T1 → T2 → T3a → T4 → T5`。

### 9.3 T3 收益重新定性，3b 降级为「先测量再决定」（采纳）

**评审意见：** v1 §0.2 说「桥接把推理压成瞬时块」不成立——`publishLive(liveEncoder?.reasoningDelta(...))`
就是逐帧下发，`consumeSse` 逐 chunk 读。一次性工具参数是真的，但它只作用于**纯工具调用步**。
60% 的 token 是否落在这些步上，需要按步型分类才知道。

**核对：**

- 「桥接把推理压平」——**推翻**。v1 §0.2 的成因 2 其实自己也写了「上游本身抖成 1–2ms」，
  是措辞把它和「桥接压平」混在了一起。v2 已改正。
- 「token 落在纯工具调用步」——**已用真实会话分类证实**（脚本见 §10.2，可复现）：
  会话 A 共 **251 步**（v2 误写成「192 步」，是 v1 稿的残留数字），其中 `-T-`（纯工具调用）
  198 步 / 38,131 token / **占 63.4%**（38,131 ÷ 60,158）/ **100% 零窗口**；其余三类零窗口为 0。
  会话 B（250 步）交叉验证：`-T-` 183 步 / 46,852 token / 44.1%。
- 「修完能回多少」——**新的量化**：上游把参数切成 1–4 字符、**123 ms** 内发完；
  桥接把它攒成 0。**v2 的「~123 ms」是单次实测，不可靠**；v2.1 用 5 条命令 × 2 种前缀重测，
  跨度为 **48–108 ms**、帧数 8–24。据此重算：3b 落地后截图口径从 906 → 643–767，
  全量口径从 527 → 444–487，**远不是「恢复正常」**——因为 `outputTokens` 还含工具调用
  框架开销（实测 `out=42 token / 30 字符参数`）。所以判据改为相对量，见 §0.2 / §0.2b。

**v2 处置：** 3b 单列，前置条件是「先测量再决定」，并给了明确的回滚判据（占比没到 < 20% 就撤销）。

### 9.4 三个会让执行静默出错的 P0（全部采纳）

| # | 评审指出 | 核对 | v2 处置 |
|---|---|---|---|
| P0-1 | `openToolCallIds` 不存在，`liveEncoder?.openToolCallIds?.()` 可选链会静默返回 `undefined` → `.done` 永不发出 → 「显式关闭事件」安全前提失效 | 编码器 `return` 只有 `{ reasoningDelta, textDelta, snapshot }`，**确认** | T3a 不再依赖一个未定义的导出；关闭动作由**编码器内部的 `reasoningSummaryDone()`** 完成，并由 T3a Step 1/2 的用例守「必须发出」。3b 才需要工具块的关闭，且要求先有测试 |
| P0-2 | `responseEvents` 没有接收 `liveEmitted` 的入口 | 签名确认是 `{ response, reasoning, content, calls, registry, finishType }` | T3a Step 7 改成在 **`cancelEvents`**（它同时持有 `live` 快照和终态事件）里过滤，不再往 `responseEvents` 塞参数 |
| P0-3 | 行号漂移 8 行（`outputIndex += reasoningItem` 在 847 而非 839 等） | 确认；对方在文件头加了 22 行托管工具代码 | 全文改为**符号锚点**（§9.5），不再出现「第 N 行」 |

### 9.5 定位方式：符号锚点（新增约定）

执行时一律按下面的锚点定位，**不要按行号**。锚点选的是唯一且不易被并行工作改动的字符串。

| 锚点名 | 所在文件 | 锚点字符串 |
|---|---|---|
| `resolveReasoningEffort` | `src/reasoning-effort.js` | `export function resolveReasoningEffort(` |
| `assertAccepted` | `src/reasoning-effort.js` | `function bad(` 附近（新增） |
| `applyReasoningEffort` | `src/api-responses.js` | `function applyReasoningEffort(prepared, account, credentials)` |
| `applyReasoningEffort`（Chat） | `src/api-runtime.js` | `function applyReasoningEffort(credentials)` |
| Anthropic 内联段 | `src/api-runtime.js` | `const declaration = reasoningCatalogue?.getDeclaration({` |
| `consumeSse` | `src/api-responses.js` | `async function consumeSse(upstream)` |
| `run()` 终态入口 | `src/api-responses.js` | `const finalBody = completedResponseBody({` |
| `cancelEvents` | `src/api-responses.js` | `function cancelEvents(finalBody, {` |
| `responseUsage` | `src/protocols/responses.js` | `export function responseUsage(` |
| `completedResponseBody` | `src/protocols/responses.js` | `export function completedResponseBody({` |
| `outputForResult` | `src/protocols/responses.js` | `export function outputForResult({` |
| `createResponsesStreamEncoder` | `src/protocols/responses.js` | `export function createResponsesStreamEncoder({` |
| 索引冲突点 | `src/protocols/responses.js` | `outputIndex += reasoningItem ? 1 : 0` |
| 推理增量 | `src/protocols/responses.js` | `function reasoningDelta(delta)` |
| 工具参数一次性下发 | `src/protocols/responses.js` | `push('response.function_call_arguments.delta'` |
| `responseEvents` | `src/protocols/responses.js` | `export function responseEvents({` |
| `eventUsage` | `src/protocols/openai.js` | `function eventUsage(usage)` |
| Anthropic usage | `src/protocols/anthropic.js` | `function usage(outputTokens, reasoningTokens)` |

### 9.6 外部实测材料的存放位置（**不在本仓库，但可读，已复核**）

v2 曾写「不在仓库中，无法复核」——这个措辞是错的，会让下一位读者重复踩坑。实际情况：

| 材料 | 位置 | 状态 |
|---|---|---|
| `reasoning-effort-guide.md` §5.1 / §5.2 | `~/…/reverse-proxy-master/reverse-proxy-master/docs/reasoning-effort-guide.md` | **已读并复核** |
| `scripts/dump-model-efforts.py` | 同上工作区 `scripts/` | 未纳入本仓库，未核对内容 |
| `scripts/probe-upstream.py` | 同上工作区 `scripts/` | 未纳入本仓库，未核对内容 |

**§5.1 原文已核（三行数据与评审引用一致）**：

```
| space-bunny | canDisableThinking:false | 传 none 实测 47/47  | 真的关不掉 |
| hy4free     | canDisableThinking:false | 传 none 实测 0/0    | 其实能关   |
| glm-5.3     | canDisableThinking:false | 传 none 实测 1      | 能关       |
```

原文的结论是「**总是发，最坏情况是被忽略**」，并且明确要求「在文档里告诉用户部分模型
无法真正关闭思考」。这与 §3.1 第 6 行（显式 `none` 照发）完全一致——本指南因此不再保留
「无法复核」的免责措辞。

**同时发现 §5.2 一条对本计划有直接影响的结论**：`reasoning_tokens` 会漏报
（`step-5-preview` 16 个样本全部为 0，但同批 `reasoning_content` 有 357–939 字符）。
原文给的判据是：

```python
thinking_happened = (reasoning_tokens > 0) or (len(reasoning_content) > 0)
```

**这条已纳入 T6 的验收**：判断「思维链是否恢复」时**两个信号取并集**，
只看 `reasoning_tokens` 会把正常工作的链路误判为「档位没生效」。

### 9.7 续跑约束副作用（采纳「另开 fix」，不并入本计划）

评审指出 `src/continuation-nudge.js` 第 3 条与第 5 条叠加会逼模型一直跑下去。我在
v1 的调查里测到 2/2 次拒绝收尾，但 **n=2 不足以支撑结论**。

**处置：** 另开一个 fix，验收用 3 态对照（关闭 / 现版 / 收窄版），**n ≥ 5**；
收窄方向按评审给的措辞（「任务未完成时才禁止纯文字收尾」+ 逃生语
「若任务已完成（含已在上文给出结论），直接总结，不要为了满足本条而额外调用工具」）。
本计划不包含该改动。

### 9.8 已采纳但需要 Lead 复核的两处判断

1. ~~§0.2 的「上游 123 ms」是单次实测~~ —— **v2.1 已用 10 次多规模实测（48–108 ms）取代**，
   不再单点。执行到 3b 判据时仍以当场实测为准。
2. **§0.1 的「上游思考出现率有抖动」**（受控实验 3 次只有 1 次返回推理）也只来自小样本。
   T6 的验收因此要求 ≥ 2 轮同 prompt 对照，而不是单轮。

### 9.9 v2.1 评审结论（第二轮）

| # | 评审指出 | 核对 | 处置 |
|---|---|---|---|
| 1 | Step 4 让 `output_index` 与终态 `output` 顺序矛盾；`alignLiveOutputIds` 只搬 id 不搬顺序；Step 1 用例抓不到 | **成立**。`outputForResult` 固定按 reasoning→message→calls 构造，`alignLiveOutputIds` 只改 id | T3a 新增**硬规则**小节 + Step 1 顺序断言 + **Step 4b**（终态跟随 live 顺序）；§7 那条错误的缓解措施已替换 |
| 2 | `.audit/decode-window.mjs` 不存在，3b 的「先测量」拦截条件执行不了 | **成立**，已全仓确认为 0 处 | 脚本写成 **T3a Step 0** 的交付物（`scripts/decode-window.mjs`，独立 commit）；本文档里的代码已实跑验证，能精确复现 §0.2 的表 |
| 3 | 数值自相矛盾：标题「192 步」vs 表内 251 步；「63%」vs 65.9%；123 ms × 198 ≈ 24 s 推不出 200–300 tok/s | **全部成立**。「192」是 v1 稿残留；实际 38,131/60,158 = **63.4%**；123 ms 是**单次**实测，且当时的推算漏了「分子里含框架开销」 | §0.2 整节重写：补 251 步、补百分比列、补会话 B、补 **10 次多规模实测（48–108 ms）**、补重算表（906→643~767）；新增 **§0.2b** 说明分子不可修；§6 与 T3b 判据**删掉绝对 tps**，只用相对量 |
| 4 | §1 文件清单过期（4→7），且 `test/run.mjs` 与 `test/api/run.mjs` 易混 | **成立** | §1 改为「按 `git status` 实际输出为准，数量不固定」，并加一条 ⚠️ 区分两个 run.mjs |
| 5 | §9.6 措辞错误：三份材料「不在仓库」，实际在 reverse-proxy 工作区可读 | **成立**，已找到并读原文 | §9.6 重写为位置表 + 已核对的 §5.1 三行原文；**并据此把外部材料里的 §5.2「`reasoning_tokens` 会漏报」纳入 T6 验收**（两信号取并集） |
| 6 | `alignLiveOutputIds(finalBody);` 有 2 处，只有 `const finalBody = completedResponseBody({` 唯一 | **成立**（`terminalFailure` 与 `run()` 各一） | Step 6 改为只用唯一锚点，并写明「用 `alignLiveOutputIds` 会插到失败路径」 |

**评审未提、本轮自查新增的一条**：`RT-`（有推理 + 工具调用）步的零窗口数为 **0**——
推理增量本身就把窗口撑开了。这意味着**修好思维链会顺带改善速度读数**，两个问题不是独立的。
已补进 §0.2 的注记。


---

## 10. 附录：本指南所有数字的复现方式

所有统计结论都可以用 **T3a Step 0 交付的 `scripts/decode-window.mjs`** 复现。
这是本指南里唯一的脚本，不要另外写一份。

```bash
# 会话 A（§0.2 的主表）
node scripts/decode-window.mjs \
  ~/.dsh/sessions/--mnt-windata-awa-NAPCAT--/session-8b4adb24-4c3a-444c-a376-2668b5608a55/session.v4.jsonl.zstd

# 会话 B（交叉验证）
node scripts/decode-window.mjs \
  ~/.dsh/sessions/--mnt-windata-awa-NAPCAT--/session-a5a3c82c-38d3-4d60-ab51-1357235c9ef1/session.v4.jsonl.zstd
```

预期输出（会话 A）：

```
steps=251 outputTokens=60158 decodeMs=114057 tps=527.4
zeroWindowSteps=198 zeroWindowTokens=38131 (63.4%)
  --X  steps=   3 tokens=   2325 (3.9%) zeroSteps=0
  -T-  steps= 198 tokens=  38131 (63.4%) zeroSteps=198
  -TX  steps=  32 tokens=   9786 (16.3%) zeroSteps=0
  RT-  steps=  14 tokens=   7399 (12.3%) zeroSteps=0
  RTX  steps=   4 tokens=   2517 (4.2%) zeroSteps=0
```

**口径说明**（与 `@deepseek-ai/dsh-session-stats` 的 `sessionStats` 投影逐字段一致）：

- `firstVisibleTime`：该步第一条**可见**增量——文本/推理取非空 `text`，工具调用取
  首个带 `name` 或非空 `arguments` 的片段（`tool-call-chunks` 的 `time0 + Σdt`）。
- `decodeMs = t(assistant/message) − firstVisibleTime`；`span <= 5ms` 记为「零窗口」。
- `tps = ΣoutputTokens / ΣdecodeMs`。
- 步型：`R` 有推理、`T` 有工具调用、`X` 有正文。

**上游帧跨度（§0.2 那张 48–108 ms 的表）**不是从会话日志推的，是直连上游测的：
用 `src/upstream-client.js` 发一条带单个 `bash` 工具的真实请求，记录
`choices[].delta.tool_calls` 的到达时刻，比较首帧与末帧。5 条命令 × 2 种 system 前缀 = 10 次。
这段脚本**没有**进仓库（一次性测量），执行者若需要复核，按上面的描述重写约 20 行即可；
也可以用 `node scripts/decode-window.mjs` 在修复后的会话上观察 `-T-` 行的 `zeroSteps` 变化，
效果等价。
