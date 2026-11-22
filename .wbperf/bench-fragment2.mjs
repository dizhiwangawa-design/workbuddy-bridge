
import { createSseParser } from '../src/sse.js';

const hr = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;
const med = (xs) => xs.slice().sort((p, q) => p - q)[Math.floor(xs.length / 2)];

function fragmented(eventBytes, sliceBytes, reps = 3) {
  const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(Math.max(1, eventBytes - 120)) } }] }) + '\n\n';
  const times = [];
  for (let r = 0; r < reps; r++) {
    const p = createSseParser({ maxBufferBytes: 64 * 1024 * 1024 });
    const t0 = hr();
    for (let i = 0; i < payload.length; i += sliceBytes) p.feed(payload.slice(i, i + sliceBytes));
    times.push(ms(t0, hr()));
  }
  return +med(times).toFixed(2);
}

// 真实 TCP/HTTP 分片尺寸
const rows = [];
for (const slice of [1448, 4096, 16384, 65536]) {
  rows.push({
    sliceBytes: slice,
    '256KB_event': fragmented(256 * 1024, slice),
    '1MB_event': fragmented(1024 * 1024, slice),
    '4MB_event': fragmented(4 * 1024 * 1024, slice),
  });
}
console.log(JSON.stringify({ realisticFragmentation: rows }, null, 1));
