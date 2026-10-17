import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';

import {GasCollector, collectBatch} from '../.bld/collector.js';
import {WEEK_SECONDS, summarizeHistory} from '../.bld/history.js';
import {BlockReader} from '../.bld/rpc.js';
import {CollectorStore} from '../.bld/storage.js';

const now = 1800000000;
const latestNumber = 100000;

function sample(timestamp, fee) {
  const number = latestNumber + (timestamp - now) / 12;
  return {
    timestamp,
    blockNumber: String(number),
    baseFeePerGas: fee ?? String(number),
  };
}

function cursors(nextForward, nextBackward = now - WEEK_SECONDS) {
  return {nextForward, nextBackward, retryCount: 0, notBefore: 0};
}

function setup(context, initial = []) {
  const database = new DatabaseSync(':memory:');
  context.after(() => database.close());
  let clock = now * 1000 + 1000;
  let alarmAt = null;
  let legacy = structuredClone(initial);
  let respond;
  let collector;
  const errors = [];
  context.mock.method(Date, 'now', () => clock);
  context.mock.method(console, 'info', () => {});
  context.mock.method(console, 'error', (...args) => errors.push(args));
  const request = context.mock.method(
    globalThis,
    'fetch',
    async (_url, options) => {
      const [tag] = JSON.parse(options.body).params;
      const number =
        tag === 'latest'
          ? latestNumber + Math.floor((clock / 1000 - now + 1) / 12)
          : Number(BigInt(tag));
      // Network time advances the one millisecond pacing interval without sleeps.
      clock++;
      const response = await respond?.({tag, number});
      if (response) return response;
      return Response.json({
        result: {
          number: `0x${number.toString(16)}`,
          timestamp: `0x${(now + (number - latestNumber) * 12 - 1).toString(16)}`,
          baseFeePerGas: `0x${number.toString(16)}`,
        },
      });
    },
  );
  const storage = {
    sql: {
      exec(query, ...bindings) {
        const rows = database
          .prepare(query)
          .all(...bindings)
          .map(row => ({...row}));
        return {toArray: () => rows};
      },
    },
    transactionSync(callback) {
      database.exec('BEGIN');
      try {
        const result = callback();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    async getAlarm() {
      return alarmAt;
    },
    async setAlarm(timestamp) {
      alarmAt = timestamp;
    },
    async deleteAlarm() {
      alarmAt = null;
    },
  };
  const env = {
    ETHEREUM_RPC_URL: 'https://rpc.example.test',
    RPC_REQUESTS_PER_SECOND: '1000000000',
    GAS_HISTORY: {
      async get() {
        return structuredClone(legacy);
      },
    },
  };
  const store = new CollectorStore(storage);
  collector = new GasCollector(storage, env);
  return {
    request,
    store,
    errors,
    get collector() {
      return collector;
    },
    get alarmAt() {
      return alarmAt;
    },
    get clock() {
      return clock;
    },
    advance(milliseconds) {
      clock += milliseconds;
    },
    respondWith(callback) {
      respond = callback;
    },
    setLegacy(samples) {
      legacy = structuredClone(samples);
    },
    restart() {
      collector = new GasCollector(storage, env);
    },
    async fire() {
      assert.notEqual(alarmAt, null, 'a continuation alarm must be scheduled');
      clock = Math.max(clock, alarmAt);
      alarmAt = null;
      await collector.alarm();
    },
  };
}

test('delayed wakes resume every forward bucket using its historical price', async context => {
  const state = setup(context);
  state.store.commit(cursors(now - 900), [sample(now - 1200)], 0);
  await state.collector.wake();
  await state.fire();
  assert.equal(state.store.getState().nextForward, now + 300);
  assert.deepEqual(
    state.store.getSamples(),
    [-1200, -900, -600, -300, 0].map(offset => sample(now + offset)),
  );
  assert.equal(state.alarmAt, null);

  state.advance(1500000);
  await state.collector.wake();
  await state.fire();
  assert.equal(state.store.getState().nextForward, now + 1800);
  assert.deepEqual(
    state.store.getSamples(),
    Array.from({length: 10}, (_, i) => sample(now - 1200 + i * 300)),
  );
  assert.equal(state.errors.length, 0);
});

test('a failed bucket checkpoints successful predecessors and resumes after persisted backoff', async context => {
  const state = setup(context);
  state.store.commit(cursors(now - 900), [sample(now - 1200)], 0);
  state.respondWith(({number}) =>
    number === Number(sample(now - 600).blockNumber)
      ? new Response(null, {status: 503})
      : undefined,
  );
  await state.collector.wake();
  await state.fire();
  const checkpoint = state.store.getState();
  assert.equal(checkpoint.nextForward, now - 600);
  assert.equal(checkpoint.retryCount, 1);
  assert.ok(checkpoint.notBefore >= state.clock + 5000);
  assert.equal(state.alarmAt, checkpoint.notBefore);
  assert.deepEqual(state.store.getSamples(), [
    sample(now - 1200),
    sample(now - 900),
  ]);

  state.restart();
  state.respondWith(undefined);
  await state.collector.wake();
  assert.equal(state.alarmAt, checkpoint.notBefore);
  await state.fire();
  assert.equal(state.store.getState().nextForward, now + 300);
  assert.equal(state.store.getState().retryCount, 0);
  assert.deepEqual(
    state.store.getSamples(),
    [-1200, -900, -600, -300, 0].map(offset => sample(now + offset)),
  );
  assert.equal(state.errors.length, 1);
});

test('request budget exhaustion schedules another history batch immediately', async context => {
  const state = setup(context);
  await state.collector.wake();
  await state.fire();
  assert.equal(state.request.mock.callCount(), 40);
  assert.ok(state.store.getSamples().length > 1);
  assert.equal(state.store.getState().retryCount, 0);
  assert.ok(state.alarmAt <= state.clock + 1);
  const oldest = state.store.getSamples()[0].timestamp;

  await state.fire();
  assert.equal(state.request.mock.callCount(), 80);
  assert.ok(state.store.getSamples()[0].timestamp < oldest);
  assert.ok(state.clock < now * 1000 + 300000);
  assert.equal(state.errors.length, 0);
});

test('migration preserves existing samples while continuous alarms complete seven days and stop', async context => {
  const initial = [sample(now - 900, '42'), sample(now - 300, '84')];
  const state = setup(context, initial);
  await state.collector.wake();
  assert.deepEqual(state.store.getSamples(), initial);
  state.setLegacy([]);
  state.restart();
  let runs = 0;
  while (state.alarmAt !== null && runs < 150) {
    await state.fire();
    runs++;
  }

  assert.ok(runs > 1 && runs < 150);
  assert.equal(state.alarmAt, null);
  const samples = state.store.getSamples();
  assert.equal(samples.length, 2016);
  assert.deepEqual(
    samples.map(value => value.timestamp),
    Array.from({length: 2016}, (_, i) => now - (2015 - i) * 300),
  );
  for (const original of initial) {
    assert.deepEqual(
      samples.find(value => value.timestamp === original.timestamp),
      original,
    );
  }
  const summary = summarizeHistory(samples, Math.floor(state.clock / 1000));
  assert.equal(summary.windows['7d'].status, 'ready');
  assert.equal(summary.windows['7d'].sampleCount, 2016);
  const requests = state.request.mock.callCount();
  await state.collector.wake();
  assert.equal(state.request.mock.callCount(), requests);
  assert.equal(state.alarmAt, null);
  assert.equal(state.errors.length, 0);
});

test('a wake during RPC work preserves the active batch watchdog', async context => {
  const state = setup(context);
  state.store.commit(cursors(now), [], 0);
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let entered;
  const started = new Promise(resolve => {
    entered = resolve;
  });
  state.respondWith(async ({tag}) => {
    if (tag === 'latest') {
      entered();
      await gate;
    }
  });
  await state.collector.wake();
  const running = state.fire();
  await started;
  try {
    const watchdog = state.alarmAt;
    assert.ok(watchdog > state.clock);
    await state.collector.wake();
    assert.equal(state.alarmAt, watchdog);
    assert.equal(state.request.mock.callCount(), 1);
    assert.deepEqual(await state.collector.read(), []);
  } finally {
    release();
    await running;
  }
  assert.deepEqual(state.store.getSamples(), [sample(now)]);
  assert.equal(state.alarmAt, null);
});

test('wakes and early alarm delivery honor a persisted HTTP 429 Retry-After', async context => {
  const state = setup(context);
  state.store.commit(cursors(now), [], 0);
  state.respondWith(
    () => new Response(null, {status: 429, headers: {'Retry-After': '120'}}),
  );
  await state.collector.wake();
  await state.fire();
  const checkpoint = state.store.getState();
  assert.equal(checkpoint.nextForward, now);
  assert.equal(checkpoint.retryCount, 1);
  assert.ok(checkpoint.notBefore >= state.clock + 120000);
  assert.equal(state.alarmAt, checkpoint.notBefore);

  state.restart();
  state.advance(60000);
  await state.collector.wake();
  assert.equal(state.alarmAt, checkpoint.notBefore);
  await state.collector.alarm();
  assert.equal(state.alarmAt, checkpoint.notBefore);
  assert.equal(state.request.mock.callCount(), 1);
  assert.deepEqual(state.store.getState(), checkpoint);

  state.respondWith(undefined);
  await state.fire();
  assert.equal(state.store.getState().nextForward, now + 300);
  assert.equal(state.store.getState().retryCount, 0);
  assert.deepEqual(state.store.getSamples(), [sample(now)]);
  assert.equal(state.alarmAt, null);
});

test('public reads neither initialize nor schedule collection and use committed data after migration', async context => {
  const initial = [sample(now - 300, '42')];
  const state = setup(context, initial);
  assert.deepEqual(await state.collector.read(), initial);
  assert.equal(state.store.getState(), undefined);
  assert.equal(state.alarmAt, null);

  state.store.commit(cursors(now + 300), [sample(now)], 0);
  state.setLegacy([sample(now - 600, '1')]);
  assert.deepEqual(await state.collector.read(), [sample(now)]);
  assert.equal(state.alarmAt, null);
  assert.equal(state.request.mock.callCount(), 0);
});

test('batch progress never mutates its last durable checkpoint or original samples', async context => {
  setup(context);
  const previous = cursors(now - 300);
  const samples = [sample(now - 600)];
  const reader = new BlockReader('https://rpc.example.test');
  const result = await collectBatch(previous, samples, reader, now);

  assert.equal(result.error, undefined);
  assert.deepEqual(previous, cursors(now - 300));
  assert.deepEqual(samples, [sample(now - 600)]);
  assert.equal(result.state.nextForward, now + 300);
  assert.deepEqual(result.added, [sample(now - 300), sample(now)]);
});
