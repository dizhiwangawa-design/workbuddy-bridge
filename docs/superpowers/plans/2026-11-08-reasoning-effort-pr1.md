# Reasoning Effort Routing PR1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add model-aware reasoning-effort normalization, catalogue caching, and truthful Responses/Chat observation without changing Anthropic `thinking` behavior.

**Architecture:** A pure normalization module maps client effort values onto the selected model's catalogue declaration. A catalogue service caches endpoint- and UID-scoped model snapshots and serves both model listing and request routing. Responses and Chat apply the same normalized value through their different outbound-construction paths.

**Tech Stack:** Node.js `>=22.13`, native ESM, `node:test`, existing bridge runtimes and zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-08-reasoning-effort-routing-design.md`

## Global Constraints

- API acceptance is `npm run test:api`; it must exit 0.
- `npm test` is supplemental because `node test/run.mjs && node test/api/run.mjs` short-circuits when CLI login tests fail.
- Do not add dependencies.
- Do not modify Anthropic `thinking` behavior in PR1.
- Do not infer reasoning support from model-name prefixes.
- If the selected model is absent from a cached catalogue, do not inject `reasoning_effort`.
- A declared single `reasoning.effort` value is the model's only non-off rung.
- Unknown effort strings return protocol-appropriate HTTP 400.
- Missing Responses/Chat effort maps to `none` only when the model is known to support reasoning.
- Responses builds `outbound` from a whitelist; absence means do not add the field.
- Chat starts from `structuredClone(body)`; absence means explicitly `delete outbound.reasoning_effort`.
- Cache keys include `endpoint`, account UID, and model ID.
- Do not add a universal `max_tokens: 8192` default.
- Record the unknown-effort 400 behavior in a new `CHANGELOG.md`.
- Run each task's focused test before the full API suite.
- Commit after every task.

## File Structure

- `src/reasoning-effort.js`: pure validation, declaration parsing, upward clamping, thinking-budget helpers.
- `src/reasoning-catalogue.js`: catalogue extraction, TTL cache, endpoint/UID scoping, refresh fallback.
- `src/upstream-client.js`: expose the configured endpoint for cache namespacing.
- `src/api-server.js`: create one shared upstream client, catalogue, and runtimes per dependency set.
- `src/api-runtime.js`: apply Chat effort routing per selected account; expose catalogue-backed model listing.
- `src/api-responses.js`: apply Responses effort routing per selected account.
- `src/protocols/openai.js`: parse Chat effort, preserve reasoning usage, expose model reasoning metadata.
- `src/protocols/responses.js`: parse Responses effort and echo the forwarded value.
- `test/api/reasoning-effort.test.mjs`: pure normalization tests.
- `test/api/reasoning-catalogue.test.mjs`: cache and extraction tests.
- `test/api/openai.test.mjs`: Chat and model-catalogue integration.
- `test/api/responses.test.mjs`: Responses routing and echo.
- `README.md`: document accepted effort values, model-dependent normalization, and cache refresh.
- `CHANGELOG.md`: record the breaking 400 behavior and observation changes.

---

### Task 1: Pure Reasoning-Effort Normalization

**Files:**
- Create: `src/reasoning-effort.js`
- Create: `test/api/reasoning-effort.test.mjs`

**Interfaces:**
- Consumes: `ApiError` from `src/api-errors.js`.
- Produces:
  - `REASONING_LADDER: readonly string[]`
  - `reasoningDeclaration(model: object|null): ReasoningDeclaration`
  - `resolveReasoningEffort(requested: string|null, declaration: ReasoningDeclaration|null): string|null`
  - `budgetEffort(thinking: object): string`

`ReasoningDeclaration` has this exact shape:

```js
{
  form: 'supported' | 'single' | 'none',
  efforts: string[],
  declaredEffort: string | null,
  defaultEffort: string | null,
  canDisableThinking: boolean | null,
}
```

- [ ] **Step 1: Write failing pure-function tests**

Create `test/api/reasoning-effort.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetEffort,
  reasoningDeclaration,
  resolveReasoningEffort,
} from '../../src/reasoning-effort.js';

function supported(efforts) {
  return reasoningDeclaration({
    reasoning: {
      supportedEfforts: efforts,
      defaultEffort: 'high',
      canDisableThinking: false,
    },
  });
}

test('五档模型保留 medium 和 xhigh', () => {
  const declaration = supported(['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(resolveReasoningEffort('medium', declaration), 'medium');
  assert.equal(resolveReasoningEffort('xhigh', declaration), 'xhigh');
});

test('三档模型向上归一化且 minimal 归为 low', () => {
  const declaration = supported(['low', 'high', 'max']);
  assert.equal(resolveReasoningEffort('minimal', declaration), 'low');
  assert.equal(resolveReasoningEffort('medium', declaration), 'high');
  assert.equal(resolveReasoningEffort('xhigh', declaration), 'max');
});

test('单值声明沿用目录值', () => {
  const declaration = reasoningDeclaration({
    reasoning: { effort: 'medium' },
  });
  assert.deepEqual(declaration.efforts, ['medium']);
  assert.equal(resolveReasoningEffort('low', declaration), 'medium');
  assert.equal(resolveReasoningEffort('high', declaration), 'medium');
  assert.equal(resolveReasoningEffort('none', declaration), 'none');
});

test('无 reasoning 对象不产生转发值', () => {
  const declaration = reasoningDeclaration({ id: 'glm-4.6' });
  assert.equal(resolveReasoningEffort('high', declaration), null);
  assert.equal(resolveReasoningEffort(null, declaration), null);
});

test('已知模型缺失档位时显式转发 none', () => {
  const declaration = supported(['low', 'high', 'max']);
  assert.equal(resolveReasoningEffort(null, declaration), 'none');
});

test('未知档位返回 400 且大小写不敏感', () => {
  const declaration = supported(['low', 'high', 'max']);
  assert.equal(resolveReasoningEffort('HIGH', declaration), 'high');
  assert.throws(
    () => resolveReasoningEffort('hihg', declaration),
    (error) => error.status === 400 && /unknown reasoning effort/i.test(error.message),
  );
});

test('Anthropic 预算分桶边界稳定', () => {
  assert.equal(budgetEffort({ type: 'disabled' }), 'none');
  assert.equal(budgetEffort({ type: 'enabled', budget_tokens: 0 }), 'low');
  assert.equal(budgetEffort({ type: 'enabled', budget_tokens: 4095 }), 'low');
  assert.equal(budgetEffort({ type: 'enabled', budget_tokens: 4096 }), 'high');
  assert.equal(budgetEffort({ type: 'enabled', budget_tokens: 16383 }), 'high');
  assert.equal(budgetEffort({ type: 'enabled', budget_tokens: 16384 }), 'max');
});

test('Anthropic 空对象和未知 type 返回 400', () => {
  for (const thinking of [{}, { type: 'maybe' }]) {
    assert.throws(
      () => budgetEffort(thinking),
      (error) => error.status === 400,
    );
  }
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
node --test test/api/reasoning-effort.test.mjs
```

Expected: FAIL because `src/reasoning-effort.js` does not exist.

- [ ] **Step 3: Implement the pure module**

Create `src/reasoning-effort.js` with these exports and behavior:

```js
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
  return String(value || '').trim().toLowerCase();
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
  if (!declaration || declaration.form === 'none' || !declaration.efforts?.length) {
    return null;
  }
  const raw = requested === null || requested === undefined
    ? 'none'
    : canonical(requested);
  if (!ACCEPTED.has(raw)) {
    throw bad(`unknown reasoning effort: ${JSON.stringify(requested)}`);
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
```

- [ ] **Step 4: Run the focused tests**

Run:

```bash
node --test test/api/reasoning-effort.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reasoning-effort.js test/api/reasoning-effort.test.mjs
git commit -m "feat: add reasoning effort normalization"
```

---

### Task 2: Endpoint/UID-Scoped Reasoning Catalogue

**Files:**
- Create: `src/reasoning-catalogue.js`
- Create: `test/api/reasoning-catalogue.test.mjs`
- Modify: `src/upstream-client.js`

**Interfaces:**
- Consumes:
  - `reasoningDeclaration(model)` from Task 1.
  - `load({ accountId, credentials })` returns the raw upstream catalogue payload.
- Produces:
  - `createReasoningCatalogue(options): ReasoningCatalogue`
  - `ReasoningCatalogue.snapshot({ accountId, credentials, refresh }): Promise<{ models, fetchedAt, stale, error }>`
  - `ReasoningCatalogue.getDeclaration({ accountId, credentials, model }): ReasoningDeclaration | null`
  - `createUpstreamClient(...).endpoint: string`

- [ ] **Step 1: Write failing catalogue tests**

Create `test/api/reasoning-catalogue.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReasoningCatalogue } from '../../src/reasoning-catalogue.js';

function payload(effort) {
  return {
    data: {
      models: [{
        id: 'deep-model',
        reasoning: { effort },
      }],
    },
  };
}

test('同一 endpoint 和 UID 在 TTL 内只加载一次', async () => {
  let loads = 0;
  const catalogue = createReasoningCatalogue({
    endpoint: 'https://a.test',
    now: () => 1000,
    load: async () => {
      loads += 1;
      return payload('medium');
    },
  });
  const credentials = { uid: 'u1' };
  await catalogue.snapshot({ accountId: 'a', credentials });
  await catalogue.snapshot({ accountId: 'a', credentials });
  assert.equal(loads, 1);
  assert.equal(
    catalogue.getDeclaration({ accountId: 'a', credentials, model: 'deep-model' }).efforts[0],
    'medium',
  );
});

test('refresh=true 强制刷新', async () => {
  let loads = 0;
  const catalogue = createReasoningCatalogue({
    endpoint: 'https://a.test',
    now: () => 1000,
    load: async () => payload(++loads === 1 ? 'medium' : 'high'),
  });
  const credentials = { uid: 'u1' };
  await catalogue.snapshot({ accountId: 'a', credentials });
  await catalogue.snapshot({ accountId: 'a', credentials, refresh: true });
  assert.equal(loads, 2);
  assert.equal(
    catalogue.getDeclaration({ accountId: 'a', credentials, model: 'deep-model' }).efforts[0],
    'high',
  );
});

test('不同 UID 和 endpoint 不共享声明', async () => {
  const calls = [];
  const make = (endpoint) => createReasoningCatalogue({
    endpoint,
    now: () => 1000,
    load: async ({ credentials }) => {
      calls.push([endpoint, credentials.uid]);
      return payload(credentials.uid === 'u1' ? 'medium' : 'high');
    },
  });
  const a = make('https://a.test');
  const b = make('https://b.test');
  await a.snapshot({ accountId: 'a', credentials: { uid: 'u1' } });
  await a.snapshot({ accountId: 'b', credentials: { uid: 'u2' } });
  await b.snapshot({ accountId: 'a', credentials: { uid: 'u1' } });
  assert.deepEqual(calls, [
    ['https://a.test', 'u1'],
    ['https://a.test', 'u2'],
    ['https://b.test', 'u1'],
  ]);
});

test('刷新失败保留旧快照', async () => {
  let loads = 0;
  const catalogue = createReasoningCatalogue({
    endpoint: 'https://a.test',
    now: () => 1000,
    load: async () => {
      loads += 1;
      if (loads === 1) return payload('medium');
      throw new Error('upstream unavailable');
    },
  });
  const credentials = { uid: 'u1' };
  await catalogue.snapshot({ accountId: 'a', credentials });
  const stale = await catalogue.snapshot({
    accountId: 'a',
    credentials,
    refresh: true,
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.error.message, 'upstream unavailable');
  assert.equal(
    catalogue.getDeclaration({ accountId: 'a', credentials, model: 'deep-model' }).efforts[0],
    'medium',
  );
});

test('非标准包装仍能递归提取 models', async () => {
  const catalogue = createReasoningCatalogue({
    endpoint: 'https://a.test',
    now: () => 1000,
    load: async () => ({ result: { list: [{ id: 'm1', reasoning: { effort: 'high' } }] } }),
  });
  const snapshot = await catalogue.snapshot({
    accountId: 'a',
    credentials: { uid: 'u1' },
  });
  assert.equal(snapshot.models[0].id, 'm1');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
node --test test/api/reasoning-catalogue.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the catalogue**

Create `src/reasoning-catalogue.js`. Extract model arrays recursively from `data`, `models`, `list`, or `result`. Cache by `${endpoint}\0${uid}`. Treat TTL as `10 * 60 * 1000`. Deduplicate concurrent refreshes with an in-flight Map. Commit a new snapshot only after a successful load. On forced-refresh failure, return the old snapshot with `stale: true` and the error. If no old snapshot exists, throw the load error.

The returned object must implement:

```js
{
  async snapshot({ accountId, credentials, refresh = false }) {},
  getDeclaration({ accountId, credentials, model }) {},
  invalidate({ credentials, endpoint = configuredEndpoint }) {},
}
```

Use the fallback partition `account:${accountId}` only when `credentials.uid` is empty; never share that partition across endpoints.

- [ ] **Step 4: Expose the upstream endpoint**

Modify `src/upstream-client.js` so the returned client includes this read-only property:

```js
get endpoint() {
  return endpoint;
}
```

Extend `test/api/upstream.test.mjs` with:

```js
test('upstream client exposes its normalized endpoint for cache namespacing', () => {
  const client = createUpstreamClient({ baseUrl: 'http://127.0.0.1:1234/' });
  assert.equal(client.endpoint, 'http://127.0.0.1:1234');
});
```

- [ ] **Step 5: Run focused catalogue and upstream tests**

Run:

```bash
node --test test/api/reasoning-catalogue.test.mjs test/api/upstream.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reasoning-catalogue.js src/upstream-client.js \
  test/api/reasoning-catalogue.test.mjs test/api/upstream.test.mjs
git commit -m "feat: cache reasoning capability catalogue"
```

---

### Task 3: Share Catalogue Between Model Listing and Request Routing

**Files:**
- Modify: `src/api-server.js`
- Modify: `src/api-runtime.js`
- Modify: `src/protocols/openai.js`
- Modify: `test/api/openai.test.mjs`

**Interfaces:**
- Consumes:
  - `createReasoningCatalogue()` from Task 2.
  - `reasoningDeclaration(model)` from Task 1.
- Produces:
  - `createOpenAIRuntime({ reasoningCatalogue, ... })`
  - `createResponsesRuntime({ reasoningCatalogue, ... })`
  - `createAnthropicRuntime({ reasoningCatalogue, ... })`
  - `mapModelCatalogue(payload, options)` rows with `wb_reasoning`.
  - `catalogue(config, { refresh })`

- [ ] **Step 1: Write failing model-metadata and cache-reuse tests**

In `test/api/openai.test.mjs`, extend the existing `mapModelCatalogue` assertion:

```js
assert.deepEqual(mapped[0].wb_reasoning, {
  form: 'supported',
  supported_efforts: ['low', 'high', 'max'],
  declared_effort: null,
  default_effort: 'high',
  can_disable_thinking: false,
});
```

Add an HTTP fixture test that sends two `GET /v1/models` requests and asserts the upstream catalogue endpoint is called once:

```js
test('模型目录在 TTL 内复用同一份缓存', async (t) => {
  let catalogueCalls = 0;
  const { baseUrl } = await startFixture(t, (req, res) => {
    if (req.url === '/v2/enterprises/personal/models') {
      catalogueCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          models: [{
            id: 'deepseek-v4.1-flash',
            reasoning: {
              supportedEfforts: ['low', 'high', 'max'],
              defaultEffort: 'high',
              canDisableThinking: true,
            },
          }],
        },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await fetch(`${baseUrl}/v1/models`);
  await fetch(`${baseUrl}/v1/models`);
  assert.equal(catalogueCalls, 1);
});
```

Add a `?refresh=true` variant that expects two calls.

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
node --test test/api/openai.test.mjs
```

Expected: FAIL because model rows have no `wb_reasoning`, and catalogue requests are not cached.

- [ ] **Step 3: Add model metadata mapping**

Modify `mapModelCatalogue()` in `src/protocols/openai.js`:

- Accept each raw model row.
- Compute `const declaration = reasoningDeclaration(model)`.
- Add this extension to each mapped row:

```js
wb_reasoning: {
  form: declaration.form,
  supported_efforts: declaration.efforts,
  declared_effort: declaration.declaredEffort,
  default_effort: declaration.defaultEffort,
  can_disable_thinking: declaration.canDisableThinking,
}
```

- Add `wb_reasoning: null` to fallback rows.

- [ ] **Step 4: Create shared runtime services**

In `src/api-server.js`, add a per-`deps` WeakMap that owns:

```js
{
  upstreamClient,
  reasoningCatalogue,
  responsesRuntime,
  openaiRuntime,
  anthropicRuntime,
}
```

Use `deps.upstreamClient || createUpstreamClient()` once. Create the catalogue with:

```js
createReasoningCatalogue({
  endpoint: upstreamClient.endpoint,
  load: ({ credentials }) => upstreamClient.models(credentials),
})
```

Pass `upstreamClient` and `reasoningCatalogue` to every runtime created by the helper. Keep explicitly injected runtimes intact. Replace the current per-request `createOpenAIRuntime(...)` call with the cached shared runtime.

- [ ] **Step 5: Make runtime model listing use the catalogue**

Modify `createOpenAIRuntime()` in `src/api-runtime.js`:

- Accept `reasoningCatalogue`.
- Change `catalogue(config, { refresh = false } = {})`.
- Pick and authenticate an account as today.
- Call `reasoningCatalogue.snapshot({ accountId: picked.name, credentials, refresh })`.
- Map `snapshot.models` through `mapModelCatalogue({ models: snapshot.models }, ...)`.
- Return `source: snapshot.stale ? 'stale' : 'upstream'`.
- Change `models()` and `model()` to accept `refresh`.
- Pass `url.searchParams.get('refresh') === 'true'` from `src/api-server.js`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test test/api/openai.test.mjs test/api/reasoning-catalogue.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/api-server.js src/api-runtime.js src/protocols/openai.js \
  test/api/openai.test.mjs
git commit -m "feat: share cached reasoning catalogue"
```

---

### Task 4: Responses Effort Injection and Echo

**Files:**
- Modify: `src/protocols/responses.js`
- Modify: `src/api-responses.js`
- Modify: `test/api/responses.test.mjs`

**Interfaces:**
- Consumes:
  - `resolveReasoningEffort(requested, declaration)` from Task 1.
  - `ReasoningCatalogue.getDeclaration()` from Task 2.
- Produces:
  - `prepareResponsesRequest()` result gains `requestedEffort`.
  - Prepared result gains `forwardedEffort` after an account is selected.
  - `baseResponse().reasoning.effort` equals `forwardedEffort` or `null`.

- [ ] **Step 1: Write failing Responses routing tests**

Add tests that capture the upstream request body:

```js
test('Responses 按模型支持的档位注入并回显实际转发值', async (t) => {
  const bodies = [];
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    upstream(res, 'done');
  });
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      input: 'route',
      reasoning: { effort: 'medium' },
    }),
  });
  const body = await response.json();
  assert.equal(bodies[0].reasoning_effort, 'high');
  assert.equal(body.reasoning.effort, 'high');
});
```

Add focused cases with an injected catalogue:

```js
const reasoningCatalogue = {
  getDeclaration() {
    return {
      form: 'single',
      efforts: ['medium'],
      declaredEffort: 'medium',
      defaultEffort: null,
      canDisableThinking: null,
    };
  },
};
```

Assert:

- `max` becomes `medium`.
- Missing `reasoning` becomes `none`.
- Unknown `reasoning.effort` returns 400 before upstream dispatch.
- A declaration with `form: 'none'` produces no `reasoning_effort` key.
- Missing `max_output_tokens` still omits upstream `max_tokens`.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test test/api/responses.test.mjs
```

Expected: FAIL because no field is injected and response effort remains `null`.

- [ ] **Step 3: Parse effort in request preparation**

In `prepareResponsesRequest()`:

- Validate that `body.reasoning`, when present, is an object.
- Read `body.reasoning?.effort`.
- Store `requestedEffort` as the canonical requested string, or `null`.
- Do not add `reasoning_effort` in the whitelist yet.

- [ ] **Step 4: Apply effort after account selection**

In `src/api-responses.js`, after credentials are available and before `upstreamClient.chat()`:

```js
const declaration = reasoningCatalogue?.getDeclaration({
  accountId: account,
  credentials,
  model: prepared.model,
});
const forwardedEffort = resolveReasoningEffort(
  prepared.requestedEffort,
  declaration || null,
);
if (forwardedEffort === null) delete prepared.body.reasoning_effort;
else prepared.body.reasoning_effort = forwardedEffort;
prepared.forwardedEffort = forwardedEffort;
```

Apply the same logic before the retry request after credential refresh; the value must not change merely because the access token was refreshed.

- [ ] **Step 5: Echo the forwarded value**

Change `baseResponse()`:

```js
reasoning: {
  effort: request?.forwardedEffort ?? null,
  summary: null,
},
```

Ensure final, streamed, failed, canceled, and persisted Responses all pass the same prepared request object.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test test/api/responses.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/protocols/responses.js src/api-responses.js \
  test/api/responses.test.mjs
git commit -m "feat: route Responses reasoning effort"
```

---

### Task 5: Chat Effort Injection and Reasoning Usage

**Files:**
- Modify: `src/protocols/openai.js`
- Modify: `src/api-runtime.js`
- Modify: `test/api/openai.test.mjs`

**Interfaces:**
- Consumes:
  - `resolveReasoningEffort()` and `ReasoningCatalogue.getDeclaration()`.
- Produces:
  - `prepareOpenAIRequest()` result gains `requestedEffort`.
  - Chat outbound body always deletes or overwrites `reasoning_effort` after account selection.
  - OpenAI usage includes `completion_tokens_details.reasoning_tokens` when present.

- [ ] **Step 1: Write failing Chat tests**

Add:

```js
test('Chat 按模型支持集合归一化 reasoning_effort', async (t) => {
  const bodies = [];
  const { baseUrl } = await startFixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
      + '"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,'
      + '"completion_tokens_details":{"reasoning_tokens":1}}}\n\n'
      + 'data: [DONE]\n\n',
    );
  });
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'route' }],
      reasoning_effort: 'medium',
    }),
  });
  const body = await response.json();
  assert.equal(bodies[0].reasoning_effort, 'high');
  assert.equal(body.usage.completion_tokens_details.reasoning_tokens, 1);
});
```

Add cases:

- Single declaration `medium` turns `max` into `medium`.
- `form: 'none'` deletes the field inherited from `structuredClone`.
- Unknown effort returns 400 and makes zero upstream calls.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test test/api/openai.test.mjs
```

Expected: FAIL because Chat preserves `medium`, and usage drops reasoning details.

- [ ] **Step 3: Parse Chat effort**

In `prepareOpenAIRequest()`:

- Read `body.reasoning_effort`.
- Store `requestedEffort`.
- Keep it out of the final outbound decision until an account has been selected.

- [ ] **Step 4: Apply effort per attempt**

In `executeAttempt()` after credentials are available:

```js
const declaration = reasoningCatalogue?.getDeclaration({
  accountId: account,
  credentials,
  model: body.model,
});
const forwardedEffort = resolveReasoningEffort(body.requestedEffort, declaration || null);
if (forwardedEffort === null) delete body.body.reasoning_effort;
else body.body.reasoning_effort = forwardedEffort;
```

Apply before every retry request. Since `prepareOpenAIRequest()` uses
`structuredClone`, deletion is mandatory when no declaration exists.

- [ ] **Step 5: Preserve reasoning usage**

Modify `openAIUsage()` to return:

```js
const reasoning = source?.completion_tokens_details?.reasoning_tokens;
const reasoningTokens = Number(reasoning);
return {
  prompt_tokens,
  completion_tokens,
  total_tokens,
  ...(reasoning !== undefined && reasoning !== null && Number.isFinite(reasoningTokens) ? {
    completion_tokens_details: {
      reasoning_tokens: Math.max(0, reasoningTokens),
    },
  } : {}),
}
```

Read `source.completion_tokens_details.reasoning_tokens`. Preserve an explicitly
reported zero as well as positive values in `toOpenAIResponse()`. Update
`eventUsage()` similarly so streamed final usage matches non-streamed usage.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test test/api/openai.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/protocols/openai.js src/api-runtime.js test/api/openai.test.mjs
git commit -m "feat: route Chat reasoning effort"
```

---

### Task 6: PR1 Documentation and Full Verification

**Files:**
- Create: `CHANGELOG.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed behavior from Tasks 1-5.
- Produces: public compatibility and migration notes.

- [ ] **Step 1: Add the changelog entry**

Create `CHANGELOG.md`:

```markdown
# Changelog

## Unreleased

### Changed

- OpenAI Chat Completions and Responses now normalize `reasoning_effort` against
  the selected model's upstream capability declaration.
- Unknown reasoning effort names return HTTP 400 instead of being silently
  forwarded or transformed into a disabled-thinking request.
- Responses report the actually forwarded reasoning effort instead of `null`.
- Models without reasoning capability do not receive `reasoning_effort`.
- Model listings include a namespaced `wb_reasoning` capability declaration.
- The model catalogue is cached for ten minutes per upstream endpoint and account
  UID; `/v1/models?refresh=true` forces a refresh.
```

- [ ] **Step 2: Update README behavior documentation**

Add a section covering:

- Accepted effort names: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
  `max`.
- `minimal` maps to `low`.
- Unsupported named rungs clamp upward; single-value declarations keep their
  declared value.
- Models without a cached/known declaration do not receive the field.
- Responses echo the actual forwarded value.
- Unknown values are a breaking 400.
- `GET /v1/models?refresh=true` refreshes the catalogue.

- [ ] **Step 3: Run the authoritative API suite**

```bash
npm run test:api
```

Expected: exit 0.

- [ ] **Step 4: Run the supplemental full suite**

```bash
npm test
```

Expected: exit 0 in this workspace. If `test/run.mjs` fails, record the exact login
test failures and do not claim the later API stage ran.

- [ ] **Step 5: Review the diff**

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; only PR1 files are changed.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: document reasoning effort routing"
```

## PR1 Completion Criteria

- `npm run test:api` exits 0.
- Pure tests cover every declaration form and strict 400 behavior.
- Catalogue tests cover TTL reuse, forced refresh, endpoint/UID isolation, recursive
  extraction, and stale-on-error.
- Responses tests prove injected and echoed effort, missing-to-`none`, no-declaration
  omission, and no implicit `max_tokens`.
- Chat tests prove full-clone overwrite/delete behavior and reasoning usage mapping.
- Model listing reads the same catalogue snapshot used by request routing.
- `CHANGELOG.md` records the external behavior change.
- Anthropic thinking code remains unchanged.
