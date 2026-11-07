#!/usr/bin/env node
/**
 * 测试用的假 codebuddy。
 *
 * 两种模式：
 *  - 不带 -p：模仿登录 TUI —— 先渲染选择菜单、等回车、再吐折行的授权链接。
 *  - 带 -p：按环境变量返回不同结果，用来驱动号池的调度与故障切换。
 *      WB_FAKE_MODE=auth|ok|ratelimit|dead|fail      全局行为
 *      WB_FAKE_PER_ACCOUNT=1                          按账号目录名推断（bad / limited / dead 前缀）
 */
import path from 'node:path';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const isPrint = argv.includes('-p') || argv.includes('--print');

function result(obj, exitCode) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(exitCode);
}

function modeFor() {
  if (process.env.WB_FAKE_MODE) return process.env.WB_FAKE_MODE;
  if (!process.env.WB_FAKE_PER_ACCOUNT) return 'auth';

  const dir = path.basename(process.env.CODEBUDDY_CONFIG_DIR || 'default');
  if (/bad|expired/i.test(dir)) return 'auth';
  if (/limited|quota/i.test(dir)) return 'ratelimit';
  if (/dead|broken/i.test(dir)) return 'dead';
  if (/fail/i.test(dir)) return 'fail';
  return 'ok';
}

if (isPrint) {
  const mode = modeFor();

  if (mode === 'auth') {
    result({ type: 'result', subtype: 'error', is_error: true, result: 'please log in first' }, 1);
  }
  if (mode === 'ratelimit') {
    process.stderr.write('API error 429: rate limit exceeded, retry later\n');
    result({ type: 'result', subtype: 'error', is_error: true, result: 'rate limit exceeded' }, 1);
  }
  if (mode === 'dead') {
    process.stderr.write('boom\n');
    process.exit(2);
  }
  if (mode === 'fail') {
    result({ type: 'result', subtype: 'error', is_error: true, result: 'something went wrong' }, 1);
  }

  const prompt = argv.filter((a) => !a.startsWith('-')).join(' ');
  result(
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      session_id: 'fake-session',
      duration_ms: 12,
      duration_api_ms: 11,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {
        input_tokens: 1200 + prompt.length,
        output_tokens: 200,
        cache_read_input_tokens: 300,
      },
      modelUsage: { 'deepseek-v4.1-flash': { inputTokens: 1200, outputTokens: 200, contextWindow: 256000 } },
    },
    0,
  );
}

const url =
  'https://copilot.tencent.com/auth/cli?code=TESTCODE1234567890&state=' +
  'abcdefghijklmnopqrstuvwxyz0123456789';

process.stdout.write('\x1b[2J');

if (process.env.WB_FAKE_TRUST_PROMPT === '1') {
  process.stdout.write('Do you trust the files in this folder?\n');
  process.stdout.write('> 1. Trust folder only (login-workspace)\n');
  process.stdout.write('Enter to confirm • Esc to exit\n');
}

let inputCount = 0;
let sawPromptText = false;

function showLogin() {
  process.stdout.write('\x1b[2J');
  process.stdout.write('Select login method:\n');
  process.stdout.write('  Log in via Chinese Site\n');
  process.stdout.write('  Log in via International Site\n');
  process.stdout.write('(Use ↑↓ to select, Enter to login)\n');
}

if (process.env.WB_FAKE_MAIN_THEN_LOGIN === '1') {
  process.stdout.write('\x1b[2J');
  process.stdout.write('Welcome to CodeBuddy\n');
  process.stdout.write('Type your message\n');
} else if (process.env.WB_FAKE_TRUST_PROMPT !== '1') {
  showLogin();
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  inputCount++;
  if (
    process.env.WB_FAKE_MAIN_THEN_LOGIN === '1' &&
    process.env.WB_FAKE_SPLIT_ENTER !== '1' &&
    inputCount > 1
  ) return;
  if (process.env.WB_FAKE_SPLIT_ENTER === '1' && !sawPromptText) {
    sawPromptText = true;
    return;
  }
  if (process.env.WB_FAKE_TRUST_PROMPT === '1' && inputCount === 1) {
    showLogin();
    return;
  }
  if (process.env.WB_FAKE_LOGIN_URL_LOG === '1') {
    const logDir = path.join(process.env.CODEBUDDY_CONFIG_DIR, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'login-workspace__fake.log'), `Opening auth URL: ${url}\n`);
  } else {
    process.stdout.write("\nBrowser didn't open? Use the url below to sign in:\n");
    // 故意折行，模拟 Ink 在窄终端里的渲染
    process.stdout.write(url.slice(0, 40) + '\n' + url.slice(40) + '\n');
  }
  process.stdout.write('\nWaiting for auth... (Press ESC to cancel)\n');
  setTimeout(() => process.exit(0), 60000);
});
process.stdin.resume();
