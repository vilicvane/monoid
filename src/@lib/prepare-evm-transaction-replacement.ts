import {
  FeeData,
  type Provider,
  Transaction,
  type TransactionLike,
} from 'ethers';

import {type EvmGasSettings, assertEvmGasSettings} from './evm-gas-settings.js';
import {formatEvmTransactionError} from './evm-transaction-error.js';
import {
  type EvmTransactionReplacementKind,
  assertEvmTransactionReplacement,
  createEvmTransactionReplacement,
} from './evm-transaction-replacement.js';
import {
  type EvmTransactionPreparation,
  prepareEvmTransaction,
} from './prepare-evm-transaction.js';

export function getEvmTransactionInput(
  transaction: Transaction,
): TransactionLike<string> {
  const {
    type,
    chainId,
    nonce,
    to,
    value,
    data,
    accessList,
    gasLimit,
    gasPrice,
    maxFeePerGas,
    maxPriorityFeePerGas,
  } = transaction;
  return {
    type,
    chainId,
    nonce,
    to,
    value,
    data,
    accessList,
    gasLimit,
    gasPrice,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
}

export async function prepareEvmTransactionReplacement(
  original: Transaction,
  kind: EvmTransactionReplacementKind,
  provider: Provider,
  settings?: EvmGasSettings,
  competing: readonly Transaction[] = [],
): Promise<EvmTransactionPreparation> {
  let input = {
    ...getEvmTransactionInput(
      createEvmTransactionReplacement(
        original,
        kind,
        new FeeData(null, null, null),
        competing,
      ),
    ),
    ...settings,
  };

  try {
    if (settings) assertEvmGasSettings({...settings, type: original.type});
    const replacement = createEvmTransactionReplacement(
      original,
      kind,
      await provider.getFeeData(),
      competing,
    );
    input = {...getEvmTransactionInput(replacement), ...settings};
    if (kind === 'cancel' && !settings) input.gasLimit = undefined;

    // Pending balance may already include the transaction being replaced.
    const result = await prepareEvmTransaction(
      input,
      original.from!,
      provider,
      'latest',
    );
    if (result.unsignedTransaction) {
      assertEvmTransactionReplacement(
        original,
        Transaction.from(result.unsignedTransaction),
        kind,
        competing,
      );
    }
    return result;
  } catch (error) {
    return {transaction: input, error: formatEvmTransactionError(error)};
  }
}
