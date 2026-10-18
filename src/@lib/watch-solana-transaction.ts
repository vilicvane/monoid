import {
  type SolanaTransactionBalances,
  parseSolanaTransactionBalances,
} from './solana-transaction-balances.js';
import type {SolanaRPCRequest} from './solana-transaction-review.js';

const POLL_INTERVAL = 5_000;
export const SOLANA_SIGNED_TRANSACTION_LOOKUP_TIMEOUT = 5 * 60_000;

export type SolanaSignatureStatus = {
  slot: number;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized';
  err: null | string | Record<string, unknown>;
};

export type SolanaTransactionConfirmation =
  | {status: 'signed' | 'not-found' | 'pending'; error?: unknown}
  | {
      status: 'confirmed' | 'failed';
      slot: number;
      fee?: bigint;
      balances?: SolanaTransactionBalances;
      executionError?: string;
      error?: unknown;
    };

export async function getSolanaSignatureStatus(
  request: SolanaRPCRequest,
  signature: string,
  signal?: AbortSignal,
): Promise<SolanaSignatureStatus | null> {
  signal?.throwIfAborted();
  const result = await request(
    'getSignatureStatuses',
    [[signature], {searchTransactionHistory: true}],
    signal,
  );
  signal?.throwIfAborted();

  if (
    !isRecord(result) ||
    !Array.isArray(result.value) ||
    result.value.length !== 1
  ) {
    throw new Error('Invalid Solana signature status response.');
  }

  const status: unknown = result.value[0];
  if (status === null) return null;
  if (
    !isRecord(status) ||
    !isUnsignedInteger(status.slot) ||
    (status.confirmationStatus !== 'processed' &&
      status.confirmationStatus !== 'confirmed' &&
      status.confirmationStatus !== 'finalized') ||
    (status.err !== null &&
      typeof status.err !== 'string' &&
      !isRecord(status.err))
  ) {
    throw new Error('Invalid Solana signature status response.');
  }

  return {
    slot: status.slot,
    confirmationStatus: status.confirmationStatus,
    err: status.err,
  };
}

export function watchSolanaTransaction({
  signature,
  request,
  onChange,
  initial,
  notFoundAfter,
}: {
  signature: string;
  request: SolanaRPCRequest;
  onChange: (confirmation: SolanaTransactionConfirmation) => void;
  initial?: SolanaTransactionConfirmation;
  notFoundAfter?: number;
}): () => void {
  const controller = new AbortController();
  const {signal} = controller;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let confirmation: SolanaTransactionConfirmation = initial ?? {
    status: 'pending',
  };

  const poll = async (): Promise<void> => {
    confirmation = {...confirmation};
    delete confirmation.error;
    let detailsLoaded = false;

    try {
      if (
        confirmation.status === 'pending' ||
        confirmation.status === 'signed' ||
        confirmation.status === 'not-found'
      ) {
        const status = await getSolanaSignatureStatus(
          request,
          signature,
          signal,
        );

        if (status?.confirmationStatus === 'processed') {
          confirmation = {status: 'pending'};
        } else if (status) {
          confirmation = {
            status: status.err === null ? 'confirmed' : 'failed',
            slot: status.slot,
            ...(status.err !== null && {
              executionError:
                typeof status.err === 'string'
                  ? status.err
                  : JSON.stringify(status.err),
            }),
          };
          onChange(confirmation);
          if (signal.aborted) return;
        } else if (
          confirmation.status !== 'pending' &&
          notFoundAfter !== undefined &&
          Date.now() >= notFoundAfter
        ) {
          // A successful empty lookup is not evidence of execution failure,
          // or of expiry for transactions using a durable nonce.
          confirmation = {status: 'not-found'};
        }
      }

      if (
        confirmation.status === 'confirmed' ||
        confirmation.status === 'failed'
      ) {
        const transaction = await request(
          'getTransaction',
          [
            signature,
            {
              commitment: 'confirmed',
              encoding: 'json',
              maxSupportedTransactionVersion: 0,
            },
          ],
          signal,
        );
        signal.throwIfAborted();

        if (transaction !== null) {
          if (
            !isRecord(transaction) ||
            !isUnsignedInteger(transaction.slot) ||
            !isRecord(transaction.transaction) ||
            !Array.isArray(transaction.transaction.signatures) ||
            transaction.transaction.signatures[0] !== signature ||
            (transaction.meta !== null &&
              (!isRecord(transaction.meta) ||
                !isUnsignedInteger(transaction.meta.fee) ||
                !('err' in transaction.meta) ||
                (transaction.meta.err === null) !==
                  (confirmation.status === 'confirmed')))
          ) {
            throw new Error('Invalid Solana transaction details response.');
          }

          confirmation = {
            ...confirmation,
            slot: transaction.slot,
            balances: parseSolanaTransactionBalances(transaction),
            ...(transaction.meta !== null && {
              fee: BigInt(transaction.meta.fee as number),
            }),
          };
          detailsLoaded = true;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      confirmation = {...confirmation, error};
    }

    if (signal.aborted) return;
    onChange(confirmation);
    if (
      !signal.aborted &&
      !detailsLoaded &&
      confirmation.status !== 'not-found'
    ) {
      timer = setTimeout(() => void poll(), POLL_INTERVAL);
    }
  };

  void poll();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}

export function canRefreshSolanaTransaction(
  confirmation: SolanaTransactionConfirmation,
): boolean {
  return (
    confirmation.error !== undefined ||
    confirmation.status === 'not-found' ||
    ((confirmation.status === 'confirmed' ||
      confirmation.status === 'failed') &&
      confirmation.balances !== undefined &&
      (confirmation.fee === undefined ||
        confirmation.balances.native === undefined ||
        confirmation.balances.tokens === undefined ||
        confirmation.balances.tokens.some(
          token =>
            (token.before !== undefined && token.before.owner === undefined) ||
            (token.after !== undefined && token.after.owner === undefined),
        )))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnsignedInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
