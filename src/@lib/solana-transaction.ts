import {base58, base64} from '@scure/base';
import type {
  CompiledTransactionMessageWithLifetime,
  LegacyCompiledTransactionMessage,
  V0CompiledTransactionMessage,
} from '@solana/transaction-messages';
import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from '@solana/transaction-messages';
import {
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/transactions';

import {verifySolanaSignature} from './solana-signature.js';

export type SolanaCompiledTransaction = (
  | LegacyCompiledTransactionMessage
  | V0CompiledTransactionMessage
) &
  CompiledTransactionMessageWithLifetime;

export type SolanaTransaction = {
  bytes: Uint8Array;
  messageBytes: Uint8Array;
  messageOffset: number;
  compiled: SolanaCompiledTransaction;
  signerAddresses: readonly string[];
  feePayer: string;
  signatures: readonly Uint8Array[];
};

const TRANSACTION_SIZE_LIMIT = 1232;
const transactionDecoder = getTransactionDecoder();
const transactionEncoder = getTransactionEncoder();
const messageDecoder = getCompiledTransactionMessageDecoder();
const messageEncoder = getCompiledTransactionMessageEncoder();

export function parseSolanaTransaction(encoded: string): SolanaTransaction {
  if (encoded.length > Math.ceil(TRANSACTION_SIZE_LIMIT / 3) * 4) {
    throw new Error('The Solana transaction exceeds 1232 bytes.');
  }

  let bytes: Uint8Array;

  try {
    bytes = base64.decode(encoded);
  } catch {
    throw new Error('The Solana transaction is not valid base64.');
  }

  if (!bytes.length || base64.encode(bytes) !== encoded) {
    throw new Error('The Solana transaction is not valid base64.');
  }

  if (bytes.length > TRANSACTION_SIZE_LIMIT) {
    throw new Error('The Solana transaction exceeds 1232 bytes.');
  }

  // Legacy and v0 put signatures first; newer message-first envelopes are unsupported.
  if (bytes[0] >= 0x80) {
    throw new Error('This Solana transaction version is not supported.');
  }

  const prefix = bytes[1 + bytes[0] * 64];

  if (prefix >= 0x80 && prefix !== 0x80) {
    throw new Error('This Solana transaction version is not supported.');
  }

  const [decoded, transactionEnd] = transactionDecoder.read(bytes, 0);
  const messageBytes = Uint8Array.from(decoded.messageBytes);
  const [compiled, messageEnd] = messageDecoder.read(messageBytes, 0);

  if (compiled.version !== 'legacy' && compiled.version !== 0) {
    throw new Error('This Solana transaction version is not supported.');
  }

  if (
    transactionEnd !== bytes.length ||
    messageEnd !== messageBytes.length ||
    !sameBytes(transactionEncoder.encode(decoded), bytes) ||
    !sameBytes(messageEncoder.encode(compiled), messageBytes)
  ) {
    throw new Error('The Solana transaction encoding is invalid.');
  }

  const {header, staticAccounts, instructions} = compiled;
  const {numSignerAccounts, numReadonlySignerAccounts} = header;

  if (
    numSignerAccounts === 0 ||
    numSignerAccounts > staticAccounts.length ||
    numReadonlySignerAccounts >= numSignerAccounts ||
    header.numReadonlyNonSignerAccounts >
      staticAccounts.length - numSignerAccounts ||
    new Set(staticAccounts).size !== staticAccounts.length
  ) {
    throw new Error('The Solana transaction account header is invalid.');
  }

  let accountCount = staticAccounts.length;

  for (const lookup of compiled.version === 0
    ? (compiled.addressTableLookups ?? [])
    : []) {
    const count = lookup.writableIndexes.length + lookup.readonlyIndexes.length;

    if (!count) {
      throw new Error('The Solana address lookup table is empty.');
    }

    accountCount += count;
  }

  if (
    accountCount > 256 ||
    instructions.some(
      instruction =>
        instruction.programAddressIndex === 0 ||
        instruction.programAddressIndex >= staticAccounts.length ||
        instruction.accountIndices?.some(index => index >= accountCount),
    )
  ) {
    throw new Error('The Solana transaction account index is invalid.');
  }

  const signerAddresses = staticAccounts.slice(0, numSignerAccounts);
  const messageOffset = bytes.length - messageBytes.length;
  const signaturesOffset = messageOffset - numSignerAccounts * 64;
  const signatures = signerAddresses.map((address, index) => {
    const offset = signaturesOffset + index * 64;
    const signature = bytes.slice(offset, offset + 64);

    if (
      signature.some(byte => byte !== 0) &&
      !verifySolanaSignature(messageBytes, base58.encode(signature), address)
    ) {
      throw new Error('The Solana transaction has an invalid signature.');
    }

    return signature;
  });

  return {
    bytes,
    messageBytes,
    messageOffset,
    compiled,
    signerAddresses,
    feePayer: signerAddresses[0],
    signatures,
  };
}

export function addSolanaTransactionSignature(
  transaction: SolanaTransaction,
  address: string,
  signature: string,
): string {
  const index = transaction.signerAddresses.indexOf(address);

  if (index < 0) {
    throw new Error('This account is not a required transaction signer.');
  }

  if (!verifySolanaSignature(transaction.messageBytes, signature, address)) {
    throw new Error('The Solana transaction signature is invalid.');
  }

  // Patch only this signature slot; never compile or replace the signed message.
  const bytes = transaction.bytes.slice();
  const offset =
    transaction.messageOffset -
    (transaction.signerAddresses.length - index) * 64;
  bytes.set(base58.decode(signature), offset);

  return base64.encode(bytes);
}

function sameBytes(left: ArrayLike<number>, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    right.every((byte, index) => byte === left[index])
  );
}
