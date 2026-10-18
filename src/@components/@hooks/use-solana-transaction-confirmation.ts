import {useEffect, useMemo, useRef, useState} from 'react';

import {useEntrances} from '../../@entrances.js';
import {createSolanaRPC} from '../../@lib/solana-rpc.js';
import {
  SOLANA_SIGNED_TRANSACTION_LOOKUP_TIMEOUT,
  type SolanaTransactionConfirmation,
  watchSolanaTransaction,
} from '../../@lib/watch-solana-transaction.js';

export function useSolanaTransactionConfirmation(
  chainId: string,
  signature: string | undefined,
  active: boolean,
  attempt = 0,
): SolanaTransactionConfirmation {
  const {walletKit, solanaTransactionHistoryService, errorService} =
    useEntrances();
  const saved = signature
    ? solanaTransactionHistoryService.getConfirmation(chainId, signature)
    : undefined;
  const request = useMemo(
    () => createSolanaRPC(chainId, walletKit.core.projectId!),
    [chainId, walletKit],
  );
  const [result, setResult] = useState<{
    signature: string;
    chainId: string;
    confirmation: SolanaTransactionConfirmation;
  }>();
  const checkedAttempt = useRef(attempt);

  useEffect(() => {
    if (!active || !signature) return;

    const refresh = attempt !== checkedAttempt.current;
    checkedAttempt.current = attempt;
    const initial = solanaTransactionHistoryService.getConfirmation(
      chainId,
      signature,
    );
    if (
      !refresh &&
      ((initial && 'balances' in initial && initial.balances !== undefined) ||
        initial?.status === 'not-found')
    ) {
      return;
    }
    const detail = solanaTransactionHistoryService.getBySignature(
      chainId,
      signature,
    );
    setResult({
      signature,
      chainId,
      confirmation: initial ?? {status: 'pending'},
    });

    return watchSolanaTransaction({
      signature,
      request,
      initial,
      notFoundAfter:
        detail &&
        (initial?.status === 'signed' || initial?.status === 'not-found')
          ? detail.transaction.timestamp +
            SOLANA_SIGNED_TRANSACTION_LOOKUP_TIMEOUT
          : undefined,
      onChange: confirmation => {
        setResult({signature, chainId, confirmation});
        errorService.catch(
          solanaTransactionHistoryService.rememberConfirmation(
            chainId,
            signature,
            confirmation,
          ),
          'Could not save transaction status',
        );
      },
    });
  }, [
    active,
    chainId,
    signature,
    request,
    attempt,
    solanaTransactionHistoryService,
    errorService,
  ]);

  const current =
    result && result.signature === signature && result.chainId === chainId
      ? result.confirmation
      : undefined;

  if (!signature) return {status: 'signed'};

  return saved
    ? {...saved, error: current?.error}
    : (current ?? {status: 'pending'});
}
