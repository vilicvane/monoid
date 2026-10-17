import assert from 'node:assert/strict';
import {test} from 'node:test';

import {JsonRpcProvider, Transaction, keccak256} from 'ethers';

const {parseEvmTransaction} = await import(
  '../.bld/app/@lib/evm-transaction.js'
);
const {prepareEvmTransaction} = await import(
  '../.bld/app/@lib/prepare-evm-transaction.js'
);

const address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const recipient = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';
const accessList = [
  {address: recipient, storageKeys: [`0x${'ab'.repeat(32)}`]},
];
const transaction = (fields = {}) =>
  parseEvmTransaction({from: address, to: recipient, ...fields}, 1n);

function createProvider(context) {
  return {
    getNetwork: context.mock.fn(async () => ({chainId: 1n})),
    getFeeData: context.mock.fn(async () => ({
      gasPrice: 3n,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
    })),
    getTransactionCount: context.mock.fn(async () => 7),
    estimateGas: context.mock.fn(async () => 21000n),
    getBalance: context.mock.fn(async () => 2n ** 255n),
  };
}

test('fills pending nonce and signing fees while estimating execution independently', async context => {
  const provider = createProvider(context);
  const input = transaction({value: '9007199254740993', data: '0xaabb'});
  const original = structuredClone(input);

  const result = await prepareEvmTransaction(input, address, provider);
  assert.equal(result.error, undefined);
  const prepared = Transaction.from(result.unsignedTransaction);

  assert.deepEqual(provider.getTransactionCount.mock.calls[0].arguments, [
    address,
    'pending',
  ]);
  assert.deepEqual(provider.estimateGas.mock.calls[0].arguments, [
    {
      chainId: 1n,
      type: undefined,
      to: recipient,
      from: address,
      value: 9007199254740993n,
      data: '0xaabb',
      nonce: 7,
      gasPrice: undefined,
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
    },
  ]);
  assert.equal(prepared.gasLimit, 21000n);
  assert.equal(prepared.signature, null);
  assert.equal(result.transaction.gasLimit, prepared.gasLimit);
  assert.deepEqual(provider.getBalance.mock.calls[0].arguments, [
    address,
    'pending',
  ]);
  assert.deepEqual(input, original);
});

test('low-fee transactions reach signing without sending their fee cap to gas estimation', async context => {
  for (const type of [0, 1, 2]) {
    const provider = new JsonRpcProvider('http://localhost:0', 1, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    context.after(() => provider.destroy());
    const requests = [];
    provider._send = async request => {
      requests.push(request);
      if (request.method === 'eth_estimateGas') {
        const [transaction] = request.params;
        const fee = transaction.maxFeePerGas ?? transaction.gasPrice;
        if (fee != null && BigInt(fee) < 10n) {
          return [
            {
              id: request.id,
              error: {
                code: -32000,
                message: 'max fee per gas less than block base fee',
              },
            },
          ];
        }
        return [{id: request.id, result: '0x5208'}];
      }
      if (request.method === 'eth_getBalance') {
        return [{id: request.id, result: '0x5208'}];
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };
    const input = transaction({
      type,
      nonce: 7,
      gas: 21000,
      ...(type === 2
        ? {maxFeePerGas: 1, maxPriorityFeePerGas: 0}
        : {gasPrice: 1}),
      ...(type === 0 ? {} : {accessList}),
    });
    const result = await prepareEvmTransaction(input, address, provider);

    assert.equal(result.error, undefined);
    const prepared = Transaction.from(result.unsignedTransaction);
    assert.equal(prepared.type, type);
    assert.equal(prepared.gasLimit, 21000n);
    assert.equal(prepared.nonce, 7);
    assert.equal(prepared.gasPrice, type === 2 ? null : 1n);
    assert.equal(prepared.maxFeePerGas, type === 2 ? 1n : null);
    assert.equal(prepared.maxPriorityFeePerGas, type === 2 ? 0n : null);
    assert.deepEqual(
      requests.map(request => request.method),
      ['eth_estimateGas', 'eth_getBalance'],
    );
    const [estimate] = requests[0].params;
    for (const field of [
      'type',
      'gasPrice',
      'maxFeePerGas',
      'maxPriorityFeePerGas',
    ]) {
      assert.equal(Object.hasOwn(estimate, field), false);
    }
    assert.equal(estimate.gas, '0x5208');
    assert.equal(estimate.from, address.toLowerCase());
    assert.equal(estimate.to, recipient.toLowerCase());
    if (type !== 0) assert.deepEqual(estimate.accessList, accessList);
  }
});

test('validates gas while preserving explicit fields including zero fees and nonce', async context => {
  for (const type of [0, 1, 2]) {
    const provider = createProvider(context);
    const input = transaction({
      type,
      nonce: 0,
      gas: 30000,
      value: 0,
      data: '0x',
      ...(type === 2
        ? {maxFeePerGas: 0, maxPriorityFeePerGas: 0}
        : {gasPrice: 0}),
      ...(type === 0 ? {} : {accessList}),
    });
    const original = structuredClone(input);

    const result = await prepareEvmTransaction(input, address, provider);
    assert.equal(result.error, undefined);
    const prepared = Transaction.from(result.unsignedTransaction);

    assert.equal(prepared.type, type);
    assert.equal(prepared.chainId, 1n);
    assert.equal(prepared.to, recipient);
    assert.equal(prepared.nonce, 0);
    assert.equal(prepared.gasLimit, 30000n);
    assert.equal(prepared.value, 0n);
    assert.equal(prepared.data, '0x');
    if (type === 2) {
      assert.equal(prepared.maxFeePerGas, 0n);
      assert.equal(prepared.maxPriorityFeePerGas, 0n);
    } else {
      assert.equal(prepared.gasPrice, 0n);
    }
    if (type !== 0) assert.deepEqual(prepared.accessList, accessList);
    assert.equal(provider.getNetwork.mock.callCount(), 1);
    assert.equal(provider.getFeeData.mock.callCount(), 0);
    assert.equal(provider.getTransactionCount.mock.callCount(), 0);
    assert.equal(provider.estimateGas.mock.callCount(), 1);
    assert.equal(
      provider.estimateGas.mock.calls[0].arguments[0].gasLimit,
      30000n,
    );
    assert.deepEqual(input, original);
  }
});

test('rejects an explicit zero or insufficient gas limit instead of replacing it with the estimate', async context => {
  for (const gas of [0, 20999]) {
    const provider = createProvider(context);
    const input = transaction({gas});
    const original = structuredClone(input);

    const result = await prepareEvmTransaction(input, address, provider);
    assert.equal(result.error, 'Gas limit is too low.');
    assert.equal(result.unsignedTransaction, undefined);
    assert.equal(result.transaction.gasLimit, BigInt(gas));
    assert.equal(provider.estimateGas.mock.callCount(), 1);
    assert.equal(
      provider.estimateGas.mock.calls[0].arguments[0].gasLimit,
      BigInt(gas),
    );
    assert.deepEqual(input, original);
  }
});

test('compares explicit gas limits without losing integer precision', async context => {
  const estimate = 2n ** 180n + 3n;

  for (const difference of [-1n, 0n, 1n]) {
    const provider = createProvider(context);
    provider.estimateGas.mock.mockImplementation(async () => estimate);
    const input = transaction({gas: (estimate + difference).toString()});
    const result = await prepareEvmTransaction(input, address, provider);

    if (difference < 0n) {
      assert.equal(result.error, 'Gas limit is too low.');
      assert.equal(result.unsignedTransaction, undefined);
    } else {
      assert.equal(result.error, undefined);
      const prepared = Transaction.from(result.unsignedTransaction);
      assert.equal(prepared.gasLimit, estimate + difference);
    }
  }
});

test('a failed estimate rejects even when the caller supplied every transaction field', async context => {
  const provider = createProvider(context);
  const input = transaction({type: 0, gas: 30000, nonce: 7, gasPrice: 3});
  const failure = new Error('Execution reverted.');
  provider.estimateGas.mock.mockImplementation(async () => {
    throw failure;
  });

  const result = await prepareEvmTransaction(input, address, provider);
  assert.equal(result.error, failure.message);
  assert.equal(result.unsignedTransaction, undefined);
  assert.equal(result.transaction.gasLimit, 30000n);
  assert.equal(provider.getFeeData.mock.callCount(), 0);
  assert.equal(provider.getTransactionCount.mock.callCount(), 0);
  assert.equal(provider.estimateGas.mock.callCount(), 1);
});

test('infers legacy, access-list or EIP-1559 types from explicit fees without replacing them', async context => {
  for (const [fields, type] of [
    [{gasPrice: 4}, 0],
    [{gasPrice: 4, accessList}, 1],
    [{maxFeePerGas: 8, maxPriorityFeePerGas: 1}, 2],
  ]) {
    const provider = createProvider(context);
    const input = transaction({nonce: 1, gas: 30000, ...fields});
    const result = await prepareEvmTransaction(input, address, provider);
    assert.equal(result.error, undefined);
    const prepared = Transaction.from(result.unsignedTransaction);

    assert.equal(prepared.type, type);
    assert.equal(provider.getFeeData.mock.callCount(), 0);
    if (type === 2) {
      assert.equal(prepared.maxFeePerGas, 8n);
      assert.equal(prepared.maxPriorityFeePerGas, 1n);
    } else {
      assert.equal(prepared.gasPrice, 4n);
    }
    if (type === 1) assert.deepEqual(prepared.accessList, accessList);
  }
});

test('chooses legacy or access-list fees on networks without EIP-1559 and preserves explicit types', async context => {
  for (const [fields, expectedType] of [
    [{}, 0],
    [{accessList}, 1],
    [{type: 0}, 0],
    [{type: 1, accessList}, 1],
  ]) {
    const provider = createProvider(context);
    provider.getFeeData.mock.mockImplementation(async () => ({
      gasPrice: 3n,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    }));
    const result = await prepareEvmTransaction(
      transaction(fields),
      address,
      provider,
    );
    assert.equal(result.error, undefined);
    const prepared = Transaction.from(result.unsignedTransaction);

    assert.equal(prepared.type, expectedType);
    assert.equal(prepared.gasPrice, 3n);
    assert.equal(prepared.maxFeePerGas, null);
    if (fields.accessList) assert.deepEqual(prepared.accessList, accessList);
  }

  for (const type of [0, 1]) {
    const provider = createProvider(context);
    const result = await prepareEvmTransaction(
      transaction({type}),
      address,
      provider,
    );
    assert.equal(result.error, undefined);
    const prepared = Transaction.from(result.unsignedTransaction);
    assert.equal(prepared.type, type);
    assert.equal(prepared.gasPrice, 3n);
  }
});

test('fills only missing EIP-1559 fee fields and keeps access lists when choosing EIP-1559', async context => {
  for (const [fields, maximum, priority] of [
    [{maxFeePerGas: 5}, 5n, 2n],
    [{maxPriorityFeePerGas: 0}, 10n, 0n],
    [{accessList}, 10n, 2n],
  ]) {
    const provider = createProvider(context);
    const result = await prepareEvmTransaction(
      transaction(fields),
      address,
      provider,
    );
    assert.equal(result.error, undefined);
    const prepared = Transaction.from(result.unsignedTransaction);

    assert.equal(prepared.type, 2);
    assert.equal(prepared.maxFeePerGas, maximum);
    assert.equal(prepared.maxPriorityFeePerGas, priority);
    assert.equal(provider.getFeeData.mock.callCount(), 1);
    if (fields.accessList) assert.deepEqual(prepared.accessList, accessList);
  }
});

test('does not downgrade explicit fee models when RPC fee data is incomplete', async context => {
  for (const fields of [{type: 2}, {maxFeePerGas: 5}, {type: 0}, {type: 1}]) {
    const provider = createProvider(context);
    provider.getFeeData.mock.mockImplementation(async () => ({
      gasPrice: null,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    }));

    const result = await prepareEvmTransaction(
      transaction(fields),
      address,
      provider,
    );
    assert.equal(result.error, 'Could not determine transaction fees.');
    assert.equal(result.unsignedTransaction, undefined);
    assert.equal(provider.getTransactionCount.mock.callCount(), 0);
    assert.equal(provider.estimateGas.mock.callCount(), 0);
  }
});

test('rejects incompatible partial fee suggestions without changing the explicit limit', async context => {
  for (const fields of [{maxFeePerGas: 1}, {maxPriorityFeePerGas: 11}]) {
    const provider = createProvider(context);
    const input = transaction({nonce: 0, gas: 21000, ...fields});
    const original = structuredClone(input);

    const result = await prepareEvmTransaction(input, address, provider);
    assert.equal(result.error, 'priorityFee cannot be more than maxFee');
    assert.equal(result.unsignedTransaction, undefined);

    assert.deepEqual(input, original);
  }
});

test('rejects a different RPC network before requesting fees, nonce or gas', async context => {
  const provider = createProvider(context);
  provider.getNetwork.mock.mockImplementation(async () => ({chainId: 137n}));

  const result = await prepareEvmTransaction(transaction(), address, provider);
  assert.equal(result.error, 'The RPC uses a different network.');
  assert.equal(result.unsignedTransaction, undefined);

  assert.equal(provider.getFeeData.mock.callCount(), 0);
  assert.equal(provider.getTransactionCount.mock.callCount(), 0);
  assert.equal(provider.estimateGas.mock.callCount(), 0);
});

test('keeps partial preparation after RPC failures without returning signable bytes or mutating the input', async context => {
  const methods = [
    'getNetwork',
    'getFeeData',
    'getTransactionCount',
    'estimateGas',
    'getBalance',
  ];

  for (const [index, method] of methods.entries()) {
    const provider = createProvider(context);
    const input = transaction();
    const original = structuredClone(input);
    const failure = new Error(`${method} failed`);
    provider[method].mock.mockImplementation(async () => {
      throw failure;
    });

    const result = await prepareEvmTransaction(input, address, provider);
    assert.equal(result.error, failure.message);
    assert.equal(result.unsignedTransaction, undefined);
    if (index >= 2) {
      assert.equal(result.transaction.type, 2);
      assert.equal(result.transaction.maxFeePerGas, 10n);
      assert.equal(result.transaction.maxPriorityFeePerGas, 2n);
    }
    if (index >= 3) assert.equal(result.transaction.nonce, 7);
    if (index >= 4) assert.equal(result.transaction.gasLimit, 21000n);

    for (const later of methods.slice(index + 1)) {
      assert.equal(provider[later].mock.callCount(), 0);
    }
    assert.deepEqual(input, original);
  }
});

test('returns stable unsigned bytes and digest without retaining mutable provider or input state', async context => {
  const provider = createProvider(context);
  const input = transaction({
    type: 0,
    nonce: 9,
    gasPrice: '20000000000',
    gas: 21000,
    to: '0x3535353535353535353535353535353535353535',
    value: '1000000000000000000',
  });
  const original = structuredClone(input);
  const expected =
    '0xec098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080018080';

  const result = await prepareEvmTransaction(input, address, provider);
  assert.equal(result.error, undefined);
  const bytes = result.unsignedTransaction;
  const digest = keccak256(bytes);

  assert.equal(bytes, expected);
  assert.deepEqual(input, original);
  input.value = 2n;
  provider.getFeeData.mock.mockImplementation(async () => ({gasPrice: 100n}));

  assert.equal(bytes, expected);
  assert.equal(Transaction.from(bytes).unsignedSerialized, bytes);
  assert.equal(Transaction.from(bytes).unsignedHash, digest);
  assert.equal(digest, keccak256(expected));
});

test('preserves deployment data and an absent recipient during preparation', async context => {
  const provider = createProvider(context);
  const input = transaction({to: null, data: '0x60006000'});
  const result = await prepareEvmTransaction(input, address, provider);
  assert.equal(result.error, undefined);
  const prepared = Transaction.from(result.unsignedTransaction);

  assert.equal(prepared.to, null);
  assert.equal(prepared.data, '0x60006000');
  assert.equal(provider.estimateGas.mock.calls[0].arguments[0].to, null);
});

test('requires balance for the value and retained maximum gas limit after estimation succeeds', async context => {
  for (const type of [0, 1, 2]) {
    const gasLimit = 100000n;
    const fee = 2n ** 100n + 3n;
    const value = 2n ** 180n + 1n;
    const required = value + gasLimit * fee;
    const input = transaction({
      type,
      gas: gasLimit,
      value,
      ...(type === 2
        ? {maxFeePerGas: fee, maxPriorityFeePerGas: 1}
        : {gasPrice: fee}),
    });

    for (const difference of [-1n, 0n]) {
      const provider = createProvider(context);
      provider.getBalance.mock.mockImplementation(
        async () => required + difference,
      );
      const result = await prepareEvmTransaction(input, address, provider);

      assert.equal(provider.estimateGas.mock.callCount(), 1);
      assert.equal(result.transaction.gasLimit, gasLimit);
      if (difference < 0n) {
        assert.equal(
          result.error,
          'Insufficient funds for the amount and maximum gas fee.',
        );
        assert.equal(result.unsignedTransaction, undefined);
        assert.equal(result.transaction.nonce, 7);
      } else {
        assert.equal(result.error, undefined);
        assert.equal(
          Transaction.from(result.unsignedTransaction).gasLimit,
          gasLimit,
        );
      }
    }
  }
});
