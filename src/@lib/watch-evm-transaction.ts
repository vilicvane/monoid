import type {Provider, TransactionReceipt} from 'ethers';
import ms from 'ms';

const POLL_INTERVAL = ms('5s');

export type EvmTransactionConfirmation =
  | {status: 'pending'; error?: unknown}
  | {status: 'confirmed' | 'failed'; receipt: TransactionReceipt};

export function watchEvmTransaction({
  chainId,
  hash,
  getProvider,
  onChange,
}: {
  chainId: bigint;
  hash: string;
  getProvider: () => Promise<
    Pick<Provider, 'getNetwork' | 'getTransactionReceipt'>
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
        if (receipt.hash.toLowerCase() !== hash.toLowerCase()) {
          throw new Error('The RPC returned a different transaction hash.');
        }
        if (receipt.status !== 0 && receipt.status !== 1) {
          throw new Error('The receipt does not include an execution status.');
        }
        confirmation = {
          status: receipt.status === 1 ? 'confirmed' : 'failed',
          receipt,
        };
      } else {
        confirmation = {status: 'pending'};
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
