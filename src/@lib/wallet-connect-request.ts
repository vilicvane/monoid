import type {WalletKitTypes} from '@reown/walletkit';
import {getAddress, getBytes, hashMessage} from 'ethers';

import type {WalletKitSession} from '../@services/index.js';

import {parseEvmTransaction} from './evm-transaction.js';
import {type EvmTypedData, parseEvmTypedData} from './evm-typed-data.js';

export type WalletConnectSignRequest = {
  address: string;
  chainId: string;
  digest: string;
} & (
  | {method: 'personal_sign'; message: Uint8Array; text: string | undefined}
  | {method: 'eth_signTypedData_v4'; typedData: EvmTypedData}
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

export function parseWalletConnectRequest(
  request: WalletKitTypes.SessionRequest,
  session: WalletKitSession,
): WalletConnectSignRequest | WalletConnectTransactionRequest {
  return request.params.request.method === 'eth_sendTransaction'
    ? parseWalletConnectTransactionRequest(request, session)
    : parseWalletConnectSignRequest(request, session);
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

  return {
    method: payload.method,
    address,
    chainId,
    digest: hashMessage(message),
    message,
    text,
  };
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

function authorizeWalletConnectRequest(
  request: WalletKitTypes.SessionRequest,
  session: WalletKitSession,
  value: unknown,
): string {
  if (request.topic !== session.topic) {
    throw new WalletConnectRequestError(
      'This session is not authorized.',
      4100,
    );
  }

  const {chainId, request: payload} = request.params;
  if (!/^eip155:[1-9]\d*$/.test(chainId)) {
    throw new WalletConnectRequestError('This network is not supported.', 4200);
  }

  let address: string;
  try {
    if (typeof value !== 'string' || !/^0x[\da-fA-F]{40}$/.test(value)) {
      throw new Error('Invalid account.');
    }
    address = getAddress(value);
  } catch {
    throw new WalletConnectRequestError('Invalid signing account.', -32602);
  }

  const account = `${chainId}:${address}`.toLowerCase();
  const authorized = Object.entries(session.namespaces).some(
    ([name, namespace]) =>
      (name === 'eip155' || name === chainId) &&
      (!namespace.chains || namespace.chains.includes(chainId)) &&
      namespace.methods.includes(payload.method) &&
      namespace.accounts.some(value => value.toLowerCase() === account),
  );
  if (!authorized) {
    throw new WalletConnectRequestError(
      'This account or network is not authorized.',
      4100,
    );
  }

  return address;
}
