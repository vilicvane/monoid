import type {WalletKitTypes} from '@reown/walletkit';
import {getAddress, getBytes} from 'ethers';

import type {WalletKitSession} from '../@services/index.js';

export class WalletConnectRequestError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export function parseWalletConnectPersonalSign(
  request: WalletKitTypes.SessionRequest,
  session: WalletKitSession,
): {
  address: string;
  chainId: string;
  message: Uint8Array;
  text: string | undefined;
} {
  if (request.topic !== session.topic) {
    throw new WalletConnectRequestError(
      'This session is not authorized.',
      4100,
    );
  }

  const {chainId, request: payload} = request.params;

  if (payload.method !== 'personal_sign') {
    throw new WalletConnectRequestError(
      'This signing method is not supported.',
      4200,
    );
  }

  if (!/^eip155:[1-9]\d*$/.test(chainId)) {
    throw new WalletConnectRequestError('This network is not supported.', 4200);
  }

  const {params} = payload;

  if (
    !Array.isArray(params) ||
    params.length !== 2 ||
    typeof params[0] !== 'string' ||
    !/^0x(?:[\da-fA-F]{2})*$/.test(params[0]) ||
    typeof params[1] !== 'string' ||
    !/^0x[\da-fA-F]{40}$/.test(params[1])
  ) {
    throw new WalletConnectRequestError(
      'Invalid message signing request.',
      -32602,
    );
  }

  let address: string;

  try {
    address = getAddress(params[1]);
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

  return {address, chainId, message, text};
}
