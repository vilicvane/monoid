import assert from 'node:assert/strict';
import {test} from 'node:test';

import {FeeData, SigningKey, Transaction} from 'ethers';

const {prepareEvmTransactionReplacement} = await import(
  '../.bld/app/@lib/prepare-evm-transaction-replacement.js'
);

const key = new SigningKey(`0x${'01'.padStart(64, '0')}`);
const recipient = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';
const accessList = [
  {address: recipient, storageKeys: [`0x${'ab'.repeat(32)}`]},
];

function signedTransaction(type = 2) {
  const transaction = Transaction.from({
    type,
    chainId: 1n,
    nonce: 7,
    to: recipient,
    value: 12n,
    data: '0xaabb',
    gasLimit: 60000n,
    ...(type === 2
      ? {maxFeePerGas: 100n, maxPriorityFeePerGas: 8n}
      : {gasPrice: 100n}),
    ...(type === 0 ? {} : {accessList}),
  });
  transaction.signature = key.sign(transaction.unsignedHash);
  return transaction;
}

function createProvider(context) {
  return {
    getNetwork: context.mock.fn(async () => ({chainId: 1n})),
    getFeeData: context.mock.fn(async () => new FeeData(100n, 100n, 8n)),
    getTransactionCount: context.mock.fn(async () => 99),
    estimateGas: context.mock.fn(async () => 30000n),
    getBalance: context.mock.fn(async (_address, block) =>
      block === 'latest' ? 2n ** 255n : 0n,
    ),
  };
}

function gasSettings(type = 2, overrides = {}) {
  return {
    gasLimit: 60000n,
    gasPrice: type === 2 ? null : 120n,
    maxFeePerGas: type === 2 ? 120n : null,
    maxPriorityFeePerGas: type === 2 ? 10n : null,
    ...overrides,
  };
}

test('replacement checks latest balance without subtracting the pending transaction a second time', async context => {
  const original = signedTransaction();
  const provider = createProvider(context);
  provider.getBalance.mock.mockImplementation(async (_address, block) =>
    block === 'latest' ? 60000n * 113n + 12n : 0n,
  );

  const result = await prepareEvmTransactionReplacement(
    original,
    'speed-up',
    provider,
  );

  assert.equal(result.error, undefined);
  assert.ok(result.unsignedTransaction);
  assert.deepEqual(provider.getBalance.mock.calls[0].arguments, [
    original.from,
    'latest',
  ]);
  assert.equal(provider.getBalance.mock.callCount(), 1);
});

test('speed-up preparation preserves the signed action and gas limit without fetching a new nonce', async context => {
  for (const type of [0, 1, 2]) {
    const original = signedTransaction(type);
    const serialized = original.serialized;
    const provider = createProvider(context);
    const result = await prepareEvmTransactionReplacement(
      original,
      'speed-up',
      provider,
    );

    assert.equal(result.error, undefined);
    const prepared = Transaction.from(result.unsignedTransaction);

    assert.equal(prepared.chainId, original.chainId);
    assert.equal(prepared.type, original.type);
    assert.equal(prepared.nonce, original.nonce);
    assert.equal(prepared.to, original.to);
    assert.equal(prepared.value, original.value);
    assert.equal(prepared.data, original.data);
    assert.deepEqual(prepared.accessList, original.accessList);
    assert.equal(prepared.gasLimit, original.gasLimit);
    assert.equal(prepared.signature, null);
    assert.equal(original.serialized, serialized);
    assert.equal(provider.getTransactionCount.mock.callCount(), 0);
    assert.equal(provider.getFeeData.mock.callCount(), 1);
    assert.equal(
      provider.estimateGas.mock.calls[0].arguments[0].from,
      original.from,
    );
    assert.equal(
      provider.estimateGas.mock.calls[0].arguments[0].nonce,
      original.nonce,
    );
  }
});

test('cancellation estimates self-send gas without enforcing a 21000 ceiling', async context => {
  for (const type of [0, 1, 2]) {
    const original = signedTransaction(type);
    const serialized = original.serialized;
    const provider = createProvider(context);
    provider.estimateGas.mock.mockImplementation(async () => 45000n);

    const result = await prepareEvmTransactionReplacement(
      original,
      'cancel',
      provider,
    );

    assert.equal(result.error, undefined);
    const prepared = Transaction.from(result.unsignedTransaction);
    const estimateInput = provider.estimateGas.mock.calls[0].arguments[0];

    assert.equal(estimateInput.gasLimit, undefined);
    assert.equal(estimateInput.from, original.from);
    assert.equal(estimateInput.to, original.from);
    assert.equal(estimateInput.value, 0n);
    assert.equal(estimateInput.data, '0x');
    assert.deepEqual(estimateInput.accessList, type === 0 ? null : []);
    assert.equal(prepared.to, original.from);
    assert.equal(prepared.value, 0n);
    assert.equal(prepared.data, '0x');
    assert.equal(prepared.gasLimit, 45000n);
    assert.equal(prepared.chainId, original.chainId);
    assert.equal(prepared.type, original.type);
    assert.equal(prepared.nonce, original.nonce);
    assert.equal(prepared.signature, null);
    assert.equal(original.serialized, serialized);
    assert.equal(provider.getTransactionCount.mock.callCount(), 0);
  }
});

test('edited gas settings are preserved when they meet both estimate and replacement requirements', async context => {
  for (const kind of ['speed-up', 'cancel']) {
    for (const type of [0, 1, 2]) {
      const original = signedTransaction(type);
      const provider = createProvider(context);
      const settings = gasSettings(type, {gasLimit: 65000n});
      const result = await prepareEvmTransactionReplacement(
        original,
        kind,
        provider,
        settings,
      );

      assert.equal(result.error, undefined);
      const prepared = Transaction.from(result.unsignedTransaction);

      assert.equal(prepared.gasLimit, settings.gasLimit);
      assert.equal(prepared.gasPrice, settings.gasPrice);
      assert.equal(prepared.maxFeePerGas, settings.maxFeePerGas);
      assert.equal(
        prepared.maxPriorityFeePerGas,
        settings.maxPriorityFeePerGas,
      );
      assert.equal(prepared.nonce, original.nonce);
      assert.equal(prepared.type, original.type);
      assert.equal(
        provider.estimateGas.mock.calls[0].arguments[0].gasLimit,
        65000n,
      );
    }
  }
});

test('underpriced fee edits return an error without signable bytes', async context => {
  for (const [type, overrides, message] of [
    [0, {gasPrice: 112n}, /Increase the gas price/],
    [1, {gasPrice: 112n}, /Increase the gas price/],
    [2, {maxFeePerGas: 112n}, /Increase both maximum and priority fees/],
    [2, {maxPriorityFeePerGas: 8n}, /Increase both maximum and priority fees/],
  ]) {
    const original = signedTransaction(type);
    const settings = gasSettings(type, overrides);
    const result = await prepareEvmTransactionReplacement(
      original,
      'speed-up',
      createProvider(context),
      settings,
    );

    assert.equal(result.unsignedTransaction, undefined);
    assert.match(result.error, message);
    assert.equal(result.transaction.gasPrice, settings.gasPrice);
    assert.equal(result.transaction.maxFeePerGas, settings.maxFeePerGas);
    assert.equal(
      result.transaction.maxPriorityFeePerGas,
      settings.maxPriorityFeePerGas,
    );
  }
});

test('invalid fee combinations and gas settings cannot produce signable bytes', async context => {
  for (const [type, overrides] of [
    [2, {gasPrice: 120n}],
    [2, {maxFeePerGas: 120n, maxPriorityFeePerGas: 121n}],
    [2, {maxPriorityFeePerGas: -1n}],
    [0, {gasPrice: -1n}],
    [1, {gasPrice: 120n, maxFeePerGas: 120n}],
    [2, {gasLimit: 0n}],
  ]) {
    const result = await prepareEvmTransactionReplacement(
      signedTransaction(type),
      'speed-up',
      createProvider(context),
      gasSettings(type, overrides),
    );

    assert.equal(result.unsignedTransaction, undefined);
    assert.ok(result.error);
  }
});

test('speed-up cannot silently reduce the original gas allowance even when the new estimate is lower', async context => {
  const result = await prepareEvmTransactionReplacement(
    signedTransaction(),
    'speed-up',
    createProvider(context),
    gasSettings(2, {gasLimit: 40000n}),
  );

  assert.equal(result.unsignedTransaction, undefined);
  assert.equal(result.error, 'Speed-up cannot lower the original gas limit.');
  assert.equal(result.transaction.gasLimit, 40000n);
});

test('gas estimate failure retains the cancellation action for display', async context => {
  const original = signedTransaction();
  const provider = createProvider(context);
  provider.estimateGas.mock.mockImplementation(async () => {
    throw new Error('Execution reverted.');
  });

  const result = await prepareEvmTransactionReplacement(
    original,
    'cancel',
    provider,
  );

  assert.equal(result.unsignedTransaction, undefined);
  assert.equal(result.error, 'Execution reverted.');
  assert.equal(result.transaction.to, original.from);
  assert.equal(result.transaction.value, 0n);
  assert.equal(result.transaction.data, '0x');
  assert.deepEqual(result.transaction.accessList, []);
  assert.equal(provider.getBalance.mock.callCount(), 0);
});

test('fee lookup failure still returns zero-value cancellation rather than the original action', async context => {
  for (const type of [0, 1, 2]) {
    const original = signedTransaction(type);
    const provider = createProvider(context);
    provider.getFeeData.mock.mockImplementation(async () => {
      throw new Error('Fee lookup unavailable.');
    });

    const result = await prepareEvmTransactionReplacement(
      original,
      'cancel',
      provider,
    );

    assert.equal(result.unsignedTransaction, undefined);
    assert.equal(result.error, 'Fee lookup unavailable.');
    assert.equal(result.transaction.to, original.from);
    assert.equal(result.transaction.value, 0n);
    assert.equal(result.transaction.data, '0x');
    assert.deepEqual(result.transaction.accessList, type === 0 ? null : []);
    assert.equal(result.transaction.type, original.type);
    assert.equal(result.transaction.nonce, original.nonce);
    assert.equal(result.transaction.chainId, original.chainId);
    assert.equal(provider.estimateGas.mock.callCount(), 0);
    assert.equal(provider.getBalance.mock.callCount(), 0);
  }
});

test('latest balance must still cover the higher replacement fee', async context => {
  const provider = createProvider(context);
  provider.getBalance.mock.mockImplementation(async () => 60000n * 113n + 11n);
  const result = await prepareEvmTransactionReplacement(
    signedTransaction(),
    'speed-up',
    provider,
  );

  assert.equal(result.unsignedTransaction, undefined);
  assert.equal(
    result.error,
    'Insufficient funds for the amount and maximum gas fee.',
  );
});

test('an RPC network mismatch cannot prepare a replacement on another chain', async context => {
  const provider = createProvider(context);
  provider.getNetwork.mock.mockImplementation(async () => ({chainId: 10n}));
  const result = await prepareEvmTransactionReplacement(
    signedTransaction(),
    'speed-up',
    provider,
  );

  assert.equal(result.unsignedTransaction, undefined);
  assert.equal(result.error, 'The RPC uses a different network.');
  assert.equal(provider.estimateGas.mock.callCount(), 0);
});

test('replacement preparation accounts for previously submitted competitors before and after fee edits', async context => {
  const original = signedTransaction();
  const competing = Transaction.from(original.unsignedSerialized);
  competing.maxFeePerGas = 200n;
  competing.maxPriorityFeePerGas = 20n;
  competing.signature = key.sign(competing.unsignedHash);

  const result = await prepareEvmTransactionReplacement(
    original,
    'cancel',
    createProvider(context),
    undefined,
    [competing],
  );
  assert.equal(result.error, undefined);
  const prepared = Transaction.from(result.unsignedTransaction);
  assert.equal(prepared.maxFeePerGas, 225n);
  assert.equal(prepared.maxPriorityFeePerGas, 23n);
  assert.equal(prepared.to, original.from);
  assert.equal(prepared.value, 0n);

  const underpriced = await prepareEvmTransactionReplacement(
    original,
    'cancel',
    createProvider(context),
    gasSettings(),
    [competing],
  );
  assert.equal(underpriced.unsignedTransaction, undefined);
  assert.match(underpriced.error, /Increase both maximum and priority fees/);
});

test('fee lookup failure retains the competitor-aware cancellation fees for display', async context => {
  const original = signedTransaction();
  const competing = Transaction.from(original.unsignedSerialized);
  competing.maxFeePerGas = 200n;
  competing.maxPriorityFeePerGas = 20n;
  competing.signature = key.sign(competing.unsignedHash);
  const provider = createProvider(context);
  provider.getFeeData.mock.mockImplementation(async () => {
    throw new Error('Fee lookup unavailable.');
  });

  const result = await prepareEvmTransactionReplacement(
    original,
    'cancel',
    provider,
    undefined,
    [competing],
  );

  assert.equal(result.unsignedTransaction, undefined);
  assert.equal(result.error, 'Fee lookup unavailable.');
  assert.equal(result.transaction.to, original.from);
  assert.equal(result.transaction.value, 0n);
  assert.equal(result.transaction.maxFeePerGas, 225n);
  assert.equal(result.transaction.maxPriorityFeePerGas, 23n);
});
