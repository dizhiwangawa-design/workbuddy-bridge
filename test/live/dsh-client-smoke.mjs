#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { copyFile, removeTreeQuietly, stageBridgeHome } from './bridge-home.mjs';
import { CONTINUATION_NUDGE_MARKER } from '../../src/continuation-nudge.js';

// deepseekharness（dsh）在 provider 里声明的是 `api: openai-responses`，
// 也就是和 codex 同一条 /v1/responses 路径。这个用例把 dsh 放进隔离
// DSH_HOME 里，指向本进程临时起的 bridge，跑一个多步编码任务，验证
// 「任务没做完不会被判定结束」。

const model = process.env.WB_LIVE_MODEL?.trim() || 'deepseek-v4.1-flash';
const account = process.env.WB_LIVE_ACCOUNT?.trim() || 'default';
const dshCommand = process.env.WB_DSH_COMMAND?.trim() || 'dsh';
const dshProfile = process.env.WB_DSH_PROFILE?.trim() || 'headless';
const providerName = 'wbverify';
const timeoutMs = Math.max(
  30_000,
  Number(process.env.WB_DSH_TIMEOUT_MS) || 240_000,
);
const expectFiles = /^(1|true|yes)$/i.test(process.env.WB_DSH_EXPECT_FILES || '')
  || !process.env.WB_DSH_PROMPT;
const prompt = process.env.WB_DSH_PROMPT?.trim() || [
  'You are in an isolated temporary coding workspace.',
  'Complete this multi-step coding task without asking questions:',
  '1. Create calc.mjs exporting add(a,b), sub(a,b) and mul(a,b).',
  '2. Create test.mjs importing them, asserting add(2,3)===5, sub(5,3)===2, mul(3,4)===12.',
  '3. Run node test.mjs and fix any failure.',
  '4. Create README.md with one line describing the module.',
  'Do not stop after describing what you will do. Finish only after the test passes.',
].join('\n');

const sourceBridgeHome = path.resolve(
  process.env.WB_LIVE_BRIDGE_HOME
    || path.join(os.homedir(), '.workbuddy-bridge'),
);
const sourceDshHome = path.resolve(
  process.env.WB_LIVE_DSH_HOME || path.join(os.homedir(), '.dsh'),
);
const temporary = fs.mkdtempSync(path.join(os.homedir(), '.wb-dsh-live-'));
const bridgeHome = path.join(temporary, 'bridge');
const dshHome = path.join(temporary, 'dsh-home');
const workspace = path.join(temporary, 'workspace');
process.once('exit', () => {
  try {
    fs.rmSync(temporary, { recursive: true, force: true });
  } catch {
    // 清理失败不影响验证结论。
  }
});

stageBridgeHome({ sourceBridgeHome, bridgeHome });
process.env.WB_BRIDGE_HOME = bridgeHome;
process.env.WB_COMMAND = path.join(temporary, 'missing-codebuddy-command');
process.env.WB_DEBUG = process.env.WB_DEBUG || '1';

const settings = await import('../../src/api-settings.js');
const pool = await import('../../src/pool.js');
const { createResponsesStore } = await import('../../src/responses-store.js');
const { createResponsesRuntime } = await import('../../src/api-responses.js');
const { createUpstreamClient } = await import('../../src/upstream-client.js');
const { startHttpServer } = await import('../../src/http.js');

const originalSettings = settings.getApiSettings();
const originalEnabled = Object.fromEntries(
  Object.entries(pool.loadPool().accounts).map(([name, entry]) => [
    name,
    Boolean(entry.enabled),
  ]),
);
if (!Object.hasOwn(originalEnabled, account)) {
  throw new Error(`live account not found: ${account}`);
}

const store = createResponsesStore({ directory: path.join(temporary, 'responses') });
const upstreamAttempts = [];
let bridge = null;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || workspace,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
          killTimer.unref?.();
        }, options.timeoutMs)
      : null;
    timer?.unref?.();
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        code: code ?? null,
        signal: timedOut ? 'TIMEOUT' : (signal ?? null),
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function createObservedUpstreamClient() {
  const client = createUpstreamClient();
  return {
    ...client,
    async chat(args) {
      const body = args.body || {};
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const observation = {
        model: args.model,
        stream: body.stream,
        message_count: messages.length,
        tools: Array.isArray(body.tools)
          ? body.tools.map((tool) => tool?.function?.name || tool?.name || null)
          : [],
        reasoning_effort: body.reasoning_effort ?? null,
        continuation_nudge: messages.some((message) => (
          message?.role === 'system'
          && typeof message?.content === 'string'
          && message.content.includes(CONTINUATION_NUDGE_MARKER)
        )),
      };
      try {
        const response = await client.chat(args);
        observation.status = response.status;
        if (!response.ok) {
          observation.detail = (await response.clone().text()).slice(0, 500);
        }
        upstreamAttempts.push(observation);
        return response;
      } catch (error) {
        observation.error = String(error?.message || error).slice(0, 500);
        upstreamAttempts.push(observation);
        throw error;
      }
    },
  };
}

/**
 * 在隔离 DSH_HOME 里搭一个 headless profile：只抄配置文件，
 * node_modules 用软链指回真实安装（只读），这样不用重装依赖。
 */
function stageDshHome(baseUrl) {
  const profileDir = path.join(dshHome, 'profiles', dshProfile);
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const sourceProfile = path.join(sourceDshHome, 'profiles', dshProfile);
  for (const file of ['cordis.yml', 'package.json']) {
    const source = path.join(sourceProfile, file);
    if (fs.existsSync(source)) copyFile(source, path.join(profileDir, file));
  }
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    throw new Error(`dsh profile ${dshProfile} has no package.json in ${sourceProfile}`);
  }
  for (const file of ['cordis.yml']) {
    if (!fs.existsSync(path.join(profileDir, file))) {
      fs.writeFileSync(path.join(profileDir, file), '[]\n');
    }
  }
  const modules = path.join(sourceDshHome, 'profiles', 'node_modules');
  if (!fs.existsSync(modules)) {
    throw new Error(`dsh shared node_modules is missing: ${modules}`);
  }
  const link = path.join(profileDir, 'node_modules');
  if (!fs.existsSync(link)) fs.symlinkSync(modules, link);

  const patch = path.join(dshHome, 'continuation-verify.patch.yml');
  fs.writeFileSync(patch, [
    '- id: agent-default-model',
    '  config:',
    `    provider: ${providerName}`,
    `    model: ${model}`,
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${providerName}:`,
    `        displayName: ${providerName}`,
    '        apiKeyEnv: WB_VERIFY_KEY',
    '        api: openai-responses',
    `        baseURL: ${JSON.stringify(`${baseUrl}/v1/`)}`,
    '        models:',
    `          - id: ${model}`,
    `            name: ${model}`,
    '            contextWindow: 1000000',
    '            maxTokens: 128000',
    '            reasoningEfforts:',
    '              off:',
    '              low: low',
    '              high: high',
    '              max: max',
    '',
  ].join('\n'), { mode: 0o600 });
  return patch;
}

try {
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });

  settings.updateApiSettings({
    enabled: true,
    openai: true,
    streaming: true,
    tools: true,
    responsesPersistence: true,
    responsesNudge: false,
    requireApiKey: false,
    remoteRequireKey: false,
    defaultModel: model,
  });
  for (const name of Object.keys(originalEnabled)) {
    pool.updateAccount(name, { enabled: name === account });
  }

  bridge = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    mcp: false,
    apiDeps: {
      responsesRuntime: createResponsesRuntime({
        store,
        upstreamClient: createObservedUpstreamClient(),
      }),
    },
  });
  const baseUrl = `http://127.0.0.1:${bridge.port}`;
  const patch = stageDshHome(baseUrl);

  const startedAt = Date.now();
  const result = await run(dshCommand, [
    '--profile', dshProfile,
    '--patch', patch,
    '--json',
    prompt,
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: temporary,
      DSH_HOME: dshHome,
      NODE_OPTIONS: '',
      WB_VERIFY_KEY: 'wb-live-loopback',
      NO_COLOR: '1',
    },
    timeoutMs,
  });
  const durationMs = Date.now() - startedAt;

  const files = ['calc.mjs', 'test.mjs', 'README.md']
    .filter((file) => fs.existsSync(path.join(workspace, file)));
  let testResult = null;
  if (expectFiles && files.length === 3) {
    testResult = await run(process.execPath, ['test.mjs'], { cwd: workspace });
  }

  const toolCalls = result.stdout.split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((event) => /tool/i.test(String(event.type || event.kind || '')));

  const nudgeExpected = !/^(0|false|no|off)$/i.test(
    String(process.env.WB_CONTINUATION_NUDGE || '').trim(),
  );
  const nudgeDelivered = upstreamAttempts.some(
    (attempt) => attempt.continuation_nudge && attempt.tools?.length,
  );
  const filesOk = expectFiles
    ? files.length === 3 && testResult?.code === 0
    : true;
  const passed = result.code === 0 && filesOk && (!nudgeExpected || nudgeDelivered);
  if (!passed) {
    throw new Error(JSON.stringify({
      exit_code: result.code,
      signal: result.signal,
      files,
      test_exit_code: testResult?.code ?? null,
      continuation_nudge_delivered: nudgeDelivered,
      upstream_attempts: upstreamAttempts,
      output_tail: `${result.stdout}\n${result.stderr}`.slice(-12_000),
    }));
  }

  console.log(JSON.stringify({
    ok: true,
    account,
    model,
    profile: dshProfile,
    duration_ms: durationMs,
    dsh: {
      version: (await run(dshCommand, ['--version'], { env: process.env })).stdout.trim(),
      events: result.stdout.split('\n').filter((line) => line.trim().startsWith('{')).length,
      tool_events: toolCalls.length,
    },
    continuation_nudge: {
      expected: nudgeExpected,
      delivered: nudgeDelivered,
    },
    upstream: {
      attempts: upstreamAttempts.length,
      efforts: upstreamAttempts.map((attempt) => attempt.reasoning_effort),
    },
    workspace: {
      files,
      test_passed: expectFiles ? testResult?.code === 0 : null,
    },
  }));
} finally {
  await bridge?.close({ graceMs: 2000 });
  await store.close();
  for (const [name, enabled] of Object.entries(originalEnabled)) {
    pool.updateAccount(name, { enabled });
  }
  settings.updateApiSettings({
    enabled: originalSettings.enabled,
    openai: originalSettings.openai,
    streaming: originalSettings.streaming,
    tools: originalSettings.tools,
    responsesPersistence: originalSettings.responsesPersistence,
    responsesNudge: originalSettings.responsesNudge,
    requireApiKey: originalSettings.requireApiKey,
    remoteRequireKey: originalSettings.remoteRequireKey,
    defaultModel: originalSettings.defaultModel,
  });
  removeTreeQuietly(temporary);
}
