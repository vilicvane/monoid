import type {WalletKitTypes} from '@reown/walletkit';
import type {buildAuthObject} from '@walletconnect/utils';
import {formatMessage, isRecap} from '@walletconnect/utils';

import {buildWalletConnectNamespaces} from './wallet-connect.js';

export type WalletConnectAuthentication = {
  request: NonNullable<
    NonNullable<
      WalletKitTypes.SessionProposal['params']['requests']
    >['authentication']
  >[number];
  address: string;
  iss: string;
  message: string;
};

export type WalletConnectAuthenticationResult = ReturnType<
  typeof buildAuthObject
>;

export function getWalletConnectRequestExpiry(
  proposal: WalletKitTypes.SessionProposal,
): number {
  return Math.min(
    proposal.params.expiryTimestamp * 1000,
    ...(proposal.params.requests?.authentication ?? []).flatMap(request =>
      request.exp ? [Date.parse(request.exp)] : [],
    ),
  );
}

export function buildWalletConnectAuthentication(
  proposal: WalletKitTypes.SessionProposal,
  addresses: readonly string[],
): WalletConnectAuthentication[] {
  const requests = proposal.params.requests?.authentication ?? [];
  if (!requests.length) return [];

  const namespaces = buildWalletConnectNamespaces(proposal, addresses);
  const accounts = namespaces.eip155?.accounts ?? [];

  return requests.flatMap(request => {
    // SIWE fields occupy individual lines; do not allow extra fields in their text.
    if (
      [...Object.values(request), ...(request.resources ?? [])].some(
        value => typeof value === 'string' && /[\r\n]/.test(value),
      )
    ) {
      throw new Error('Invalid sign-in message fields.');
    }

    if (
      request.type !== 'caip122' ||
      request.version !== '1' ||
      request.signatureTypes !== undefined
    ) {
      throw new Error('This sign-in method is not supported.');
    }

    if (request.resources?.some(isRecap)) {
      throw new Error('This sign-in requests unsupported permissions.');
    }

    if (
      (request.exp && !(Date.parse(request.exp) > Date.now())) ||
      (request.nbf && !(Date.parse(request.nbf) <= Date.now()))
    ) {
      throw new Error('This sign-in request is not currently valid.');
    }

    const chains = new Set(request.chains);
    const matching = accounts.filter(account =>
      chains.has(account.split(':').slice(0, 2).join(':')),
    );

    if (!matching.length) {
      throw new Error('This sign-in requests an unsupported network.');
    }

    return matching.map(account => {
      const iss = `did:pkh:${account}`;
      return {
        request,
        address: account.split(':')[2]!,
        iss,
        message: formatMessage(request, iss),
      };
    });
  });
}

export function validateWalletConnectAuthentication(
  expected: readonly WalletConnectAuthentication[],
  results: readonly WalletConnectAuthenticationResult[],
): void {
  if (
    results.length !== expected.length ||
    results.some((result, index) => {
      const {iss, message} = expected[index]!;
      return (
        result.h.t !== 'caip122' ||
        result.s.t !== 'eip191' ||
        result.p.iss !== iss ||
        formatMessage(result.p, iss) !== message
      );
    })
  ) {
    throw new Error('Sign all selected accounts before connecting.');
  }
}
