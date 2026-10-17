import type {Provider} from 'ethers';
import ms from 'ms';

import type {EvmTransactionReceipt} from './evm-transaction.js';

const POLL_INTERVAL = ms('5s');

export type EvmTransactionConfirmation =
  | {status: 'pending'; error?: unknown; nonceUsed?: boolean}
  | {status: 'confirmed' | 'failed'; receipt: EvmTransactionReceipt}
  | {
      status: 'replaced';
      replacementHash: string;
      replacementReceipt?: EvmTransactionReceipt;
    };

export function watchEvmTransaction({
  chainId,
  hash,
  replacement,
  getProvider,
  onChange,
}: {
  chainId: bigint;
  hash: string;
  replacement?: {
    from: string;
    nonce: number;
    hashes: () => readonly string[];
  };
  getProvider: () => Promise<
    Pick<
      Provider,
      'getNetwork' | 'getTransactionReceipt' | 'getTransactionCount'
    >
  >;
  onChange: (confirmation: EvmTransactionConfirmation) => void;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async (): Promise<void> => {
    let confirmation: EvmTransactionConfirmation;
    try {
      const provider = await getProvider();
      if (stopped) return;
      const network = await provider.getNetwork();
      if (stopped) return;
      if (network.chainId !== chainId) {
        throw new Error('The RPC uses a different network.');
      }

      const receipt = await provider.getTransactionReceipt(hash);
      if (stopped) return;
      if (receipt) {
        assertReceipt(hash, receipt);
        confirmation = {
          status: receipt.status === 1 ? 'confirmed' : 'failed',
          receipt,
        };
      } else {
        confirmation = {status: 'pending'};

        if (replacement) {
          for (const replacementHash of replacement.hashes()) {
            const replacementReceipt =
              await provider.getTransactionReceipt(replacementHash);
            if (stopped) return;
            if (!replacementReceipt) continue;
            assertReceipt(replacementHash, replacementReceipt);
            confirmation = {
              status: 'replaced',
              replacementHash,
              replacementReceipt,
            };
            break;
          }

          if (confirmation.status === 'pending') {
            const nonce = await provider.getTransactionCount(
              replacement.from,
              'latest',
            );
            if (stopped) return;
            if (nonce > replacement.nonce) {
              // A newer nonce does not identify which transaction was mined.
              const receipt = await provider.getTransactionReceipt(hash);
              if (stopped) return;
              if (receipt) {
                assertReceipt(hash, receipt);
                confirmation = {
                  status: receipt.status === 1 ? 'confirmed' : 'failed',
                  receipt,
                };
              } else {
                confirmation = {status: 'pending', nonceUsed: true};
              }
            }
          }
        }
      }
    } catch (error) {
      if (stopped) return;
      confirmation = {status: 'pending', error};
    }

    onChange(confirmation);
    if (!stopped && confirmation.status === 'pending') {
      timer = setTimeout(() => void poll(), POLL_INTERVAL);
    }
  };

  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function assertReceipt(hash: string, receipt: EvmTransactionReceipt): void {
  if (receipt.hash.toLowerCase() !== hash.toLowerCase()) {
    throw new Error('The RPC returned a different transaction hash.');
  }
  if (receipt.status !== 0 && receipt.status !== 1) {
    throw new Error('The receipt does not include an execution status.');
  }
}
