
import { createSseParser } from '../src/sse.js';

const hr = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;

// 复现上游真实节奏：每帧一个小 SSE 事件，40ms 间隔，帧间测量事件循环抖动
function jitterProbe(totalMs) {
  const samples = [];
  let last = process.hrtime.bigint();
  return new Promise((resolve) => {
    const t = setInterval(() => {
      const now = process.hrtime.bigint();
      samples.push(Number(now - last) / 1e6 - 1);
      last = now;
    }, 1);
    t.unref?.();
    setTimeout(() => { clearInterval(t); resolve(samples); }, totalMs);
  });
}

// A. 空转基线
const idle = await jitterProbe(400);

// B. 期间不断喂 SSE（模拟桥接解析）
const parser = createSseParser();
const chunk = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(40) } }] }) + '\n\n';
let feeding = true;
const feeder = (async () => {
  let n = 0;
  while (feeding) {
    parser.feed(chunk);
    n += 1;
    await new Promise((r) => setTimeout(r, 40));
  }
  return n;
})();
const withParse = await jitterProbe(400);
feeding = false;
const fed = await feeder;

// C. 大事件：单次 512KB SSE 事件在循环里解析（模拟长 tool result 到达）
const big = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'y'.repeat(512 * 1024) } }] }) + '\n\n';
const bigTimes = [];
for (let i = 0; i < 5; i++) {
  const p2 = createSseParser({ maxBufferBytes: 8 * 1024 * 1024 });
  const t0 = hr();
  p2.feed(big);
  bigTimes.push(ms(t0, hr()));
}
bigTimes.sort((a, b) => a - b);

const stats = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return { p50: +s[Math.floor(s.length * 0.5)].toFixed(2), p99: +s[Math.floor(s.length * 0.99)].toFixed(2), max: +s[s.length - 1].toFixed(2) };
};

console.log(JSON.stringify({
  idleJitterMs: stats(idle),
  parseDuringJitterMs: stats(withParse),
  chunksFed: fed,
  big512kParseMedianMs: +bigTimes[2].toFixed(2),
  big512kParseMaxMs: +bigTimes[4].toFixed(2),
}, null, 1));
