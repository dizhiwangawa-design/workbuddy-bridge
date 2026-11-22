# 思维链泄漏与 codex 提前收尾：根因分析与修复

- 触发版本：`5157f0b fix: stop dropping reasoning history and misfiling the continuation nudge`
- 受影响客户端：codex（Responses 协议）。dsh 只受「提前收尾」一项的轻微影响
- 结论：两个现象都源自同一次提交里的两处「想当然」改动，**已全部回改**

---

## 1. 思维链泄漏：`<prior_reasoning>` 是我上一轮凭空发明的标记

### 1.1 现象

codex 的可见输出里出现：

```
<prior_reasoning>We need continue, no final until complete. Need implement rest.
First normalize QQ lyric first line "阔天空 - BEYOND" — likely parser bug: ...
```

这是模型的**内部推理原文**，被包在我造的标签里，显示给了用户。

### 1.2 根因：把推理塞进了模型可以模仿的正文频道

上游（codebuddy）只有 Chat Completions 那一个通道，没有原生 reasoning 通道。我为了
「别让模型忘记上一轮想过什么」，把推理历史折成 assistant 正文消息：

```js
// src/protocols/responses.js — replayHistory（已回改）
messages.push({
  role: 'assistant',
  content: `<prior_reasoning>${clipped}</prior_reasoning>`,
});
```

```js
// src/protocols/anthropic.js — normalizeMessages（已回改）
texts.push(`<prior_reasoning>${block.thinking}</prior_reasoning>`);
```

两条路径都把「模型的思考」写进了 **assistant 的 content**。对模型来说，这条消息读起来
就是「我上一轮说过这句话」。于是它按同样的格式继续说话 —— 把自己的推理写进正文，并且
沿用 `<prior_reasoning>` 这个格式。**是我给了它一个可以照抄的模板。**

实测证据（两条注入路径都指向同一形状）：

```
客户端回传 → 上游收到的 messages:
[{"role":"assistant","content":"<prior_reasoning>首行少一个字</prior_reasoning>"},
 {"role":"user","content":"继续"}]

Anthropic 历史 thinking → 上游收到:
{"role":"assistant","content":"<prior_reasoning>首行少一个字</prior_reasoning>\n改好了"}
```

改动前推理是**整条丢弃**的，这个字符串在系统里任何位置都不可能存在（`grep` 全仓可验），
所以泄漏 100% 是这次改动引入的。

### 1.3 为什么我的测试没拦住

我做过的验证是「历史里放一条带标签的 assistant 消息，看模型下一轮会不会复读标签」，
3 次采样全为 0/3，于是判定安全。这个实验设计有两个漏洞：

1. **样本太短**：泄漏需要多轮累积，标签在历史里反复出现才会变成「我的说话习惯」。
   单条注入不足以让模型定型。
2. **只测了「复读」没测「格式继承」**：我断言的是 `text.includes('prior_reasoning')`，
   而真正发生的是模型把推理写进正文——哪怕它不写标签，正文里出现推理原文本身
   就已经是泄漏。

**教训：不要在模型能模仿的频道里发明标记。**「让模型记得想过什么」的收益，远小于
「推理原文进了用户可见输出」的代价。

### 1.4 修复

两条注入路径全部回改为丢弃：

```js
// responses.js
if (type === 'reasoning') continue;

// anthropic.js
if (block?.type === 'thinking' || block?.type === 'redacted_thinking') continue;
```

保留的部分：`historyForResponse` 仍然保留 `reasoning.summary` 文本（只换 item id），
因为那条路径只是把记录喂给 `GET /v1/responses/:id` 与回放，**不进入上游 messages**，
不会成为模型可模仿的模板。

---

## 2. codex 提前收尾：约束位置 + 生效判定双双失手

### 2.1 现象

codex 在「发出工具调用之后」或「报告了一句进度之后」不再继续任务，把控制权交回用户；
dsh 正常。

### 2.2 根因一：约束被挪到了 tool 结果之后

上一轮我把约束从「最后一条 user 消息之后」改到了「messages 整串末尾」，理由是「真实请求
尾部是工具往返」。真实 codex 请求形状（实测）：

```
msg:developer, msg:user, msg:user, function_call, function_call_output
```

所以末尾追加后，消息序列变成 `… function_call_output, system`。**system 直接跟在 tool
结果后面**，模型很容易把这条指令读成「新一轮对话的开头」，于是它回答这条指令（写一句
「我会继续…」），而不是继续工具循环。codex 判定「本轮无工具调用 = 任务结束」，收尾。

dsh 没那么容易触发，因为它的 harness 有 goal 级别的续跑判断，不只看单轮有没有工具调用。

### 2.3 根因二：`auto` 判定太严，首轮根本没注入

我把 `continuationNudge: true` 的语义改成 `auto`：只有确认是编码 Agent 或历史里已有
工具往返才注入。实测判定矩阵：

| 请求特征 | 识别结果 | 首轮是否注入 |
| --- | --- | --- |
| `originator: codex_exec` | codex | 是 |
| 只有 `user-agent: codex_exec/0.160.0` | **null** | **否** |
| codex 桌面/IDE 变体（无 `originator`） | **null** | **否** |
| 未知 UA | null | 否 |

codex 的 CLI 会发 `originator`，但不是所有 codex 前端都发。识别失败 + 首轮没有工具
历史（`input` 只有 `developer`/`user`）⇒ **约束完全不注入** ⇒ 「说一句就收工」的老 bug
原样复发。dsh 一直发 `user-agent: pi (…)`，所以识别得中，没受影响。

**这解释了为什么「dsh 没问题」**：不是 dsh 更健壮，而是它的识别线索没被漏掉。

### 2.4 修复

1. **位置回退**到「最后一条 user 之后」（长期验证过的位置）。
2. **识别放宽**（漏判代价远大于误判，误判只是多一段 system 文本）：
   - `originator` 以 `codex` 开头
   - `user-agent` 含 `codex`（不再要求开头）
   - `user-agent` 以 `pi` 开头 ⇒ dsh
   - `x-codex-turn-metadata` / `x-codex-window-id` / `client_metadata` 里的 `x-codex*`
3. **协议兜底**：`/v1/responses` + 带工具 ⇒ 直接注入。Responses 协议基本只有编码 Agent
   在用（codex 的 `wire_api`、dsh 的 `api: openai-responses`），这条能把「首轮 + 头识别
   失败」的漏网情况全部兜住。

### 2.5 附带保留的加固

- `tool_choice: "none"` 仍然不注入（客户端明确说这次别用工具，约束不该硬顶）。
- 规则 2 保留新写法：允许一两句话说明进度，只禁止「只写计划不调用工具」。这条是用户
  明确要求的（旧写法让过程完全不可见）；实测 codex 接受「说明 + 工具调用」同轮，
  不会因此提前收尾 —— 提前收尾的真因是上面两条，不是这条。

---

## 3. 回归覆盖

| 用例 | 断言 |
| --- | --- |
| `anthropic.test.mjs`「历史回放忽略 thinking 块」 | thinking/redacted_thinking 都不进 messages |
| `anthropic.test.mjs`「请求转换支持 tools…」 | 约束落在 user 之后（`messages[2]`），assistant/tool 仍相邻 |
| `responses.test.mjs`「历史 reasoning 不进上游 messages，且不泄漏成可见文本」 | `messages` 里既没有 assistant 前缀，也不含推理原文 |
| `continuation-nudge.test.mjs`「约束不落在 tool 结果之后」 | 位置为最后一条 user 之后，末尾不是 system |
| `continuation-nudge.test.mjs`「auto 模式…」 | codex/pi 头命中；Responses 协议兜底 |
| `openai.test.mjs`「SSE 流式…多轮工具」 | 末尾仍是 tool 结果，约束只注入一次 |

`node test/run.mjs` = 73 通过 / 0 失败；`node test/api/run.mjs` = 25 文件 / 388 用例 /
0 失败。

---

## 4. 一句话总结

`<prior_reasoning>` 是我为了「保住推理连续性」发明的新标记，而它必须经过模型的正文
频道 —— 那条频道里的任何格式，模型都会当成自己的说话方式来继承。这属于**用新增标记
去修一个本来就该保守处理的通道**，收益与风险不成比例，已整体回退。

提前收尾则是**改了约束的位置与生效条件**却没在真实客户端上重新验证「首轮是否注入」
导致的：单测只测得到「注入了对不对」，测不到「根本没注入」。
