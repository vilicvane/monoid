import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

const {watchEvmTransaction} = await import(
  '../.bld/app/@lib/watch-evm-transaction.js'
);

const hash = `0x${'12'.repeat(32)}`;
const replacementHash = `0x${'34'.repeat(32)}`;
const from = `0x${'56'.repeat(20)}`;
const receipt = {hash, status: 1, blockNumber: 123, fee: 42000n, logs: []};
const replacement = {from, nonce: 7, hashes: () => [replacementHash]};

function setup(context, provider = {}, replacement) {
  context.mock.timers.enable({apis: ['setTimeout']});
  const changes = [];
  const rpc = {
    getNetwork: context.mock.fn(async () => ({chainId: 1n})),
    getTransactionReceipt: context.mock.fn(async () => null),
    getTransactionCount: context.mock.fn(async () => 7),
    ...provider,
  };
  const stop = watchEvmTransaction({
    chainId: 1n,
    hash,
    replacement,
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

test('a pending competitor does not replace the original transaction', async context => {
  const {changes, rpc} = setup(context, {}, replacement);
  await setImmediate();
  assert.deepEqual(changes, [{status: 'pending'}]);
  assert.deepEqual(
    rpc.getTransactionReceipt.mock.calls.map(call => call.arguments),
    [[hash], [replacementHash]],
  );
  assert.deepEqual(rpc.getTransactionCount.mock.calls[0].arguments, [
    from,
    'latest',
  ]);
  context.mock.timers.tick(5000);
  await setImmediate();
  assert.equal(changes.length, 2);
});

test('the original receipt wins without querying competitors', async context => {
  const {changes, rpc} = setup(
    context,
    {getTransactionReceipt: context.mock.fn(async () => receipt)},
    replacement,
  );
  await setImmediate();
  assert.deepEqual(changes, [{status: 'confirmed', receipt}]);
  assert.equal(rpc.getTransactionReceipt.mock.callCount(), 1);
  assert.equal(rpc.getTransactionCount.mock.callCount(), 0);
});

test('a mined known competitor replaces the original even when its execution failed', async context => {
  for (const status of [0, 1]) {
    await context.test(`receipt status ${status}`, async context => {
      const replacementReceipt = {...receipt, hash: replacementHash, status};
      const {changes, rpc} = setup(
        context,
        {
          getTransactionReceipt: context.mock.fn(async value =>
            value === replacementHash ? replacementReceipt : null,
          ),
        },
        replacement,
      );
      await setImmediate();
      assert.deepEqual(changes, [
        {status: 'replaced', replacementHash, replacementReceipt},
      ]);
      context.mock.timers.tick(20000);
      await setImmediate();
      assert.equal(rpc.getTransactionReceipt.mock.callCount(), 2);
      assert.equal(rpc.getTransactionCount.mock.callCount(), 0);
    });
  }
});

test('competitors submitted after polling starts are included on the next poll', async context => {
  const hashes = [];
  const replacementReceipt = {...receipt, hash: replacementHash};
  const {changes} = setup(
    context,
    {
      getTransactionReceipt: async value =>
        value === replacementHash ? replacementReceipt : null,
    },
    {...replacement, hashes: () => hashes},
  );
  await setImmediate();
  assert.deepEqual(changes, [{status: 'pending'}]);
  hashes.push(replacementHash);
  context.mock.timers.tick(5000);
  await setImmediate();
  assert.deepEqual(changes.at(-1), {
    status: 'replaced',
    replacementHash,
    replacementReceipt,
  });
});

test('a consumed nonce without a matching receipt stays unresolved and keeps polling', async context => {
  const {changes, rpc} = setup(
    context,
    {getTransactionCount: context.mock.fn(async () => 8)},
    replacement,
  );
  await setImmediate();
  assert.deepEqual(changes, [{status: 'pending', nonceUsed: true}]);
  assert.deepEqual(
    rpc.getTransactionReceipt.mock.calls.map(call => call.arguments),
    [[hash], [replacementHash], [hash]],
  );
  rpc.getTransactionReceipt.mock.mockImplementation(async () => receipt);
  context.mock.timers.tick(5000);
  await setImmediate();
  assert.deepEqual(changes.at(-1), {status: 'confirmed', receipt});
});

test('rechecks the original receipt after its nonce is consumed', async context => {
  let queries = 0;
  const {changes} = setup(
    context,
    {
      getTransactionCount: async () => 8,
      getTransactionReceipt: async value =>
        value === hash && ++queries === 2 ? receipt : null,
    },
    replacement,
  );
  await setImmediate();
  assert.deepEqual(changes, [{status: 'confirmed', receipt}]);
});

test('invalid competitor receipts and nonce RPC failures remain pending errors', async context => {
  for (const [name, provider] of [
    [
      'wrong hash',
      {
        getTransactionReceipt: async value =>
          value === replacementHash ? receipt : null,
      },
    ],
    [
      'absent status',
      {
        getTransactionReceipt: async value =>
          value === replacementHash
            ? {...receipt, hash: replacementHash, status: null}
            : null,
      },
    ],
    [
      'nonce unavailable',
      {
        getTransactionCount: async () => {
          throw new Error('Offline');
        },
      },
    ],
  ]) {
    await context.test(name, async context => {
      const {changes} = setup(context, provider, replacement);
      await setImmediate();
      assert.equal(changes[0].status, 'pending');
      assert.ok(changes[0].error instanceof Error);
    });
  }
});

test('disposal while finding a mined competitor ignores its receipt and stops RPC work', async context => {
  let resolve;
  const result = new Promise(done => (resolve = done));
  const {changes, rpc, stop} = setup(
    context,
    {
      getTransactionReceipt: context.mock.fn(async value =>
        value === replacementHash ? result : null,
      ),
    },
    replacement,
  );
  await setImmediate();
  context.mock.timers.tick(20000);
  await setImmediate();
  assert.equal(rpc.getTransactionReceipt.mock.callCount(), 2);
  stop();
  resolve({...receipt, hash: replacementHash});
  await setImmediate();
  assert.deepEqual(changes, []);
  assert.equal(rpc.getTransactionCount.mock.callCount(), 0);
});
