
import { createSseParser } from '../src/sse.js';

const hr = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;
const med = (xs) => xs.slice().sort((p, q) => p - q)[Math.floor(xs.length / 2)];

// 病理路径：单个大事件，但网络把它切成很多小片到达。
// sse.js 每喂一次都 textBuffer.search(/\r\n|\n|\r/)，无换行时 search 扫完整个增长中的缓冲。
function fragmented(eventBodyBytes, sliceBytes, reps = 3) {
  const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(eventBodyBytes - 120) } }] }) + '\n\n';
  const times = [];
  for (let r = 0; r < reps; r++) {
    const p = createSseParser({ maxBufferBytes: 32 * 1024 * 1024 });
    const t0 = hr();
    for (let i = 0; i < payload.length; i += sliceBytes) p.feed(payload.slice(i, i + sliceBytes));
    times.push(ms(t0, hr()));
  }
  return { payloadBytes: payload.length, sliceBytes, medianMs: +med(times).toFixed(2) };
}

const rows = [];
for (const kb of [16, 64, 256, 1024]) {
  rows.push(fragmented(kb * 1024, 16));
}

// 对照：同样内容一次性喂入
function oneShot(eventBodyBytes, reps = 5) {
  const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(eventBodyBytes - 120) } }] }) + '\n\n';
  const times = [];
  for (let r = 0; r < reps; r++) {
    const p = createSseParser({ maxBufferBytes: 32 * 1024 * 1024 });
    const t0 = hr();
    p.feed(payload);
    times.push(ms(t0, hr()));
  }
  return { payloadBytes: payload.length, medianMs: +med(times).toFixed(2) };
}
const oneshots = [16, 64, 256, 1024].map((kb) => oneShot(kb * 1024));

// 放大比：16KB→1MB 是 64 倍数据量，看耗时放大多少
const growthRatio = rows[3].medianMs / rows[0].medianMs;
console.log(JSON.stringify({
  fragmented16ByteSlices: rows,
  growthRatio_16KB_to_1MB_64x_data: +growthRatio.toFixed(1),
  quadraticIf: 64 * 64,
  oneShotSameSize: oneshots,
}, null, 1));
