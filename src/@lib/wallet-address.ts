import {base58, bech32, bech32m} from '@scure/base';
import {SigningKey, computeAddress, getBytes, ripemd160, sha256} from 'ethers';

import {BIP39PathString, BIP39Seed, CurveName} from '../@atomics.js';

export type AddressType =
  | 'evm'
  | 'solana'
  | 'bitcoin-segwit'
  | 'bitcoin-taproot';

export type AddressChain = 'evm' | 'solana' | 'bitcoin';

export const ADDRESS_TYPES: Record<
  AddressType,
  {
    chain: AddressChain;
    seed: BIP39Seed;
    curve: CurveName;
    path: (index: number) => BIP39PathString;
    taproot?: true;
  }
> = {
  evm: {
    chain: 'evm',
    seed: BIP39Seed.satisfies('Bitcoin seed'),
    curve: CurveName.satisfies('secp256k1'),
    path: index => createDerivationPath("m/44'/60'/0'/0/", index),
  },
  solana: {
    chain: 'solana',
    seed: BIP39Seed.satisfies('ed25519 seed'),
    curve: CurveName.satisfies('ed25519'),
    path: index => createDerivationPath("m/44'/501'/", index, "'/0'"),
  },
  'bitcoin-segwit': {
    chain: 'bitcoin',
    seed: BIP39Seed.satisfies('Bitcoin seed'),
    curve: CurveName.satisfies('secp256k1'),
    path: index => createDerivationPath("m/84'/0'/0'/0/", index),
  },
  'bitcoin-taproot': {
    chain: 'bitcoin',
    seed: BIP39Seed.satisfies('Bitcoin seed'),
    curve: CurveName.satisfies('secp256k1'),
    path: index => createDerivationPath("m/86'/0'/0'/0/", index),
    taproot: true,
  },
};

function createDerivationPath(
  prefix: string,
  index: number,
  suffix = '',
): BIP39PathString {
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) {
    throw new Error('Derivation index must be between 0 and 2147483647.');
  }

  return BIP39PathString.satisfies(`${prefix}${index}${suffix}`);
}

export function getDerivationPathError(
  type: AddressType,
  path: string,
): string | undefined {
  if (!BIP39PathString.is(path)) {
    return "Enter a valid derivation path, such as m/44'/60'/0'/0/0.";
  }

  const components = path.split('/').slice(1);

  if (components.some(component => parseInt(component, 10) > 0x7fffffff)) {
    return 'Each derivation index must be between 0 and 2147483647.';
  }

  if (
    type === 'solana' &&
    components.some(component => !component.endsWith("'"))
  ) {
    return "Solana requires hardened path components ending in '.";
  }

  return undefined;
}

export function computeWalletAddress(
  type: AddressType,
  publicKey: Uint8Array,
): string {
  if (type === 'solana' || type === 'bitcoin-taproot') {
    if (publicKey.length !== 32) {
      throw new Error('Expected a 32-byte public key.');
    }

    if (type === 'solana') {
      return base58.encode(publicKey);
    }

    // The card returns the already tweaked x-only Taproot output key.
    return bech32m.encode('bc', [1, ...bech32m.toWords(publicKey)]);
  }

  if (publicKey.length !== 33 && publicKey.length !== 65) {
    throw new Error('Expected a 33- or 65-byte secp256k1 public key.');
  }

  const compressedKey = SigningKey.computePublicKey(publicKey, true);

  if (type === 'evm') {
    return computeAddress(compressedKey);
  }

  const keyHash = getBytes(ripemd160(sha256(compressedKey)));

  return bech32.encode('bc', [0, ...bech32.toWords(keyHash)]);
}
