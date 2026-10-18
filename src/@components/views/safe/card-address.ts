import type {BIP39PathString, PublicKeyHex} from '../../../@atomics.js';
import {parseDerivationPath} from '../../../@lib/bip39.js';
import type {MonoidApplet} from '../../../@lib/monoid/index.js';
import {getAppletKey} from '../../../@lib/monoid/index.js';
import type {AddressType} from '../../../@lib/wallet-address.js';
import {
  ADDRESS_TYPES,
  computeWalletAddress,
} from '../../../@lib/wallet-address.js';
import type {
  WalletKeyPublicKeyData,
  WalletKeyWalletParameters,
} from '../../../@services/index.js';
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
  derivationPath?: BIP39PathString,
): Promise<ScannedCardKeyData['ref']> {
  if (!getCardKeyAddressTypes(key.type).includes(addressType)) {
    throw new Error(
      `Address type ${addressType} is not supported by ${key.type}.`,
    );
  }

  const options = ADDRESS_TYPES[addressType];
  const path =
    key.type === 'seed' || key.type === 'master'
      ? (derivationPath ?? options.path(0))
      : undefined;
  const seed = key.type === 'seed' ? options.seed : undefined;
  const {publicKey} = await applet.viewKey({
    ...getAppletKey(key, addressType, path),
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

export async function readCardWalletDerivations(
  applet: MonoidApplet,
  key: Pick<ScannedCardKeyData, 'type' | 'index'>,
  wallets: readonly WalletKeyWalletParameters[],
  signal?: AbortSignal,
  onProgress?: (current: number, total: number) => void,
): Promise<WalletKeyPublicKeyData[]> {
  const derived: WalletKeyPublicKeyData[] = [];
  const publicKeys = new Map<string, PublicKeyHex>();

  for (const wallet of wallets) {
    if (signal?.aborted) {
      throw Object.assign(new Error('Updating card was cancelled.'), {
        code: 'CANCELLED',
      });
    }
    const requestKey = getCardWalletDerivationKey(wallet);
    let publicKey = publicKeys.get(requestKey);

    if (publicKey === undefined) {
      const ref = await readCardKeyAddress(
        applet,
        key,
        wallet.addressType,
        wallet.path,
      );
      publicKey = ref.publicKey;
      publicKeys.set(requestKey, publicKey);
    }

    derived.push({...wallet, publicKey});
    onProgress?.(derived.length, wallets.length);
  }

  return derived;
}

function getCardWalletDerivationKey(wallet: WalletKeyWalletParameters): string {
  return JSON.stringify([
    ADDRESS_TYPES[wallet.addressType].curve,
    wallet.seed,
    wallet.curve,
    wallet.path === undefined
      ? undefined
      : uint8ArrayToHex(parseDerivationPath(wallet.path)),
    !!ADDRESS_TYPES[wallet.addressType].taproot,
  ]);
}

export function getLocalCardWalletDerivation(
  wallets: readonly WalletKeyPublicKeyData[],
  target: WalletKeyWalletParameters,
): WalletKeyPublicKeyData | undefined {
  // Callers scope these records to one root. Address formats remain separate
  // records even when their derivation produces the same public key.
  const requestKey = getCardWalletDerivationKey(target);
  const source = wallets.find(
    wallet => getCardWalletDerivationKey(wallet) === requestKey,
  );

  return source && {...target, publicKey: source.publicKey};
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
