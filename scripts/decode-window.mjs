#!/usr/bin/env node
// 统计一次 dsh 会话的 decode 窗口与步型分布。
//
// 口径与 @deepseek-ai/dsh-session-stats 的 sessionStats 投影一致：
//   decodeMs = t(assistant/message) − t(首个可见增量)
//   零窗口   = decodeMs <= 5ms（整步可见内容在同一毫秒内到达）
//   tps      = ΣoutputTokens / ΣdecodeMs
//
// 用法：
//   node scripts/decode-window.mjs <session.v4.jsonl.zstd | session.v4.jsonl>
//
// 步型：R=有推理，T=有工具调用，X=有正文。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/decode-window.mjs <session.v4.jsonl.zstd>');
  process.exit(2);
}
const raw = file.endsWith('.zstd')
  ? execFileSync('zstd', ['-dc', file], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
  : fs.readFileSync(file, 'utf8');
const events = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));

/** 压缩记录内的时间点：time0 加上累计 dt。 */
function runTimes(run) {
  const times = [run.time0];
  for (const dt of run.dt || []) times.push(times[times.length - 1] + dt);
  return times;
}

function isTokenDelta(chunk) {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text !== '';
  if (chunk.type === 'tool-call-delta') {
    return chunk.argumentsDelta !== '' || chunk.name !== undefined;
  }
  return false;
}

/** 该步第一条可见增量的时间；没有可见增量时返回 undefined。 */
function firstVisibleTime(stream) {
  for (const record of stream) {
    if (record.type === 'chunk') {
      if (isTokenDelta(record.chunk)) return record.time;
      continue;
    }
    const times = runTimes(record);
    if (record.type === 'tool-call-chunks') {
      if (record.name !== undefined) return record.time0;
      if ((record.args || []).length) return times[Math.min(1, times.length - 1)];
      continue;
    }
    const texts = record.texts || [];
    for (let i = 0; i < texts.length; i += 1) {
      if (texts[i] && texts[i].trim()) return times[Math.min(i, times.length - 1)];
    }
  }
  return undefined;
}

const hasRun = (stream, type) => stream.some((record) => record.type === type);

const rows = [];
for (const event of events) {
  if (event.type !== 'assistant/message') continue;
  const stream = event.data?.stream || [];
  const tokens = event.data?.usage?.outputTokens || 0;
  if (!tokens) continue;
  const first = firstVisibleTime(stream);
  rows.push({
    key: `${hasRun(stream, 'reasoning-chunks') ? 'R' : '-'}`
      + `${hasRun(stream, 'tool-call-chunks') ? 'T' : '-'}`
      + `${hasRun(stream, 'text-chunks') ? 'X' : '-'}`,
    tokens,
    span: first === undefined ? 0 : Math.max(0, event.time - first),
  });
}

if (!rows.length) {
  console.error('no assistant steps with usage found');
  process.exit(1);
}

const total = rows.reduce((sum, row) => sum + row.tokens, 0);
const decodeMs = rows.reduce((sum, row) => sum + row.span, 0);
const zero = rows.filter((row) => row.span <= 5);
const zeroTokens = zero.reduce((sum, row) => sum + row.tokens, 0);

console.log(
  `steps=${rows.length} outputTokens=${total} decodeMs=${decodeMs} `
  + `tps=${(total / (decodeMs / 1000)).toFixed(1)}`,
);
console.log(
  `zeroWindowSteps=${zero.length} zeroWindowTokens=${zeroTokens} `
  + `(${(100 * zeroTokens / total).toFixed(1)}%)`,
);

const byKind = new Map();
for (const row of rows) {
  const acc = byKind.get(row.key) || { steps: 0, tokens: 0, zero: 0 };
  acc.steps += 1;
  acc.tokens += row.tokens;
  if (row.span <= 5) acc.zero += 1;
  byKind.set(row.key, acc);
}
for (const [kind, acc] of [...byKind].sort()) {
  console.log(
    `  ${kind}  steps=${String(acc.steps).padStart(4)} `
    + `tokens=${String(acc.tokens).padStart(7)} (${(100 * acc.tokens / total).toFixed(1)}%) `
    + `zeroSteps=${acc.zero}`,
  );
}
