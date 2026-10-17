import {type JsonRpcProvider, Transaction} from 'ethers';

import type {EvmGasTransaction} from './evm-gas.js';

const UINT256_LIMIT = BigInt(1) << BigInt(256);

export type EvmGasSettings = Pick<
  Transaction,
  'gasLimit' | 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'
>;

export type EvmGasPresets = Record<
  'economy' | 'standard' | 'fast',
  EvmGasSettings
>;

export function assertEvmGasSettings(transaction: EvmGasTransaction): void {
  if (!isQuantity(transaction.gasLimit) || transaction.gasLimit === BigInt(0)) {
    throw new Error('Gas limit must be a positive integer below 2²⁵⁶.');
  }

  if (transaction.type === 2) {
    if (
      transaction.gasPrice !== null ||
      !isQuantity(transaction.maxFeePerGas) ||
      !isQuantity(transaction.maxPriorityFeePerGas)
    ) {
      throw new Error('Gas fees must be non-negative integers below 2²⁵⁶.');
    }
    if (transaction.maxPriorityFeePerGas > transaction.maxFeePerGas) {
      throw new Error('Priority fee cannot exceed the maximum fee.');
    }
  } else if (transaction.type === 0 || transaction.type === 1) {
    if (
      !isQuantity(transaction.gasPrice) ||
      transaction.maxFeePerGas !== null ||
      transaction.maxPriorityFeePerGas !== null
    ) {
      throw new Error('Gas price must be a non-negative integer below 2²⁵⁶.');
    }
  } else {
    throw new Error('Unsupported transaction type.');
  }
}

export function applyEvmGasSettings(
  unsignedTransaction: string,
  settings: EvmGasSettings,
): string {
  const transaction = Transaction.from(unsignedTransaction);

  transaction.gasLimit = settings.gasLimit;
  transaction.gasPrice = settings.gasPrice;
  transaction.maxFeePerGas = settings.maxFeePerGas;
  transaction.maxPriorityFeePerGas = settings.maxPriorityFeePerGas;
  transaction.signature = null;

  assertEvmGasSettings(transaction);

  return transaction.unsignedSerialized;
}

export async function getEvmGasPresets(
  transaction: EvmGasTransaction,
  provider: JsonRpcProvider,
): Promise<EvmGasPresets> {
  let baseFee: bigint | undefined;
  let prices: bigint[];

  if (transaction.type === 2) {
    try {
      const history = parseFeeHistory(
        await provider.send('eth_feeHistory', ['0x5', 'latest', [10, 50, 90]]),
      );

      baseFee = history.baseFee;
      prices = history.priorities;
    } catch {
      const [fees, block] = await Promise.all([
        provider.getFeeData(),
        provider.getBlock('latest'),
      ]);

      if (
        !isQuantity(fees.maxPriorityFeePerGas) ||
        !isQuantity(block?.baseFeePerGas)
      ) {
        throw new Error('Could not determine transaction fees.');
      }

      baseFee = block.baseFeePerGas;
      prices = scalePrices(fees.maxPriorityFeePerGas);
    }
  } else {
    const fees = await provider.getFeeData();

    if (!isQuantity(fees.gasPrice)) {
      throw new Error('Could not determine transaction fees.');
    }

    prices = scalePrices(fees.gasPrice);
  }

  const settings = prices.map(price => {
    const settings: EvmGasSettings = {
      gasLimit: transaction.gasLimit,
      gasPrice: baseFee === undefined ? price : null,
      maxFeePerGas: baseFee === undefined ? null : baseFee * BigInt(2) + price,
      maxPriorityFeePerGas: baseFee === undefined ? null : price,
    };

    assertEvmGasSettings({...settings, type: transaction.type});

    return settings;
  });

  return {economy: settings[0], standard: settings[1], fast: settings[2]};
}

function isQuantity(value: unknown): value is bigint {
  return (
    typeof value === 'bigint' && value >= BigInt(0) && value < UINT256_LIMIT
  );
}

function scalePrices(price: bigint): bigint[] {
  return [80, 100, 120].map(
    percent => (price * BigInt(percent) + BigInt(99)) / BigInt(100),
  );
}

function parseFeeHistory(input: unknown): {
  baseFee: bigint;
  priorities: bigint[];
} {
  const history = input as {
    baseFeePerGas: unknown[];
    reward: unknown[][];
    gasUsedRatio: unknown[];
  };

  if (
    !history ||
    !Array.isArray(history.baseFeePerGas) ||
    !Array.isArray(history.reward) ||
    !Array.isArray(history.gasUsedRatio) ||
    history.reward.length === 0 ||
    history.baseFeePerGas.length !== history.reward.length + 1 ||
    history.gasUsedRatio.length !== history.reward.length
  ) {
    throw new Error('Invalid fee history.');
  }

  const rewards = history.reward.flatMap((row, index) => {
    const ratio = history.gasUsedRatio[index];

    if (
      typeof ratio !== 'number' ||
      !Number.isFinite(ratio) ||
      ratio < 0 ||
      ratio > 1
    ) {
      throw new Error('Invalid fee history.');
    }
    if (ratio === 0) return [];
    if (!Array.isArray(row) || row.length !== 3) {
      throw new Error('Invalid fee history.');
    }

    const values = row.map(parseQuantity);

    if (values[0] > values[1] || values[1] > values[2]) {
      throw new Error('Invalid fee history.');
    }

    return [values];
  });

  if (rewards.length === 0)
    throw new Error('Fee history has no active blocks.');

  const priorities = [0, 1, 2].map(index => {
    const values = rewards
      .map(row => row[index])
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const middle = Math.floor(values.length / 2);

    return values.length % 2 === 1
      ? values[middle]
      : (values[middle - 1] + values[middle] + BigInt(1)) / BigInt(2);
  });

  return {
    baseFee: parseQuantity(history.baseFeePerGas.at(-1)),
    priorities,
  };
}

function parseQuantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[\da-f]+$/i.test(value)) {
    throw new Error('Invalid fee history quantity.');
  }

  const quantity = BigInt(value);

  if (!isQuantity(quantity)) throw new Error('Invalid fee history quantity.');

  return quantity;
}
