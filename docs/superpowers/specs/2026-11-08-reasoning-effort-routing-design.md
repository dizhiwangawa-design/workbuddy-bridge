# WorkBuddy Bridge 推理档位映射与转换设计

**日期：** 2026-11-08

**目标：** 让 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages
共享一套按目标模型能力归一化的推理档位转换，正确控制思考程度，并如实回显转发
档位、reasoning token 和截断状态。

**交付拆分：**

- PR1：档位归一化、目录缓存、OpenAI Chat/Responses 注入与观测。
- PR2：Anthropic thinking 请求映射、thinking 内容块和事件序列。

两个 PR 共用 PR1 建立的档位模块和目录缓存。PR2 不重新实现第二套映射表。

## 背景与事实来源

本设计依据用户提供的以下实测材料：

- `docs/reasoning-effort-guide.md`
- `scripts/dump-model-efforts.py`
- `scripts/probe-upstream.py`

上游模型目录是档位能力的权威来源。目录中同时存在
`reasoning.supportedEfforts`、单值 `reasoning.effort` 和完全没有
`reasoning` 对象三种声明形态。支持集合至少包含以下五种：

- `low|high|max`
- `low|medium|high|xhigh|max`
- `low|high`
- `low|medium|high`
- 单档 `high`

因此不能使用一张全局三档表。档位归一化必须发生在选定目标账号和目标模型之后。

## 当前实现缺口

1. Responses 请求没有读取 `reasoning.effort`，也没有向上游发送
   `reasoning_effort`。
2. Responses 的 `reasoning.effort` 固定返回 `null`，没有回显实际转发值。
3. Anthropic 将整个 `thinking` 字段作为不支持能力返回 400。
4. Anthropic 丢弃上游 `reasoning_content`，没有 thinking 内容块或 reasoning
   token 明细。
5. Chat Completions 原样透传 `reasoning_effort`，没有按模型归一化。
6. 模型目录映射只保留展示字段，丢弃 reasoning 声明；目录查询没有缓存。

Responses 的 `length -> incomplete` 和 Anthropic 的
`length -> max_tokens` 已经符合要求，本次保持现有行为。

## 架构

新增两个职责单一的模块：

### `src/reasoning-effort.js`

负责所有纯转换逻辑，不访问网络：

- 校验公开档位名。
- 将 `minimal` 归为 `low`。
- 在目标模型支持集合内选择最近档位，优先向上取。
- 处理 `none`、无 reasoning 声明和单值声明。
- 将 Anthropic `budget_tokens` 分桶为 `low`、`high` 或 `max`。

公开档位按不区分大小写处理。可识别的 Responses/Chat 输入为：

`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。

`none` 是三条协议共用的显式关闭值。未知非空字符串返回 400，不静默转换为
关闭。

### `src/reasoning-catalogue.js`

负责账号维度的目录缓存和查询：

- 使用 `endpoint + account UID` 作为缓存分区，避免跨账号或跨上游地址复用档位表。
- 缓存上游模型目录 10 分钟。
- 请求路径只读缓存；缓存不存在时使用保守回退。
- 目录刷新成功后原子替换快照；失败时保留旧快照。
- 支持强制刷新。
- 解析 `supportedEfforts`、单值 `reasoning.effort` 和无 reasoning 对象三种声明。
- 同一份快照同时服务 `/v1/models` 展示和请求档位归一化。

请求路径不得同步调用上游模型目录。这里不使用账号名作为唯一键，因为同一账号的
UID 才能稳定标识目录归属；同一 UID 在不同 endpoint 下的目录也必须隔离。

模型列表的公开行应携带规范化的 reasoning 声明，使调用方、调试信息和档位解析
读取同一事实来源。该扩展字段不作为替换现有 OpenAI model 字段的依据。

`GET /v1/models?refresh=true` 和
`GET /v1/models/:id?refresh=true` 强制刷新目录。

## 档位解析规则

排序阶梯为：

```text
low < medium < high < xhigh < max
```

归一化规则：

| 输入或声明 | 转发结果 |
| --- | --- |
| 目标档位在 `supportedEfforts` 内 | 原样转发 |
| `minimal` | 按 `low` 在支持集合内定位 |
| 目标档位介于两个支持档位之间 | 向上取最近档位 |
| 目标档位高于模型最高档 | 取模型最高档 |
| 单值 `reasoning.effort` 声明 | 任意非关闭档位归一化为声明的单值 |
| 无 `reasoning` 对象 | 不发送 `reasoning_effort` |
| 请求档位缺失 | 显式转发 `none` |
| 未知档位字符串 | 返回 400 `invalid_request_error` |

单值声明表示“无粗细可调”，不是“默认为 high”。例如声明
`reasoning.effort: "medium"` 的模型，对 `low`、`high`、`max` 等输入都转发
`medium`。现有实测只证明单值模型的档位响应方差很大，没有证据证明声明的值比
其他值更差，因此不能覆盖上游声明。

缓存缺失时的保守回退：

- `glm-*`、`kimi-*`、`deepseek-*` 使用 `low|high|max`。
- 其他模型使用公共子集 `low|high`。
- 目录明确声明无 reasoning 对象时始终优先使用该声明，不发送字段。

## 各协议行为

### OpenAI Responses

输入：

```json
{
  "reasoning": {
    "effort": "medium"
  }
}
```

- 读取并校验 `reasoning.effort`。
- 在选定账号后把归一化结果写入上游 `reasoning_effort`。
- 对外仍保持客户端未请求输出上限时的 `max_output_tokens: null` 语义。
- 响应中的 `reasoning.effort` 返回实际转发值。
- reasoning token 继续映射到
  `usage.output_tokens_details.reasoning_tokens`。

### OpenAI Chat Completions

- 接受并校验顶层 `reasoning_effort`。
- 与 Responses 复用同一归一化函数。
- 以解析后的模型声明覆盖客户端原值后再发往上游。
- 输出 usage 保留
  `completion_tokens_details.reasoning_tokens`。

### Anthropic Messages

请求映射：

| `thinking` | 转发档位 |
| --- | --- |
| 缺失 | `none` |
| `type: disabled` | `none` |
| `type: enabled`，预算 `< 4096` | `low` |
| `type: enabled`，预算 `4096..16383` | `high` |
| `type: enabled`，预算 `>= 16384` | `max` |

预算分桶结果仍必须经过目标模型的档位集合归一化。`thinking.type` 缺失但
`thinking` 对象存在时，沿用 Anthropic 兼容语义按 `enabled` 处理。

响应映射：

- 启用 thinking 时，把上游 `reasoning_content` 转为 Anthropic `thinking`
  内容块；流式使用 `thinking_delta`。
- 禁用 thinking 时不输出 thinking 内容块。
- 非流式 usage 和流式 `message_delta.usage` 增加
  `output_tokens_details.reasoning_tokens`。
- 上游没有可验证的 thinking signature，不伪造签名；输出空签名字段，历史回放时
  忽略 thinking 块。
- `none` 后上游仍返回非空 `reasoning_content` 时，不把内容泄漏给禁用了 thinking
  的客户端，但记录不含正文的 warning，并按上游可用值如实上报 reasoning token。

## 输出预算与截断

- 不把缺失输出预算统一补成 8192。OpenAI 协议中缺省表示由服务端决定；强制 8192
  会把该语义变成新的硬上限，可能截断长输出。
- Responses 和 Chat Completions 在客户端未指定输出上限时继续省略上游
  `max_tokens`。
- Anthropic 继续要求正整数 `max_tokens`。
- Responses 的 `length` 保持映射为 `incomplete`，原因优先为
  `max_output_tokens`，否则为 `upstream_length_limit`。
- Anthropic 的 `length` 保持映射为 `max_tokens`。

如果未来需要默认输出预算，应通过显式配置或按模型能力配置启用，不能把它作为
全局隐式行为。

## 账号与缓存失效

缓存键至少包含 endpoint、账号 UID 和模型 ID。以下情况不会误用其他目录的声明：

- 号池切换账号。
- 同一账号切换到不同 upstream endpoint。
- 同一账号刷新 access token 后继续使用同一 UID。
- 新增账号首次请求尚无缓存。

账号被删除后，其缓存条目可以自然过期；无需在请求路径等待清理。目录刷新失败时
保留旧快照，不使用空目录覆盖有效缓存。

## 错误处理

- Responses/Chat 的未知档位返回协议对应的 400。
- Anthropic 未知 `thinking.type` 返回 400。
- Anthropic `budget_tokens` 必须是非负整数；非法值返回 400。
- 目录不可用不是请求失败条件，除非模型明确要求无法回退的能力。
- 上游 5xx 不使已有档位缓存失效。
- `canDisableThinking` 不参与注入判断；无论其值为何都先发送客户端要求的
  `none`。部分模型仍可能继续思考，因此响应阶段必须观察实际 reasoning 内容。

## 测试策略

纯函数测试覆盖：

- 五档模型保留 `medium` 和 `xhigh`。
- 三档模型把 `medium` 向上映射到 `high`。
- 两档模型的 `xhigh` 降到最高支持档 `high`。
- 单值 `reasoning.effort` 模型把任何非关闭输入映射为目录声明值。
- `minimal` 映射到 `low`。
- 无 reasoning 对象不注入字段。
- 未知档位返回 400。
- Anthropic 三档预算分桶和再次归一化。

协议测试覆盖：

- Responses 请求注入和回显实际档位。
- Chat 请求归一化及 reasoning token 透出。
- Anthropic thinking 禁用、启用、流式和非流式内容块。
- Responses/Anthropic 截断原因不回退为 completed。

- Responses/Chat 未提供输出上限时上游不出现人工补写的 `max_tokens`。
- 上游返回 `length` 时，客户端仍能收到明确的截断状态。

思考发生判据必须取两个独立信号：

```text
thinkingHappened = reasoningTokens > 0 || reasoningContent.length > 0
```

流式和非流式验收都使用该并集。只检查 `reasoningTokens` 会把
`reasoning_tokens = 0` 但仍返回 `reasoning_content` 的模型误判为链路失效。

禁用 thinking 的 Anthropic 测试还需覆盖：

- 上游仍有 `reasoning_content` 时不返回 thinking 块。
- 服务端记录不含正文的 warning。
- 上游明确报告的 reasoning token 不被抹成 0。

目录测试覆盖：

- 相同账号和模型在 TTL 内只加载一次。
- `refresh=true` 强制重新加载。
- 不同 UID 不会共享声明。
- 相同 UID、不同 endpoint 不会共享声明。
- 刷新失败保留旧快照。
- 模型列表和档位解析使用同一快照中的 reasoning 声明。

实现完成后运行相关 API 测试文件，并运行 `npm test`。当前基线中与本功能无关的
`ERR_WORKER_INVALID_EXEC_ARGV` 和取消持久化失败必须单独记录，不能当作本次功能
通过或失败的依据。

## 许可证边界

参考仓库是 GPL-3.0-or-later，bridge 是 MIT。本功能只采用实测行为、协议字段和
公开事实，不复制参考仓库的 Rust 源码；新增 JavaScript 代码按 bridge 现有结构
独立实现。

## 交付边界

### PR1

- 新增档位纯转换模块。
- 新增 endpoint + UID 目录缓存，并让模型列表与档位解析共用快照。
- Responses/Chat 注入、回显和 reasoning token 透出。
- 单值声明沿用目录值。
- 不修改 Anthropic thinking。

### PR2

- 解析 Anthropic `thinking` 并映射预算。
- 输出 thinking 内容块、流式 thinking 事件和 reasoning token 明细。
- 对 `none` 后仍出现的 reasoning 内容记录安全 warning。

PR1 合并并通过测试后才能开始 PR2。
