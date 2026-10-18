import {useEffect, useMemo, useState} from 'react';

import {useEntrances} from '../../@entrances.js';
import {createSolanaRPC} from '../../@lib/solana-rpc.js';
import {
  type SolanaTransactionConfirmation,
  watchSolanaTransaction,
} from '../../@lib/watch-solana-transaction.js';

export function useSolanaTransactionConfirmation(
  chainId: string,
  signature: string,
  active: boolean,
  attempt = 0,
): SolanaTransactionConfirmation {
  const {walletKit} = useEntrances();
  const request = useMemo(
    () => createSolanaRPC(chainId, walletKit.core.projectId!),
    [chainId, walletKit],
  );
  const [result, setResult] = useState<{
    signature: string;
    chainId: string;
    confirmation: SolanaTransactionConfirmation;
  }>();

  useEffect(() => {
    if (!active) return;

    return watchSolanaTransaction({
      signature,
      request,
      onChange: confirmation => setResult({signature, chainId, confirmation}),
    });
  }, [active, chainId, signature, request, attempt]);

  return result?.signature === signature && result.chainId === chainId
    ? result.confirmation
    : {status: 'pending'};
}
