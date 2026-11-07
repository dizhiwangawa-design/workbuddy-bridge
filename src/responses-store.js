import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { BRIDGE_HOME, ensureDir } from './paths.js';
import { warn } from './log.js';
import { utf8Prefix } from './stream-control.js';

const MAX_RECORDS = 256;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_MEMORY = 64;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_PARTIAL_BYTES = 8 * 1024 * 1024;
const WRITE_TIMEOUT_MS = 2000;
const MAX_PERSISTED_TEXT_BYTES = 256 * 1024;

function workerExecArgv(args = process.execArgv) {
  const filtered = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--input-type' || arg === '--eval' || arg === '--print'
      || arg === '-e' || arg === '-p') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--input-type=') || arg.startsWith('--eval=')
      || arg.startsWith('--print=')) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

export function compactResponseForStore(response) {
  let textBudget = MAX_PERSISTED_TEXT_BYTES;
  const clip = (value) => {
    const text = String(value ?? '');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= textBudget) {
      textBudget -= bytes;
      return text;
    }
    const kept = textBudget > 0 ? utf8Prefix(text, textBudget) : '';
    textBudget = 0;
    return kept;
  };
  const output = (response?.output || []).map((item) => {
    if (item?.type === 'message') return {
      ...item,
      content: (item.content || []).map((part) => (
        part?.type === 'output_text' ? { ...part, text: clip(part.text) } : part
      )),
    };
    if (item?.type === 'reasoning') return {
      ...item,
      summary: (item.summary || []).map((part) => (
        part?.type === 'summary_text' ? { ...part, text: clip(part.text) } : part
      )),
    };
    if (item?.type === 'custom_tool_call') return { ...item, input: clip(item.input) };
    if (item?.type === 'function_call') return { ...item, arguments: clip(item.arguments) };
    return item;
  });
  return { ...response, output };
}

function recordSize(record) {
  try {
    return Buffer.byteLength(JSON.stringify(record), 'utf8');
  } catch {
    return MAX_BYTES;
  }
}

function atomicWrite(file, raw, mode) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temporary, raw, { mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, file);
}

export function partialBodyFromOutput(output) {
  const text = [];
  const calls = [];
  for (const item of Array.isArray(output) ? output : []) {
    if (item?.type === 'message') {
      for (const part of item.content || []) {
        if (part?.type === 'output_text' && typeof part.text === 'string') text.push(part.text);
      }
    }
    if (item?.type === 'function_call' && typeof item.name === 'string') {
      let input = item.arguments;
      try {
        input = JSON.parse(item.arguments || '{}');
      } catch {
        continue;
      }
      calls.push({ id: item.call_id, name: item.name, input });
    }
  }
  const body = {};
  if (text.length) body.content = text.join('');
  if (calls.length) body.toolCalls = calls;
  return body;
}

export function outputFromPartial(partial) {
  const output = [];
  const text = typeof partial?.content === 'string' ? partial.content : '';
  if (text) output.push({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  });
  for (const call of Array.isArray(partial?.toolCalls) ? partial.toolCalls : []) {
    output.push({
      type: 'function_call',
      call_id: call.id || call.call_id,
      name: call.name,
      arguments: JSON.stringify(call.input ?? call.arguments ?? {}),
    });
  }
  return output;
}

export function mergePartialOutput(base, partial) {
  const text = typeof partial?.content === 'string' ? partial.content : '';
  const calls = Array.isArray(partial?.toolCalls) ? partial.toolCalls : [];
  const output = [];
  let matchedMessage = false;
  for (const item of Array.isArray(base) ? base : []) {
    if (item?.type === 'message') {
      const original = item.content?.map((part) => part.text || '').join('') || '';
      const mergedText = !matchedMessage && text && !original.includes(text)
        ? `${original}${text}`
        : original;
      matchedMessage = true;
      output.push({
        ...item,
        content: [{
          type: 'output_text',
          text: mergedText,
          annotations: [],
        }],
      });
      continue;
    }
    output.push(item);
  }
  if (!output.some((item) => item.type === 'message')) {
    output.push(...outputFromPartial({ content: text }).filter((item) => item.type === 'message'));
  }
  output.push(...outputFromPartial({ toolCalls: calls }).filter((item) => (
    !output.some((existing) => existing.call_id === item.call_id)
  )));
  return output;
}

export function createDeadLetter({
  file = path.join(BRIDGE_HOME, 'responses-dead-letter.jsonl'),
  now = Date.now,
} = {}) {
  let startupComplete = false;

  function entries() {
    try {
      return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function rewrite(rows) {
    if (!rows.length) {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== 'ENOENT') warn(`dead-letter cleanup failed: ${error.code}`);
      }
      return;
    }
    atomicWrite(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 0o600);
  }

  function exists(responseId) {
    return entries().some((row) => row.response_id === responseId);
  }

  return {
    file,
    entries,
    exists,
    append(entry) {
      if (exists(entry.response_id)) return false;
      ensureDir(path.dirname(file));
      const row = {
        response_id: entry.response_id,
        partial: entry.partial || {},
        cancel_reason: entry.cancelReason || 'canceled',
        phase: entry.phase || 'generation',
        usage: entry.usage || {},
        input: Array.isArray(entry.input) ? entry.input : [],
        previous_response_id: entry.previousResponseId || entry.previous_response_id || null,
        save_status: 'failed',
        db_error: String(entry.error?.code || entry.error?.message || 'database write failed').slice(0, 300),
        created_at: new Date(now()).toISOString(),
      };
      if (recordSize(row) > MAX_PARTIAL_BYTES) return false;
      atomicWrite(file, `${[...entries(), row].map((item) => JSON.stringify(item)).join('\n')}\n`, 0o600);
      return true;
    },
    remove(responseId) {
      const rows = entries();
      const kept = rows.filter((row) => row.response_id !== responseId);
      if (kept.length !== rows.length) rewrite(kept);
    },
    async retryOnce(insert) {
      if (startupComplete) return { attempted: 0, recovered: 0 };
      startupComplete = true;
      const rows = entries();
      let recovered = 0;
      let attempted = 0;
      for (const row of rows) {
        attempted += 1;
        try {
          const saved = await insert(row);
          if (saved) {
            this.remove(row.response_id);
            recovered += 1;
          }
        } catch (error) {
          warn(`dead-letter retry remains undelivered: ${error.code || error.message}`);
        }
      }
      return { attempted, recovered };
    },
  };
}

export function createResponsesStore({
  directory = path.join(BRIDGE_HOME, 'responses'),
  now = Date.now,
  sqliteModule = null,
  writeTimeoutMs = WRITE_TIMEOUT_MS,
  busyTimeoutMs = WRITE_TIMEOUT_MS,
  slowForTestMs: defaultSlowForTestMs = 0,
  deadLetter = createDeadLetter({ now }),
  failPersist = null,
  workerScript = new URL('./responses-store-worker.js', import.meta.url),
} = {}) {
  ensureDir(directory);
  const memory = new Map();
  const deadLetters = deadLetter;
  let dbPath = path.join(directory, 'responses.sqlite');
  let worker = null;
  let workerReady = null;
  let requestId = 0;
  let queue = Promise.resolve();

  function pruneMemory() {
    for (const [id, record] of memory) {
      if (now() - Number(record?.createdAt || 0) > MAX_AGE_MS) memory.delete(id);
    }
    while (memory.size > MAX_MEMORY) memory.delete(memory.keys().next().value);
  }

  function remember(record) {
    memory.delete(record.id);
    memory.set(record.id, record);
    pruneMemory();
  }

  function discardWorker(current) {
    if (worker === current) {
      worker = null;
      workerReady = null;
    }
    current.terminate().catch(() => {});
  }

  async function startWorker() {
    if (worker) return workerReady;
    const current = new Worker(workerScript, {
      // A bridge may be launched from `node --eval`; that mode is not valid
      // for a file-backed worker and would otherwise fail worker startup.
      execArgv: workerExecArgv(),
      workerData: {
        dbPath,
        busyTimeoutMs: Math.max(1, Number(busyTimeoutMs) || WRITE_TIMEOUT_MS),
      },
    });
    worker = current;
    workerReady = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        current.off('message', onMessage);
        current.off('error', onError);
        current.off('exit', onExit);
        fn(value);
      };
      const timer = setTimeout(() => finish(
        reject,
        Object.assign(new Error('SQLite worker startup timed out'), { code: 'ETIMEDOUT' }),
      ), writeTimeoutMs);
      timer.unref?.();
      const onMessage = (message) => {
        if (message?.type === 'ready') return finish(resolve, current);
        if (message?.type === 'startup-error') return finish(
          reject,
          Object.assign(new Error(message.error?.message || 'SQLite worker startup failed'), {
            code: message.error?.code || 'SQLITE_UNAVAILABLE',
          }),
        );
      };
      const onError = (error) => finish(reject, error);
      const onExit = (code) => finish(
        reject,
        Object.assign(new Error(`SQLite worker exited during startup (${code})`), {
          code: 'SQLITE_WORKER_EXIT',
        }),
      );
      current.on('message', onMessage);
      current.once('error', onError);
      current.once('exit', onExit);
    }).catch((error) => {
      discardWorker(current);
      throw error;
    });
    return workerReady;
  }

  async function requestWorkerNow(operation, payload = {}, timeoutMs = writeTimeoutMs) {
    if (sqliteModule === false) throw Object.assign(new Error('node:sqlite is unavailable'), {
      code: 'SQLITE_UNAVAILABLE',
    });
    const current = await startWorker();
    current.ref?.();
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        current.off('message', onMessage);
        current.off('error', onError);
        current.off('exit', onExit);
        current.unref?.();
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const timer = setTimeout(() => {
        const error = Object.assign(new Error('SQLite worker timed out'), { code: 'ETIMEDOUT' });
        finish(reject, error);
        discardWorker(current);
      }, Math.max(1, Number(timeoutMs) || writeTimeoutMs));
      timer.unref?.();
      const onMessage = (message) => {
        if (message?.id !== id) return;
        if (message.type === 'response' || message.type === 'closed') {
          finish(resolve, message.result ?? null);
          return;
        }
        if (message.type === 'error') {
          finish(reject, Object.assign(
            new Error(message.error?.message || 'SQLite operation failed'),
            { code: message.error?.code || 'SQLITE_ERROR' },
          ));
        }
      };
      const onError = (error) => finish(reject, error);
      const onExit = (code) => finish(
        reject,
        Object.assign(new Error(`SQLite worker exited (${code})`), {
          code: 'SQLITE_WORKER_EXIT',
        }),
      );
      current.on('message', onMessage);
      current.once('error', onError);
      current.once('exit', onExit);
      current.postMessage({
        type: 'request',
        id,
        operation,
        slowForTestMs: defaultSlowForTestMs,
        ...payload,
      });
    });
  }

  function requestWorker(operation, payload, timeoutMs) {
    const task = queue.then(() => requestWorkerNow(operation, payload, timeoutMs));
    queue = task.catch(() => {});
    return task;
  }

  async function insert(entry, {
    timeoutMs = writeTimeoutMs,
    operationSlowMs = defaultSlowForTestMs,
  } = {}) {
    const body = compactResponseForStore(entry.body);
    const raw = JSON.stringify(body);
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > MAX_PARTIAL_BYTES) throw Object.assign(new Error('response record is too large'), {
      code: 'RESPONSE_TOO_LARGE',
    });
    const record = {
      id: String(entry.id),
      createdAt: Number(entry.createdAt || now()),
      bytes,
      status: String(body?.status || 'completed'),
      body,
    };
    const result = await requestWorker('insert', {
      record,
      raw,
      cutoff: now() - MAX_AGE_MS,
      maxRecords: MAX_RECORDS,
      maxBytes: MAX_BYTES,
      slowForTestMs: operationSlowMs,
    }, timeoutMs);
    remember(result);
    return result;
  }

  function fromDbRow(row) {
    return {
      id: row.id,
      createdAt: Number(row.created_at),
      bytes: Number(row.bytes),
      status: row.status,
      body: JSON.parse(row.body_json),
    };
  }

  const save = (entry, options = {}) => new Promise((resolve) => setImmediate(resolve))
    .then(() => saveNow(entry, options));

  async function saveNow(entry, {
    cancelInfo = null,
    partial = null,
    timeoutMs = writeTimeoutMs,
    slowForTestMs: operationSlowMs = defaultSlowForTestMs,
  } = {}) {
    const recordId = String(entry.id);
    try {
      if (failPersist) await failPersist(entry);
      const result = await insert(entry, { timeoutMs, operationSlowMs });
      deadLetters.remove(recordId);
      return { ok: true, record: result };
    } catch (error) {
      let written = false;
      if (cancelInfo) {
        try {
          written = deadLetters.append({
            response_id: recordId,
            partial: partial || entry.partial || {},
            cancelReason: cancelInfo.reason || 'client',
            phase: cancelInfo.phase || 'generation',
            usage: entry.usage || {},
            input: entry.body?._bridgeInput,
            previousResponseId: entry.body?.previous_response_id || null,
            error,
          });
        } catch (deadLetterError) {
          warn(`dead-letter write failed: ${deadLetterError.code || deadLetterError.message}`);
        }
      }
      return { ok: false, error, deadLetterWritten: written };
    }
  }

  async function get(id) {
    const local = memory.get(id);
    if (local) {
      if (now() - Number(local.createdAt || 0) > MAX_AGE_MS) {
        memory.delete(id);
        return null;
      }
      return local;
    }
    try {
      const row = await requestWorker('get', { id });
      if (!row) return null;
      if (now() - Number(row.created_at) > MAX_AGE_MS) {
        await requestWorker('remove', { id });
        return null;
      }
      const record = fromDbRow(row);
      remember(record);
      return record;
    } catch {
      return null;
    }
  }

  async function remove(id) {
    memory.delete(id);
    try {
      await requestWorker('remove', { id });
    } catch {
      // Retention cleanup is best effort during shutdown.
    }
  }

  async function resolvePersistedCancel(inputOrId) {
    const deadline = now() + 750;
    while (now() <= deadline) {
      pruneMemory();
      for (const record of memory.values()) {
        if (record.id === inputOrId) return record;
        if (record.status !== 'incomplete') continue;
        const message = record.body?.output?.find((item) => item.type === 'message');
        const text = message?.content?.map((part) => part.text).join('');
        if (text || record.status === 'incomplete') return record;
      }
      try {
        const row = await requestWorker('latest-incomplete');
        if (row) {
          if (now() - Number(row.created_at) > MAX_AGE_MS) {
            await requestWorker('remove', { id: row.id });
            continue;
          }
          const record = fromDbRow(row);
          remember(record);
          return record;
        }
      } catch {
        // no record yet
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  }

  async function retryDeadLetters() {
    return deadLetters.retryOnce(async (row) => {
      const record = {
        id: row.response_id,
        createdAt: now(),
        status: 'incomplete',
        body: {
          id: row.response_id,
          status: 'incomplete',
          incomplete_details: { reason: 'canceled' },
          output: outputFromPartial(row.partial),
          store: true,
          previous_response_id: row.previous_response_id || null,
          _bridgeInput: Array.isArray(row.input) ? row.input : [],
          _bridgeMeta: { version: 1, outputOffset: 0 },
        },
      };
      await insert(record, { timeoutMs: writeTimeoutMs });
      return true;
    });
  }

  async function close() {
    await queue.catch(() => {});
    const current = worker;
    worker = null;
    workerReady = null;
    if (current) await current.terminate().catch(() => {});
  }

  return {
    storage: 'sqlite',
    limits: {
      maxRecords: MAX_RECORDS,
      maxBytes: MAX_BYTES,
      maxMemory: MAX_MEMORY,
      maxAgeMs: MAX_AGE_MS,
    },
    deadLetter: deadLetters,
    save,
    get,
    memoryView() {
      pruneMemory();
      return [...memory.values()];
    },
    remove,
    resolvePersistedCancel,
    retryDeadLetters,
    close,
    fingerprint(body) {
      return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12);
    },
    setPath(next) {
      dbPath = next;
      const current = worker;
      worker = null;
      workerReady = null;
      void current?.terminate().catch(() => {});
    },
  };
}
