import {useEffect, useState} from 'react';

import {useEntrances} from '../../@entrances.js';
import {
  type SolanaTransactionSimulation,
  simulateSolanaTransaction,
} from '../../@lib/simulate-solana-transaction.js';
import {createSolanaRPC} from '../../@lib/solana-rpc.js';
import type {WalletConnectSolanaTransactionRequest} from '../../@lib/wallet-connect-request.js';

export function useSolanaTransactionSimulations(
  payload: WalletConnectSolanaTransactionRequest | undefined,
  active: boolean,
): {
  results: readonly (SolanaTransactionSimulation | undefined)[];
  pending: boolean;
  refresh: () => void;
} {
  const {walletKit} = useEntrances();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    payload: WalletConnectSolanaTransactionRequest;
    attempt: number;
    results: (SolanaTransactionSimulation | undefined)[];
  }>();

  useEffect(() => {
    if (!payload || !active) return;
    const controller = new AbortController();
    const {signal} = controller;
    const request = createSolanaRPC(payload.chainId, walletKit.core.projectId!);
    setState({
      payload,
      attempt,
      results: payload.transactions.map(() => undefined),
    });
    let nextIndex = 0;

    const simulateNext = async (): Promise<void> => {
      while (!signal.aborted && nextIndex < payload.transactions.length) {
        const index = nextIndex++;
        let result: SolanaTransactionSimulation;
        try {
          result = await simulateSolanaTransaction(
            payload.transactions[index].transaction,
            request,
            signal,
          );
        } catch (error) {
          if (signal.aborted) return;
          result = {
            status: 'unavailable',
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (signal.aborted) return;
        setState(current =>
          current?.payload === payload && current.attempt === attempt
            ? {
                ...current,
                results: current.results.map((value, i) =>
                  i === index ? result : value,
                ),
              }
            : current,
        );
      }
    };

    // Bound RPC traffic for large signing batches; each result is independent.
    void simulateNext();
    void simulateNext();
    return () => controller.abort();
  }, [payload, active, attempt, walletKit]);

  const results =
    state?.payload === payload && state?.attempt === attempt
      ? state.results
      : (payload?.transactions.map(() => undefined) ?? []);

  return {
    results,
    pending: results.some(result => !result),
    refresh: () => setAttempt(value => value + 1),
  };
}
