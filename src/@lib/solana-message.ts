import {
  MAX_SUPPORTED_TRANSACTION_VERSION,
  getCompiledTransactionMessageDecoder,
} from '@solana/transaction-messages';

const transactionMessageDecoder = getCompiledTransactionMessageDecoder();

export function assertSolanaMessage(message: Uint8Array): void {
  let transactionMessage:
    | ReturnType<typeof transactionMessageDecoder.read>
    | undefined;

  try {
    transactionMessage = transactionMessageDecoder.read(message, 0);
  } catch {
    // Most raw messages do not have a transaction message structure.
  }

  if (transactionMessage) {
    const [{header, staticAccounts}] = transactionMessage;
    const {numSignerAccounts, numReadonlySignerAccounts} = header;

    if (
      numSignerAccounts > 0 &&
      numSignerAccounts <= staticAccounts.length &&
      numReadonlySignerAccounts < numSignerAccounts &&
      header.numReadonlyNonSignerAccounts <=
        staticAccounts.length - numSignerAccounts
    ) {
      throw new Error('Use transaction signing for this message.');
    }
  }

  const prefix = message[0];
  if (
    prefix !== undefined &&
    prefix >= 0x80 &&
    (prefix & 0x7f) > MAX_SUPPORTED_TRANSACTION_VERSION &&
    prefix !== 0xff
  ) {
    try {
      // UTF-8 text also starts with a high bit; 0xff is reserved for off-chain messages.
      new TextDecoder('utf-8', {fatal: true}).decode(message);
    } catch {
      throw new Error('This transaction message version is not supported.');
    }
  }
}
