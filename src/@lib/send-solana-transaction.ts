import {base58} from '@scure/base';

import type {SolanaRPCRequest} from './solana-transaction-review.js';
import {parseSolanaTransaction} from './solana-transaction.js';

export type SolanaSendOptions = {
  skipPreflight?: boolean;
  preflightCommitment?: 'processed' | 'confirmed' | 'finalized';
  maxRetries?: number;
  minContextSlot?: number;
};

export function getSignedSolanaTransactionSignature(encoded: string): string {
  const transaction = parseSolanaTransaction(encoded);

  if (transaction.signatures.some(signature => !signature.some(byte => byte))) {
    throw new Error('The Solana transaction is missing a required signature.');
  }

  return base58.encode(transaction.signatures[0]);
}

export async function sendSolanaTransaction(
  encoded: string,
  request: SolanaRPCRequest,
  options: SolanaSendOptions = {},
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const signature = getSignedSolanaTransactionSignature(encoded);
  const {
    skipPreflight = false,
    preflightCommitment = 'confirmed',
    maxRetries,
    minContextSlot,
  } = options;
  const result = await request(
    'sendTransaction',
    [
      encoded,
      {
        encoding: 'base64',
        skipPreflight,
        preflightCommitment,
        maxRetries,
        minContextSlot,
      },
    ],
    signal,
  );

  if (result !== signature) {
    throw new Error(
      'The Solana RPC returned a different transaction signature.',
    );
  }

  return signature;
}
