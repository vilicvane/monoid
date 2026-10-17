import type {AddressMark} from '../@services/index.js';

export type AddressKind = 'signer' | 'own' | 'listed' | 'seen' | 'unknown';

export function getAddressKind(
  address: string,
  signer: string,
  ownAddresses: ReadonlySet<string>,
  signedAddresses: ReadonlySet<string>,
): AddressKind {
  const identity = address.toLowerCase();

  if (identity === signer.toLowerCase()) return 'signer';
  if (ownAddresses.has(identity)) return 'own';
  if (signedAddresses.has(identity)) return 'seen';
  return 'unknown';
}

export function getAddressSeverity(
  kind: AddressKind | undefined,
  mark: AddressMark | undefined,
): 'warning' | 'danger' | undefined {
  if (mark === 'dangerous') return 'danger';
  if (kind === 'unknown' && mark !== 'trusted') return 'warning';
  return undefined;
}
