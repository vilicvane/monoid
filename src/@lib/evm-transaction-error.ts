import {AbiCoder, isError} from 'ethers';

const RETRY_MESSAGE = 'Could not prepare this transaction. Try again.';

export function formatEvmTransactionError(error: unknown): string {
  if (isError(error, 'INSUFFICIENT_FUNDS')) return 'Insufficient funds.';

  if (isError(error, 'CALL_EXCEPTION')) {
    // ethers also wraps RPC failures as CALL_EXCEPTION, with no revert data.
    if (
      typeof error.data === 'string' &&
      /^0x(?:[\da-f]{2})*$/i.test(error.data)
    ) {
      return describeRevert(error.data);
    }
    if (error.reason) return error.reason;

    const message: unknown = error.info?.error?.message;

    if (typeof message === 'string') {
      if (/^execution reverted(?:$|:| \()/i.test(message)) {
        return 'Execution reverted.';
      }
      if (/^(?:intrinsic gas too low|out of gas)\b/i.test(message)) {
        return 'Gas limit is too low.';
      }
      if (/^insufficient funds\b/i.test(message)) {
        return 'Insufficient funds.';
      }
    }
  }

  if (
    error instanceof Error &&
    !('code' in error) &&
    error.message &&
    error.message.length <= 240
  ) {
    return error.message;
  }

  return RETRY_MESSAGE;
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
