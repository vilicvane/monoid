import {AbiCoder, isError} from 'ethers';

const RETRY_MESSAGE = 'Could not prepare this transaction. Try again.';

export function formatEvmTransactionError(error: unknown): string {
  if (isError(error, 'INSUFFICIENT_FUNDS')) return 'Insufficient funds.';

  const details = error as
    | {
        info?: {error?: {message?: unknown}};
        error?: {message?: unknown};
        reason?: unknown;
        shortMessage?: unknown;
        message?: unknown;
      }
    | undefined
    | null;
  const rpcMessage = firstMessage(
    details?.info?.error?.message,
    details?.error?.message,
  );

  if (isError(error, 'CALL_EXCEPTION')) {
    // ethers also wraps RPC failures as CALL_EXCEPTION, with no revert data.
    if (
      typeof error.data === 'string' &&
      /^0x(?:[\da-f]{2})+$/i.test(error.data)
    ) {
      return describeRevert(error.data);
    }
    // With empty revert data, ethers synthesizes "require(false)" as the reason.
    if (!rpcMessage && error.data === '0x') return 'Execution reverted.';

    if (rpcMessage) {
      if (
        /(?:^|: )max fee per gas less than block base fee\b/i.test(rpcMessage)
      ) {
        return 'Max. fee per gas is below the current base fee.';
      }
      if (/^execution reverted$/i.test(rpcMessage)) {
        return 'Execution reverted.';
      }
      if (/^(?:intrinsic gas too low|out of gas)\b/i.test(rpcMessage)) {
        return 'Gas limit is too low.';
      }
      if (/^insufficient funds\b/i.test(rpcMessage)) {
        return 'Insufficient funds.';
      }
    }
  }

  return (
    firstMessage(
      rpcMessage,
      details?.reason,
      details?.shortMessage,
      details?.message,
      error,
    ) ?? RETRY_MESSAGE
  );
}

function firstMessage(...messages: unknown[]): string | undefined {
  for (const message of messages) {
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return undefined;
}

function describeRevert(data: string): string {
  const selector = data.slice(0, 10).toLowerCase();
  const coder = AbiCoder.defaultAbiCoder();

  try {
    if (selector === '0x08c379a0') {
      const [reason] = coder.decode(['string'], `0x${data.slice(10)}`);

      return reason || 'Execution reverted.';
    }
    if (selector === '0x4e487b71') {
      const [code] = coder.decode(['uint256'], `0x${data.slice(10)}`);

      return `Panic (0x${(code as bigint).toString(16)}).`;
    }
  } catch {
    return 'Execution reverted.';
  }

  return data.length >= 10
    ? `Custom error (${selector}).`
    : 'Execution reverted.';
}
