import type {WalletKitTypes} from '@reown/walletkit';
import {base58} from '@scure/base';
import {
  buildApprovedNamespaces,
  normalizeNamespaces,
} from '@walletconnect/utils';

import {normalizeWalletAddress} from './wallet-address.js';

const HEX_32_BYTES = /^[0-9a-f]{64}$/i;
const EIP155_CHAIN = /^eip155:[1-9]\d*$/;
export const WALLET_CONNECT_SOLANA_CHAINS = new Set([
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
]);
const UNSUPPORTED_FEATURES = 'This site requires unsupported wallet features.';

export const WALLET_CONNECT_ADDRESS_TYPES = {
  eip155: 'evm',
  solana: 'solana',
} as const;

export type WalletConnectAddressType =
  (typeof WALLET_CONNECT_ADDRESS_TYPES)[keyof typeof WALLET_CONNECT_ADDRESS_TYPES];

export function getWalletConnectAddressType(
  address: string,
): WalletConnectAddressType | undefined {
  if (/^0x[0-9a-f]{40}$/i.test(address)) return 'evm';

  try {
    if (base58.decode(address).length === 32) return 'solana';
  } catch {
    // Only supported account formats can enter a session namespace.
  }

  return undefined;
}

function getWalletConnectChains(
  proposal: WalletKitTypes.SessionProposal,
): Record<keyof typeof WALLET_CONNECT_ADDRESS_TYPES, string[]> {
  const required = normalizeNamespaces(proposal.params.requiredNamespaces);
  const optional = normalizeNamespaces(
    proposal.params.optionalNamespaces ?? {},
  );
  const requested = (namespace: string): string[] =>
    Array.from(
      new Set([
        ...(required[namespace]?.chains ?? []),
        ...(optional[namespace]?.chains ?? []),
      ]),
    );

  return {
    eip155: requested('eip155').filter(chain => EIP155_CHAIN.test(chain)),
    solana: requested('solana').filter(chain =>
      WALLET_CONNECT_SOLANA_CHAINS.has(chain),
    ),
  };
}

export function getWalletConnectProposalAddressTypes(
  proposal: WalletKitTypes.SessionProposal,
): WalletConnectAddressType[] {
  return Object.entries(getWalletConnectChains(proposal))
    .filter(([, chains]) => chains.length)
    .map(
      ([namespace]) =>
        WALLET_CONNECT_ADDRESS_TYPES[
          namespace as keyof typeof WALLET_CONNECT_ADDRESS_TYPES
        ],
    );
}

export function buildWalletConnectNamespaces(
  proposal: WalletKitTypes.SessionProposal,
  addresses: readonly string[],
): ReturnType<typeof buildApprovedNamespaces> {
  const identities = new Set<string>();
  const accounts = addresses.filter(address => {
    const identity = normalizeWalletAddress(address);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });

  if (!accounts.length) throw new Error('Choose at least one account.');

  const chains = getWalletConnectChains(proposal);
  const supportedNamespaces: Parameters<
    typeof buildApprovedNamespaces
  >[0]['supportedNamespaces'] = {};

  for (const [namespace, addressType] of Object.entries(
    WALLET_CONNECT_ADDRESS_TYPES,
  )) {
    const namespaceChains = chains[namespace as keyof typeof chains];
    const namespaceAccounts = accounts.filter(
      address => getWalletConnectAddressType(address) === addressType,
    );

    if (!namespaceChains.length || !namespaceAccounts.length) continue;

    supportedNamespaces[namespace] = {
      chains: namespaceChains,
      methods:
        addressType === 'evm'
          ? ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction']
          : [
              'solana_signMessage',
              'solana_signTransaction',
              'solana_signAllTransactions',
              'solana_signAndSendTransaction',
            ],
      events: ['accountsChanged', 'chainChanged'],
      accounts: namespaceChains.flatMap(chain =>
        namespaceAccounts.map(address => `${chain}:${address}`),
      ),
    };
  }

  if (!Object.keys(supportedNamespaces).length)
    throw new Error(UNSUPPORTED_FEATURES);

  try {
    return buildApprovedNamespaces({
      proposal: proposal.params,
      supportedNamespaces,
    });
  } catch (cause) {
    throw new Error(UNSUPPORTED_FEATURES, {cause});
  }
}

export function parseWalletConnectUri(value: string): string | undefined {
  let uri: URL;

  try {
    uri = new URL(value.trim());
  } catch {
    return undefined;
  }

  if (
    uri.protocol !== 'wc:' ||
    !/^[0-9a-f]{64}@2$/i.test(uri.pathname) ||
    uri.host ||
    uri.hash
  ) {
    return undefined;
  }

  const parameters = uri.searchParams;
  const keys = parameters.getAll('symKey');
  const relays = parameters.getAll('relay-protocol');
  const expiries = parameters.getAll('expiryTimestamp');

  if (
    keys.length !== 1 ||
    !HEX_32_BYTES.test(keys[0]!) ||
    relays.length !== 1 ||
    relays[0] !== 'irn' ||
    expiries.length > 1
  ) {
    return undefined;
  }

  if (expiries.length) {
    const expiry = Number(expiries[0]);

    if (
      !/^\d+$/.test(expiries[0]!) ||
      !Number.isSafeInteger(expiry) ||
      expiry * 1000 <= Date.now()
    ) {
      return undefined;
    }
  }

  return uri.href;
}
