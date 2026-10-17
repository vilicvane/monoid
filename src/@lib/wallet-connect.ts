import type {WalletKitTypes} from '@reown/walletkit';
import {
  buildApprovedNamespaces,
  normalizeNamespaces,
} from '@walletconnect/utils';

const HEX_32_BYTES = /^[0-9a-f]{64}$/i;
const EIP155_CHAIN = /^eip155:[1-9]\d*$/;
const UNSUPPORTED_FEATURES = 'This site requires unsupported wallet features.';

export function buildWalletConnectNamespaces(
  proposal: WalletKitTypes.SessionProposal,
  addresses: readonly string[],
): ReturnType<typeof buildApprovedNamespaces> {
  const identities = new Set<string>();
  const accounts = addresses.filter(address => {
    const identity = address.toLowerCase();
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });

  if (!accounts.length) throw new Error('Choose at least one account.');

  const required = normalizeNamespaces(proposal.params.requiredNamespaces);
  const optional = normalizeNamespaces(
    proposal.params.optionalNamespaces ?? {},
  );
  const chains = Array.from(
    new Set([
      ...(required.eip155?.chains ?? []),
      ...(optional.eip155?.chains ?? []),
    ]),
  ).filter(chain => EIP155_CHAIN.test(chain));

  if (!chains.length) throw new Error(UNSUPPORTED_FEATURES);

  try {
    return buildApprovedNamespaces({
      proposal: proposal.params,
      supportedNamespaces: {
        eip155: {
          chains,
          methods: [
            'personal_sign',
            'eth_signTypedData_v4',
            'eth_sendTransaction',
          ],
          events: ['accountsChanged', 'chainChanged'],
          accounts: chains.flatMap(chain =>
            accounts.map(address => `${chain}:${address}`),
          ),
        },
      },
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
