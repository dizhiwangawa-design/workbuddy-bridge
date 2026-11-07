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
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        '--max-semi-space-size=4',
        '--max-old-space-size=64',
      ]
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
  let peakAnonymousRssBytes = 0;
  let sampleQueue = Promise.resolve();
  const sampling = setInterval(() => {
    sampleQueue = sampleQueue.then(async () => {
    try {
      const status = await fs.promises.readFile(`/proc/${child.pid}/status`, 'utf8');
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
  // Node 24 sizes both V8 spaces from host resources. Keep the child's heaps
  // bounded so the RSS gates do not depend on the host's default heap policy.
  assert.ok(result.rssGrowthBytes < 128 * 1024 * 1024, line);
  // The child has bounded V8 heaps. Anonymous RSS is the stable memory-growth
  // guard; process-wide RSS also includes shared executable pages and is kept
  // below a bounded ceiling by its own sampler.
  assert.ok(peakAnonymousRssBytes < 128 * 1024 * 1024, `child anonymous RSS=${Math.round(peakAnonymousRssBytes / 1024)} KiB is beyond the process guard; ${line}`);
  assert.ok(result.peakRssBytes < 160 * 1024 * 1024, line);
});
