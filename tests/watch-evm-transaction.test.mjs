import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

const {watchEvmTransaction} = await import(
  '../.bld/app/@lib/watch-evm-transaction.js'
);

const hash = `0x${'12'.repeat(32)}`;
const receipt = {hash, status: 1, blockNumber: 123, fee: 42000n};

function setup(context, provider = {}) {
  context.mock.timers.enable({apis: ['setTimeout']});
  const changes = [];
  const rpc = {
    getNetwork: context.mock.fn(async () => ({chainId: 1n})),
    getTransactionReceipt: context.mock.fn(async () => null),
    ...provider,
  };
  const stop = watchEvmTransaction({
    chainId: 1n,
    hash,
    getProvider: async () => rpc,
    onChange: value => changes.push(value),
  });
  context.after(stop);
  return {changes, rpc, stop};
}

test('a missing receipt remains pending, then a successful receipt confirms and stops polling', async context => {
  const {changes, rpc} = setup(context);
  await setImmediate();
  assert.deepEqual(changes, [{status: 'pending'}]);
  rpc.getTransactionReceipt.mock.mockImplementation(async () => receipt);
  context.mock.timers.tick(5000);
  await setImmediate();
  assert.deepEqual(changes.at(-1), {status: 'confirmed', receipt});
  context.mock.timers.tick(20000);
  await setImmediate();
  assert.equal(rpc.getTransactionReceipt.mock.callCount(), 2);
  assert.deepEqual(rpc.getTransactionReceipt.mock.calls[0].arguments, [hash]);
});

test('only a failed execution receipt marks the transaction failed', async context => {
  const failed = {...receipt, status: 0};
  const {changes, rpc} = setup(context, {
    getTransactionReceipt: context.mock.fn(async () => failed),
  });
  await setImmediate();
  assert.deepEqual(changes, [{status: 'failed', receipt: failed}]);
  context.mock.timers.tick(10000);
  await setImmediate();
  assert.equal(rpc.getTransactionReceipt.mock.callCount(), 1);
});

test('RPC failures stay pending and recover on the next poll', async context => {
  const error = new Error('Offline');
  const getReceipt = context.mock.fn(async () => {
    throw error;
  });
  const {changes} = setup(context, {getTransactionReceipt: getReceipt});
  await setImmediate();
  assert.deepEqual(changes, [{status: 'pending', error}]);
  getReceipt.mock.mockImplementation(async () => receipt);
  context.mock.timers.tick(5000);
  await setImmediate();
  assert.deepEqual(changes.at(-1), {status: 'confirmed', receipt});
});

test('does not accept another network, another hash or an absent execution status', async context => {
  for (const [name, provider] of [
    ['network', {getNetwork: async () => ({chainId: 137n})}],
    [
      'hash',
      {getTransactionReceipt: async () => ({...receipt, hash: '0xother'})},
    ],
    [
      'status',
      {getTransactionReceipt: async () => ({...receipt, status: null})},
    ],
  ]) {
    await context.test(name, async context => {
      const {changes} = setup(context, provider);
      await setImmediate();
      assert.equal(changes[0].status, 'pending');
      assert.ok(changes[0].error instanceof Error);
    });
  }
});

test('does not overlap slow requests and ignores a result after disposal', async context => {
  let resolve;
  const result = new Promise(done => (resolve = done));
  const {changes, rpc, stop} = setup(context, {
    getTransactionReceipt: context.mock.fn(() => result),
  });
  await setImmediate();
  context.mock.timers.tick(20000);
  await setImmediate();
  assert.equal(rpc.getTransactionReceipt.mock.callCount(), 1);
  stop();
  resolve(receipt);
  await setImmediate();
  context.mock.timers.tick(20000);
  await setImmediate();
  assert.deepEqual(changes, []);
  assert.equal(rpc.getTransactionReceipt.mock.callCount(), 1);
});

test('disposal during provider discovery prevents further RPC work', async context => {
  let resolve;
  const discovery = new Promise(done => (resolve = done));
  const getNetwork = context.mock.fn(async () => ({chainId: 1n}));
  const onChange = context.mock.fn();
  const stop = watchEvmTransaction({
    chainId: 1n,
    hash,
    getProvider: () => discovery,
    onChange,
  });
  stop();
  resolve({getNetwork});
  await setImmediate();
  assert.equal(getNetwork.mock.callCount(), 0);
  assert.equal(onChange.mock.callCount(), 0);
});
