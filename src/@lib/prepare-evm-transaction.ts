import {
  type Provider,
  Transaction,
  type TransactionLike,
  getBigInt,
} from 'ethers';

import {formatEvmTransactionError} from './evm-transaction-error.js';

export type EvmTransactionPreparation = {
  transaction: TransactionLike<string>;
  unsignedTransaction?: string;
  error?: string;
};

export async function prepareEvmTransaction(
  input: TransactionLike<string>,
  address: string,
  provider: Provider,
): Promise<EvmTransactionPreparation> {
  const transaction = {...input};

  try {
    const network = await provider.getNetwork();
    if (network.chainId !== getBigInt(input.chainId!)) {
      throw new Error('The RPC uses a different network.');
    }

    if (transaction.type == null) {
      if (transaction.gasPrice != null) {
        transaction.type = transaction.accessList == null ? 0 : 1;
      } else if (
        transaction.maxFeePerGas != null ||
        transaction.maxPriorityFeePerGas != null
      ) {
        transaction.type = 2;
      }
    }

    if (
      transaction.type == null ||
      (transaction.type === 2
        ? transaction.maxFeePerGas == null ||
          transaction.maxPriorityFeePerGas == null
        : transaction.gasPrice == null)
    ) {
      const fees = await provider.getFeeData();

      transaction.type ??=
        fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null
          ? 2
          : transaction.accessList == null
            ? 0
            : 1;

      if (transaction.type === 2) {
        transaction.maxFeePerGas ??= fees.maxFeePerGas;
        transaction.maxPriorityFeePerGas ??= fees.maxPriorityFeePerGas;
      } else {
        transaction.gasPrice ??= fees.gasPrice;
      }
    }

    if (
      transaction.type === 2
        ? transaction.maxFeePerGas == null ||
          transaction.maxPriorityFeePerGas == null
        : transaction.gasPrice == null
    ) {
      throw new Error('Could not determine transaction fees.');
    }

    transaction.nonce ??= await provider.getTransactionCount(
      address,
      'pending',
    );
    const estimatedGas = await provider.estimateGas({
      ...transaction,
      from: address,
    });

    if (
      transaction.gasLimit != null &&
      getBigInt(transaction.gasLimit) < estimatedGas
    ) {
      throw new Error('Gas limit is too low.');
    }
    transaction.gasLimit ??= estimatedGas;

    const prepared = Transaction.from(transaction);
    const unsignedTransaction = prepared.unsignedSerialized;
    const fee =
      prepared.type === 2 ? prepared.maxFeePerGas! : prepared.gasPrice!;
    const required = prepared.value + prepared.gasLimit * fee;
    const balance = await provider.getBalance(address, 'pending');

    if (balance < required) {
      throw new Error('Insufficient funds for the amount and maximum gas fee.');
    }

    // Review and signing use these same bytes, without repopulating the transaction.
    return {transaction, unsignedTransaction};
  } catch (error) {
    return {transaction, error: formatEvmTransactionError(error)};
  }
}
