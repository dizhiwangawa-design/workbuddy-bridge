
import { sanitizeChatBody } from '../src/upstream-client.js';
import { conservativeTokenEstimate } from '../src/protocols/anthropic.js';

const hr = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;
const med = (xs) => xs.slice().sort((p, q) => p - q)[Math.floor(xs.length / 2)];
function bench(fn, reps = 7) {
  fn();
  const s = [];
  for (let i = 0; i < reps; i++) { const t0 = hr(); fn(); s.push(ms(t0, hr())); }
  return +med(s).toFixed(3);
}

// 构造一个真实 agent 会话：system 提示 + N 轮工具结果
function buildBody(toolResultKb, turns) {
  const msgs = [{ role: 'system', content: 'You are an AI coding agent. ' + 'rule '.repeat(200) }];
  const payload = 'x'.repeat(toolResultKb * 1024);
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'user', content: 'run step ' + i });
    msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] });
    msgs.push({ role: 'tool', tool_call_id: 'c' + i, content: payload });
  }
  return {
    model: 'deepseek-v4.1-flash',
    stream: true,
    max_tokens: 8192,
    messages: msgs,
    tools: [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
  };
}

const rows = [];
for (const [kb, turns] of [[50, 1], [200, 2], [800, 4], [2000, 5]]) {
  const body = buildBody(kb, turns);
  const bytes = Buffer.byteLength(JSON.stringify(body));
  const clone = bench(() => structuredClone(body));
  const scrub = bench(() => sanitizeChatBody(body));
  const stringify = bench(() => JSON.stringify(body));
  const estimate = bench(() => conservativeTokenEstimate(body));
  const parseBack = bench(() => JSON.parse(JSON.stringify(body)));
  rows.push({ contextKB: Math.round(bytes / 1024), cloneMs: clone, scrubMs: scrub, stringifyMs: stringify, estimateMs: estimate, parseMs: parseBack });
}
console.log(JSON.stringify(rows, null, 1));
