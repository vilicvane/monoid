import type {WalletKitTypes} from '@reown/walletkit';
import {base58} from '@scure/base';
import {getAddress, getBytes, hashMessage} from 'ethers';

import type {WalletKitSession} from '../@services/index.js';

import {parseEvmTransaction} from './evm-transaction.js';
import {type EvmTypedData, parseEvmTypedData} from './evm-typed-data.js';
import type {SolanaSendOptions} from './send-solana-transaction.js';
import {assertSolanaMessage} from './solana-message.js';
import {
  type SolanaTransaction,
  parseSolanaTransaction,
} from './solana-transaction.js';
import {normalizeWalletAddress} from './wallet-address.js';
import {
  WALLET_CONNECT_SOLANA_CHAINS,
  getWalletConnectAddressType,
} from './wallet-connect.js';

export type WalletConnectSignRequest = {
  address: string;
  chainId: string;
} & (
  | {
      method: 'personal_sign';
      digest: string;
      message: Uint8Array;
      text: string | undefined;
    }
  | {method: 'eth_signTypedData_v4'; digest: string; typedData: EvmTypedData}
  | {
      method: 'solana_signMessage';
      message: Uint8Array;
      text: string | undefined;
    }
);

export type WalletConnectTransactionRequest = {
  method: 'eth_sendTransaction';
  address: string;
  chainId: string;
  transaction: ReturnType<typeof parseEvmTransaction>;
};

export type WalletConnectPreparedTransaction =
  WalletConnectTransactionRequest & {
    unsignedTransaction: string;
    digest: string;
  };

export type WalletConnectSolanaTransactionRequest = {
  chainId: string;
  transactions: {
    transaction: SolanaTransaction;
    addresses: string[];
  }[];
} & (
  | {method: 'solana_signTransaction' | 'solana_signAllTransactions'}
  | {method: 'solana_signAndSendTransaction'; sendOptions: SolanaSendOptions}
);

export function parseWalletConnectRequest(
  request: WalletKitTypes.SessionRequest,
  session: WalletKitSession,
):
  | WalletConnectSignRequest
  | WalletConnectTransactionRequest
  | WalletConnectSolanaTransactionRequest {
  const {method} = request.params.request;

  if (method === 'eth_sendTransaction') {
    return parseWalletConnectTransactionRequest(request, session);
  }
  if (
    method === 'solana_signTransaction' ||
    method === 'solana_signAllTransactions' ||
    method === 'solana_signAndSendTransaction'
  ) {
    return parseWalletConnectSolanaTransactionRequest(request, session);
  }

  return parseWalletConnectSignRequest(request, session);
}

export class WalletConnectRequestError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export function parseWalletConnectSignRequest(
  request: WalletKitTypes.SessionRequest,
  session: WalletKitSession,
): WalletConnectSignRequest {
  const {chainId, request: payload} = request.params;

  if (payload.method === 'solana_signMessage') {
    const {params} = payload;
    if (
      typeof params !== 'object' ||
      params === null ||
      Array.isArray(params)
    ) {
      throw new WalletConnectRequestError(
        'Invalid message signing request.',
        -32602,
      );
    }

    const {pubkey, message: encoded} = params as Record<string, unknown>;
    const address = authorizeWalletConnectRequest(
      request,
      session,
      pubkey,
      'solana',
    );
    let message: Uint8Array;
    try {
      if (typeof encoded !== 'string') throw new Error('Invalid message.');
      message = base58.decode(encoded);
    } catch {
      throw new WalletConnectRequestError(
        'Invalid message signing request.',
        -32602,
      );
    }

    try {
      assertSolanaMessage(message);
    } catch (error) {
      throw new WalletConnectRequestError((error as Error).message, -32602);
    }

    return {
      method: payload.method,
      address,
      chainId,
      message,
      text: getMessageText(message),
    };
  }

  if (
    payload.method !== 'personal_sign' &&
    payload.method !== 'eth_signTypedData_v4'
  ) {
    throw new WalletConnectRequestError(
      'This signing method is not supported.',
      4200,
    );
  }

  const {params} = payload;

  if (!Array.isArray(params) || params.length !== 2) {
    throw new WalletConnectRequestError(
      'Invalid message signing request.',
      -32602,
    );
  }

  const address = authorizeWalletConnectRequest(
    request,
    session,
    params[payload.method === 'personal_sign' ? 1 : 0],
  );

  if (payload.method === 'eth_signTypedData_v4') {
    let parsed: ReturnType<typeof parseEvmTypedData>;
    try {
      parsed = parseEvmTypedData(params[1]);
    } catch {
      throw new WalletConnectRequestError(
        'Invalid typed data signing request.',
        -32602,
      );
    }

    const {data, digest} = parsed;
    if (
      data.domain.chainId !== undefined &&
      BigInt(data.domain.chainId) !== BigInt(chainId.split(':')[1]!)
    ) {
      throw new WalletConnectRequestError(
        'The signing domain uses a different network.',
        -32602,
      );
    }

    return {method: payload.method, address, chainId, digest, typedData: data};
  }

  if (
    typeof params[0] !== 'string' ||
    !/^0x(?:[\da-fA-F]{2})*$/.test(params[0])
  ) {
    throw new WalletConnectRequestError(
      'Invalid message signing request.',
      -32602,
    );
  }

  const message = getBytes(params[0]);

  return {
    method: payload.method,
    address,
    chainId,
    digest: hashMessage(message),
    message,
    text: getMessageText(message),
  };
}

function getMessageText(message: Uint8Array): string | undefined {
  let text: string | undefined;

  try {
    text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(
      message,
    );
  } catch {
    // Binary messages are displayed as hex without changing the bytes to sign.
  }

  if (
    text !== undefined &&
    /[\p{Cc}\p{Cf}]/u.test(text.replace(/[\t\n\r]/g, ''))
  ) {
    text = undefined;
  }

  return text;
}

export function parseWalletConnectTransactionRequest(
  request: WalletKitTypes.SessionRequest,
  session: WalletKitSession,
): WalletConnectTransactionRequest {
  const {chainId, request: payload} = request.params;
  if (payload.method !== 'eth_sendTransaction') {
    throw new WalletConnectRequestError('This method is not supported.', 4200);
  }

  const {params} = payload;
  if (
    !Array.isArray(params) ||
    params.length !== 1 ||
    typeof params[0] !== 'object' ||
    params[0] === null ||
    Array.isArray(params[0])
  ) {
    throw new WalletConnectRequestError('Invalid transaction request.', -32602);
  }

  const input = params[0] as Record<string, unknown>;
  const address = authorizeWalletConnectRequest(request, session, input.from);
  let transaction: ReturnType<typeof parseEvmTransaction>;

  try {
    transaction = parseEvmTransaction(input, BigInt(chainId.split(':')[1]!));
  } catch {
    throw new WalletConnectRequestError('Invalid transaction request.', -32602);
  }

  return {method: payload.method, address, chainId, transaction};
}

export function parseWalletConnectSolanaTransactionRequest(
  request: WalletKitTypes.SessionRequest,
  session: WalletKitSession,
): WalletConnectSolanaTransactionRequest {
  const {chainId, request: payload} = request.params;

  if (
    payload.method !== 'solana_signTransaction' &&
    payload.method !== 'solana_signAllTransactions' &&
    payload.method !== 'solana_signAndSendTransaction'
  ) {
    throw new WalletConnectRequestError('This method is not supported.', 4200);
  }

  if (
    typeof payload.params !== 'object' ||
    payload.params === null ||
    Array.isArray(payload.params)
  ) {
    throw new WalletConnectRequestError('Invalid transaction request.', -32602);
  }

  const params = payload.params as Record<string, unknown>;
  const encoded =
    payload.method === 'solana_signAllTransactions'
      ? params.transactions
      : [params.transaction];

  if (
    !Array.isArray(encoded) ||
    encoded.length === 0 ||
    encoded.some(value => typeof value !== 'string')
  ) {
    throw new WalletConnectRequestError('Invalid transaction request.', -32602);
  }

  const accounts = getAuthorizedWalletConnectAccounts(
    request,
    session,
    'solana',
  );
  const specifiedAddress =
    payload.method !== 'solana_signAllTransactions' &&
    params.pubkey !== undefined
      ? authorizeWalletConnectRequest(request, session, params.pubkey, 'solana')
      : undefined;
  const transactions = encoded.map(value => {
    let transaction: SolanaTransaction;

    try {
      transaction = parseSolanaTransaction(value as string);
    } catch (error) {
      throw new WalletConnectRequestError((error as Error).message, -32602);
    }

    const addresses = transaction.signerAddresses.filter(address =>
      specifiedAddress
        ? address === specifiedAddress
        : accounts.includes(`${chainId}:${address}`),
    );

    if (!addresses.length) {
      throw new WalletConnectRequestError(
        'No authorized account can sign this transaction.',
        4100,
      );
    }

    return {transaction, addresses};
  });

  return payload.method === 'solana_signAndSendTransaction'
    ? {
        method: payload.method,
        chainId,
        transactions,
        sendOptions: parseSolanaSendOptions(params.sendOptions),
      }
    : {method: payload.method, chainId, transactions};
}

function parseSolanaSendOptions(value: unknown): SolanaSendOptions {
  const options: SolanaSendOptions = {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  };

  if (value === undefined) return options;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WalletConnectRequestError(
      'Invalid transaction send options.',
      -32602,
    );
  }

  const {skipPreflight, preflightCommitment, maxRetries, minContextSlot} =
    value as Record<string, unknown>;

  if (skipPreflight !== undefined) {
    if (typeof skipPreflight !== 'boolean') {
      throw new WalletConnectRequestError('Invalid preflight option.', -32602);
    }
    options.skipPreflight = skipPreflight;
  }
  if (preflightCommitment !== undefined) {
    if (
      preflightCommitment !== 'processed' &&
      preflightCommitment !== 'confirmed' &&
      preflightCommitment !== 'finalized'
    ) {
      throw new WalletConnectRequestError(
        'Invalid preflight commitment.',
        -32602,
      );
    }
    options.preflightCommitment = preflightCommitment;
  }
  for (const [name, number] of [
    ['maxRetries', maxRetries],
    ['minContextSlot', minContextSlot],
  ] as const) {
    if (number === undefined) continue;
    if (
      typeof number !== 'number' ||
      !Number.isSafeInteger(number) ||
      number < 0
    ) {
      throw new WalletConnectRequestError(`Invalid ${name} option.`, -32602);
    }
    options[name] = number;
  }

  return options;
}

function authorizeWalletConnectRequest(
  request: WalletKitTypes.SessionRequest,
  session: WalletKitSession,
  value: unknown,
  namespace: 'eip155' | 'solana' = 'eip155',
): string {
  const accounts = getAuthorizedWalletConnectAccounts(
    request,
    session,
    namespace,
  );
  let address: string;

  try {
    if (
      typeof value !== 'string' ||
      getWalletConnectAddressType(value) !==
        (namespace === 'solana' ? 'solana' : 'evm')
    ) {
      throw new Error('Invalid account.');
    }
    address = namespace === 'solana' ? value : getAddress(value);
  } catch {
    throw new WalletConnectRequestError('Invalid signing account.', -32602);
  }

  const account = `${request.params.chainId}:${normalizeWalletAddress(address)}`;
  if (!accounts.includes(account)) {
    throw new WalletConnectRequestError(
      'This account or network is not authorized.',
      4100,
    );
  }

  return address;
}

function getAuthorizedWalletConnectAccounts(
  request: WalletKitTypes.SessionRequest,
  session: WalletKitSession,
  namespace: 'eip155' | 'solana',
): string[] {
  if (request.topic !== session.topic) {
    throw new WalletConnectRequestError(
      'This session is not authorized.',
      4100,
    );
  }

  const {chainId, request: payload} = request.params;
  if (
    !(namespace === 'solana'
      ? WALLET_CONNECT_SOLANA_CHAINS.has(chainId)
      : /^eip155:[1-9]\d*$/.test(chainId))
  ) {
    throw new WalletConnectRequestError('This network is not supported.', 4200);
  }

  return Object.entries(session.namespaces).flatMap(([name, permissions]) =>
    (name === namespace || name === chainId) &&
    (!permissions.chains || permissions.chains.includes(chainId)) &&
    permissions.methods.includes(payload.method)
      ? permissions.accounts.map(value =>
          namespace === 'eip155' ? value.toLowerCase() : value,
        )
      : [],
  );
}
