import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';

import {CollectorStore} from '../.bld/storage.js';

function setup(context) {
  const database = new DatabaseSync(':memory:');
  context.after(() => database.close());
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
  };
  return {storage, store: new CollectorStore(storage)};
}

const initialState = {
  nextForward: 1800000300,
  nextBackward: 1799999700,
  retryCount: 0,
  notBefore: 0,
};

function sample(timestamp, fee = '9007199254740993') {
  return {timestamp, blockNumber: String(timestamp / 12), baseFeePerGas: fee};
}

test('initialization preserves stored state and samples across store recreation', context => {
  const {storage, store} = setup(context);
  assert.equal(store.getState(), undefined);
  assert.deepEqual(store.getSamples(), []);
  const samples = [sample(1800000000), sample(1799999700)];
  store.commit(initialState, samples, 0);

  const reopened = new CollectorStore(storage);
  assert.deepEqual(reopened.getState(), initialState);
  assert.deepEqual(reopened.getSamples(), [samples[1], samples[0]]);
});

test('duplicate buckets retain their original block and exact fee', context => {
  const {store} = setup(context);
  const original = sample(1800000000);
  store.commit(initialState, [original], 0);
  store.commit(
    {...initialState, nextBackward: 1799999400},
    [{...original, blockNumber: '1', baseFeePerGas: '42'}],
    0,
  );

  assert.deepEqual(store.getSamples(), [original]);
  assert.equal(store.getState().nextBackward, 1799999400);
});

test('one commit inserts samples, expires the inclusive lower boundary and advances state', context => {
  const {store} = setup(context);
  store.commit(initialState, [sample(1799999400), sample(1799999700)], 0);
  const nextState = {
    nextForward: 1800000600,
    nextBackward: 1799999100,
    retryCount: 2,
    notBefore: 1800000600000,
  };
  store.commit(nextState, [sample(1800000000)], 1799999400);

  assert.deepEqual(store.getSamples(), [
    sample(1799999700),
    sample(1800000000),
  ]);
  assert.deepEqual(store.getState(), nextState);
});

test('a failed state write rolls back inserted samples and retention deletion', context => {
  const {store} = setup(context);
  const original = sample(1799999700);
  store.commit(initialState, [original], 0);

  assert.throws(
    () =>
      store.commit(
        {...initialState, nextForward: 1800000600, retryCount: null},
        [sample(1800000300)],
        1799999700,
      ),
    /NOT NULL constraint failed/,
  );
  assert.deepEqual(store.getSamples(), [original]);
  assert.deepEqual(store.getState(), initialState);
});
