import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

const {getSolanaSignatureStatus, watchSolanaTransaction} = await import(
  '../.bld/app/@lib/watch-solana-transaction.js'
);

const signature = 'test-signature';
const confirmed = {slot: 123, confirmationStatus: 'confirmed', err: null};
const transaction = {
  slot: 123,
  transaction: {signatures: [signature]},
  meta: {fee: 5000, err: null},
};

function setup(context, implementation) {
  context.mock.timers.enable({apis: ['setTimeout']});
  const changes = [];
  const request = context.mock.fn(
    implementation ?? (async () => ({value: [null]})),
  );
  const stop = watchSolanaTransaction({
    signature,
    request,
    onChange: value => changes.push(value),
  });
  context.after(stop);
  return {changes, request, stop};
}

test('queries historical statuses and keeps missing or processed transactions pending', async context => {
  const {changes, request} = setup(context);
  await setImmediate();
  assert.deepEqual(changes, [{status: 'pending'}]);
  assert.deepEqual(request.mock.calls[0].arguments.slice(0, 2), [
    'getSignatureStatuses',
    [[signature], {searchTransactionHistory: true}],
  ]);

  request.mock.mockImplementation(async () => ({
    value: [{...confirmed, confirmationStatus: 'processed', err: 'Error'}],
  }));
  context.mock.timers.tick(5000);
  await setImmediate();
  assert.deepEqual(changes.at(-1), {status: 'pending'});
  assert.equal(request.mock.callCount(), 2);
});

test('confirmed and finalized both display confirmed with a fee and then stop polling', async context => {
  for (const confirmationStatus of ['confirmed', 'finalized']) {
    await context.test(confirmationStatus, async context => {
      const {changes, request} = setup(context, async method =>
        method === 'getSignatureStatuses'
          ? {value: [{...confirmed, confirmationStatus}]}
          : transaction,
      );
      await setImmediate();
      assert.deepEqual(changes, [
        {status: 'confirmed', slot: 123},
        {status: 'confirmed', slot: 123, fee: 5000n},
      ]);
      assert.deepEqual(request.mock.calls[1].arguments.slice(0, 2), [
        'getTransaction',
        [
          signature,
          {
            commitment: 'confirmed',
            encoding: 'json',
            maxSupportedTransactionVersion: 0,
          },
        ],
      ]);
      context.mock.timers.tick(30000);
      await setImmediate();
      assert.equal(request.mock.callCount(), 2);
    });
  }
});

test('only confirmed execution errors mark failure and still retain transaction fees', async context => {
  const err = {InstructionError: [0, {Custom: 6001}]};
  const {changes} = setup(context, async method =>
    method === 'getSignatureStatuses'
      ? {value: [{...confirmed, err}]}
      : {...transaction, meta: {fee: 5000, err}},
  );
  await setImmediate();
  assert.deepEqual(changes.at(-1), {
    status: 'failed',
    slot: 123,
    fee: 5000n,
    executionError: JSON.stringify(err),
  });
});

test('a lagging transaction response retains confirmed and polls only the missing details', async context => {
  let available = false;
  const {changes, request} = setup(context, async method =>
    method === 'getSignatureStatuses'
      ? {value: [confirmed]}
      : available
        ? transaction
        : null,
  );
  await setImmediate();
  assert.deepEqual(changes.at(-1), {status: 'confirmed', slot: 123});
  available = true;
  context.mock.timers.tick(5000);
  await setImmediate();
  assert.deepEqual(changes.at(-1), {
    status: 'confirmed',
    slot: 123,
    fee: 5000n,
  });
  assert.deepEqual(
    request.mock.calls.map(call => call.arguments[0]),
    ['getSignatureStatuses', 'getTransaction', 'getTransaction'],
  );
});

test('transaction metadata may be unavailable without inventing a fee or an error', async context => {
  const {changes, request} = setup(context, async method =>
    method === 'getSignatureStatuses'
      ? {value: [confirmed]}
      : {...transaction, meta: null},
  );
  await setImmediate();
  assert.deepEqual(changes.at(-1), {status: 'confirmed', slot: 123});
  context.mock.timers.tick(5000);
  await setImmediate();
  assert.equal(request.mock.callCount(), 2);
});

test('RPC errors remain retryable and do not erase an already confirmed status', async context => {
  const error = new Error('Gateway unavailable');
  let available = false;
  const {changes} = setup(context, async method => {
    if (method === 'getSignatureStatuses') return {value: [confirmed]};
    if (!available) throw error;
    return transaction;
  });
  await setImmediate();
  assert.deepEqual(changes.at(-1), {
    status: 'confirmed',
    slot: 123,
    error,
  });
  available = true;
  context.mock.timers.tick(5000);
  await setImmediate();
  assert.deepEqual(changes.at(-1), {
    status: 'confirmed',
    slot: 123,
    fee: 5000n,
  });
});

test('status RPC failures leave the transaction pending without inferring expiry', async context => {
  const error = new Error('Offline');
  const {changes, request} = setup(context, async () => {
    throw error;
  });
  await setImmediate();
  assert.deepEqual(changes, [{status: 'pending', error}]);
  request.mock.mockImplementation(async () => ({value: [null]}));
  context.mock.timers.tick(5000);
  await setImmediate();
  assert.deepEqual(changes.at(-1), {status: 'pending'});
});

test('rejects incomplete statuses instead of treating malformed results as accepted', async () => {
  for (const result of [
    null,
    {},
    {value: []},
    {value: [null, null]},
    {value: [undefined]},
    {value: [{...confirmed, slot: -1}]},
    {value: [{...confirmed, slot: Number.MAX_SAFE_INTEGER + 1}]},
    {value: [{...confirmed, confirmationStatus: null}]},
    {value: [{...confirmed, err: undefined}]},
    {value: [{...confirmed, err: []}]},
  ]) {
    await assert.rejects(
      getSolanaSignatureStatus(async () => result, signature),
      /Invalid Solana signature status/,
    );
  }
});

test('an already cancelled lookup does not send an RPC request', async context => {
  const request = context.mock.fn();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    getSolanaSignatureStatus(request, signature, controller.signal),
    {name: 'AbortError'},
  );
  assert.equal(request.mock.callCount(), 0);
});

test('rejects another signature, invalid fee or contradictory result without changing confirmed status', async context => {
  for (const result of [
    {...transaction, transaction: {signatures: ['other']}},
    {...transaction, meta: {fee: -1, err: null}},
    {...transaction, meta: {fee: Number.MAX_SAFE_INTEGER + 1, err: null}},
    {...transaction, meta: {fee: 5000, err: 'Failure'}},
  ]) {
    await context.test(JSON.stringify(result), async context => {
      const {changes} = setup(context, async method =>
        method === 'getSignatureStatuses' ? {value: [confirmed]} : result,
      );
      await setImmediate();
      assert.equal(changes.at(-1).status, 'confirmed');
      assert.match(changes.at(-1).error.message, /Invalid Solana transaction/);
    });
  }
});

test('slow polls never overlap, and disposal aborts requests and ignores late results', async context => {
  let resolve;
  const response = new Promise(done => (resolve = done));
  const {changes, request, stop} = setup(context, () => response);
  await setImmediate();
  context.mock.timers.tick(30000);
  await setImmediate();
  assert.equal(request.mock.callCount(), 1);
  stop();
  assert.equal(request.mock.calls[0].arguments[2].aborted, true);
  resolve({value: [confirmed]});
  await setImmediate();
  assert.deepEqual(changes, []);
  assert.equal(request.mock.callCount(), 1);
});

test('disposal during details keeps the last status and stops future polling', async context => {
  let resolve;
  const response = new Promise(done => (resolve = done));
  const {changes, request, stop} = setup(context, async method =>
    method === 'getSignatureStatuses' ? {value: [confirmed]} : response,
  );
  await setImmediate();
  assert.deepEqual(changes, [{status: 'confirmed', slot: 123}]);
  stop();
  assert.equal(request.mock.calls[1].arguments[2].aborted, true);
  resolve(transaction);
  await setImmediate();
  context.mock.timers.tick(30000);
  await setImmediate();
  assert.deepEqual(changes, [{status: 'confirmed', slot: 123}]);
  assert.equal(request.mock.callCount(), 2);
});
