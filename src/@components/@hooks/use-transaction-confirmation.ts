import {Transaction} from 'ethers';
import {useEffect, useMemo, useState} from 'react';

import {useEntrances} from '../../@entrances.js';
import type {EvmTransaction} from '../../@lib/evm-transaction.js';
import {
  type EvmTransactionConfirmation,
  watchEvmTransaction,
} from '../../@lib/watch-evm-transaction.js';

export function useTransactionConfirmation(
  transaction: EvmTransaction,
  active: boolean,
  attempt = 0,
): EvmTransactionConfirmation {
  const {chainService, transactionHistoryService, errorService} =
    useEntrances();
  const {chainId, hash, from} = transaction;
  const chain = `eip155:${chainId}`;
  const record = transactionHistoryService.get(from, chain, hash);
  const receipt = record?.receipt;
  const signedTransaction = record?.signedTransaction;
  const original = useMemo(
    () => signedTransaction && Transaction.from(signedTransaction),
    [signedTransaction],
  );
  const nonce = original ? original.nonce : undefined;
  const replacementHash = record?.replacementHash;
  const [confirmation, setConfirmation] = useState<EvmTransactionConfirmation>({
    status: 'pending',
  });
  const status = receipt
    ? receipt.status === 1
      ? 'confirmed'
      : 'failed'
    : replacementHash
      ? 'replaced'
      : confirmation.status;

  useEffect(() => {
    if (!active || status !== 'pending') return;

    return watchEvmTransaction({
      chainId,
      hash,
      replacement:
        nonce === undefined
          ? undefined
          : {
              from,
              nonce,
              hashes: () =>
                transactionHistoryService.getCompetingHashes(chain, hash),
            },
      getProvider: () => chainService.getRPC(chain),
      onChange: setConfirmation,
    });
  }, [
    active,
    status,
    chainId,
    chain,
    hash,
    from,
    nonce,
    chainService,
    transactionHistoryService,
    attempt,
  ]);

  useEffect(() => {
    if (!record || receipt || confirmation.status === 'pending') return;

    if (confirmation.status === 'replaced') {
      if (!confirmation.replacementReceipt || replacementHash) return;
      errorService.catch(
        transactionHistoryService.rememberReceipt(
          chainId,
          confirmation.replacementHash,
          confirmation.replacementReceipt,
        ),
        'Could not save transaction status',
      );
      return;
    }

    errorService.catch(
      transactionHistoryService.rememberReceipt(
        chainId,
        hash,
        confirmation.receipt,
      ),
      'Could not save transaction status',
    );
  }, [
    record,
    receipt,
    replacementHash,
    confirmation,
    chainId,
    hash,
    transactionHistoryService,
    errorService,
  ]);

  return receipt
    ? {status: receipt.status === 1 ? 'confirmed' : 'failed', receipt}
    : replacementHash
      ? {status: 'replaced', replacementHash}
      : confirmation;
}
