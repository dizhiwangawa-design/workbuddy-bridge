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
    const verifyTools = process.argv.includes('--tools');
    settings.updateApiSettings({ enabled: true, openai: true, requireApiKey: false });
    bridge = await startHttpServer({ port: 0, host: '127.0.0.1', mcp: false });
    let toolRoundtripComplete = false;
    try {
      const client = new OpenAI({
        apiKey,
        baseURL: `http://127.0.0.1:${bridge.port}/v1`,
        maxRetries: 0,
      });
      if (verifyTools) {
        const tools = [{
          type: 'function',
          function: {
            name: 'record_value',
            description: 'Record a value supplied by the caller.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'number' } },
              required: ['value'],
            },
          },
        }];
        const first = await client.chat.completions.create({
          model,
          messages: [{
            role: 'user',
            content: 'Call record_value exactly once with value 391. Do not answer in prose.',
          }],
          tools,
          tool_choice: {
            type: 'function',
            function: { name: 'record_value' },
          },
        });
        const message = first.choices[0]?.message;
        const call = message?.tool_calls?.[0];
        if (first.choices[0]?.finish_reason !== 'tool_calls' || !call) {
          throw new Error('OpenAI tools live test returned no tool_calls');
        }
        let args;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          throw new Error('OpenAI tools live test returned invalid arguments');
        }
        if (call.function.name !== 'record_value' || args.value !== 391) {
          throw new Error('OpenAI tools live test returned an unexpected call');
        }
        const second = await client.chat.completions.create({
          model,
          messages: [
            {
              role: 'user',
              content: 'Call record_value exactly once with value 391. Do not answer in prose.',
            },
            message,
            {
              role: 'tool',
              tool_call_id: call.id,
              content: 'The value 391 was accepted. Confirm with exactly the number 391 and no other text.',
            },
          ],
          tools,
          tool_choice: 'none',
        });
        const finalText = second.choices[0]?.message?.content;
        if (!finalText?.includes('391')) {
          throw new Error('OpenAI tool continuation did not use the tool result');
        }
        console.log([
          'live ok (tool roundtrip)',
          `model=${model}`,
          `rounds=${second.choices[0]?.finish_reason === 'stop' ? 2 : 1}`,
          'tool_name=record_value',
          'argument_value=391',
          'continuation=text',
          'cli_required=false',
          'openai_sdk=true',
        ].join(' · '));
        toolRoundtripComplete = true;
      }
      if (!verifyTools) {
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
      }
      if (verifyTools && !toolRoundtripComplete) {
        throw new Error('OpenAI tool roundtrip did not complete');
      }
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
