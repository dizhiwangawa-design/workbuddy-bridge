#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';

const model = process.env.WB_LIVE_MODEL?.trim() || 'deepseek-v4.1-flash';
const externalBaseUrl = process.env.WB_LIVE_BASE_URL?.trim();
const apiKey = process.env.WB_LIVE_API_KEY?.trim() || 'wb-live-loopback';

let bridge = null;
let baseUrl = externalBaseUrl;

try {
  if (!baseUrl) {
    // API 路径必须不依赖 CLI。故意把命令指向不存在的文件来验证这一点。
    process.env.WB_COMMAND = path.join(
      os.tmpdir(),
      `wb-live-missing-codebuddy-${process.pid}`,
    );
    const [{ default: Anthropic }, { startHttpServer }] = await Promise.all([
      import('@anthropic-ai/sdk'),
      import('../../src/http.js'),
    ]);
    bridge = await startHttpServer({ port: 0, host: '127.0.0.1', mcp: false });
    baseUrl = `http://127.0.0.1:${bridge.port}`;

    const client = new Anthropic({
      apiKey,
      baseURL: baseUrl,
      maxRetries: 0,
    });
    const request = {
      model,
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: '只回答两个字：收到',
      }],
    };
    const estimate = await client.messages.countTokens(request);
    const message = await client.messages.create(request);
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (!text.trim()) throw new Error('Anthropic API returned no visible text');

    console.log([
      'live ok',
      `model=${model}`,
      `estimated_tokens_marked=${estimate.estimated === true}`,
      `text_chars=${text.length}`,
      'cli_required=false',
    ].join(' · '));
  } else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({
      apiKey,
      baseURL: baseUrl,
      maxRetries: 0,
    });
    const message = await client.messages.create({
      model,
      max_tokens: 64,
      messages: [{ role: 'user', content: '只回答两个字：收到' }],
    });
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (!text.trim()) throw new Error('Anthropic API returned no visible text');
    console.log(`live ok · model=${model} · text_chars=${text.length} · external=true`);
  }
} catch (error) {
  console.error(`live test failed: ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  await bridge?.close();
}
