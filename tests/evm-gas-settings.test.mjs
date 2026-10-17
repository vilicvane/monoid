import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Transaction} from 'ethers';

const {applyEvmGasSettings, assertEvmGasSettings, getEvmGasPresets} =
  await import('../.bld/app/@lib/evm-gas-settings.js');

const transaction = Object.freeze({
  type: 2,
  gasLimit: 21000n,
  gasPrice: null,
  maxFeePerGas: 100000000000n,
  maxPriorityFeePerGas: 2000000000n,
});

function history(rewards, baseFee = 100n, ratios = rewards.map(() => 0.5)) {
  return {
    baseFeePerGas: [...rewards.map(() => '0x1'), `0x${baseFee.toString(16)}`],
    reward: rewards.map(row => row.map(value => `0x${value.toString(16)}`)),
    gasUsedRatio: ratios,
  };
}

test('fee history uses per-column median rewards and the next block base fee', async context => {
  const provider = {
    send: context.mock.fn(async () =>
      history([
        [8n, 20n, 100n],
        [1n, 10n, 30n],
        [5n, 15n, 40n],
        [6n, 16n, 50n],
        [2n, 11n, 35n],
      ]),
    ),
  };

  const presets = await getEvmGasPresets(transaction, provider);

  assert.deepEqual(provider.send.mock.calls[0].arguments, [
    'eth_feeHistory',
    ['0x5', 'latest', [10, 50, 90]],
  ]);
  assert.deepEqual(
    Object.values(presets).map(settings => settings.maxPriorityFeePerGas),
    [5n, 15n, 40n],
  );
  assert.deepEqual(
    Object.values(presets).map(settings => settings.maxFeePerGas),
    [205n, 215n, 240n],
  );
  assert.ok(
    Object.values(presets).every(settings => settings.gasLimit === 21000n),
  );
  assert.equal(transaction.maxFeePerGas, 100000000000n);
});

test('empty blocks are excluded while zero rewards in active blocks remain valid', async () => {
  const provider = {
    send: async () =>
      history(
        [
          [0n, 0n, 0n],
          [0n, 2n, 4n],
          [0n, 3n, 5n],
        ],
        0n,
        [0, 0.5, 0.5],
      ),
  };

  const presets = await getEvmGasPresets(transaction, provider);

  assert.deepEqual(
    Object.values(presets).map(settings => settings.maxPriorityFeePerGas),
    [0n, 3n, 5n],
  );
  assert.equal(presets.economy.maxFeePerGas, 0n);
});

test('fee history preserves integer precision above the Number safe range', async () => {
  const value = 2n ** 180n;
  const provider = {
    send: async () => history([[value + 1n, value + 2n, value + 3n]], value),
  };

  const presets = await getEvmGasPresets(transaction, provider);

  assert.equal(presets.economy.maxFeePerGas, value * 3n + 1n);
  assert.equal(presets.standard.maxFeePerGas, value * 3n + 2n);
  assert.equal(presets.fast.maxFeePerGas, value * 3n + 3n);
});

test('unsupported, empty and malformed histories fall back to current RPC fees', async () => {
  for (const response of [
    new Error('Method not supported'),
    history([[0n, 0n, 0n]], 100n, [0]),
    null,
    {...history([[1n, 2n, 3n]]), reward: [['bad', '0x2', '0x3']]},
    {...history([[1n, 2n, 3n]]), gasUsedRatio: []},
    {...history([[1n, 2n, 3n]]), gasUsedRatio: [NaN]},
  ]) {
    const provider = {
      send: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
      getFeeData: async () => ({maxPriorityFeePerGas: 11n}),
      getBlock: async () => ({baseFeePerGas: 100n}),
    };

    const presets = await getEvmGasPresets(transaction, provider);

    assert.deepEqual(
      Object.values(presets).map(settings => settings.maxPriorityFeePerGas),
      [9n, 11n, 14n],
    );
    assert.deepEqual(
      Object.values(presets).map(settings => settings.maxFeePerGas),
      [209n, 211n, 214n],
    );
  }
});

test('legacy and access-list presets use rounded-up RPC gas prices without changing transaction type', async () => {
  for (const type of [0, 1]) {
    const legacy = {
      ...transaction,
      type,
      gasPrice: 50n,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    };
    const price = 2n ** 180n + 3n;
    const presets = await getEvmGasPresets(legacy, {
      getFeeData: async () => ({gasPrice: price}),
    });

    assert.deepEqual(
      Object.values(presets).map(settings => settings.gasPrice),
      [(price * 80n + 99n) / 100n, price, (price * 120n + 99n) / 100n],
    );
    assert.ok(
      Object.values(presets).every(
        settings =>
          settings.gasLimit === transaction.gasLimit &&
          settings.maxFeePerGas === null &&
          settings.maxPriorityFeePerGas === null,
      ),
    );
  }
});

test('missing fee suggestions reject instead of applying an invented preset', async () => {
  const provider = {
    send: async () => null,
    getFeeData: async () => ({gasPrice: null, maxPriorityFeePerGas: null}),
    getBlock: async () => null,
  };

  await assert.rejects(getEvmGasPresets(transaction, provider), /determine/);
  await assert.rejects(
    getEvmGasPresets({...transaction, type: 0}, provider),
    /determine/,
  );
});

test('settings require positive gas and unsigned 256-bit fees with a sufficient cap', () => {
  const maximum = 2n ** 256n - 1n;

  assert.doesNotThrow(() =>
    assertEvmGasSettings({
      ...transaction,
      gasLimit: maximum,
      maxFeePerGas: maximum,
      maxPriorityFeePerGas: maximum,
    }),
  );
  assert.doesNotThrow(() =>
    assertEvmGasSettings({
      ...transaction,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    }),
  );

  for (const gasLimit of [0n, -1n, maximum + 1n, 1, null]) {
    assert.throws(
      () => assertEvmGasSettings({...transaction, gasLimit}),
      /Gas limit/,
    );
  }
  for (const field of ['maxFeePerGas', 'maxPriorityFeePerGas']) {
    for (const value of [-1n, maximum + 1n, 1, null]) {
      assert.throws(
        () => assertEvmGasSettings({...transaction, [field]: value}),
        /Gas fees/,
      );
    }
  }
  assert.throws(
    () => assertEvmGasSettings({...transaction, maxFeePerGas: 1n}),
    /Priority fee cannot exceed/,
  );

  const legacy = {
    ...transaction,
    type: 0,
    gasPrice: 0n,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
  };

  assert.doesNotThrow(() => assertEvmGasSettings(legacy));
  for (const gasPrice of [-1n, maximum + 1n, null]) {
    assert.throws(
      () => assertEvmGasSettings({...legacy, gasPrice}),
      /Gas price/,
    );
  }
  assert.throws(() => assertEvmGasSettings({...transaction, gasPrice: 1n}));
  assert.throws(() => assertEvmGasSettings({...legacy, maxFeePerGas: 1n}));
});

test('applying settings preserves every non-gas transaction field and never carries a signature', () => {
  for (const type of [0, 1, 2]) {
    const original = Transaction.from({
      ...transaction,
      type,
      chainId: 11155111,
      to: '0x1111111111111111111111111111111111111111',
      value: 2n ** 180n,
      nonce: 3,
      data: '0x12345678',
      gasPrice: type === 2 ? null : 123n,
      maxFeePerGas: type === 2 ? 123n : null,
      maxPriorityFeePerGas: type === 2 ? 12n : null,
      accessList:
        type === 0
          ? null
          : [
              {
                address: '0x2222222222222222222222222222222222222222',
                storageKeys: [`0x${'0'.repeat(63)}1`],
              },
            ],
      signature: {r: `0x${'0'.repeat(63)}1`, s: `0x${'0'.repeat(63)}1`, v: 27},
    });
    const settings = {
      gasLimit: 35000n,
      gasPrice: type === 2 ? null : 456n,
      maxFeePerGas: type === 2 ? 456n : null,
      maxPriorityFeePerGas: type === 2 ? 45n : null,
      // Only the four gas fields are accepted, even if additional data is passed.
      type: 2,
      to: '0x3333333333333333333333333333333333333333',
    };
    const result = Transaction.from(
      applyEvmGasSettings(original.serialized, settings),
    );

    for (const field of [
      'type',
      'chainId',
      'to',
      'value',
      'nonce',
      'data',
      'accessList',
    ]) {
      assert.deepEqual(result[field], original[field]);
    }
    for (const field of [
      'gasLimit',
      'gasPrice',
      'maxFeePerGas',
      'maxPriorityFeePerGas',
    ]) {
      assert.equal(result[field], settings[field]);
    }
    assert.equal(result.signature, null);
    assert.notEqual(original.signature, null);
    assert.equal(original.gasLimit, 21000n);
  }
});

test('applying conflicting or out-of-range gas settings cannot produce signing bytes', () => {
  const original = Transaction.from({
    ...transaction,
    chainId: 1,
  }).unsignedSerialized;

  assert.throws(() =>
    applyEvmGasSettings(original, {...transaction, maxFeePerGas: 1n}),
  );
  assert.throws(() =>
    applyEvmGasSettings(original, {...transaction, gasLimit: 2n ** 256n}),
  );
});
