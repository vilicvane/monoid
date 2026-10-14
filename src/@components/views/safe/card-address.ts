import {parseDerivationPath} from '../../../@lib/bip39.js';
import type {MonoidApplet} from '../../../@lib/monoid/index.js';
import type {AddressType} from '../../../@lib/wallet-address.js';
import {
  ADDRESS_TYPES,
  computeWalletAddress,
} from '../../../@lib/wallet-address.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../@utils/index.js';

import type {ScannedCardKeyData} from './common.js';

const DERIVABLE_ADDRESS_TYPES = [
  'evm',
  'solana',
  'bitcoin-segwit',
  'bitcoin-taproot',
] as const;

const SECP256K1_ADDRESS_TYPES = [
  'evm',
  'bitcoin-segwit',
  'bitcoin-taproot',
] as const;

export function getCardKeyAddressTypes(type: string): readonly AddressType[] {
  switch (type) {
    case 'seed':
    case 'master':
      return DERIVABLE_ADDRESS_TYPES;
    case 'secp256k1':
      return SECP256K1_ADDRESS_TYPES;
    case 'ed25519':
      return ['solana'];
    default:
      return [];
  }
}

export async function readCardKeyAddress(
  applet: MonoidApplet,
  key: Pick<ScannedCardKeyData, 'type' | 'index'>,
  addressType: AddressType,
): Promise<ScannedCardKeyData['ref']> {
  if (!getCardKeyAddressTypes(key.type).includes(addressType)) {
    throw new Error(
      `Address type ${addressType} is not supported by ${key.type}.`,
    );
  }

  const options = ADDRESS_TYPES[addressType];
  const path =
    key.type === 'seed' || key.type === 'master' ? options.path(0) : undefined;
  const seed = key.type === 'seed' ? options.seed : undefined;
  const {publicKey} = await applet.viewKey({
    index: hexToUint8Array(key.index),
    ...(seed !== undefined && {seed}),
    ...(path !== undefined && {
      curve: options.curve,
      path: parseDerivationPath(path),
    }),
    ...(options.taproot && {taproot: true}),
  });

  return {
    addressType,
    ...(seed !== undefined && {seed}),
    ...(path !== undefined && {curve: options.curve, path}),
    publicKey: uint8ArrayToHex(publicKey),
    address: computeWalletAddress(addressType, publicKey),
  };
}

export function getLocalCardKeyAddress(
  ref: ScannedCardKeyData['ref'],
  addressType: AddressType,
): ScannedCardKeyData['ref'] | undefined {
  if (ref.addressType === addressType) {
    return ref;
  }

  if (
    ref.path === undefined &&
    (ref.addressType === 'evm' || ref.addressType === 'bitcoin-segwit') &&
    (addressType === 'evm' || addressType === 'bitcoin-segwit')
  ) {
    return {
      ...ref,
      addressType,
      address: computeWalletAddress(
        addressType,
        hexToUint8Array(ref.publicKey),
      ),
    };
  }

  return undefined;
}
