import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

function delay(milliseconds) {
  if (!milliseconds || milliseconds <= 0) return;
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    // Test-only synchronous preemption probe.
  }
}

function prune(database, { cutoff, maxRecords, maxBytes }) {
  database.prepare('DELETE FROM responses WHERE created_at < ?').run(cutoff);
  database.prepare(`
    DELETE FROM responses
    WHERE id IN (
      SELECT id FROM responses
      ORDER BY created_at ASC, rowid ASC
      LIMIT MAX(0, (SELECT COUNT(*) FROM responses) - ?)
    )
  `).run(maxRecords);
  let total = database.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM responses').get().n;
  if (total <= maxBytes) return;
  const rows = database.prepare(
    'SELECT id, bytes FROM responses ORDER BY created_at ASC, rowid ASC',
  ).all();
  const remove = database.prepare('DELETE FROM responses WHERE id = ?');
  for (const row of rows) {
    remove.run(row.id);
    total -= row.bytes;
    if (total <= maxBytes) break;
  }
}

function openDatabase() {
  const database = new DatabaseSync(workerData.dbPath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = ${Number(workerData.busyTimeoutMs) || 2000};
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
}

function errorPayload(error) {
  return {
    code: error?.code || 'SQLITE_ERROR',
    message: error?.message || 'SQLite operation failed',
  };
}

let database = null;
try {
  database = openDatabase();
  parentPort.postMessage({ type: 'ready' });
} catch (error) {
  parentPort.postMessage({ type: 'startup-error', error: errorPayload(error) });
}

parentPort.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'close') {
    try {
      database?.close();
      database = null;
      parentPort.postMessage({ type: 'closed', id: message.id });
    } catch (error) {
      parentPort.postMessage({ type: 'error', id: message.id, error: errorPayload(error) });
    }
    return;
  }
  if (message.type !== 'request' || !database) return;
  try {
    delay(message.slowForTestMs);
    let result = null;
    if (message.operation === 'insert') {
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`
          INSERT INTO responses(id, created_at, bytes, status, body_json)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            created_at=excluded.created_at,
            bytes=excluded.bytes,
            status=excluded.status,
            body_json=excluded.body_json
        `).run(
          message.record.id,
          message.record.createdAt,
          message.record.bytes,
          message.record.status,
          message.raw,
        );
        prune(database, message);
        database.exec('COMMIT');
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // SQLite may already have rolled back the failed transaction.
        }
        throw error;
      }
      result = message.record;
    } else if (message.operation === 'get') {
      result = database.prepare('SELECT * FROM responses WHERE id = ?').get(message.id) || null;
    } else if (message.operation === 'remove') {
      database.prepare('DELETE FROM responses WHERE id = ?').run(message.id);
    } else if (message.operation === 'latest-incomplete') {
      result = database.prepare(
        'SELECT * FROM responses WHERE status = ? ORDER BY created_at DESC LIMIT 1',
      ).get('incomplete') || null;
    } else {
      throw Object.assign(new Error('unknown SQLite operation'), {
        code: 'SQLITE_OPERATION',
      });
    }
    parentPort.postMessage({ type: 'response', id: message.id, result });
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      id: message.id,
      error: errorPayload(error),
    });
  }
});
