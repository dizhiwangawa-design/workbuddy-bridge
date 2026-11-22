# dsh-session-stats 速度读数修复（fork）

本目录是 `@deepseek-ai/dsh-session-stats@0.2.1-rc.5` 的**最小改动 fork**，只解决一件事：
DeepSeek Harness 显示的 `tok/s` 虚高。

## 问题

上游算法（`lib/types/projection.js` 的 `assistant/message` 分支）：

```js
next.decodeMs    += Math.max(0, event.time - firstToken);
next.decodeTokens += outputTokens;
```

渲染侧：`tps = decodeTokens / (decodeMs / 1000)`。

纯工具调用步的可见内容（`tool-call-chunks` 的参数 JSON）在上游是一帧下发的，
于是 `event.time - firstToken` 塌到 0–5ms，而这一步的 `outputTokens` 往往有几十到上百。
分子照算、分母归零 ⇒ 读数虚高。

用两个真实会话复算（脚本见 `test/api/dsh-stats-patch.test.mjs` 的思路）：

| 会话 | 步数 | outputTokens | 上游 tps | 零窗口 token 占比 |
|---|---|---|---|---|
| A | 251 | 60,158 | **527.4** | 63.4% |
| B | 250 | 106,179 | **251.7** | 44.7% |

## 改了什么

只动两处，**既有字段名与语义全部保留**：

1. **门槛**：解码窗口 `span <= DECODE_GATE_MS`（5ms）的步整步不进 `decodeMs` / `decodeTokens`。
   这类步没有可观测的生成时间，把它算作 0ms 就等于让分母归零。
2. **拆分**：新增三个字段，把 provider 报的 output token 按**通道字符占比**分配：

   | 字段 | 含义 |
   |---|---|
   | `decodeFrameTokens` | 工具调用框架（参数 JSON）占的 token |
   | `decodeTextTokens` | 可见正文占的 token |
   | `decodeReasoningTokens` | 推理正文占的 token |

   三者之和恒等于 `decodeTokens`。

`turns` / `steps` / `llmMs` / `toolMs` / `ttftMs` / `ttftSteps` **一个都没改**，
`stateVersion` 从 1 提到 2 以便缓存行整批重算而不是混读。

## 效果（同一批真实会话）

```
会话 A  上游 527.4 tok/s  →  修复后 193.5 tok/s（全部输出）/ 69.4（仅答案）
会话 B  上游 251.7 tok/s  →  修复后 141.3 tok/s（全部输出）/ 91.7（仅答案）
```

**这只修复了分母与口径，不是性能提升**。剩下的差距是真实的：
纯工具调用步本来就不产生可见文本，把它排除后速度反映的是「有正文/推理的那些步」。

## 估算的性质（重要，别当成精确值）

拆分是**字符占比**估算，不是真 tokenizer。三个通道的 tokenization 不同，
所以 `decodeFrameTokens` 这类字段应当读作**比例归因**，不是精确计数。
要精确，需要 provider 分别报 reasoning / text / tool-frame 三个计数——那要求上游改协议。

## 部署（已在本机落地，可直接照抄）

本机实际位置：

```
~/.dsh/plugins/dsh-session-stats-patched/          # 本 fork 的副本
~/.dsh/profiles/web/node_modules/dsh-session-stats-patched -> 上面那个目录
```

1. 拷目录：
   ```bash
   cp -r vendor/dsh-session-stats-0.2.1-rc.5 ~/.dsh/plugins/dsh-session-stats-patched
   ```
2. 重建依赖软链（本机已建，换机器按实际路径改）：
   ```bash
   cd ~/.dsh/plugins/dsh-session-stats-patched
   ln -sfn <dsh-llm 安装路径> node_modules/@deepseek-ai/dsh-llm
   ln -sfn <zod 安装路径>     node_modules/zod
   ```
3. 链进 profile（loader 从 profile 目录解析插件名）：
   ```bash
   ln -sfn ~/.dsh/plugins/dsh-session-stats-patched \
           ~/.dsh/profiles/<profile>/node_modules/dsh-session-stats-patched
   ```
4. 改 `cordis.patch.yml` —— **必须禁用 + insert，不能只改 name**（见 `OVERLAY-example.yml` 里的原因）：

   ```yaml
   - id: session-stats
     disabled: true
   - insert:
       - id: session-stats-patched
         name: 'dsh-session-stats-patched'
   ```
5. 重启 dsh 会话。`stateVersion` 变了，历史会话的投影会整批重算（一次性开销，之后走缓存）。

验证配置被接受（应看到 `disabled: true` 与新的 `session-stats-patched` 两行，且没有 name mismatch 警告）：

```bash
dsh --profile web --dump-config 2>&1 | grep -n 'session-stats' -A1
```

## 回滚

删掉 `cordis.patch.yml` 里那两段（`disabled: true` 与 `insert`）并重启即可回到上游行为；
缓存行因为 `ver` 不匹配会自动丢弃重算，无需手工清理。

## 验证

```bash
node --test test/api/dsh-stats-patch.test.mjs     # 9 条：门槛、拆分、既有字段不变、分布缝
```

对真实会话日志复算（把部署副本直接折叠，验证装上去的那份就是修好的那份）：

```bash
node --input-type=module -e "
const { execFileSync } = await import('node:child_process');
const d = (await import(process.env.HOME + '/.dsh/plugins/dsh-session-stats-patched/index.js'))
  .sessionStatsProjectionDefinition;
const raw = execFileSync('zstd', ['-dc', process.argv[1]], { encoding: 'utf8' });
let s = d.init();
for (const line of raw.split('\n')) if (line) s = d.apply(s, JSON.parse(line));
const v = d.wire.viewSchema.parse(d.wire.view(s));
console.log('tps', (v.decodeTokens / (v.decodeMs / 1000)).toFixed(1),
            '| split', Math.round(v.decodeFrameTokens), Math.round(v.decodeTextTokens), Math.round(v.decodeReasoningTokens));
" ~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd
```

本机两个真实会话的结果：

```
A: decodeMs 113829 tokens 22027 tps 193.5 | 拆分 frame 14128 text 2743  reasoning 5156
B: decodeMs 421563 tokens 59550 tps 141.3 | 拆分 frame 20891 text 7602  reasoning 31057
```
