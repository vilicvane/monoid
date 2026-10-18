import {base64} from '@scure/base';

import type {SolanaRPCRequest} from './solana-transaction-review.js';
import type {SolanaTransaction} from './solana-transaction.js';

export type SolanaTransactionSimulation = {
  status: 'succeeded' | 'failed' | 'unavailable';
  fee?: bigint;
  feeError?: string;
  error?: string;
  logs?: string[];
  unitsConsumed?: number;
  slot?: number;
};

export async function simulateSolanaTransaction(
  transaction: SolanaTransaction,
  request: SolanaRPCRequest,
  signal?: AbortSignal,
): Promise<SolanaTransactionSimulation> {
  signal?.throwIfAborted();

  // Simulate the exact request, including its blockhash and any co-signatures.
  // https://solana.com/docs/rpc/http/simulatetransaction
  const [simulationResult, feeResult] = await Promise.allSettled([
    (async () => {
      const response = await request(
        'simulateTransaction',
        [
          base64.encode(transaction.bytes),
          {
            encoding: 'base64',
            sigVerify: false,
            replaceRecentBlockhash: false,
            commitment: 'confirmed',
          },
        ],
        signal,
      );

      return parseSimulation(response);
    })(),
    (async () => {
      const response = await request(
        'getFeeForMessage',
        [base64.encode(transaction.messageBytes), {commitment: 'confirmed'}],
        signal,
      );

      if (
        !isRecord(response) ||
        !isRecord(response.context) ||
        !isUnsignedInteger(response.context.slot) ||
        (response.value !== null && !isUnsignedInteger(response.value))
      ) {
        throw new Error('Invalid Solana transaction fee response.');
      }

      if (response.value === null) {
        throw new Error('The transaction fee is unavailable.');
      }

      return BigInt(response.value);
    })(),
  ]);
  signal?.throwIfAborted();

  const simulation: SolanaTransactionSimulation =
    simulationResult.status === 'fulfilled'
      ? simulationResult.value
      : {status: 'unavailable', error: describeError(simulationResult.reason)};

  if (simulation.fee === undefined) {
    if (feeResult.status === 'fulfilled') {
      simulation.fee = feeResult.value;
      delete simulation.feeError;
    } else {
      simulation.feeError = describeError(feeResult.reason);
    }
  }

  return simulation;
}

function parseSimulation(response: unknown): SolanaTransactionSimulation {
  if (
    !isRecord(response) ||
    !isRecord(response.context) ||
    !isUnsignedInteger(response.context.slot) ||
    !isRecord(response.value)
  ) {
    throw new Error('Invalid Solana transaction simulation response.');
  }

  const {err, logs, unitsConsumed, fee} = response.value;

  if (
    (err !== null && !isExecutionError(err)) ||
    (logs != null &&
      (!Array.isArray(logs) || logs.some(log => typeof log !== 'string'))) ||
    (unitsConsumed != null && !isUnsignedInteger(unitsConsumed))
  ) {
    throw new Error('Invalid Solana transaction simulation response.');
  }

  return {
    status:
      err === null
        ? 'succeeded'
        : err === 'BlockhashNotFound'
          ? 'unavailable'
          : 'failed',
    ...(err !== null && {error: formatExecutionError(err)}),
    ...(logs != null && {logs: [...(logs as string[])]}),
    ...(unitsConsumed != null && {unitsConsumed: unitsConsumed as number}),
    slot: response.context.slot,
    ...(isUnsignedInteger(fee)
      ? {fee: BigInt(fee)}
      : fee != null
        ? {feeError: 'Invalid Solana simulation fee.'}
        : {}),
  };
}

function isExecutionError(error: unknown): boolean {
  if (typeof error === 'string') return error.trim().length > 0;
  if (!isRecord(error) || !Object.keys(error).length) return false;

  if ('InstructionError' in error) {
    const detail = error.InstructionError;
    return (
      Object.keys(error).length === 1 &&
      Array.isArray(detail) &&
      detail.length === 2 &&
      isUnsignedInteger(detail[0]) &&
      detail[0] < 256 &&
      isExecutionError(detail[1])
    );
  }

  if ('Custom' in error) {
    return (
      Object.keys(error).length === 1 &&
      isUnsignedInteger(error.Custom) &&
      error.Custom <= 0xffffffff
    );
  }

  return true;
}

function formatExecutionError(error: unknown): string {
  if (isRecord(error) && Array.isArray(error.InstructionError)) {
    const [index, detail] = error.InstructionError;
    return `Instruction ${(index as number) + 1}: ${formatExecutionError(detail)}`;
  }

  if (isRecord(error) && isUnsignedInteger(error.Custom)) {
    return `Custom program error ${error.Custom}.`;
  }

  if (isRecord(error) && 'InsufficientFundsForRent' in error) {
    const detail = error.InsufficientFundsForRent;
    return isRecord(detail) && isUnsignedInteger(detail.account_index)
      ? `Insufficient SOL for account rent (account ${detail.account_index + 1}).`
      : 'Insufficient SOL for account rent.';
  }

  switch (error) {
    case 'BlockhashNotFound':
      return 'The transaction blockhash is unavailable.';
    case 'InsufficientFundsForFee':
      return 'Insufficient SOL to pay the transaction fee.';
    case 'InsufficientFunds':
      return 'Insufficient funds.';
    default:
      return describeError(error);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (isRecord(error) && typeof error.message === 'string' && error.message) {
    return error.message;
  }

  return JSON.stringify(error) ?? String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnsignedInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
