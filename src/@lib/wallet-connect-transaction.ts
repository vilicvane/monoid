import {Transaction, type TransactionLike, accessListify} from 'ethers';

import {assertEvmGasSettings} from './evm-gas-settings.js';
import type {WalletConnectTransactionRequest} from './wallet-connect-request.js';

export function assertWalletConnectTransaction(
  payload: WalletConnectTransactionRequest,
  unsignedTransaction: string,
): void {
  const transaction = Transaction.from(unsignedTransaction);
  if (transaction.signature || ![0, 1, 2].includes(transaction.type!)) {
    throw new Error('Invalid unsigned transaction.');
  }
  assertEvmGasSettings(transaction);

  // Gas settings belong to the wallet; the requested action must stay unchanged.
  for (const field of [
    'chainId',
    'to',
    'data',
    'value',
    'nonce',
    'type',
  ] as const) {
    const expected = payload.transaction[field];
    if (expected !== undefined && transaction[field] !== expected) {
      throw new Error('The transaction no longer matches the request.');
    }
  }

  if (
    payload.transaction.accessList !== undefined &&
    JSON.stringify(transaction.accessList) !==
      JSON.stringify(payload.transaction.accessList)
  ) {
    throw new Error('The transaction no longer matches the request.');
  }
}

export function getEvmTransactionAddresses(
  transaction: TransactionLike<string>,
): string[] {
  const addresses = transaction.to ? [transaction.to] : [];
  if (transaction.accessList) {
    addresses.push(
      ...accessListify(transaction.accessList).map(({address}) => address),
    );
  }
  return [...new Set(addresses.map(address => address.toLowerCase()))];
}
