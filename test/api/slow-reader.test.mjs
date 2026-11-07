import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../load/slow-reader.mjs');

test('慢读大流量按 1 MiB 硬阈值中止，子进程 RSS 有界', { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, [script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WB_DEBUG: '',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-semi-space-size=8']
        .filter(Boolean)
        .join(' '),
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  let peakRssBytes = 0;
  let peakAnonymousRssBytes = 0;
  let sampleQueue = Promise.resolve();
  const sampling = setInterval(() => {
    sampleQueue = sampleQueue.then(async () => {
    try {
      const status = await fs.promises.readFile(`/proc/${child.pid}/status`, 'utf8');
      const hwm = Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] || 0);
      peakRssBytes = Math.max(peakRssBytes, hwm * 1024);
      const anon = Number(status.match(/^RssAnon:\s+(\d+)/m)?.[1] || 0);
      peakAnonymousRssBytes = Math.max(peakAnonymousRssBytes, anon * 1024);
    } catch {
      // The child may exit between samples.
    }
    });
  }, 25);
  let timeoutRef;
  const timeout = new Promise((_, reject) => {
    timeoutRef = setTimeout(() => reject(new Error(`slow-reader timed out\n${stderr}`)), 15000);
  });
  let code;
  try {
    [code] = await Promise.race([
      new Promise((resolve) => child.once('exit', (exitCode) => resolve([exitCode]))),
      timeout,
    ]);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  } finally {
    clearTimeout(timeoutRef);
  }
  clearInterval(sampling);
  await sampleQueue;
  assert.equal(code, 0, stderr);
  const line = stdout.trim().split('\n').at(-1);
  const result = JSON.parse(line);
  assert.equal(result.upstreamClosed, true);
  assert.equal(result.inflight, 0);
  assert.equal(result.writerStats.failedCode, 'BACKPRESSURE_OVERFLOW', line);
  assert.ok(result.producedBytes < 16 * 1024 * 1024, line);
  assert.ok(result.writerStats.peakPendingBytes < 2 * 1024 * 1024, line);
  assert.ok(result.peakHeapUsedBytes < 64 * 1024 * 1024, line);
  assert.ok(result.peakExternalBytes < 16 * 1024 * 1024, line);
  // Node 24 reserves a young generation based on host resources. Keep the
  // child's semi-space bounded, and use the kernel's process high-water mark
  // so the gate does not depend on a parent-side sampling race.
  assert.ok(result.rssGrowthBytes < 128 * 1024 * 1024, line);
  // VmHWM includes the executable and shared libraries mapped into this
  // process. The anonymous resident set is the memory this workload can
  // actually grow, so guard it together with bounded total process RSS.
  assert.ok(peakAnonymousRssBytes < 128 * 1024 * 1024, `child anonymous RSS=${Math.round(peakAnonymousRssBytes / 1024)} KiB is beyond the process guard; ${line}`);
  assert.ok(peakRssBytes < 192 * 1024 * 1024, `child total RSS=${Math.round(peakRssBytes / 1024)} KiB is beyond the process guard; ${line}`);
});
