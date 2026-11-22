
import { createSseParser } from '../src/sse.js';

const hr = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;

// 找一个 SSE 大事件在 TCP 分片（1448B）下开始变慢的拐点
function cost(eventBytes) {
  const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(Math.max(1, eventBytes - 120)) } }] }) + '\n\n';
  const p = createSseParser({ maxBufferBytes: 64 * 1024 * 1024 });
  const t0 = hr();
  for (let i = 0; i < payload.length; i += 1448) p.feed(payload.slice(i, i + 1448));
  return +ms(t0, hr()).toFixed(2);
}

const rows = [];
for (const kb of [8, 16, 32, 64, 96, 128, 192, 256, 384, 512]) {
  rows.push({ eventKB: kb, costMs: cost(kb * 1024) });
}
// 二次拟合检查：cost / (n^2)
const base = rows[0];
console.log(JSON.stringify({
  tcpSegmentBytes: 1448,
  curve: rows,
  ratio_512KB_vs_8KB_data_64x: +(rows[rows.length - 1].costMs / base.costMs).toFixed(0),
  note: 'linear would be 64x; quadratic would be 4096x',
}, null, 1));
