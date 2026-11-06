#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';

const model = process.env.WB_LIVE_MODEL?.trim() || 'deepseek-v4-flash';
const baseUrl = process.env.WB_LIVE_BASE_URL?.trim();
const apiKey = process.env.WB_LIVE_API_KEY?.trim() || 'wb-live-loopback';
let bridge = null;

try {
  if (!baseUrl) {
    process.env.WB_COMMAND = path.join(os.tmpdir(), `wb-live-missing-codebuddy-${process.pid}`);
    const [{ default: OpenAI }, { startHttpServer }, settings] = await Promise.all([
      import('openai'),
      import('../../src/http.js'),
      import('../../src/api-settings.js'),
    ]);
    const previousOpenAI = settings.getApiSettings().openai;
    const verifyThinking = process.argv.includes('--thinking');
    settings.updateApiSettings({ enabled: true, openai: true, requireApiKey: false });
    bridge = await startHttpServer({ port: 0, host: '127.0.0.1', mcp: false });
    try {
      const client = new OpenAI({
        apiKey,
        baseURL: `http://127.0.0.1:${bridge.port}/v1`,
        maxRetries: 0,
      });
      const list = await client.models.list();
      if (!list.data.some((item) => item.id === model)) throw new Error(`model ${model} not found`);
      const response = await client.chat.completions.create({
        model,
        stream: false,
        messages: [
          { role: 'system', content: '你是严谨的算术助手。' },
          { role: 'user', content: verifyThinking ? '计算 17 × 23，再用结果减 391。先分析步骤，最后一行只回答数字。' : '只回答两个字：收到' },
        ],
      });
      const text = response.choices[0]?.message?.content;
      if (!text?.trim()) throw new Error('OpenAI API returned no text');
      if (verifyThinking && text.trim().split(/\r?\n/).at(-1)?.trim() !== '0') {
        throw new Error('OpenAI API returned an unexpected arithmetic result');
      }
      console.log([
        verifyThinking ? 'live ok (thinking prompt)' : 'live ok (text)',
        `model=${model}`,
        `text_chars=${text.length}`,
        'cli_required=false',
        'openai_sdk=true',
      ].join(' · '));
    } finally {
      settings.updateApiSettings({ openai: previousOpenAI });
    }
  } else {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      apiKey,
      baseURL: baseUrl.replace(/\/+$/, '').endsWith('/v1')
        ? baseUrl.replace(/\/+$/, '')
        : `${baseUrl.replace(/\/+$/, '')}/v1`,
      maxRetries: 0,
    });
    const response = await client.chat.completions.create({
      model,
      stream: false,
      messages: [{ role: 'user', content: '只回答两个字：收到' }],
    });
    const text = response.choices[0]?.message?.content;
    if (!text?.trim()) throw new Error('OpenAI API returned no text');
    console.log(`live ok · model=${model} · text_chars=${text.length} · external=true · openai_sdk=true`);
  }
} catch (error) {
  console.error(`live test failed: ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  await bridge?.close();
}
