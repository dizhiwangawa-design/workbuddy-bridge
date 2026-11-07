#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const model = process.env.WB_LIVE_MODEL?.trim() || 'deepseek-v4.1-flash';
const account = process.env.WB_LIVE_ACCOUNT?.trim() || 'default';
const codexCommand = process.env.WB_CODEX_COMMAND?.trim() || 'codex';
const timeoutMs = Math.max(
  30_000,
  Number(process.env.WB_CODEX_TIMEOUT_MS) || 240_000,
);
const expectFiles = /^(1|true|yes)$/i.test(process.env.WB_CODEX_EXPECT_FILES || '')
  || !process.env.WB_CODEX_PROMPT;
const prompt = process.env.WB_CODEX_PROMPT?.trim() || [
  'You are in an isolated temporary coding workspace.',
  'Complete this multi-step coding task without asking questions:',
  'Do not send a preamble or a plan. Your first action must be a tool call.',
  '1. Create calc.mjs exporting an add(a,b) function.',
  '2. Create test.mjs that imports add and asserts add(2,3) === 5.',
  '3. Run node test.mjs and fix any failure.',
  '4. Create README.md with one line describing the module.',
  'Use apply_patch to write files, then use exec_command to run the test.',
  'Do not stop after describing what you will do.',
  'Finish only after the test passes.',
].join('\n');

const sourceBridgeHome = path.resolve(
  process.env.WB_LIVE_BRIDGE_HOME
    || path.join(os.homedir(), '.workbuddy-bridge'),
);
const temporary = fs.mkdtempSync(path.join(os.homedir(), '.wb-codex-live-'));
const bridgeHome = path.join(temporary, 'bridge');
const codexHome = path.join(temporary, 'codex-home');
const workspace = path.join(temporary, 'workspace');
process.once('exit', () => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

function copyBridgeState() {
  fs.mkdirSync(path.join(bridgeHome, 'profiles'), { recursive: true, mode: 0o700 });
  for (const file of ['config.json', 'pool.json', 'accounts.json']) {
    const source = path.join(sourceBridgeHome, file);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(bridgeHome, file));
      fs.chmodSync(path.join(bridgeHome, file), 0o600);
    }
  }
  const sourceProfiles = path.join(sourceBridgeHome, 'profiles');
  if (!fs.existsSync(sourceProfiles)) {
    throw new Error('bridge profiles directory is missing');
  }
  fs.cpSync(sourceProfiles, path.join(bridgeHome, 'profiles'), {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });

  const accountsFile = path.join(bridgeHome, 'accounts.json');
  if (!fs.existsSync(accountsFile)) {
    throw new Error('bridge accounts.json is missing');
  }
  const store = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
  for (const [name, record] of Object.entries(store.accounts || {})) {
    const relative = path.relative(sourceProfiles, String(record.profileDir || ''));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`account profile path is outside the bridge home: ${name}`);
    }
    record.profileDir = path.join(bridgeHome, 'profiles', relative);
  }
  fs.writeFileSync(accountsFile, JSON.stringify(store, null, 2), { mode: 0o600 });
}

copyBridgeState();
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

const store = createResponsesStore({
  directory: path.join(temporary, 'responses'),
});
let bridge = null;
let wsUpgrades = 0;
let httpResponses = 0;
const upstreamAttempts = [];
const responseChunks = [];

function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve) => {
    const poll = () => {
      if (predicate()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(poll, 25);
    };
    poll();
  });
}

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
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
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

function codexConfig(baseUrl) {
  return [
    `model = ${JSON.stringify(model)}`,
    'model_provider = "workbuddy"',
    'model_reasoning_effort = "none"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'web_search = "disabled"',
    '',
    '[model_providers.workbuddy]',
    'name = "WorkBuddy"',
    `base_url = ${JSON.stringify(`${baseUrl}/v1`)}`,
    'wire_api = "responses"',
    'env_key = "WB_API_KEY"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    'stream_idle_timeout_ms = 300000',
    '',
  ].join('\n');
}

function codexArgs(lastMessage) {
  return [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-rules',
    '--json',
    '--sandbox', 'danger-full-access',
    '-C', workspace,
    '--output-last-message', lastMessage,
    '--disable', 'plugins',
    '--disable', 'remote_plugin',
    '--disable', 'apps',
    '--disable', 'browser_use',
    '--disable', 'computer_use',
    '--disable', 'image_generation',
    '--disable', 'multi_agent',
    '--disable', 'multi_agent_v2',
    '--disable', 'tool_suggest',
    '--disable', 'hooks',
    '--disable', 'goals',
    '--disable', 'workspace_dependencies',
    prompt,
  ];
}

function eventCount(output) {
  return output.split('\n').filter((line) => line.trim().startsWith('{')).length;
}

function summarizeResponseEvents() {
  const raw = Buffer.concat(responseChunks).toString('utf8');
  const events = raw.split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
    .filter(Boolean)
    .map((data) => {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const counts = {};
  for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
  const terminal = events.findLast((event) => [
    'response.completed',
    'response.failed',
    'response.incomplete',
  ].includes(event.type));
  const finalCalls = (terminal?.response?.output || []).filter((item) => (
    ['function_call', 'custom_tool_call'].includes(item.type)
  ));
  const toolIdentityOk = finalCalls.every((call) => {
    const added = events.find((event) => (
      event.type === 'response.output_item.added'
      && event.item?.id === call.id
    ));
    const done = events.find((event) => (
      event.type === 'response.output_item.done'
      && event.item?.id === call.id
    ));
    return added?.item?.type === call.type
      && done?.item?.type === call.type
      && added.item.call_id === call.call_id
      && done.item.call_id === call.call_id
      && done.item.name === call.name;
  });
  return {
    bytes: Buffer.byteLength(raw),
    counts,
    tool_identity_ok: toolIdentityOk,
    terminal: terminal ? {
      type: terminal.type,
      status: terminal.response?.status || terminal.response?.response?.status || null,
      output: (terminal.response?.output || []).map((item) => ({
        type: item?.type,
        name: item?.name || null,
        call_id: item?.call_id || null,
      })),
    } : null,
  };
}

function createObservedUpstreamClient() {
  const client = createUpstreamClient();
  return {
    ...client,
    async chat(args) {
      const body = args.body || {};
      const observation = {
        model: args.model,
        stream: body.stream,
        messages: Array.isArray(body.messages)
          ? body.messages.map((message) => ({
              role: message?.role || null,
              content_type: Array.isArray(message?.content) ? 'array' : typeof message?.content,
              content_length: typeof message?.content === 'string'
                ? message.content.length
                : JSON.stringify(message?.content || '').length,
              tool_calls: Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0,
            }))
          : [],
        tools: Array.isArray(body.tools)
          ? body.tools.map((tool) => ({
              type: tool?.type || null,
              name: tool?.function?.name || tool?.name || null,
              description_length: String(tool?.function?.description || tool?.description || '').length,
              parameter_keys: Object.keys(tool?.function?.parameters?.properties || {}),
            }))
          : [],
        tool_choice: body.tool_choice || null,
        parallel_tool_calls: body.parallel_tool_calls ?? null,
        max_tokens: body.max_tokens ?? null,
        response_format: body.response_format?.type || null,
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

try {
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
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
  bridge.server.on('upgrade', (req) => {
    if (String(req.url || '').startsWith('/v1/responses')) wsUpgrades += 1;
  });
  bridge.server.on('request', (req) => {
    if (req.method === 'POST' && String(req.url || '').startsWith('/v1/responses')) {
      httpResponses += 1;
    }
  });
  bridge.server.on('request', (req, res) => {
    if (req.method !== 'POST' || !String(req.url || '').startsWith('/v1/responses')) return;
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = (chunk, ...args) => {
      if (chunk) responseChunks.push(Buffer.from(chunk));
      return write(chunk, ...args);
    };
    res.end = (chunk, ...args) => {
      if (chunk) responseChunks.push(Buffer.from(chunk));
      return end(chunk, ...args);
    };
  });

  const baseUrl = `http://127.0.0.1:${bridge.port}`;
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    codexConfig(baseUrl),
    { mode: 0o600 },
  );

  const lastMessage = path.join(temporary, 'codex-last.txt');
  const before = pool.poolView().accounts.find((item) => item.name === account);
  const startedAt = Date.now();
  const result = await run(codexCommand, codexArgs(lastMessage), {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      WB_API_KEY: 'wb-live-loopback',
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
  const leaseReleased = await waitFor(
    () => pool.poolView().accounts.find((item) => item.name === account)?.inflight === 0,
  );
  const finalRow = pool.poolView().accounts.find((item) => item.name === account);

  const passed = result.code === 0
    && leaseReleased
    && summarizeResponseEvents().tool_identity_ok
    && (!expectFiles
      ? fs.existsSync(lastMessage)
      : files.length === 3 && testResult?.code === 0);
  if (!passed) {
    const safeOutput = `${result.stdout}\n${result.stderr}`.slice(-12_000);
    throw new Error(JSON.stringify({
      exit_code: result.code,
      signal: result.signal,
      files,
      test_exit_code: testResult?.code ?? null,
      lease_released: leaseReleased,
      upstream_attempts: upstreamAttempts,
      response_events: summarizeResponseEvents(),
      output_tail: safeOutput,
    }));
  }

  console.log(JSON.stringify({
    ok: true,
    account,
    model,
    duration_ms: durationMs,
    codex: {
      version: (await run(codexCommand, ['--version'], { env: process.env })).stdout.trim(),
      events: eventCount(result.stdout),
      last_message_chars: fs.readFileSync(lastMessage, 'utf8').trim().length,
    },
    transport: {
      websocket_upgrades: wsUpgrades,
      http_response_requests: httpResponses,
    },
    response_events: summarizeResponseEvents(),
    workspace: {
      files,
      test_passed: expectFiles ? testResult?.code === 0 : null,
    },
    pool: {
      inflight: finalRow?.inflight ?? null,
      requests_added: finalRow
        ? finalRow.today.req - before.today.req
        : null,
      status: finalRow?.status ?? null,
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
  fs.rmSync(temporary, { recursive: true, force: true });
}
