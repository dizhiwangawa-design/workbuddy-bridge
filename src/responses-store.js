import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BRIDGE_HOME, ensureDir } from './paths.js';
import { warn } from './log.js';
import { withTimeout } from './stream-control.js';

const MAX_RECORDS = 256;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_MEMORY = 64;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_PARTIAL_BYTES = 8 * 1024 * 1024;
const WRITE_TIMEOUT_MS = 2000;
const MAX_PERSISTED_TEXT_BYTES = 256 * 1024;

export function compactResponseForStore(response) {
  let textBudget = MAX_PERSISTED_TEXT_BYTES;
  const clip = (value) => {
    const text = String(value ?? '');
    const bytes = Buffer.from(text);
    if (bytes.length <= textBudget) {
      textBudget -= bytes.length;
      return text;
    }
    const kept = bytes.subarray(0, textBudget).toString('utf8');
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
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
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
  for (const item of Array.isArray(base) ? base : []) {
    if (item?.type === 'message') {
      const original = item.content?.map((part) => part.text || '').join('') || '';
      output.push({
        ...item,
        content: [{
          type: 'output_text',
          text: `${original}${text}`,
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
        save_status: 'failed',
        db_error: String(entry.error?.code || entry.error?.message || 'database write failed').slice(0, 300),
        created_at: new Date(now()).toISOString(),
      };
      if (recordSize(row) > MAX_PARTIAL_BYTES) return false;
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
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
  deadLetter = createDeadLetter({ now }),
  failPersist = null,
} = {}) {
  ensureDir(directory);
  const memory = new Map();
  const deadLetters = deadLetter;
  let database = null;
  let dbPath = path.join(directory, 'responses.sqlite');

  async function getSqlite() {
    if (database) return database;
    if (sqliteModule === false) throw Object.assign(new Error('node:sqlite is unavailable'), {
      code: 'SQLITE_UNAVAILABLE',
    });
    try {
      const module = sqliteModule || await import('node:sqlite');
      const Database = module.DatabaseSync || module.default?.DatabaseSync;
      if (!Database) throw new Error('DatabaseSync not exported');
      database = new Database(dbPath);
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS responses (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          bytes INTEGER NOT NULL,
          status TEXT NOT NULL,
          body_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS responses_created ON responses(created_at);
      `);
      return database;
    } catch (error) {
      throw Object.assign(error, { code: error.code || 'SQLITE_UNAVAILABLE' });
    }
  }

  function pruneMemory() {
    while (memory.size > MAX_MEMORY) memory.delete(memory.keys().next().value);
  }

  function pruneDatabase(db) {
    const cutoff = now() - MAX_AGE_MS;
    db.prepare('DELETE FROM responses WHERE created_at < ?').run(cutoff);
    const rows = db.prepare(
      'SELECT id, bytes FROM responses ORDER BY created_at DESC LIMIT -1 OFFSET ?',
    ).all(MAX_RECORDS);
    let total = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM responses').get().n;
    for (const row of rows) {
      if (total <= MAX_BYTES) break;
      db.prepare('DELETE FROM responses WHERE id = ?').run(row.id);
      total -= row.bytes;
    }
  }

  function remember(record) {
    memory.delete(record.id);
    memory.set(record.id, record);
    pruneMemory();
  }

  async function insert(entry) {
    const db = await getSqlite();
    const raw = JSON.stringify(entry.body);
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > MAX_BYTES) throw Object.assign(new Error('response record is too large'), {
      code: 'RESPONSE_TOO_LARGE',
    });
    const record = {
      id: entry.id,
      createdAt: Number(entry.createdAt || now()),
      bytes,
      status: String(entry.body?.status || 'completed'),
      body: entry.body,
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO responses(id, created_at, bytes, status, body_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          created_at=excluded.created_at,
          bytes=excluded.bytes,
          status=excluded.status,
          body_json=excluded.body_json
      `).run(record.id, record.createdAt, record.bytes, record.status, raw);
      pruneDatabase(db);
      db.exec('COMMIT');
      remember(record);
      return record;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // A failed transaction may already have been rolled back by SQLite.
      }
      throw error;
    }
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

  // Persistence has a synchronous SQLite transaction and a hard write budget.
  // Deferring it one macrotask lets the upstream reader observe cancellation
  // before the process pauses for durable I/O.
  const save = (entry, options = {}) => new Promise((resolve) => setImmediate(resolve))
    .then(() => saveNow(entry, options));

  async function saveNow(entry, {
    cancelInfo = null,
    partial = null,
  } = {}) {
    const record = {
      id: String(entry.id),
      createdAt: Number(entry.createdAt || now()),
      status: String(entry.body?.status || 'completed'),
      body: entry.body,
    };
    try {
      if (failPersist) await failPersist(entry);
      const result = await withTimeout(insert(record), writeTimeoutMs, 'SQLite worker timed out');
      if (recordSize(record) > MAX_PARTIAL_BYTES) await insert({
        ...record,
        body: {
          ...record.body,
          output: record.body.output?.filter((item) => item?.type !== 'message') || [],
        },
      });
      deadLetters.remove(record.id);
      return { ok: true, record: result };
    } catch (error) {
      let written = false;
      if (cancelInfo) {
        try {
          written = deadLetters.append({
            response_id: record.id,
            partial: partial || entry.partial || {},
            cancelReason: cancelInfo.reason || 'client',
            phase: cancelInfo.phase || 'generation',
            usage: entry.usage || {},
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
    if (local) return local;
    try {
      const db = await getSqlite();
      const row = db.prepare('SELECT * FROM responses WHERE id = ?').get(id);
      if (!row) return null;
      if (now() - Number(row.created_at) > MAX_AGE_MS) {
        db.prepare('DELETE FROM responses WHERE id = ?').run(id);
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
      const db = await getSqlite();
      db.prepare('DELETE FROM responses WHERE id = ?').run(id);
    } catch {
      // Retention cleanup is best effort during shutdown.
    }
  }

  async function resolvePersistedCancel(inputOrId) {
    if (!memory.size) return null;
    const deadline = now() + 750;
    while (now() <= deadline) {
      for (const record of memory.values()) {
        if (record.id === inputOrId) return record;
        if (record.status !== 'incomplete') continue;
        const message = record.body?.output?.find((item) => item.type === 'message');
        const text = message?.content?.map((part) => part.text).join('');
        if (text || record.status === 'incomplete') return record;
      }
      try {
        const db = await getSqlite();
        const row = db.prepare('SELECT * FROM responses WHERE status = ? ORDER BY created_at DESC LIMIT 1')
          .get('incomplete');
        if (row) {
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
        },
      };
      await withTimeout(insert(record), writeTimeoutMs, 'dead-letter retry timed out');
      return true;
    });
  }

  async function close() {
    try {
      database?.close();
    } catch {
      // Nothing remains to flush after the synchronous transactions.
    }
    database = null;
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
    },
  };
}
