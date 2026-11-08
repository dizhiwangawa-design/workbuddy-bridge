# Anthropic Thinking Support PR2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support Anthropic `thinking` requests and responses on top of the reasoning-effort routing and catalogue delivered by PR1.

**Architecture:** Anthropic input budgets are converted to a named effort, then normalized after account selection through the shared PR1 catalogue. The Anthropic encoder emits thinking blocks and reasoning-token usage; disabled thinking never exposes reasoning text but records a content-free warning if the upstream still thinks.

**Tech Stack:** Node.js `>=22.13`, native ESM, `node:test`, existing Anthropic SSE encoder and bridge runtimes; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-08-reasoning-effort-routing-design.md`

**Prerequisite:** `docs/superpowers/plans/2026-11-08-reasoning-effort-pr1.md` is complete and merged.

## Global Constraints

- API acceptance is `npm run test:api`; it must exit 0.
- Do not create a second effort ladder or catalogue.
- `thinking.type` is required and must be `enabled` or `disabled`.
- `thinking: {}` and unknown types return HTTP 400.
- Missing `thinking` or `type: disabled` forwards `none`.
- Budget mapping is `<4096 -> low`, `4096..16383 -> high`, `>=16384 -> max`.
- The budget-derived effort is normalized again against the selected model.
- Enabled thinking emits Anthropic `thinking` blocks from upstream `reasoning_content`.
- Disabled thinking emits no reasoning text.
- A model that still returns reasoning while disabled produces a warning without
  logging reasoning text, prompt text, tokens, or credentials.
- Thinking-token verification uses
  `reasoningTokens > 0 || reasoningContent.length > 0`.
- Upstream has no verifiable thinking signature; emit an empty signature and do not
  pretend it is cryptographically valid.
- History replay ignores assistant thinking/redacted-thinking blocks.
- No universal `max_tokens` default is added.
- Commit after every task.

## File Structure

- `src/protocols/anthropic.js`: strict request mapping, historical thinking filtering, thinking encoder.
- `src/api-runtime.js`: per-account effort application, reasoning capture, warning, usage.
- `test/api/anthropic.test.mjs`: pure request and encoder tests.
- `test/api/anthropic-http.test.mjs`: stream/non-stream integration and warning tests.
- `CHANGELOG.md`: Anthropic thinking support and disabled-fallback caveat.
- `README.md`: supported thinking request/response behavior and limitations.

---

### Task 1: Strict Anthropic Thinking Request Conversion

**Files:**
- Modify: `src/protocols/anthropic.js`
- Modify: `test/api/anthropic.test.mjs`

**Interfaces:**
- Consumes:
  - `budgetEffort(thinking)` from `src/reasoning-effort.js`.
  - `resolveReasoningEffort(requested, declaration)` after PR1.
- Produces:
  - `normalizeAnthropicRequest()` result gains:
    - `requestedEffort: string | null`
    - `thinkingEnabled: boolean`
  - `anthropicToOpenAI()` returns those values through `normalized`.

- [ ] **Step 1: Write failing request-conversion tests**

Replace the existing “thinking unsupported” assertion with:

```js
test('Anthropic thinking 预算映射为具名档位', () => {
  const base = {
    model: 'deepseek-v4.1-flash',
    max_tokens: 2048,
    messages: [{ role: 'user', content: 'hello' }],
  };
  for (const [thinking, effort, enabled] of [
    [{ type: 'enabled', budget_tokens: 1024 }, 'low', true],
    [{ type: 'enabled', budget_tokens: 8000 }, 'high', true],
    [{ type: 'enabled', budget_tokens: 32000 }, 'max', true],
    [{ type: 'disabled' }, 'none', false],
  ]) {
    const normalized = normalizeAnthropicRequest({ ...base, thinking });
    assert.equal(normalized.requestedEffort, effort);
    assert.equal(normalized.thinkingEnabled, enabled);
  }
  const absent = normalizeAnthropicRequest(base);
  assert.equal(absent.requestedEffort, 'none');
  assert.equal(absent.thinkingEnabled, false);
});

test('Anthropic thinking 的畸形请求返回 400', () => {
  const base = {
    model: 'deepseek-v4.1-flash',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  };
  for (const thinking of [
    {},
    { type: 'maybe' },
    { type: 'enabled' },
    { type: 'enabled', budget_tokens: -1 },
    { type: 'enabled', budget_tokens: 1.5 },
  ]) {
    assert.throws(
      () => normalizeAnthropicRequest({ ...base, thinking }),
      (error) => error.status === 400 && error.type === 'invalid_request_error',
    );
  }
});

test('Anthropic 历史回放忽略 thinking 块', () => {
  const normalized = normalizeAnthropicRequest({
    model: 'deepseek-v4.1-flash',
    max_tokens: 64,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private', signature: '' },
          { type: 'text', text: 'answer' },
        ],
      },
      { role: 'user', content: 'next' },
    ],
  });
  assert.deepEqual(normalized.messages[0], {
    role: 'assistant',
    content: 'answer',
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test test/api/anthropic.test.mjs
```

Expected: FAIL because `thinking` is still rejected wholesale.

- [ ] **Step 3: Convert thinking before message normalization**

In `normalizeAnthropicRequest()`:

- Remove the unconditional `thinking` rejection.
- Call `budgetEffort(body.thinking)` only when `body.thinking !== undefined`.
- Set `requestedEffort` to the returned value, or `'none'` when missing.
- Set `thinkingEnabled` to `thinking?.type === 'enabled'`.
- Include both fields in the returned normalized object.

- [ ] **Step 4: Ignore thinking blocks in assistant history**

In `normalizeMessages()`, when handling an assistant content block:

```js
if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
  continue;
}
```

Do not pass thinking content to WorkBuddy. A turn containing only thinking blocks
must still produce an assistant message with `content: null` only if tool calls
exist; otherwise skip empty assistant text as existing behavior requires.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test test/api/anthropic.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/protocols/anthropic.js test/api/anthropic.test.mjs
git commit -m "feat: parse Anthropic thinking budgets"
```

---

### Task 2: Stream and Non-Stream Thinking Responses

**Files:**
- Modify: `src/protocols/anthropic.js`
- Modify: `src/api-runtime.js`
- Modify: `test/api/anthropic.test.mjs`
- Modify: `test/api/anthropic-http.test.mjs`

**Interfaces:**
- Consumes:
  - `thinkingEnabled` and `requestedEffort` from Task 1.
  - `ReasoningCatalogue.getDeclaration()` and `resolveReasoningEffort()` from PR1.
- Produces:
  - `createAnthropicEncoder({ thinkingEnabled })`.
  - Encoder method `thinkingDelta(text)`.
  - `finalize({ reasoningTokens })` and `cancel({ reasoningTokens })` usage detail.
  - Non-stream content block `{ type: 'thinking', thinking, signature: '' }`.

- [ ] **Step 1: Write failing encoder tests**

In `test/api/anthropic.test.mjs`, add:

```js
test('Anthropic 流式 thinking 使用合法内容块和 delta', () => {
  const encoder = createAnthropicEncoder({
    id: 'msg_thinking',
    model: 'deepseek-v4.1-flash',
    inputTokens: 5,
    thinkingEnabled: true,
  });
  const events = [
    ...encoder.start(),
    ...encoder.thinkingDelta('inspect'),
    ...encoder.textDelta('done'),
    ...encoder.finalize({
      finishReason: 'stop',
      outputTokens: 8,
      reasoningTokens: 3,
    }),
  ];

  const start = events.find((event) => (
    event.type === 'content_block_start'
    && event.data.content_block.type === 'thinking'
  ));
  assert.deepEqual(start.data.content_block, {
    type: 'thinking',
    thinking: '',
    signature: '',
  });
  assert.equal(
    events.filter((event) => event.data?.delta?.type === 'thinking_delta')
      .map((event) => event.data.delta.thinking)
      .join(''),
    'inspect',
  );
  const stop = events.find((event) => (
    event.type === 'content_block_stop'
    && event.data.index === start.data.index
  ));
  assert.ok(stop);
  const terminal = events.find((event) => event.type === 'message_delta');
  assert.equal(terminal.data.usage.output_tokens_details.reasoning_tokens, 3);
});

test('Anthropic 禁用 thinking 时 encoder 不输出推理内容', () => {
  const encoder = createAnthropicEncoder({
    id: 'msg_no_thinking',
    model: 'deepseek-v4.1-flash',
    thinkingEnabled: false,
  });
  const events = [
    ...encoder.start(),
    ...encoder.thinkingDelta('must not leak'),
    ...encoder.finalize({ finishReason: 'stop', outputTokens: 2 }),
  ];
  assert.equal(
    events.some((event) => event.data?.content_block?.type === 'thinking'),
    false,
  );
  assert.equal(
    events.some((event) => event.data?.delta?.type === 'thinking_delta'),
    false,
  );
});
```

- [ ] **Step 2: Write failing HTTP integration tests**

In `test/api/anthropic-http.test.mjs`, add a stream fixture that returns:

```js
res.write('data: {"choices":[{"delta":{"reasoning_content":"inspect"}}]}\n\n');
res.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n');
res.end(
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
  + '"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,'
  + '"completion_tokens_details":{"reasoning_tokens":0}}}\n\n'
  + 'data: [DONE]\n\n',
);
```

Send:

```js
thinking: { type: 'enabled', budget_tokens: 8000 }
```

Assert:

- Upstream receives `reasoning_effort: 'high'` for a three-rung declaration.
- `thinking_delta` reconstructs `inspect` even though
  `reasoning_tokens === 0`.
- `message_delta.usage.output_tokens_details.reasoning_tokens === 0`.
- Text delta reconstructs `done`.

Add a non-stream test asserting `content[0]` is:

```js
{
  type: 'thinking',
  thinking: 'inspect',
  signature: '',
}
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
node --test test/api/anthropic.test.mjs test/api/anthropic-http.test.mjs
```

Expected: FAIL because reasoning content is discarded.

- [ ] **Step 4: Extend the Anthropic encoder**

In `createAnthropicEncoder()`:

- Accept `thinkingEnabled = false`.
- Track a thinking block index and text.
- `thinkingDelta(text)` returns `[]` unless `thinkingEnabled` and text is non-empty.
- On first thinking text, emit `content_block_start` with `{ type: 'thinking',
  thinking: '', signature: '' }`, followed by `thinking_delta`.
- `closeThinking()` emits `signature_delta` with `signature: ''` and
  `content_block_stop`.
- Close thinking before opening text or tool blocks.
- `finalize()` and `cancel()` accept `reasoningTokens = 0` and include:

```js
usage: {
  output_tokens: outputTokens,
  output_tokens_details: {
    reasoning_tokens: Math.max(0, Number(reasoningTokens) || 0),
  },
}
```

- Keep the existing event ordering for text/tool calls.

- [ ] **Step 5: Apply normalized effort per account**

In `src/api-runtime.js`, after credentials are available and before the upstream
request:

```js
const declaration = reasoningCatalogue?.getDeclaration({
  accountId: account,
  credentials,
  model: body.normalized.model,
});
const forwardedEffort = resolveReasoningEffort(
  body.normalized.requestedEffort,
  declaration || null,
);
if (forwardedEffort === null) delete body.body.reasoning_effort;
else body.body.reasoning_effort = forwardedEffort;
```

Do not add any Anthropic-specific copy of the clamping ladder.

- [ ] **Step 6: Capture reasoning text and usage**

In `executeAttempt()`:

- Add a bounded `reasoningText` cache using `createRuntimeTextCache`.
- In `processDocument()`, when `choice.delta.reasoning_content` is a non-empty
  string:
  - Always append to `reasoningText`.
  - If thinking is enabled, call `ensureStarted()` and write
    `encoder.thinkingDelta(text)`.
- Extend `usageFromChunk()` with `reasoningTokens` read from:

```js
source.completion_tokens_details?.reasoning_tokens
  ?? source.reasoning_tokens
  ?? usage.reasoningTokens
  ?? 0
```

- In non-stream `responseBody.content`, prepend this block when thinking is enabled
  and `reasoningText.value()` is non-empty:

```js
{
  type: 'thinking',
  thinking: reasoningText.value(),
  signature: '',
}
```

- Add `output_tokens_details.reasoning_tokens` to non-stream usage and streamed
  `message_delta`.
- Pass reasoning tokens to cancellation persistence where available.

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test test/api/anthropic.test.mjs test/api/anthropic-http.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/protocols/anthropic.js src/api-runtime.js \
  test/api/anthropic.test.mjs test/api/anthropic-http.test.mjs
git commit -m "feat: return Anthropic thinking content"
```

---

### Task 3: Disabled-Thinking Fallback Warning and PR2 Verification

**Files:**
- Modify: `src/api-runtime.js`
- Modify: `test/api/anthropic-http.test.mjs`
- Modify: `CHANGELOG.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed Anthropic thinking behavior from Tasks 1-2.
- Produces: one content-free warning per request when reasoning appears while
  thinking is disabled.

- [ ] **Step 1: Write the failing warning test**

Allow `createAnthropicRuntime()` to accept `logWarn = warn`, then pass a collector:

```js
const warnings = [];
const runtime = createAnthropicRuntime({
  upstreamClient,
  logWarn: (message) => warnings.push(String(message)),
});
```

Fixture behavior:

- Request omits `thinking`.
- Upstream returns `reasoning_content: 'secret reasoning'`.
- Upstream reports `reasoning_tokens: 2`.

Assert:

```js
assert.equal(body.content.some((block) => block.type === 'thinking'), false);
assert.equal(body.usage.output_tokens_details.reasoning_tokens, 2);
assert.equal(warnings.filter((line) => /thinking disabled/i.test(line)).length, 1);
assert.equal(warnings.join('\n').includes('secret reasoning'), false);
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test test/api/anthropic-http.test.mjs
```

Expected: FAIL because the warning has not been implemented.

- [ ] **Step 3: Add one-shot warning**

In `src/api-runtime.js`:

- Accept `logWarn = warn` in `createAnthropicRuntime()`.
- Track `warnedThinkingWhileDisabled = false` per attempt.
- On the first non-empty `reasoning_content` while `thinkingEnabled === false`,
  call:

```js
logWarn(
  `Anthropic request ${requestId} received reasoning content while thinking `
  + 'was disabled; the model may not honor none',
);
```

- Never interpolate reasoning content, prompt content, tokens, or credentials.
- Do not emit a thinking block in this state.

- [ ] **Step 4: Document Anthropic behavior**

Append to `CHANGELOG.md`:

```markdown
### Added

- Anthropic `thinking` budgets are mapped to model-supported reasoning effort.
- Thinking responses expose upstream reasoning as Anthropic `thinking` blocks and
  report reasoning-token details.

### Known Limitation

- Some upstream models continue reasoning after `none`. The proxy suppresses that
  reasoning text when thinking is disabled and emits a content-free server warning.
- Thinking signatures are empty because the upstream does not provide verifiable
  signatures.
```

Update `README.md` with:

- The three budget bands.
- Empty/unknown thinking types return 400.
- Thinking blocks and empty signatures.
- Disabled-thinking best effort and warning.
- No guarantee that every model can disable thinking.

- [ ] **Step 5: Run required verification**

```bash
npm run test:api
```

Expected: exit 0.

Run:

```bash
npm test
```

Expected: exit 0 in this workspace. If the CLI login stage fails, record the exact
failures and do not claim the API stage ran.

- [ ] **Step 6: Review and commit**

```bash
git diff --check
git diff --stat
git add src/api-runtime.js test/api/anthropic-http.test.mjs CHANGELOG.md README.md
git commit -m "docs: explain Anthropic thinking compatibility"
```

## PR2 Completion Criteria

- `npm run test:api` exits 0.
- Strict thinking request validation covers missing/unknown types and invalid budgets.
- Stream and non-stream responses expose thinking blocks only when enabled.
- `reasoning_tokens === 0` with non-empty reasoning content is treated as successful
  thinking evidence.
- Disabled-thinking fallback emits one content-free warning and no reasoning text.
- History replay ignores thinking blocks.
- README and changelog document all limitations and behavior changes.
