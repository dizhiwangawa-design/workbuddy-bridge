import test from 'node:test';
import assert from 'node:assert/strict';
import { createReasoningCatalogue } from '../../src/reasoning-catalogue.js';

function payload(effort) {
  return {
    data: {
      models: [{
        id: 'deep-model',
        reasoning: { effort },
      }],
    },
  };
}

test('同一 endpoint 和 UID 在 TTL 内只加载一次', async () => {
  let loads = 0;
  const catalogue = createReasoningCatalogue({
    endpoint: 'https://a.test',
    now: () => 1000,
    load: async () => {
      loads += 1;
      return payload('medium');
    },
  });
  const credentials = { uid: 'u1' };

  await catalogue.snapshot({ accountId: 'a', credentials });
  await catalogue.snapshot({ accountId: 'a', credentials });

  assert.equal(loads, 1);
  assert.equal(
    catalogue.getDeclaration({
      accountId: 'a',
      credentials,
      model: 'deep-model',
    }).efforts[0],
    'medium',
  );
});

test('refresh=true 强制刷新', async () => {
  let loads = 0;
  const catalogue = createReasoningCatalogue({
    endpoint: 'https://a.test',
    now: () => 1000,
    load: async () => payload(++loads === 1 ? 'medium' : 'high'),
  });
  const credentials = { uid: 'u1' };

  await catalogue.snapshot({ accountId: 'a', credentials });
  await catalogue.snapshot({ accountId: 'a', credentials, refresh: true });

  assert.equal(loads, 2);
  assert.equal(
    catalogue.getDeclaration({
      accountId: 'a',
      credentials,
      model: 'deep-model',
    }).efforts[0],
    'high',
  );
});

test('不同 UID 和 endpoint 不共享声明', async () => {
  const calls = [];
  const make = (endpoint) => createReasoningCatalogue({
    endpoint,
    now: () => 1000,
    load: async ({ credentials }) => {
      calls.push([endpoint, credentials.uid]);
      return payload(credentials.uid === 'u1' ? 'medium' : 'high');
    },
  });
  const a = make('https://a.test');
  const b = make('https://b.test');

  await a.snapshot({ accountId: 'a', credentials: { uid: 'u1' } });
  await a.snapshot({ accountId: 'b', credentials: { uid: 'u2' } });
  await b.snapshot({ accountId: 'a', credentials: { uid: 'u1' } });

  assert.deepEqual(calls, [
    ['https://a.test', 'u1'],
    ['https://a.test', 'u2'],
    ['https://b.test', 'u1'],
  ]);
});

test('刷新失败保留旧快照', async () => {
  let loads = 0;
  const catalogue = createReasoningCatalogue({
    endpoint: 'https://a.test',
    now: () => 1000,
    load: async () => {
      loads += 1;
      if (loads === 1) return payload('medium');
      throw new Error('upstream unavailable');
    },
  });
  const credentials = { uid: 'u1' };

  await catalogue.snapshot({ accountId: 'a', credentials });
  const stale = await catalogue.snapshot({
    accountId: 'a',
    credentials,
    refresh: true,
  });

  assert.equal(stale.stale, true);
  assert.equal(stale.error.message, 'upstream unavailable');
  assert.equal(
    catalogue.getDeclaration({
      accountId: 'a',
      credentials,
      model: 'deep-model',
    }).efforts[0],
    'medium',
  );
});

test('空目录刷新不覆盖有效的旧快照', async () => {
  let loads = 0;
  const catalogue = createReasoningCatalogue({
    endpoint: 'https://a.test',
    now: () => 1000,
    load: async () => {
      loads += 1;
      return loads === 1 ? payload('medium') : { data: { models: [] } };
    },
  });
  const credentials = { uid: 'u1' };

  await catalogue.snapshot({ accountId: 'a', credentials });
  const stale = await catalogue.snapshot({
    accountId: 'a',
    credentials,
    refresh: true,
  });

  assert.equal(stale.stale, true);
  assert.match(stale.error.message, /empty/i);
  assert.equal(
    catalogue.getDeclaration({
      accountId: 'a',
      credentials,
      model: 'deep-model',
    }).efforts[0],
    'medium',
  );
});

test('非标准包装仍能递归提取 models', async () => {
  const catalogue = createReasoningCatalogue({
    endpoint: 'https://a.test',
    now: () => 1000,
    load: async () => ({
      result: {
        list: [{ id: 'm1', reasoning: { effort: 'high' } }],
      },
    }),
  });

  const snapshot = await catalogue.snapshot({
    accountId: 'a',
    credentials: { uid: 'u1' },
  });

  assert.equal(snapshot.models[0].id, 'm1');
});

test('并发请求共享同一次目录加载', async () => {
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const catalogue = createReasoningCatalogue({
    endpoint: 'https://a.test',
    now: () => 1000,
    load: async () => {
      loads += 1;
      await gate;
      return payload('medium');
    },
  });
  const credentials = { uid: 'u1' };

  const first = catalogue.snapshot({ accountId: 'a', credentials });
  const second = catalogue.snapshot({ accountId: 'a', credentials });
  release();
  await Promise.all([first, second]);

  assert.equal(loads, 1);
});

test('首次加载失败时 reject，不用空目录覆盖缓存', async () => {
  const catalogue = createReasoningCatalogue({
    endpoint: 'https://a.test',
    now: () => 1000,
    load: async () => {
      throw new Error('catalogue unavailable');
    },
  });

  await assert.rejects(
    catalogue.snapshot({
      accountId: 'a',
      credentials: { uid: 'u1' },
    }),
    /catalogue unavailable/,
  );
  assert.equal(
    catalogue.getDeclaration({
      accountId: 'a',
      credentials: { uid: 'u1' },
      model: 'deep-model',
    }),
    null,
  );
});
