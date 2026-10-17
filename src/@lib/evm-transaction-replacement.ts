import {type FeeData, Transaction} from 'ethers';

import {assertEvmGasSettings} from './evm-gas-settings.js';

export type EvmTransactionReplacementKind = 'speed-up' | 'cancel';

export function createEvmTransactionReplacement(
  original: Transaction,
  kind: EvmTransactionReplacementKind,
  fees: FeeData,
  competing: readonly Transaction[] = [],
): Transaction {
  assertSupportedTransaction(original);

  const transactions = [original, ...competing];
  const transaction = Transaction.from(original.unsignedSerialized);

  if (kind === 'cancel') {
    transaction.to = original.from;
    transaction.value = BigInt(0);
    transaction.data = '0x';
    transaction.accessList = original.type === 0 ? null : [];
    transaction.gasLimit = BigInt(21000);
  }

  if (original.type === 2) {
    transaction.maxPriorityFeePerGas = maximum(
      minimumReplacementFee(transactions, 'maxPriorityFeePerGas'),
      fees.maxPriorityFeePerGas ?? BigInt(0),
    );
    transaction.maxFeePerGas = maximum(
      minimumReplacementFee(transactions, 'maxFeePerGas'),
      fees.maxFeePerGas ?? BigInt(0),
      transaction.maxPriorityFeePerGas,
    );
  } else {
    transaction.gasPrice = maximum(
      minimumReplacementFee(transactions, 'gasPrice'),
      fees.gasPrice ?? BigInt(0),
    );
  }

  return transaction;
}

export function assertEvmTransactionReplacement(
  original: Transaction,
  candidate: Transaction,
  kind: EvmTransactionReplacementKind,
  competing: readonly Transaction[] = [],
): void {
  assertSupportedTransaction(original);

  if (
    candidate.type !== original.type ||
    candidate.chainId !== original.chainId ||
    candidate.nonce !== original.nonce
  ) {
    throw new Error(
      'The replacement must use the same network, type and nonce.',
    );
  }

  assertEvmGasSettings(candidate);

  if (kind === 'cancel') {
    if (
      candidate.to !== original.from ||
      candidate.value !== BigInt(0) ||
      candidate.data !== '0x' ||
      candidate.accessList?.length
    ) {
      throw new Error(
        'Cancellation must send zero value to the original sender.',
      );
    }
    if (candidate.gasLimit < BigInt(21000)) {
      throw new Error('Gas limit is too low.');
    }
  } else {
    if (
      candidate.to !== original.to ||
      candidate.value !== original.value ||
      candidate.data !== original.data ||
      JSON.stringify(candidate.accessList) !==
        JSON.stringify(original.accessList)
    ) {
      throw new Error(
        'Speed-up must preserve the original transaction action.',
      );
    }
    if (candidate.gasLimit < original.gasLimit) {
      throw new Error('Speed-up cannot lower the original gas limit.');
    }
  }

  const transactions = [original, ...competing];

  if (original.type === 2) {
    if (
      candidate.maxFeePerGas! <
        minimumReplacementFee(transactions, 'maxFeePerGas') ||
      candidate.maxPriorityFeePerGas! <
        minimumReplacementFee(transactions, 'maxPriorityFeePerGas')
    ) {
      throw new Error(
        'Increase both maximum and priority fees to replace this transaction.',
      );
    }
  } else if (
    candidate.gasPrice! < minimumReplacementFee(transactions, 'gasPrice')
  ) {
    throw new Error('Increase the gas price to replace this transaction.');
  }
}

function assertSupportedTransaction(transaction: Transaction): void {
  if (!transaction.isSigned()) {
    throw new Error('The original transaction must be signed.');
  }
  if (![0, 1, 2].includes(transaction.type)) {
    throw new Error('Unsupported transaction type.');
  }
}

function minimumReplacementFee(
  transactions: readonly Transaction[],
  field: 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas',
): bigint {
  const value = maximum(
    ...transactions.map(transaction =>
      field === 'gasPrice'
        ? (transaction.gasPrice ?? transaction.maxFeePerGas!)
        : (transaction[field] ?? transaction.gasPrice!),
    ),
  );

  return maximum(
    (value * BigInt(1125) + BigInt(999)) / BigInt(1000),
    value + BigInt(1),
  );
}

function maximum(...values: bigint[]): bigint {
  return values.reduce((maximum, value) => (value > maximum ? value : maximum));
}
