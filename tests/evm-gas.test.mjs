import assert from 'node:assert/strict';
import {test} from 'node:test';

const {compareEvmGas, estimateEvmGas} = await import(
  '../.bld/app/@lib/evm-gas.js'
);

const transaction = Object.freeze({
  type: 2,
  gasLimit: 21000n,
  gasPrice: null,
  maxFeePerGas: 100000000000n,
  maxPriorityFeePerGas: 2000000000n,
});

test('EIP-1559 keeps the network base fee distinct from the transaction cap and includes its priority fee in the estimate', async context => {
  const provider = {
    getBlock: context.mock.fn(async () => ({
      number: 1000,
      baseFeePerGas: 30000000000n,
    })),
  };

  assert.deepEqual(await estimateEvmGas(transaction, provider), {
    networkFeePerGas: 30000000000n,
    expectedFee: 21000n * 32000000000n,
  });
  assert.deepEqual(provider.getBlock.mock.calls[0].arguments, ['latest']);
  assert.equal(transaction.maxFeePerGas, 100000000000n);
});

test('EIP-1559 estimated execution fee never exceeds the reviewed maximum', async () => {
  const limited = {...transaction, maxFeePerGas: 31000000000n};
  const provider = {
    getBlock: async () => ({number: 1000, baseFeePerGas: 30000000000n}),
  };

  assert.deepEqual(await estimateEvmGas(limited, provider), {
    networkFeePerGas: 30000000000n,
    expectedFee: limited.gasLimit * limited.maxFeePerGas,
  });
});

test('zero base and priority fees remain valid estimates', async () => {
  const free = {...transaction, maxPriorityFeePerGas: 0n};
  const provider = {getBlock: async () => ({number: 1000, baseFeePerGas: 0n})};

  assert.deepEqual(await estimateEvmGas(free, provider), {
    networkFeePerGas: 0n,
    expectedFee: 0n,
  });
});

test('a missing block or base fee does not substitute the maximum for an expected fee', async () => {
  for (const block of [null, {}, {baseFeePerGas: null}]) {
    const provider = {getBlock: async () => block};

    assert.deepEqual(await estimateEvmGas(transaction, provider), {});
  }
});

test('legacy and access-list transactions use their reviewed price even when the network suggestion differs', async () => {
  for (const type of [0, 1]) {
    const legacy = Object.freeze({
      ...transaction,
      type,
      gasPrice: 30000000000n,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    });
    const provider = {getFeeData: async () => ({gasPrice: 10000000000n})};

    assert.deepEqual(await estimateEvmGas(legacy, provider), {
      networkFeePerGas: 10000000000n,
      expectedFee: 21000n * 30000000000n,
    });
    assert.equal(legacy.gasPrice, 30000000000n);
  }
});

test('an unavailable legacy network suggestion still permits the reviewed execution fee estimate', async () => {
  const legacy = {...transaction, type: 0, gasPrice: 0n};
  const provider = {getFeeData: async () => ({gasPrice: null})};

  assert.deepEqual(await estimateEvmGas(legacy, provider), {
    networkFeePerGas: undefined,
    expectedFee: 0n,
  });
});

test('network lookup failures propagate without changing reviewed transaction fields', async () => {
  const failure = new Error('Network unavailable');
  const provider = {
    getBlock: async () => {
      throw failure;
    },
    getFeeData: async () => {
      throw failure;
    },
  };

  for (const type of [0, 2]) {
    const reviewed = Object.freeze({...transaction, type, gasPrice: 1n});
    const original = {...reviewed};

    await assert.rejects(estimateEvmGas(reviewed, provider), failure);
    assert.deepEqual(reviewed, original);
  }
});

test('24-hour comparison uses strict percentile boundaries with equality remaining normal', () => {
  for (const [fee, level] of [
    [24n, 'low'],
    [25n, 'normal'],
    [50n, 'normal'],
    [75n, 'normal'],
    [76n, 'high'],
  ]) {
    assert.deepEqual(compareEvmGas(fee, {p25: '25', p75: '75'}), {
      level,
      window: '24h',
    });
  }
});

test('flat and zero-fee histories are normal at their shared percentile', () => {
  for (const fee of [0n, 100n]) {
    assert.deepEqual(compareEvmGas(fee, {p25: String(fee), p75: String(fee)}), {
      level: 'normal',
      window: '24h',
    });
  }
});

test('comparison retains decimal integer precision beyond Number safe integers', () => {
  const fee = 2n ** 200n;
  const history = Object.freeze({p25: String(fee), p75: String(fee + 1n)});

  assert.deepEqual(compareEvmGas(fee - 1n, history), {
    level: 'low',
    window: '24h',
  });
  assert.deepEqual(compareEvmGas(fee + 2n, history), {
    level: 'high',
    window: '24h',
  });
});
