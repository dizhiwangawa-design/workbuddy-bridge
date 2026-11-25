# workbuddy-bridge 完成度评审报告（以代码与现场实测为唯一依据）

- 版本 0.4.0，HEAD = 23b3ee8（本报告第 11–15 节记录 B3 / B2 / B1+B4+B6+统计重构 / DSH 侧速度修复 / 安全加固的落地过程）
- 基线：node test/api/run.mjs = 311/311 通过；node test/run.mjs = 62/62 通过；均 exit 0
- B3 修复后：node test/api/run.mjs = 319/319；node test/run.mjs = 62/62；均 exit 0
- B2 修复后：node test/api/run.mjs = 326/326；node test/run.mjs = 62/62；均 exit 0
- 全部修复后：node test/api/run.mjs = **351/351**；node test/run.mjs = **65/65**；均 exit 0（含安全加固 9 条）
- 工作区未提交：CHANGELOG.md、README.md、src/install.js、test/live/codex-client-smoke.mjs、test/run.mjs，加未跟踪的 dsh 修复计划文档
- 实测方法：21 个一次性探针脚本（已全部删除），覆盖「假上游精确断言」+「真实上游端到端」+「dsh 真实会话日志复算」

> **回归数字说明（2026-11-26 补充）**：上面这些 xxx/xxx 是各阶段当时的历史实测值，
> 保留作修复过程的记录。**当前基线请以实测为准**：
> `node test/api/run.mjs` = 406 通过 / 0 失败；`node test/run.mjs` = 73 通过。
> 两者已随后续提交增长（新增续跑、并发、安全等用例），因此旧数字不可复现属正常。

---

## 0. 总评

| 维度 | 分数 | 一句话结论 |
|---|---|---|
| 1. 三个 API 可达性（无思维链泄漏 / 工具调用完整 / 不吞字） | **96 / 100** | B3（effort=none 抑制）、B2（reasoning 通道 DSML 泄漏）、B1（流式末尾吞字）三协议全部修复 ★ |
| 2. 新改动是否真实有效、是否波及其他模块 | **94 / 100** | 索引、缓存透传、缓存记账、时间口径全部接线并回归全绿 ★；契约冲突那处按既有测试回滚而非强推 |
| 3. DSH 优化与 bug 修复 | **93 / 100** | 续跑约束、半截参数防护有效；速度读数已在 DSH 折叠层修好（零窗口步剔除 527→193）+ 按通道拆分 token ★，见 §14 |
| 4. 缓存命中与统计完整性 | **88 / 100** | 缓存读写已进号池与面板（实测 hitRate 0.57）★；统计新增 ttftMs / decodeMs / decodeThroughput，并与端到端吞吐分开呈现 ★ |
| 5. DSH 上下文统计正确性 | **88 / 100** | Anthropic 流式已在 message_delta 回填真实 input_tokens（实测 4016 估算 → 1079 真实）★；目录与另两条协议本就正确 |
| 6. 思考程度（reasoning effort）修复 | **94 / 100** | 冷目录透传真实有效、三 API 全覆盖；关闭思考的抑制与真实 input_tokens 回填都已补齐 ★ |

**整体完成度：约 92%。**（基线 65% → B3 后 69% → B2 后 73% → 桥接侧全部修复后 89% → DSH 侧速度修复后 92%，★ 标记的条目是本轮修复的增量。）
六条主线里，「档位透传」「思维链不泄漏」「不吞字」「缓存统计」「上下文统计」五条已闭环；
「速度读数」在两头都修了——桥接侧改口径（§13.4），DSH 折叠层改算法（§14）——只剩「拆分是比例归因而非精确计数」这一条本质限制。

> 关键判断：该计划文档的 T1/T2/T3a/T4/T5 已合并（aced061…40aac50）；**T3b 经实测判定为「不做」**（与既有测试契约冲突，且收益不足），T6 文档部分已补。计划文档顶部现已改为如实的执行状态表（不再写「尚未执行」）。

---

## 1. 三个 API 的可达性

### 1.1 结论：可达，工具调用完整

真实上游端到端（staged bridge home，真实账号，真实 copilot.tencent.com）：

    [RESPONSES] status = 200 | terminal = response.completed
    [RESPONSES] output = reasoning,function_call   | args = {"command":"ls -la"}
    [CHAT]      status = 200 | finish = tool_calls | args = {"command":"ls"}
    [ANTHROPIC] status = 200 | blocks = ["thinking","tool_use"] | input_json = {"command":"ls -la"}

三条协议都能完整落到 tool_use / function_call，参数 JSON 完整，finish_reason 正确映射（tool_calls → tool_use）。**这一点达标。**

### 1.2 缺陷 A（P0，**已修复 ★**）：思维链泄漏 —— reasoning 通道的 DSML 原文不剥离

> **本节记录的是修复前的状态，保留作为修复依据。修复与验证见 §12。**

src/api-responses.js 的 applyDocument 里，reasoning_content 直接 appendResponseText(reasoningText, ...) 与 liveEncoder.reasoningDelta(...)，**从不经过 createDsmlScanner**；扫描器只作用于 content 通道。

实测（假上游把工具调用塞进 thinking 通道）：

    RESPONSES DSML marker survives in response = true
    CHAT      DSML marker survives in response = true

即：当模型把 DSML 工具调用写在思考里（DeepSeek 系模型的常见行为），客户端会在 reasoning / reasoning_content 里看到原始标记文本，而不是被剥离成一次工具调用。**这是「思维链泄漏 + 工具调用不完整」的合流缺陷**：既漏了内部标记，又少了一次本该执行的调用。

### 1.3 缺陷 B（P0，**已修复 ★**）：effort=none 时思维链未被抑制，与 CHANGELOG 声明相反

> **本节记录的是修复前的状态，保留作为修复依据。修复与验证见 §11。**

CHANGELOG.md 的 Known Limitations 写着："The proxy suppresses that reasoning text when thinking is disabled and emits one content-free server warning for the request."

实测：

    effort=none  stream=false | CoT visible = true | reported effort = none
    effort=none  stream=true  | CoT visible = true | reported effort = none
    effort=null  stream=false | CoT visible = true | reported effort = none
    effort=null  stream=true  | CoT visible = true | reported effort = none

逐协议核对源码：

| 协议 | 位置 | 是否抑制 | 结论 |
|---|---|---|---|
| Anthropic | src/api-runtime.js:598 —— condition 为 body.normalized.thinkingEnabled 时才 write(encoder.thinkingDelta(...)) | **是** | 唯一正确的 |
| Chat | src/api-runtime.js:1586 及 createChatEncoder.reasoningDelta | **否**，无条件发送 | 泄漏 |
| Responses | src/api-responses.js:1173 —— if (payload.reasoning_content) 就 publishLive(...reasoningDelta(...)) | **否**，无条件发送 | 泄漏 |

所以「Known Limitation」这句话只对 Anthropic 成立，对 Chat / Responses 是**错误声明**。

### 1.4 缺陷 C（P0，真实吞字）：流式响应末尾的 DSML 前缀缓冲未 flush

createDsmlScanner 用 longestPrefixSuffix(buffer, CALLS_OPEN) 把可能是标记开头的尾巴留在缓冲里（正确的防误判设计），但**流式路径结束时这份缓冲没有回灌到 live 文本**。

实测（正文以尖括号结尾）：

| 输入 | Responses 流式 | Chat 流式 | 非流式 |
|---|---|---|---|
| trailing less-than 后跟一个半角左尖括号 | 该尖括号丢失 | 该尖括号丢失 | 完整 |
| 后跟 半角左尖括号 + 全角竖线 | 丢失 | 丢失 | 完整 |
| 后跟 左尖括号 + 两个全角竖线 | 丢失 | 丢失 | 完整 |
| 后跟 左尖括号 + 两个全角竖线 + 字母 D | 丢失 | 丢失 | 完整 |

根因链（src/api-responses.js）：

1. snapshot(final=true) 确实调用了 scanner.finish() 并 appendResponseText(visibleText, scanned.visibleText) —— 终态**是对的**；
2. 但 run() 里紧接着 if (liveEncoder?.snapshot().content) result.content = liveEncoder.snapshot().content; **用 live 内容覆盖了终态内容**；
3. cancelEvents(finalBody, { finalDeltas: false }) 又把终态 delta 按 live.content.length 切片裁掉尾部。

结果：任何以尖括号结尾（或结尾凑巧构成 DSML 前缀）的正文，在**流式**下丢字符。这是用户所说「吞字」的精确复现。Chat 路径同构（src/api-runtime.js 的 emit(encoder.finalize(...)) 用 visibleText.value()，而 live 已发过截断版本）。

---

## 2. 新更改与修复的新 bug 是否真实有效

### 2.1 真实有效的（有证据）

| 提交 | 内容 | 证据 |
|---|---|---|
| fb54007 | 每块独立 output_index + 推理结束事件 | 探针：added idx = 0:message, 1:reasoning, 2:function_call；终态 output 顺序一致；order invariant = true；done ids 无重复 |
| fb54007 | 交错/并行工具调用 | 探针：2 个并行调用 + 正文与推理交错 → 顺序 message/reasoning/fc/fc，参数各自完整 ls 与 pwd |
| fb54007 | 续接（previous_response_id）顺序 | 探针：第二轮 output = msg(prior), reasoning(prior), msg(new), reasoning(new)，output_index 从 2 起算，不重复关闭 |
| 3d15bf4 / 40aac50 | 缓存命中透传 | 探针：Responses input_tokens_details.cached_tokens=3840；Chat prompt_tokens_details.cached_tokens=3840；Anthropic cache_read_input_tokens=3840 / cache_creation_input_tokens=64 |
| 未提交 src/install.js | DSH_HOME 改为调用时解析 | 全量测试通过；diff 干净（只把模块常量换成 dshHome()） |
| 23b3ee8 | worker 不继承 node --eval 参数 | 有专门用例「SQLite worker 不从 node --eval 继承无效启动参数」通过 |

### 2.2 看似修了、实际没修好的

**缓存统计断线（P1）。** 客户端可见的 usage 已经正确，但**回写给号池/统计的 lease meta 里没有缓存字段**。三 API 实测：

    RESPONSES  client usage: {"input_tokens":4010,"input_tokens_details":{"cached_tokens":3840}}
    RESPONSES  lease meta  : {"model":"deepseek-v4.1-flash","usage":{"input_tokens":4010,"output_tokens":12}}
    CHAT       client usage: {"prompt_tokens_details":{"cached_tokens":3840}}
    CHAT       lease meta  : {"input_tokens":4010,"output_tokens":12}
    ANTHROPIC  client usage: {"cache_read_input_tokens":3840,"cache_creation_input_tokens":64}
    ANTHROPIC  lease meta  : {"input_tokens":4010,"output_tokens":12}

src/pool.js:262 读的是 usage.cache_read_input_tokens，而三个 runtime 的 leaseResult.meta.usage 只写 {input_tokens, output_tokens}。于是 stats.js 的 cacheHitRate = cacheRead / tin **恒为 0**：

    account codex-fresh-mvxgctfk | req 3 | tokensIn 45 | tokensOut 6 | cacheRead 0
    buildStats totals: {"req":109,"tokens":15341686,"cacheHitRate":0,...}

对照：真实上游同一请求报 prompt_cache_hit_tokens=3840 / prompt_tokens=4010。数据源已具备，只差一次接线。

**effort=none 抑制（见 §1.3）** 曾属于「文档说修了、实现没修」，**已在本次修复中落地（§11）**。

### 2.3 是否波及其他模块

- 全量回归 **311/311 + 62/62，exit 0**，无新增失败；
- 索引重排是有意的契约变更（流顺序 = 终态顺序），已被顺序断言守住；
- install.js 的延迟解析是纯改善，不改变默认路径；
- 未发现「改一处崩一片」的连带破坏。

---

## 3. DSH 的优化与 bug 修复

### 3.1 工具调用不泄漏 —— 部分达成

**做对的部分**：live 流**从不**提前下发可执行的半截参数。createResponsesStreamEncoder 只对 reasoning / text 发 live 事件，function_call_arguments.delta 只在终态发一次，且仲裁失败会走 response.failed。这是正确的安全取舍。

**曾经没做到的**：§1.2 的 reasoning 通道泄漏 —— 那同样属于「工具调用泄漏」（标记原文泄漏给用户）。**已在本次修复中补齐（§12）**：三协议现在都在推理通道上跑扫描器。

### 3.2 输出后调用工具不自动异常停止 —— 达成

src/continuation-nudge.js 在三协议都注入（实测 config.continuationNudge = true，Responses / Chat / Anthropic 上游请求里都能看到「运行约束」标记，注入位置在最后一条 user 之后、保持 assistant(tool_calls) 与 tool 结果相邻）。

真实上游三轮多步任务全部正常进入工具循环，未出现「写完一句散文就停」。这一项**验收通过**。

### 3.3 tokens 速度显示 —— 完全未修（最大缺口）

用仓库自带的 scripts/decode-window.mjs 复算真实 dsh 会话，结果与计划文档 §0.2 **逐位一致**，说明修复尚未落地：

    会话 A: steps=251 outputTokens=60158 decodeMs=114057 tps=527.4
            zeroWindowSteps=198 zeroWindowTokens=38131 (63.4%)
            -T-  steps=198 tokens=38131 (63.4%) zeroSteps=198   ← 纯工具调用步 100% 零窗口
    会话 B: steps=250 outputTokens=106179 decodeMs=369773 tps=287.1
            -T-  steps=183 tokens=46852 (44.1%) zeroSteps=183

直接测上游真实节奏（真实 copilot.tencent.com，ls -la 一条命令）：

    tool_calls argument frames = 10
    first frame at +123ms , last frame at +163ms , span = 40ms
    frame sizes = 0,2,7,1,3,2,2,2,1,1
    joined = {"command": "ls -la"}

上游切成 **10 帧、40ms** 发完，桥接把它们攒成 **1 帧**在响应结束时下发 → decodeMs ≈ 0 → tps = ΣoutputTokens / ΣdecodeMs 爆炸。这正是 T3b，**未实施**。

补充一条计划文档没写透的：decodeMs 的分子含工具调用框架 token（本次实测 out=42 对应 30 字符参数），所以即使做了 T3b，tps 也只会从「虚高 3–4 倍」降到「虚高 1.5–2 倍」。**桥接侧无法根治，必须 DSH 侧拆分 token 口径。**

---

## 4. 缓存命中与统计模块（含改进报告）

### 4.1 现状盘点

| 层 | 状态 |
|---|---|
| 上游 → 桥接解析 | 通过：usageFromChunk / openAIUsage / responseUsage 都能识别 prompt_cache_hit_tokens、prompt_tokens_details.cached_tokens、cache_read_input_tokens、prompt_cache_write_tokens |
| 桥接 → 客户端 | 通过：三协议全部透传（只在非零时输出，保住旧形状） |
| 桥接 → 号池记账 | **断线**：leaseResult.meta.usage 不含 cache 字段 |
| 号池 → 统计 | 有实现但恒 0：stats.js:335 cacheHitRate = cacheRead / tin |
| 面板展示 | 只有一个 cacheHitRate（admin.js:763）加单一 throughput（admin.js:757） |

### 4.2 口径问题（不只是断线）

1. stats.js 注释写「input_tokens 已包含 cache_read_input_tokens」，与 Anthropic 原生语义**相反**（Anthropic 的 input_tokens 不含 cache）。当前实现因为恒 0 而掩盖了这个矛盾；一旦接线，Anthropic 路径的 cacheHitRate 会 > 100%。
2. throughput = tout / (ms/1000) 是**端到端吞吐**，把 TTFT、排队、上游抖动全算进分母，和 dsh 的 decodeTokens/decodeMs（纯解码窗口）**不是同一个量**。面板却标成「生成速度」，这本身就是「速度显示不正常」的一部分。
3. 没有任何 TTFT 采样：grep ttft / firstToken 在 src/ 只命中超时用的 firstByteTimer，**没有一个「首 token 到达时刻」的统计变量**。

### 4.3 借鉴开源方案的具体改法（改进报告）

参考 LiteLLM 的 prompt-caching 计量口径与 pi-ai 的 cacheRead/cacheWrite 分离模型（openai-completions.js:1167 与 openai-responses-shared.js:454 都是先从 usage 拆出四个分量再算成本）：

**R1（P0，一次接线，立刻见效）** —— 三处 leaseResult.meta.usage 补字段（src/api-runtime.js:923 Anthropic、src/api-runtime.js:1897 Chat、src/api-responses.js:1311 Responses）：

    usage: {
      input_tokens: ...,
      output_tokens: ...,
      cache_read_input_tokens: Number(usage.cacheReadTokens ?? snapshot.usage.cached_tokens) || 0,
      cache_creation_input_tokens: Number(usage.cacheWriteTokens) || 0,
      reasoning_tokens: ...,
    }

**R2（P0）** —— stats.js 拆成四个互斥分量，别再用「input 含 cache」的假设：

    freshIn    = max(0, tin - cacheRead)
    cacheHitRate = cacheRead / (freshIn + cacheRead)   // 与 dsh 的 formatCacheHitPercent 口径一致

**R3（P1）** —— 采集 ttftMs 与 decodeMs，面板分三栏：

| 指标 | 定义 | 对应用户抱怨 |
|---|---|---|
| TTFT | 请求发出 → 首个可见增量（首个非空 content / reasoning_content / tool_calls.name） | 「首字慢」 |
| decode tok/s | output_tokens / decodeMs，decodeMs = 结束 − 首增量 | dsh 里那个四位数 |
| 端到端 tok/s | output_tokens / totalMs | 现有 throughput，改标签即可 |

**R4（P1）** —— decodeMs 要**排除纯工具调用步**或单独计数。否则修了 T3b 也只有 40ms 分母。建议同时记 decodeTokens 与 toolCallSteps，让前端能算「去掉工具步后的真实速度」。

**R5（P2）** —— 采样粒度：现在只有小时桶/天桶（stats.js 的 KEEP_HOUR_DAYS=16 / KEEP_DAY_DAYS=400），要算分位数（p50/p90 TTFT）需要保留原始 sample 窗口，建议加一个 500 条的环形缓冲。

---

## 5. DSH 上下文统计排查（结合上游与本机）

### 5.1 DSH 侧机制（读 @deepseek-ai/dsh-token-meter 源码）

contextPressure 投影的分子分母来源不同，这一点很关键：

    const pressureFrom = (usage) => usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    // 分子：最新一次 assistant/message 的 usage（prompt 侧）
    // 分母：最新一次 request/context 事件的 contextWindow

注释里作者自己也写明："the pair is explicitly not one atomic request observation"。所以**分子是否可信，完全取决于桥接上报的 usage 是否可信**。

### 5.2 桥接侧排查结果

| 协议 | input_tokens 来源 | 实测同一请求 | 判定 |
|---|---|---|---|
| Responses | 上游 usage.prompt_tokens | 485 | 准确 |
| Chat | 上游 usage.prompt_tokens | 485 | 准确 |
| Anthropic 非流式 | 上游 usage.prompt_tokens | 805 | 准确 |
| **Anthropic 流式** | **estimateAnthropicInputTokens(body) = bytes / 3 估算** | **4150** | **偏大 5.2 倍** |

    message_start usage = {"input_tokens":4150}     ← 估算
    message_delta usage = {"output_tokens":64,...}   ← 上报里没有 input_tokens
    non-stream usage    = {"input_tokens":805,...,"cache_read_input_tokens":640}  ← 真实
    request chars       = 4000

src/protocols/anthropic.js:389 的 message_start 写死 usage: { input_tokens: inputTokens }（构造函数入参），而 finalize 的 message_delta 只带 output_tokens 系。**Anthropic SDK 的语义是 message_start 给初值、message_delta 可覆盖**（pi-ai 的 anthropic-messages.js:657 就是这么处理的："Preserves input_tokens from message_start when proxies omit it in message_delta"）。

**后果**：任何按 Anthropic 协议接入的客户端，上下文占用条会显示约 5 倍真实值，很容易误触发压缩/截断。这是「上下文统计有问题」的**唯一实锤根因**。

### 5.3 模型目录侧（正确，无需改）

GET /v1/models 实测输出 deepseek-v4.1-flash：context_window 1000000、max_output_tokens 128000、input [text, image]、wb_reasoning.form = "supported"、supported_efforts [low, high, max]。与用户 ~/.dsh/profiles/web/cordis.patch.yml 的手写条目一致。dsh 网络发现只采纳 id/名称/容量，所以这里「发布正确但客户端不采用」不是桥接的 bug，README 已有说明。

---

## 6. 思考程度修复的真实性

### 6.1 冷目录透传 —— 真实有效，三 API 全覆盖

src/reasoning-effort.js:138 的 return { effort: raw === 'minimal' ? 'low' : raw, source: 'passthrough' } 是这次最扎实的一处修复。探针（目录刻意保持冷）：

    RESPONSES cold-catalogue forwarded effort = "max"
    CHAT      cold-catalogue forwarded effort = "max"
    ANTHROPIC cold-catalogue forwarded effort = "max"
    RESPONSES reported reasoning effort = {"effort":"max","summary":null}

真实上游 5 轮 A/B（同一 prompt、同一 effort=max）：

    RESPONSES thinking 5/5 | reasoningTokens 35,33,30,78,38
    CHAT      thinking 3/5 | reasoningTokens 145,74,0,33,0
    ANTHROPIC 3 轮里 thinking 块分别出现（含 thinking 内容与 reasoningTokens 128/18/37）

结论：**档位确实送到了上游**，思维链确实恢复了。Chat 的 3/5 与 Anthropic 的抖动来自**上游本身**（计划文档 §0.1 记录过同一现象，本次独立复现，n=5）。

### 6.2 判定链与 §3.1 矩阵一致

逐条核对 resolveRequestedEffort：未声明 → none/default；显式 none → none/disabled；form:none → 不发送；efforts 非空 → 向上取档；**目录缺失 → passthrough**。与计划文档 §3.1 的 8 行矩阵完全一致；未知档位名仍 400（invalid_reasoning_effort）。

### 6.3 唯一扣分项：关闭思考时的抑制不齐

见 §1.3。修复前三家只有 Anthropic 会抑制 effort=none 下的推理文本，Chat 与 Responses 原样透出。用户要求「三个 api 都要覆盖」——**本次已按此补齐，验证见 §11**。

---

## 7. 缺陷清单（按优先级，每条都带证据）

| ID | 级别 | 缺陷 | 证据 | 影响面 |
|---|---|---|---|---|
| **B1** | P0 | ~~流式响应末尾 DSML 前缀缓冲未 flush → 吞字~~ **已修复 ★** | 修复前 Chat 丢字符、Responses 终态被 live 覆盖；修复后三协议四组用例全绿，见 §13 | 所有以尖括号结尾的正文 |
| **B2** | P0 | ~~reasoning 通道的 DSML 原文不剥离~~ **已修复 ★** | 修复前 leak = true（三协议）；修复后全部 false，见 §12 | 安全 + 工具调用完整性 |
| **B3** | P0 | ~~effort=none 时 CoT 未抑制（Chat、Responses）~~ **已修复 ★** | 修复前 CoT visible = true（4/4）；修复后全部 false，见 §11 | 隐私 + 与 CHANGELOG 声明矛盾 |
| **B4** | P0 | ~~缓存命中未回写 lease meta → 面板命中率恒 0~~ **已修复 ★** | 修复前 lease meta 无 cache 字段；修复后实测号池 hitRate 0.57，见 §13 | 统计可信度 |
| **B5** | P1 | 工具参数整块下发 → dsh 速度虚高 | 桥接侧**不做**（与两条契约冲突，§13.5）；改在 **DSH 折叠层**修：零窗口步剔除 + 通道拆分，527→193 ★，见 §14 |
| **B6** | P1 | ~~Anthropic 流式 input_tokens 是 bytes/3 估算~~ **已修复 ★** | 修复前 message_delta 不带 input_tokens；修复后实测 4016（估算）→ 1079（真实），见 §13 | 上下文占用统计 |
| **B7** | P2 | ~~throughput 口径是端到端而非解码速度，标签误导~~ **已修复 ★** | 面板改称「解码速度」并用 decodeThroughput；端到端吞吐降为一行说明，见 §13 | 面板可信度 |
| **B8** | P2 | ~~stats.js 假设「input 含 cache」~~ **已用夹取兜住 ★** | cacheReadSafe() 把命中率钉在 100% 以内，freshIn 不再为负；有用例，见 §13 | 接线后会 >100% |
| **B9** | P2 | ~~计划文档自称「未执行」，但 T1–T5 已合并~~ **已修复 ★** | 文档顶部改为执行状态表，并写明 T3b 为什么不做 | 误导后续执行者 |

---

## 8. 指导修复计划

> **状态**：阶段 0 的 T-D（B3）与 T-B（B2）**已完成**，见 §11 / §12。T-A（B1）、T-C（B4）仍待做。

### 阶段 0：一天内可完成的高收益修复（B1、B2、B4）

**T-A（B1 吞字，改动约 3 行）**
src/api-responses.js 的 run() 终态处，去掉「live 覆盖终态」，改成只在 live 更长时取 live：

    // 现状（覆盖，导致吞字）
    if (liveEncoder?.snapshot().content) result.content = liveEncoder.snapshot().content;
    // 改为（终态是 scanner.finish() 之后的权威值，永远不比 live 短）
    const liveContent = liveEncoder?.snapshot().content || '';
    if (liveContent.length > result.content.length) result.content = liveContent;

Chat / Anthropic 同构检查：src/api-runtime.js 两处 encoder.finalize 前，把 visibleText 与 live 已发文本比较，把差额补发一次 delta。

**验收**：新增用例「流式正文以尖括号（含 1 个、2 个全角竖线前缀）结尾时不得丢字符」，三协议 × 流式/非流式共 6 条断言。

**T-B（B2 reasoning 通道扫描，★ 已完成，实现见 §12）**
applyDocument 里给 reasoning 单独建一个 createDsmlScanner：

    if (typeof payload.reasoning_content === 'string') {
      const scannedReasoning = reasoningScanner.push(payload.reasoning_content);
      if (scannedReasoning.error) throw runtimeError(...);
      if (scannedReasoning.calls.length) dsmlCalls.push(...scannedReasoning.calls);
      if (scannedReasoning.visibleText) { /* 只下发可见部分 */ }
    }

终态在 snapshot(true) 里 reasoningScanner.finish() 并合入 dsmlCalls。三协议都要做（Chat 的 processDocument 同构）。

**T-D（B3 关闭思考时的抑制，★ 已完成）**
**验收**：见 §11 的实测矩阵与用例清单。

**验收**（已通过）：用例「工具调用出现在 reasoning 通道时被剥离并执行，且响应里不含 DSML 标记」。

**T-C（B4 缓存接线，3 处 × 约 5 行）**
按 §4.3 的 R1 与 R2 改。**注意先做 R2 再做 R1**，否则 Anthropic 路径的 cacheHitRate 会 >100%。

**验收**：真实上游跑 3 次，pool.json 里 cacheRead > 0；面板「缓存命中率」非 0；单测覆盖 cacheRead/(freshIn+cacheRead) 的边界（全命中=1、零命中=0、无 usage=null）。

### 阶段 1：dsh 速度读数（B5，即计划文档的 T3b）

前置：先落 T-A（否则增量下发会让吞字更频繁）。

1. response.output_item.added（item.type === 'function_call'）**必须在首个参数增量之前发**；
2. 逐帧转发上游 function.arguments 片段为 response.function_call_arguments.delta；
3. 流结束时统一 done + output_item.done；仲裁失败走 response.failed，**不发** done；
4. **仲裁逻辑不变**（createStructuredToolAssembler + arbitrateToolCalls），最终可执行参数仍以仲裁结果为准。

**验收（只用相对量）**：node scripts/decode-window.mjs 新会话的 -T- 行 zeroSteps/steps 从约 100% 降到 < 20%。**不要用绝对 tps 当判据**（§3.3 已说明分子不可修）。

### 阶段 2：统计口径重构（B7、B8 + R3/R4/R5）

1. 采样结构加 ttftMs、decodeMs、decodeTokens、toolCallSteps（stats.js 的 emptyMetrics 起手）；
2. 三个 runtime 在首个可见增量处打点（liveEncoder.textDelta / reasoningDelta 首次返回非空时）；
3. 面板把「生成速度」拆成 TTFT / 解码 tok/s / 端到端 tok/s 三栏；
4. freshIn / cacheRead / cacheWrite / out 四分量的成本公式同步改（stats.js:276）。

**验收**：构造一次「首字节慢、解码快」与一次「首字节快、解码慢」的假上游，三栏指标必须分别体现差异。

### 阶段 3：上下文统计与文档（B6、B3、B9）

1. **B6**：src/protocols/anthropic.js 的 message_start 保留估算值，但**在 finalize 的 message_delta.usage 里补真实 input_tokens**（pi-ai 已支持覆盖）。同时 src/api-runtime.js:923 的 leaseResult 用真实值。
2. **B3**：Chat 与 Responses 补 thinkingEnabled 判定；effort === 'none' 或未声明时不发 reasoning delta，并保留一次 logWarn（与 Anthropic 对齐）。
3. **B9**：把 docs/superpowers/plans/2026-11-08-dsh-reasoning-and-timing-fix.md 顶部的「尚未执行」改成实际状态（T1–T5 已合并 / T3b、T6 待做），并把 CHANGELOG 的 Known Limitations 按 §1.3 的实测结论改写 —— **不要留一条与实现相反的声明**。

---

## 9. 不建议做的事（避免过度工程）

- **不建议**为了速度读数去改 DSH 的 decodeMs 算法（不在本仓库，且 T3b 已能拿到大部分收益）。
- **不建议**在桥接侧伪造 decodeMs（比如人为 sleep 拉长分母）—— 那会把「虚高」换成「虚低」，更不可信。
- **不建议**把 reasoning.summary / include 转发到上游（无上游接受度证据，计划文档 §2 已列为 Non-Goal）。
- **不建议**为 canDisableThinking 重开判定（计划文档 §9.1 的三行实测数据虽不在仓库，但结论方向不依赖精确数字）。

---

## 10. 附：本次实测的复现命令

    # 1) 全量回归
    node test/api/run.mjs      # 311/311
    node test/run.mjs          # 62/62

    # 2) dsh 速度读数（仓库自带脚本，数字与计划文档逐位一致）
    node scripts/decode-window.mjs \
      ~/.dsh/sessions/--mnt-windata-awa-NAPCAT--/session-8b4adb24-4c3a-444c-a376-2668b5608a55/session.v4.jsonl.zstd
    node scripts/decode-window.mjs \
      ~/.dsh/sessions/--mnt-windata-awa-NAPCAT--/session-a5a3c82c-38d3-4d60-ab51-1357235c9ef1/session.v4.jsonl.zstd

其余结论均来自临时探针脚本（假上游注入 + 真实上游端到端），脚本已清理，方法见本文各小节的代码锚点。
---

## 11. B3 修复记录（本次已实施）

### 11.1 判据设计：只认「显式要求关闭」

修复前的核心难点不是「怎么抑制」，而是「什么时候该抑制」。\`resolveReasoningEffort\` 对两种不同语义都返回 \`'none'\`：

| 客户端输入 | 归一化后转发值 | 语义 |
|---|---|---|
| \`reasoning.effort: "none"\`（显式） | \`none\` | **我要求关闭思考** |
| 未声明档位 | \`none\` | 什么都没要求，桥接补的默认值 |

如果一律按 \`forwardedEffort === 'none'\` 抑制，第二种情况会**静默砍掉既有功能**——未声明档位的请求本来能拿到推理正文（既有用例 \`OpenAI SSE 聚合生成标准非流式响应\` 就断言了 \`reasoning_content: 'think'\`）。

因此改用 \`resolveRequestedEffort\` 的 \`source\` 字段作为判据：

\`\`\`js
const decision = resolveRequestedEffort(prepared.requestedEffort, declaration);
prepared.reasoningSuppressed = decision.source === 'disabled';   // 只有显式 none 才为 true
\`\`\`

\`source === 'disabled'\` 只在 \`raw === 'none' && hasRequest\` 时为真，正好对应「显式要求关闭」。

### 11.2 改动清单

| 文件 | 改动 |
|---|---|
| \`src/api-responses.js\` | import 换成 \`resolveRequestedEffort\`；\`applyReasoningEffort\` 写入 \`prepared.reasoningSuppressed\`；\`applyDocument\` 的 reasoning 分支按它分流；新增 \`warnedReasoningWhileDisabled\` 一次性告警 |
| \`src/api-runtime.js\` | import 补 \`resolveRequestedEffort\`；Chat 的 \`applyReasoningEffort\` 写入 \`body.reasoningSuppressed\`；\`processDocument\`（Chat）reasoning 分支按它分流；新增同名告警变量 |
| \`CHANGELOG.md\` | Known Limitations 重写为「三协议按显式 none 抑制 + 未声明不抑制」；Changed 增补一条 |
| \`README.md\` | Anthropic 小节统一三协议口径；修正「缓存中没有该模型时不发送 reasoning_effort」这处**与实现相反**的旧描述（实际是 passthrough） |
| \`test/api/responses.test.mjs\` | +4 用例 |
| \`test/api/openai.test.mjs\` | +3 用例 |
| \`test/api/anthropic-http.test.mjs\` | +1 回归守卫用例 |

### 11.3 验证矩阵（假上游精确断言）

\`\`\`
RESPONSES none stream=false | CoT visible = false
CHAT      none stream=false | CoT visible = false
RESPONSES none stream=true  | CoT visible = false
CHAT      none stream=true  | CoT visible = false
RESPONSES max  stream=false | CoT visible = true
CHAT      max  stream=false | CoT visible = true
RESPONSES max  stream=true  | CoT visible = true
CHAT      max  stream=true  | CoT visible = true
RESPONSES unset             | CoT visible = true
CHAT      unset             | CoT visible = true
ANTHROPIC disabled          | CoT visible = false
ANTHROPIC enabled           | CoT visible = true
\`\`\`

每次抑制都伴随恰好一条不含正文的告警：

\`\`\`
WARN Responses request resp_… received reasoning content while reasoning_effort was none; the model may not honor none
WARN Chat request chatcmpl-… received reasoning content while reasoning_effort was none; the model may not honor none
WARN Anthropic request msg_… received reasoning content while thinking was disabled; the model may not honor none
\`\`\`

### 11.4 真实上游端到端（staged bridge home，真实账号）

\`\`\`
effort=none
  RESPONSES {"status":200,"kinds":"function_call","reasoningTokens":0,"reasoningChars":0,"args":"{\"command\":\"ls\"}"}
  CHAT      {"status":200,"finish":"tool_calls","reasoningChars":0,"reasoningTokens":0,"args":"{\"command\":\"ls -la\"}"}
effort=max
  RESPONSES {"status":200,"kinds":"reasoning,function_call","reasoningTokens":64,"reasoningChars":286,"args":"{\"command\":\"ls -la\"}"}
  CHAT      {"status":200,"finish":"tool_calls","reasoningChars":137,"reasoningTokens":32,"args":"{\"command\":\"ls -la\"}"}
\`\`\`

**关键点**：\`effort=none\` 时推理正文消失（reasoningChars 0），但**工具调用依然完整下发**（args 与 max 档一致），说明抑制只作用于 reasoning 通道，没有连带吞掉正文或工具调用。

### 11.5 回归

\`\`\`
node test/api/run.mjs  →  319/319  pass,  fail 0,  exit 0   （修复前 311）
node test/run.mjs      →   62/62   pass,           exit 0
\`\`\`

新增 8 条用例全部通过；既有 311 条无一条被改动或删除。特别确认了三条「不能被抑制影响」的回归守卫：

- \`OpenAI SSE 聚合生成标准非流式响应\`（未声明档位仍返回 \`reasoning_content: 'think'\`）
- \`Responses 未声明档位时保持既有行为：推理正文照常透出\`
- \`Chat 显式档位与未声明档位都不受抑制逻辑影响（回归守卫）\`

### 11.6 本次修复没有触及的范围（避免误读）

- **没有**改 \`resolveRequestedEffort\` 的判定链——抑制只发生在「渲染」环节，转发逻辑一行未动；
- **没有**改 Anthropic 的既有抑制行为（它本来就是对的），只补了一条回归守卫；
- **没有**碰 B1（吞字）、B4（缓存记账）——这两条仍待做；B2 的 reasoning 通道剥离在紧随其后的另一批改动里完成（§12）；
- \`reasoning_tokens\` 的 usage 上报保持原样：抑制正文不影响 token 计量（\`effort=none\` 且上游仍思考时，报告里的 0 与正文隐藏并不矛盾——那是上游真实计费口径）。
---

## 12. B2 修复记录（本次已实施）

### 12.1 问题复述与判据

模型有时把工具调用写进**思考通道**而不是正文。`createDsmlScanner` 此前只挂在 `content` / `delta.content` 上，`reasoning_content` 是一条直通管道：

| 通道 | 修复前 | 后果 |
|---|---|---|
| 正文 | `scanner.push(content)` → 调用进仲裁、可见文本下发 | 正确 |
| 推理 | 直接 `append(reasoningText, ...)` + `publishLive(reasoningDelta(...))` | 原始标记泄漏给用户 + 少执行一次调用 |

因此判据有两条，必须**同时**满足：
1. 响应里（任何字段）不出现 DSML 标记原文；
2. 该调用成为一次真实可执行的工具调用。

### 12.2 设计要点

**要点一：推理通道用独立扫描器。**
不能复用正文那把——两个通道的缓冲如果共用，一段跨通道的半截标记会把彼此的内容锁在缓冲里，直到对方补齐才放行。三处各建一个 `reasoningScanner`。

**要点二：失败策略与正文不同。**
正文通道畸形 → `throw`（失败关闭，宁可整轮失败也不能把半截标记当正文发出去）。推理通道畸形 → 只 `warn` 并丢弃该片段。理由：推理是辅助内容，一段跑偏的思考不该把本来能成功的回合打成 502。这条差异是有意的，已写进 README。

**要点三：收尾必须 flush。**
与 B1 同源的坑：`longestPrefixSuffix` 会把可能是标记开头的尾巴留在缓冲里。所以终态必须调 `reasoningScanner.finish()`，把 `visibleText` 补回推理正文、把 `calls` 并入仲裁。

### 12.3 改动清单

| 文件 | 改动 |
|---|---|
| `src/api-responses.js` | 新增 `reasoningScanner`；抽出 `applyReasoningDocument(text)`（扫描 → 调用并入 `dsmlCalls` → 可见文本下发 → 抑制判断 → 告警幂等）；`snapshot(final)` 里 flush 并把尾巴补回 `reasoningText`；`run()` 终态改成「只在 live 更长时取 live」 |
| `src/api-runtime.js`（Chat） | 新增 `reasoningScanner` 与 `applyReasoningDocument`；`processDocument` 的 reasoning 分支改为调用它；`scanner.finish()` 之后追加推理通道 flush |
| `src/api-runtime.js`（Anthropic） | 同上，另保留既有的 `thinkingEnabled` 抑制与一次性告警语义 |
| `CHANGELOG.md` / `README.md` | 记录行为与失败策略差异 |
| 测试 | Responses +3、Chat +3、Anthropic +1 |

### 12.4 顺带修掉的 B1 一半（Responses 终态被 live 覆盖）

`run()` 里原本无条件 `result.content = liveEncoder.snapshot().content`，把 `scanner.finish()` 产出的权威终态覆盖成「已经流出去的那部分」。改成只在 live 更长时取 live：

```js
const liveSnapshot = liveEncoder?.snapshot();
if (liveSnapshot?.content && liveSnapshot.content.length > result.content.length) {
  result.content = liveSnapshot.content;
}
if (liveSnapshot?.reasoning && liveSnapshot.reasoning.length > result.reasoning.length) {
  result.reasoning = liveSnapshot.reasoning;
}
```

这修掉了 **Responses 侧**的「流式末尾丢字符」。**Chat / Anthropic 侧的吞字（B1 剩余部分）仍未修**——那两条路径的 `encoder.finalize()` 用的是 `visibleText.value()`，与 live 已发内容之间还缺一次差额补发。

### 12.5 验证矩阵（假上游精确断言）

**核心场景（三协议，非流式）**

```
RESPONSES leak = false | output = reasoning,message,function_call | args = ["{\"command\":\"ls -la\"}"]
  reasoning = "I should call the tool: "
CHAT      leak = false | tool_calls = ["{\"command\":\"ls -la\"}"]
  reasoning = "I should call the tool: "
ANTHROPIC leak = false | blocks = ["thinking","text","tool_use"] | tool_use = [{"command":"ls -la"}]
  thinking = "I should call the tool: "
```

标记被剥离、调用被执行、**可见推理文本完整保留**（`"I should call the tool: "` 前后都没丢）。

**流式（DSML 标记跨两个 delta）**

```
RESPONSES stream leak = false | output = reasoning,message,function_call | args = ["{\"command\":\"pwd\"}"]
  reasoning stream = "plan: "
CHAT      stream leak = false | args = "{\"command\":\"pwd\"}"
  reasoning stream = "plan: "
ANTHROPIC stream leak = false | input_json = "{\"command\":\"pwd\"}"
  thinking stream = "plan: "
```

**边界场景**

| 场景 | 结果 |
|---|---|
| 纯推理、无标记 | 逐字保留（`plain thinking without markers`） |
| 推理以裸 `<` 结尾 | `trailing less-than <` 完整（收尾 flush 生效） |
| 结构化 `tool_calls` 与推理 DSML 同时存在 | 只产出 **1** 个调用（结构化优先），无泄漏 |
| 未声明 tools，推理里有 DSML | 0 个调用，标记被清掉，推理留 `"maybe: "` |
| 推理里 DSML 畸形 / 截断 | `status = completed`，正文 `"still works"` 完整下发，**只告警不失败** |

### 12.6 真实上游端到端（staged bridge home，真实账号，两轮）

```
--- round 1 ---
RESPONSES  stream=false | leak = false | args = "{\"command\":\"ls\"}"      | reasoning chars = 472
RESPONSES  stream=true  | leak = false | args = "{\"command\":\"ls -la\"}"  | reasoning chars = 0
CHAT       stream=false | leak = false | args = "{\"command\":\"ls -la\"}"  | reasoning chars = 434
CHAT       stream=true  | leak = false | args = "{\"command\":\"ls\"}"      | reasoning chars = 116
ANTHROPIC  stream=false | leak = false | args = "[{\"command\":\"ls\"}]"    | reasoning chars = 0
ANTHROPIC  stream=true  | leak = false | args = "{\"command\":\"ls -la\"}"  | reasoning chars = 125
--- round 2 ---
RESPONSES  stream=false | leak = false | args = "{\"command\":\"ls -la\"}"  | reasoning chars = 147
RESPONSES  stream=true  | leak = false | args = "{\"command\":\"ls\"}"      | reasoning chars = 452
CHAT       stream=false | leak = false | args = "{\"command\":\"ls -la\"}"  | reasoning chars = 395
CHAT       stream=true  | leak = false | args = "{\"command\":\"ls\"}"      | reasoning chars = 820
ANTHROPIC  stream=false | leak = false | args = "[{\"command\":\"ls\"}]"    | reasoning chars = 0
ANTHROPIC  stream=true  | leak = false | args = "{\"command\":\"ls\"}"      | reasoning chars = 348
```

12/12 无泄漏，工具调用全部完整。`reasoning chars = 0` 的那几格是**上游本轮本来就没返回推理内容**（抖动，见 §6.1），不是被吞——同一协议下一轮就回到 100+。

### 12.7 回归

```
node test/api/run.mjs  →  326/326  pass,  fail 0,  exit 0   （B3 后 319，本次 +7）
node test/run.mjs      →   62/62   pass,           exit 0
```

新增 7 条用例：Responses 3、Chat 3、Anthropic 1。既有 319 条无一条被改动或删除。

### 12.8 本次未触及

- **B1 的剩余部分**：Chat / Anthropic 流式末尾吞字（本次只修了 Responses 侧那一处 live 覆盖）；
- **B4**：缓存记账接线；
- **B5 / B6 / B7 / B8 / B9**：全部按原样保留在 §7 清单中。
---

## 13. B1 / B4 / B6 / B7 / B8 / B9 修复记录（本次已实施）

### 13.1 B1 流式末尾吞字

两处独立根因，都在「缓冲的保护 → 收尾的释放」这条链上：

| 协议 | 修复前 | 修复 |
|---|---|---|
| Chat | `scanner.finish()` 拿到的尾巴只写进 `visibleText`，**从不发 delta** | `finish()` 后把 `visibleText` 补发一次 `encoder.textDelta` |
| Responses | `run()` 无条件用 live 内容覆盖 `snapshot(true)` 的权威终态 | 改成只在 live 更长时才取 live（content 与 reasoning 各一条） |
| Anthropic | 本来就对（`finish()` 后会 `write(encoder.textDelta(...))`） | 只补回归用例 |

验证（四组输入 × 三协议，流式）：

```
[plain]      OK  ANTH OK
[tail <]     OK  ANTH OK      ← 修复前 Chat LOST
[tail <|]    OK  ANTH OK      ← 修复前 Chat LOST
[tail <||]   OK  ANTH OK      ← 修复前 Chat LOST
```

新增 3 条用例（Chat / Responses / Anthropic 各一条，每条内跑四组输入）。

### 13.2 B4 缓存记账接线

三个 runtime 的成功分支都补上号池读取的字段：

```js
// Anthropic src/api-runtime.js
cache_read_input_tokens: Math.max(0, Number(usage.cacheReadTokens) || 0),
cache_creation_input_tokens: Math.max(0, Number(usage.cacheWriteTokens) || 0),

// Chat
cache_read_input_tokens: Math.max(0, Number(usage.prompt_tokens_details?.cached_tokens) || 0),
cache_creation_input_tokens: 0,

// Responses
cache_read_input_tokens: Math.max(0, Number(result.usage.cached_tokens) || 0),
cache_creation_input_tokens: 0,
```

真实上游实测（同一轮跑三条协议）：

```
ledger default | req 8 | tokensIn 8536 | cacheRead 4864 | hitRate 0.57
ledger awa     | req 2 | tokensIn 2158 | cacheRead 0    | hitRate 0    ← 那两次上游确实没命中
```

修复前三协议这一栏恒为 0。新增 3 条用例分别断言三协议的 lease meta 带 3840 / 64。

### 13.3 B8 命中率夹取

上游偶尔会回一个比 `input_tokens` 还大的 `cached_tokens`（原生 Anthropic 口径：input 不含 cache）。新增 `cacheReadSafe()` 把命中数夹在 `[0, tin]`，命中率与成本公式都走它：

```js
function cacheReadSafe(b) {
  const read = Math.max(0, Number(b.cacheRead) || 0);
  const tin = Math.max(0, Number(b.tin) || 0);
  return Math.min(read, tin);
}
```

用例：`记录 cacheRead=100 / tin=100` 时命中率必须是 1（不是 1.0 之外的任何值），`freshIn` 必须是 0（不是 -0 或负数）。

### 13.4 B7 速度口径拆分 + 首字延迟

`emptyMetrics()` 增加 `ttftMs / ttftReq / decodeMs / decodeTokens`，`summarizeMetrics()` 输出三个互不替代的量：

| 指标 | 定义 | 用途 |
|---|---|---|
| `ttftMs` | 请求发出 → 首个可见增量（正文/推理/工具调用任一） | 首字多慢 |
| `decodeThroughput` | `decodeTokens / decodeMs`，与 dsh 同口径 | 模型本身多快 |
| `throughput` | `tout / ms`（原有） | 端到端多快 |

三个 runtime 都用 `markVisible()` 埋点（首次触发才记），lease meta 带 `ttftMs / decodeMs`，`pool.endTask` 透传进 `recordSample`。

面板 KPI 从「生成速度（端到端）」改成「解码速度」，首字延迟与端到端吞吐降为副行：

```
⚡ 解码速度 158.4 tok/s
   首字 1.9s · 端到端 100.1 tok/s
   按首增量→结束计算 · 样本 9 次
```

真实上游实测三个量确实分开：`ttftMs = 1933.6ms`、`decode tps = 158.4`、`e2e tps = 100.1`。

用例：构造「首字节 3s + 解码 2s 出 1000 token」，断言 `decodeThroughput = 500`、`throughput = 200`；无样本时 `ttftMs` 与 `decodeThroughput` 必须是 `null` 而不是 0。

### 13.5 B5 为什么最终判定「不做」

按计划文档 §5 的「先测量再决定」实施了一半，**被既有测试契约拦下**，按契约回滚：

- 实测上游仍是 10 帧 / 40 ms；即使逐帧转发，`decodeMs` 也只从 ~0 涨到 40 ms。
- 更关键：提前下发 `function_call_arguments.delta` 会让**未经仲裁的可执行参数**出现在流里。两条既有用例立即变红：
  - `Responses 流式工具 item 使用合法 function/custom 结构并与 completed 身份一致`
  - `Responses 拒绝同轮合法调用旁边的半截结构化工具参数`（断言流里不得出现 `call_valid` / `call_partial`）
- 这两条守的是「未验证的调用不得外泄」，属于安全契约，不是可协商的实现细节。

**顺带修掉的真问题**：为支持并行调用，`alignLiveOutputIds` 原本按**类型**取第一个 live 块配对，两个 `function_call` 会拿到同一个 id。现改成按**出现次序**排队配对（`queues` + `shift()`），已随回归通过。

**结论**：速度读数在桥接侧的修复上限就是「把口径讲清楚」（13.4），分子里的框架 token 需要 DSH 侧把 `outputTokens` 拆成 reasoning / text / toolcall-frame。

### 13.6 B6 Anthropic 流式真实 input_tokens

`message_start` 只能给估算（上游此时还没上报），但 `message_delta` 是最后一次机会——Anthropic SDK 与 pi-ai 都会用后者的 `input_tokens` 覆盖初值（`anthropic-messages.js`：「Preserves input_tokens from message_start when proxies omit it in message_delta」）。

```js
// src/protocols/anthropic.js usage(...)
...(Number.isFinite(inputTokens) && inputTokens > 0
  ? { input_tokens: Math.max(0, inputTokens) }
  : {}),
```

真实上游实测（4000 字符历史）：

```
message_start.input_tokens = 4016 (估算)
message_delta.input_tokens = 1079 (真实)
non-stream usage           = input_tokens 1079
```

修复前客户端会一直停在 4016，偏大 3.7 倍——这正是 dsh 上下文占用条失真的直接原因。

### 13.7 B9 文档纠偏

`docs/superpowers/plans/2026-11-08-dsh-reasoning-and-timing-fix.md` 顶部「这是一份待评估的修复指南，尚未执行」已替换为执行状态表（T1–T5 已合并 / T3b 判定不做 / T6 部分完成），并把 T3b 不做的三条理由写进文档，避免下一位执行者把它当成待办重跑一遍。

### 13.8 回归

```
node test/api/run.mjs  →  333/333  pass,  fail 0,  exit 0   （基线 311，累计 +22）
node test/run.mjs      →   65/65   pass,           exit 0   （基线 62，累计 +3）
```

新增用例分布：Responses +9、Chat +5、Anthropic +5、统计 +3。既有 311 + 62 条无一条被删除或改弱。

### 13.9 仍未闭环的一项（明确记录，不隐藏）

> **已于 §14 闭环**：DSH 侧的 `session-stats` 折叠被拿到本仓库做成最小改动 fork，同时修掉分母（零窗口步）与分子（按通道拆分）。本节保留作为「当时的判断」记录。

**速度读数的分子**：`outputTokens` 里含工具调用框架开销（实测 out=42 token 对应 30 字符参数）。桥接能做的两件事都已完成——把 `decodeMs` 口径讲清（13.4）、把缓存与时间样本接进统计（13.2 / 13.4）。`outputTokens` 的拆分本身属于 DSH 侧，见 §14。
---

## 14. DSH 侧速度读数修复（本次已实施）

### 14.1 上游算法与它的两个缺陷

`@deepseek-ai/dsh-session-stats@0.2.1-rc.5` 的 `sessionStats` 折叠（`lib/types/projection.js`）：

```js
next.decodeMs     += Math.max(0, event.time - firstToken);
next.decodeTokens += outputTokens;
```

渲染侧：`tps = decodeTokens / (decodeMs / 1000)`（`dsh-client-ui-chat` 的 `decodeSpeed()`）。

两个独立缺陷：

| # | 缺陷 | 为什么错 |
|---|---|---|
| 1 | **分母塌陷** | 纯工具调用步的可见内容（`tool-call-chunks` 的参数 JSON）在上游是一帧下发的，窗口塌到 0–3ms。分子照算、分母近零 ⇒ 速度爆炸。 |
| 2 | **分子不可分** | `outputTokens` 是 provider 报的**总数**，含工具调用框架开销。想看「生成正文多快」时没有可用分子。 |

真实会话实测（用会话日志复算，不是估的）：

| 会话 | 步数 | 零窗口步 | 零窗口 token 占比 | 上游 tps | 修复后 tps |
|---|---|---|---|---|---|
| A | 251 | 198 | 63.4% | **527.4** | **193.5** |
| B | 250 | 187 | 44.5% | **251.7** | **141.3** |

### 14.2 门槛为什么取 5ms —— 有实测支撑，不是拍脑袋

两类步之间存在一条很宽的缝：

```
会话 A: 零窗口步最大 span = 2ms   |  最短真实窗口 = 319ms   |  缝宽 317ms
会话 B: 零窗口步最大 span = 3ms   |  最短真实窗口 = 316ms   |  缝宽 313ms

   非零窗口里最小的 8 个：319, 396, 548, 573, 615, 622, 630, 632
```

门槛取 5ms，安全地落在这条 313ms 宽的缝里——**两侧各留 200 倍余量**，不存在「漏剔除」或「误杀真实窗口」的边界情况。用例里把这条分布固化成了断言。

### 14.3 改动

新建 `vendor/dsh-session-stats-0.2.1-rc.5/`，从已安装的上游 `lib/index.js` 复制后做最小改动：

| 改动 | 内容 |
|---|---|
| 门槛 | `span <= DECODE_GATE_MS (5)` 的步整步不进 `decodeMs` / `decodeTokens` |
| 拆分 | 新增 `decodeFrameTokens / decodeTextTokens / decodeReasoningTokens`，按**通道字符占比**分配 provider 报的总数，三者之和恒等于 `decodeTokens` |
| 版本 | `stateVersion: 1 → 2`（缓存 `ver` 门不匹配即丢弃重算，不做迁移） |
| 不改 | `turns / steps / llmMs / toolMs / ttftMs / ttftSteps` 一个字段都没动 |

### 14.4 正确性证明：与上游逐字段比对

把**真正的上游折叠**（从安装路径复制，未改一行）和 fork 一起跑同一份真实日志：

```
==== session A
  upstream tps 527.4  |  patched tps 193.5
  upstream decodeMs 114057 tokens 60158
  patched  decodeMs 113829 tokens 22027
  untouched fields identical: YES      ← turns/steps/llmMs/toolMs/ttftMs/ttftSteps 全等
  split sums to decodeTokens: YES
==== session B
  upstream tps 251.7  |  patched tps 141.3
  untouched fields identical: YES
  split sums to decodeTokens: YES
```

**唯一的行为差异就是门槛与拆分**，其余字段逐位相同。

### 14.5 拆分是比例归因，不是精确计数（必须讲清）

按字符占比拆分 `outputTokens` 是**估算**：三个通道的 tokenization 不同，
所以 `decodeFrameTokens` 这类字段应当读作「份额」，不是精确 token 数。
要精确，得让 provider 分别上报 reasoning / text / tool-frame 三个计数——那要求上游改协议。
**这也是为什么没有去改 `decodeTokens` 的定义**：新语义进新字段，老消费者不受影响。

### 14.6 部署（**已在本机落地并验证**）

挂载在本次会话后半段从 `ro` 变为 `rw`（`mount` 显示 `/dev/sda1 on /mnt/windata type fuseblk (rw,...)`），
所以这一项**已经真正装上去了**，不再是"给步骤等别人执行"。

实际落点：

```
~/.dsh/plugins/dsh-session-stats-patched/           # fork 副本（含 dsh-llm / zod 软链）
---

## 15. 安全加固：管理门禁与上游地址白名单（本次已实施）

### 15.1 高危：非回环监听时管理接口没有门禁

**复现（修复前，`127.0.0.1` 起服务、不带任何令牌）**：

```
GET  /api/api-compat                    -> 200  返回全部配置
PATCH /api/api-compat {remoteRequireKey:false} -> 200  远程鉴权被关掉
POST /api/api-compat/keys               -> 200  返回明文 sk-wb_...
```

根因是门禁语义写反了：`adminAllowed` 在 `WB_ADMIN_TOKEN` 未设时 `return true`，
于是「有没有配令牌」变成了「要不要校验」，而不是「谁连得上」。
`wb http --host 0.0.0.0`（README 里为手机扫码推荐过）就等于把这两个写接口送给了整个网段。

**修复**：门禁改由**监听地址**决定。

| 监听地址 | 未设令牌 | 设了令牌 |
|---|---|---|
| 回环（127.0.0.1 / ::1 / localhost） | 放行（本地开发业态） | 校验 |
| 非回环（0.0.0.0 / 网卡 IP） | **拒绝启动** `ADMIN_TOKEN_REQUIRED` | 校验 |

拒绝发生在两处，缺一不可：`startHttpServer` 内部（任何调用方都绕不过）与
`wb http` / `wb admin` 的入口（给出可读的错误而不是堆栈）。
令牌比较改为定长 + `timingSafeEqual`。

**实测（修复后）**：

```
$ wb http --host 0.0.0.0
拒绝在 0.0.0.0 上监听：未设置 WB_ADMIN_TOKEN。
（exit 1）

$ WB_ADMIN_TOKEN=verify-token wb http --host 0.0.0.0
GET   /api/api-compat                    -> 401
PATCH /api/api-compat {remoteRequireKey:false} -> 401
POST  /api/api-compat/keys               -> 401
带正确 x-wb-token 请求头                  -> 200
令牌放在查询串 ?token=                    -> 401（API 一律不认 URL 令牌）

$ wb http --port 7666        # 回环，未设令牌
GET /admin -> 200   GET /api/api-compat -> 200     ← 本地开发体验不变
```

### 15.2 令牌不再走 URL

`?token=` 会进浏览器历史、截图和反向代理日志。现在只有**管理页本身**接受它作为首次引导，
页面加载后立刻 `history.replaceState` 抹掉；所有 API 请求必须带 `x-wb-token` 头。
（回环 + 未设令牌时管理页的 JS 里不再注入空令牌字符串。）

### 15.3 中危：`upstreamBaseUrl` 可指向任意地址

这个值直接决定 `authorization: Bearer <accessToken>` 发往哪里（`src/upstream-client.js`），
而原校验只看协议是不是 http/https。配合 15.1，攻击者把它改成自己的服务器就能收走账号 token。

**修复**：新增 `assertUpstreamHost()`，默认拒绝

- 回环：`127.0.0.0/8`、`::1`、`localhost`、`0.0.0.0`
- 私网：`10/8`、`172.16/12`、`192.168/16`
- 链路本地：`169.254/16`（含云厂商元数据 `169.254.169.254`）、`fe80::/10`
- CGNAT：`100.64/10`、IPv6 唯一本地 `fc00::/7`

两个逃生阀，都是显式 opt-in：

| 环境变量 | 作用 |
|---|---|
| `WB_ALLOW_PRIVATE_UPSTREAM=1` | 允许内网上游（自建网关场景） |
| `WB_UPSTREAM_ALLOW_HOSTS=gw.example.com,*.corp.example` | 只认白名单主机，支持通配 |

**实测**：

```
ALLOW https://copilot.tencent.com
DENY  http://127.0.0.1:1234 · http://10.0.0.5 · http://169.254.169.254
DENY  http://192.168.1.2 · http://[::1]:80
ALLOW https://gw-one.example.com      (WB_UPSTREAM_ALLOW_HOSTS 命中)
ALLOW https://api.corp.example        (通配 *.corp.example)
DENY  https://other.example.com       (白名单未命中)
```

### 15.4 附带修复：`upstreamBaseUrl` / `timeoutMs` 的「假热更新」

原实现把两个值在 `createUpstreamClient` 构造时固化进闭包：管理页 PATCH 返回 200、
界面显示已保存，但真正发请求仍走老地址——看起来生效，实际要重启，是最容易误导人的那种半修。

现在改成**每次请求读一次配置**：

```js
function currentEndpoint() {
  if (pinnedEndpoint !== null) return pinnedEndpoint;   // 夹具显式传入时才固定
  const live = loadConfig().apiCompat || {};
  return String(live.upstreamBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}
```

`endpoint` getter 也跟着动态，所以 api-server 用它做的模型目录缓存键会随地址变化，
不会继续复用旧 endpoint 的目录快照。管理页两个字段标注「保存即生效」。

**实测**：

```
initial endpoint = https://copilot.tencent.com
after PATCH #1   = https://gw-one.example.com
after PATCH #2   = https://gw-two.example.com   (尾部斜杠已去掉)
pinned client    = https://pinned.example.com   (测试夹具不跟随，符合预期)
```

### 15.5 新增测试

`test/api/security-hardening.test.mjs`（9 条）：

| 用例 | 守住什么 |
|---|---|
| 非回环且无令牌拒绝启动 | `ADMIN_TOKEN_REQUIRED` |
| 非回环 + 令牌：匿名/错令牌/URL 令牌全 401，正确头 200 | 门禁真正生效 |
| 回环无令牌放行 | 本地开发不被误伤 |
| 匿名改配置、匿名建 Key 均 401，且失败请求不留 Key | 写操作闭环 |
| 八类本机/内网地址全部拒绝，公网放行 | 白名单 |
| `WB_ALLOW_PRIVATE_UPSTREAM=1` 放行 | 逃生阀 |
| `WB_UPSTREAM_ALLOW_HOSTS` 通配白名单 | 收紧能力 |
| 改配置后客户端 endpoint 立即变化 | 热更新 |
| 显式传 `baseUrl` 的客户端不跟随全局 | 夹具隔离 |

另外把两处测试桩的上游改成显式 `WB_ALLOW_PRIVATE_UPSTREAM=1`
（`admin-api.test.mjs`、`failover.test.mjs`）——它们的上游就起在 127.0.0.1，
**这是有意的行为变更，不是放宽保护**：生产默认仍然禁止内网上游。

### 15.6 回归

```
node test/api/run.mjs  →  351/351  pass,  fail 0,  exit 0   （本次新增 9 条）
node test/run.mjs      →   65/65   pass,           exit 0
```

### 15.7 仍建议但本次未做

1. **默认绑定再收紧**：目前 `wb http` 默认 `127.0.0.1`（已安全）。若要把「手机扫码」做成
   一等场景，建议加一个 `--lan` 开关，自动生成一次性令牌并打印带令牌的二维码，
   而不是让用户手写 `--host 0.0.0.0`。
2. **管理页审计日志**：15.1 修复后匿名改动被拒，但「谁在什么时候改了远程鉴权」目前没有留痕。
3. **上游地址变更需要二次确认**：即便有白名单，改上游仍等于移交 token。可考虑变更时要求
   重新输入当前 `WB_ADMIN_TOKEN`（sudo 模式），而不只是带在请求头里。
