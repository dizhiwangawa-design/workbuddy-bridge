# WorkBuddy Bridge OpenAI / Anthropic API Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不经过 `codebuddy -p` 的前提下，让 `workbuddy-bridge` 直接使用现有账号池和隔离登录凭据，为 OpenAI Chat Completions 与 Anthropic Messages 客户端提供文本、SSE、工具调用和多账号故障切换。

**Architecture:** `/v1/*` 请求进入 bridge 的同一 HTTP 服务，先做客户端鉴权与功能开关检查，再由现有 `pickAccount` 选号、从账号隔离 HOME 的 `.info` 读取凭据并直连 WorkBuddy `/v2/chat/completions`。协议层负责 OpenAI/Anthropic 与 WorkBuddy SSE 的双向转换，包括 DSML 工具调用恢复；CLI 只保留扫码登录和原有 MCP 任务。

**Tech Stack:** Node.js `>=18`、`node:http`、全局 `fetch`/Web Streams、`node:test`、现有零依赖 bridge 模块；不引入 Rust sidecar，不引入框架。

**Spec:** 本文件中的“需求基线”“兼容边界”“数据流和事实来源”三节是本次实施规格。

## 需求基线

2026-11-06 的计划输入包含以下明确要求：

1. 保留 bridge 现有号池、登录、统计、MCP 和管理界面。
2. API 请求不启动 CLI，直接请求 WorkBuddy `/v2/chat/completions`。
3. 同时兼容 OpenAI 与 Anthropic 客户端。
4. tool call 必须真实可用，不能只转发 DSML 文本。
5. 尽量复用扫码登录产生的同一份账号凭据。
6. 管理界面提供总开关、协议开关、流式开关、工具开关和客户端 API Key。
7. 每个阶段先交付最小可验收闭环，再扩展下一项能力。
8. 不支持的能力必须明确返回协议对应的错误，不能静默忽略。

当前基线必须保持：

- bridge 位于 `/mnt/windata/awa/workbuddy-bridge`。
- 2026-11-06 已建立 Git 仓库，`main` 分支保存实施前基线；功能开发在
  `feature/openai-anthropic-api-compat` 分支进行。
- 2026-11-06 实际运行 `npm test` 得到 `54/54` 通过。
- 当前 `src/pool.js` 已把 `inflight` 保存在进程内 Map，磁盘只保存统计；旧摘要中“`loadPool()` 重置并发”的问题已经不是当前缺陷。
- 当前登录文件位于 `profiles/<account>/home/.../CodeBuddyExtension/Data/Public/auth/*.info`。
- 实际 `.info` 顶层包含 `account`、`auth`、`accounts`；`auth` 包含 `accessToken`、`refreshToken`、`expiresAt`、`refreshExpiresAt`、`domain`。
- 测试模型名统一使用 `deepseek-v4.1-flash`；旗舰模型只用于人工抽查。

## 数据流和事实来源

```text
OpenAI / Anthropic SDK
        │
        ▼
bridge HTTP /v1/*
        │  功能开关 + 客户端 API Key
        ▼
api-runtime
        │  pickAccount / beginTask / endTask
        │  auth-store 读取同一份 .info
        ▼
WorkBuddy POST /v2/chat/completions
        │  始终 stream: true
        ▼
SSE 聚合 / DSML 扫描 / 协议转换
        │
        ▼
OpenAI chat.completion(.chunk)
或 Anthropic message / tool_use
```

唯一事实来源规则：

- 号池仍是 `accounts.json`、`pool.json` 和进程内 `inflightByCurrentProcess`。
- 不启用 reverse-proxy 的 `state.json`，不把它的账号复制进 bridge。
- API Key 保存在 bridge 自己的 `config.json` 中，但只保存 SHA-256 摘要。
- 登录凭据直接复用账号隔离 HOME 下的 `.info`。
- 刷新成功后只更新原 `.info` 的认证字段，不生成第二份 token 文件。
- 所有计数、冷却和 token 归账继续走 `beginTask`、`endTask`、`recordSample`。

## 兼容边界

本次目标是“主流客户端使用的聊天接口完整”，不是实现 WorkBuddy 并不具备的所有 OpenAI/Anthropic 产品：

| 能力 | 目标 |
|---|---|
| OpenAI `POST /v1/chat/completions` | 支持非流式、SSE、system/developer、图片内容、tools、tool_calls、tool 消息 |
| OpenAI `GET /v1/models`、`GET /v1/models/:id` | 支持模型目录与单模型查询 |
| Anthropic `POST /v1/messages` | 支持非流式、SSE、system、图片、tools、tool_use、tool_result |
| Anthropic `POST /v1/messages/count_tokens` | 使用本地保守估算，不宣称上游精确 tokenizer |
| 客户端鉴权 | OpenAI `Authorization: Bearer` 与 Anthropic `x-api-key` 共用同一套 bridge API Key |
| 多账号 | 401、429、402、5xx 和传输失败在尚未向客户端输出时换号 |
| 流式取消 | 客户端断开后中止上游请求并释放号池租约 |
| OpenAI Responses、Embeddings、Audio、Batch、Fine-tuning | 明确返回 404/400，不伪造成功 |
| Anthropic thinking、prompt caching 等无法保真的高级块 | 明确返回 `invalid_request_error`，不把不可验证字段静默丢弃 |

许可证边界：

- bridge 是 MIT。
- reverse-proxy 是 GPL-3.0-or-later。
- 本计划允许参考线上路径、请求头、DSML 格式和可观察行为，但新代码必须按 Node 接口重新实现，不复制 Rust 源码或内部结构。
- README 可注明“协议行为参考了 reverse-proxy 的公开测试与线上格式”，不把对方代码作为 bridge 的衍生文件。

## 文件结构

创建：

- `src/api-settings.js`：API 兼容配置、功能开关、API Key 哈希与验证。
- `src/api-errors.js`：OpenAI/Anthropic 共用的错误对象和响应编码。
- `src/auth-store.js`：`.info` 解析、有效期判断、账号级刷新锁和原子回写。
- `src/upstream-client.js`：WorkBuddy 直连、请求头、通道兼容清洗、刷新和模型目录。
- `src/sse.js`：SSE 行解析、事件编码和安全关闭。
- `src/tool-calls.js`：可增量处理任意分片的 DSML 扫描器与唯一 call ID。
- `src/api-runtime.js`：号池租约、凭据获取、换号、归账和取消。
- `src/protocols/openai.js`：OpenAI 请求规范化、聚合与响应编码。
- `src/protocols/anthropic.js`：Anthropic/OpenAI 转换与流式事件编码。
- `src/api-server.js`：`/v1/*` 路由、客户端鉴权、功能门禁和错误形状。
- `test/api/run.mjs`：按文件隔离环境运行 API 测试。
- `test/api/pool-runtime.test.mjs`：号池租约与取消。
- `test/api/credentials.test.mjs`：凭据读取、刷新协作和原子写回。
- `test/api/upstream.test.mjs`：直连路径、请求头和清洗。
- `test/api/openai.test.mjs`：OpenAI 文本、SSE、tools。
- `test/api/anthropic.test.mjs`：Anthropic 文本、SSE、tool_use。
- `test/api/settings.test.mjs`：功能开关和 API Key。
- `test/api/admin-api.test.mjs`：管理开关、页面元素和 Key 生命周期。
- `test/api/failover.test.mjs`：401/429/流首帧前换号与输出后停止。

修改：

- `src/paths.js:47-63`：为 `config.json` 增加 `apiCompat` 默认值并做嵌套合并。
- `src/pool.js:187-205`：增加统一的异步号池租约包装，保持现有运行态 Map。
- `src/dispatch.js:22-37`：复用租约包装，CLI 路径行为保持不变。
- `src/runner.js:309-323`：登录检查改为解析真实凭据有效期。
- `src/http.js:143-224`：在静态管理页和 MCP 路由之外挂载 `/v1/*` 与 `/api/api-compat*`。
- `src/admin.js:13-1040`：增加 API 兼容控制面板、密钥创建和连接测试。
- `bin/wb.js:20-78`：帮助信息中补充同一 HTTP 端口上的 API 地址。
- `package.json`：加入 API 测试脚本，版本升到 `0.4.0`。
- `README.md`：补充客户端配置、能力边界、安全说明和故障排查。
- `test/run.mjs:416-423`：测试凭据 fixture 改为真实 `.info` 形状。

不建议修改：

- 不拆分 `src/admin.js` 的现有大文件；本次只增加一个独立面板和一组事件处理，避免重构带来无关回归。
- 不改 `src/install.js` 的 MCP 安装格式；本功能通过 HTTP API 单独使用。
- 不把 reverse-proxy 的 React Web UI 搬进 bridge。

## 阶段地图

| 阶段 | 最小交付 | 可独立验收的结果 |
|---|---|---|
| 1 | 统一号池租约 | 成功后释放、异常后释放、并发上限有效 |
| 2 | 真实凭据读取 | 复用 `.info`，能判断过期和可刷新 |
| 3 | WorkBuddy 直连客户端 | 不发 CLI，请求头与通道清洗正确 |
| 4 | 功能门禁与 API Key | 默认关闭，鉴权与协议错误正确 |
| 5 | OpenAI 非流式 | OpenAI SDK 可得到文本和模型 |
| 6 | OpenAI SSE | 流式文本、取消、超时和租约正确 |
| 7 | OpenAI tools | DSML 转 `tool_calls`，tool result 可续轮 |
| 8 | Anthropic 非流式 | Messages 文本、图片和 count_tokens |
| 9 | Anthropic SSE | 标准事件序列和取消正确 |
| 10 | Anthropic tools | DSML 转 `tool_use`，tool_result 可续轮 |
| 11 | 刷新与换号 | 401/429/5xx、原子刷新和统计正确 |
| 12 | 管理界面 | 开关、密钥、测试按钮完整可用 |
| 13 | 客户端验收与文档 | 全量测试、真实冒烟和能力声明闭环 |

## 全局实施约束

- 每个任务开始前先运行该任务的失败测试，确认失败原因是缺少目标行为。
- 每个任务只实现该任务验收所需的最小路径；后续能力在后续任务打开。
- 所有新功能默认关闭；关闭时 `/v1/*` 返回与协议匹配的 404，不能落到管理页。
- `src/api-*`、`src/protocols/*` 和 `src/upstream-client.js` 不得导入 `runTask` 或 `dispatchTask`。
- token、refresh token、客户端 API Key 明文不得进入日志、异常、管理列表或测试输出。
- 一旦向流式客户端写出第一个有效帧，不允许透明换号重放；只能在首帧前重试。
- 非流式重试可以读完整错误体；流式路径必须在返回 `200` 前确认上游响应成功。
- 每次修改后至少运行 `node test/run.mjs` 和新增的 `node test/api/run.mjs`。
- 每个任务结束时记录命令、结果和改动文件；验证通过后提交到功能分支。

---

### Task 1: 号池租约与 API 测试骨架

**Files:**
- Modify: `src/pool.js:187-205`
- Modify: `src/dispatch.js:22-37`
- Create: `test/api/run.mjs`
- Create: `test/api/pool-runtime.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `beginTask(name: string): number`, `endTask(name: string, result: object): object`。
- Produces: `withAccountLease<T>(name: string, fn: () => Promise<T>): Promise<T>`；无论成功、抛错还是取消，租约恰好释放一次。

- [x] **Step 1: 先写租约失败测试**

创建 `test/api/pool-runtime.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lease-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');

const pool = await import('../../src/pool.js');
const accounts = await import('../../src/accounts.js');

test('withAccountLease 在异常后仍释放并发占位', async () => {
  accounts.ensureAccount('lease-a');
  pool.updateAccount('lease-a', { maxConcurrency: 1 });
  await assert.rejects(
    pool.withAccountLease('lease-a', async () => {
      assert.equal(pool.poolView().accounts.find((a) => a.name === 'lease-a').inflight, 1);
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(pool.poolView().accounts.find((a) => a.name === 'lease-a').inflight, 0);
});
```

创建 `test/api/run.mjs`：

```js
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(here, file)], {
    stdio: 'inherit',
    env: { ...process.env, WB_DEBUG: '' },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
```

将 `package.json` 脚本改为：

```json
{
  "test": "node test/run.mjs && node test/api/run.mjs",
  "test:api": "node test/api/run.mjs"
}
```

- [x] **Step 2: 运行并确认失败**

Run: `npm run test:api`

Expected: FAIL，`pool.withAccountLease is not a function`。

- [x] **Step 3: 写最小租约实现**

在 `src/pool.js` 的 `endTask` 后加入：

```js
export async function withAccountLease(name, fn) {
  beginTask(name);
  let result;
  try {
    result = await fn();
    return result;
  } finally {
    endTask(name, result || {
      ok: false,
      code: 'DISPATCH_ERROR',
      error: '任务在执行前或执行中抛出异常',
      durationMs: 0,
    });
  }
}
```

在 `src/dispatch.js` 中将 `runMeteredTask` 收敛为：

```js
async function runMeteredTask(account, options) {
  return withAccountLease(account, () => runTask({ ...options, account }));
}
```

- [x] **Step 4: 运行本任务和全量回归**

Run: `node test/api/pool-runtime.test.mjs`

Expected: PASS，异常后 `inflight` 为 `0`。

Run: `npm test`

Expected: 原 `54/54` 继续通过，新增测试全部通过。

**验收标准:**

- 相同账号达到 `maxConcurrency` 后不再被 `pickAccount` 选中。
- 回调抛错、任务失败和正常结束都会把 `inflight` 收回。
- 现有 CLI/MCP 调度行为与计数口径不变。

---

### Task 2: 统一登录凭据读取与有效期判断

**Files:**
- Create: `src/auth-store.js`
- Modify: `src/runner.js:309-323`
- Modify: `test/run.mjs:416-423`
- Create: `test/api/credentials.test.mjs`

**Interfaces:**
- Consumes: `accountAuthDir(name: string): string`、`getAccount(name: string): object|null`。
- Produces:

```ts
type AccountCredential = {
  ok: true;
  accessToken: string;
  refreshToken: string | null;
  uid: string;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
  needsRefresh: boolean;
  filePath: string;
};

type CredentialFailure = { ok: false; reason: string };

readAccountCredentials(
  accountName: string,
  options?: { now?: number; refreshSkewMs?: number }
): AccountCredential | CredentialFailure;
```

- [x] **Step 1: 写凭据测试**

创建 `test/api/credentials.test.mjs`，测试真实字段名、秒/毫秒归一、过期判断和 no-secret 输出：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auth-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');

const accounts = await import('../../src/accounts.js');
const auth = await import('../../src/auth-store.js');
const pool = await import('../../src/pool.js');
accounts.ensureAccount('cred-a');
const dir = accounts.accountAuthDir('cred-a');
fs.mkdirSync(dir, { recursive: true });

const doc = {
  account: { uid: 'uid-a', nickname: 'A' },
  auth: {
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: 2000000000,
    refreshExpiresAt: 2100000000,
    domain: 'www.codebuddy.cn',
  },
  accounts: [],
};
fs.writeFileSync(path.join(dir, 'Tencent-Cloud.coding-copilot.info'), JSON.stringify(doc), { mode: 0o600 });

test('读取真实 .info 并把秒归一为毫秒', () => {
  const got = auth.readAccountCredentials('cred-a', { now: 1000 });
  assert.equal(got.ok, true);
  assert.equal(got.uid, 'uid-a');
  assert.equal(got.expiresAt, 2000000000000);
  assert.equal(got.refreshExpiresAt, 2100000000000);
  assert.equal(got.accessToken, 'access-secret');
  assert.equal(
    JSON.stringify(pool.poolView()).includes('access-secret'),
    false,
    'poolView 不得返回 token',
  );
});

test('访问 token 过期但 refresh token 有效时仍可刷新', () => {
  const got = auth.readAccountCredentials('cred-a', { now: 2000000001000 });
  assert.equal(got.ok, true);
  assert.equal(got.needsRefresh, true);
});
```

把 `test/run.mjs` 的 `credAccount` 改成写入合法文档，而不是 `"internal"`：

```js
function credAccount(name) {
  const acc = accounts.ensureAccount(name);
  const dir = accounts.accountAuthDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth_fake.info'), JSON.stringify({
    account: { uid: `uid-${name}`, nickname: name },
    auth: {
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 3600000,
      refreshExpiresAt: Date.now() + 7200000,
    },
    accounts: [],
  }), { mode: 0o600 });
  return acc;
}
```

- [x] **Step 2: 运行并确认失败**

Run: `node test/api/credentials.test.mjs`

Expected: FAIL，`auth.readAccountCredentials` 不存在。

- [x] **Step 3: 实现最小凭据读取**

`src/auth-store.js` 的核心实现：

```js
import fs from 'node:fs';
import path from 'node:path';
import { accountAuthDir } from './accounts.js';

const SECONDS_CUTOFF = 100_000_000_000;

export function normalizeEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < SECONDS_CUTOFF ? n * 1000 : n;
}

function jwtExpiresAt(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return normalizeEpochMs(claims.exp);
  } catch {
    return null;
  }
}

export function readAccountCredentials(accountName, {
  now = Date.now(),
  refreshSkewMs = 120_000,
} = {}) {
  const dir = accountAuthDir(accountName);
  if (!fs.existsSync(dir)) return { ok: false, reason: '没有隔离登录凭证' };
  const candidates = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.info'))) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const doc = JSON.parse(raw);
      const a = doc.auth || {};
      if (typeof a.accessToken !== 'string' || !a.accessToken) continue;
      const expiresAt = normalizeEpochMs(a.expiresAt) || jwtExpiresAt(a.accessToken);
      const refreshExpiresAt = normalizeEpochMs(a.refreshExpiresAt);
      const refreshToken = typeof a.refreshToken === 'string' ? a.refreshToken : null;
      const usable = expiresAt === null || expiresAt > now;
      const refreshable = refreshToken && (refreshExpiresAt === null || refreshExpiresAt > now);
      if (!usable && !refreshable) continue;
      candidates.push({
        ok: true,
        accessToken: a.accessToken,
        refreshToken,
        uid: String(doc.account?.uid || ''),
        expiresAt,
        refreshExpiresAt,
        needsRefresh: expiresAt !== null && expiresAt - now <= refreshSkewMs,
        filePath: path.join(dir, file),
      });
    } catch {
      // 单个损坏的 .info 不应掩盖同一账号下另一个有效文件。
    }
  }
  candidates.sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
  return candidates[0] || { ok: false, reason: '没有可用登录凭证' };
}
```

`quickAuthCheck` 改用该函数，不再只判断文件存在：

```js
const cred = readAccountCredentials(accountName);
return cred.ok
  ? { loggedIn: true, reason: cred.needsRefresh ? '凭证可刷新' : '登录有效' }
  : { loggedIn: false, reason: cred.reason };
```

- [x] **Step 4: 运行测试**

Run: `node test/api/credentials.test.mjs`

Expected: PASS。

Run: `npm test`

Expected: 原测试使用新 fixture 后全部通过。

**验收标准:**

- API 与 CLI 使用同一账号隔离目录中的同一 `.info`。
- 有效期支持秒和毫秒，优先选择到期时间更晚的凭据。
- 过期且无有效 refresh token 的账号不再被误判为已登录。
- 测试输出和异常中不出现 access token 或 refresh token 明文。

---

### Task 3: WorkBuddy 直连客户端与通道兼容

**Files:**
- Create: `src/upstream-client.js`
- Create: `test/api/upstream.test.mjs`

**Interfaces:**
- Consumes: 凭据对象和 `apiCompat.upstreamBaseUrl`。
- Produces:

```ts
createUpstreamClient(options?: {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}) => {
  chat(input: {
    accountId: string;
    credentials: AccountCredential;
    model: string;
    body: object;
    sanitize?: boolean;
    signal?: AbortSignal;
  }): Promise<Response>;
  refresh(credentials: AccountCredential): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    refreshExpiresIn?: number;
  }>;
  models(credentials: AccountCredential): Promise<object>;
};

sanitizeChatBody(body: object): {
  body: object;
  developerRoles: number;
  scrubbedStrings: number;
};
```

- [x] **Step 1: 写 request-shape 失败测试**

`test/api/upstream.test.mjs` 启动本地假上游，断言路径、请求头和清洗结果：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createUpstreamClient, sanitizeChatBody } from '../../src/upstream-client.js';

test('直连 /v2/chat/completions 并发送 WorkBuddy 请求头', async () => {
  let seen;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const client = createUpstreamClient({ baseUrl });
  const response = await client.chat({
    accountId: 'account-A',
    credentials: {
      ok: true,
      accessToken: 'fixture-access',
      uid: 'uid-a',
      expiresAt: Date.now() + 3600000,
    },
    model: 'deepseek-v4.1-flash',
    body: {
      model: 'deepseek-v4.1-flash',
      stream: false,
      messages: [{ role: 'user', content: 'ping' }],
    },
  });

  assert.equal(response.status, 200);
  assert.equal(seen.url, '/v2/chat/completions');
  assert.equal(seen.headers.authorization, 'Bearer fixture-access');
  assert.equal(seen.headers['x-model-id'], 'deepseek-v4.1-flash');
  assert.equal(seen.headers['x-user-id'], 'uid-a');
  assert.equal(seen.body.stream, true);
  server.close();
});

test('developer 折叠为 system，并替换已知通道签名', () => {
  const result = sanitizeChatBody({
    messages: [
      { role: 'developer', content: 'You are an AI agent powered by DeepSeek Harness.' },
    ],
  });
  assert.equal(result.body.messages[0].role, 'system');
  assert.equal(result.body.messages[0].content, 'You are an AI coding agent.');
  assert.equal(result.developerRoles, 1);
  assert.equal(result.scrubbedStrings, 1);
});
```

- [x] **Step 2: 运行并确认失败**

Run: `node test/api/upstream.test.mjs`

Expected: FAIL，模块不存在。

- [x] **Step 3: 实现最小直连**

发送请求的核心代码：

```js
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), timeoutMs);
const onAbort = () => controller.abort(signal.reason);
signal?.addEventListener('abort', onAbort, { once: true });
try {
  const requestId = randomUUID();
  const headers = {
    authorization: `Bearer ${credentials.accessToken}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-requested-with': 'XMLHttpRequest',
    'x-model-id': model,
    'x-request-id': requestId,
    'x-product': 'WorkBuddy',
    'x-agent-intent': 'craft',
    'x-agent-type': 'main',
    'x-codebuddy-request': '1',
    'x-product-version': '5.5.6',
    'x-ide-type': 'WorkBuddy',
    'x-ide-name': 'WorkBuddy',
    'x-ide-version': '5.5.6',
    'user-agent': 'WorkBuddy/5.5.6 (CLI/2.137.1)',
    'x-conversation-id': `wbbridge-${String(accountId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`,
    'x-conversation-request-id': requestId,
    'x-conversation-message-id': requestId,
  };
  if (credentials.uid) headers['x-user-id'] = credentials.uid;
  return await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v2/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  });
} finally {
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
}
```

通道清洗只做两类可观察兼容：

```js
const SIGNATURES = [
  ['You are an AI agent powered by DeepSeek Harness.', 'You are an AI coding agent.'],
  ['Tokens prefixed with @ are paths the user explicitly referenced.', 'Paths may begin with @ when the user references them.'],
  ['DeepSeek Harness Web GUI', 'Web GUI'],
];

export function sanitizeChatBody(input) {
  const body = structuredClone(input);
  let developerRoles = 0;
  let scrubbedStrings = 0;
  const scrubValue = (value) => {
    if (typeof value === 'string') {
      const before = value;
      for (const [from, to] of SIGNATURES) {
        value = value.replace(
          new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          to,
        );
      }
      return { value, changed: value !== before };
    }
    if (Array.isArray(value)) {
      let changed = false;
      for (let i = 0; i < value.length; i += 1) {
        const next = scrubValue(value[i]);
        value[i] = next.value;
        changed ||= next.changed;
      }
      return { value, changed };
    }
    if (value && typeof value === 'object') {
      let changed = false;
      for (const key of Object.keys(value)) {
        const next = scrubValue(value[key]);
        value[key] = next.value;
        changed ||= next.changed;
      }
      return { value, changed };
    }
    return { value, changed: false };
  };
  for (const message of body.messages || []) {
    if (message?.role === 'developer') {
      message.role = 'system';
      developerRoles += 1;
    }
    if (message?.content !== undefined) {
      const next = scrubValue(message.content);
      message.content = next.value;
      if (next.changed) scrubbedStrings += 1;
    }
  }
  return { body, developerRoles, scrubbedStrings };
}
```

`chat()` 内部必须在发送前执行：

```js
const sanitized = sanitize
  ? sanitizeChatBody({ ...body, model, stream: true })
  : { body: { ...body, model, stream: true } };
delete sanitized.body.stream_options;
```

- [x] **Step 4: 运行测试**

Run: `node test/api/upstream.test.mjs`

Expected: PASS，且上游看到始终为 `stream: true`。

Run: `npm test`

Expected: PASS，旧 CLI 测试不调用新客户端。

**验收标准:**

- API 路径只发 HTTP，不 spawn `codebuddy`。
- 请求固定命中 `/v2/chat/completions`。
- headers 包含 bearer、UID、模型、会话 ID 和 WorkBuddy 客户端标识。
- 只有已知签名被改写，普通消息逐字保留。
- `timeoutMs` 覆盖连接和首响应头；`readSse` 的独立 idle timeout 在 Task 5
  随 SSE 解析器一起交付并验收。
- 上游超时、外部取消和网络错误均能中止 fetch 或 reader。

---

### Task 4: 功能开关、客户端 API Key 与路由挂载

**Files:**
- Create: `src/api-settings.js`
- Create: `src/api-errors.js`
- Create: `src/api-server.js`
- Modify: `src/paths.js:47-63`
- Modify: `src/http.js:143-224`
- Create: `test/api/settings.test.mjs`

**Interfaces:**
- Produces:

```ts
type ApiSettings = {
  version: 1;
  enabled: boolean;
  openai: boolean;
  anthropic: boolean;
  streaming: boolean;
  tools: boolean;
  channelSanitize: boolean;
  requireApiKey: boolean;
  upstreamBaseUrl: string;
  defaultModel: string;
  timeoutMs: number;
  keys: Array<{ id: string; name: string; hash: string; createdAt: string }>;
};

getApiSettings(): ApiSettings;
updateApiSettings(patch: object): ApiSettings;
publicApiSettings(): object;
createApiKey(name: string): { key: string; record: object };
deleteApiKey(id: string): boolean;
verifyApiKey(raw: string): boolean;

type ApiError = Error & {
  status: number;
  type: string;
  code: string;
  retryable?: boolean;
};

badRequest(message: string, protocol?: 'openai' | 'anthropic'): ApiError;
sendApiError(res, error: ApiError, protocol: 'openai' | 'anthropic'): void;
```

同时产生 `handleApiRequest({ req, res, url }) => Promise<boolean>`，返回 `false` 表示不是 `/v1/*` 请求。

- [x] **Step 1: 写默认关闭与 API Key 测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-settings-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');
process.env.WB_ADMIN_TOKEN = 'admin-fixture';

const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');

test('API 兼容默认关闭', async () => {
  assert.equal(settings.getApiSettings().enabled, false);
  const srv = await startHttpServer({ port: 0, host: '127.0.0.1' });
  const res = await fetch(`http://127.0.0.1:${srv.port}/v1/models`);
  assert.equal(res.status, 404);
  await srv.close();
});

test('API Key 只返回一次明文，配置只保存摘要', () => {
  const created = settings.createApiKey('test');
  assert.match(created.key, /^sk-wb_/);
  assert.equal(settings.verifyApiKey(created.key), true);
  const saved = settings.getApiSettings();
  assert.equal(JSON.stringify(saved).includes(created.key), false);
  assert.equal(saved.keys[0].hash.length, 64);
});
```

- [x] **Step 2: 运行并确认失败**

Run: `node test/api/settings.test.mjs`

Expected: FAIL，模块不存在且 `/v1/models` 当前返回 `Not Found` 文本。

- [x] **Step 3: 实现配置和门禁**

`src/paths.js` 的默认配置增加：

```js
apiCompat: {
  version: 1,
  enabled: false,
  openai: false,
  anthropic: false,
  streaming: false,
  tools: false,
  channelSanitize: true,
  requireApiKey: true,
  upstreamBaseUrl: 'https://copilot.tencent.com',
  defaultModel: 'deepseek-v4.1-flash',
  timeoutMs: 900000,
  keys: [],
},
```

`loadConfig()` 对 `apiCompat` 做嵌套合并：

```js
apiCompat: {
  ...base.apiCompat,
  ...(saved.apiCompat || {}),
  keys: Array.isArray(saved.apiCompat?.keys) ? saved.apiCompat.keys : base.apiCompat.keys,
},
```

`api-settings.js` 中：

```js
export function createApiKey(name) {
  const cfg = loadConfig();
  const key = `sk-wb_${randomBytes(24).toString('base64url')}`;
  const record = {
    id: randomUUID(),
    name: String(name || 'default').slice(0, 40),
    hash: createHash('sha256').update(key).digest('hex'),
    createdAt: new Date().toISOString(),
  };
  cfg.apiCompat.keys.push(record);
  saveConfig(cfg);
  return { key, record: { ...record, hash: undefined } };
}

export function verifyApiKey(raw) {
  if (!raw) return false;
  const got = createHash('sha256').update(String(raw)).digest();
  return getApiSettings().keys.some((item) => {
    const expected = Buffer.from(item.hash, 'hex');
    return expected.length === got.length && timingSafeEqual(expected, got);
  });
}
```

`src/http.js` 在管理页路由之前加入：

```js
if (p === '/health' && req.method === 'GET') {
  return json(res, 200, { status: 'ok' });
}

if (p.startsWith('/v1/')) {
  if (await handleApiRequest({ req, res, url })) return;
}

if (p.startsWith('/api/api-compat')) {
  if (!adminAllowed(req, url)) return json(res, 401, { ok: false, error: '需要管理令牌' });
  if (await handleApiSettingsApi(req, res, url)) return;
}
```

`src/api-errors.js` 定义两种协议的稳定错误形状：

```js
export class ApiError extends Error {
  constructor(status, message, { type = 'invalid_request_error', code = '' } = {}) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

export function badRequest(message) {
  return new ApiError(400, message);
}

export function sendApiError(res, error, protocol = 'openai') {
  const status = Number(error.status || 500);
  const body = protocol === 'anthropic'
    ? {
        type: 'error',
        error: {
          type: error.type || 'api_error',
          message: error.message || 'internal error',
        },
      }
    : {
        error: {
          type: error.type || 'invalid_request_error',
          message: error.message || 'internal error',
          code: error.code || null,
        },
      };
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
```

`handleApiRequest` 的最小门禁：

```js
const p = url.pathname;
const protocol = p.startsWith('/v1/messages') ? 'anthropic' : 'openai';
function readClientKey(req) {
  const auth = String(req.headers.authorization || '');
  return auth.replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || '');
}

const cfg = getApiSettings();
if (!cfg.enabled) {
  return sendApiError(res, new ApiError(404, 'API compatibility is disabled'), protocol);
}
const protocolAllowed = p.startsWith('/v1/messages') ? cfg.anthropic : cfg.openai;
if (!protocolAllowed) {
  return sendApiError(res, new ApiError(404, 'protocol is disabled'), protocol);
}
if (cfg.requireApiKey && !verifyApiKey(readClientKey(req))) {
  return sendApiError(res, new ApiError(401, 'invalid API key', {
    type: 'authentication_error',
    code: 'invalid_api_key',
  }), protocol);
}
```

管理接口：

```text
GET    /api/api-compat              -> publicApiSettings()
PATCH  /api/api-compat              -> 白名单更新开关和上游配置
POST   /api/api-compat/keys         -> 一次性返回新明文 key
DELETE /api/api-compat/keys/:id     -> 删除 key
```

已知 `/v1/*` 之外的未知路径返回协议匹配的 404；即使是已知 chat 路径，缺失
method 也返回 405，不回退到管理页或 MCP。

- [x] **Step 4: 运行测试**

Run: `node test/api/settings.test.mjs`

Expected: PASS。

Run: `npm test`

Expected: 现有登录页、管理令牌和 MCP 测试均通过。

**验收标准:**

- 所有 API 开关默认关闭。
- 禁用时 `/v1/*` 返回协议正确形状的 404，不返回管理页。
- API Key 明文只在创建响应出现一次，配置文件不包含明文。
- `Authorization: Bearer` 与 `x-api-key` 都可验证同一套 Key。
- `/health` 不暴露账号和上游细节，只返回 `{"status":"ok"}`。
- 启用 API 不改变现有 `/login`、`/admin`、`/mcp` 路由。

---

### Task 5: OpenAI 非流式文本与模型目录

**Files:**
- Create: `src/sse.js`
- Create: `src/api-runtime.js`
- Create: `src/protocols/openai.js`
- Modify: `src/api-server.js`
- Create: `test/api/openai.test.mjs`

**Interfaces:**

```ts
runCompletion(input: {
  upstreamBody: object;
  model: string;
  signal?: AbortSignal;
}, consumeAttempt: (attempt: {
  account: string;
  response: Response;
  commit(): void;
  release(result: object): void;
}) => Promise<unknown>): Promise<unknown>;

aggregateOpenAI(events: AsyncIterable<string | object>): Promise<{
  id?: string;
  content: string;
  reasoning: string;
  toolCalls: Map<number, { id?: string; name: string; arguments: string }>;
  finishReason?: string;
  usage?: object;
}>;

toOpenAIResponse(aggregate: object, model: string): object;
```

`consumeAttempt` 在写出第一个客户端字节前调用 `commit()`。未 commit 且抛出
`retryable: true` 的 `ApiError` 时，runtime 可以换号；commit 之后的任何失败只按
当前协议发送错误并结束。

- [x] **Step 1: 写非流式文本测试**

测试启用 `openai: true, streaming: false, tools: false`，向 bridge 发：

```js
const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: false,
    messages: [{ role: 'user', content: 'ping' }],
  }),
});
const json = await response.json();
assert.equal(response.status, 200);
assert.equal(json.object, 'chat.completion');
assert.equal(json.model, 'deepseek-v4.1-flash');
assert.equal(json.choices[0].message.content, 'pong');
assert.equal(json.usage.prompt_tokens, 3);

const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`, {
  headers: { authorization: `Bearer ${apiKey}` },
})).json();
assert.equal(models.object, 'list');
assert(models.data.some((model) => model.id === 'deepseek-v4.1-flash'));
const one = await (await fetch(
  `http://127.0.0.1:${port}/v1/models/deepseek-v4.1-flash`,
  { headers: { authorization: `Bearer ${apiKey}` } },
)).json();
assert.equal(one.id, 'deepseek-v4.1-flash');
```

假上游返回：

```js
res.writeHead(200, { 'content-type': 'text/event-stream' });
res.write('data: {"id":"cmb-1","created":1,"choices":[{"delta":{"content":"po"}}]}\n\n');
res.write('data: {"choices":[{"delta":{"content":"ng"}}]}\n\n');
res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
res.end('data: [DONE]\n\n');
```

- [x] **Step 2: 运行并确认失败**

Run: `node test/api/openai.test.mjs`

Expected: FAIL，`/v1/chat/completions` 尚无实现或返回空文本。

- [x] **Step 3: 实现最小运行时和聚合**

请求规范化：

```js
export function prepareOpenAIRequest(body, { toolsEnabled }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw badRequest('messages must be a non-empty array');
  }
  if ((body.n ?? 1) !== 1) throw badRequest('only n=1 is supported');
  if (!toolsEnabled && Array.isArray(body.tools) && body.tools.length) {
    throw badRequest('tools are disabled in bridge settings');
  }
  const upstreamBody = structuredClone(body);
  upstreamBody.stream = true;
  delete upstreamBody.stream_options;
  return upstreamBody;
}
```

最小聚合器：

```js
export async function aggregateOpenAI(events) {
  const aggregate = {
    id: undefined,
    content: '',
    reasoning: '',
    toolCalls: new Map(),
    finishReason: undefined,
    usage: undefined,
  };
  for await (const raw of events) {
    if (raw === '[DONE]') break;
    const event = typeof raw === 'string' ? JSON.parse(raw) : raw;
    aggregate.id ||= event.id;
    aggregate.usage = event.usage || aggregate.usage;
    const choice = event.choices?.[0];
    if (!choice) continue;
    aggregate.finishReason = choice.finish_reason || aggregate.finishReason;
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === 'string') aggregate.content += delta.content;
    if (typeof delta.reasoning_content === 'string') {
      aggregate.reasoning += delta.reasoning_content;
    }
    for (const [fallbackIndex, call] of (delta.tool_calls || []).entries()) {
      const index = call.index ?? fallbackIndex;
      const current = aggregate.toolCalls.get(index) || { id: undefined, name: '', arguments: '' };
      if (call.id) current.id = call.id;
      current.name += call.function?.name || '';
      current.arguments += call.function?.arguments || '';
      aggregate.toolCalls.set(index, current);
    }
  }
  return aggregate;
}
```

`src/sse.js` 最小实现：

```js
export async function* readSse(response, { signal, idleTimeoutMs = 120_000 } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => reader.cancel(new Error('upstream stream idle timeout')), idleTimeoutMs);
  };
  const onAbort = () => reader.cancel(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  resetIdle();
  try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    resetIdle();
    buffer += decoder.decode(value, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data) yield data;
    }
  }
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
```

防御性处理忽略 `stream:true` 的上游实现：

```js
const contentType = upstream.headers.get('content-type') || '';
if (!contentType.includes('text/event-stream')) {
  const payload = await upstream.json();
  if (!payload?.choices) {
    throw new ApiError(502, 'upstream returned a non-chat JSON body', {
      type: 'upstream_error',
    });
  }
  // 把普通 chat.completion 包装成单一聚合结果，不原样转发给客户端。
  aggregate = {
    id: payload.id,
    content: payload.choices?.[0]?.message?.content || '',
    reasoning: payload.choices?.[0]?.message?.reasoning_content || '',
    toolCalls: new Map(),
    finishReason: payload.choices?.[0]?.finish_reason,
    usage: payload.usage,
  };
}
```

非流式聚合后输出：

```js
const base = {
  id: aggregate.id || `chatcmpl-${randomUUID().replaceAll('-', '')}`,
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{
    index: 0,
    message: { role: 'assistant', content: aggregate.content },
    logprobs: null,
    finish_reason: aggregate.finishReason || 'stop',
  }],
};
return {
  ...base,
  usage: aggregate.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
};
```

`GET /v1/models` 先用当前可用账号请求
`/v2/enterprises/personal/models`，成功时映射上游模型；上游不可用或目录为空时
返回稳定 fallback，不能让模型列表故障阻断已配置的聊天请求：

`GET /v1/models/:id` 从同一份映射结果查找；命中时返回单个模型对象，未命中时返回
OpenAI 形状的 404 `model_not_found`。

```json
{
  "object": "list",
  "data": [
    {"id":"auto","object":"model","created":0,"owned_by":"workbuddy"},
    {"id":"deepseek-v4.1-flash","object":"model","created":0,"owned_by":"workbuddy"},
    {"id":"hy3","object":"model","created":0,"owned_by":"workbuddy"}
  ]
}
```

映射代码：

```js
function mapModelCatalogue(payload) {
  const rows = payload?.data?.models || payload?.models || [];
  return rows.map((model) => ({
    id: String(model.id),
    object: 'model',
    created: 0,
    owned_by: 'workbuddy',
    name: model.name || String(model.id),
    context_window: model.maxInputTokens ?? null,
    max_output_tokens: model.maxOutputTokens ?? null,
  })).filter((model) => model.id && model.id !== 'undefined');
}
```

- [x] **Step 4: 运行本任务和回归**

Run: `node test/api/openai.test.mjs`

Expected: PASS，上游始终收到 `stream: true`，客户端收到普通 JSON。

Run: `npm test`

Expected: PASS。

**验收标准:**

- OpenAI 非流式文本请求可用。
- `/v1/models` 能返回上游目录或明确标注的稳定 fallback。
- 默认模型、显式模型和 usage 都出现在正确字段。
- 空 messages、`n>1` 和关闭 tools 时的 tools 请求返回 OpenAI 形状的 400。
- API 处理过程中没有任何 CLI 子进程。

**2026-11-06 最小实现范围更新：** 本次只开放非流式文本、文本 content part、
模型目录、模型 fallback 和管理页独立 OpenAI 开关。按用户要求先落实最小实现，
`stream:true`、tools、图片、Responses API 在后续阶段实现；请求这些能力时返回明确的
OpenAI 400/404，不得误报为已支持。

---

### Task 6: OpenAI SSE 文本与取消释放

**Files:**
- Modify: `src/protocols/openai.js`
- Modify: `src/api-server.js`
- Modify: `src/api-runtime.js`
- Modify: `test/api/openai.test.mjs`
- Modify: `test/api/pool-runtime.test.mjs`

**Interfaces:**
- Produces `writeOpenAIStream({ res, account, response, commit, release, model, signal }): Promise<void>`。
- 输出 `text/event-stream; charset=utf-8`、`cache-control: no-cache` 和 `x-accel-buffering: no`。

- [x] **Step 1: 写流式测试**

断言帧顺序、内容和结束标记：

```js
const url = `http://127.0.0.1:${bridge.port}/v1/chat/completions`;
const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
const body = JSON.stringify({
  model: 'deepseek-v4.1-flash',
  stream: true,
  messages: [{ role: 'user', content: 'ping' }],
});
const res = await fetch(url, { method: 'POST', headers, body });
const text = await res.text();
assert.match(res.headers.get('content-type'), /text\/event-stream/);
assert.match(text, /"object":"chat\.completion\.chunk"/);
assert.match(text, /"content":"po"/);
assert.match(text, /"content":"ng"/);
assert.match(text, /"finish_reason":"stop"/);
assert.match(text, /data: \[DONE\]/);
```

取消测试：

```js
const controller = new AbortController();
const res = await fetch(url, { signal: controller.signal, method: 'POST', headers, body });
const reader = res.body.getReader();
await reader.read();
controller.abort();
await waitFor(() => pool.poolView().summary.inflight === 0);
assert.equal(upstreamAborted, true);

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met before timeout');
}
```

- [x] **Step 2: 运行并确认失败**

Run: `node test/api/openai.test.mjs`

Expected: FAIL，流式被拒绝或内容仍为普通 JSON。

- [x] **Step 3: 写最小 SSE 转发**

```js
let started = false;
function startResponse() {
  if (started) return;
  started = true;
  commit();
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}
let rawContent = '';
for await (const data of readSse(upstream)) {
  if (data === '[DONE]') break;
  const event = JSON.parse(data);
  const delta = event.choices?.[0]?.delta;
  const finish = event.choices?.[0]?.finish_reason;
  if (delta?.content) {
    startResponse();
    rawContent += delta.content;
    res.write(`data: ${JSON.stringify(chunk({ content: delta.content }))}\n\n`);
  }
  if (event.usage) usage = event.usage;
  if (finish) finishReason = finish;
}
startResponse();
res.write(`data: ${JSON.stringify(chunk({}, finishReason || 'stop'))}\n\n`);
if (!signal.aborted) res.end('data: [DONE]\n\n');
```

在 `src/api-server.js` 设置：

```js
const controller = new AbortController();
res.on('close', () => {
  if (!res.writableEnded) controller.abort(new Error('client disconnected'));
});
```

在 `finally` 中调用 `release()` 和 `endTask` 的结果对象；释放函数内部使用 `released` 布尔值保证幂等。

- [x] **Step 4: 运行测试**

Run: `node test/api/openai.test.mjs`

Run: `node test/api/pool-runtime.test.mjs`

Expected: 两者都 PASS，取消后号池 `inflight` 归零。

**验收标准:**

- OpenAI 流式客户端能逐帧收到文本。
- 客户端 `200` 响应只在上游已产出首个有效数据后开始；首帧前失败可换号。
- 浏览器/代理不缓存响应。
- 客户端中止会中止上游并释放租约。
- `streaming=false` 时 `stream:true` 返回 400。
- 流输出期间不启动第二个 CLI 或第二个透明重放。

---

### Task 7: OpenAI tools、DSML 恢复与 tool result 往返

**Files:**
- Create: `src/tool-calls.js`
- Modify: `src/protocols/openai.js`
- Modify: `src/api-runtime.js`
- Modify: `test/api/openai.test.mjs`

**Interfaces:**

```ts
createDsmlScanner(): {
  push(delta: string): { visible: string; calls: TextToolCall[] };
  finish(): { visible: string; calls: TextToolCall[] };
};

type TextToolCall = { name: string; arguments: Record<string, unknown> };

recoverInbandToolCalls(content: string): {
  content: string;
  calls: TextToolCall[];
};
```

每个恢复的调用使用唯一 `call_<random>` ID，不使用固定 `call_dsml_0`。

- [x] **Step 1: 写 DSML 分片及非流式工具测试**

```js
import { createDsmlScanner } from '../../src/tool-calls.js';

const raw = '<｜｜DSML｜｜ calls>\n' +
  '<｜｜DSML｜｜ invoke name="get_weather">\n' +
  '<｜｜DSML｜｜ parameter name="city" string="true">北京</｜｜DSML｜｜ parameter>\n' +
  '</｜｜DSML｜｜ invoke>\n' +
  '</｜｜DSML｜｜ calls>';

for (let cut = 0; cut <= raw.length; cut++) {
  const scanner = createDsmlScanner();
  const first = scanner.push(raw.slice(0, cut));
  const second = scanner.push(raw.slice(cut));
  const last = scanner.finish();
  const calls = [...first.calls, ...second.calls, ...last.calls];
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].arguments, { city: '北京' });
}
```

集成测试断言：

```js
assert.equal(json.choices[0].finish_reason, 'tool_calls');
assert.equal(json.choices[0].message.content, null);
assert.equal(json.choices[0].message.tool_calls[0].function.name, 'get_weather');
assert.deepEqual(
  JSON.parse(json.choices[0].message.tool_calls[0].function.arguments),
  { city: '北京' },
);
assert.match(json.choices[0].message.tool_calls[0].id, /^call_/);
```

- [x] **Step 2: 运行并确认失败**

Run: `node test/api/openai.test.mjs`

Expected: FAIL，DSML 被当作普通文本或 call ID 不唯一。

- [x] **Step 3: 实现增量扫描**

```js
const OPEN = '<｜｜DSML｜｜ calls>';
const CLOSE = '</｜｜DSML｜｜ calls>';
const INVOKE_OPEN = '<｜｜DSML｜｜ invoke';
const INVOKE_CLOSE = '</｜｜DSML｜｜ invoke>';
const PARAM = /<｜｜DSML｜｜ parameter\s+name="([^"]+)"\s+string="(true|false)">([\s\S]*?)<\/｜｜DSML｜｜ parameter>/g;

function partialPrefixTail(text, markers) {
  const max = Math.min(text.length, Math.max(...markers.map((x) => x.length)));
  for (let n = max; n > 0; n--) {
    const tail = text.slice(-n);
    if (markers.some((marker) => marker.startsWith(tail))) return n;
  }
  return 0;
}

function parseBlock(block) {
  const calls = [];
  let from = 0;
  while ((from = block.indexOf(INVOKE_OPEN, from)) >= 0) {
    const headerEnd = block.indexOf('>', from);
    const end = block.indexOf(INVOKE_CLOSE, headerEnd);
    if (headerEnd < 0 || end < 0) break;
    const header = block.slice(from, headerEnd + 1);
    const name = /name="([^"]+)"/.exec(header)?.[1];
    const body = block.slice(headerEnd + 1, end);
    if (name) {
      const args = {};
      for (const match of body.matchAll(PARAM)) {
        const [, key, typed, raw] = match;
        args[key] = typed === 'true'
          ? raw.replace(/^\r?\n/, '')
          : (() => {
              try { return JSON.parse(raw.trim()); }
              catch { return raw.replace(/^\r?\n/, ''); }
            })();
      }
      calls.push({ name, arguments: args });
    }
    from = end + INVOKE_CLOSE.length;
  }
  return calls;
}

export function createDsmlScanner() {
  let pending = '';
  let inCalls = false;
  return {
    push(delta) {
      pending += delta;
      let visible = '';
      const calls = [];
      while (true) {
        if (!inCalls) {
          const start = pending.indexOf(OPEN);
          if (start < 0) {
            const keep = partialPrefixTail(pending, [OPEN, CLOSE]);
            const cut = pending.length - keep;
            visible += pending.slice(0, cut);
            pending = pending.slice(cut);
            break;
          }
          visible += pending.slice(0, start);
          pending = pending.slice(start + OPEN.length);
          inCalls = true;
        }
        const end = pending.indexOf(CLOSE);
        if (end < 0) break;
        const block = pending.slice(0, end);
        pending = pending.slice(end + CLOSE.length);
        calls.push(...parseBlock(block));
        inCalls = false;
      }
      return { visible, calls };
    },
    finish() {
      const buffered = pending;
      const calls = inCalls ? parseBlock(buffered) : [];
      pending = '';
      inCalls = false;
      return calls.length
        ? { visible: '', calls }
        : { visible: buffered, calls: [] };
    },
  };
}

export function toOpenAIToolCall(index, call) {
  return {
    index,
    id: `call_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  };
}

export function recoverInbandToolCalls(content) {
  const scanner = createDsmlScanner();
  const first = scanner.push(content);
  const tail = scanner.finish();
  return {
    content: first.visible + tail.visible,
    calls: [...first.calls, ...tail.calls],
  };
}
```

`finish()` 在剩余缓冲含完整 `<invoke>` 时恢复调用；没有完整调用时把剩余文本
原样返回，避免截断响应。

流式 OpenAI 中：

- 普通文本由 scanner 的 `visible` 逐段输出。
- 完成调用后在末尾输出一个 `delta.tool_calls` 帧。
- 结束帧使用 `finish_reason: "tool_calls"`。
- tool result 以原始 OpenAI `role: "tool"` 消息继续发往上游，不做字符串拼接。

- [x] **Step 4: 运行工具与全量测试**

Run: `node test/api/openai.test.mjs`

Expected: PASS，文本、流式、tools 和 tool result 全部通过。

Run: `npm test`

Expected: PASS。

**验收标准:**

- 任意 UTF-8 边界和无状态 SSE 分片下都能恢复完整调用。
- `string="true"` 保持字面文本；`string="false"` 解析为 JSON 值。
- 普通文本不被吞、不泄漏 DSML 标签。
- 每个工具调用 ID 唯一，assistant tool_calls 与 tool result 可完成下一轮。
- `tools=false` 时不会静默移除工具定义。

---

### Task 8: Anthropic 非流式 Messages 与 count_tokens

**Files:**
- Create: `src/protocols/anthropic.js`
- Modify: `src/api-server.js`
- Create: `test/api/anthropic.test.mjs`

**Interfaces:**

```ts
anthropicToOpenAI(body: object): {
  openaiBody: object;
  maxTokens: number;
};

toAnthropicResponse(aggregate: object, model: string): {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: 'text'; text: string }>;
  stop_reason: 'end_turn' | 'max_tokens';
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
};

estimateMessagesTokens(body: object): number;
```

- [x] **Step 1: 写 Anthropic 非流式测试**

```js
import { anthropicToOpenAI } from '../../src/protocols/anthropic.js';

const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
  body: JSON.stringify({
    model: 'deepseek-v4.1-flash',
    max_tokens: 128,
    system: [{ type: 'text', text: 'Be concise.' }],
    messages: [{ role: 'user', content: 'ping' }],
  }),
});
const json = await response.json();
assert.equal(response.status, 200);
assert.equal(json.type, 'message');
assert.equal(json.content[0].type, 'text');
assert.equal(json.content[0].text, 'pong');
assert.equal(json.stop_reason, 'end_turn');
assert.equal(json.usage.input_tokens, 3);
```

图片块测试：

```js
const imageBody = {
  model: 'deepseek-v4.1-flash',
  max_tokens: 32,
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'describe' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      },
    ],
  }],
};
const converted = anthropicToOpenAI(imageBody);
assert.equal(
  converted.openaiBody.messages[0].content[1].image_url.url,
  'data:image/png;base64,AAAA',
);
```

同时测试：

```js
const count = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
  body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hello world' }] }),
});
assert.ok((await count.json()).input_tokens > 0);
```

- [x] **Step 2: 运行并确认失败**

Run: `node test/api/anthropic.test.mjs`

Expected: FAIL，`/v1/messages` 未实现。

- [x] **Step 3: 实现最小转换**

```js
export function anthropicToOpenAI(body) {
  if (!body || typeof body !== 'object') throw badRequest('body must be an object');
  if (!Array.isArray(body.messages)) throw badRequest('missing messages');
  if (body.thinking) throw badRequest('thinking blocks are not supported');
  if (body.mcp_servers || body.container) {
    throw badRequest('mcp_servers and container are not supported');
  }
  const maxTokens = Number(body.max_tokens);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw badRequest('max_tokens must be positive');

  const messages = [];
  const system = blocksToText(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const message of body.messages) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) throw badRequest('message.content must be string or array');
    const parts = [];
    for (const part of message.content) {
      if (part?.type === 'text') {
        parts.push({ type: 'text', text: part.text || '' });
      } else if (part?.type === 'image') {
        const source = part.source || {};
        const url = source.type === 'base64'
          ? `data:${source.media_type};base64,${source.data}`
          : source.url;
        if (!url) throw badRequest('unsupported image source');
        parts.push({ type: 'image_url', image_url: { url } });
      } else {
        throw badRequest(`unsupported content block: ${part?.type || 'unknown'}`);
      }
    }
    const onlyText = parts.every((part) => part.type === 'text');
    messages.push({
      role: message.role,
      content: onlyText ? parts.map((part) => part.text).join('\n') : parts,
    });
  }
  return {
    maxTokens,
    openaiBody: {
      model: body.model,
      messages,
      max_tokens: maxTokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stop: body.stop_sequences,
      stream: true,
    },
  };
}

function blocksToText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter((v) => v?.type === 'text').map((v) => v.text || '').join('\n');
}
```

非流式响应：

```js
const stopReason = aggregate.finishReason === 'length' ? 'max_tokens' : 'end_turn';
json(res, 200, {
  id: `msg_${randomUUID().replaceAll('-', '')}`,
  type: 'message',
  role: 'assistant',
  model,
  content: [{ type: 'text', text: aggregate.content }],
  stop_reason: stopReason,
  stop_sequence: null,
  usage: {
    input_tokens: aggregate.usage?.prompt_tokens || 0,
    output_tokens: aggregate.usage?.completion_tokens || 0,
  },
});
```

`count_tokens` 使用确定性保守估算：

```js
function estimateText(text) {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 3));
}
```

- [x] **Step 4: 运行测试**

Run: `node test/api/anthropic.test.mjs`

Expected: PASS。

Run: `npm test`

Expected: PASS。

**验收标准:**

- Anthropic system 数组和文本 user/assistant 消息正确转换。
- Anthropic base64/url 图片转换为 OpenAI `image_url`。
- `thinking`、`mcp_servers`、`container` 和未知内容块返回明确的 400。
- `max_tokens` 缺失或非正数返回 Anthropic `invalid_request_error`。
- 非流式 `message`、usage、stop_reason 字段正确。
- count_tokens 有稳定结果且 README 标明是本地估算。

---

### Task 9: Anthropic SSE 文本事件

**Files:**
- Modify: `src/protocols/anthropic.js`
- Modify: `src/api-server.js`
- Modify: `test/api/anthropic.test.mjs`

**Interfaces:**
- Produces `writeAnthropicStream({ res, response, model, maxTokens, commit, signal }): Promise<{ usage: object; finishReason?: string }>`。

- [x] **Step 1: 写 SSE 顺序测试**

```js
const text = await response.text();
const types = [...text.matchAll(/event: ([^\n]+)/g)].map((m) => m[1]);
assert.deepEqual(types, [
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
]);
assert.match(text, /"type":"text_delta","text":"po"/);
assert.match(text, /"type":"text_delta","text":"ng"/);
assert.match(text, /"stop_reason":"end_turn"/);
```

- [x] **Step 2: 运行并确认失败**

Run: `node test/api/anthropic.test.mjs`

Expected: FAIL，`stream:true` 被拒绝或没有 Anthropic 事件。

- [x] **Step 3: 写最小事件序列**

先预读到一个有效上游 chat delta 或明确结束状态，再执行下面的提交和事件序列：

```js
function emitSseEvent(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

commit();
res.writeHead(200, {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
});
emitSseEvent(res, 'message_start', {
  type: 'message_start',
  message: {
    id: `msg_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  },
});
emitSseEvent(res, 'content_block_start', {
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'text', text: '' },
});
// 每个上游文本 delta 产生一个 content_block_delta。
emitSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
emitSseEvent(res, 'message_delta', {
  type: 'message_delta',
  delta: { stop_reason: 'end_turn', stop_sequence: null },
  usage: { input_tokens, output_tokens },
});
emitSseEvent(res, 'message_stop', { type: 'message_stop' });
```

客户端中止时不得再尝试写 `message_stop`；在 `res.on('close')` 中止上游并在 `finally` 释放租约。

- [x] **Step 4: 运行测试**

Run: `node test/api/anthropic.test.mjs`

Expected: PASS。

**验收标准:**

- 事件类型和顺序符合 Anthropic Messages SSE。
- 在读取首个有效上游事件前不写 `200`，保证首帧前失败仍可换号。
- 文本跨多个上游 delta 时客户端文本内容拼接正确。
- usage 只在最终 `message_delta` 报告真实上游值。
- 取消后不产生半截伪造 `message_stop`，号池租约归零。

---

### Task 10: Anthropic tool_use / tool_result 完全往返

**Files:**
- Modify: `src/protocols/anthropic.js`
- Modify: `src/api-server.js`
- Modify: `test/api/anthropic.test.mjs`

**Interfaces:**
- `anthropicToOpenAI` 必须把 assistant `tool_use` 转为 OpenAI `tool_calls`，把 user `tool_result` 转为 `role: "tool"`。
- `toAnthropicResponse` 必须把聚合后的 `toolCalls` 转为完整 `type: "tool_use"` 内容块。
- 流式输出使用 `content_block_start`、`input_json_delta`、`content_block_stop`，最终 `stop_reason: "tool_use"`。

- [x] **Step 1: 写请求转换和响应测试**

请求：

```js
{
  model: 'deepseek-v4.1-flash',
  max_tokens: 128,
  tools: [{
    name: 'get_weather',
    description: 'Get weather',
    input_schema: { type: 'object', properties: { city: { type: 'string' } } },
  }],
  messages: [
    { role: 'user', content: 'weather?' },
    {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_1',
        name: 'get_weather',
        input: { city: '北京' },
      }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [{ type: 'text', text: '晴' }],
      }],
    },
  ],
}
```

假上游返回 DSML。非流式断言：

```js
assert.equal(json.stop_reason, 'tool_use');
const use = json.content.find((part) => part.type === 'tool_use');
assert.equal(use.name, 'get_weather');
assert.deepEqual(use.input, { city: '北京' });
assert.match(use.id, /^toolu_/);
```

流式断言：

```js
assert.match(text, /"type":"tool_use"/);
assert.match(text, /"type":"input_json_delta"/);
assert.match(text, /"stop_reason":"tool_use"/);
```

- [x] **Step 2: 运行并确认失败**

Run: `node test/api/anthropic.test.mjs`

Expected: FAIL，DSML 仍作为中文文本输出，或 tool_result 不能进入下一轮。

- [x] **Step 3: 补齐双向转换**

工具定义：

```js
openaiBody.tools = body.tools.map((tool) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description || '',
    parameters: tool.input_schema || { type: 'object', properties: {} },
  },
}));

if (body.tool_choice) {
  openaiBody.tool_choice = {
    auto: 'auto',
    any: 'required',
    none: 'none',
    tool: {
      type: 'function',
      function: { name: body.tool_choice.name || '' },
    },
  }[body.tool_choice.type || 'auto'];
}
```

assistant 工具调用：

```js
{
  role: 'assistant',
  content: text || null,
  tool_calls: toolUseBlocks.map((part) => ({
    id: part.id,
    type: 'function',
    function: { name: part.name, arguments: JSON.stringify(part.input || {}) },
  })),
}
```

tool result：

```js
messages.push({
  role: 'tool',
  tool_call_id: part.tool_use_id,
  content: blocksToText(part.content),
});
```

响应工具块：

```js
const input = JSON.parse(call.arguments || '{}');
content.push({
  type: 'tool_use',
  id: call.id || `toolu_${randomUUID().replaceAll('-', '')}`,
  name: call.name,
  input,
});
```

流式工具块：

```js
for (const [offset, call] of calls.entries()) {
  const index = 1 + offset;
  emitSseEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'tool_use',
      id: call.id || `toolu_${randomUUID().replaceAll('-', '')}`,
      name: call.name,
      input: {},
    },
  });
  emitSseEvent(res, 'content_block_delta', {
    type: 'content_block_delta',
    index,
    delta: {
      type: 'input_json_delta',
      partial_json: JSON.stringify(call.arguments),
    },
  });
  emitSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index });
}
```

其中 `emitSseEvent` 就是 Task 9 的 SSE 编码函数。

流式 Anthropic 路径必须和 OpenAI 路径共用 `createDsmlScanner`。不能直接把 `delta.content` 全量当作 `text_delta`，这是 reverse-proxy 当前 Anthropic 路径的已知缺口。

- [x] **Step 4: 运行工具和回归测试**

Run: `node test/api/anthropic.test.mjs`

Expected: PASS，非流式、SSE、tool_use、tool_result 全部通过。

Run: `npm test`

Expected: PASS。

**验收标准:**

- Anthropic tool definitions、tool_choice 和 tool result 可完整往返。
- DSML 不泄漏给客户端，能转为 `tool_use`。
- 流式输入 JSON 可被 SDK 重组为完整对象。
- 有工具时 stop_reason 为 `tool_use`，无工具时为 `end_turn`。
- 工具调用 ID 每次请求唯一。

---

### Task 11: 凭据刷新、故障换号与归账

**Files:**
- Modify: `src/auth-store.js`
- Modify: `src/upstream-client.js`
- Modify: `src/api-runtime.js`
- Modify: `src/pool.js`
- Create: `test/api/failover.test.mjs`
- Modify: `test/api/credentials.test.mjs`

**Interfaces:**

```ts
refreshAccountCredentials(
  accountName: string,
  client: UpstreamClient
): Promise<AccountCredential | { ok: false; reason: string }>;
```

同一账号并发刷新共享一个 Promise；磁盘写入使用同目录临时文件、`fsync` 语义可接受的 rename 和 `0600` 权限。

- [x] **Step 1: 写刷新和故障测试**

测试文件先在导入业务模块前隔离数据目录：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-failover-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');

const accounts = await import('../../src/accounts.js');
const auth = await import('../../src/auth-store.js');
const pool = await import('../../src/pool.js');
const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met before timeout');
}
```

凭据刷新测试：

```js
test('同账号并发刷新只发出一次并保留未知字段', async () => {
  writeCredential('refresh-a', 'old-access', 'uid-refresh');
  const old = auth.readAccountCredentials('refresh-a');
  const fakeClient = {
    refreshCalls: 0,
    async refresh() {
      this.refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { accessToken: 'new-access', expiresIn: 3600 };
    },
  };
  const [a, b] = await Promise.all([
    auth.refreshAccountCredentials('refresh-a', fakeClient),
    auth.refreshAccountCredentials('refresh-a', fakeClient),
  ]);
  assert.equal(fakeClient.refreshCalls, 1);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const saved = JSON.parse(fs.readFileSync(old.filePath, 'utf8'));
  assert.equal(saved.auth.accessToken, 'new-access');
  assert.equal(saved.account.uid, 'uid-refresh');
  assert.equal(saved.accounts.length, 0);
});

test('刷新期间 CLI 写入更新凭据时不反向覆盖', async () => {
  writeCredential('refresh-race', 'race-old', 'uid-race');
  const file = auth.readAccountCredentials('refresh-race').filePath;
  const fakeClient = {
    async refresh() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { accessToken: 'race-refreshed', expiresIn: 3600 };
    },
  };
  const pending = auth.refreshAccountCredentials('refresh-race', fakeClient);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.auth.accessToken = 'race-external-newer';
  doc.auth.expiresAt = Date.now() + 7200000;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 });
  const result = await pending;
  assert.equal(result.accessToken, 'race-external-newer');
  assert.equal(
    JSON.parse(fs.readFileSync(file, 'utf8')).auth.accessToken,
    'race-external-newer',
  );
});
```

换号测试：

```js
function writeCredential(name, token, uid) {
  accounts.ensureAccount(name);
  const dir = accounts.accountAuthDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth_fixture.info'), JSON.stringify({
    account: { uid, nickname: name },
    auth: {
      accessToken: token,
      refreshToken: `${token}-refresh`,
      expiresAt: Date.now() + 3600000,
      refreshExpiresAt: Date.now() + 7200000,
    },
    accounts: [],
  }), { mode: 0o600 });
}

async function startUpstream(onChat) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    await onChat(req, res, body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('429 后换号并记录冷却与成功统计', async () => {
  for (const account of accounts.listAccounts()) accounts.removeAccount(account.name);
  writeCredential('fail-a', 'token-a', 'uid-a');
  writeCredential('fail-b', 'token-b', 'uid-b');
  pool.setStrategy('round-robin');

  const upstream = await startUpstream((req, res) => {
    if (req.headers.authorization === 'Bearer token-a') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"msg":"too many requests"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
  });
  settings.updateApiSettings({
    enabled: true,
    openai: true,
    streaming: true,
    tools: false,
    requireApiKey: false,
    upstreamBaseUrl: upstream.url,
  });
  const bridge = await startHttpServer({ port: 0, host: '127.0.0.1' });
  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: false,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  const json = await response.json();
  assert.equal(response.status, 200);
  assert.equal(json.choices[0].message.content, 'ok');
  const rows = pool.poolView().accounts;
  assert.match(rows.find((row) => row.name === 'fail-a').lastError, /429|too many/i);
  assert.equal(rows.find((row) => row.name === 'fail-a').status, 'cooling');
  assert.equal(rows.find((row) => row.name === 'fail-b').today.ok, 1);
  await bridge.close();
  upstream.server.close();
});
```

首帧前 vs 首帧后：

```js
test('流式首帧后失败不重放第二个账号', async () => {
  for (const account of accounts.listAccounts()) accounts.removeAccount(account.name);
  writeCredential('stream-a', 'stream-token-a', 'uid-sa');
  writeCredential('stream-b', 'stream-token-b', 'uid-sb');
  let chatBodies = 0;
  const upstream = await startUpstream((req, res) => {
    chatBodies += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    setTimeout(() => res.end(), 10);
  });
  settings.updateApiSettings({ upstreamBaseUrl: upstream.url });
  const bridge = await startHttpServer({ port: 0, host: '127.0.0.1' });
  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  const text = await response.text();
  assert.match(text, /first|upstream stream error/);
  assert.equal(chatBodies, 1, '首帧已输出后不得换号重放');
  await waitFor(() => pool.poolView().summary.inflight === 0);
  await bridge.close();
  upstream.server.close();
});
```

```js
test('流式首帧前 5xx 会换号', async () => {
  for (const account of accounts.listAccounts()) accounts.removeAccount(account.name);
  writeCredential('pre-a', 'pre-token-a', 'uid-pa');
  writeCredential('pre-b', 'pre-token-b', 'uid-pb');
  let chatCalls = 0;
  const upstream = await startUpstream((req, res) => {
    chatCalls += 1;
    if (chatCalls === 1) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"msg":"temporary unavailable"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  settings.updateApiSettings({ upstreamBaseUrl: upstream.url });
  const bridge = await startHttpServer({ port: 0, host: '127.0.0.1' });
  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  const text = await response.text();
  assert.match(text, /recovered/);
  assert.equal(chatCalls, 2);
  await bridge.close();
  upstream.server.close();
});
```

- [x] **Step 2: 运行并确认失败**

Run: `node test/api/failover.test.mjs`

Expected: FAIL，刷新函数不存在或第二个账号未被使用。

- [x] **Step 3: 实现单账号刷新锁**

```js
const refreshLocks = new Map();

export function refreshAccountCredentials(accountName, client) {
  const key = String(accountName);
  if (refreshLocks.has(key)) return refreshLocks.get(key);
  const task = (async () => {
    const current = readAccountCredentials(key, { refreshSkewMs: 0 });
    if (!current.ok || !current.refreshToken) {
      return { ok: false, reason: '账号没有可用 refresh token' };
    }
    const refreshed = await client.refresh(current);
    const latest = readAccountCredentials(key, { refreshSkewMs: 0 });
    if (
      latest.ok &&
      latest.accessToken !== current.accessToken &&
      (latest.expiresAt || 0) > (current.expiresAt || 0)
    ) {
      // 独立 CodeBuddy TUI 已写入更新的登录结果；刷新响应不能覆盖它。
      return latest;
    }
    const doc = JSON.parse(fs.readFileSync(current.filePath, 'utf8'));
    const now = Date.now();
    doc.auth.accessToken = refreshed.accessToken;
    if (refreshed.refreshToken) doc.auth.refreshToken = refreshed.refreshToken;
    if (refreshed.expiresIn) doc.auth.expiresAt = now + refreshed.expiresIn * 1000;
    if (refreshed.refreshExpiresIn) {
      doc.auth.refreshExpiresAt = now + refreshed.refreshExpiresIn * 1000;
    }
    const tmp = `${current.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, current.filePath);
    return readAccountCredentials(key, { refreshSkewMs: 0 });
  })().finally(() => refreshLocks.delete(key));
  refreshLocks.set(key, task);
  return task;
}
```

- [x] **Step 4: 实现换号边界**

可重试状态：

```js
const RETRY_STATUS = new Set([401, 402, 403, 429, 500, 502, 503, 504]);
```

每次尝试：

1. `pickAccount({ exclude: tried })`。
2. `beginTask(account)`。
3. 读取凭据；临期时刷新。
4. 发上游请求。
5. HTTP 非成功时读取错误体、`endTask`、按状态记录冷却，再选下一个号。
6. HTTP 成功时把 Response 和幂等 `release` 交给协议消费者。
7. 流式错误发生在首帧前时消费方释放并请求 runtime 下一号。
8. 首帧已写出后只发送协议错误并结束。

`runCompletion` 的控制流程：

```js
let committed = false;
const commit = () => { committed = true; };
try {
  return await consumeAttempt({ account, response, commit, release });
} catch (error) {
  release({
    ok: false,
    code: error.code || 'UPSTREAM_ERROR',
    error: error.message,
    durationMs: Date.now() - startedAt,
    meta: { model, usage },
  });
  if (committed || !error.retryable) throw error;
  // 未输出任何客户端字节，继续选中下一个未尝试账号。
}
```

`release` 的实现必须幂等：

```js
let released = false;
function release(result) {
  if (released) return;
  released = true;
  endTask(account, result);
}
```

usage 归账：

```js
release({
  ok: true,
  durationMs: Date.now() - startedAt,
  meta: {
    model,
    usage: {
      input_tokens: upstreamUsage?.prompt_tokens || 0,
      output_tokens: upstreamUsage?.completion_tokens || 0,
      cache_read_input_tokens: upstreamUsage?.prompt_tokens_details?.cached_tokens || 0,
    },
  },
});
```

- [x] **Step 5: 运行测试**

Run: `node test/api/failover.test.mjs`

Run: `node test/api/credentials.test.mjs`

Expected: 两者 PASS。

Run: `npm test`

Expected: PASS。

**验收标准:**

- refresh token 有效时，access token 临期自动刷新并原子写回同一 `.info`。
- 同账号并发刷新只产生一次上游 refresh 请求。
- 外部 CLI 写入更新 token 时，bridge 刷新结果不覆盖更新的凭据。
- 401/403/429/402/5xx 在未输出时换号；不可重试 4xx 原样映射。
- 流式一旦输出，不透明重放。
- 每个 attempted account 都有正确 request/error/token 统计。
- token 明文不进入错误文本。

---

### Task 12: 管理界面功能开关与连接测试（已完成）

**Files:**
- Modify: `src/admin.js:13-1040`
- Modify: `src/http.js`
- Modify: `bin/wb.js:20-78`
- Modify: `test/api/settings.test.mjs`
- Create: `test/api/admin-api.test.mjs`

**Interfaces:**
- 消费 `GET/PATCH /api/api-compat` 与 Key CRUD。
- Produces 管理页区块：

```text
API 兼容
  [总开关]
  [OpenAI] [Anthropic]
  [流式] [工具调用] [通道兼容清洗]
  [要求客户端 API Key]
  上游地址 / 默认模型 / 超时
  [生成 API Key] [复制]
  [测试 OpenAI 文本] [测试 Anthropic 工具]
```

- [x] **Step 1: 写管理 API 契约测试**

```js
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-admin-api-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');
process.env.WB_ADMIN_TOKEN = 'admin-fixture';

const { startHttpServer } = await import('../../src/http.js');
const server = await startHttpServer({ port: 0, host: '127.0.0.1' });
after(() => server.close());

function adminFetch(pathname, options = {}) {
  return fetch(`http://127.0.0.1:${server.port}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-wb-token': 'admin-fixture',
      ...(options.headers || {}),
    },
  });
}

test('管理开关默认关闭且可更新', async () => {
  const before = await adminFetch('/api/api-compat');
  assert.equal((await before.json()).apiCompat.enabled, false);

  const updated = await adminFetch('/api/api-compat', {
    method: 'PATCH',
    body: JSON.stringify({
      enabled: true,
      openai: true,
      anthropic: true,
      streaming: true,
      tools: true,
    }),
  });
  const json = await updated.json();
  assert.equal(json.apiCompat.openai, true);
  assert.equal(JSON.stringify(json).includes('hash'), false);
});
```

页面测试：

```js
const html = await (await adminFetch('/admin')).text();
assert.match(html, /API 兼容/);
assert.match(html, /data-api-toggle="enabled"/);
assert.match(html, /data-act="api-key-create"/);
```

- [x] **Step 2: 运行并确认失败**

Run: `node test/api/admin-api.test.mjs`

Expected: FAIL，管理接口或页面元素不存在。

- [x] **Step 3: 增加最小面板**

HTML 插入在号池标题前：

```html
<section class="panel api-panel" id="api-panel">
  <div class="panel-head">
    <div>
      <div class="panel-title">API 兼容</div>
      <div class="panel-sub">OpenAI / Anthropic 客户端直接复用当前号池与登录凭据</div>
    </div>
    <button class="switch" role="switch" data-api-toggle="enabled"></button>
  </div>
  <div class="api-grid">
    <label><input type="checkbox" data-api-toggle="openai"> OpenAI</label>
    <label><input type="checkbox" data-api-toggle="anthropic"> Anthropic</label>
    <label><input type="checkbox" data-api-toggle="streaming"> 流式</label>
    <label><input type="checkbox" data-api-toggle="tools"> 工具调用</label>
    <label><input type="checkbox" data-api-toggle="channelSanitize"> 通道兼容清洗</label>
    <label><input type="checkbox" data-api-toggle="requireApiKey"> 要求 API Key</label>
  </div>
  <div class="api-actions">
    <button class="primary" data-act="api-key-create">生成 API Key</button>
    <button class="ghost" data-act="api-test-openai">测试 OpenAI</button>
    <button class="ghost" data-act="api-test-anthropic">测试 Anthropic</button>
  </div>
</section>
```

JS 更新：

```js
function loadApiSettings() {
  return api('/api/api-compat').then(function (j) {
    state.api = j.apiCompat;
    renderApiSettings();
  });
}

function patchApiSettings(patch) {
  return api('/api/api-compat', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }).then(function (j) {
    state.api = j.apiCompat;
    renderApiSettings();
  });
}
```

Key 创建成功后只在当前页面显示一次：

```js
api('/api/api-compat/keys', {
  method: 'POST',
  body: JSON.stringify({ name: 'management-ui' }),
}).then(function (j) {
  $('api-new-key').textContent = j.key;
  toast('API Key 已生成，关闭后无法再次查看');
});
```

连接测试只调用一个最小非流式请求，使用 `deepseek-v4.1-flash`，结果只显示 `ok`、耗时、账号名和错误码，不显示 prompt 或 token。

- [x] **Step 4: 管理页结构与桌面布局验收（自动测试覆盖；2026-11-07 已完成真实浏览器桌面复验，按要求不包含手机端）**

Run: `node ./bin/wb.js admin --port 0`

在浏览器完成：

1. API 总开关初始为关闭。
2. 开启 OpenAI/Anthropic/流式/工具并刷新，状态保持。
3. 生成 Key 后关闭弹层，列表无法再显示明文。
4. 删除 Key 后使用该 Key 的请求返回 401。
5. 号池开关、扫码登录、预算、统计仍可操作。

- [x] **Step 5: 运行自动测试**

Run: `node test/api/admin-api.test.mjs`

Run: `npm test`

Expected: PASS。

**验收标准:**

- 管理界面控制全部开关，刷新后状态不丢失。
- 默认全关；只开启总开关时两个协议仍不可用。
- API Key 明文只显示一次，页面和接口不返回 hash。
- 连接测试不使用 CLI，不泄漏提示词和 cookie/token。
- 原有管理界面布局在桌面和窄屏下无横向溢出。

---

### Task 13: 真实客户端验收、文档与最终自检（离线部分已完成；真实账号冒烟待授权）

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `bin/wb.js`
- Modify: `test/run.mjs`
- Modify: `docs/superpowers/plans/2026-11-06-openai-anthropic-api-compat.md`

**Interfaces:**
- 对外地址：

```text
OpenAI base URL:    http://127.0.0.1:7666/v1
Anthropic base URL: http://127.0.0.1:7666
Health:             http://127.0.0.1:7666/health
Admin:              http://127.0.0.1:7666/admin
```

- [x] **Step 1: 更新帮助与文档**

README 必须包含：

1. 如何在管理页启用功能并创建 API Key。
2. OpenAI SDK 的 `base_url` 和 Anthropic SDK 的 `base_url`。
3. 不经过 CLI 的架构图。
4. 支持与不支持矩阵。
5. `deepseek-v4.1-flash` 自动测试约定。
6. 本地假上游测试命令。
7. 401、429、无可用账号、工具调用和流断开的排障。
8. 安全警告：监听 `0.0.0.0` 时必须启用 API Key 和 TLS 反向代理。
9. 许可证说明：行为参考 GPL 项目，但 Node 实现独立。

`wb http` 启动日志增加：

```text
OpenAI API:    http://127.0.0.1:7666/v1/chat/completions
Anthropic API: http://127.0.0.1:7666/v1/messages
```

- [x] **Step 2: 建立官方 wire-shape 验收样例（离线 SDK + 文档命令）**

OpenAI 非流式：

```bash
curl http://127.0.0.1:7666/v1/chat/completions \
  -H "Authorization: Bearer $WB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"只回复 ok"}],"stream":false}'
```

OpenAI 流式：

```bash
curl -N http://127.0.0.1:7666/v1/chat/completions \
  -H "Authorization: Bearer $WB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"数到 3"}],"stream":true}'
```

Anthropic 非流式：

```bash
curl http://127.0.0.1:7666/v1/messages \
  -H "x-api-key: $WB_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","max_tokens":64,"messages":[{"role":"user","content":"只回复 ok"}]}'
```

Anthropic 工具：

```bash
curl http://127.0.0.1:7666/v1/messages \
  -H "x-api-key: $WB_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","max_tokens":128,"tools":[{"name":"get_weather","description":"Get weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],"messages":[{"role":"user","content":"北京天气"}]}'
```

有官方 SDK 的验收环境再运行：

```python
import os
from openai import OpenAI
from anthropic import Anthropic

key = os.environ["WB_API_KEY"]

openai_client = OpenAI(
    base_url="http://127.0.0.1:7666/v1",
    api_key=key,
)
assert openai_client.chat.completions.create(
    model="deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "只回复 ok"}],
).choices[0].message.content

anthropic_client = Anthropic(
    base_url="http://127.0.0.1:7666",
    api_key=key,
)
assert anthropic_client.messages.create(
    model="deepseek-v4.1-flash",
    max_tokens=64,
    messages=[{"role": "user", "content": "只回复 ok"}],
).content[0].text
```

工具调用验收对两个 SDK 各执行一次完整往返：客户端解析出 tool call，
构造对应 tool result，再发起第二次请求并得到普通文本。这个检查覆盖“看起来返回
JSON、客户端却不执行工具”的伪兼容问题。

- [x] **Step 3: 使用假上游做完整回归**

Run: `npm test`

Expected:

- 原 CLI/MCP/账号/号池/统计测试全部通过。
- OpenAI 文本和 SSE 通过。
- Anthropic 文本和 SSE 通过。
- 两套工具调用与 tool result 往返通过。
- 取消、401、429、首帧前后失败边界通过。
- API 默认关闭和 Key 鉴权通过。

- [ ] **Step 4: 真实账号冒烟（`deepseek-v4.1-flash` 仍被上游模型级配额阻断）**

只有用户明确批准消耗账号额度后执行：

1. 使用 `deepseek-v4.1-flash` 对 `awa` 和 `default` 各发一条最短文本。
2. 各发一条流式文本。
3. 各发一次 `get_weather` 类无副作用工具调用。
4. 人工检查管理页并发数、延迟、token 和冷却。
5. 全程不打印 `.info` 内容、access token、refresh token 或完整客户端 Key。

真实冒烟验收：

- 每个已登录账号至少有一次成功响应。
- 无工具调用以 DSML 文本泄漏。
- 上游 401 能刷新或换号。
- 客户端断开后面板并发在 5 秒内回落。

**验收标准:**

- 官方 wire-shape 样例均可被标准客户端解析。
- 全量自动测试零失败。
- README 的能力声明与实际实现一致。
- 关闭功能后所有 `/v1/*` 明确不可用。
- 真实服务和测试日志中没有凭据泄漏。

**2026-11-07 执行记录:**

- `npm run test:live`：Anthropic 非流式通过；`default` 返回可见文本。
- `npm run test:live:openai`：OpenAI Chat 非流式通过。
- `node test/live/openai-live.mjs --thinking`：思考提示通过。
- `node test/live/openai-live.mjs --tools`：真实 `tool_calls` + `tool` 续传通过。
- `npm run test:live:responses`：`default` 的 Responses HTTP、SSE、原生 WS、
  `previous_response_id` 续接通过；使用临时响应库，未污染现有记录。
- 额外真实冒烟：Chat SSE、Anthropic SSE、Anthropic `tool_use/tool_result`
  和 Responses `max_output_tokens=1` 截断均通过。
- 管理页已用真实浏览器复验 1440×1000：OpenAI 开关会联动 Responses 持久化与续跑提示，
  桌面布局无横向溢出；按用户要求不把手机端验收列为完成条件。
- 新增 `test:live:account`：固定单账号执行 Chat 非流式、SSE、工具续轮和租约归零检查。
  `default` 使用 `deepseek-v4.1-flash` 通过，4 次请求全部记账且 `inflight=0`。
- `awa` 单独重试仍返回上游 `429 RATE_LIMITED`，因此“每个已登录账号至少成功一次”
  未满足；`codex-fresh-mvxgctfk` 返回同一上游 429。两者提示的重置时间分别为
  2026-11-08 02:27:25 和 2026-11-07 22:40:23（UTC+8）。
- 清除本地冷却后，`awa` 与 `codex-fresh-mvxgctfk` 使用 `deepseek-v4-flash`
  均通过同一套 4 请求账号冒烟（文本、SSE、工具续轮、租约归零）。这证明阻塞是
  `deepseek-v4.1-flash` 的外部模型级配额，不是凭据、号池或协议链路故障；默认模型
  仍保持 `deepseek-v4.1-flash`，没有自动换模型掩盖 429。
- 未读取、打印或提交 access token、refresh token 或完整客户端 Key。

---

## 最终 Bug 自检清单

- [x] `rg -n "runTask|dispatchTask" src/api-*.js src/upstream-client.js src/protocols` 无结果。
- [x] `rg -n "accessToken|refreshToken" src` 的 API 日志点不包含 token 值。
- [x] `rg -n "call_dsml_0" src` 无结果。
- [x] `rg -n "stream_options" src/protocols src/upstream-client.js` 只存在删除逻辑，不存在向上游转发。
- [x] 所有流式 `finally` 都调用幂等 `release()`。
- [x] 所有 `beginTask` 都在成功、异常、取消、上游错误四条路径释放。
- [x] `inflight` 在并发测试和服务运行后回到 `0`。
- [x] API 响应不会把 `developer` role 原样发给上游。
- [x] 非流式响应不会把上游 SSE 原样泄漏给客户端。
- [x] Anthropic 非流式路径同样经过 DSML 扫描，不只处理 OpenAI。
- [x] Anthropic 流式路径不直接把 DSML 文本输出为 `text_delta`。
- [x] 结构正确的上游 `tool_calls` 不被重复恢复。
- [x] 首帧后失败不会再次请求另一个账号。
- [x] 429 使账号进入冷却，401 在刷新失败后标记未授权。
- [x] 同一账号并发刷新只发出一次 refresh 请求。
- [x] refresh 原子写回后 `.info` 的未知字段仍存在，文件权限为 `0600`。
- [x] 功能关闭、协议关闭、API Key 错误分别返回正确状态码。
- [x] 原有 `/login`、`/admin`、`/api/pool`、`/api/stats`、`/mcp` 全部回归通过。
- [x] 计划中出现的接口名、字段名和测试名在实现代码中保持一致。

## 执行顺序与停止条件

严格按 Task 1 到 Task 13 顺序执行。每个任务满足以下条件后才能进入下一个：

1. 新测试在实现前确实失败。
2. 最小实现只覆盖当前任务。
3. 当前任务测试通过。
4. `npm test` 全量通过。
5. 没有新增未记录的能力声明。

出现下列任一情况立即停止并报告：

- 真实 `.info` 无法刷新且原因不是过期。
- 上游要求无法通过公开协议还原的浏览器 cookie。
- 工具调用无法稳定区分 DSML 与普通文本。
- 需要修改现有号池事实来源或启动第二套账号状态。
- 必须复制 GPL 源文件才能继续。
- 迁移真实账号时会覆盖或删除现有 `.info`。

---

## 2026-11-07 增量规格（绑定）

本节覆盖前文“不支持 Responses API”“取消后不再写合法收尾”等旧描述。实现必须继续
复用现有号池与共享登录凭据，保持版本 `0.4.0`，不 tag、不推送。

### Task 14: 修复鉴权回归与有界慢读

**Files:**
- Modify: `src/api-server.js`
- Modify: `src/http.js`
- Modify: `src/stream-control.js`
- Modify: `test/api/settings.test.mjs`
- Modify: `test/api/stream-control.test.mjs`
- Modify: `test/api/slow-reader.test.mjs`
- Modify: `test/load/slow-reader.mjs`

- [x] 恢复真实客户端鉴权：OpenAI `Authorization: Bearer`、Anthropic
  `x-api-key`、Responses HTTP 与 WebSocket upgrade 共用同一套 Key 校验。
- [x] 移除 `if (false)` 占位；缺失或错误 Key 必须返回协议对应的 401。
- [x] 写入器在调用 `res.write()` 前检查
  `writableLength + pendingBytes + nextBytes`，超过 1 MiB 硬阈值时不得继续接受
  新数据；健康慢读和 256 KiB 软阈值记录仍保留。
- [x] 慢读压测必须证明上游在 1 MiB 量级被取消、租约归零、审计为
  `BACKPRESSURE_OVERFLOW`、子进程峰值 RSS 小于 160 MiB、子进程确定性退出。
  测试子进程显式设置 `--max-semi-space-size=4 --max-old-space-size=64`；Node 24
  默认会按宿主资源预留较大堆，该测试参数不改生产运行时。
- [x] 新增 WS 无 Key/错误 Key 的 401 测试。

**验收:**

- `node test/api/settings.test.mjs` 全部通过。
- `node test/api/stream-control.test.mjs` 与 `node test/api/slow-reader.test.mjs`
  全部通过。
- 不读取、打印或提交任何 token、refresh token、客户端 Key。

### Task 15: 取消、断连与截断语义回归

**Files:**
- Modify: `src/api-runtime.js`
- Modify: `test/api/openai.test.mjs`
- Modify: `test/api/anthropic-http.test.mjs`
- Modify: `test/api/disconnect-resilience.test.mjs`

- [x] Chat HTTP RST 保存可见正文一次；主动取消在持久化成功后发送注释、
  `finish_reason:"stop"` 和 `[DONE]`。
- [x] Anthropic 主动取消在持久化成功后发送合法
  `message_delta(stop_reason:"canceled")` + `message_stop`；RST 不伪造成功取消。
- [x] 半截工具参数不得成为可执行 tool call；失败和上游超时不报告成功取消。
- [x] 重命名没有实际取消步骤却声称测试取消的用例，或补上真实取消步骤。
- [x] 覆盖重复 Close/Pong/取消只释放一次租约。

**验收:**

- `node test/api/openai.test.mjs`
- `node test/api/anthropic-http.test.mjs`
- `node test/api/disconnect-resilience.test.mjs`

### Task 16: Responses API 完整验收

**Files:**
- Modify: `src/protocols/responses.js`
- Modify: `src/api-responses.js`
- Modify: `test/api/responses.test.mjs`
- Modify: `test/api/disconnect-resilience.test.mjs`

- [x] 验证 `previous_response_id` 续接、`GET /v1/responses/:id`、取消片段查询。
- [x] 覆盖 `max_output_tokens` 与 `upstream_length_limit` 两种截断原因。
- [x] 覆盖 `parallel_tool_calls:false`、`allowed_tools`、function/custom/namespace、
  `local_shell`、`shell`、`apply_patch`、URL/data URL 图片。
- [x] 覆盖内嵌 item、output 早于 call、超长 namespace 哈希去歧义、不支持工具的
  `400 unsupported_tool_type` 与 `file_id` 拒绝。
- [x] 覆盖 WS `response.interrupt`，以及新 `response.create` 前取消并等待旧租约。
- [x] HTTP/SSE 事件 `sequence_number` 单调，`output_item.done` 与 completed output
  身份一致。

**验收:**

- `node test/api/responses.test.mjs` 全部通过。
- 相关断连与租约用例全部通过。

### Task 17: 管理页、文档与最终验收

**Files:**
- Modify: `src/admin.js`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-11-06-openai-anthropic-api-compat.md`
- Modify: `package.json`

- [x] 管理页验证 OpenAI 独立开关；OpenAI 关闭时 Responses 持久化与续跑提示不可用。
- [x] 文档统一说明 Chat/Responses HTTP/WS、SQLite 与 0600 死信、取消审计、
  15 秒 keepalive、RST/Close/假死、256 KiB/1 MiB 背压、`upstream_length_limit`
  和 `deepseek-v4.1-flash`。
- [x] 运行聚焦测试、`npm test`、`git diff --check`，确认版本 `0.4.0` 后本地提交。

### Task 18: 阻断修复与跨重启持久化加固

- [x] 为 Responses 持久化增加版本化 `_bridgeMeta.outputOffset`，多轮
  `previous_response_id` 只追加当前轮输出，避免重复注入历史 assistant 消息；
  未带元数据的旧记录继续按旧格式读取。
- [x] 死信记录保存本轮输入和 `previous_response_id`；SQLite 恢复后仍可通过
  `previous_response_id` 续接，不再只剩可见文本。
- [x] 增加“取消 -> 死信 -> 关闭 store -> 新 store 启动重试 -> 查询恢复记录”
  的跨重启测试，并校验输入、输出和续接关系。
- [x] 新增固定账号脱敏 live 冒烟脚本；429 使用独立退出码 2 和
  `blocked:true`，不打印上游正文、token 或客户端 Key。
- [ ] 在 `deepseek-v4.1-flash` 配额重置后，用 `test:live:account` 对
  `awa` 和 `codex-fresh-mvxgctfk` 各完成一次通过。该步骤只能等待外部配额恢复。
