import type {WalletKitTypes} from '@reown/walletkit';
import {getAddress, getBytes, hashMessage} from 'ethers';

import type {WalletKitSession} from '../@services/index.js';

import {type EvmTypedData, parseEvmTypedData} from './evm-typed-data.js';

export type WalletConnectSignRequest = {
  address: string;
  chainId: string;
  digest: string;
} & (
  | {method: 'personal_sign'; message: Uint8Array; text: string | undefined}
  | {method: 'eth_signTypedData_v4'; typedData: EvmTypedData}
);

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
  if (request.topic !== session.topic) {
    throw new WalletConnectRequestError(
      'This session is not authorized.',
      4100,
    );
  }

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

  if (!/^eip155:[1-9]\d*$/.test(chainId)) {
    throw new WalletConnectRequestError('This network is not supported.', 4200);
  }

  const {params} = payload;

  if (!Array.isArray(params) || params.length !== 2) {
    throw new WalletConnectRequestError(
      'Invalid message signing request.',
      -32602,
    );
  }

  let address: string;

  try {
    const value: unknown = params[payload.method === 'personal_sign' ? 1 : 0];
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
