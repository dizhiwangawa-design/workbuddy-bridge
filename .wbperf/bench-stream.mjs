
import { createSseParser } from '../src/sse.js';
import { createDsmlScanner } from '../src/tool-calls.js';

const hr = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;
const med = (xs) => xs.slice().sort((p, q) => p - q)[Math.floor(xs.length / 2)];

function sseChunk(i, n) {
  const payload = JSON.stringify({
    id: 'chatcmpl-x', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'x'.repeat(14) }, finish_reason: null }],
  });
  return 'data: ' + payload + '\n\n';
}

function benchSse(chunks, reps) {
  const times = [];
  let events = 0;
  for (let r = 0; r < reps; r++) {
    const p = createSseParser();
    const t0 = hr();
    let n = 0;
    for (let i = 0; i < chunks; i++) n += p.feed(sseChunk(i, chunks)).length;
    const t1 = hr();
    times.push(ms(t0, t1));
    events = n;
  }
  return { medianMs: med(times), events };
}

const small = benchSse(2000, 5);
const big = benchSse(20000, 5);

const dsmlBody = 'x'.repeat(200 * 1024);
function benchDsml(frames, reps) {
  const times = [];
  for (let r = 0; r < reps; r++) {
    const s = createDsmlScanner({ maxBufferBytes: 4 * 1024 * 1024 });
    const t0 = hr();
    s.push('<||DSML||tool_calls><||DSML||invoke name="write"><||DSML||parameter name="c">');
    const step = Math.ceil(dsmlBody.length / frames);
    for (let i = 0; i < frames; i++) s.push(dsmlBody.slice(i * step, (i + 1) * step));
    s.push('</||DSML||parameter></||DSML||invoke></||DSML||tool_calls>');
    s.finish();
    times.push(ms(t0, hr()));
  }
  return med(times);
}
const d10 = benchDsml(10, 3);
const d40 = benchDsml(40, 3);

const bigEvent = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'y'.repeat(512 * 1024) } }] }) + '\n\n';
const t0 = hr();
const p = createSseParser({ maxBufferBytes: 4 * 1024 * 1024 });
p.feed(bigEvent);
const bigEventMs = ms(t0, hr());

console.log(JSON.stringify({
  sse: { chunks2000Ms: +small.medianMs.toFixed(3), chunks20000Ms: +big.medianMs.toFixed(3), events: small.events, scaleRatio: +(big.medianMs / small.medianMs).toFixed(2) },
  dsml: { frames10Ms: +d10.toFixed(3), frames40Ms: +d40.toFixed(3), scaleRatio: +(d40 / d10).toFixed(2) },
  bigEvent512kMs: +bigEventMs.toFixed(3),
}, null, 1));
