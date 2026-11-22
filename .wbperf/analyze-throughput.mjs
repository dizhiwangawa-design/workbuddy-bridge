
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const pool = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy-bridge', 'pool.json'), 'utf8'));
const ev = pool.series?.events || [];
const sum = (k) => ev.reduce((s, e) => s + (e[k] || 0), 0);
const totalMs = sum('ms');
const totalOut = sum('tout');
const totalIn = sum('tin');
// 若上游解码速度按观测到的 p90 = 190 tok/s，则 1175 输出 token 需要多少 ms？
const medOut = 1175, medMs = 8489;
const decodeBound = (tps) => Math.round((medOut / tps) * 1000);
console.log(JSON.stringify({
  requests: ev.length,
  totalWallMs: totalMs,
  aggregateTokPerSec: +(totalOut / (totalMs / 1000)).toFixed(1),
  medianRequestMs: 8489,
  medianOutputTokens: medOut,
  impliedDecodeMs_at_50tps: decodeBound(50),
  impliedDecodeMs_at_110tps: decodeBound(110),
  impliedDecodeMs_at_190tps: decodeBound(190),
  residualIfDecodeIs110tps: medMs - decodeBound(110),
}, null, 1));
